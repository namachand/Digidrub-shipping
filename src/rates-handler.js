import { buildLocalRates } from './shipping-rules.js';
import { log } from './logger.js';

export async function handleRatesRequest(req, res) {
  const startedAt = Date.now();
  const payload = req.body?.rate;

  log.info('RAW /shopify/rates body', req.body);

  if (!payload) {
    log.warn('Received /shopify/rates with no rate payload');
    return res.status(400).json({ rates: [] });
  }

  try {
    log.info('Incoming Shopify rate payload summary', {
      destination: payload?.destination,
      currency: payload?.currency,
      itemCount: payload?.items?.length || 0,
    });

    log.info('Incoming Shopify rate items', payload?.items || []);

    const rates = await buildLocalRates(payload);

    log.info('Calculated local rates', rates);

    const durationMs = Date.now() - startedAt;
    log.info(`Returning ${rates.length} local rate(s) in ${durationMs}ms`);

    return res.json({ rates });
  } catch (err) {
    log.error('Unexpected error in rates handler', err.stack || err.message);

    return res.json({
      rates: [
        {
          service_name: 'Recoge Bodega Ashley',
          service_code: 'ASHLEY_PICKUP_STORE',
          total_price: 0,
          description: 'Recoge tu pedido sin costo',
          currency: payload?.currency || 'GTQ',
        },
      ],
    });
  }
}