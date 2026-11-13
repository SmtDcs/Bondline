#!/usr/bin/env node
// v3 customer path, without the shop's server:
//   npm run customer:register -- <bundle.json> --merchant <shop> [--contract <v3 id>] [--rpc <url>] [--refetch-signature] [--send]
// 1. re-checks the bundle offline (hashes, TEE signature, the shop's authorization in the request bytes);
// 2. --refetch-signature: re-fetches the TEE signature from NEAR AI by chat id with YOUR OWN key
//    (CUSTOMER_NEARAI_API_KEY; any valid NEAR AI Cloud key works) and compares it with the bundle's;
// 3. reads the order, the receipt and preview_register_as_buyer from the chain;
// 4. --send: calls register_receipt_as_buyer signed by BUYER_ID with CUSTOMER_SECRET_KEY (your full-access key or a
//    function-call key for this contract; your storage balance on the contract pays the record). Without --send it
//    prints the arguments and sends nothing.
// The contract is --contract or $CONTRACT_ID (the deployed v3 is claimable-promises.testnet). Exit 0 = registered or
// registrable, 1 = a check failed.
import fs from 'node:fs';
import { positionalArgs, flagValue } from '../lib/cli-args.mjs';
import { planCustomerRegister, refetchSignatureRows } from '../lib/customer.mjs';
import { readEnvFile, redactSecrets } from '../lib/live-tx.mjs';

const argv = process.argv.slice(2);
const file = positionalArgs(argv, ['--merchant', '--contract', '--rpc'])[0];
const env = readEnvFile();
const merchant = flagValue(argv, '--merchant') ?? env.MERCHANT_ID;
const contractId = flagValue(argv, '--contract') ?? env.CONTRACT_ID;
if (!file || !merchant || !contractId) {
  console.error('usage: npm run customer:register -- <bundle.json> --merchant <id> --contract <v3 id> [--rpc url] [--refetch-signature] [--send]');
  process.exit(2);
}
const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
const { makeProvider, accountFromKey, callFinal, explorerTx } = await import('../lib/near.mjs');
const provider = makeProvider(flagValue(argv, '--rpc') ?? env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com');
const buyer = env.BUYER_ID ?? bundle.buyer;

const rows = [];
if (argv.includes('--refetch-signature')) rows.push(...await refetchSignatureRows(bundle, { apiKey: env.CUSTOMER_NEARAI_API_KEY }));
const plan = await planCustomerRegister({ bundle, merchant, contractId, provider, buyer });
rows.push(...plan.rows);
let ok = true;
for (const r of rows) { ok &&= r.ok; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}  ${r.detail}`); }
if (!ok) { console.log('NOT REGISTRABLE'); process.exit(1); }
if (plan.registered) { console.log('ALREADY REGISTERED: claim it (preview_claim / claim)'); process.exit(0); }
if (!argv.includes('--send')) {
  console.log('register_receipt_as_buyer args (not sent; add --send):');
  console.log(JSON.stringify(plan.args));
  process.exit(0);
}
if (!env.CUSTOMER_SECRET_KEY) { console.error('--send needs CUSTOMER_SECRET_KEY (and BUYER_ID) in .env or the shell'); process.exit(2); }
try {
  const r = await callFinal(accountFromKey(provider, buyer, env.CUSTOMER_SECRET_KEY), contractId, 'register_receipt_as_buyer', plan.args, { tgas: 100 });
  console.log(`REGISTERED  tx ${r.txHash}  ${explorerTx(r.txHash)}`);
} catch (e) {
  console.error(redactSecrets(`FAILED  ${e.message}`, env));
  process.exit(1);
}
