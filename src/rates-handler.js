/**
 * POST /shopify/rates handler.
 * Receives Shopify's Carrier Service API payload, returns shipping options.
 */
import { getRate } from './caex.js';
import { findPobladoCode, getPobladoByCode } from './poblado-lookup.js';
import { resolveDepartamento } from './province-mapping.js';
import { cacheGet, cacheSet } from './cache.js';
import { log } from './logger.js';

const SERVICE_LABELS = {
  1: { name: 'CAEX Express', description: 'Next business day' },
  2: { name: 'CAEX Standard', description: '2-3 business days' },
  3: { name: 'CAEX Economy', description: '4-7 business days' },
};

export async function handleRatesRequest(req, res) {
  const startedAt = Date.now();
  const payload = req.body?.rate;
  if (!payload) {
    log.warn('Received /shopify/rates with no rate payload');
    return res.status(400).json({ rates: [] });
  }

  try {
    const { destination, items, currency } = payload;

    // ──────────────────────────────────────────────
    // 1. Sum cart weight (Shopify sends grams)
    // ──────────────────────────────────────────────
    const totalGrams = (items || []).reduce(
      (sum, i) => sum + (i.grams || 0) * (i.quantity || 1),
      0
    );
    const weightKg = Math.max(0.5, totalGrams / 1000); // floor at 0.5 kg so CAEX doesn't reject

    // ──────────────────────────────────────────────
    // 2. Resolve destination poblado code
    // ──────────────────────────────────────────────
    const deptCode = resolveDepartamento({
      province: destination?.province,
      province_code: destination?.province_code,
    });

    if (!deptCode) {
      log.warn('Could not resolve department', {
        province: destination?.province,
        province_code: destination?.province_code,
      });
      return res.json({ rates: [backupRate(currency)] });
    }

    const destPobladoCode = findPobladoCode(destination?.city, deptCode);
    if (!destPobladoCode) {
      log.warn('Could not resolve destination poblado', {
        city: destination?.city,
        dept: deptCode,
      });
      return res.json({ rates: [backupRate(currency)] });
    }

    const originPoblado = process.env.CAEX_ORIGEN_POBLADO;
    const pieza = process.env.CAEX_DEFAULT_PIEZA || '2';

    log.info('Rate request', {
      origen: originPoblado,
      destino: destPobladoCode,
      city: destination?.city,
      dept: deptCode,
      weightKg,
      items: items?.length,
    });

    // Red-zone warning for ops visibility (not blocking)
    const destPoblado = getPobladoByCode(destPobladoCode);
    if (destPoblado?.ZonaRoja === 1 || destPoblado?.ZonaRoja === '1') {
      log.warn('Destination is in a ZonaRoja (red zone)', { destPobladoCode });
    }

    // ──────────────────────────────────────────────
    // 3. Cache key based on origin+dest+weight+piece
    // ──────────────────────────────────────────────
    const cacheKey = `${originPoblado}|${destPobladoCode}|${weightKg}|${pieza}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      log.debug('Cache hit', { cacheKey });
      return res.json({ rates: cached });
    }

    // ──────────────────────────────────────────────
    // 4. Call CAEX 3x in parallel (one per service type)
    // ──────────────────────────────────────────────
    const results = await Promise.allSettled(
      [1, 2, 3].map((servicio) =>
        getRate({
          origen: originPoblado,
          destino: destPobladoCode,
          pieza,
          servicio,
          peso: weightKg.toFixed(2),
        })
      )
    );

    const rates = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') {
        log.warn('CAEX call rejected', r.reason?.message);
        continue;
      }
      if (!r.value.success) {
        log.info('CAEX rate not available for service', {
          servicio: r.value.servicio,
          error: r.value.error,
        });
        continue;
      }
      const labels = SERVICE_LABELS[r.value.servicio];
      rates.push({
        service_name: labels.name,
        service_code: `CAEX_${r.value.servicio}`,
        total_price: Math.round(r.value.price * 100), // Shopify expects cents
        description: labels.description,
        currency: currency || 'GTQ',
      });
    }

    // ──────────────────────────────────────────────
    // 5. Fallback if CAEX failed for all services
    // ──────────────────────────────────────────────
    if (rates.length === 0) {
      log.warn('CAEX returned no rates; using backup flat rate', {
        origen: originPoblado,
        destino: destPobladoCode,
        weightKg,
      });
      rates.push(backupRate(currency));
    } else {
      cacheSet(cacheKey, rates, Number(process.env.CACHE_TTL_SECONDS) || 1800);
    }

    const durationMs = Date.now() - startedAt;
    log.info(`Returning ${rates.length} rate(s) in ${durationMs}ms`);
    return res.json({ rates });
  } catch (err) {
    log.error('Unexpected error in rates handler', err.stack || err.message);
    // Never throw at Shopify — always return a backup rate so checkout doesn't break
    return res.json({ rates: [backupRate(payload?.currency)] });
  }
}

function backupRate(currency) {
  const priceGtq = Number(process.env.BACKUP_RATE_GTQ) || 75;
  return {
    service_name: 'Standard Shipping',
    service_code: 'CAEX_BACKUP',
    total_price: priceGtq * 100,
    description: 'Our team will confirm your delivery details',
    currency: currency || 'GTQ',
  };
}
