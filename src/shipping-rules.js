import { resolveDepartamento } from './province-mapping.js';
import { findPobladoCode } from './poblado-lookup.js';
import { getRate } from './caex.js';
import { getVariantMetafields } from './shopify-client.js';
import { log } from './logger.js';

const GUATEMALA_DEPT_CODE = '07';
const FREE_SHIPPING_THRESHOLD_GTQ = Number(process.env.FREE_SHIPPING_THRESHOLD_GTQ || 250);

// Last-resort value when an item is missing BOTH real weight AND a
// costo_de_envio metafield. Used once per such line item (not multiplied
// by quantity) — deliberately NOT the same per-unit-multiplied pattern as
// the original bug.
const FALLBACK_COSTO_ENVIO_GTQ = Number(process.env.FALLBACK_COSTO_ENVIO_GTQ || 612);

export const SERVICE_CODES = {
  HOME_GUA_FREE: 'ASHLEY_HOME_GUA_FREE',
  HOME_GUA_PAID: 'ASHLEY_HOME_GUA_PAID',
  HOME_OTHER_CAEX: 'ASHLEY_HOME_OTHER_CAEX',
  PICKUP_STORE: 'ASHLEY_PICKUP_STORE',
};

export function getServiceCodeMeta(serviceCode) {
  switch (serviceCode) {
    case SERVICE_CODES.HOME_GUA_FREE:
      return { shippingChoice: 'home', codigoDespacho: 2, shouldGenerateGuide: false };
    case SERVICE_CODES.HOME_GUA_PAID:
      return { shippingChoice: 'home', codigoDespacho: 2, shouldGenerateGuide: false };
    case SERVICE_CODES.HOME_OTHER_CAEX:
      return { shippingChoice: 'home', codigoDespacho: 8, shouldGenerateGuide: true };
    case SERVICE_CODES.PICKUP_STORE:
      return { shippingChoice: 'pickup', codigoDespacho: 3, shouldGenerateGuide: false };
    default:
      return null;
  }
}

function getSubtotalGtq(items = []) {
  const subtotalMinor = items.reduce((sum, item) => {
    const price = Number(item.price || 0);
    const quantity = Number(item.quantity || 1);
    return sum + price * quantity;
  }, 0);
  return subtotalMinor / 100;
}

/**
 * Split cart items into those with real Shopify weight data and those
 * without. Only items in the "unknown" bucket ever trigger a metafield
 * lookup — items with real weight never pay that latency cost.
 */
function splitByWeightKnowledge(items = []) {
  const known = [];
  const unknown = [];
  for (const item of items) {
    const grams = Number(item.grams || 0);
    if (grams > 0) {
      known.push(item);
    } else {
      unknown.push(item);
    }
  }
  return { known, unknown };
}

function totalWeightKgOf(items) {
  return items.reduce((sum, item) => {
    const grams = Number(item.grams || 0);
    const quantity = Number(item.quantity || 1);
    return sum + (grams / 1000) * quantity;
  }, 0);
}

/**
 * For items missing real weight, look up their costo_de_envio metafield
 * (in parallel) as a smarter per-product estimate. Falls back to the flat
 * FALLBACK_COSTO_ENVIO_GTQ (once per line item, not multiplied by qty) for
 * any item that also has no metafield value.
 *
 * ASSUMPTION: costo_de_envio represents a per-UNIT cost, so it's
 * multiplied by that item's quantity. If your team intends it as a flat
 * per-line-item cost regardless of quantity, remove the `* quantity` below.
 */
async function estimateCostForUnknownWeightItems(items) {
  const results = await Promise.all(
    items.map(async (item) => {
      const quantity = Number(item.quantity || 1);
      try {
        const metafields = await getVariantMetafields(item.variant_id);
        const mf = metafields.find(
          (m) => m.namespace === 'custom' && m.key === 'costo_de_envio'
        );
        const value = mf ? Number(mf.value) : NaN;

        if (Number.isFinite(value)) {
          return { name: item.name, variant_id: item.variant_id, source: 'metafield', costGtq: value * quantity };
        }
      } catch (err) {
        log.warn('Metafield lookup failed for item missing weight — using flat fallback', {
          variant_id: item.variant_id,
          err: err.message,
        });
      }

      return { name: item.name, variant_id: item.variant_id, source: 'flat_default', costGtq: FALLBACK_COSTO_ENVIO_GTQ };
    })
  );

  const totalCostGtq = results.reduce((sum, r) => sum + r.costGtq, 0);
  return { totalCostGtq, itemBreakdown: results };
}

/**
 * Determine shipping cost for the cart:
 *  - If every item has real weight -> real CAEX quote (or flat fallback if
 *    CAEX itself fails).
 *  - If any item is missing weight -> per-item estimate (metafield when
 *    available, flat default otherwise) for ALL items, since a partial
 *    CAEX quote based on incomplete weight would be misleading rather
 *    than helpful.
 * Always returns { priceGtq, usedFallback, detail } — usedFallback is
 * true whenever the number is NOT a live CAEX quote, regardless of which
 * fallback tier produced it.
 */
async function getShippingCost({ destPobladoCode, items }) {
  const { known, unknown } = splitByWeightKnowledge(items);

  if (unknown.length === 0) {
    const totalWeightKg = totalWeightKgOf(known);

    try {
      const result = await getRate({
        origen: process.env.CAEX_ORIGEN_POBLADO,
        destino: destPobladoCode,
        pieza: process.env.CAEX_DEFAULT_PIEZA || '1',
        servicio: process.env.CAEX_DEFAULT_SERVICIO,
        peso: totalWeightKg,
      });

      if (result.success) {
        return { priceGtq: result.price, usedFallback: false, detail: 'caex_quote' };
      }

      log.error('CAEX getRate returned failure — using flat fallback rate', {
        error: result.error,
        code: result.code,
      });
      return { priceGtq: FALLBACK_COSTO_ENVIO_GTQ, usedFallback: true, detail: 'caex_failed' };
    } catch (err) {
      log.error('CAEX getRate threw — using flat fallback rate', { err: err.message });
      return { priceGtq: FALLBACK_COSTO_ENVIO_GTQ, usedFallback: true, detail: 'caex_error' };
    }
  }

  // At least one item is missing weight — can't get a trustworthy single
  // CAEX quote for the whole cart, so estimate per item instead.
  log.warn('Cart has items with no weight data — using per-item estimate instead of a CAEX quote', {
    missingWeightItems: unknown.map((i) => ({ name: i.name, variant_id: i.variant_id })),
  });

  const { totalCostGtq, itemBreakdown } = await estimateCostForUnknownWeightItems(unknown);

  // Items that DO have weight still contribute nothing extra here, since
  // we have no reliable way to combine a partial CAEX quote with per-item
  // metafield estimates into one honest number. Logged for visibility.
  if (known.length > 0) {
    log.info('Cart also has items with real weight, but a mixed-source quote was not attempted', {
      knownWeightItems: known.map((i) => ({ name: i.name, variant_id: i.variant_id })),
    });
  }

  log.info('Per-item shipping estimate breakdown', { itemBreakdown, totalCostGtq });

  return { priceGtq: totalCostGtq, usedFallback: true, detail: 'per_item_estimate' };
}

export async function buildLocalRates(payload) {
  const destination = payload?.destination || {};
  const items = payload?.items || [];
  const currency = payload?.currency || 'GTQ';

  const deptCode = resolveDepartamento({
    province: destination?.province,
    province_code: destination?.province_code,
  });

  const destPobladoCode = findPobladoCode(destination?.city, deptCode);

  const subtotalGtq = getSubtotalGtq(items);
  const isGuatemalaDept = deptCode === GUATEMALA_DEPT_CODE;

  const costResult = await getShippingCost({ destPobladoCode, items });

  if (costResult.usedFallback) {
    log.warn('Rate quote used fallback pricing instead of a live CAEX quote', {
      destination,
      subtotalGtq,
      detail: costResult.detail,
      fallbackPriceGtq: costResult.priceGtq,
    });
  }

  const rates = [
    {
      service_name: 'Recoge Bodega Ashley',
      service_code: SERVICE_CODES.PICKUP_STORE,
      total_price: 0,
      description: 'Recoge tu pedido sin costo',
      currency,
    },
  ];

  const isFreeShippingPromo = isGuatemalaDept && subtotalGtq >= FREE_SHIPPING_THRESHOLD_GTQ;

  if (isFreeShippingPromo) {
    rates.push({
      service_name: 'Envío a domicilio',
      service_code: SERVICE_CODES.HOME_GUA_FREE,
      total_price: 0,
      description: `Envío gratis en Guatemala para compras desde Q${FREE_SHIPPING_THRESHOLD_GTQ}`,
      currency,
    });
  } else if (isGuatemalaDept) {
    rates.push({
      service_name: 'Envío a domicilio',
      service_code: SERVICE_CODES.HOME_GUA_PAID,
      total_price: Math.round(costResult.priceGtq * 100),
      description: costResult.usedFallback
        ? 'Costo estimado (no se pudo confirmar tarifa real de CAEX)'
        : 'Tarifa calculada por CAEX',
      currency,
    });
  } else {
    rates.push({
      service_name: 'Envío a domicilio',
      service_code: SERVICE_CODES.HOME_OTHER_CAEX,
      total_price: Math.round(costResult.priceGtq * 100),
      description: costResult.usedFallback
        ? 'Costo estimado (no se pudo confirmar tarifa real de CAEX)'
        : 'Tarifa calculada por CAEX',
      currency,
    });
  }

  return rates;
}
