#!/usr/bin/env node
// Usage: node app/verify.mjs <bundle.json> [--offline] [--contract <id>] [--rpc <url>]
// Off-chain re-check of a receipt bundle, then (unless --offline) the on-chain views.
// Exit code 0 = every check passed, 1 = at least one failed.
// The contract checked is --contract, then $CONTRACT_ID, then the deployed cbp-sm1110.testnet: NEVER the
// contract named inside the bundle (a forged bundle could point at the forger's own contract).
// A SIMULATED bundle (fake, publicly known key) ends in SIMULATED, never in VERIFIED.
import fs from 'node:fs';
import { checkBundle } from './lib/nearai.mjs';
import { loadAttestations, attestedRow, signerRows, resolveContract, PINNED_CONTRACT } from './lib/attestation.mjs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
if (!file) { console.error('usage: node app/verify.mjs <bundle.json> [--offline] [--contract id] [--rpc url]'); process.exit(2); }
const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = checkBundle(bundle);
const simulated = bundle.simulated === true;
const records = loadAttestations();
// A real bundle's key must be one the attestation record verified; offline VERIFIED is not just "self-consistent".
if (!simulated) rows.push(attestedRow(bundle, records));
else console.log('SIMULATED  bundle.simulated=true: signed with a fake, publicly known key; this proves nothing about a TEE');

if (!args.includes('--offline')) {
  try {
    const { makeProvider, view } = await import('./lib/near.mjs');
    const contractId = resolveContract(flag('--contract'));
    if (bundle.chain?.contract && bundle.chain.contract !== contractId) {
      console.log(`WARN  bundle.chain.contract is ${bundle.chain.contract} but this check uses ${contractId} (${PINNED_CONTRACT} is the deployed contract); the bundle's own claim is ignored`);
    }
    const provider = makeProvider(flag('--rpc') ?? process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com');
    const signer = await view(provider, contractId, 'get_signer', { public_key_hex: bundle.signature.signing_address });
    // Simulated keys have no attestation record: only the registration row applies.
    rows.push(...(simulated ? signerRows(signer, bundle, records).slice(0, 4) : signerRows(signer, bundle, records)));
    const receipt = await view(provider, contractId, 'get_receipt', { response_hash: bundle.response_hash });
    rows.push({ check: 'receipt on chain for these bytes (get_receipt)', ok: !!receipt && receipt.order_id === bundle.order_id, detail: receipt ? `order ${receipt.order_id} block ${receipt.block_height}` : 'null: NOT A PROMISE' });
    const preview = await view(provider, contractId, 'preview_claim', { order_id: bundle.order_id, response_b64: bundle.response_b64 });
    rows.push({ check: 'preview_claim', ok: preview.ok || preview.error === 'ERR_ALREADY_CLAIMED', detail: JSON.stringify(preview) });
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message;
    const detail = `${e?.message ?? e}${cause ? ` (${cause})` : ''}`.split('\n')[0];
    rows.push({ check: 'testnet RPC unreachable', ok: false, detail: `${detail} - rerun with --offline for the off-chain checks only` });
  }
}

let allOk = true;
for (const r of rows) { allOk &&= r.ok; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}  ${r.detail}`); }
if (allOk && simulated) console.log('SIMULATED (fake key, proves nothing about a TEE)');
else console.log(allOk ? 'VERIFIED' : 'NOT VERIFIED');
process.exit(allOk ? 0 : 1);
