// docs/STABLECOIN.md 12/14: v2 argument shapes, token totals in the prompt, ok:false payouts,
// expired orders, and the new error codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KeyPair } from 'near-api-js';
import { makeRelayer, errCode } from '../lib/relayer.mjs';
import { buildRequestBytes } from '../lib/nearai.mjs';
import { wrap } from '../lib/http.mjs';
import { explorerTx } from '../lib/near.mjs';

const CONTRACT_ID = 'v2.cbp-sm1110.testnet';
const MERCHANT_ID = 'cbp-shop-sm1110.testnet';
const BUYER_ID = 'cbp-alice-sm1110.testnet';
const TOKEN_ID = 'tusdc.testnet';

const cfg = () => ({
  mode: 'live', network: 'testnet', rpcUrl: 'http://127.0.0.1:1', contractId: CONTRACT_ID,
  merchantId: MERCHANT_ID, buyerId: BUYER_ID,
  model: 'z-ai/glm-5.3-flash', signingAlgo: 'ed25519', nearaiKey: 'unused',
  relayerKey: KeyPair.fromRandom('ed25519').toString(), buyerKey: KeyPair.fromRandom('ed25519').toString(),
  orders: [{ order_id: 'A123-01', label: 'Broken mug', policy_bps: 2000 }],
});

const order = (extra = {}) => ({
  order_id: 'A123-01', merchant: MERCHANT_ID, buyer: BUYER_ID,
  amount: '2000000000000000000000000', max_bps: 3000, liability: '600000000000000000000000',
  status: 'open', paid: '0', paid_bps: 0, receipt_count: 0, token: null, expires_at_ms: '9999999999999', ...extra,
});

const tempDataDir = (t) => {
  const dir = fs.mkdtempSync(path.join('app/test', '.relayer-v2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const logLines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('v2 get_order is called with {merchant, order_id}; v1 keeps the old arguments', async () => {
  for (const [api, expected] of [[1, { order_id: 'A123-01' }], [2, { merchant: MERCHANT_ID, order_id: 'A123-01' }]]) {
    const calls = [];
    const r = makeRelayer(cfg(), {
      api,
      provider: { callFunction: async (c) => { calls.push(c); return order(); } },
      chatExact: async () => { throw new Error('STOP_AFTER_REQUEST'); },
    });
    await assert.rejects(() => r.handleChat({ order_id: 'A123-01', message: 'hi' }), /STOP_AFTER_REQUEST/);
    assert.deepEqual(calls.find(c => c.method === 'get_order').args, expected, `api ${api}`);
  }
});

test('the version is detected with get_config when it is not pinned', async () => {
  const calls = [];
  const r = makeRelayer(cfg(), {
    provider: {
      callFunction: async (c) => {
        calls.push(c);
        if (c.method === 'get_config') return { api: 2, allowed_tokens: [TOKEN_ID] };
        return order();
      },
    },
    chatExact: async () => { throw new Error('STOP_AFTER_REQUEST'); },
  });
  await assert.rejects(() => r.handleChat({ order_id: 'A123-01', message: 'hi' }), /STOP_AFTER_REQUEST/);
  assert.deepEqual(calls.map(c => c.method), ['get_config', 'get_order']);
  assert.deepEqual(calls[1].args, { merchant: MERCHANT_ID, order_id: 'A123-01' });
});

test('a token order puts its own total into the prompt; a NEAR order keeps the frozen bytes', async () => {
  const tokenCfg = { ...cfg(), orders: [{ order_id: 'A123-01', label: 'Mug', policy_bps: 2000 }] };
  const seen = [];
  const provider = {
    callFunction: async ({ method }) => {
      if (method === 'get_config') return { api: 2, allowed_tokens: [TOKEN_ID] };
      if (method === 'ft_metadata') return { symbol: 'tUSDC', decimals: 6 };
      return order({ token: TOKEN_ID, amount: '20000000' });
    },
  };
  const r = makeRelayer(tokenCfg, {
    provider,
    chatExact: async ({ requestBytes }) => { seen.push(JSON.parse(requestBytes.toString('utf8'))); throw new Error('STOP'); },
  });
  await assert.rejects(() => r.handleChat({ order_id: 'A123-01', message: 'hi' }), /STOP/);
  assert.match(seen[0].messages[0].content, /total 20 tUSDC\./);

  const nearSeen = [];
  const near = makeRelayer(tokenCfg, {
    api: 1,
    provider: { callFunction: async () => order({ amount: '2000000000000000000000000' }) },
    chatExact: async ({ requestBytes }) => { nearSeen.push(requestBytes); throw new Error('STOP'); },
  });
  await assert.rejects(() => near.handleChat({ order_id: 'A123-01', message: 'hi' }), /STOP/);
  const expected = buildRequestBytes({
    model: 'z-ai/glm-5.3-flash', orderId: 'A123-01', amountNear: '2', maxPolicyBps: 2000,
    history: [], userMessage: 'hi', naivePolicy: false,
  });
  assert.deepEqual(nearSeen[0], expected, 'the NEAR request bytes are unchanged');
});

test('an expired order is refused before any NEAR AI call', async () => {
  let aiCalls = 0;
  const r = makeRelayer(cfg(), {
    provider: { callFunction: async () => order({ expires_at_ms: String(Date.now() - 1) }) },
    chatExact: async () => { aiCalls += 1; throw new Error('must not be called'); },
  });
  await assert.rejects(
    () => r.handleChat({ order_id: 'A123-01', message: 'hi' }),
    (e) => e.message === 'ERR_ORDER_EXPIRED' && e.status === 400,
  );
  assert.equal(aiCalls, 0);

  const expiredStatus = makeRelayer(cfg(), { provider: { callFunction: async () => order({ status: 'expired' }) } });
  await assert.rejects(() => expiredStatus.handleChat({ order_id: 'A123-01', message: 'hi' }), (e) => e.message === 'ERR_ORDER_EXPIRED');
});

test('handleClaim treats ok:false as a retryable 502 error row, not a payout', async (t) => {
  const dataDir = tempDataDir(t);
  let attempt = 0;
  const r = makeRelayer(cfg(), {
    provider: {}, merchant: {}, buyer: {}, dataDir,
    callFinal: async () => {
      attempt += 1;
      if (attempt === 1) return { txHash: 'FailTx1', value: { ok: false, error: 'ERR_PAYOUT_FAILED', token: TOKEN_ID, payout: '0' } };
      return { txHash: 'OKTx2', value: { ok: true, payout: '4000000' } };
    },
  });
  await assert.rejects(
    () => r.handleClaim({ order_id: 'A123-01', response_b64: 'AAAA' }),
    (e) => e.message.startsWith('ERR_PAYOUT_FAILED') && e.status === 502 && e.txHash === 'FailTx1'
      && /register cbp-alice-sm1110\.testnet on tusdc\.testnet/.test(e.detail),
  );
  assert.deepEqual(logLines(path.join(dataDir, 'claims.log')), [
    { order_id: 'A123-01', claim_tx: 'FailTx1', error: 'ERR_PAYOUT_FAILED' },
  ]);
  // the retry is allowed (the order is open again) and succeeds
  const out = await r.handleClaim({ order_id: 'A123-01', response_b64: 'AAAA' });
  assert.equal(out.ok, true);
  assert.equal(out.claim_tx, 'OKTx2');
  assert.equal(out.explorer, explorerTx('OKTx2'));
});

test('handleClaim still logs a successful ok:true result', async (t) => {
  const dataDir = tempDataDir(t);
  const r = makeRelayer(cfg(), {
    provider: {}, merchant: {}, buyer: {}, dataDir,
    callFinal: async () => ({ txHash: 'OKTx1', value: { ok: true, payout: '4000000', token: TOKEN_ID } }),
  });
  const out = await r.handleClaim({ order_id: 'A123-01', response_b64: 'AAAA' });
  assert.equal(out.ok, true);
  assert.deepEqual(logLines(path.join(dataDir, 'claims.log')), [{ order_id: 'A123-01', claim_tx: 'OKTx1', result: { ok: true, payout: '4000000', token: TOKEN_ID } }]);
});

test('ERR_ORDER_EXPIRED and ERR_CLAIM_IN_PROGRESS map to HTTP 400 with their code', async () => {
  const call = (handler) => new Promise((resolve) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { resolve({ status: this.statusCode, body: payload }); } };
    handler({ body: {}, path: '/api/demo/claim' }, res);
  });
  for (const code of ['ERR_ORDER_EXPIRED', 'ERR_CLAIM_IN_PROGRESS']) {
    const handler = wrap(() => { throw Object.assign(new Error(`Smart contract panicked: ${code}`), { txHash: 'Tx1' }); }, () => {});
    const { status, body } = await call(handler);
    assert.equal(status, 400);
    assert.equal(body.error, code);
    assert.equal(body.tx, 'Tx1');
  }
});

test('errCode reads the new v2 error strings', () => {
  for (const code of ['ERR_TOKEN_NOT_ALLOWED', 'ERR_STORAGE_BALANCE', 'ERR_ORDER_EXPIRED', 'ERR_CLAIM_IN_PROGRESS', 'ERR_PAYOUT_FAILED', 'ERR_NOT_ENOUGH_GAS', 'ERR_CALLBACK_STATE']) {
    assert.equal(errCode(new Error(`tx 1 failed: Smart contract panicked: ${code}`)), code);
  }
  assert.equal(errCode(new Error('ERR_PAYOUT_FAILED: the order is open again')), 'ERR_PAYOUT_FAILED');
});
