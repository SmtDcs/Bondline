// Pure parts of the live-run helpers (app/lib/live-tx.mjs, app/lib/run-plan.mjs): .env parsing, secret redaction,
// outcome -> record (success, panic, failed payout with logs), gas per method, RunBook. No network, no keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv, redactSecrets, describeOutcome, decodeSuccess, failureText, tgasOf, eventsOf, RunBook, readEnvFile } from '../lib/live-tx.mjs';
import { shouldSkip } from '../lib/run-plan.mjs';
import { outputPaths } from '../lib/transcript.mjs';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

// Shape of an RPC EXPERIMENTAL_tx_status response for a v2 claim whose transfer failed (ok:false callback).
const claimOutcome = (ok) => ({
  transaction: { hash: 'TXHASH' },
  transaction_outcome: { id: 'TXHASH', outcome: { gas_burnt: 2_500_000_000_000, status: { SuccessReceiptId: 'R1' }, logs: [] } },
  status: { SuccessValue: b64({ ok, error: ok ? null : 'ERR_PAYOUT_FAILED', payout: ok ? '4000000' : '0' }) },
  receipts: [
    { receipt_id: 'R1', predecessor_id: 'alice', receiver_id: 'market', receipt: { Action: { actions: [{ FunctionCall: { method_name: 'claim' } }] } } },
    { receipt_id: 'R2', predecessor_id: 'market', receiver_id: 'token', receipt: { Action: { actions: [{ FunctionCall: { method_name: 'ft_transfer' } }] } } },
    { receipt_id: 'R3', predecessor_id: 'market', receiver_id: 'market', receipt: { Action: { actions: [{ FunctionCall: { method_name: 'on_claim_paid' } }] } } },
    { receipt_id: 'R4', predecessor_id: 'market', receiver_id: 'alice', receipt: { Action: { actions: [{ Transfer: { deposit: '1' } }] } } },
  ],
  receipts_outcome: [
    { id: 'R1', outcome: { executor_id: 'market', gas_burnt: 9_000_000_000_000, logs: [], status: { SuccessReceiptId: 'R3' } } },
    { id: 'R2', outcome: { executor_id: 'token', gas_burnt: ok ? 4_000_000_000_000 : 3_000_000_000_000, logs: [], status: ok ? { SuccessValue: '' } : { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: The account alice is not registered' } } } } } } },
    { id: 'R3', outcome: { executor_id: 'market', gas_burnt: 6_000_000_000_000, logs: ok ? ['EVENT_JSON:{"standard":"botpromise","event":"promise_claimed","data":[{"payout":"4000000"}]}'] : ['PAYOUT_FAILED:A123-21'], status: { SuccessValue: b64({ ok }) } } },
  ],
});

test('parseEnv: quotes, comments, no expansion', () => {
  const env = parseEnv('# c\nA=1\nB="two words"\nC=\'x y\'\nD=$HOME\n\nE=a=b\n');
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'x y', D: '$HOME', E: 'a=b' });
});

test('readEnvFile: the process environment wins over the file (same as node --env-file)', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'env-')), '.env');
  fs.writeFileSync(f, 'X=file\nY=file\n');
  const env = readEnvFile(f, { X: 'shell' });
  assert.equal(env.X, 'shell');
  assert.equal(env.Y, 'file');
});

test('redactSecrets removes key-like values and ed25519 strings', () => {
  const key = 'ed25519:' + '5'.repeat(88);
  const sk = ['sk', 'abcdefghijklmn'].join('-'); // built at run time so the repository's secret scan does not match this test
  const out = redactSecrets(`oops ${key} and apikey-12345678901234 and ${sk}`, { CBP_SHOP_KEY: key, NEARAI_API_KEY: 'apikey-12345678901234', MERCHANT_ID: 'shop.testnet' });
  assert.doesNotMatch(out, /5{20}/);
  assert.doesNotMatch(out, /apikey-12345678901234/);
  assert.ok(!out.includes(sk));
  assert.match(out, /<CBP_SHOP_KEY>/);
});

test('describeOutcome: successful claim names each receipt, burns gas per call and carries the callback value', () => {
  const rec = describeOutcome(claimOutcome(true));
  assert.equal(rec.tx_hash, 'TXHASH');
  assert.equal(rec.explorer, 'https://testnet.nearblocks.io/txns/TXHASH');
  assert.equal(rec.ok, true);
  assert.deepEqual(rec.value, { ok: true, error: null, payout: '4000000' });
  assert.deepEqual(rec.receipts.map(r => r.method), ['claim', 'ft_transfer', 'on_claim_paid']);
  assert.equal(tgasOf(rec, 'claim'), 9);
  assert.equal(tgasOf(rec, 'ft_transfer'), 4);
  assert.equal(tgasOf(rec, 'on_claim_paid'), 6);
  assert.equal(rec.gas_burnt_total, (2_500_000_000_000n + 19_000_000_000_000n).toString());
  assert.equal(eventsOf(rec).length, 1);
  assert.equal(eventsOf(rec)[0].event, 'promise_claimed');
});

test('describeOutcome: a failed token transfer is a successful tx with ok:false, no event, PAYOUT_FAILED log', () => {
  const rec = describeOutcome(claimOutcome(false));
  assert.equal(rec.ok, true, 'the transaction itself succeeded');
  assert.equal(rec.value.ok, false);
  assert.equal(rec.value.error, 'ERR_PAYOUT_FAILED');
  assert.equal(rec.receipts.find(r => r.method === 'ft_transfer').status, 'failure');
  assert.match(rec.receipts.find(r => r.method === 'ft_transfer').failure, /not registered/);
  assert.deepEqual(eventsOf(rec), []);
  assert.deepEqual(rec.logs, ['PAYOUT_FAILED:A123-21']);
});

test('describeOutcome: a contract panic is recorded as a failure with the ERR_ code', () => {
  const rec = describeOutcome({
    transaction_outcome: { id: 'BADTX', outcome: { gas_burnt: 1_000_000_000_000, status: { SuccessReceiptId: 'R1' } } },
    status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: ERR_ORDER_EXPIRED' } } } } },
    receipts_outcome: [{ id: 'R1', outcome: { executor_id: 'market', gas_burnt: 3_000_000_000_000, logs: [], status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: ERR_ORDER_EXPIRED' } } } } } } }],
  });
  assert.equal(rec.ok, false);
  assert.equal(rec.error, 'ERR_ORDER_EXPIRED');
  assert.equal(rec.value, undefined);
});

test('failureText / decodeSuccess edge cases', () => {
  assert.equal(failureText('Smart contract panicked: ERR_ONE_YOCTO'), 'ERR_ONE_YOCTO');
  assert.equal(failureText({ x: 1 }), '{"x":1}');
  assert.equal(decodeSuccess({ SuccessValue: '' }), undefined);
  assert.equal(decodeSuccess({ SuccessValue: Buffer.from('not json').toString('base64') }), 'not json');
  assert.equal(decodeSuccess({ SuccessValue: Buffer.from('"1000"').toString('base64') }), '1000');
});

test('RunBook writes after every append and records the check result it computed itself', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runbook-')), 'sub', 'run.json');
  const book = new RunBook(f, { type: 't' });
  const quiet = console.log; console.log = () => {};
  try {
    book.tx({ tx_hash: 'A', ok: true });
    assert.equal(book.check('L1', 'equal', '5', '5'), true);
    assert.equal(book.check('L1', 'not equal', '5', '6'), false);
    assert.equal(book.check('L1', 'custom', 7, '>5', 7 > 5), true);
  } finally { console.log = quiet; }
  book.note('L1', 'hello');
  const onDisk = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(onDisk.txs.length, 1);
  assert.deepEqual(onDisk.checks.map(c => c.pass), [true, false, true]);
  assert.equal(onDisk.notes[0].text, 'hello');
  // a second RunBook on the same file continues it
  assert.equal(new RunBook(f, { type: 'ignored' }).data.txs.length, 1);
});

test('shouldSkip: a one-time step is skipped when its condition says it is done', async () => {
  const present = async () => ({ total: '1' });
  const absent = async () => null;
  const step = { skipIf: { view: { contractId: 'c', method: 'storage_balance_of', args: {} }, when: 'present' } };
  assert.equal(await shouldSkip({}, step, present), true);
  assert.equal(await shouldSkip({}, step, absent), false);
  assert.equal(await shouldSkip({}, {}, present), false);
});

test('outputPaths: a v2 suffix records a second v2 run beside the first and never touches v1', () => {
  assert.equal(outputPaths(2).bundleA, 'fixtures/live/a123-v2.json');
  assert.deepEqual(outputPaths(2, 'near'), {
    bundleA: 'fixtures/live/a123-v2-near.json', bundleB: 'fixtures/live/a124-v2-near.json',
    tampered: 'fixtures/live/a123-v2-near-tampered.json', transcript: 'fixtures/replay/transcript-v2-near.json',
  });
  assert.equal(outputPaths(1, 'near').bundleA, 'fixtures/live/a123.json', 'the suffix is ignored for v1');
});
