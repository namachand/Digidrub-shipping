import { resolveDepartamento } from './province-mapping.js';
import { findPobladoCode } from './poblado-lookup.js';
import { getRate } from './caex.js';
import { log } from './logger.js';

const GUATEMALA_DEPT_CODE = '07';
const FREE_SHIPPING_THRESHOLD_GTQ = Number(process.env.FREE_SHIPPING_THRESHOLD_GTQ || 250);

// Used ONLY when a real weight genuinely cannot be determined (missing on
// the product AND CAEX itself is unreachable). This is a last-resort
// fallback, not the primary path — the primary path is always the real
// CAEX rate. Flagged loudly whenever it fires so it's visible, not silent.
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
 * Total weight of the cart, in kg, using each item's real grams/weight
 * field passed by Shopify's rate request. Returns { totalWeightKg,
 * missingWeightItems } so callers know if any item had no usable weight.
 *
 * IMPORTANT: this trusts whatever weight Shopify's rate payload sends for
 * each item (Shopify includes `grams` on cart line items in the carrier
 * service request). If a product's weight is 0 in Shopify (as we found is
 * true for most of the catalog today), that shows up here as missing —
 * which is the correct, honest behavior. The real fix for those items is
 * populating real weight data at the source, not guessing here.
 */
function getCartWeightKg(items = []) {
  let totalWeightKg = 0;
  const missingWeightItems = [];

  for (const item of items) {
    const grams = Number(item.grams || 0);
    const quantity = Number(item.quantity || 1);

    if (!grams || grams <= 0) {
      missingWeightItems.push({
        name: item.name,
        variant_id: item.variant_id,
        quantity,
      });
      continue;
    }

    totalWeightKg += (grams / 1000) * quantity;
  }

  return { totalWeightKg, missingWeightItems };
}

/**
 * Call CAEX's real rate API for the resolved destination + cart weight.
 * Returns { success, priceGtq, usedFallback, missingWeightItems }.
 */
async function getRealShippingCost({ destPobladoCode, items }) {
  const { totalWeightKg, missingWeightItems } = getCartWeightKg(items);

  if (missingWeightItems.length > 0) {
    log.warn('Cart has items with no weight data — CAEX quote will be based on partial weight', {
      missingWeightItems,
      knownWeightKg: totalWeightKg,
    });
  }

  // If we have ZERO usable weight (e.g. every item is missing weight),
  // there's nothing meaningful to send CAEX — go straight to fallback
  // rather than asking CAEX to quote a 0kg shipment.
  if (totalWeightKg <= 0) {
    log.error('No usable weight for any cart item — using flat fallback rate', {
      missingWeightItems,
    });
    return {
      success: false,
      priceGtq: FALLBACK_COSTO_ENVIO_GTQ,
      usedFallback: true,
      missingWeightItems,
    };
  }

  try {
    const result = await getRate({
      origen: process.env.CAEX_ORIGEN_POBLADO,
      destino: destPobladoCode,
      pieza: process.env.CAEX_DEFAULT_PIEZA || '1',
      servicio: process.env.CAEX_DEFAULT_SERVICIO,
      peso: totalWeightKg,
    });

    if (result.success) {
      return {
        success: true,
        priceGtq: result.price,
        usedFallback: false,
        missingWeightItems,
      };
    }

    log.error('CAEX getRate returned failure — using flat fallback rate', {
      error: result.error,
      code: result.code,
    });
    return {
      success: false,
      priceGtq: FALLBACK_COSTO_ENVIO_GTQ,
      usedFallback: true,
      missingWeightItems,
    };
  } catch (err) {
    log.error('CAEX getRate threw — using flat fallback rate', { err: err.message });
    return {
      success: false,
      priceGtq: FALLBACK_COSTO_ENVIO_GTQ,
      usedFallback: true,
      missingWeightItems,
    };
  }
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

  // Always calculate the REAL cost, even if the customer ends up seeing
  // "free" — this keeps internal records accurate and makes it possible to
  // track what free shipping is actually costing the business.
  const costResult = await getRealShippingCost({ destPobladoCode, items });

  if (costResult.usedFallback) {
    log.warn('Rate quote used fallback pricing instead of a real CAEX quote', {
      destination,
      subtotalGtq,
      fallbackPriceGtq: costResult.priceGtq,
      missingWeightItems: costResult.missingWeightItems,
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
