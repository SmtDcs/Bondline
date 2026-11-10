// The near-api-js port of the V2 demo setup (app/scripts/demo-setup-v2.mjs, app/lib/demo-setup-plan.mjs).
// No network, no keys: the plan is data, and the script's DRY_RUN reads no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSetup, describeStep, nearToYocto, yoctoToNearText, ONE_YOCTO } from '../lib/demo-setup-plan.mjs';

const ids = { contractId: 'v2.cbp-sm1110.testnet', merchantId: 'cbp-shop-sm1110.testnet', buyerId: 'cbp-alice-sm1110.testnet', tokenId: 'sm1110-tusdc.testnet', run: '99' };

test('nearToYocto / yoctoToNearText are exact', () => {
  assert.equal(nearToYocto('0.5'), 5n * 10n ** 23n);
  assert.equal(nearToYocto('3'), 3n * 10n ** 24n);
  assert.equal(nearToYocto('0.00125'), 1250000000000000000000n);
  assert.equal(yoctoToNearText(5n * 10n ** 23n), '0.5');
  assert.equal(yoctoToNearText(3n * 10n ** 24n), '3');
  assert.throws(() => nearToYocto('1e3'));
  assert.throws(() => nearToYocto('-1'));
});

test('token plan: storage, merchant on token, bond, buyer on token, orders, in that order', () => {
  const steps = planSetup({ asset: 'token', ...ids });
  assert.deepEqual(steps.map(s => s.id), ['market-storage', 'merchant-on-token', 'token-bond', 'buyer-on-token', 'order-A123-99', 'order-A124-99']);
  const bond = steps.find(s => s.id === 'token-bond');
  assert.equal(bond.contractId, 'sm1110-tusdc.testnet');
  assert.equal(bond.method, 'ft_transfer_call');
  assert.deepEqual(bond.args, { receiver_id: 'v2.cbp-sm1110.testnet', amount: '100000000', msg: '{"add_bond":{}}' });
  assert.equal(bond.depositYocto, ONE_YOCTO);
  const order = steps.find(s => s.id === 'order-A123-99');
  assert.deepEqual(order.args, { order_id: 'A123-99', buyer: 'cbp-alice-sm1110.testnet', amount: '20000000', max_bps: 3000, token: 'sm1110-tusdc.testnet', ttl_ms: '1800000' });
});

test('the 1-yocto fix: every register_order attaches exactly 1 yoctoNEAR and nothing overrides it', () => {
  for (const asset of ['token', 'near']) {
    const orders = planSetup({ asset, ...ids }).filter(s => s.method === 'register_order');
    assert.equal(orders.length, 2);
    for (const o of orders) assert.equal(o.depositYocto, 1n);
  }
  // the old 0-deposit override variables are not read any more
  const src = fs.readFileSync('app/lib/demo-setup-plan.mjs', 'utf8') + fs.readFileSync('app/scripts/demo-setup-v2.mjs', 'utf8');
  assert.doesNotMatch(src, /REGISTER_ORDER_DEPOSIT|ADD_SIGNER_DEPOSIT/);
});

test('NEAR plan: storage balance, register_merchant 3 NEAR, NEAR orders with a ttl and no token', () => {
  const steps = planSetup({ asset: 'near', ...ids, tokenId: undefined });
  assert.deepEqual(steps.map(s => s.id), ['market-storage', 'register-merchant', 'order-A123-99', 'order-A124-99']);
  assert.equal(steps[1].depositYocto, 3n * 10n ** 24n);
  assert.equal(steps[1].skipIf.when, 'present', 'a second run does not try register_merchant again');
  assert.equal(steps[2].args.amount, '2000000000000000000000000');
  assert.equal('token' in steps[2].args, false);
  assert.equal(steps[2].args.ttl_ms, '1800000');
});

test('token path needs a token id; run is required', () => {
  assert.throws(() => planSetup({ asset: 'token', ...ids, tokenId: undefined }), /tokenId/);
  assert.throws(() => planSetup({ asset: 'near', ...ids, run: '' }), /run/);
});

test('one-time steps are skipped on a re-run (registrations, merchant, storage)', () => {
  const steps = planSetup({ asset: 'token', ...ids });
  for (const id of ['market-storage', 'merchant-on-token', 'buyer-on-token']) assert.ok(steps.find(s => s.id === id).skipIf, id);
  assert.equal(steps.find(s => s.id === 'token-bond').skipIf, undefined);
  assert.equal(steps.find(s => s.id === 'order-A123-99').skipIf, undefined);
});

test('describeStep prints account ids and amounts, never a key', () => {
  const lines = planSetup({ asset: 'token', ...ids }).map(s => describeStep(s, { merchant: ids.merchantId }));
  assert.match(lines[0], /^\+ cbp-shop-sm1110\.testnet -> v2\.cbp-sm1110\.testnet\.storage_deposit .* deposit 0\.5 NEAR gas 30Tgas/);
  assert.match(lines[2], /deposit 1 yoctoNEAR gas 100Tgas/);
  for (const l of lines) assert.doesNotMatch(l, /ed25519:|secret|KEY/i);
});

test('the script DRY_RUN reads no key and sends nothing', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-setup-v2-'));
  const res = spawnSync(process.execPath, [path.resolve('app/scripts/demo-setup-v2.mjs')], {
    encoding: 'utf8', cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DRY_RUN: '1', RUN: '99', CONTRACT_ID: ids.contractId, MERCHANT_ID: ids.merchantId, BUYER_ID: ids.buyerId, TOKEN_ID: ids.tokenId },
  });
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 7);
  assert.ok(lines.slice(0, 6).every(l => l.startsWith('+ ')));
  assert.match(lines[6], /^Now set DEMO_ORDERS="A123-99:Broken mug:2000,A124-99:Late delivery:2000:naive" in \.env and TOKEN_ID=sm1110-tusdc\.testnet$/);
  assert.doesNotMatch(res.stdout + res.stderr, /ed25519:[1-9A-HJ-NP-Za-km-z]{20,}/);
});

test('the script refuses a missing RUN and a bad ASSET', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-setup-v2-'));
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, DRY_RUN: '1', CONTRACT_ID: ids.contractId, MERCHANT_ID: ids.merchantId, BUYER_ID: ids.buyerId, TOKEN_ID: ids.tokenId };
  const noRun = spawnSync(process.execPath, [path.resolve('app/scripts/demo-setup-v2.mjs')], { encoding: 'utf8', cwd, env: base });
  assert.equal(noRun.status, 2);
  assert.match(noRun.stderr, /missing RUN/);
  const badAsset = spawnSync(process.execPath, [path.resolve('app/scripts/demo-setup-v2.mjs')], { encoding: 'utf8', cwd, env: { ...base, RUN: '1', ASSET: 'gold' } });
  assert.equal(badAsset.status, 2);
});
