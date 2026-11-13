// A failed on-chain call must answer with {error, tx, explorer} (INTERFACES 11).
// The error is produced by the real callFinal() from a stubbed account outcome, not hand-built.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wrap } from '../lib/http.mjs';
import { callFinal, explorerTx } from '../lib/near.mjs';
import { loadConfig, publicConfig } from '../lib/relayer.mjs';

const call = (handler, body = {}) => new Promise((resolve) => {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { resolve({ status: this.statusCode, body: payload }); },
  };
  handler({ body, path: '/api/demo/register-edited' }, res);
});

const failingAccount = (txHash, panic) => ({
  callFunctionRaw: async () => ({
    transaction_outcome: { id: txHash },
    status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: panic } } } } },
  }),
});

test('register-edited failure carries error, tx and explorer', async () => {
  const handler = wrap(() => callFinal(
    failingAccount('FakeTxHash111', 'Smart contract panicked: ERR_BAD_SIGNATURE'),
    'cbp-sm1110.testnet', 'register_receipt', { order_id: 'A123-01' },
  ));
  const { status, body } = await call(handler, { order_id: 'A123-01' });
  assert.equal(status, 400);
  assert.equal(body.error, 'ERR_BAD_SIGNATURE');
  assert.equal(body.tx, 'FakeTxHash111');
  assert.equal(body.explorer, explorerTx('FakeTxHash111'));
  assert.equal(body.explorer, 'https://testnet.nearblocks.io/txns/FakeTxHash111');
});

test('an error without a transaction has no explorer link', async () => {
  const handler = wrap(() => { throw Object.assign(new Error('ERR_BAD_REQUEST'), { status: 400, detail: 'bad input' }); });
  const { status, body } = await call(handler);
  assert.equal(status, 400);
  assert.equal(body.error, 'ERR_BAD_REQUEST');
  assert.equal(body.detail, 'bad input');
  assert.equal(body.tx, null);
  assert.equal(body.explorer, undefined);
});

// GET /api/config is exactly publicConfig(loadConfig(env)): it must carry the DEMO_ORDERS naive
// Flag for the UI label and never any key material.
test('/api/config exposes the naive order flag and no key material', () => {
  const env = {
    CONTRACT_ID: 'cbp-sm1110.testnet',
    MERCHANT_ID: 'cbp-shop-sm1110.testnet',
    BUYER_ID: 'cbp-alice-sm1110.testnet',
    RELAYER_SECRET_KEY: 'placeholder-relayer-key',
    BUYER_CLAIM_SECRET_KEY: 'placeholder-buyer-key',
    NEARAI_API_KEY: 'placeholder-api-key',
    DEMO_ORDERS: 'A123-01:Broken mug:2000,A124-01:Late delivery:2000:naive',
  };
  const pub = publicConfig(loadConfig(env));
  assert.deepEqual(pub.orders, [
    { order_id: 'A123-01', label: 'Broken mug' },
    { order_id: 'A124-01', label: 'Late delivery', naive: true },
  ]);
  assert.deepEqual(Object.keys(pub).sort(), ['buyerId', 'contractId', 'merchantId', 'mode', 'model', 'network', 'orders', 'rpcUrl']);
  const json = JSON.stringify(pub);
  assert.doesNotMatch(json, /placeholder-|SECRET|ed25519:|sk-/);
});

// The live shape of a failed call: near-api-js 7 THROWS ContractExecutionError instead of returning
// status.Failure, so callFinal must read the tx hash out of the attached transactionResult.
test('callFinal keeps the tx hash of a thrown contract panic', async () => {
  const thrown = Object.assign(new Error('Smart contract panicked: ERR_BAD_SIGNATURE'), {
    name: 'ContractExecutionError',
    transactionResult: { transaction_outcome: { id: 'ChainTxHash222' }, status: { Failure: {} } },
  });
  const account = { callFunctionRaw: async () => { throw thrown; } };
  await assert.rejects(
    () => callFinal(account, 'cbp-sm1110.testnet', 'register_receipt', { order_id: 'A123-01' }),
    (e) => /ERR_BAD_SIGNATURE/.test(e.message) && e.txHash === 'ChainTxHash222',
  );
  const handler = wrap(() => callFinal(account, 'cbp-sm1110.testnet', 'register_receipt', { order_id: 'A123-01' }));
  const { status, body } = await call(handler);
  assert.equal(status, 400);
  assert.equal(body.error, 'ERR_BAD_SIGNATURE');
  assert.equal(body.tx, 'ChainTxHash222');
  assert.equal(body.explorer, explorerTx('ChainTxHash222'));
});

// docs/STABLECOIN.md 12: the v2 /api/config additions are additive; the v1 payload above is unchanged.
test('/api/config on v2 adds contract_api, token metadata and per-order token/expiry, never keys', () => {
  const env = {
    CONTRACT_ID: 'v2.cbp-sm1110.testnet',
    MERCHANT_ID: 'cbp-shop-sm1110.testnet',
    BUYER_ID: 'cbp-alice-sm1110.testnet',
    RELAYER_SECRET_KEY: 'placeholder-relayer-key',
    BUYER_CLAIM_SECRET_KEY: 'placeholder-buyer-key',
    NEARAI_API_KEY: 'placeholder-api-key',
    TOKEN_ID: 'tusdc.testnet',
    DEMO_ORDERS: 'A123-01:Broken mug:2000,A124-01:Late delivery:2000:naive',
  };
  const cfg = loadConfig(env);
  assert.equal(cfg.tokenId, 'tusdc.testnet');
  cfg.contractApi = 2;
  cfg.tokens = [{ id: 'tusdc.testnet', symbol: 'tUSDC', decimals: 6 }];
  cfg.orders[0].token = 'tusdc.testnet';
  cfg.orders[0].amount = '20000000';
  cfg.orders[0].expires_at_ms = '1796792000000';
  const pub = publicConfig(cfg);
  assert.equal(pub.contract_api, 2);
  assert.deepEqual(pub.tokens, [{ id: 'tusdc.testnet', symbol: 'tUSDC', decimals: 6 }]);
  assert.deepEqual(pub.orders, [
    { order_id: 'A123-01', label: 'Broken mug', token: 'tusdc.testnet', expires_at_ms: '1796792000000' },
    { order_id: 'A124-01', label: 'Late delivery', naive: true, token: null, expires_at_ms: null },
  ]);
  assert.deepEqual(Object.keys(pub).sort(), ['buyerId', 'contractId', 'contract_api', 'merchantId', 'mode', 'model', 'network', 'orders', 'rpcUrl', 'tokens']);
  const json = JSON.stringify(pub);
  assert.doesNotMatch(json, /placeholder-|SECRET|ed25519:|sk-/);
});
