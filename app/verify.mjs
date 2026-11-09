#!/usr/bin/env node
// Usage: node app/verify.mjs <bundle.json> [--offline] [--contract <id>] [--rpc <url>]
// Off-chain re-check of a receipt bundle, then (unless --offline) the on-chain views.
// Exit code 0 = every check passed, 1 = at least one failed.
import fs from 'node:fs';
import { checkBundle } from './lib/nearai.mjs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
if (!file) { console.error('usage: node app/verify.mjs <bundle.json> [--offline] [--contract id] [--rpc url]'); process.exit(2); }
const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = checkBundle(bundle);

if (!args.includes('--offline')) {
  const { makeProvider, view } = await import('./lib/near.mjs');
  const contractId = flag('--contract') ?? bundle.chain?.contract ?? process.env.CONTRACT_ID;
  const provider = makeProvider(flag('--rpc') ?? process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com');
  const signer = await view(provider, contractId, 'get_signer', { public_key_hex: bundle.signature.signing_address });
  rows.push({ check: 'signer registered in contract (get_signer)', ok: !!signer, detail: signer ? `${signer.kind} ${signer.model_id ?? ''} att=${signer.attestation_sha256.slice(0, 12)}` : 'null' });
  const receipt = await view(provider, contractId, 'get_receipt', { response_hash: bundle.response_hash });
  rows.push({ check: 'receipt on chain for these bytes (get_receipt)', ok: !!receipt && receipt.order_id === bundle.order_id, detail: receipt ? `order ${receipt.order_id} block ${receipt.block_height}` : 'null: NOT A PROMISE' });
  const preview = await view(provider, contractId, 'preview_claim', { order_id: bundle.order_id, response_b64: bundle.response_b64 });
  rows.push({ check: 'preview_claim', ok: preview.ok || preview.error === 'ERR_ALREADY_CLAIMED', detail: JSON.stringify(preview) });
}

let allOk = true;
for (const r of rows) { allOk &&= r.ok; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}  ${r.detail}`); }
console.log(allOk ? 'VERIFIED' : 'NOT VERIFIED');
process.exit(allOk ? 0 : 1);
