// node --env-file=.env app/server.mjs      (live)
// MODE=replay node app/server.mjs          (replay, no .env needed)
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, publicConfig, makeRelayer } from './lib/relayer.mjs';
import { wrap } from './lib/http.mjs';
import { localGuard } from './lib/guard.mjs';

const MODE = process.env.MODE ?? 'live';
const PORT = Number(process.env.PORT ?? 8787);
const app = express();
app.use('/api', localGuard({ port: PORT })); // Host + dashboard Origin + JSON only, before anything is parsed or signed
app.use(express.json({ limit: '1mb' }));
app.use(express.static('web'));
app.use('/fixtures', express.static('fixtures')); // replay files are public demo data

let handlers, cfgPublic;
if (MODE === 'replay') {
  const { makeReplay } = await import('./lib/replay.mjs'); // task T19
  const r = makeReplay('fixtures/replay/transcript.json');
  handlers = r.handlers; cfgPublic = r.publicConfig;
} else {
  const cfg = loadConfig();
  // v2 detection is one get_config at startup. MethodNotFound means v1 (raised errors are logged,
  // never read as v1); the page then uses the v1 argument shapes and hides token orders.
  const { makeProvider, view } = await import('./lib/near.mjs');
  const { detectApi, orderArgs } = await import('./lib/contract-api.mjs');
  const { loadTokenConfig } = await import('./lib/token.mjs');
  const provider = makeProvider(cfg.rpcUrl);
  let contractApi = null;
  try { contractApi = await detectApi(provider, cfg.contractId); } catch (e) { console.error(`contract version detection failed: ${e.message}`); }
  let tokens = [];
  if (contractApi === 2) {
    try {
      const config = await view(provider, cfg.contractId, 'get_config', {});
      const loaded = await loadTokenConfig(provider, cfg.contractId, config.allowed_tokens ?? []);
      tokens = loaded.tokens;
      if (loaded.unregistered.length) {
        console.error(`the market is not registered on ${loaded.unregistered.join(', ')}: those token orders are hidden`);
      }
    } catch (e) {
      console.error(`token metadata failed: ${e.message}`);
    }
    const kept = [];
    for (const order of cfg.orders) {
      try {
        const chain = await view(provider, cfg.contractId, 'get_order', orderArgs(contractApi, cfg.merchantId, order.order_id));
        if (chain) {
          const token = chain.token ?? null;
          if (token && !tokens.some(t => t.id === token)) continue; // market not registered: hide it
          order.token = token;
          order.amount = chain.amount ?? null;
          order.expires_at_ms = chain.expires_at_ms ?? null;
        }
      } catch { /* the config is still usable without the per-order metadata */ }
      kept.push(order);
    }
    cfg.orders = kept;
  }
  cfg.contractApi = contractApi;
  cfg.tokens = tokens;
  handlers = makeRelayer(cfg, { provider, ...(contractApi ? { api: contractApi } : {}) });
  cfgPublic = publicConfig(cfg);
}

app.get('/api/config', (_req, res) => res.json(cfgPublic));
app.post('/api/chat', wrap(handlers.handleChat));
app.post('/api/demo/claim', wrap(handlers.handleClaim));
app.post('/api/demo/register-edited', wrap(handlers.handleRegisterEdited));
app.get('/api/bundles/:id', (req, res) => {
  const id = path.basename(req.params.id);
  for (const dir of ['data/bundles', 'fixtures/live']) {
    const f = path.join(dir, `${id}.json`);
    if (fs.existsSync(f)) return res.type('json').send(fs.readFileSync(f));
  }
  res.status(404).json({ error: 'NOT_FOUND' });
});

app.listen(PORT, '127.0.0.1', () => console.log(`listening on http://127.0.0.1:${PORT} mode=${MODE}`));
