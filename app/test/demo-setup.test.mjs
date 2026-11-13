// docs/STABLECOIN.md 12: the v2 demo setup script. DRY_RUN prints the exact commands in order
// and touches nothing: no near-cli call, no key, no secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve('app/scripts/demo-setup.sh');
// The script reads .env from its cwd. Run it in an empty directory so a developer's real .env (which now
// has TOKEN_ID set) cannot change what the tests see; the explicit env below is the whole input.
const EMPTY_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-setup-test-'));

const runDry = (extra = {}) => {
  const res = spawnSync('/bin/bash', [SCRIPT], {
    encoding: 'utf8',
    cwd: EMPTY_CWD,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      V2: '1',
      DRY_RUN: '1',
      RUN: '99',
      CONTRACT_ID: 'v2.cbp-sm1110.testnet',
      MERCHANT_ID: 'cbp-shop-sm1110.testnet',
      BUYER_ID: 'cbp-alice-sm1110.testnet',
      TOKEN_ID: 'tusdc.testnet',
      ...extra,
    },
  });
  if (res.error) throw res.error;
  return res;
};

test('the v2 script parses', () => {
  const res = spawnSync('/bin/bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
});

test('DRY_RUN prints storage, token bond, buyer registration and token orders in order', () => {
  const res = runDry();
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split('\n');
  const at = (needle) => lines.findIndex(l => l.includes(needle));
  const storageMarket = at(`storage_deposit json-args {"account_id":"cbp-shop-sm1110.testnet"} prepaid-gas 30 Tgas attached-deposit 0.5 NEAR`);
  const storageMerchantToken = at(`as-transaction tusdc.testnet storage_deposit json-args {"account_id":"cbp-shop-sm1110.testnet","registration_only":true}`);
  const bond = at('ft_transfer_call');
  const buyerRegistration = at(`{"account_id":"cbp-alice-sm1110.testnet","registration_only":true}`);
  const orderA = at('"order_id":"A123-99"');
  const orderB = at('"order_id":"A124-99"');
  for (const [name, i] of Object.entries({ storageMarket, storageMerchantToken, bond, buyerRegistration, orderA, orderB })) {
    assert.ok(i >= 0, `${name} is printed`);
  }
  assert.ok(storageMarket < storageMerchantToken, 'market storage balance before the token registration');
  assert.ok(storageMerchantToken < bond, 'the merchant registers on the token before depositing');
  assert.ok(bond < buyerRegistration, 'bond before the buyer registration');
  assert.ok(buyerRegistration < orderA, 'buyer registration before the orders');
  assert.ok(orderA < orderB, 'A123 then A124');
  assert.match(lines[orderA], /"token":"tusdc\.testnet"/);
  assert.match(lines[orderA], /"ttl_ms":"1800000"/);
  assert.match(lines[bond], /\\"add_bond\\":\{\}/, 'the ft_transfer_call msg is the exact add_bond msg');
  assert.ok(lines.every(l => l.startsWith('+ ') || l === '' || l.startsWith('Now set DEMO_ORDERS=')), 'dry run only prints commands');
});

test('DRY_RUN never prints a key or a secret', () => {
  const res = runDry();
  assert.doesNotMatch(res.stdout, /ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/);
  assert.doesNotMatch(res.stdout, /private_key|secret|SECRET/);
  assert.match(res.stdout, /sign-with-legacy-keychain/, 'keys stay in the legacy keychain');
});

test('V2 needs TOKEN_ID and says so', () => {
  const res = runDry({ TOKEN_ID: '' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /missing TOKEN_ID/);
});

test('V2 ASSET=near sets up the NEAR path: storage balance, NEAR bond, NEAR orders with a TTL, no token call', () => {
  const res = runDry({ ASSET: 'near', TOKEN_ID: '' });
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split('\n');
  const at = (needle) => lines.findIndex(l => l.includes(needle));
  const storage = at('storage_deposit json-args {"account_id":"cbp-shop-sm1110.testnet"}');
  const merchant = at('register_merchant json-args {} prepaid-gas 30 Tgas attached-deposit 3 NEAR');
  const orderA = at('"order_id":"A123-99"');
  const orderB = at('"order_id":"A124-99"');
  assert.ok(storage >= 0 && merchant > storage && orderA > merchant && orderB > orderA, 'storage, merchant, orders in order');
  assert.match(lines[orderA], /"amount":"2000000000000000000000000","max_bps":3000,"ttl_ms":"1800000"/);
  assert.doesNotMatch(lines[orderA], /"token"/, 'a NEAR order carries no token');
  assert.doesNotMatch(res.stdout, /ft_transfer_call|registration_only|tusdc/, 'no token command at all');
});

test('v2 register_order commands attach exactly 1 yoctoNEAR (token and NEAR path)', () => {
  for (const extra of [{}, { ASSET: 'near', TOKEN_ID: '' }]) {
    const res = runDry(extra);
    assert.equal(res.status, 0, res.stderr);
    const orders = res.stdout.split('\n').filter(l => l.includes('register_order'));
    assert.equal(orders.length, 2);
    for (const l of orders) {
      assert.match(l, /attached-deposit 1 yoctoNEAR /);
      assert.doesNotMatch(l, /attached-deposit 0 NEAR/);
    }
  }
});

test('the 0-deposit override for the pre-redeploy v2 build is gone: REGISTER_ORDER_DEPOSIT is ignored', () => {
  // This replaces the test that used to assert the override works. The behaviour was removed on purpose
  // after the market was redeployed with the 1-yocto check (2026-11-10); a 0 deposit is now a failure.
  for (const extra of [{}, { ASSET: 'near', TOKEN_ID: '' }]) {
    const res = runDry({ ...extra, REGISTER_ORDER_DEPOSIT: '0 NEAR' });
    assert.equal(res.status, 0, res.stderr);
    const orders = res.stdout.split('\n').filter(l => l.includes('register_order'));
    assert.equal(orders.length, 2);
    for (const l of orders) {
      assert.match(l, /attached-deposit 1 yoctoNEAR /);
      assert.doesNotMatch(l, /attached-deposit 0 NEAR/);
    }
  }
});
