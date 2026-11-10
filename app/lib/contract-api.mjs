// Contract version detection and the per-version argument shapes.
// v1 (contract/) has no get_config: MethodNotFound means v1. Any OTHER error is raised, never read as v1.
import { view } from './near.mjs';

export const API_V1 = 1;
export const API_V2 = 2;

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
 * Ask get_config and return 2 for a v2 contract, 1 when the method does not exist.
 * A successful get_config without `api: 2` is treated as v1 (an older deployment of the same method name).
 */
export async function detectApi(provider, contractId) {
  try {
    const config = await view(provider, contractId, 'get_config', {});
    return Number(config?.api) === API_V2 ? API_V2 : API_V1;
  } catch (e) {
    if (isMethodNotFound(e)) return API_V1;
    throw e;
  }
}

export function orderArgs(api, merchantId, orderId) {
  return api === API_V2 ? { merchant: merchantId, order_id: orderId } : { order_id: orderId };
}

export function receiptArgs(api, merchantId, responseHash) {
  return api === API_V2 ? { merchant: merchantId, response_hash: responseHash } : { response_hash: responseHash };
}

export function previewClaimArgs(api, merchantId, orderId, responseB64) {
  return api === API_V2 ? { merchant: merchantId, order_id: orderId, response_b64: responseB64 } : { order_id: orderId, response_b64: responseB64 };
}

export function claimArgs(api, merchantId, orderId, responseB64) {
  return api === API_V2 ? { merchant: merchantId, order_id: orderId, response_b64: responseB64 } : { order_id: orderId, response_b64: responseB64 };
}
