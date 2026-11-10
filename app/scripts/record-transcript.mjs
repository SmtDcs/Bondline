#!/usr/bin/env node
// Usage: node app/scripts/record-transcript.mjs A123-10 A124-10     (from the repo root)
//
// T18: turn one live demo run into committed replay files.
//  - takes the newest bundle in data/bundles/ for each order id (args: A123-nn A124-nn)
//  - copies them to fixtures/live/a123.json and fixtures/live/a124.json
//  - writes fixtures/live/a123-tampered.json: the A123 response bytes with the first bps=2000
//    changed to bps=3000, everything else (hashes, signature, chain) unchanged, so it must NOT verify
//  - calls get_receipt, preview_claim, get_order and get_merchant through app/lib/near.mjs
//  - writes fixtures/replay/transcript.json in the INTERFACES.md section 15 format
//
// The claim tx hashes come from data/claims.log and the failed register-edited tx from
// data/merchant.log (both appended by app/lib/relayer.mjs during the recorded run). The
// `claim-again` step is the logged ERR_ALREADY_CLAIMED attempt, not a literal.
//
// preview_claim on a settled order can only answer ERR_ALREADY_CLAIMED (the contract checks the
// order status first), so the transcript's chat-time `preview_claim`, each `views.tamper` outcome
// and the first chat step's pre-claim bond meter are COMPUTED by app/lib/transcript.mjs with the
// contract's own rules from the committed bundle bytes + get_receipt + get_order + the claim log.
// No hand-made snapshot file is read: re-running this script against the same bundles/logs
// reproduces the recording.
import fs from 'node:fs';
import path from 'node:path';
import { makeProvider, view } from '../lib/near.mjs';
import { sha256Hex } from '../lib/nearai.mjs';
import { detectApi, orderArgs, receiptArgs, previewClaimArgs } from '../lib/contract-api.mjs';
import { ftMetadata } from '../lib/token.mjs';
import {
  newestBundle, tamperedCopy, chatTimePreview, merchantBeforeClaims, readJsonLines, lastLine, lastUserMessage,
} from '../lib/transcript.mjs';

const ORDER_ID_RE = /^[A-Za-z0-9-]{1,32}$/;
const RPC_TRIES = 5;
const RPC_DELAY_MS = 1500;

const ROOT = process.cwd();
const BUNDLE_DIR = path.join(ROOT, 'data', 'bundles');
const LIVE_DIR = path.join(ROOT, 'fixtures', 'live');
const REPLAY_DIR = path.join(ROOT, 'fixtures', 'replay');
const CLAIMS_LOG = path.join(ROOT, 'data', 'claims.log');
const MERCHANT_LOG = path.join(ROOT, 'data', 'merchant.log');
const RPC_URL = process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com';

const [orderA, orderB] = process.argv.slice(2);
if (!orderA || !orderB || !ORDER_ID_RE.test(orderA) || !ORDER_ID_RE.test(orderB)) {
  console.error('usage: node app/scripts/record-transcript.mjs <A123-nn> <A124-nn>');
  process.exit(2);
}
if (!orderA.startsWith('A123-') || !orderB.startsWith('A124-')) {
  console.error('the args must be the honest order (A123-nn) first and the injection order (A124-nn) second');
  process.exit(2);
}

async function viewWithRetry(provider, contractId, method, args) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await view(provider, contractId, method, args);
    } catch (e) {
      if (attempt >= RPC_TRIES) throw new Error(`${method} failed after ${attempt} tries: ${e.message}`);
      console.log(`  ${method} try ${attempt} failed (${e.message}); retrying`);
      await new Promise(r => setTimeout(r, RPC_DELAY_MS));
    }
  }
}

const bundleA = newestBundle(BUNDLE_DIR, orderA);
const bundleB = newestBundle(BUNDLE_DIR, orderB);
const contractId = bundleA.bundle.chain?.contract ?? bundleB.bundle.chain?.contract;
if (!contractId || contractId !== bundleB.bundle.chain?.contract) throw new Error('the two bundles name different contracts');
console.log(`bundles: ${orderA} -> ${path.relative(ROOT, bundleA.file)} (${bundleA.bundle.response_hash.slice(0, 12)})`);
console.log(`         ${orderB} -> ${path.relative(ROOT, bundleB.file)} (${bundleB.bundle.response_hash.slice(0, 12)})`);
console.log(`contract: ${contractId}  rpc: ${RPC_URL}`);

const provider = makeProvider(RPC_URL);
// v2 keys orders and receipts by (merchant, id); v1 does not. Detect once, then use the matching args.
const api = await detectApi(provider, contractId);
console.log(`contract api ${api}`);

async function recordViews(orderId, bundle) {
  const order = await viewWithRetry(provider, contractId, 'get_order', orderArgs(api, null, orderId));
  if (!order) throw new Error(`get_order(${orderId}) is null`);
  const receipt = await viewWithRetry(provider, contractId, 'get_receipt', receiptArgs(api, order.merchant, bundle.response_hash));
  const previewLive = await viewWithRetry(provider, contractId, 'preview_claim', previewClaimArgs(api, order.merchant, orderId, bundle.response_b64));
  const merchant = await viewWithRetry(provider, contractId, 'get_merchant', { merchant: order.merchant });
  // The recorded run settled the order, so the live view is ERR_ALREADY_CLAIMED; rebuild what the
  // contract answered at chat time. If a future run is recorded while the order is still open, the
  // live view is the truthful one and is kept.
  const preview = previewLive?.error === 'ERR_ALREADY_CLAIMED'
    ? chatTimePreview(order, bundle.response_b64, receipt)
    : previewLive;
  console.log(`  ${orderId}: receipt ${receipt ? `block ${receipt.block_height}` : 'null'}; preview_claim live ${JSON.stringify(previewLive)}; recorded ${JSON.stringify(preview)}`);
  return { get_receipt: receipt, preview_claim: preview, get_order: order, get_merchant: merchant };
}

/** The edited bytes have no receipt. Record the outcome the page's Tamper button produced at run time. */
async function tamperViews(orderId, bundle, order) {
  const tampered = tamperedCopy(bundle);
  if (!tampered) return null;
  const responseHash = sha256Hex(Buffer.from(tampered.response_b64, 'base64'));
  const receipt = await viewWithRetry(provider, contractId, 'get_receipt', receiptArgs(api, order.merchant, responseHash));
  const previewLive = await viewWithRetry(provider, contractId, 'preview_claim', previewClaimArgs(api, order.merchant, orderId, tampered.response_b64));
  const preview = previewLive?.error === 'ERR_ALREADY_CLAIMED'
    ? chatTimePreview(order, tampered.response_b64, receipt)
    : previewLive;
  console.log(`  ${orderId} tampered: hash ${responseHash.slice(0, 12)}; preview_claim live ${JSON.stringify(previewLive)}; recorded ${JSON.stringify(preview)}`);
  return { response_b64: tampered.response_b64, response_hash: responseHash, get_receipt: receipt, preview_claim: preview };
}

const viewsA = await recordViews(orderA, bundleA.bundle);
const viewsB = await recordViews(orderB, bundleB.bundle);
const tamperA = await tamperViews(orderA, bundleA.bundle, viewsA.get_order);
const tamperB = await tamperViews(orderB, bundleB.bundle, viewsB.get_order);

const claims = readJsonLines(CLAIMS_LOG);
const claimA = lastLine(claims, l => l.order_id === orderA && l.claim_tx && l.result, `claims.log claim for ${orderA}`);
const claimB = lastLine(claims, l => l.order_id === orderB && l.claim_tx && l.result, `claims.log claim for ${orderB}`);
/** A recorded failed payout (ok:false): the retry beat of the v2 transcript. */
const failedFor = (orderId) => claims.filter(l => l.order_id === orderId && l.error === 'ERR_PAYOUT_FAILED').at(-1) ?? null;
const failedA = failedFor(orderA);
const failedB = failedFor(orderB);
const claimAgain = lastLine(claims, l => l.order_id === orderA && l.error === 'ERR_ALREADY_CLAIMED', `claims.log ERR_ALREADY_CLAIMED for ${orderA}`);
const edits = readJsonLines(MERCHANT_LOG);
const editedA = lastLine(edits, l => l.kind === 'register-edited' && l.order_id === orderA, `merchant.log register-edited for ${orderA}`);
if (editedA.error !== 'ERR_BAD_SIGNATURE') throw new Error(`expected ERR_BAD_SIGNATURE for ${orderA}, got ${editedA.error}`);

// The first chat step happened before both claims, so its bond meter is the final view rolled back
// by the two recorded claims. The last chat step keeps the live post-run view (used after a claim).
const preClaimMerchant = merchantBeforeClaims(viewsA.get_merchant, [
  { payout: claimA.result.payout, liability: viewsA.get_order.liability },
  { payout: claimB.result.payout, liability: viewsB.get_order.liability },
]);

// v2: token metadata for every token in a recorded order, so the replay page can format amounts.
const tokens = [];
if (api === 2) {
  for (const order of [viewsA.get_order, viewsB.get_order]) {
    const id = order?.token ?? null;
    if (id && !tokens.some(t => t.id === id)) tokens.push(await ftMetadata(provider, id));
  }
}

const transcript = {
  type: api === 2 ? 'bot-promises/replay/v2' : 'bot-promises/replay/v1',
  recorded_at: new Date().toISOString(),
  contract: contractId,
  ...(api === 2 ? { contract_api: 2, tokens } : {}),
  steps: [
    { kind: 'chat', order_id: orderA, message: lastUserMessage(bundleA.bundle), bundle_file: 'fixtures/live/a123.json', register_tx: bundleA.bundle.chain.register_tx, views: { ...viewsA, get_merchant: preClaimMerchant, ...(tamperA ? { tamper: tamperA } : {}) } },
    ...(failedA ? [{ kind: 'claim-failed', order_id: orderA, tx: failedA.claim_tx, error: failedA.error }] : []),
    { kind: 'claim', order_id: orderA, claim_tx: claimA.claim_tx, result: claimA.result },
    { kind: 'chat', order_id: orderB, message: lastUserMessage(bundleB.bundle), bundle_file: 'fixtures/live/a124.json', register_tx: bundleB.bundle.chain.register_tx, views: { ...viewsB, ...(tamperB ? { tamper: tamperB } : {}) } },
    ...(failedB ? [{ kind: 'claim-failed', order_id: orderB, tx: failedB.claim_tx, error: failedB.error }] : []),
    { kind: 'claim', order_id: orderB, claim_tx: claimB.claim_tx, result: claimB.result },
    { kind: 'register-edited', order_id: orderA, tx: editedA.tx, error: editedA.error },
    { kind: 'claim-again', order_id: orderA, error: claimAgain.error },
  ],
};

fs.mkdirSync(LIVE_DIR, { recursive: true });
fs.mkdirSync(REPLAY_DIR, { recursive: true });
fs.writeFileSync(path.join(LIVE_DIR, 'a123.json'), JSON.stringify(bundleA.bundle, null, 2) + '\n');
fs.writeFileSync(path.join(LIVE_DIR, 'a124.json'), JSON.stringify(bundleB.bundle, null, 2) + '\n');
fs.writeFileSync(path.join(LIVE_DIR, 'a123-tampered.json'), JSON.stringify(tamperedCopy(bundleA.bundle), null, 2) + '\n');
fs.writeFileSync(path.join(REPLAY_DIR, 'transcript.json'), JSON.stringify(transcript, null, 2) + '\n');

console.log(`wrote fixtures/live/a123.json, fixtures/live/a124.json, fixtures/live/a123-tampered.json, fixtures/replay/transcript.json`);
console.log(`steps: ${transcript.steps.map(s => s.kind).join(',')}`);
console.log(`claim ${orderA}: ${claimA.claim_tx}  payout ${claimA.result?.payout}`);
console.log(`claim ${orderB}: ${claimB.claim_tx}  payout ${claimB.result?.payout}`);
console.log(`claim-again ${orderA}: ${claimAgain.error} tx ${claimAgain.claim_tx}`);
console.log(`register-edited ${orderA}: ${editedA.error} tx ${editedA.tx}`);
