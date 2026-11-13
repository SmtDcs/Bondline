// The part of handleChat that runs AFTER the NEAR AI call, offline:
//   signature -> local check -> register_receipt (FINAL) -> only then the reply.
// chatExact, fetchSignature and callFinal are injected with the committed fixtures/simulated/honest.json bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyPair } from 'near-api-js';
import { makeRelayer } from '../lib/relayer.mjs';
import { API_V2 } from '../lib/contract-api.mjs';

const CONTRACT_ID = 'cbp-sm1110.testnet';
const MERCHANT_ID = 'cbp-shop-sm1110.testnet';
const BUYER_ID = 'cbp-alice-sm1110.testnet';
const honest = JSON.parse(fs.readFileSync(new URL('../../fixtures/simulated/honest.json', import.meta.url), 'utf8'));
const CHAT_ID = 'abc123-def456'; // the relayer only accepts a hex-ish id as a file name

const cfg = () => ({
  mode: 'live', network: 'testnet', rpcUrl: 'http://127.0.0.1:1', contractId: CONTRACT_ID,
  merchantId: MERCHANT_ID, buyerId: BUYER_ID,
  model: honest.model, signingAlgo: 'ed25519', nearaiKey: 'unused',
  relayerKey: KeyPair.fromRandom('ed25519').toString(), buyerKey: KeyPair.fromRandom('ed25519').toString(),
  orders: [{ order_id: 'A123', label: 'Broken mug', policy_bps: 2000 }],
});
const openOrder = {
  order_id: 'A123', merchant: MERCHANT_ID, buyer: BUYER_ID, amount: '2000000000000000000000000', max_bps: 3000,
  status: 'open', token: null, expires_at_ms: String(Date.now() + 3_600_000),
};

/** A relayer whose three outside calls are fakes; `calls` records what happened and in which order. */
function rig({ callFinal, responseBytes = Buffer.from(honest.response_b64, 'base64'), signature = honest.signature } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relayer-chat-'));
  const calls = { history: [], final: [], order: [] };
  const merchant = { sentinel: 'merchant-account' };
  const relayer = makeRelayer(cfg(), {
    api: API_V2, dataDir, merchant, buyer: { sentinel: 'buyer-account' },
    provider: { callFunction: async () => openOrder },
    buildRequestBytes: ({ history }) => { calls.history.push(history); return Buffer.from(honest.request_b64, 'base64'); },
    chatExact: async ({ requestBytes }) => {
      calls.order.push('chat');
      return { requestBytes, responseBytes, json: JSON.parse(responseBytes.toString('utf8')), chatId: CHAT_ID };
    },
    fetchSignature: async (args) => { calls.order.push('signature'); calls.sigArgs = args; return signature; },
    callFinal: async (...args) => {
      calls.order.push('register_receipt');
      calls.final.push(args);
      return callFinal ? callFinal(...args) : { txHash: 'TXHASH1', value: null };
    },
  });
  const bundleFile = path.join(dataDir, 'bundles', `${CHAT_ID}.json`);
  return { relayer, calls, merchant, bundleFile, dataDir };
}
const chat = (r, message = 'My mug arrived broken, can I get a refund?') => r.relayer.handleChat({ order_id: 'A123', message });

test('the honest reply is registered with exactly the signed fields, by the merchant, before it is returned', async () => {
  const r = rig();
  const out = await chat(r);
  assert.deepEqual(r.calls.order, ['chat', 'signature', 'register_receipt']);
  assert.equal(r.calls.final.length, 1);
  const [account, contractId, method, args, opts] = r.calls.final[0];
  assert.equal(account, r.merchant, 'signed by the merchant account, not the buyer');
  assert.equal(contractId, CONTRACT_ID);
  assert.equal(method, 'register_receipt');
  assert.deepEqual(args, {
    order_id: 'A123',
    signed_text: honest.signature.text,
    signature_hex: honest.signature.signature,
    signer_public_key_hex: honest.signature.signing_address,
  });
  assert.equal(opts.tgas, 100);
  assert.deepEqual({ chatId: r.calls.sigArgs.chatId, model: r.calls.sigArgs.model }, { chatId: CHAT_ID, model: honest.model });
  assert.equal(out.register_tx, 'TXHASH1');
  assert.equal(out.bundle.chain.register_tx, 'TXHASH1');
  assert.match(out.reply, /PROMISE\|refund\|order=A123\|bps=2000/);
  assert.equal(out.bundle.response_hash, honest.response_hash);
  assert.ok(fs.existsSync(r.bundleFile), 'the bundle is stored once the receipt is on chain');
});

test('the reply is not returned while register_receipt is still pending', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = rig({ callFinal: () => gate });
  let settled = false;
  const p = chat(r).then((v) => { settled = true; return v; }, (e) => { settled = true; throw e; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(r.calls.final.length, 1, 'register_receipt was sent');
  assert.equal(settled, false, 'handleChat must wait for register_receipt to finish (FINAL)');
  assert.equal(fs.existsSync(r.bundleFile), false, 'no bundle before the receipt exists');
  release({ txHash: 'LATE', value: null });
  const out = await p;
  assert.equal(out.register_tx, 'LATE');
});

test('a rejected registration returns no reply, stores no bundle and leaves no turn in the history', async () => {
  let attempt = 0;
  const r = rig({
    callFinal: async () => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('tx X failed: ERR_BAD_SIGNATURE'), { txHash: 'X' });
      return { txHash: 'TX2', value: null };
    },
  });
  await assert.rejects(() => chat(r, 'first message'), /ERR_BAD_SIGNATURE/);
  assert.equal(fs.existsSync(r.bundleFile), false, 'no bundle file after a failed registration');
  // the next request is built from an EMPTY history: the failed exchange was never shown to the model again
  await chat(r, 'second message');
  assert.deepEqual(r.calls.history, [[], []]);
  // control: after a SUCCESSFUL turn the history does grow, so the check above is not vacuous
  await chat(r, 'third message');
  assert.equal(r.calls.history[2].length, 2);
  assert.deepEqual(r.calls.history[2].map((t) => t.role), ['user', 'assistant']);
  assert.equal(r.calls.history[2][0].content, 'second message');
});

test('a reply with one byte flipped fails the local check and nothing is registered', async () => {
  const bytes = Buffer.from(honest.response_b64, 'base64');
  const pos = bytes.indexOf('bps=2000') + 4;
  assert.ok(pos > 3);
  bytes[pos] = '3'.charCodeAt(0); // 2000 -> 3000, the signature still covers the old bytes
  const r = rig({ responseBytes: bytes });
  await assert.rejects(() => chat(r), (e) => e.message === 'LOCAL_CHECK_FAILED' && e.status === 502 && /response_hash|signed text/.test(e.detail));
  assert.equal(r.calls.final.length, 0, 'register_receipt must not be called');
  assert.equal(fs.existsSync(r.bundleFile), false);
});

test('a signature that does not verify fails the local check before register_receipt', async () => {
  const bad = { ...honest.signature, signature: honest.signature.signature.replace(/.$/, (c) => (c === '0' ? '1' : '0')) };
  const r = rig({ signature: bad });
  await assert.rejects(() => chat(r), (e) => e.message === 'LOCAL_CHECK_FAILED' && e.status === 502);
  assert.equal(r.calls.final.length, 0);
});
