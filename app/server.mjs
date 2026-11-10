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
  handlers = makeRelayer(cfg); cfgPublic = publicConfig(cfg);
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
