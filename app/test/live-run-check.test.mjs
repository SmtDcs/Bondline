// Structure check + diff used to replay the recorded live run (app/lib/live-run-check.mjs).
// The last test reads the committed fixtures/runs/v2-live-run.json once it exists (offline, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkLiveRunStructure, diffRecord } from '../lib/live-run-check.mjs';

const HASH = '8kFz9qr7Q1NL8rnXz5y3ZosPbWf9pDxCyj2vPZUxEDB9';
const good = () => ({
  type: 'bot-promises/live-run/v2',
  txs: [{ tx_hash: HASH, explorer: `https://testnet.nearblocks.io/txns/${HASH}`, ok: true, error: null, signer: 'a.testnet', receiver: 'b.testnet', method: 'claim', gas_burnt_total: '7700000000000', receipts: [], logs: [], label: 'x', step: 'L7' }],
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

test('rechecks: a tagged tx or check needs a listed round with a wasm hash and a redeploy tx', () => {
  const d = good();
  d.txs[0].round = 'r2'; d.checks[0].round = 'r2';
  const p1 = checkLiveRunStructure(d).join('\n');
  assert.match(p1, /round r2 is not listed in rechecks/);
  assert.equal((p1.match(/round r2 is not listed/g) ?? []).length, 2); // the tx and the check
  d.rechecks = [{ round: 'r2', wasm_sha256: 'ab'.repeat(32), redeploy_tx: HASH }];
  assert.deepEqual(checkLiveRunStructure(d), []);
  d.rechecks = [{ round: 'r2', wasm_sha256: 'nothex', redeploy_tx: 'x' }, {}];
  const p2 = checkLiveRunStructure(d).join('\n');
  assert.match(p2, /wasm_sha256 must be 64 hex/);
  assert.match(p2, /redeploy_tx is not a base58 hash/);
  assert.match(p2, /rechecks #1: round missing/);
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

// ---- tests-10 ----

test('a check whose recorded value differs from the expectation is a problem even with pass:true', () => {
  const d = good();
  d.checks = [{ step: 'L1', name: 'payout', got: '0', expected: '4000000', pass: true }];
  assert.match(checkLiveRunStructure(d).join('\n'), /pass is true but got "0" is not expected "4000000"/);
  d.checks = [{ step: 'L1', name: 'nested', got: { a: ['1'] }, expected: { a: ['1'] }, pass: true }];
  assert.deepEqual(checkLiveRunStructure(d), []);
  d.checks = [{ step: 'L1', name: 'nested differs', got: { a: ['1'] }, expected: { a: ['2'] }, pass: true }];
  assert.equal(checkLiveRunStructure(d).length, 1);
});

test("the documented '>0' predicate means a positive integer, nothing else passes", () => {
  const d = good();
  for (const [got, ok] of [['7580000000000000000000', true], [5, true], ['0', false], ['-1', false], ['abc', false], [null, false]]) {
    d.checks = [{ step: 'L6', name: 'storage', got, expected: '>0', pass: true }];
    assert.equal(checkLiveRunStructure(d).length === 0, ok, String(got));
  }
});

test('a tx whose step label is not an L-step is a problem', () => {
  const d = good();
  d.txs[0].step = 'whatever';
  assert.match(checkLiveRunStructure(d).join('\n'), /step must look like L7 or L9b/);
});

test('diffRecord: a tx relabelled as another signer / receiver / method no longer matches the chain', () => {
  const rec = { ok: true, error: null, gas_burnt_total: '5', logs: [], signer: 'a.testnet', receiver: 'b.testnet', method: 'claim' };
  assert.deepEqual(diffRecord(rec, { ...rec }), []);
  assert.match(diffRecord(rec, { ...rec, signer: 'mallory.testnet' }).join(), /signer a\.testnet != mallory\.testnet/);
  assert.match(diffRecord(rec, { ...rec, receiver: 'c.testnet' }).join(), /receiver/);
  assert.match(diffRecord(rec, { ...rec, method: 'add_bond' }).join(), /method claim != add_bond/);
});

test('describeOutcome reads signer, receiver and method from the transaction itself', async () => {
  const { describeOutcome } = await import('../lib/live-tx.mjs');
  const rec = describeOutcome({
    transaction: { hash: HASH, signer_id: 'a.testnet', receiver_id: 'b.testnet', actions: [{ FunctionCall: { method_name: 'claim' } }] },
    transaction_outcome: { id: HASH, outcome: { gas_burnt: 1 } }, receipts_outcome: [], status: { SuccessValue: '' },
  });
  assert.deepEqual([rec.signer, rec.receiver, rec.method], ['a.testnet', 'b.testnet', 'claim']);
});

// The recording names the wasm each round ran against. A rebuilt wasm needs a new live run, so the committed file must be
// the one the LATEST round recorded: the header's wasm for the first run, the last `rechecks` entry after a redeploy.
test('the committed contract-v2 wasm is the one the live run recorded', { skip: !fs.existsSync('fixtures/runs/v2-live-run.json') || !fs.existsSync('contract-v2/res/bot_promises_v2.wasm') }, async () => {
  const { createHash } = await import('node:crypto');
  const data = JSON.parse(fs.readFileSync('fixtures/runs/v2-live-run.json', 'utf8'));
  const sha = createHash('sha256').update(fs.readFileSync('contract-v2/res/bot_promises_v2.wasm')).digest('hex');
  const latest = (data.rechecks ?? []).at(-1);
  assert.equal(sha, latest ? latest.wasm_sha256 : data.wasm_sha256, 'contract-v2/res/bot_promises_v2.wasm changed without a new live run (fixtures/runs/v2-live-run.json)');
  const l1 = data.checks.filter(c => /code hash/.test(c.name) && (latest ? c.round === latest.round : c.round === undefined));
  assert.ok(l1.length >= 1);
  for (const c of l1) assert.equal(c.got, sha, c.name);
});
