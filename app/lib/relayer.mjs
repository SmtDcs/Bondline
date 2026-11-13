// Relayer logic (merchant's bot server). INTERFACES.md section 11.
// Order of operations in handleChat is FROZEN: build bytes -> NEAR AI -> signature -> local check ->
// register_receipt (wait FINAL) -> only then return the reply.
import fs from 'node:fs';
import path from 'node:path';
import { buildRequestBytes, chatExact, fetchSignature, checkBundle, sha256Hex } from './nearai.mjs';
import { makeProvider, accountFromKey, callFinal, explorerTx, payoutFailedValue } from './near.mjs';
import { detectApi, orderArgs, claimArgs, buyerRegisterArgs, merchantKeyed, API_V1, API_V3 } from './contract-api.mjs';
import { authLine, newNonce, signRequestBytes, publicKeyFromSeed, SHOP_AUTH_MARKER } from './shop-auth.mjs';
import { ftMetadata, registrationHint } from './token.mjs';
import { formatAmount } from './amount.mjs';

/**
 * A badly configured (naive) order is told it may promise up to 100% (docs/PROMPT-TESTS.md). This is a
 * SYSTEM-PROMPT input only: the order's on-chain max_bps (3000 in the demo) still caps the payout.
 */
export const NAIVE_POLICY_BPS = 10000;

export const DEFAULT_DEMO_ORDERS = 'A123-01:Broken mug:2000,A124-01:Late delivery:2000:naive';

/**
 * DEMO_ORDERS = `order_id:label:policy_bps[:naive]`, comma separated (INTERFACES 13; the
 * optional trailing `naive` flag labels the badly configured bot; without it the order gets the
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
  // An empty/blank DEMO_ORDERS means "not set": use the default instead of starting with no orders.
  const orders = parseDemoOrders(String(env.DEMO_ORDERS ?? '').trim() || DEFAULT_DEMO_ORDERS);
  if (orders.length === 0) throw new Error('DEMO_ORDERS has no order: run demo-setup.sh and set order_id:label:policy_bps[,...] (see .env.example)');
  return {
    mode: 'live', network: 'testnet',
    rpcUrl: env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com',
    contractId: env.CONTRACT_ID, merchantId: env.MERCHANT_ID, buyerId: env.BUYER_ID,
    model: env.MODEL ?? 'z-ai/glm-5.3-flash', signingAlgo: env.SIGNING_ALGO ?? 'ed25519',
    nearaiKey: env.NEARAI_API_KEY, relayerKey: env.RELAYER_SECRET_KEY, buyerKey: env.BUYER_CLAIM_SECRET_KEY,
    // Scripts only; the relayer itself never moves tokens in. The value is not a key.
    tokenId: env.TOKEN_ID ?? null,
    // Optional override for tests/tools; null means "detect with get_config at the first call".
    contractApi: env.CONTRACT_API ? Number(env.CONTRACT_API) : null,
    // v3 only: the shop-auth seed (32 bytes hex) whose public key the merchant registered with set_shop_key. Never
    // sent anywhere; only its signatures leave the server, inside the request bytes.
    shopAuthSeed: env.SHOP_AUTH_SEED_HEX ?? null,
    // v3 only: '0' = the relayer does NOT register receipts (an uncooperative shop); the customer registers instead.
    relayerRegisters: String(env.RELAYER_REGISTERS ?? '1') !== '0',
    orders,
  };
}

/** Public part of the config (never includes keys).
 *  contract_api/tokens and per-order token/expires_at_ms are additive and only present on v2,
 *  so a v1 payload stays byte-compatible (pinned by app/test/server.test.mjs). */
export function publicConfig(cfg) {
  const { mode, network, rpcUrl, contractId, merchantId, buyerId, model, orders } = cfg;
  const api = cfg.contractApi ?? null;
  const out = {
    mode, network, rpcUrl, contractId, merchantId, buyerId, model,
    orders: orders.map(({ order_id, label, naive, token, expires_at_ms }) => ({
      order_id, label,
      ...(naive ? { naive: true } : {}),
      ...(merchantKeyed(api) ? { token: token ?? null, expires_at_ms: expires_at_ms ?? null } : {}),
    })),
  };
  if (api != null) out.contract_api = api;
  if (merchantKeyed(api)) out.tokens = cfg.tokens ?? [];
  if (api === API_V3) out.relayer_registers = cfg.relayerRegisters !== false;
  return out;
}

export function makeRelayer(cfg, deps = {}) {
  const provider = deps.provider ?? makeProvider(cfg.rpcUrl);
  const merchant = deps.merchant ?? accountFromKey(provider, cfg.merchantId, cfg.relayerKey);
  const buyer = deps.buyer ?? accountFromKey(provider, cfg.buyerId, cfg.buyerKey);
  // Overridable so tests can assert the exact request bytes without a paid NEAR AI call.
  const buildBytes = deps.buildRequestBytes ?? buildRequestBytes;
  const chatOnce = deps.chatExact ?? chatExact;
  const finalCall = deps.callFinal ?? callFinal;
  const getSignature = deps.fetchSignature ?? fetchSignature; // injectable so the whole chat path runs offline
  const history = new Map(); // order_id -> [{role, content}]
  const dataDir = deps.dataDir ?? 'data';
  const bundleDir = path.join(dataDir, 'bundles');
  fs.mkdirSync(bundleDir, { recursive: true });
  // One JSON line per claim / register-edited attempt, read back by app/scripts/record-transcript.mjs.
  // A log write must never turn a paid-out claim (or a recorded failed registration) into an API error.
  const appendLog = (file, entry) => {
    try { fs.appendFileSync(path.join(dataDir, file), JSON.stringify(entry) + '\n'); }
    catch (e) { console.error(`log write failed (${file}): ${e.message}`); }
  };

  // v2 is detected once with get_config; MethodNotFound means v1, every other error is raised
  // (app/lib/contract-api.mjs). deps.api pins it in tests/tools.
  let apiPromise;
  async function apiVersion() {
    if (deps.api) return deps.api;
    if (cfg.contractApi) return cfg.contractApi;
    if (!apiPromise) {
      apiPromise = typeof provider?.callFunction === 'function'
        ? detectApi(provider, cfg.contractId)
        : Promise.resolve(API_V1);
    }
    return apiPromise;
  }
  const tokenMeta = new Map(); // token id -> {id, symbol, decimals}
  async function metaFor(tokenId) {
    if (!tokenMeta.has(tokenId)) tokenMeta.set(tokenId, await ftMetadata(provider, tokenId));
    return tokenMeta.get(tokenId);
  }

  async function handleChat({ order_id, message } = {}) {
    requireOrderId(order_id);
    requireMessage(message);
    const api = await apiVersion();
    const order = await provider.callFunction({ contractId: cfg.contractId, method: 'get_order', args: orderArgs(api, cfg.merchantId, order_id) });
    if (!order) throw Object.assign(new Error('ERR_NO_ORDER'), { status: 404 });
    if (String(order.merchant) !== cfg.merchantId) throw badRequest(`order ${order_id} belongs to ${order.merchant}, not ${cfg.merchantId}`);
    const expiresAt = order.expires_at_ms == null ? null : Number(order.expires_at_ms);
    if (order.status === 'expired' || (expiresAt != null && Date.now() >= expiresAt)) {
      throw Object.assign(new Error('ERR_ORDER_EXPIRED'), { status: 400, detail: `order ${order_id} expired, a new reply cannot be registered` });
    }
    if (order.status === 'paying') throw Object.assign(new Error('ERR_CLAIM_IN_PROGRESS'), { status: 400, detail: `order ${order_id} has a payout in flight` });
    if (order.status !== 'open') throw Object.assign(new Error('ERR_ALREADY_CLAIMED'), { status: 400, detail: `order ${order_id} is ${order.status}` });
    const meta = cfg.orders.find(o => o.order_id === order_id) ?? { policy_bps: 2000, naive: false };
    const amountNear = (Number(BigInt(order.amount) / 10n ** 21n) / 1000).toString(); // display only
    // A token order shows its own currency; a NEAR order keeps the frozen `2 NEAR` wording (byte identical).
    const amountLabel = order.token ? await tokenLabel(order.token, order.amount) : undefined;
    const turns = history.get(order_id) ?? [];
    // The DEMO_ORDERS `naive` flag marks the badly configured bot (docs/PROMPT-TESTS.md).
    // It changes the system prompt (and the policy the bot is told about) only; the on-chain max_bps
    // stays 3000, so the contract caps the payout.
    const naive = meta.naive === true;
    const v3 = api === API_V3;
    let shopAuth = null;
    if (v3) shopAuth = prepareShopAuth(order, order_id, message);
    let requestBytes = buildBytes({
      model: cfg.model, orderId: order_id, amountNear, amountLabel,
      maxPolicyBps: naive ? NAIVE_POLICY_BPS : meta.policy_bps,
      history: turns, userMessage: message, naivePolicy: naive,
      ...(shopAuth ? { shopAuthLine: shopAuth.line } : {}),
    });
    // v3 trap 1: the shop signs THIS request (all of its bytes), so the contract can tell it from a request the
    // customer built and sent to NEAR AI on their own.
    if (shopAuth) requestBytes = signRequestBytes(requestBytes, cfg.shopAuthSeed);
    const chat = await chatOnce({ apiKey: cfg.nearaiKey, requestBytes });
    const signature = await getSignature({ apiKey: cfg.nearaiKey, chatId: chat.chatId, model: cfg.model, signingAlgo: cfg.signingAlgo });
    const chatId = safeChatId(chat.chatId);
    const bundle = {
      type: v3 ? 'bot-promises/receipt-bundle/v3' : 'bot-promises/receipt-bundle/v1', simulated: false, order_id, model: cfg.model, chat_id: chatId,
      created_at: new Date().toISOString(),
      request_b64: requestBytes.toString('base64'), response_b64: chat.responseBytes.toString('base64'),
      request_hash: sha256Hex(requestBytes), response_hash: sha256Hex(chat.responseBytes),
      signature, attestation: null,
      ...(v3 ? { merchant: cfg.merchantId, buyer: String(order.buyer), shop_auth: { nonce: shopAuth.nonce, public_key_hex: shopAuth.publicKeyHex } } : {}),
      chain: { network: 'testnet', contract: cfg.contractId, register_tx: null, claim_tx: null },
    };
    const failed = checkBundle(bundle).filter(r => !r.ok);
    if (failed.length) throw Object.assign(new Error('LOCAL_CHECK_FAILED'), { status: 502, detail: JSON.stringify(failed) });
    const reply = chat.json.choices?.[0]?.message?.content ?? '';
    const remember = () => history.set(order_id, [...turns, { role: 'user', content: message }, { role: 'assistant', content: reply }]);
    if (!v3) {
      const reg = await finalCall(merchant, cfg.contractId, 'register_receipt', {
        order_id, signed_text: signature.text, signature_hex: signature.signature, signer_public_key_hex: signature.signing_address,
      }, { tgas: 100 });
      bundle.chain.register_tx = reg.txHash;
      fs.writeFileSync(path.join(bundleDir, `${chatId}.json`), JSON.stringify(bundle, null, 2) + '\n');
      remember();
      return { reply, bundle, register_tx: reg.txHash, explorer: explorerTx(reg.txHash) };
    }
    // v3 trap 2: the customer ALWAYS gets the full signed bundle (request bytes, response bytes, TEE signature,
    // signer), whether or not the relayer registers it and even when that registration fails, so the customer can
    // register it with register_receipt_as_buyer.
    let registerError = null;
    if (cfg.relayerRegisters !== false) {
      try {
        const reg = await finalCall(merchant, cfg.contractId, 'register_receipt', {
          order_id, signed_text: signature.text, signature_hex: signature.signature, signer_public_key_hex: signature.signing_address,
        }, { tgas: 100 });
        bundle.chain.register_tx = reg.txHash;
      } catch (e) {
        registerError = errCode(e);
      }
    }
    fs.writeFileSync(path.join(bundleDir, `${chatId}.json`), JSON.stringify(bundle, null, 2) + '\n');
    remember();
    const tx = bundle.chain.register_tx;
    return {
      reply, bundle, register_tx: tx, ...(tx ? { explorer: explorerTx(tx) } : {}),
      customer_can_register: !tx, ...(registerError ? { register_error: registerError } : {}),
    };
  }

  /** v3: the tag for one request, after checking that this server's key is the order's on-chain shop key. */
  function prepareShopAuth(order, orderId, message) {
    if (message.includes(SHOP_AUTH_MARKER)) throw badRequest(`message must not contain ${SHOP_AUTH_MARKER}`);
    if (!cfg.shopAuthSeed) throw Object.assign(new Error('ERR_NO_SHOP_AUTH_KEY'), { status: 500, detail: 'set SHOP_AUTH_SEED_HEX for a v3 contract (.env.example)' });
    const publicKeyHex = publicKeyFromSeed(cfg.shopAuthSeed);
    if (String(order.shop_key ?? '').toLowerCase() !== publicKeyHex) {
      throw Object.assign(new Error('ERR_SHOP_KEY_MISMATCH'), { status: 500, detail: `order ${orderId} expects shop key ${order.shop_key}, this server signs with ${publicKeyHex}` });
    }
    const nonce = newNonce();
    const line = authLine({ contract: cfg.contractId, merchant: cfg.merchantId, order: orderId, buyer: String(order.buyer), nonce });
    return { line, nonce, publicKeyHex };
  }

  async function tokenLabel(tokenId, rawAmount) {
    const meta = await metaFor(tokenId);
    return `${formatAmount(rawAmount, meta.decimals)} ${meta.symbol}`;
  }

  async function handleClaim({ order_id, response_b64 } = {}) {
    // Validate before a transaction is signed: a malformed request must never spend the claim key's gas allowance.
    requireOrderId(order_id);
    requireResponseB64(response_b64);
    const api = await apiVersion();
    try {
      const r = await finalCall(buyer, cfg.contractId, 'claim', claimArgs(api, cfg.merchantId, order_id, response_b64), { tgas: 100 });
      // A successful transaction is not a successful payout: the contract's callback returns ok:false
      // when the transfer failed and put the order back to open. The shopper can retry after fixing it.
      const failed = payoutFailedValue(r.value);
      if (failed) {
        const error = failed.error ?? 'ERR_PAYOUT_FAILED';
        appendLog('claims.log', { order_id, claim_tx: r.txHash, error: 'ERR_PAYOUT_FAILED' });
        // The callback names the order's token: null means a NEAR order, where registration is not the cause
        // (a stale TOKEN_ID in the env must not send the shopper to register on a token for a NEAR payout).
        const hint = failed.token
          ? registrationHint(failed.token, cfg.buyerId)
          : `check that ${cfg.buyerId} is an existing NEAR account that can receive the transfer`;
        throw Object.assign(new Error(`ERR_PAYOUT_FAILED: ${error}; the order is open again, retry after fixing it`), {
          status: 502,
          txHash: r.txHash,
          detail: `payout failed (${error}); the order is open again. ${hint}`,
        });
      }
      appendLog('claims.log', { order_id, claim_tx: r.txHash, result: r.value });
      return { ok: true, result: r.value, claim_tx: r.txHash, explorer: explorerTx(r.txHash) };
    } catch (e) {
      // The replay's `claim-again` step is the logged 400 (ERR_ALREADY_CLAIMED), not a literal.
      // Do not double-log the ERR_PAYOUT_FAILED entry written above.
      if (errCode(e) !== 'ERR_PAYOUT_FAILED') appendLog('claims.log', { order_id, claim_tx: e.txHash ?? null, error: errCode(e) });
      throw e;
    }
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
      const r = await finalCall(merchant, cfg.contractId, 'register_receipt', {
        order_id, signed_text: editedText, signature_hex: bundle.signature.signature, signer_public_key_hex: bundle.signature.signing_address,
      }, { tgas: 100 });
      appendLog('merchant.log', { kind: 'register-edited', order_id, tx: r.txHash, error: null });
      return r;
    } catch (e) {
      appendLog('merchant.log', { kind: 'register-edited', order_id, tx: e.txHash ?? null, error: errCode(e) });
      throw e;
    }
  }

  /**
   * v3 customer path (demo): the buyer's key registers a reply the shop did not register. The same call can be made
   * without this server: `npm run customer:register -- <bundle.json>` (app/scripts/customer-register.mjs).
   */
  async function handleCustomerRegister({ order_id, bundle } = {}) {
    requireOrderId(order_id);
    if ((await apiVersion()) !== API_V3) throw badRequest('the customer path needs a v3 contract');
    if (!bundle || bundle.order_id !== order_id || typeof bundle.request_b64 !== 'string' || typeof bundle.signature?.text !== 'string') {
      throw badRequest('bundle must be the v3 bundle of this order (request_b64, signature)');
    }
    const failed = checkBundle(bundle).filter(r => !r.ok);
    if (failed.length) throw Object.assign(new Error('LOCAL_CHECK_FAILED'), { status: 400, detail: JSON.stringify(failed) });
    try {
      const r = await finalCall(buyer, cfg.contractId, 'register_receipt_as_buyer', buyerRegisterArgs(cfg.merchantId, bundle), { tgas: 100 });
      appendLog('customer.log', { kind: 'register_receipt_as_buyer', order_id, tx: r.txHash, error: null });
      return { ok: true, register_tx: r.txHash, explorer: explorerTx(r.txHash), receipt: r.value };
    } catch (e) {
      appendLog('customer.log', { kind: 'register_receipt_as_buyer', order_id, tx: e.txHash ?? null, error: errCode(e) });
      throw e;
    }
  }

  return { handleChat, handleClaim, handleRegisterEdited, handleCustomerRegister };
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

const MAX_RESPONSE_B64_CHARS = 200_000;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function requireResponseB64(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_RESPONSE_B64_CHARS || !BASE64_RE.test(value)) {
    throw badRequest(`response_b64 must be a non-empty base64 string of at most ${MAX_RESPONSE_B64_CHARS} characters`);
  }
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
