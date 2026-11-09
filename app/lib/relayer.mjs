// Relayer logic (merchant's bot server). INTERFACES.md section 11.
// Order of operations in handleChat is FROZEN: build bytes -> NEAR AI -> signature -> local check ->
// register_receipt (wait FINAL) -> only then return the reply.
import fs from 'node:fs';
import path from 'node:path';
import { buildRequestBytes, chatExact, fetchSignature, checkBundle, sha256Hex } from './nearai.mjs';
import { makeProvider, accountFromKey, callFinal, explorerTx } from './near.mjs';

export function loadConfig(env = process.env) {
  const need = ['CONTRACT_ID', 'MERCHANT_ID', 'RELAYER_SECRET_KEY', 'BUYER_ID', 'BUYER_CLAIM_SECRET_KEY', 'NEARAI_API_KEY'];
  for (const k of need) if (!env[k]) throw new Error(`missing env ${k} (see .env.example)`);
  const orders = (env.DEMO_ORDERS ?? 'A123-01:Broken mug:2000,A124-01:Late delivery:2000').split(',').map(s => {
    const [order_id, label, policy_bps] = s.split(':');
    return { order_id, label, policy_bps: Number(policy_bps) };
  });
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
  return { mode, network, rpcUrl, contractId, merchantId, buyerId, model, orders: orders.map(({ order_id, label }) => ({ order_id, label })) };
}

export function makeRelayer(cfg) {
  const provider = makeProvider(cfg.rpcUrl);
  const merchant = accountFromKey(provider, cfg.merchantId, cfg.relayerKey);
  const buyer = accountFromKey(provider, cfg.buyerId, cfg.buyerKey);
  const history = new Map(); // order_id -> [{role, content}]
  const bundleDir = 'data/bundles';
  fs.mkdirSync(bundleDir, { recursive: true });

  async function handleChat({ order_id, message }) {
    const order = await provider.callFunction({ contractId: cfg.contractId, method: 'get_order', args: { order_id } });
    if (!order) throw Object.assign(new Error('ERR_NO_ORDER'), { status: 404 });
    const meta = cfg.orders.find(o => o.order_id === order_id) ?? { policy_bps: 2000 };
    const amountNear = (Number(BigInt(order.amount) / 10n ** 21n) / 1000).toString(); // display only
    const turns = history.get(order_id) ?? [];
    const requestBytes = buildRequestBytes({ model: cfg.model, orderId: order_id, amountNear, maxPolicyBps: meta.policy_bps, history: turns, userMessage: message });
    const chat = await chatExact({ apiKey: cfg.nearaiKey, requestBytes });
    const signature = await fetchSignature({ apiKey: cfg.nearaiKey, chatId: chat.chatId, model: cfg.model, signingAlgo: cfg.signingAlgo });
    const bundle = {
      type: 'bot-promises/receipt-bundle/v1', simulated: false, order_id, model: cfg.model, chat_id: chat.chatId,
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
    fs.writeFileSync(path.join(bundleDir, `${chat.chatId}.json`), JSON.stringify(bundle, null, 2) + '\n');
    const reply = chat.json.choices?.[0]?.message?.content ?? '';
    history.set(order_id, [...turns, { role: 'user', content: message }, { role: 'assistant', content: reply }]);
    return { reply, bundle, register_tx: reg.txHash, explorer: explorerTx(reg.txHash) };
  }

  async function handleClaim({ order_id, response_b64 }) {
    const r = await callFinal(buyer, cfg.contractId, 'claim', { order_id, response_b64 }, { tgas: 100 });
    return { ok: true, result: r.value, claim_tx: r.txHash, explorer: explorerTx(r.txHash) };
  }

  /** The merchant tries to register an EDITED reply under the real TEE signature. Must fail with ERR_BAD_SIGNATURE. */
  async function handleRegisterEdited({ order_id, bundle, edit }) {
    const bytes = Buffer.from(bundle.response_b64, 'base64').toString('utf8').replace(edit.from, edit.to);
    const editedHash = sha256Hex(Buffer.from(bytes, 'utf8'));
    const editedText = bundle.signature.text.replace(bundle.response_hash, editedHash);
    return callFinal(merchant, cfg.contractId, 'register_receipt', {
      order_id, signed_text: editedText, signature_hex: bundle.signature.signature, signer_public_key_hex: bundle.signature.signing_address,
    }, { tgas: 100 });
  }

  return { handleChat, handleClaim, handleRegisterEdited };
}

/** Pull "ERR_..." out of any thrown error (contract panics, RPC errors). */
export function errCode(e) {
  const m = String(e?.message ?? e).match(/ERR_[A-Z_]+/) ?? JSON.stringify(e ?? {}).match(/ERR_[A-Z_]+/);
  return m ? m[0] : 'ERR_INTERNAL';
}
