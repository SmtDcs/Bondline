// Stablecoin regressions: each test fails on the code before the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KeyPair } from 'near-api-js';
import { makeRelayer } from '../lib/relayer.mjs';
import { buildLiveConfig } from '../lib/live-config.mjs';

globalThis.location = new URL('http://127.0.0.1:8787/');
const app = await import('../../web/app.js?regressions');

const MERCHANT = 'cbp-shop-sm1110.testnet';
const BUYER = 'cbp-alice-sm1110.testnet';
const cfg = (extra = {}) => ({
  mode: 'live', network: 'testnet', rpcUrl: 'http://127.0.0.1:1', contractId: 'v2.cbp-sm1110.testnet',
  merchantId: MERCHANT, buyerId: BUYER, model: 'm', signingAlgo: 'ed25519', nearaiKey: 'unused',
  relayerKey: KeyPair.fromRandom('ed25519').toString(), buyerKey: KeyPair.fromRandom('ed25519').toString(),
  orders: [{ order_id: 'A1', label: 'x', policy_bps: 2000 }], ...extra,
});

test('a failed NEAR payout does not tell the shopper to register on a token (even with TOKEN_ID set)', async (t) => {
  const dataDir = fs.mkdtempSync(path.join('app/test', '.regress-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const r = makeRelayer(cfg({ tokenId: 'tusdc.testnet' }), {
    provider: {}, merchant: {}, buyer: {}, dataDir, api: 2,
    callFinal: async () => ({ txHash: 'T1', value: { ok: false, error: 'ERR_PAYOUT_FAILED', token: null, payout: '0' } }),
  });
  await assert.rejects(
    () => r.handleClaim({ order_id: 'A1', response_b64: 'AAAA' }),
    (e) => e.status === 502 && !/tusdc|storage_deposit/.test(e.detail) && e.detail.includes(BUYER),
  );
});

test('a chat on an order with a payout in flight says so, not "already claimed"', async () => {
  const r = makeRelayer(cfg(), {
    api: 2,
    provider: { callFunction: async () => ({ order_id: 'A1', merchant: MERCHANT, buyer: BUYER, amount: '1', status: 'paying', token: null, expires_at_ms: '9999999999999' }) },
  });
  await assert.rejects(() => r.handleChat({ order_id: 'A1', message: 'hi' }), (e) => e.message === 'ERR_CLAIM_IN_PROGRESS' && e.status === 400);
});

test('the claim toast names the token: 4 tUSDC, not "0.000 NEAR"; the NEAR toast is unchanged', () => {
  const tokens = [{ id: 'tusdc.testnet', symbol: 'tUSDC', decimals: 6 }];
  assert.equal(app.claimToastText('4000000', 'tusdc.testnet', tokens), 'paid 4 tUSDC');
  assert.equal(app.claimToastText('400000000000000000000000'), 'paid 0.400 NEAR');
  assert.equal(app.claimToastText('400000000000000000000000', null, tokens), 'paid 0.400 NEAR');
});

test('startup does not read a network error as v1; MethodNotFound still means v1', async () => {
  const down = { callFunction: async () => { throw new Error('fetch failed'); } };
  await assert.rejects(() => buildLiveConfig(cfg(), down, () => {}), /fetch failed/);
  const v1 = { callFunction: async () => { throw new Error('wasm execution failed: MethodNotFound'); } };
  const out = await buildLiveConfig(cfg(), v1, () => {});
  assert.equal(out.contractApi, 1);
  assert.deepEqual(out.tokens, []);
});

test('startup hides a token order when the market is not registered on its token', async () => {
  const provider = {
    callFunction: async ({ method }) => {
      if (method === 'get_config') return { api: 2, allowed_tokens: ['tusdc.testnet'] };
      if (method === 'ft_metadata') return { symbol: 'tUSDC', decimals: 6 };
      if (method === 'storage_balance_of') return null;
      if (method === 'get_order') return { token: 'tusdc.testnet', amount: '20000000', expires_at_ms: '1' };
      throw new Error(method);
    },
  };
  const out = await buildLiveConfig(cfg(), provider, () => {});
  assert.equal(out.contractApi, 2);
  assert.deepEqual(out.orders, []);
});
