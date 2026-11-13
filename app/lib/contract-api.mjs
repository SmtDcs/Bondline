// Contract version detection and the per-version argument shapes.
// v1 (contract/) has no get_config: MethodNotFound means v1. Any OTHER error is raised, never read as v1.
import { view } from './near.mjs';

export const API_V1 = 1;
export const API_V2 = 2;
/** contract-v3: v2 shapes plus receipts keyed by (merchant, order, response hash) and the customer path. */
export const API_V3 = 3;

/** v2 and v3 key orders and receipts by merchant. */
export const merchantKeyed = (api) => api === API_V2 || api === API_V3;

function errorText(e) {
  const cause = e?.cause ?? {};
  return [
    e?.message,
    cause.name,
    cause.message,
    cause.cause?.name,
    cause.cause?.message,
    typeof cause === 'object' ? JSON.stringify(cause) : '',
  ].filter(Boolean).join(' ');
}

/** True only for the RPC's "no such contract method" error, never for a network failure. */
export function isMethodNotFound(e) {
  return /MethodNotFound|METHOD_NOT_FOUND|Contract method is not found|method not found/i.test(errorText(e));
}

/**
 * Ask get_config and return 2 or 3 for a v2 / v3 contract, 1 when the method does not exist.
 * A successful get_config without `api: 2|3` is treated as v1 (an older deployment of the same method name).
 */
export async function detectApi(provider, contractId) {
  try {
    const config = await view(provider, contractId, 'get_config', {});
    const api = Number(config?.api);
    return api === API_V2 || api === API_V3 ? api : API_V1;
  } catch (e) {
    if (isMethodNotFound(e)) return API_V1;
    throw e;
  }
}

export function orderArgs(api, merchantId, orderId) {
  return merchantKeyed(api) ? { merchant: merchantId, order_id: orderId } : { order_id: orderId };
}

/** v3 also needs the order id (receipts are keyed by order there); v1/v2 ignore it. */
export function receiptArgs(api, merchantId, responseHash, orderId) {
  if (api === API_V3) {
    if (!orderId) throw new Error('a v3 get_receipt needs the order id');
    return { merchant: merchantId, order_id: orderId, response_hash: responseHash };
  }
  return api === API_V2 ? { merchant: merchantId, response_hash: responseHash } : { response_hash: responseHash };
}

export function previewClaimArgs(api, merchantId, orderId, responseB64) {
  return merchantKeyed(api) ? { merchant: merchantId, order_id: orderId, response_b64: responseB64 } : { order_id: orderId, response_b64: responseB64 };
}

export function claimArgs(api, merchantId, orderId, responseB64) {
  return merchantKeyed(api) ? { merchant: merchantId, order_id: orderId, response_b64: responseB64 } : { order_id: orderId, response_b64: responseB64 };
}

/** v3 customer path: the arguments of `register_receipt_as_buyer` (and, plus `buyer`, of its preview view) from a bundle. */
export function buyerRegisterArgs(merchantId, bundle) {
  return {
    merchant: merchantId,
    order_id: bundle.order_id,
    request_b64: bundle.request_b64,
    signed_text: bundle.signature.text,
    signature_hex: bundle.signature.signature,
    signer_public_key_hex: bundle.signature.signing_address,
  };
}
