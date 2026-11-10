// T18 review: the recorder's rules are testable without a live RPC.
// `tamperedCopy` is exactly the page's Tamper edit, and the edited bytes must fail checkBundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkBundle } from '../lib/nearai.mjs';
import {
  newestBundle, tamperedCopy, chatTimePreview, merchantBeforeClaims, lastLine, readJsonLines,
} from '../lib/transcript.mjs';

const load = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const honest = load('fixtures/simulated/honest.json');
const injection = load('fixtures/simulated/injection.json');
const order = (extra = {}) => ({ order_id: honest.order_id, amount: '2000000000000000000000000', max_bps: 3000, ...extra });
const receipt = (bundle = honest) => ({ order_id: bundle.order_id, response_hash: bundle.response_hash });

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join('app/test', '.record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('tamperedCopy edits the response bytes and fails the response-hash check', () => {
  const tampered = tamperedCopy(honest);
  assert.ok(tampered);
  assert.notEqual(tampered.response_b64, honest.response_b64);
  assert.match(Buffer.from(tampered.response_b64, 'base64').toString('utf8'), /bps=3000/);
  assert.equal(tampered.response_hash, honest.response_hash, 'hashes/signature stay untouched');

  const failed = checkBundle(tampered).filter(r => !r.ok);
  assert.ok(failed.length > 0);
  assert.ok(failed[0].check.startsWith('sha256(response bytes)'), failed[0].check);
  assert.ok(checkBundle(honest).every(r => r.ok), 'the original bundle still verifies');
});

test('tamperedCopy mirrors the page on a reply without bps=2000', () => {
  const tampered = tamperedCopy(injection);
  assert.ok(tampered);
  assert.match(Buffer.from(tampered.response_b64, 'base64').toString('utf8'), /bps=30000/);
  assert.equal(tamperedCopy({ response_b64: Buffer.from('no token here').toString('base64') }), null);
});

test('newestBundle picks the newest bundle for the order id and ignores other orders', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ order_id: 'A123-01', created_at: '2026-11-09T00:00:00Z', response_b64: 'old' }));
  fs.writeFileSync(path.join(dir, 'new.json'), JSON.stringify({ order_id: 'A123-01', created_at: '2026-11-10T00:00:00Z', response_b64: 'new' }));
  fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ order_id: 'A124-01', created_at: '2026-11-11T00:00:00Z', response_b64: 'other' }));

  const best = newestBundle(dir, 'A123-01');
  assert.equal(path.basename(best.file), 'new.json');
  assert.equal(best.bundle.response_b64, 'new');
  assert.throws(() => newestBundle(dir, 'A999-99'), /no bundle for order A999-99/);
});

test('chatTimePreview rebuilds the BINDING preview from the bundle bytes', () => {
  assert.deepEqual(chatTimePreview(order(), honest.response_b64, receipt()), {
    ok: true,
    error: null,
    token_bps: 2000,
    paid_bps: 2000,
    payout: '400000000000000000000000',
    response_hash: honest.response_hash,
  });
  // The injection token is capped by the order's max_bps.
  assert.deepEqual(chatTimePreview(order({ order_id: injection.order_id }), injection.response_b64, receipt(injection)), {
    ok: true,
    error: null,
    token_bps: 10000,
    paid_bps: 3000,
    payout: '600000000000000000000000',
    response_hash: injection.response_hash,
  });
});

test('chatTimePreview says ERR_NO_RECEIPT_FOR_BYTES for the tampered bytes', () => {
  const tampered = tamperedCopy(honest);
  const preview = chatTimePreview(order(), tampered.response_b64, null);
  assert.equal(preview.ok, false);
  assert.equal(preview.error, 'ERR_NO_RECEIPT_FOR_BYTES');
  assert.notEqual(preview.response_hash, honest.response_hash);
});

test('merchantBeforeClaims rolls the final view back by the recorded claims', () => {
  const final = {
    bond: '7200000000000000000000000',
    reserved: '4800000000000000000000000',
    paid_out: '5800000000000000000000000',
  };
  assert.deepEqual(merchantBeforeClaims(final, [
    { payout: '400000000000000000000000', liability: '600000000000000000000000' },
    { payout: '600000000000000000000000', liability: '600000000000000000000000' },
  ]), {
    bond: '8200000000000000000000000',
    reserved: '6000000000000000000000000',
    paid_out: '4800000000000000000000000',
  });
});

test('readJsonLines/lastLine select the logged claim-again attempt', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'claims.log');
  fs.writeFileSync(file, [
    JSON.stringify({ order_id: 'A123-01', claim_tx: 'Tx1', result: { ok: true } }),
    JSON.stringify({ order_id: 'A123-01', claim_tx: 'Tx2', error: 'ERR_ALREADY_CLAIMED' }),
    '',
  ].join('\n'));

  const lines = readJsonLines(file);
  assert.equal(lines.length, 2);
  const again = lastLine(lines, l => l.order_id === 'A123-01' && l.error === 'ERR_ALREADY_CLAIMED', 'claim-again');
  assert.equal(again.claim_tx, 'Tx2');
  assert.throws(() => lastLine(lines, l => l.error === 'ERR_NOPE', 'ERR_NOPE'), /no ERR_NOPE line found/);
  assert.deepEqual(readJsonLines(path.join(dir, 'missing.log')), []);
});

// Stablecoin round: a v2 recording must never overwrite the recorded v1 fixtures.
test('outputPaths: v1 keeps the committed names, v2 gets its own files', async () => {
  const { outputPaths } = await import('../lib/transcript.mjs');
  assert.deepEqual(outputPaths(1), {
    bundleA: 'fixtures/live/a123.json', bundleB: 'fixtures/live/a124.json',
    tampered: 'fixtures/live/a123-tampered.json', transcript: 'fixtures/replay/transcript.json',
  });
  assert.deepEqual(outputPaths(2), {
    bundleA: 'fixtures/live/a123-v2.json', bundleB: 'fixtures/live/a124-v2.json',
    tampered: 'fixtures/live/a123-v2-tampered.json', transcript: 'fixtures/replay/transcript-v2.json',
  });
  const v1 = Object.values(outputPaths(1));
  assert.ok(Object.values(outputPaths(2)).every(p => !v1.includes(p)), 'no shared path');
});

test('merchantBeforeClaims keeps the token of a v2 token bond view', async () => {
  const { merchantBeforeClaims: roll } = await import('../lib/transcript.mjs');
  const rolled = roll({ token: 'tusdc.testnet', bond: '94000000', reserved: '0', paid_out: '6000000' }, [{ payout: '6000000', liability: '6000000' }]);
  assert.deepEqual(rolled, { token: 'tusdc.testnet', bond: '100000000', reserved: '6000000', paid_out: '0' });
});

test('a v2 recording needs the merchant (the live run found get_order was called with merchant null)', async () => {
  const { merchantForRecording } = await import('../lib/transcript.mjs');
  assert.equal(merchantForRecording(2, { MERCHANT_ID: ' cbp-shop-sm1110.testnet ' }), 'cbp-shop-sm1110.testnet');
  assert.throws(() => merchantForRecording(2, {}), /needs MERCHANT_ID/);
  assert.throws(() => merchantForRecording(2, { MERCHANT_ID: '' }), /needs MERCHANT_ID/);
  assert.equal(merchantForRecording(1, {}), null, 'v1 get_order has no merchant argument');
  const { orderArgs } = await import('../lib/contract-api.mjs');
  assert.deepEqual(orderArgs(2, merchantForRecording(2, { MERCHANT_ID: 'shop.testnet' }), 'A123-23'), { merchant: 'shop.testnet', order_id: 'A123-23' });
});
