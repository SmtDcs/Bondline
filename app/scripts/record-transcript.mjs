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
// data/merchant.log (both appended by app/lib/relayer.mjs during the recorded run).
//
// preview_claim on a settled order can only answer ERR_ALREADY_CLAIMED. For the chat step's `views`
// (the replay's offline BINDING check) this script therefore uses the BINDING result that the page
// itself recorded at chat time in data/binding-views.json, when the live view is ERR_ALREADY_CLAIMED.
// get_receipt is immutable, so the live one is used; get_order/get_merchant are the current state.
import fs from 'node:fs';
import path from 'node:path';
import { makeProvider, view } from '../lib/near.mjs';

const ORDER_ID_RE = /^[A-Za-z0-9-]{1,32}$/;
const RPC_TRIES = 5;
const RPC_DELAY_MS = 1500;

const ROOT = process.cwd();
const BUNDLE_DIR = path.join(ROOT, 'data', 'bundles');
const LIVE_DIR = path.join(ROOT, 'fixtures', 'live');
const REPLAY_DIR = path.join(ROOT, 'fixtures', 'replay');
const CLAIMS_LOG = path.join(ROOT, 'data', 'claims.log');
const MERCHANT_LOG = path.join(ROOT, 'data', 'merchant.log');
const SNAPSHOT = path.join(ROOT, 'data', 'binding-views.json');
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

function newestBundle(orderId) {
  const files = fs.readdirSync(BUNDLE_DIR).filter(f => f.endsWith('.json'));
  let best = null;
  for (const f of files) {
    const file = path.join(BUNDLE_DIR, f);
    let bundle;
    try { bundle = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (bundle.order_id !== orderId) continue;
    const created = Date.parse(bundle.created_at ?? '') || fs.statSync(file).mtimeMs;
    if (!best || created > best.created) best = { created, file, bundle };
  }
  if (!best) throw new Error(`no bundle for order ${orderId} in data/bundles/`);
  return best;
}

function tamperedCopy(bundle) {
  const text = Buffer.from(bundle.response_b64, 'base64').toString('utf8');
  if (!text.includes('bps=2000')) throw new Error('the honest reply has no bps=2000 to edit');
  const edited = text.replace('bps=2000', 'bps=3000');
  return { ...bundle, response_b64: Buffer.from(edited, 'utf8').toString('base64') };
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line));
}

function lastLine(lines, match, what) {
  const found = lines.filter(match).at(-1);
  if (!found) throw new Error(`no ${what} line found`);
  return found;
}

function lastUserMessage(bundle) {
  const request = JSON.parse(Buffer.from(bundle.request_b64, 'base64').toString('utf8'));
  const user = [...(request.messages ?? [])].reverse().find(m => m.role === 'user');
  if (!user) throw new Error('the request bytes carry no user message');
  return user.content;
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

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT)) return {};
  return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
}

const bundleA = newestBundle(orderA);
const bundleB = newestBundle(orderB);
const contractId = bundleA.bundle.chain?.contract ?? bundleB.bundle.chain?.contract;
if (!contractId || contractId !== bundleB.bundle.chain?.contract) throw new Error('the two bundles name different contracts');
console.log(`bundles: ${orderA} -> ${path.relative(ROOT, bundleA.file)} (${bundleA.bundle.response_hash.slice(0, 12)})`);
console.log(`         ${orderB} -> ${path.relative(ROOT, bundleB.file)} (${bundleB.bundle.response_hash.slice(0, 12)})`);
console.log(`contract: ${contractId}  rpc: ${RPC_URL}`);

const provider = makeProvider(RPC_URL);
const snapshot = loadSnapshot();

async function recordViews(orderId, bundle) {
  const receipt = await viewWithRetry(provider, contractId, 'get_receipt', { response_hash: bundle.response_hash });
  const previewLive = await viewWithRetry(provider, contractId, 'preview_claim', { order_id: orderId, response_b64: bundle.response_b64 });
  const order = await viewWithRetry(provider, contractId, 'get_order', { order_id: orderId });
  if (!order) throw new Error(`get_order(${orderId}) is null`);
  const merchant = await viewWithRetry(provider, contractId, 'get_merchant', { merchant: order.merchant });
  const atChat = snapshot[orderId]?.preview_claim;
  const settled = previewLive && previewLive.ok === false && previewLive.error === 'ERR_ALREADY_CLAIMED';
  const preview = settled && atChat?.ok ? atChat : previewLive;
  console.log(`  ${orderId}: receipt ${receipt ? `block ${receipt.block_height}` : 'null'}; preview_claim ${JSON.stringify(preview)}${preview !== previewLive ? ' (chat-time snapshot)' : ''}`);
  return { get_receipt: receipt, preview_claim: preview, get_order: order, get_merchant: merchant };
}

const viewsA = await recordViews(orderA, bundleA.bundle);
const viewsB = await recordViews(orderB, bundleB.bundle);

const claims = readJsonLines(CLAIMS_LOG);
const claimA = lastLine(claims, l => l.order_id === orderA && l.claim_tx, `claims.log claim for ${orderA}`);
const claimB = lastLine(claims, l => l.order_id === orderB && l.claim_tx, `claims.log claim for ${orderB}`);
const edits = readJsonLines(MERCHANT_LOG);
const editedA = lastLine(edits, l => l.kind === 'register-edited' && l.order_id === orderA, `merchant.log register-edited for ${orderA}`);
if (editedA.error !== 'ERR_BAD_SIGNATURE') throw new Error(`expected ERR_BAD_SIGNATURE for ${orderA}, got ${editedA.error}`);

const transcript = {
  type: 'bot-promises/replay/v1',
  recorded_at: new Date().toISOString(),
  contract: contractId,
  steps: [
    { kind: 'chat', order_id: orderA, message: lastUserMessage(bundleA.bundle), bundle_file: 'fixtures/live/a123.json', register_tx: bundleA.bundle.chain.register_tx, views: viewsA },
    { kind: 'claim', order_id: orderA, claim_tx: claimA.claim_tx, result: claimA.result },
    { kind: 'chat', order_id: orderB, message: lastUserMessage(bundleB.bundle), bundle_file: 'fixtures/live/a124.json', register_tx: bundleB.bundle.chain.register_tx, views: viewsB },
    { kind: 'claim', order_id: orderB, claim_tx: claimB.claim_tx, result: claimB.result },
    { kind: 'register-edited', order_id: orderA, tx: editedA.tx, error: editedA.error },
    { kind: 'claim-again', order_id: orderA, error: 'ERR_ALREADY_CLAIMED' },
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
console.log(`register-edited ${orderA}: ${editedA.error} tx ${editedA.tx}`);
