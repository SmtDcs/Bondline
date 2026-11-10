// Startup config for the live server: which contract version, which tokens, per-order token metadata.
// Extracted from app/server.mjs so it can be tested with a stub provider.
import { view } from './near.mjs';
import { detectApi, orderArgs, API_V2 } from './contract-api.mjs';
import { loadTokenConfig } from './token.mjs';

/**
 * Fills cfg.contractApi, cfg.tokens and the per-order token/amount/expiry fields.
 * `detectApi` treats only MethodNotFound as v1. Any other error (network, RPC) is NOT swallowed here:
 * serving a v2 contract with v1 argument shapes would be wrong, so startup fails instead.
 */
export async function buildLiveConfig(cfg, provider, log = console.error) {
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
      try {
        const chain = await view(provider, cfg.contractId, 'get_order', orderArgs(contractApi, cfg.merchantId, order.order_id));
        if (chain) {
          const token = chain.token ?? null;
          if (token && !tokens.some(t => t.id === token)) continue; // market not registered: hide it
          order.token = token;
          order.amount = chain.amount ?? null;
          order.expires_at_ms = chain.expires_at_ms ?? null;
        }
      } catch { /* the config is still usable without the per-order metadata */ }
      kept.push(order);
    }
    cfg.orders = kept;
  }
  cfg.contractApi = contractApi;
  cfg.tokens = tokens;
  return cfg;
}
