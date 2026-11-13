#!/usr/bin/env node
// Deploy contract-v3 on TESTNET (operator script; NOT run by the build).
//   node app/scripts/deploy-v3.mjs                 print the plan (default; reads no key, sends nothing)
//   node app/scripts/deploy-v3.mjs --send          deploy + init, signer, merchant/buyer setup, function-call keys
//   node app/scripts/deploy-v3.mjs --send --lock   ... and finally delete the contract account's only full-access key
// Proxy sandbox: NODE_USE_ENV_PROXY=1.
//
// Needs in .env (parsed, never printed): V3_CONTRACT_ID + CBP_V3_CONTRACT_KEY (the new, empty contract account and its
// full-access key; create it first, e.g. `near account create-account fund-myself v3.cbp-sm1110.testnet '5 NEAR'
// autogenerate-new-keypair save-to-legacy-keychain sign-as cbp-sm1110.testnet network-config testnet sign-with-legacy-keychain send`),
// CBP_V3_OWNER_ACCOUNT + CBP_V3_OWNER_KEY (a SEPARATE owner account), CBP_SHOP_ACCOUNT + CBP_SHOP_KEY,
// CBP_ALICE_ACCOUNT + CBP_ALICE_KEY (the buyer), SHOP_AUTH_SEED_HEX (only its public key leaves this script),
// optional TOKEN_ID, RELAYER_SECRET_KEY / CUSTOMER_SECRET_KEY (only their public keys are used: function-call keys),
// V3_ATTESTATION_FILE (default: the renewed glm-5.3-flash record), V3_SIGNER_EXPIRES_AT_MS, V3_MIN_ORDER_TTL_MS.
// Every transaction is recorded in data/deploy-v3.json (RUN_LOG overrides).
//
// Checks it makes itself: the wasm's sha256 equals contract-v3/res/bot_promises_v3.wasm.sha256 (the reproducible
// build's), the account's code hash after deploy equals it, get_config says api 3 and the owner, and before --lock the
// contract account has exactly ONE key (the one in .env); after --lock it has none.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { readEnvFile, accountFor, sendTx, redactSecrets, RunBook, txLine, retry } from '../lib/live-tx.mjs';
import { planDeployV3, describeDeployStep } from '../lib/deploy-v3-plan.mjs';
import { publicKeyFromSeed } from '../lib/shop-auth.mjs';

const argv = process.argv.slice(2);
const send = argv.includes('--send');
const lock = argv.includes('--lock');
const env = readEnvFile();
const need = (k) => { if (!env[k]) { console.error(`missing ${k} (.env)`); process.exit(2); } return env[k]; };
const log = (s) => console.log(redactSecrets(s, env));

const WASM = 'contract-v3/res/bot_promises_v3.wasm';
const expectedSha = fs.readFileSync(`${WASM}.sha256`, 'utf8').trim().split(/\s+/)[0];
const wasm = fs.readFileSync(WASM);
const sha = crypto.createHash('sha256').update(wasm).digest('hex');
if (sha !== expectedSha) { console.error(`FAIL wasm sha256 ${sha} != ${expectedSha} (rebuild with cargo near build reproducible-wasm)`); process.exit(1); }
console.log(`PASS wasm sha256 ${sha} (${wasm.length} bytes)`);

const attFile = env.V3_ATTESTATION_FILE ?? 'fixtures/attestation/z-ai_glm-5.3-flash-ed25519-2026-11-10-renewed.json';
const att = JSON.parse(fs.readFileSync(attFile, 'utf8'));
const signer = {
  publicKeyHex: att.verified[0].signer.signingAddress,
  model: att.model,
  attestationSha256: crypto.createHash('sha256').update(fs.readFileSync(attFile)).digest('hex'),
  expiresAtMs: env.V3_SIGNER_EXPIRES_AT_MS ?? String(Date.parse('2026-11-30T10:45:00Z')),
};
const pubOf = async (secret) => {
  if (!secret) return null;
  const { KeyPair } = await import('near-api-js');
  return KeyPair.fromString(secret).getPublicKey().toString();
};

const steps = planDeployV3({
  contractId: need('V3_CONTRACT_ID'), ownerId: need('CBP_V3_OWNER_ACCOUNT'),
  merchantId: need('CBP_SHOP_ACCOUNT'), buyerId: need('CBP_ALICE_ACCOUNT'),
  tokenId: env.TOKEN_ID || null, minOrderTtlMs: env.V3_MIN_ORDER_TTL_MS ?? '3600000',
  signer, shopKeyHex: publicKeyFromSeed(need('SHOP_AUTH_SEED_HEX')),
  relayerPublicKey: await pubOf(env.RELAYER_SECRET_KEY), buyerPublicKey: await pubOf(env.CUSTOMER_SECRET_KEY),
  lock,
});
for (const s of steps) console.log(describeDeployStep(s));
if (!send) { console.log('DRY RUN: nothing sent (add --send)'); process.exit(0); }

const { makeProvider, view } = await import('../lib/near.mjs');
const { actions, PublicKey, teraToGas } = await import('near-api-js');
const provider = makeProvider(env.NEAR_RPC_URL ?? 'https://rpc.testnet.fastnear.com');
const contractId = env.V3_CONTRACT_ID;
const accounts = {
  contract: accountFor(provider, contractId, need('CBP_V3_CONTRACT_KEY')),
  owner: accountFor(provider, env.CBP_V3_OWNER_ACCOUNT, need('CBP_V3_OWNER_KEY')),
  merchant: accountFor(provider, env.CBP_SHOP_ACCOUNT, need('CBP_SHOP_KEY')),
  buyer: accountFor(provider, env.CBP_ALICE_ACCOUNT, need('CBP_ALICE_KEY')),
};
const book = new RunBook(env.RUN_LOG ?? 'data/deploy-v3.json', { type: 'bot-promises/deploy-v3', contract: contractId, wasm_sha256: sha, network: 'testnet', started_at: new Date().toISOString() });
const keysOf = async (id) => (await retry(() => provider.query({ request_type: 'view_access_key_list', finality: 'final', account_id: id }))).keys ?? [];

async function runActions(step) {
  const account = accounts[step.signer];
  const built = [];
  for (const a of step.actions) {
    if (a.type === 'deployContract') built.push(actions.deployContract(new Uint8Array(fs.readFileSync(a.wasmPath))));
    else if (a.type === 'functionCall') built.push(actions.functionCall(a.method, a.args, teraToGas(a.tgas), a.depositYocto));
    else if (a.type === 'addFunctionCallAccessKey') built.push(actions.addFunctionCallAccessKey(PublicKey.from(a.publicKey), a.contractId, a.methodNames, a.allowance));
    else if (a.type === 'deleteOwnKey') {
      const keys = await keysOf(step.receiverId);
      const { KeyPair } = await import('near-api-js');
      const mine = KeyPair.fromString(env.CBP_V3_CONTRACT_KEY).getPublicKey().toString();
      if (keys.length !== 1 || keys[0].public_key !== mine) throw new Error(`refusing to lock: ${step.receiverId} has ${keys.length} keys (expected exactly the one in CBP_V3_CONTRACT_KEY)`);
      built.push(actions.deleteKey(PublicKey.from(mine)));
    } else throw new Error(`unknown action ${a.type}`);
  }
  const out = await account.signAndSendTransaction({ receiverId: step.receiverId, actions: built, waitUntil: 'FINAL' });
  const rec = { step: step.id, label: step.id, signer: account.accountId, receiver: step.receiverId, ok: !('Failure' in (out.status ?? {})), tx: out.transaction_outcome?.id, at: new Date().toISOString(), actions: step.actions.map(a => a.type) };
  book.tx(rec);
  log(`[${step.id}] ${rec.ok ? 'OK' : 'FAILED'} tx ${rec.tx}`);
  if (!rec.ok) throw new Error(`${step.id} failed: ${JSON.stringify(out.status)}`);
}

for (const step of steps) {
  if (step.kind === 'actions') await runActions(step);
  else {
    const rec = await sendTx(provider, accounts[step.signer], { contractId: step.contractId, method: step.method, args: step.args, tgas: step.tgas, depositYocto: step.depositYocto, step: step.id, label: step.id });
    book.tx(rec);
    log(`[${step.id}] ${txLine(rec)}`);
    if (!rec.ok) { console.error(`stopped at ${step.id}`); process.exit(1); }
  }
  if (step.id === 'deploy-and-init') {
    const acct = await retry(() => provider.query({ request_type: 'view_account', finality: 'final', account_id: contractId }));
    const { baseEncode } = await import('near-api-js');
    const want = baseEncode(Buffer.from(sha, 'hex'));
    console.log(`${acct.code_hash === want ? 'PASS' : 'FAIL'} on-chain code hash ${acct.code_hash} == ${want}`);
    const cfg = await view(provider, contractId, 'get_config', {});
    console.log(`${cfg.api === 3 && cfg.owner === env.CBP_V3_OWNER_ACCOUNT ? 'PASS' : 'FAIL'} get_config api ${cfg.api} owner ${cfg.owner}`);
    if (acct.code_hash !== want || cfg.api !== 3) process.exit(1);
  }
}
const keys = await keysOf(contractId);
console.log(`${contractId} access keys now: ${keys.length}${lock ? (keys.length === 0 ? ' PASS (keyless)' : ' FAIL') : ' (not locked; run again with --lock after checking, or delete the key by hand)'}`);
console.log(`Shop key on chain: ${await view(provider, contractId, 'get_shop_key', { merchant: env.CBP_SHOP_ACCOUNT })}`);
console.log(`Next: RUN=31 CONTRACT_ID=${contractId} node app/scripts/demo-setup-v2.mjs (orders), then CONTRACT_ID=${contractId} RELAYER_REGISTERS=0 npm run dev`);
