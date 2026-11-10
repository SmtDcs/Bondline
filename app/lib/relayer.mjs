// Relayer logic (merchant's bot server). INTERFACES.md section 11.
// Order of operations in handleChat is FROZEN: build bytes -> NEAR AI -> signature -> local check ->
// register_receipt (wait FINAL) -> only then return the reply.
import fs from 'node:fs';
import path from 'node:path';
import { buildRequestBytes, chatExact, fetchSignature, checkBundle, sha256Hex } from './nearai.mjs';
import { makeProvider, accountFromKey, callFinal, explorerTx } from './near.mjs';

/**
 * A badly configured (naive) order is told it may promise up to 100% (TASKS T06/S2). This is a
 * SYSTEM-PROMPT input only: the order's on-chain max_bps (3000 in the demo) still caps the payout.
 */
export const NAIVE_POLICY_BPS = 10000;

export const DEFAULT_DEMO_ORDERS = 'A123-01:Broken mug:2000,A124-01:Late delivery:2000:naive';

/**
 * DEMO_ORDERS = `order_id:label:policy_bps[:naive]`, comma separated (INTERFACES 13 plus CR-3:
 * the optional trailing `naive` flag labels the badly configured bot; without it the order gets the
 * honest prompt and its own policy_bps). The flag is the ONLY switch: no order id is special.
 */
export function parseDemoOrders(value = DEFAULT_DEMO_ORDERS) {
  return String(value).split(',').filter(s => s.trim() !== '').map(rawEntry => {
    const entry = rawEntry.trim();
    const [order_id, label, policy, flag, ...rest] = entry.split(':');
    const policy_bps = Number(policy);
    const bad = (why) => new Error(`bad DEMO_ORDERS entry ${JSON.stringify(entry)}: ${why} (expected order_id:label:policy_bps[:naive])`);
    if (!order_id || !label || !Number.isInteger(policy_bps) || policy_bps <= 0 || rest.length > 0) throw bad('malformed');
    if (flag !== undefined && flag !== 'naive') throw bad(`unknown flag ${JSON.stringify(flag)}`);
    return { order_id: order_id.trim(), label: label.trim(), policy_bps, naive: flag === 'naive' };
  });
}

export function loadConfig(env = process.env) {
  const need = ['CONTRACT_ID', 'MERCHANT_ID', 'RELAYER_SECRET_KEY', 'BUYER_ID', 'BUYER_CLAIM_SECRET_KEY', 'NEARAI_API_KEY'];
  for (const k of need) if (!env[k]) throw new Error(`missing env ${k} (see .env.example)`);
  const orders = parseDemoOrders(env.DEMO_ORDERS ?? DEFAULT_DEMO_ORDERS);
  return {
    mode: 'live', network: 'testnet',
    rpcUrl: env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com',
    contractId: env.CONTRACT_ID, merchantId: env.MERCHANT_ID, buyerId: env.BUYER_ID,
    model: env.MODEL ?? 'z-ai/glm-5.3-flash', signingAlgo: env.SIGNING_ALGO ?? 'ed25519',
    nearaiKey: env.NEARAI_API_KEY, relayerKey: env.RELAYER_SECRET_KEY, buyerKey: env.BUYER_CLAIM_SECRET_KEY,
    orders,
  };
}

/** Public part of the config (never includes keys). */
export function publicConfig(cfg) {
  const { mode, network, rpcUrl, contractId, merchantId, buyerId, model, orders } = cfg;
  // `naive` is additive (CR-3) and only present when true, so the honest /api/config payload is unchanged.
  return {
    mode, network, rpcUrl, contractId, merchantId, buyerId, model,
    orders: orders.map(({ order_id, label, naive }) => ({ order_id, label, ...(naive ? { naive: true } : {}) })),
  };
}

export function makeRelayer(cfg, deps = {}) {
  const provider = deps.provider ?? makeProvider(cfg.rpcUrl);
  const merchant = deps.merchant ?? accountFromKey(provider, cfg.merchantId, cfg.relayerKey);
  const buyer = deps.buyer ?? accountFromKey(provider, cfg.buyerId, cfg.buyerKey);
  // Overridable so tests can assert the exact request bytes without a paid NEAR AI call.
  const buildBytes = deps.buildRequestBytes ?? buildRequestBytes;
  const chatOnce = deps.chatExact ?? chatExact;
  const history = new Map(); // order_id -> [{role, content}]
  const dataDir = 'data';
  const bundleDir = path.join(dataDir, 'bundles');
  fs.mkdirSync(bundleDir, { recursive: true });
  // T18: one JSON line per claim / register-edited attempt, read back by app/scripts/record-transcript.mjs.
  const appendLog = (file, entry) => fs.appendFileSync(path.join(dataDir, file), JSON.stringify(entry) + '\n');

  async function handleChat({ order_id, message } = {}) {
    requireOrderId(order_id);
    requireMessage(message);
    const order = await provider.callFunction({ contractId: cfg.contractId, method: 'get_order', args: { order_id } });
    if (!order) throw Object.assign(new Error('ERR_NO_ORDER'), { status: 404 });
    if (String(order.merchant) !== cfg.merchantId) throw badRequest(`order ${order_id} belongs to ${order.merchant}, not ${cfg.merchantId}`);
    if (order.status !== 'open') throw Object.assign(new Error('ERR_ALREADY_CLAIMED'), { status: 400, detail: `order ${order_id} is ${order.status}` });
    const meta = cfg.orders.find(o => o.order_id === order_id) ?? { policy_bps: 2000, naive: false };
    const amountNear = (Number(BigInt(order.amount) / 10n ** 21n) / 1000).toString(); // display only
    const turns = history.get(order_id) ?? [];
    // The DEMO_ORDERS `naive` flag marks the badly configured bot (docs/spike-s2.md, PLAN R4).
    // It changes the system prompt (and the policy the bot is told about) only; the on-chain max_bps
    // stays 3000, so the contract caps the payout.
    const naive = meta.naive === true;
    const requestBytes = buildBytes({
      model: cfg.model, orderId: order_id, amountNear,
      maxPolicyBps: naive ? NAIVE_POLICY_BPS : meta.policy_bps,
      history: turns, userMessage: message, naivePolicy: naive,
    });
    const chat = await chatOnce({ apiKey: cfg.nearaiKey, requestBytes });
    const signature = await fetchSignature({ apiKey: cfg.nearaiKey, chatId: chat.chatId, model: cfg.model, signingAlgo: cfg.signingAlgo });
    const chatId = safeChatId(chat.chatId);
    const bundle = {
      type: 'bot-promises/receipt-bundle/v1', simulated: false, order_id, model: cfg.model, chat_id: chatId,
      created_at: new Date().toISOString(),
      request_b64: requestBytes.toString('base64'), response_b64: chat.responseBytes.toString('base64'),
      request_hash: sha256Hex(requestBytes), response_hash: sha256Hex(chat.responseBytes),
      signature, attestation: null,
      chain: { network: 'testnet', contract: cfg.contractId, register_tx: null, claim_tx: null },
    };
    const failed = checkBundle(bundle).filter(r => !r.ok);
    if (failed.length) throw Object.assign(new Error('LOCAL_CHECK_FAILED'), { status: 502, detail: JSON.stringify(failed) });
    const reg = await callFinal(merchant, cfg.contractId, 'register_receipt', {
      order_id, signed_text: signature.text, signature_hex: signature.signature, signer_public_key_hex: signature.signing_address,
    }, { tgas: 100 });
    bundle.chain.register_tx = reg.txHash;
    fs.writeFileSync(path.join(bundleDir, `${chatId}.json`), JSON.stringify(bundle, null, 2) + '\n');
    const reply = chat.json.choices?.[0]?.message?.content ?? '';
    history.set(order_id, [...turns, { role: 'user', content: message }, { role: 'assistant', content: reply }]);
    return { reply, bundle, register_tx: reg.txHash, explorer: explorerTx(reg.txHash) };
  }

  async function handleClaim({ order_id, response_b64 }) {
    const r = await callFinal(buyer, cfg.contractId, 'claim', { order_id, response_b64 }, { tgas: 100 });
    appendLog('claims.log', { order_id, claim_tx: r.txHash, result: r.value });
    return { ok: true, result: r.value, claim_tx: r.txHash, explorer: explorerTx(r.txHash) };
  }

  /** The merchant tries to register an EDITED reply under the real TEE signature. Must fail with ERR_BAD_SIGNATURE. */
  async function handleRegisterEdited({ order_id, bundle, edit } = {}) {
    requireOrderId(order_id);
    if (typeof bundle?.response_b64 !== 'string') throw badRequest('bundle.response_b64 must be a base64 string');
    if (!edit || typeof edit.from !== 'string' || edit.from.length === 0 || typeof edit.to !== 'string') throw badRequest('edit must be {from: string, to: string}');
    const bytes = Buffer.from(bundle.response_b64, 'base64').toString('utf8');
    if (!bytes.includes(edit.from)) throw Object.assign(new Error('ERR_EDIT_NOT_FOUND'), { status: 400, detail: `edit.from ${JSON.stringify(edit.from)} is not in the reply bytes` });
    const editedHash = sha256Hex(Buffer.from(bytes.replace(edit.from, edit.to), 'utf8'));
    const editedText = bundle.signature.text.replace(bundle.response_hash, editedHash);
    try {
      const r = await callFinal(merchant, cfg.contractId, 'register_receipt', {
        order_id, signed_text: editedText, signature_hex: bundle.signature.signature, signer_public_key_hex: bundle.signature.signing_address,
      }, { tgas: 100 });
      appendLog('merchant.log', { kind: 'register-edited', order_id, tx: r.txHash, error: null });
      return r;
    } catch (e) {
      appendLog('merchant.log', { kind: 'register-edited', order_id, tx: e.txHash ?? null, error: errCode(e) });
      throw e;
    }
  }

  return { handleChat, handleClaim, handleRegisterEdited };
}

const ORDER_ID_RE = /^[A-Za-z0-9-]{1,32}$/;
const CHAT_ID_RE = /^[0-9a-f-]{1,64}$/;
const MAX_MESSAGE_CHARS = 2000;

function badRequest(detail) {
  return Object.assign(new Error('ERR_BAD_REQUEST'), { status: 400, detail });
}

function requireOrderId(order_id) {
  if (typeof order_id !== 'string' || !ORDER_ID_RE.test(order_id)) throw badRequest('order_id must match ^[A-Za-z0-9-]{1,32}$');
}

function requireMessage(message) {
  if (typeof message !== 'string' || message.length < 1 || message.length > MAX_MESSAGE_CHARS) throw badRequest(`message must be a string of 1..${MAX_MESSAGE_CHARS} characters`);
}

/** The chat id becomes a file name under data/bundles/: keep only its basename and a hex-ish id. */
export function safeChatId(id) {
  const base = path.basename(String(id ?? ''));
  if (!CHAT_ID_RE.test(base)) throw Object.assign(new Error('ERR_BAD_CHAT_ID'), { status: 502, detail: 'NEAR AI returned an unusable chat id' });
  return base;
}

/** Pull "ERR_..." out of any thrown error (contract panics, RPC errors). */
export function errCode(e) {
  const m = String(e?.message ?? e).match(/ERR_[A-Z_]+/) ?? JSON.stringify(e ?? {}).match(/ERR_[A-Z_]+/);
  return m ? m[0] : 'ERR_INTERNAL';
}
