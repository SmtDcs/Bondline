// docs/STABLECOIN.md 12: the v2 demo setup script. DRY_RUN prints the exact commands in order
// and touches nothing: no near-cli call, no key, no secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const SCRIPT = 'app/scripts/demo-setup.sh';

const runDry = (extra = {}) => {
  const res = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
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
  const res = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
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
