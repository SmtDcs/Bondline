#!/usr/bin/env node
// Usage: RUN=21 node app/scripts/demo-setup-v2.mjs                    token path: storage deposit, shop + shopper on the token,
//                                                                      100 tUSDC bond, orders A123-21 / A124-21
//        RUN=22 ASSET=near node app/scripts/demo-setup-v2.mjs         NEAR path on v2: storage deposit, register_merchant 3 NEAR, 2 orders
//        DRY_RUN=1 RUN=21 node app/scripts/demo-setup-v2.mjs          print the steps, read no key, send nothing
// The near-api-js port of the V2 branches of app/scripts/demo-setup.sh (no near-cli, so it also works where near-cli
// cannot reach the RPC; in a proxy sandbox run it with NODE_USE_ENV_PROXY=1).
// Reads CONTRACT_ID, MERCHANT_ID, BUYER_ID, TOKEN_ID and CBP_SHOP_ACCOUNT / CBP_SHOP_KEY from .env (parsed, never
// sourced, never printed). Records every transaction in $RUN_LOG (default data/demo-setup-v2.json).
import { readEnvFile, accountFor, retry, redactSecrets, RunBook } from '../lib/live-tx.mjs';
import { runPlan } from '../lib/run-plan.mjs';
import { makeProvider, view } from '../lib/near.mjs';
import { planSetup, describeStep, demoOrdersLine } from '../lib/demo-setup-plan.mjs';
import { detectApi } from '../lib/contract-api.mjs';
import { storageBalanceOf } from '../lib/token.mjs';

const env = readEnvFile();
const need = (k) => { if (!env[k]) { console.error(`missing ${k} (set it in .env or the shell)`); process.exit(2); } return env[k]; };
const run = need('RUN');
const asset = (env.ASSET ?? 'token').toLowerCase();
if (!['token', 'near'].includes(asset)) { console.error('ASSET must be token or near'); process.exit(2); }
const contractId = need('CONTRACT_ID');
const merchantId = env.MERCHANT_ID ?? need('CBP_SHOP_ACCOUNT');
const buyerId = need('BUYER_ID');
const tokenId = asset === 'token' ? need('TOKEN_ID') : null;
const dry = env.DRY_RUN === '1';

const steps = planSetup({
  asset, run, contractId, merchantId, buyerId, tokenId,
  ...(env.TTL_MS ? { ttlMs: env.TTL_MS } : {}),
  ...(env.AMOUNT_RAW ? { amountRaw: env.AMOUNT_RAW } : {}),
  ...(env.BOND_RAW ? { bondRaw: env.BOND_RAW } : {}),
  ...(env.STORAGE_DEPOSIT ? { storageDeposit: env.STORAGE_DEPOSIT } : {}),
});

if (dry) {
  for (const s of steps) console.log(describeStep(s, { merchant: merchantId }));
  console.log(`Now set ${demoOrdersLine(run)} in .env${tokenId ? ` and TOKEN_ID=${tokenId}` : ''}`);
  process.exit(0);
}

const provider = makeProvider(env.NEAR_RPC_URL ?? 'https://rpc.testnet.fastnear.com');
// v3 (contract-v3) takes the same steps; its merchant needs a shop key first (app/scripts/deploy-v3.mjs sets it).
if (![2, 3].includes(await detectApi(provider, contractId))) throw new Error(`${contractId} is not a v2 or v3 contract`);
if (tokenId && (await retry(() => storageBalanceOf(provider, tokenId, contractId))) === null) {
  console.error(`the market ${contractId} is not registered on ${tokenId}: run its storage_deposit first (docs/DEPLOY.md)`);
  process.exit(1);
}
const merchant = accountFor(provider, env.CBP_SHOP_ACCOUNT ?? merchantId, need('CBP_SHOP_KEY'));
if (merchant.accountId !== merchantId) throw new Error(`CBP_SHOP_ACCOUNT (${merchant.accountId}) is not MERCHANT_ID (${merchantId})`);
const book = new RunBook(env.RUN_LOG ?? 'data/demo-setup-v2.json', { type: 'bot-promises/demo-setup-v2', contract: contractId, asset, run });

const { stoppedAt } = await runPlan(provider, steps, { merchant }, { onTx: (rec) => book.tx(rec), log: (l) => console.log(redactSecrets(l, env)) });
if (stoppedAt) { console.error(`stopped: ${stoppedAt} failed (see ${book.file})`); process.exit(1); }
console.log(JSON.stringify(await view(provider, contractId, 'get_bonds', { merchant: merchantId })));
console.log(`Now set ${demoOrdersLine(run)} in .env${tokenId ? ` and TOKEN_ID=${tokenId}` : ''}`);
