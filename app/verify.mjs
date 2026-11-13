#!/usr/bin/env node
// Usage: node app/verify.mjs <bundle.json> [--offline] [--contract <id>] [--rpc <url>]
// Off-chain re-check of a receipt bundle, then (unless --offline) the on-chain views.
// Exit code 0 = every check passed, 1 = at least one failed.
// The contract checked is --contract, then $CONTRACT_ID, then the contract the bundle names only if it is one of
// the two repo deployments (v1 cbp-sm1110.testnet history, v2 v2.cbp-sm1110.testnet), then the pinned v2. Any other
// name in the bundle is ignored (a forged bundle could point at the forger's own contract).
// A SIMULATED bundle (fake, publicly known key) ends in SIMULATED, never in VERIFIED.
import fs from 'node:fs';
import { checkBundle } from './lib/nearai.mjs';
import { loadAttestations, attestedRow, signerRows, resolveContract, PINNED_CONTRACT } from './lib/attestation.mjs';
import { detectApi, receiptArgs, previewClaimArgs, buyerRegisterArgs, API_V3 } from './lib/contract-api.mjs';
import { positionalArgs, flagValue } from './lib/cli-args.mjs';

const args = process.argv.slice(2);
// The bundle is the first positional argument: the VALUE of --contract/--rpc/--merchant is never mistaken for it.
const file = positionalArgs(args, ['--contract', '--rpc', '--merchant'])[0];
const flag = (n) => flagValue(args, n);
if (!file) { console.error('usage: node app/verify.mjs <bundle.json> [--offline] [--contract id] [--rpc url]'); process.exit(2); }
const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = checkBundle(bundle);
const simulated = bundle.simulated === true;
const records = loadAttestations();
// A real bundle's key must be one the attestation record verified; offline VERIFIED is not just "self-consistent".
if (!simulated) rows.push(attestedRow(bundle, records));
else console.log('SIMULATED  bundle.simulated=true: signed with a fake, publicly known key; this proves nothing about a TEE');

let missingInput = false;
if (!args.includes('--offline')) {
  try {
    const { makeProvider, view } = await import('./lib/near.mjs');
    const contractId = resolveContract(flag('--contract'), process.env, bundle.chain?.contract);
    if (bundle.chain?.contract && bundle.chain.contract !== contractId) {
      console.log(`WARN  bundle.chain.contract is ${bundle.chain.contract} but this check uses ${contractId} (${PINNED_CONTRACT} is the current contract); the bundle's own claim is ignored`);
    }
    const provider = makeProvider(flag('--rpc') ?? process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com');
    // v2 keys orders and receipts by (merchant, id). The merchant is a CLI/env input, never guessed
    // from the bundle (a forged bundle could name any merchant).
    const merchant = flag('--merchant') ?? process.env.MERCHANT_ID ?? null;
    const api = await detectApi(provider, contractId);
    if (api >= 2 && !merchant) {
      // Its own row: this is a missing input, not a network problem.
      rows.push({ check: 'merchant given (a v2 contract keys receipts by merchant)', ok: false, detail: 'pass --merchant <id> or set MERCHANT_ID; the on-chain checks were not run' });
      missingInput = true;
    }
    if (!missingInput) {
      const config = api >= 2 ? await view(provider, contractId, 'get_config', {}) : null;
      const signer = await view(provider, contractId, 'get_signer', { public_key_hex: bundle.signature.signing_address });
      const receipt = await view(provider, contractId, 'get_receipt', receiptArgs(api, merchant, bundle.response_hash, bundle.order_id));
      if (api === API_V3) {
        // v3: the shop key in the bundle must be the one the ORDER carries on chain (copied at register_order), and
        // the order's buyer the bundle's buyer; otherwise the offline shop-authorization row proves nothing.
        const order = await view(provider, contractId, 'get_order', { merchant, order_id: bundle.order_id });
        rows.push({ check: 'v3 bundle names this merchant', ok: bundle.merchant === merchant, detail: `${bundle.merchant}` });
        rows.push({ check: 'v3 shop key in the bundle == the order\'s on-chain shop_key', ok: !!order && order.shop_key === bundle.shop_auth?.public_key_hex, detail: order ? order.shop_key : 'null: no such order' });
        rows.push({ check: 'v3 bundle buyer == the order\'s buyer', ok: !!order && order.buyer === bundle.buyer, detail: order ? order.buyer : '-' });
        if (!receipt) {
          const why = await view(provider, contractId, 'preview_register_as_buyer', { ...buyerRegisterArgs(merchant, bundle), buyer: bundle.buyer });
          console.log(why == null
            ? `INFO  not registered yet; the buyer CAN register it: npm run customer:register -- ${file} --merchant ${merchant}`
            : `INFO  not registered yet; preview_register_as_buyer answers ${why}`);
        }
      }
      // The signer is judged at the receipt's registration time, not by today's clock.
      // Simulated keys have no attestation record: only the registration rows apply.
      rows.push(...(simulated ? signerRows(signer, bundle, records, Date.now(), receipt).slice(0, 4) : signerRows(signer, bundle, records, Date.now(), receipt)));
      if (api >= 2 && receipt) console.log(`token ${receipt.token ?? 'NEAR'}  order_amount ${receipt.order_amount ?? '-'} (raw units)`);
      if (api >= 2) {
        const allowed = config?.allowed_tokens ?? [];
        for (const tokenId of allowed) {
          const balance = await view(provider, tokenId, 'storage_balance_of', { account_id: contractId });
          rows.push({
            check: `market is registered on ${tokenId} (storage_balance_of)`,
            ok: balance !== null && balance !== undefined,
            detail: balance ? 'registered' : 'null: deposit storage on the token before a token order',
          });
        }
        rows.push({
          check: 'receipt token is in get_config().allowed_tokens',
          ok: receipt?.token == null || allowed.includes(receipt.token),
          detail: receipt?.token == null ? 'NEAR (always allowed)' : `${receipt.token} in [${allowed.join(', ')}]`,
        });
      }
      rows.push({ check: 'receipt on chain for these bytes (get_receipt)', ok: !!receipt && receipt.order_id === bundle.order_id, detail: receipt ? `order ${receipt.order_id} block ${receipt.block_height}` : 'null: NOT A PROMISE' });
      const preview = await view(provider, contractId, 'preview_claim', previewClaimArgs(api, merchant, bundle.order_id, bundle.response_b64));
      rows.push({ check: 'preview_claim', ok: preview.ok || preview.error === 'ERR_ALREADY_CLAIMED', detail: JSON.stringify(preview) });
    }
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message;
    const detail = `${e?.message ?? e}${cause ? ` (${cause})` : ''}`.split('\n')[0];
    // `RPC unreachable` only for network-shaped errors; any other error in the on-chain block is named as such.
    const network = !!cause || /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|socket|network|timed? ?out/i.test(String(e?.message ?? e));
    rows.push(network
      ? { check: 'testnet RPC unreachable', ok: false, detail: `${detail} - rerun with --offline for the off-chain checks only` }
      : { check: 'on-chain check failed', ok: false, detail });
  }
}

let allOk = true;
for (const r of rows) { allOk &&= r.ok; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}  ${r.detail}`); }
if (allOk && simulated) console.log('SIMULATED (fake key, proves nothing about a TEE)');
else console.log(allOk ? 'VERIFIED' : 'NOT VERIFIED');
process.exit(allOk ? 0 : 1);
