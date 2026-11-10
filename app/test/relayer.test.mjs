// T11 review fixes: input validation, order ownership/status, chat-id sanitising, edit guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair } from 'near-api-js';
import { makeRelayer, safeChatId } from '../lib/relayer.mjs';

const CONTRACT_ID = 'cbp-sm1110.testnet';
const MERCHANT_ID = 'cbp-shop-sm1110.testnet';
const BUYER_ID = 'cbp-alice-sm1110.testnet';

// Throwaway keys generated per run: account construction needs a valid secret key, nothing is signed here.
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
  status: 'open', paid: '0', paid_bps: 0, receipt_count: 0, ...extra,
});

// Only get_order can be reached: every case below is rejected before a NEAR AI or RPC call.
const relayer = (o = order()) => makeRelayer(cfg(), { provider: { callFunction: async () => o } });

const isBadRequest = (e) => e.message === 'ERR_BAD_REQUEST' && e.status === 400;
const isAlreadyClaimed = (e) => e.message === 'ERR_ALREADY_CLAIMED' && e.status === 400;

test('chat rejects a bad order id or message before calling the paid API', async () => {
  const r = relayer();
  const cases = [
    [undefined, 'hello'], [{}, 'hello'], [42, 'hello'], ['A 1', 'hello'], ['A'.repeat(33), 'hello'], ['', 'hello'], ['A123/01', 'hello'],
    ['A123-01', undefined], ['A123-01', {}], ['A123-01', ''], ['A123-01', 'x'.repeat(2001)],
  ];
  for (const [order_id, message] of cases) {
    const label = `${JSON.stringify(order_id)} / ${typeof message === 'string' ? `len ${message.length}` : JSON.stringify(message)}`;
    await assert.rejects(() => r.handleChat({ order_id, message }), isBadRequest, label);
  }
});

test('chat accepts the 32/2000 boundary values', () => {
  // Reaching the order check means validation passed; the fake provider returns an order of another merchant.
  const r = relayer(order({ merchant: 'someone-else.testnet' }));
  return assert.rejects(
    () => r.handleChat({ order_id: 'A'.repeat(32), message: 'x'.repeat(2000) }),
    (e) => e.message === 'ERR_BAD_REQUEST' && /belongs to/.test(e.detail),
  );
});

test('chat rejects an order that belongs to another merchant', async () => {
  const r = relayer(order({ merchant: 'other-shop.testnet' }));
  await assert.rejects(() => r.handleChat({ order_id: 'A123-01', message: 'hello' }), isBadRequest);
});

test('chat rejects an order that is no longer open', async () => {
  const r = relayer(order({ status: 'claimed' }));
  await assert.rejects(() => r.handleChat({ order_id: 'A123-01', message: 'hello' }), isAlreadyClaimed);
});

test('chat id is reduced to a safe file name', () => {
  assert.equal(safeChatId('881751414e034218a501b56f39d923cd'), '881751414e034218a501b56f39d923cd');
  assert.equal(safeChatId('../881751414e034218a501b56f39d923cd'), '881751414e034218a501b56f39d923cd');
  assert.equal(safeChatId('a/b'), 'b'); // the path is stripped, the write stays in data/bundles/
  for (const bad of ['../../etc/passwd', '../evil', 'ABC', '', null, undefined, 'x'.repeat(65)])
    assert.throws(() => safeChatId(bad), /ERR_BAD_CHAT_ID/, String(bad));
});

test('register-edited refuses an edit that is not in the reply bytes', async () => {
  const r = makeRelayer(cfg());
  const bundle = {
    response_b64: Buffer.from('PROMISE|refund|order=A123-01|bps=2000', 'utf8').toString('base64'),
    response_hash: '00'.repeat(32),
    signature: { text: `z-ai/glm-5.3-flash:${'11'.repeat(32)}:${'00'.repeat(32)}`, signature: '22'.repeat(64), signing_address: '33'.repeat(32), signature_kind: 'provider_tee' },
  };
  await assert.rejects(
    () => r.handleRegisterEdited({ order_id: 'A123-01', bundle, edit: { from: '9999', to: '3000' } }),
    (e) => e.message === 'ERR_EDIT_NOT_FOUND' && e.status === 400,
  );
  await assert.rejects(() => r.handleRegisterEdited({ order_id: {}, bundle, edit: { from: '2000', to: '3000' } }), isBadRequest);
  await assert.rejects(() => r.handleRegisterEdited({ order_id: 'A123-01', bundle, edit: { from: '', to: '3000' } }), isBadRequest);
});
