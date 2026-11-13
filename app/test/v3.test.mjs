// contract-v3 client side: the shop authorization (JS mirror of the contract), the bot server's v3 chat path
// (signed request, bundle always returned, optional relayer registration), the customer path, the customer
// tooling, the deploy plan and the page's v3 argument shapes. Offline: NEAR AI and NEAR are injected fakes; the
// "TEE" key is the fake public seed 0x01*32 of the simulated vectors.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyPair } from 'near-api-js';
import { makeVectors } from '../scripts/make-v3-vectors.mjs';
import {
  authLine, parseShopAuth, signRequestBytes, checkShopAuth, publicKeyFromSeed, shopAuthMessage, ZERO_SIG,
} from '../lib/shop-auth.mjs';
import { buildRequestBytes, checkBundle, sha256Hex } from '../lib/nearai.mjs';
import { makeRelayer, publicConfig, loadConfig } from '../lib/relayer.mjs';
import { detectApi, receiptArgs, orderArgs, claimArgs, buyerRegisterArgs, merchantKeyed, API_V2, API_V3 } from '../lib/contract-api.mjs';
import { planCustomerRegister, refetchSignatureRows } from '../lib/customer.mjs';
import { planDeployV3, describeDeployStep, V3_METHODS_BUYER, V3_METHODS_RELAYER } from '../lib/deploy-v3-plan.mjs';

const VECTORS_FILE = new URL('../../contract-v3/tests/v3_vectors.json', import.meta.url);
const committed = JSON.parse(fs.readFileSync(VECTORS_FILE, 'utf8'));
const TEE_SEED = '01'.repeat(32);
const SHOP_SEED = '02'.repeat(32);
const teeKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(TEE_SEED, 'hex')]), format: 'der', type: 'pkcs8' });
const CONTRACT = 'v3.cbp-sm1110.testnet';
const MERCHANT = 'cbp-shop-sm1110.testnet';
const BUYER = 'cbp-alice-sm1110.testnet';

// ---------------- the shop authorization ----------------

test('the committed v3 vectors are exactly what the generator makes (Rust and JS test the same bytes)', () => {
  assert.equal(JSON.stringify(makeVectors(), null, 2) + '\n', fs.readFileSync(VECTORS_FILE, 'utf8'));
});

test('the JS mirror gives every vector the contract\'s expected answer', () => {
  const wrong = [];
  for (const [name, c] of Object.entries(committed.cases)) {
    const key = name === 'new_key_order' ? committed.rotated_shop_public_key_hex : committed.shop_public_key_hex;
    const got = checkShopAuth(Buffer.from(c.request_b64, 'base64'), { publicKeyHex: key, contract: committed.contract, merchant: committed.merchant, order: c.order_id, buyer: committed.buyer });
    // ERR_SHOP_AUTH_USED is chain state (a first registration), not a property of the bytes
    const want = c.expect === 'ERR_SHOP_AUTH_USED' ? null : c.expect;
    if (got !== want) wrong.push(`${name}: ${got} != ${want}`);
  }
  assert.deepEqual(wrong, []);
  assert.equal(checkShopAuth(Buffer.from(committed.cases.injection.request_b64, 'base64'), { publicKeyHex: committed.shop_public_key_hex, contract: committed.contract, merchant: committed.merchant, order: 'A123', buyer: committed.buyer }), 'ERR_SHOP_AUTH_ORDER');
});

test('the signature covers the whole request: any changed byte outside the sig breaks it', () => {
  const req = Buffer.from(committed.cases.honest.request_b64, 'base64');
  const expect = { publicKeyHex: committed.shop_public_key_hex, contract: committed.contract, merchant: committed.merchant, order: 'A123', buyer: committed.buyer };
  assert.equal(checkShopAuth(req, expect), null);
  for (const from of ['broken', '2000 basis', '"temperature":0', 'nonce=0']) {
    const edited = Buffer.from(req.toString('utf8').replace(from, from.toUpperCase()), 'utf8');
    assert.notEqual(edited.toString(), req.toString(), from);
    assert.equal(checkShopAuth(edited, expect), from === 'nonce=0' ? 'ERR_SHOP_AUTH_FORMAT' : 'ERR_SHOP_AUTH_SIGNATURE', from);
  }
});

test('signRequestBytes signs the zero-placeholder template and changes only the 128 sig characters', () => {
  const line = authLine({ contract: CONTRACT, merchant: MERCHANT, order: 'A1', buyer: BUYER, nonce: 'ab'.repeat(16) });
  assert.ok(line.endsWith(`sig=${ZERO_SIG}`));
  const template = buildRequestBytes({ model: 'm', orderId: 'A1', amountNear: '1', maxPolicyBps: 1, history: [], userMessage: 'hi', shopAuthLine: line });
  const signed = signRequestBytes(template, SHOP_SEED);
  assert.equal(signed.length, template.length);
  const p = parseShopAuth(signed);
  assert.equal(signed.subarray(0, p.sigOffset).toString(), template.subarray(0, p.sigOffset).toString());
  assert.equal(signed.subarray(p.sigOffset + 128).toString(), template.subarray(p.sigOffset + 128).toString());
  assert.ok(crypto.verify(null, shopAuthMessage(signed, p.sigOffset), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyFromSeed(SHOP_SEED), 'hex')]), format: 'der', type: 'spki' }), Buffer.from(p.sig, 'hex')));
  assert.throws(() => signRequestBytes(signed, SHOP_SEED), /zero placeholder/);
  assert.throws(() => signRequestBytes(Buffer.from('no tag'), SHOP_SEED), /ERR_SHOP_AUTH_MISSING/);
});

test('authLine refuses values the contract grammar would not parse', () => {
  const ok = { contract: CONTRACT, merchant: MERCHANT, order: 'A1', buyer: BUYER, nonce: '00'.repeat(16) };
  assert.doesNotThrow(() => authLine(ok));
  assert.throws(() => authLine({ ...ok, order: 'A 1' }));
  assert.throws(() => authLine({ ...ok, buyer: 'Alice|x' }));
  assert.throws(() => authLine({ ...ok, nonce: 'xyz' }));
});

test('without a shop tag the v1/v2 request bytes are byte identical to the frozen prompt', () => {
  const args = { model: 'z-ai/glm-5.3-flash', orderId: 'A123', amountNear: '2', maxPolicyBps: 2000, history: [], userMessage: 'hi' };
  assert.equal(buildRequestBytes(args).toString(), buildRequestBytes({ ...args, shopAuthLine: undefined }).toString());
  assert.ok(!buildRequestBytes(args).toString().includes('SHOP_AUTH'));
});

// ---------------- the bot server (v3) ----------------

const openOrder = (extra = {}) => ({
  order_id: 'A123-31', merchant: MERCHANT, buyer: BUYER, amount: '20000000', max_bps: 3000, status: 'open',
  token: null, expires_at_ms: String(Date.now() + 3_600_000), shop_key: publicKeyFromSeed(SHOP_SEED), ...extra,
});
const cfg = (extra = {}) => ({
  mode: 'live', network: 'testnet', rpcUrl: 'http://127.0.0.1:1', contractId: CONTRACT, merchantId: MERCHANT, buyerId: BUYER,
  model: 'z-ai/glm-5.3-flash', signingAlgo: 'ed25519', nearaiKey: 'unused',
  relayerKey: KeyPair.fromRandom('ed25519').toString(), buyerKey: KeyPair.fromRandom('ed25519').toString(),
  shopAuthSeed: SHOP_SEED, relayerRegisters: true, orders: [{ order_id: 'A123-31', label: 'Broken mug', policy_bps: 2000 }], ...extra,
});

/** A relayer whose outside calls are fakes. The fake NEAR AI signs model:sha256(req):sha256(resp) with the fake TEE key. */
function rig({ config = {}, order = openOrder(), callFinal, api = API_V3 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relayer-v3-'));
  const calls = { final: [], requests: [] };
  const merchant = { sentinel: 'merchant' }; const buyer = { sentinel: 'buyer' };
  let n = 0;
  const relayer = makeRelayer(cfg(config), {
    api, dataDir, merchant, buyer,
    provider: { callFunction: async () => order },
    chatExact: async ({ requestBytes }) => {
      calls.requests.push(requestBytes);
      const responseBytes = Buffer.from(JSON.stringify({ id: `chat-${++n}`, choices: [{ message: { content: 'Sorry.\nPROMISE|refund|order=A123-31|bps=2000' } }] }));
      return { requestBytes, responseBytes, json: JSON.parse(responseBytes), chatId: `abc${n}` };
    },
    fetchSignature: async () => {
      const req = calls.requests.at(-1);
      const resp = Buffer.from(JSON.stringify({ id: `chat-${n}`, choices: [{ message: { content: 'Sorry.\nPROMISE|refund|order=A123-31|bps=2000' } }] }));
      const text = `z-ai/glm-5.3-flash:${sha256Hex(req)}:${sha256Hex(resp)}`;
      return { text, signature: crypto.sign(null, Buffer.from(text), teeKey).toString('hex'), signing_address: publicKeyFromSeed(TEE_SEED), signing_algo: 'ed25519', signature_kind: 'provider_tee' };
    },
    callFinal: async (...args) => { calls.final.push(args); return callFinal ? callFinal(...args) : { txHash: `TX${calls.final.length}`, value: { ok: true } }; },
  });
  return { relayer, calls, merchant, buyer, dataDir };
}
const chat = (r, message = 'My mug arrived broken.') => r.relayer.handleChat({ order_id: 'A123-31', message });

test('v3 chat: the request carries a valid shop tag for this contract/merchant/order/buyer, and the bundle is v3', async () => {
  const r = rig();
  const out = await chat(r);
  const req = Buffer.from(out.bundle.request_b64, 'base64');
  assert.equal(checkShopAuth(req, { publicKeyHex: publicKeyFromSeed(SHOP_SEED), contract: CONTRACT, merchant: MERCHANT, order: 'A123-31', buyer: BUYER }), null);
  assert.equal(out.bundle.type, 'bot-promises/receipt-bundle/v3');
  assert.deepEqual({ merchant: out.bundle.merchant, buyer: out.bundle.buyer, key: out.bundle.shop_auth.public_key_hex }, { merchant: MERCHANT, buyer: BUYER, key: publicKeyFromSeed(SHOP_SEED) });
  assert.equal(out.bundle.shop_auth.nonce, parseShopAuth(req).nonce);
  assert.ok(checkBundle(out.bundle).every(row => row.ok), JSON.stringify(checkBundle(out.bundle)));
  assert.ok(checkBundle(out.bundle).some(row => row.check.includes('shop authorization')));
  // the relayer path still registers (default)
  assert.equal(r.calls.final.length, 1);
  assert.equal(r.calls.final[0][2], 'register_receipt');
  assert.equal(out.register_tx, 'TX1');
  assert.equal(out.customer_can_register, false);
});

test('v3 chat: every request gets a fresh nonce', async () => {
  const r = rig();
  const a = await chat(r); const b = await chat(r, 'And the handle?');
  assert.notEqual(a.bundle.shop_auth.nonce, b.bundle.shop_auth.nonce);
});

test('v3 trap 2: with RELAYER_REGISTERS=0 nothing is registered and the full signed bundle still comes back', async () => {
  const r = rig({ config: { relayerRegisters: false } });
  const out = await chat(r);
  assert.equal(r.calls.final.length, 0);
  assert.equal(out.register_tx, null);
  assert.equal(out.customer_can_register, true);
  for (const k of ['request_b64', 'response_b64', 'request_hash', 'response_hash']) assert.ok(out.bundle[k], k);
  assert.ok(out.bundle.signature.signature && out.bundle.signature.signing_address && out.bundle.signature.text);
});

test('v3 trap 2: a failed relayer registration still returns the bundle (the customer can register it)', async () => {
  const r = rig({ callFinal: async () => { throw Object.assign(new Error('tx X failed: ERR_STORAGE_BALANCE'), { txHash: 'X' }); } });
  const out = await chat(r);
  assert.equal(out.register_error, 'ERR_STORAGE_BALANCE');
  assert.equal(out.customer_can_register, true);
  assert.ok(out.bundle.request_b64);
});

test('v3 chat refuses a message that smuggles a second tag, a missing seed and a key that is not the order\'s', async () => {
  await assert.rejects(chat(rig(), 'hi SHOP_AUTH|v3|x'), /ERR_BAD_REQUEST/);
  await assert.rejects(chat(rig({ config: { shopAuthSeed: null } })), /ERR_NO_SHOP_AUTH_KEY/);
  await assert.rejects(chat(rig({ order: openOrder({ shop_key: publicKeyFromSeed('04'.repeat(32)) }) })), /ERR_SHOP_KEY_MISMATCH/);
});

test('v2 chat is unchanged: no tag in the request, v1 bundle type, registration first', async () => {
  const r = rig({ api: API_V2, order: openOrder({ shop_key: undefined }) });
  const out = await chat(r);
  assert.ok(!Buffer.from(out.bundle.request_b64, 'base64').toString().includes('SHOP_AUTH'));
  assert.equal(out.bundle.type, 'bot-promises/receipt-bundle/v1');
  assert.equal(out.register_tx, 'TX1');
});

test('the customer path (demo endpoint) signs register_receipt_as_buyer with the BUYER account and the bundle\'s exact fields', async () => {
  const r = rig({ config: { relayerRegisters: false } });
  const { bundle } = await chat(r);
  const out = await r.relayer.handleCustomerRegister({ order_id: 'A123-31', bundle });
  assert.equal(out.ok, true);
  const [account, contractId, method, args] = r.calls.final[0];
  assert.equal(account, r.buyer);
  assert.equal(contractId, CONTRACT);
  assert.equal(method, 'register_receipt_as_buyer');
  assert.deepEqual(args, buyerRegisterArgs(MERCHANT, bundle));
  assert.deepEqual(Object.keys(args).sort(), ['merchant', 'order_id', 'request_b64', 'signature_hex', 'signed_text', 'signer_public_key_hex']);
  const log = fs.readFileSync(path.join(r.dataDir, 'customer.log'), 'utf8');
  assert.match(log, /register_receipt_as_buyer/);
});

test('the customer endpoint refuses a tampered bundle, another order\'s bundle and a v2 contract before signing', async () => {
  const r = rig({ config: { relayerRegisters: false } });
  const { bundle } = await chat(r);
  const tampered = { ...bundle, response_b64: Buffer.from(Buffer.from(bundle.response_b64, 'base64').toString().replace('2000', '3000')).toString('base64') };
  await assert.rejects(r.relayer.handleCustomerRegister({ order_id: 'A123-31', bundle: tampered }), /LOCAL_CHECK_FAILED/);
  await assert.rejects(r.relayer.handleCustomerRegister({ order_id: 'A124-31', bundle }), /ERR_BAD_REQUEST/);
  const v2 = rig({ api: API_V2 });
  await assert.rejects(v2.relayer.handleCustomerRegister({ order_id: 'A123-31', bundle }), /ERR_BAD_REQUEST/);
  assert.equal(r.calls.final.length, 0);
});

test('publicConfig and loadConfig for v3', () => {
  const pc = publicConfig({ ...cfg({ relayerRegisters: false }), contractApi: API_V3, tokens: [] });
  assert.equal(pc.contract_api, 3);
  assert.equal(pc.relayer_registers, false);
  assert.deepEqual(pc.tokens, []);
  assert.ok(!JSON.stringify(pc).includes(SHOP_SEED), 'the seed never leaves the server');
  const base = { CONTRACT_ID: 'c', MERCHANT_ID: 'm', RELAYER_SECRET_KEY: 'x', BUYER_ID: 'b', BUYER_CLAIM_SECRET_KEY: 'y', NEARAI_API_KEY: 'k' };
  assert.equal(loadConfig(base).relayerRegisters, true);
  assert.equal(loadConfig({ ...base, RELAYER_REGISTERS: '0' }).relayerRegisters, false);
  assert.equal(loadConfig({ ...base, SHOP_AUTH_SEED_HEX: SHOP_SEED }).shopAuthSeed, SHOP_SEED);
});

// ---------------- argument shapes ----------------

test('contract-api: v3 is detected and keeps v2 shapes, except get_receipt which needs the order', async () => {
  assert.equal(await detectApi({ callFunction: async () => ({ api: 3 }) }, 'c'), API_V3);
  assert.equal(merchantKeyed(API_V3), true);
  assert.deepEqual(orderArgs(API_V3, 'm', 'o'), { merchant: 'm', order_id: 'o' });
  assert.deepEqual(claimArgs(API_V3, 'm', 'o', 'b'), { merchant: 'm', order_id: 'o', response_b64: 'b' });
  assert.deepEqual(receiptArgs(API_V3, 'm', 'h', 'o'), { merchant: 'm', order_id: 'o', response_hash: 'h' });
  assert.throws(() => receiptArgs(API_V3, 'm', 'h'), /order id/);
  assert.deepEqual(receiptArgs(API_V2, 'm', 'h', 'o'), { merchant: 'm', response_hash: 'h' });
});

// ---------------- customer tooling ----------------

function stubProvider(views) {
  const seen = [];
  return { seen, callFunction: async ({ method, args }) => { seen.push([method, args]); return typeof views[method] === 'function' ? views[method](args) : views[method]; } };
}

test('planCustomerRegister: registrable bundle, already registered, and a refused one', async () => {
  const r = rig({ config: { relayerRegisters: false } });
  const { bundle } = await chat(r);
  const order = openOrder();
  const p = stubProvider({ get_config: { api: 3 }, get_order: order, get_receipt: null, preview_register_as_buyer: null });
  const plan = await planCustomerRegister({ bundle, merchant: MERCHANT, contractId: CONTRACT, provider: p });
  assert.ok(plan.rows.every(x => x.ok), JSON.stringify(plan.rows.filter(x => !x.ok)));
  assert.equal(plan.registered, false);
  assert.equal(plan.preview, null);
  assert.deepEqual(p.seen.find(([m]) => m === 'preview_register_as_buyer')[1], { ...buyerRegisterArgs(MERCHANT, bundle), buyer: BUYER });
  assert.deepEqual(p.seen.find(([m]) => m === 'get_receipt')[1], { merchant: MERCHANT, order_id: 'A123-31', response_hash: bundle.response_hash });

  const done = await planCustomerRegister({ bundle, merchant: MERCHANT, contractId: CONTRACT, provider: stubProvider({ get_config: { api: 3 }, get_order: order, get_receipt: { registered_by: MERCHANT, block_height: 1 } }) });
  assert.equal(done.registered, true);

  const refusedPlan = await planCustomerRegister({ bundle, merchant: MERCHANT, contractId: CONTRACT, provider: stubProvider({ get_config: { api: 3 }, get_order: openOrder({ shop_key: '11'.repeat(32) }), get_receipt: null, preview_register_as_buyer: 'ERR_SHOP_AUTH_SIGNATURE' }) });
  assert.equal(refusedPlan.preview, 'ERR_SHOP_AUTH_SIGNATURE');
  assert.ok(refusedPlan.rows.some(x => !x.ok && x.check.includes('shop_key')));

  const v2 = await planCustomerRegister({ bundle, merchant: MERCHANT, contractId: CONTRACT, provider: stubProvider({ get_config: { api: 2 } }) });
  assert.equal(v2.preview, 'ERR_NOT_V3');
});

test('trap 2, independent route: the customer re-fetches the TEE signature by chat id with their own key', async () => {
  const r = rig({ config: { relayerRegisters: false } });
  const { bundle } = await chat(r);
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url, auth: opts.headers.Authorization }); return new Response(JSON.stringify(bundle.signature), { status: 200 }); };
  const rows = await refetchSignatureRows(bundle, { apiKey: 'customer-own-key', fetchImpl });
  assert.ok(rows.every(x => x.ok));
  assert.match(seen[0].url, new RegExp(`/signature/${bundle.chat_id}\\?model=`));
  assert.equal(seen[0].auth, 'Bearer customer-own-key');
  const other = await refetchSignatureRows(bundle, { apiKey: 'k', fetchImpl: async () => new Response(JSON.stringify({ ...bundle.signature, signature: 'ff'.repeat(64) }), { status: 200 }) });
  assert.ok(other.some(x => !x.ok));
  const missing = await refetchSignatureRows(bundle, { apiKey: 'k', tries: 2, delayMs: 1, fetchImpl: async () => new Response('{}', { status: 404 }) });
  assert.equal(missing[0].ok, false);
  assert.equal((await refetchSignatureRows(bundle, {}))[0].ok, false);
});

// ---------------- deploy plan ----------------

const signer = { publicKeyHex: '5a'.repeat(32), model: 'z-ai/glm-5.3-flash', attestationSha256: '52'.repeat(32), expiresAtMs: '1796035500000' };
const plan = (extra = {}) => planDeployV3({ contractId: 'v3.cbp-sm1110.testnet', ownerId: 'cbp-v3-owner.testnet', merchantId: MERCHANT, buyerId: BUYER, tokenId: 'sm1110-tusdc.testnet', signer, shopKeyHex: publicKeyFromSeed(SHOP_SEED), relayerPublicKey: 'ed25519:R', buyerPublicKey: 'ed25519:B', ...extra });

test('deploy plan: deploy + init in one tx with a separate owner, then signer, storage, shop key, keys', () => {
  const steps = plan();
  assert.deepEqual(steps.map(s => s.id), ['deploy-and-init', 'market-on-token', 'add-signer', 'merchant-storage', 'shop-key', 'buyer-storage', 'relayer-key', 'buyer-key']);
  assert.deepEqual(steps[0].actions.map(a => a.type), ['deployContract', 'functionCall']);
  assert.equal(steps[0].actions[1].args.owner, 'cbp-v3-owner.testnet');
  assert.equal(steps.find(s => s.id === 'add-signer').depositYocto, 1n);
  assert.equal(steps.find(s => s.id === 'shop-key').depositYocto, 1n);
  assert.deepEqual(steps.find(s => s.id === 'relayer-key').actions[0].methodNames, V3_METHODS_RELAYER);
  assert.deepEqual(steps.find(s => s.id === 'buyer-key').actions[0].methodNames, V3_METHODS_BUYER);
  assert.ok(steps.every(s => typeof describeDeployStep(s) === 'string'));
});

test('deploy plan: --lock adds the key deletion LAST, and the owner can never be the contract', () => {
  const steps = plan({ lock: true });
  assert.equal(steps.at(-1).id, 'lock-contract-account');
  assert.match(describeDeployStep(steps.at(-1)), /keyless/);
  assert.throws(() => plan({ ownerId: 'v3.cbp-sm1110.testnet' }), /owner/);
  assert.throws(() => plan({ shopKeyHex: 'zz' }), /shopKeyHex/);
});

// ---------------- the page ----------------

test('page: on v3 get_receipt carries the order id and the customer button posts the bundle unchanged', async () => {
  globalThis.location = new URL('http://127.0.0.1:8787/');
  const app = await import('../../web/app.js?v3');
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ mode: 'live', contract_api: 3, merchantId: MERCHANT, orders: [], tokens: [] }));
  try { await app.loadConfig(); } finally { globalThis.fetch = real; }
  assert.equal(app.isV3(), true);
  assert.equal(app.isV2(), true, 'v3 keeps the merchant-keyed v2 shapes');
  assert.deepEqual(app.receiptArgs('h', 'A1'), { merchant: MERCHANT, order_id: 'A1', response_hash: 'h' });
  const bundle = { order_id: 'A1', request_b64: 'cQ==' };
  assert.deepEqual(app.customerRegisterBody('A1', bundle), { order_id: 'A1', bundle });
  const full = { order_id: 'A1', request_b64: 'cQ==', signature: { text: 't', signature: 's', signing_address: 'k' } };
  // the page asks the contract with exactly the argument names of register_receipt_as_buyer plus `buyer`
  assert.deepEqual(app.customerPreviewArgs(full, BUYER), { ...buyerRegisterArgs(MERCHANT, full), buyer: BUYER });
});
