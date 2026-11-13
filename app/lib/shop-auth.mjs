// v3 shop authorization (contract-v3, docs/V3.md). The shop's bot server puts ONE tag into the system prompt of
// every request it sends to NEAR AI:
//
//   SHOP_AUTH|v3|contract=<contract>|merchant=<merchant>|order=<order id>|buyer=<buyer>|nonce=<32 hex>|sig=<128 hex>
//
// `sig` is an ed25519 signature, by the shop-auth key the merchant registered on chain (`set_shop_key`, copied into
// every order at `register_order`), over the UTF-8 bytes of
//
//   "cbp-v3-shop-auth:" + hex(sha256(request bytes with the 128 sig characters replaced by '0'))
//
// so the signature covers the WHOLE request (model, system prompt, history, the customer's message, nonce) and not
// just the tag. A request the customer builds and sends to NEAR AI on their own has no valid tag, so the contract
// refuses to accept a customer-submitted receipt for it (`register_receipt_as_buyer`). This file is the JS mirror of
// contract-v3/src/parse.rs `parse_shop_auth` plus the shop-side signer; both sides are run against the same vectors
// (contract-v3/tests/v3_vectors.json, app/test/shop-auth.test.mjs).
import crypto from 'node:crypto';

export const SHOP_AUTH_MARKER = 'SHOP_AUTH|';
export const SHOP_AUTH_PREFIX = 'SHOP_AUTH|v3|';
export const SHOP_AUTH_DOMAIN = 'cbp-v3-shop-auth:';
export const ZERO_SIG = '0'.repeat(128);
const FIELDS = ['contract', 'merchant', 'order', 'buyer', 'nonce', 'sig'];
const VALUE_RE = /^[A-Za-z0-9._-]+$/;
const ORDER_RE = /^[A-Za-z0-9-]{1,32}$/;
const ACCOUNT_RE = /^[a-z0-9._-]{2,64}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX128_RE = /^[0-9a-f]{128}$/;

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** The tag text. With no `sig`, the 128-zero placeholder the signature is computed over. */
export function authLine({ contract, merchant, order, buyer, nonce, sig = ZERO_SIG }) {
  for (const [k, v] of Object.entries({ contract, merchant, buyer })) {
    if (!ACCOUNT_RE.test(String(v))) throw new Error(`shop auth: bad ${k} ${JSON.stringify(v)}`);
  }
  if (!ORDER_RE.test(String(order))) throw new Error(`shop auth: bad order ${JSON.stringify(order)}`);
  if (!HEX32_RE.test(String(nonce))) throw new Error('shop auth: nonce must be 32 lowercase hex characters');
  if (!HEX128_RE.test(String(sig))) throw new Error('shop auth: sig must be 128 lowercase hex characters');
  return `${SHOP_AUTH_PREFIX}contract=${contract}|merchant=${merchant}|order=${order}|buyer=${buyer}|nonce=${nonce}|sig=${sig}`;
}

export function newNonce() {
  return crypto.randomBytes(16).toString('hex');
}

/** Every byte offset of `needle` in `hay` (Buffers). */
function offsets(hay, needle) {
  const out = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

const TAG_BYTE = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2e || b === 0x5f || b === 0x2d || b === 0x7c || b === 0x3d;

/**
 * Find and parse the tag in the raw request bytes. Same rules and error codes as the contract:
 * exactly one `SHOP_AUTH|` in the raw bytes, the fixed field order, lowercase hex nonce/sig.
 * Returns { ok:true, contract, merchant, order, buyer, nonce, sig, sigOffset } or { ok:false, error }.
 */
export function parseShopAuth(requestBytes) {
  const bytes = Buffer.isBuffer(requestBytes) ? requestBytes : Buffer.from(requestBytes);
  const at = offsets(bytes, Buffer.from(SHOP_AUTH_MARKER));
  if (at.length === 0) return { ok: false, error: 'ERR_SHOP_AUTH_MISSING' };
  if (at.length > 1) return { ok: false, error: 'ERR_SHOP_AUTH_MULTIPLE' };
  let end = at[0];
  while (end < bytes.length && TAG_BYTE(bytes[end])) end++;
  const tag = bytes.subarray(at[0], end).toString('latin1');
  if (!tag.startsWith(SHOP_AUTH_PREFIX)) return { ok: false, error: 'ERR_SHOP_AUTH_FORMAT' };
  const parts = tag.slice(SHOP_AUTH_PREFIX.length).split('|');
  if (parts.length !== FIELDS.length) return { ok: false, error: 'ERR_SHOP_AUTH_FORMAT' };
  const out = {};
  for (let i = 0; i < FIELDS.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq < 0 || parts[i].slice(0, eq) !== FIELDS[i]) return { ok: false, error: 'ERR_SHOP_AUTH_FORMAT' };
    const value = parts[i].slice(eq + 1);
    if (!VALUE_RE.test(value)) return { ok: false, error: 'ERR_SHOP_AUTH_FORMAT' };
    out[FIELDS[i]] = value;
  }
  if (!HEX32_RE.test(out.nonce) || !HEX128_RE.test(out.sig) || !ORDER_RE.test(out.order)) return { ok: false, error: 'ERR_SHOP_AUTH_FORMAT' };
  return { ok: true, ...out, sigOffset: end - 128 };
}

/** The bytes the shop signs: "cbp-v3-shop-auth:" + hex(sha256(request with the sig zeroed)). */
export function shopAuthMessage(requestBytes, sigOffset) {
  const template = Buffer.from(requestBytes);
  template.write(ZERO_SIG, sigOffset, 'latin1');
  return Buffer.from(SHOP_AUTH_DOMAIN + sha256Hex(template), 'utf8');
}

function seedKey(seedHex) {
  const seed = Buffer.from(String(seedHex).replace(/^0x/, ''), 'hex');
  if (seed.length !== 32) throw new Error('shop auth seed must be 32 bytes hex');
  return crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
}

/** The 32-byte public key (hex) of a 32-byte seed (hex). This is what `set_shop_key` registers. */
export function publicKeyFromSeed(seedHex) {
  return crypto.createPublicKey(seedKey(seedHex)).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
}

function publicKey(hex) {
  const raw = Buffer.from(String(hex).replace(/^0x/, ''), 'hex');
  if (raw.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
}

/**
 * Sign request bytes that carry the tag with the zero placeholder. Returns the final request bytes (same length,
 * only the 128 sig characters changed). Throws if the bytes do not carry exactly one placeholder tag.
 */
export function signRequestBytes(templateBytes, seedHex) {
  const p = parseShopAuth(templateBytes);
  if (!p.ok) throw new Error(`shop auth: ${p.error}`);
  if (p.sig !== ZERO_SIG) throw new Error('shop auth: the template must carry the zero placeholder signature');
  const sig = crypto.sign(null, shopAuthMessage(templateBytes, p.sigOffset), seedKey(seedHex)).toString('hex');
  const out = Buffer.from(templateBytes);
  out.write(sig, p.sigOffset, 'latin1');
  return out;
}

/**
 * Off-chain mirror of the contract's shop-authorization check. `expect` = { publicKeyHex, contract, merchant, order, buyer }.
 * Returns null when the request is authorized, or the contract's error code.
 */
export function checkShopAuth(requestBytes, expect) {
  const p = parseShopAuth(requestBytes);
  if (!p.ok) return p.error;
  if (p.contract !== expect.contract) return 'ERR_SHOP_AUTH_CONTRACT';
  if (p.merchant !== expect.merchant) return 'ERR_SHOP_AUTH_MERCHANT';
  if (p.order !== expect.order) return 'ERR_SHOP_AUTH_ORDER';
  if (p.buyer !== expect.buyer) return 'ERR_SHOP_AUTH_BUYER';
  let ok = false;
  try {
    ok = crypto.verify(null, shopAuthMessage(requestBytes, p.sigOffset), publicKey(expect.publicKeyHex), Buffer.from(p.sig, 'hex'));
  } catch { ok = false; }
  return ok ? null : 'ERR_SHOP_AUTH_SIGNATURE';
}
