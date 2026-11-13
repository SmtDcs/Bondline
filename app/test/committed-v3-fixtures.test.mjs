// The committed v3 live run (testnet): well formed, every check passed, the refusals are the ones the contract gave,
// and the bundles behave offline (the self-made ones fail exactly at the shop-authorization row).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkLiveRunStructure } from '../lib/live-run-check.mjs';
import { checkBundle } from '../lib/nearai.mjs';

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const run = read('fixtures/runs/v3-live-run.json');

test('the v3 live run is well formed and every recorded check passed', () => {
  assert.deepEqual(checkLiveRunStructure(run), []);
  assert.equal(run.type, 'bot-promises/live-run/v3');
  assert.equal(run.contract, 'claimable-promises.testnet');
  assert.ok(run.checks.every(c => c.pass));
});

test('what the contract refused, and what it paid', () => {
  const errors = run.txs.filter(t => !t.ok).map(t => t.error).sort();
  assert.deepEqual(errors, [
    'ERR_ALREADY_CLAIMED', 'ERR_NOT_BUYER', 'ERR_ORDER_EXPIRED', 'ERR_ORDER_EXPIRED', 'ERR_ORDER_NOT_OPEN',
    'ERR_SHOP_AUTH_BUYER', 'ERR_SHOP_AUTH_MISSING', 'ERR_SHOP_AUTH_MISSING', 'ERR_SHOP_AUTH_ORDER',
    'ERR_SHOP_AUTH_SIGNATURE', 'ERR_SHOP_AUTH_SIGNATURE', 'ERR_SHOP_AUTH_USED',
  ]);
  const claims = run.txs.filter(t => t.ok && t.method === 'claim');
  assert.equal(claims.length, 2);
  assert.ok(claims.every(c => c.signer === 'claimable-buyer.testnet'));
  const regs = run.txs.filter(t => t.ok && t.method === 'register_receipt_as_buyer');
  assert.equal(regs.length, 3);
  assert.ok(regs.every(r => r.signer === 'claimable-buyer.testnet'), 'only the customer registered; the shop never did');
  assert.ok(run.txs.every(t => t.method !== 'register_receipt'));
});

test('the independent signature re-fetch (V6) ran live and matched', () => {
  const v6 = run.checks.filter(c => c.step === 'V6');
  assert.equal(v6.length, 3); assert.ok(v6.every(c => c.pass === true));
});

test('V7 to V10 ran live: own-key self-made requests, a wrong-buyer tag, and expiry', () => {
  for (const step of ['V7', 'V8', 'V9', 'V10']) {
    const checks = run.checks.filter(c => c.step === step);
    assert.ok(checks.length >= 2 && checks.every(c => c.pass === true), step);
  }
  const err = (step, label) => run.txs.find(t => t.step === step && !t.ok && t.label.includes(label))?.error;
  assert.equal(err('V7', 'no tag'), 'ERR_SHOP_AUTH_MISSING');
  assert.equal(err('V7', 'signed herself'), 'ERR_SHOP_AUTH_SIGNATURE');
  assert.equal(err('V8', 'names'), 'ERR_SHOP_AUTH_BUYER');
  assert.equal(err('V10', 'register_receipt_as_buyer'), 'ERR_ORDER_EXPIRED');
  assert.equal(err('V10', 'claim'), 'ERR_ORDER_EXPIRED');
  // the V7 requests were sent with the customer's own NEAR AI key, not the app's
  for (const f of ['v3-own-key-self-made-35', 'v3-own-key-forged-tag-35']) assert.equal(read(`fixtures/live/${f}.json`).nearai_key, 'customer own key', f);
  // expiry: the claim after expiry happened after the order's recorded expiry
  assert.ok(run.expiry.nav_expires_at_ms > 0 && run.expiry.hon_expires_at_ms > 0);
});

test('v3 bundles: the shop-made ones are consistent, the self-made ones fail only the shop-authorization row', () => {
  for (const f of ['v3-a123-33', 'v3-a124-33']) {
    const b = read(`fixtures/live/${f}.json`);
    assert.deepEqual(checkBundle(b).filter(r => !r.ok), [], f);
  }
  for (const f of ['v3-expiry-unregistered-a123-34', 'v3-expiry-registered-a124-34']) {
    assert.deepEqual(checkBundle(read(`fixtures/live/${f}.json`)).filter(r => !r.ok), [], f);
  }
  for (const f of ['v3-self-made', 'v3-forged-tag', 'v3-own-key-self-made-35', 'v3-own-key-forged-tag-35', 'v3-wrong-buyer-35']) {
    const fails = checkBundle(read(`fixtures/live/${f}.json`)).filter(r => !r.ok);
    assert.equal(fails.length, 1, f);
    assert.match(fails[0].check, /^shop authorization in the request bytes/);
  }
});

test('no committed v3 fixture contains a key or secret', () => {
  for (const f of ['fixtures/runs/v3-live-run.json', ...fs.readdirSync('fixtures/live').filter(x => x.startsWith('v3-')).map(x => `fixtures/live/${x}`)]) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /ed25519:[1-9A-HJ-NP-Za-km-z]{40,}|sk-[A-Za-z0-9]{10,}/, f);
  }
});
