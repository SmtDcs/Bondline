// T18: helpers for app/scripts/record-transcript.mjs, kept out of the CLI script so node tests
// can exercise the recording rules without a live RPC.
//
// `chatTimePreview` rebuilds the ClaimPreview the contract's evaluate() would have returned while
// the order was still open. The recorder runs after the claims, when the live preview_claim can
// only answer ERR_ALREADY_CLAIMED (the contract checks the order status first), so the transcript's
// chat-time views are computed from the committed bundle bytes + get_receipt + get_order with the
// same rules and error strings. Nothing is copied from a hand-made snapshot file.
import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from './nearai.mjs';
import { extractContent, parsePromise } from './promise.mjs';

/** Newest bundle for `orderId` in `bundleDir` by bundle.created_at, falling back to file mtime. */
export function newestBundle(bundleDir, orderId) {
  const files = fs.readdirSync(bundleDir).filter(f => f.endsWith('.json'));
  let best = null;
  for (const f of files) {
    const file = path.join(bundleDir, f);
    let bundle;
    try { bundle = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (bundle.order_id !== orderId) continue;
    const created = Date.parse(bundle.created_at ?? '') || fs.statSync(file).mtimeMs;
    if (!best || created > best.created) best = { created, file, bundle };
  }
  if (!best) throw new Error(`no bundle for order ${orderId} in ${bundleDir}`);
  return best;
}

/** The page's Tamper edit (web/app.js tamperText): first bps=2000 -> bps=3000, else the first
 *  digit after bps= becomes 3. Returns a new bundle or null when the reply has no bps=. */
export function tamperedCopy(bundle) {
  const text = Buffer.from(bundle.response_b64, 'base64').toString('utf8');
  let edited;
  if (text.includes('bps=2000')) {
    edited = text.replace('bps=2000', 'bps=3000');
  } else {
    const m = /bps=\d/.exec(text);
    if (!m) return null;
    const digit = m.index + 'bps='.length;
    edited = text.slice(0, digit) + '3' + text.slice(digit + 1);
  }
  return { ...bundle, response_b64: Buffer.from(edited, 'utf8').toString('base64') };
}

/** The ClaimPreview the contract returns for `responseB64` while `order` is still open. */
export function chatTimePreview(order, responseB64, receipt) {
  const bytes = Buffer.from(responseB64, 'base64');
  const response_hash = sha256Hex(bytes);
  const err = (error, token_bps = 0) => ({ ok: false, error, token_bps, paid_bps: 0, payout: '0', response_hash });
  if (!receipt) return err('ERR_NO_RECEIPT_FOR_BYTES');
  if (receipt.order_id !== order.order_id) return err('ERR_RECEIPT_ORDER_MISMATCH');
  const content = extractContent(bytes);
  if (content.error) return err(content.error);
  const token = parsePromise(content.content);
  if (token.error) return err(token.error);
  if (token.orderId !== order.order_id) return err('ERR_TOKEN_ORDER_MISMATCH', token.bps);
  const paid_bps = Math.min(token.bps, order.max_bps);
  const payout = (BigInt(order.amount) * BigInt(paid_bps) / 10_000n).toString();
  return { ok: true, error: null, token_bps: token.bps, paid_bps, payout, response_hash };
}

/**
 * `get_merchant` before the recorded claims: roll the final on-chain view back by every claim the
 * transcript records after the first chat step. A claim frees the order's liability from `reserved`
 * and moves the payout out of `bond` into `paid_out` (INTERFACES 3.9). The recorder runs after the
 * claims, so this is how the first chat step gets its real pre-claim meter.
 * claims: [{payout: yocto string, liability: yocto string}, ...]
 */
export function merchantBeforeClaims(finalMerchant, claims) {
  let bond = BigInt(finalMerchant.bond);
  let reserved = BigInt(finalMerchant.reserved);
  let paidOut = BigInt(finalMerchant.paid_out);
  for (const { payout, liability } of claims) {
    bond += BigInt(payout);
    reserved += BigInt(liability);
    paidOut -= BigInt(payout);
  }
  // A v2 token bond view (get_bond) carries `token`; keep it so the page shows the right asset.
  return { ...(finalMerchant.token !== undefined ? { token: finalMerchant.token } : {}), bond: bond.toString(), reserved: reserved.toString(), paid_out: paidOut.toString() };
}

export function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line));
}

export function lastLine(lines, match, what) {
  const found = lines.filter(match).at(-1);
  if (!found) throw new Error(`no ${what} line found`);
  return found;
}

export function lastUserMessage(bundle) {
  const request = JSON.parse(Buffer.from(bundle.request_b64, 'base64').toString('utf8'));
  const user = [...(request.messages ?? [])].reverse().find(m => m.role === 'user');
  if (!user) throw new Error('the request bytes carry no user message');
  return user.content;
}

/**
 * Where the recorder writes. The v1 run is recorded history (fixtures/live/a123.json ...,
 * fixtures/replay/transcript.json) and must never be overwritten by a v2 recording, so a v2 contract
 * gets its own file names.
 */
export function outputPaths(api) {
  const v = api === 2 ? '-v2' : '';
  return {
    bundleA: `fixtures/live/a123${v}.json`,
    bundleB: `fixtures/live/a124${v}.json`,
    tampered: `fixtures/live/a123${v}-tampered.json`,
    transcript: `fixtures/replay/transcript${v}.json`,
  };
}
