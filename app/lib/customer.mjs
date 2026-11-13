// v3 customer-side tooling: everything a shopper needs to register the shop bot's reply WITHOUT the shop's help.
// Used by app/scripts/customer-register.mjs (CLI) and tested in app/test/customer.test.mjs.
//
// Inputs: the bundle the bot server returned with the reply (request bytes, response bytes, TEE signature, signer,
// shop authorization), the merchant id and the v3 contract id. Nothing here trusts the shop's server: the rows are
// recomputed from the bytes, and the on-chain views come from the RPC the customer chooses.
import { checkBundle, NEARAI_BASE } from './nearai.mjs';
import { buyerRegisterArgs, detectApi, API_V3 } from './contract-api.mjs';
import { view } from './near.mjs';

/**
 * Trap 2, the independent route: NEAR AI's GET /v1/signature/{chat_id} needs A valid API key, not the key of the
 * caller who made the completion (nearai/cloud-api crates/api/src/routes/attestation.rs, route table: "Requires a
 * valid API key, then looks up the response ID. The shared lookup does not enforce ownership by organization or API
 * key."). So a customer with their own NEAR AI key can re-fetch the TEE signature by chat id and compare it with the
 * one the shop's server handed over. Returns rows like checkBundle. `fetchImpl` is injectable for tests.
 */
export async function refetchSignatureRows(bundle, { apiKey, model = bundle.model, signingAlgo = 'ed25519', fetchImpl = fetch, tries = 5, delayMs = 1000 } = {}) {
  const rows = [];
  if (!apiKey) return [{ check: 're-fetch the TEE signature with your own NEAR AI key', ok: false, detail: 'set CUSTOMER_NEARAI_API_KEY (any valid NEAR AI Cloud key)' }];
  const url = `${NEARAI_BASE}/signature/${encodeURIComponent(bundle.chat_id)}?model=${encodeURIComponent(model)}&signing_algo=${signingAlgo}`;
  let sig = null; let status = null;
  for (let i = 0; i < tries; i++) {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` } });
    status = res.status;
    if (res.status === 404) { await new Promise(r => setTimeout(r, delayMs)); continue; }
    const text = await res.text();
    if (res.ok) { sig = JSON.parse(text); break; }
    break;
  }
  if (!sig || sig.error_code) {
    rows.push({ check: 're-fetch the TEE signature by chat id (own key)', ok: false, detail: sig?.error_code ?? `HTTP ${status}` });
    return rows;
  }
  rows.push({ check: 're-fetched signature text == bundle signature text', ok: sig.text === bundle.signature.text, detail: sig.text });
  rows.push({ check: 're-fetched signer == bundle signer', ok: sig.signing_address === bundle.signature.signing_address, detail: sig.signing_address });
  rows.push({ check: 're-fetched signature == bundle signature', ok: String(sig.signature).replace(/^0x/, '') === String(bundle.signature.signature).replace(/^0x/, ''), detail: '' });
  return rows;
}

/**
 * Off-chain + on-chain checks before the customer registers. Returns { rows, args, registered, preview }.
 * `registered` = a receipt for these bytes already exists for this order (nothing to do but claim).
 * `preview` = null when register_receipt_as_buyer would succeed, else the contract's error code.
 */
export async function planCustomerRegister({ bundle, merchant, contractId, provider, buyer = bundle.buyer }) {
  const rows = checkBundle(bundle);
  if (!String(bundle.type ?? '').endsWith('/v3')) rows.push({ check: 'bundle is a v3 bundle', ok: false, detail: String(bundle.type) });
  const args = buyerRegisterArgs(merchant, bundle);
  const api = await detectApi(provider, contractId);
  if (api !== API_V3) {
    rows.push({ check: `${contractId} is a v3 contract (get_config api 3)`, ok: false, detail: `api ${api}` });
    return { rows, args, registered: false, preview: 'ERR_NOT_V3' };
  }
  const order = await view(provider, contractId, 'get_order', { merchant, order_id: bundle.order_id });
  rows.push({ check: 'order exists on chain', ok: !!order, detail: order ? `${order.status}, buyer ${order.buyer}` : 'null' });
  if (order) {
    rows.push({ check: 'bundle shop key == order shop_key on chain', ok: order.shop_key === bundle.shop_auth?.public_key_hex, detail: order.shop_key });
    rows.push({ check: 'you are the order\'s buyer', ok: order.buyer === buyer, detail: `${buyer}` });
  }
  const receipt = await view(provider, contractId, 'get_receipt', { merchant, order_id: bundle.order_id, response_hash: bundle.response_hash });
  const preview = receipt ? null : await view(provider, contractId, 'preview_register_as_buyer', { ...args, buyer });
  if (receipt) rows.push({ check: 'receipt already on chain (registered by ' + receipt.registered_by + ')', ok: true, detail: `block ${receipt.block_height}` });
  else rows.push({ check: 'preview_register_as_buyer', ok: preview == null, detail: preview ?? 'would be accepted' });
  return { rows, args, registered: !!receipt, preview: preview ?? null };
}
