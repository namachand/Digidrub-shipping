/**
 * Entry point. Loads env, mounts routes, starts the server.
 */
import 'dotenv/config';
import express from 'express';
import { handleRatesRequest } from './rates-handler.js';
import { loadPoblados } from './poblado-lookup.js';
import { log } from './logger.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Health check — Render + uptime monitors use this
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Shopify Carrier Service API callback
app.post('/shopify/rates', handleRatesRequest);

// Local testing endpoint — hit with a fake Shopify payload without Shopify involved
app.post('/test/rates', handleRatesRequest);

// Root
app.get('/', (_req, res) => {
  res.json({
    service: 'CAEX Shopify Middleware',
    endpoints: ['/health', '/shopify/rates', '/test/rates'],
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

const port = Number(process.env.PORT) || 3000;

// Load poblados before accepting requests
loadPoblados();

app.listen(port, () => {
  log.info(`CAEX middleware listening on port ${port}`);
  log.info(`Health check: http://localhost:${port}/health`);
});
