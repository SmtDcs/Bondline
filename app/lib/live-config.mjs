// Startup config for the live server: which contract version, which tokens, per-order token metadata.
// Extracted from app/server.mjs so it can be tested with a stub provider.
import { view } from './near.mjs';
import { detectApi, orderArgs, API_V2 } from './contract-api.mjs';
import { loadTokenConfig } from './token.mjs';

async function viewWithRetry(provider, contractId, method, args, { tries, delayMs }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await view(provider, contractId, method, args);
    } catch (e) {
      if (attempt >= tries) throw e;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

/**
 * Fills cfg.contractApi, cfg.tokens and the per-order token/amount/expiry fields.
 * `detectApi` treats only MethodNotFound as v1. Any other error (network, RPC) is NOT swallowed here:
 * serving a v2 contract with v1 argument shapes would be wrong, so startup fails instead.
 */
export async function buildLiveConfig(cfg, provider, log = console.error, retry = { tries: 4, delayMs: 1000 }) {
  const contractApi = await detectApi(provider, cfg.contractId);
  let tokens = [];
  if (contractApi === API_V2) {
    try {
      const config = await view(provider, cfg.contractId, 'get_config', {});
      const loaded = await loadTokenConfig(provider, cfg.contractId, config.allowed_tokens ?? []);
      tokens = loaded.tokens;
      if (loaded.unregistered.length) {
        log(`the market is not registered on ${loaded.unregistered.join(', ')}: those token orders are hidden`);
      }
    } catch (e) {
      log(`token metadata failed: ${e.message}`);
    }
    const kept = [];
    for (const order of cfg.orders) {
      // client-1: an order whose chain view failed (after retries) or does not exist yet is DROPPED, never kept
      // token-less: the page would then show its tUSDC amount as NEAR. Restart the server after registering it.
      let chain;
      try {
        chain = await viewWithRetry(provider, cfg.contractId, 'get_order', orderArgs(contractApi, cfg.merchantId, order.order_id), retry);
      } catch (e) {
        log(`order ${order.order_id} hidden: get_order failed (${e.message}); restart the server once the RPC answers`);
        continue;
      }
      if (!chain) {
        log(`order ${order.order_id} hidden: it is not registered on ${cfg.contractId} for ${cfg.merchantId} (register it, then restart the server)`);
        continue;
      }
      const token = chain.token ?? null;
      if (token && !tokens.some(t => t.id === token)) continue; // market not registered: hide it
      order.token = token;
      order.amount = chain.amount ?? null;
      order.expires_at_ms = chain.expires_at_ms ?? null;
      kept.push(order);
    }
    cfg.orders = kept;
  }
  cfg.contractApi = contractApi;
  cfg.tokens = tokens;
  return cfg;
}
