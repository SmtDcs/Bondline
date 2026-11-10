// Structure check + diff used to replay the recorded live run (app/lib/live-run-check.mjs).
// The last test reads the committed fixtures/runs/v2-live-run.json once it exists (offline, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkLiveRunStructure, diffRecord } from '../lib/live-run-check.mjs';

const HASH = '8kFz9qr7Q1NL8rnXz5y3ZosPbWf9pDxCyj2vPZUxEDB9';
const good = () => ({
  type: 'bot-promises/live-run/v2',
  txs: [{ tx_hash: HASH, explorer: `https://testnet.nearblocks.io/txns/${HASH}`, ok: true, error: null, signer: 'a.testnet', receiver: 'b.testnet', method: 'claim', gas_burnt_total: '7700000000000', receipts: [], logs: [], label: 'x' }],
  checks: [{ step: 'L1', name: 'n', pass: true }],
});

test('a well-formed run has no problems', () => {
  assert.deepEqual(checkLiveRunStructure(good()), []);
});

test('problems: bad hash, duplicate hash, wrong explorer link, failed tx without an error, failed check', () => {
  const d = good();
  d.txs.push({ ...d.txs[0] });                                        // duplicate
  d.txs.push({ ...d.txs[0], tx_hash: 'short', explorer: 'x' });        // bad hash + link
  d.txs.push({ ...d.txs[0], tx_hash: HASH.replace('8', '9'), explorer: `https://testnet.nearblocks.io/txns/${HASH.replace('8', '9')}`, ok: false, error: null });
  d.checks.push({ step: 'L2', name: 'broken', pass: false });
  const p = checkLiveRunStructure(d).join('\n');
  assert.match(p, /duplicate tx_hash/);
  assert.match(p, /not a base58 hash/);
  assert.match(p, /explorer link/);
  assert.match(p, /failed tx must record its error/);
  assert.match(p, /did not pass: \[L2\] broken/);
});

test('a secret-looking string anywhere in a record is a problem', () => {
  const d = good();
  d.txs[0].args = { key: 'ed25519:' + '5'.repeat(60) };
  assert.match(checkLiveRunStructure(d).join('\n'), /looks like a secret/);
});

test('diffRecord: equal records match, a changed value / error / gas / logs is reported', () => {
  const a = { ok: true, error: null, value: { ok: true }, gas_burnt_total: '5', logs: ['x'] };
  assert.deepEqual(diffRecord(a, { ...a }), []);
  assert.equal(diffRecord(a, { ...a, ok: false }).length, 1);
  assert.equal(diffRecord(a, { ...a, value: { ok: false } }).length, 1);
  assert.equal(diffRecord(a, { ...a, gas_burnt_total: '6' }).length, 1);
  assert.equal(diffRecord(a, { ...a, logs: [] }).length, 1);
  assert.equal(diffRecord(a, { ...a, error: 'ERR_X' }).length, 1);
});

test('the committed live run (if present) is well formed, has failures recorded, and covers L1-L13', { skip: !fs.existsSync('fixtures/runs/v2-live-run.json') }, () => {
  const data = JSON.parse(fs.readFileSync('fixtures/runs/v2-live-run.json', 'utf8'));
  assert.deepEqual(checkLiveRunStructure(data), []);
  assert.ok(data.txs.some(t => !t.ok), 'failures are recorded, not dropped');
  const steps = new Set(data.txs.map(t => t.step));
  for (const s of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L13']) assert.ok(steps.has(s), `${s} has at least one recorded tx`);
  assert.ok(data.txs.some(t => t.value?.error === 'ERR_PAYOUT_FAILED' && t.ok), 'L7: the ok:false payout is recorded as a successful tx');
});
