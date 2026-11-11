// client-3 (final audit): the replay SERVER used to remember claims for the life of the process, so after one
// claim a page reload could not replay the claim beat. Loading /api/config (what every page load does) now
// starts a fresh replay session. This drives the real server (imported in-process) over HTTP on localhost.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const transcript = JSON.parse(fs.readFileSync('fixtures/replay/transcript.json', 'utf8'));
const claimStep = transcript.steps.find(s => s.kind === 'claim');
const chat = transcript.steps.find(s => s.kind === 'chat' && s.order_id === claimStep.order_id);
const response_b64 = JSON.parse(fs.readFileSync(chat.bundle_file, 'utf8')).response_b64;
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;

test('a page reload (GET /api/config) lets the replayed claim play again', async (t) => {
  process.env.MODE = 'replay';
  process.env.PORT = String(PORT);
  const { server } = await import('../server.mjs');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const claim = () => fetch(`${BASE}/api/demo/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ order_id: claimStep.order_id, response_b64 }),
  });
  assert.equal((await fetch(`${BASE}/api/config`)).status, 200);
  assert.equal((await claim()).status, 200);
  const second = await claim();
  assert.equal(second.status, 400);
  assert.equal((await second.json()).error, 'ERR_ALREADY_CLAIMED');
  await fetch(`${BASE}/api/config`); // the page is reloaded
  assert.equal((await claim()).status, 200, 'the claim beat must be replayable after a reload');
});
