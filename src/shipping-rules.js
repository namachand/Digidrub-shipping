import { resolveDepartamento } from './province-mapping.js';
import { getVariantMetafields } from './shopify-client.js';

const GUATEMALA_DEPT_CODE = '07';
const DEFAULT_COSTO_ENVIO = Number(process.env.DEFAULT_COSTO_ENVIO || 612);

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

async function getItemShippingCostGtq(item) {
  try {
    const variantId = item?.variant_id;

    if (!variantId) {
      return DEFAULT_COSTO_ENVIO;
    }

    const metafields = await getVariantMetafields(variantId);

    // Update this namespace/key if your store uses a different definition
    const mf = metafields.find(
      (m) => m.namespace === 'custom' && m.key === 'costo_de_envio'
    );

    if (!mf || mf.value === null || mf.value === undefined || mf.value === '') {
      return DEFAULT_COSTO_ENVIO;
    }

    const value = Number(mf.value);
    return Number.isFinite(value) ? value : DEFAULT_COSTO_ENVIO;
  } catch {
    return DEFAULT_COSTO_ENVIO;
  }
}

async function getCartShippingCostGtq(items = []) {
  let total = 0;

  for (const item of items) {
    const unitShipping = await getItemShippingCostGtq(item);
    const quantity = Number(item.quantity || 1);
    total += unitShipping * quantity;
  }

  return total;
}

export async function buildLocalRates(payload) {
  const destination = payload?.destination || {};
  const items = payload?.items || [];
  const currency = payload?.currency || 'GTQ';

  const deptCode = resolveDepartamento({
    province: destination?.province,
    province_code: destination?.province_code,
  });

  const subtotalGtq = getSubtotalGtq(items);
  const shippingCostGtq = await getCartShippingCostGtq(items);
  const isGuatemalaDept = deptCode === GUATEMALA_DEPT_CODE;

  const rates = [
    {
      service_name: 'Recoge Bodega Ashley',
      service_code: SERVICE_CODES.PICKUP_STORE,
      total_price: 0,
      description: 'Recoge tu pedido sin costo',
      currency,
    },
  ];

  if (isGuatemalaDept && subtotalGtq >= 250) {
    rates.push({
      service_name: 'Envío a domicilio',
      service_code: SERVICE_CODES.HOME_GUA_FREE,
      total_price: 0,
      description: 'Envío gratis en Guatemala para compras desde Q250',
      currency,
    });
  } else if (isGuatemalaDept && subtotalGtq < 250) {
    rates.push({
      service_name: 'Envío a domicilio',
      service_code: SERVICE_CODES.HOME_GUA_PAID,
      total_price: Math.round(shippingCostGtq * 100),
      description: 'Costo calculado según productos del carrito',
      currency,
    });
  } else {
    rates.push({
      service_name: 'Envío a domicilio',
      service_code: SERVICE_CODES.HOME_OTHER_CAEX,
      total_price: Math.round(shippingCostGtq * 100),
      description: 'Envío departamental',
      currency,
    });
  }

  return rates;
}