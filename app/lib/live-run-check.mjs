// Offline structure check of fixtures/runs/v2-live-run.json, and the comparison used when it is replayed
// against the chain (app/scripts/verify-live-run.mjs). No network here.
import { isDeepStrictEqual } from 'node:util';

const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** Problems with the recorded run as a list of strings (empty = well formed). */
export function checkLiveRunStructure(data) {
  const problems = [];
  if (!['bot-promises/live-run/v2', 'bot-promises/live-run/v3'].includes(data?.type)) problems.push('type must be bot-promises/live-run/v2 or bot-promises/live-run/v3');
  if (!Array.isArray(data?.txs) || data.txs.length === 0) { problems.push('txs must be a non-empty array'); return problems; }
  const seen = new Set();
  data.txs.forEach((t, i) => {
    const at = `tx #${i} (${t?.label ?? '?'})`;
    if (!BASE58_HASH.test(String(t?.tx_hash ?? ''))) problems.push(`${at}: tx_hash is not a base58 hash`);
    if (seen.has(t?.tx_hash)) problems.push(`${at}: duplicate tx_hash ${t.tx_hash}`);
    seen.add(t?.tx_hash);
    if (t.explorer !== `https://testnet.nearblocks.io/txns/${t.tx_hash}`) problems.push(`${at}: explorer link does not match the hash`);
    if (typeof t.ok !== 'boolean') problems.push(`${at}: ok must be a boolean`);
    if (t.ok === false && !/^ERR_|^[A-Za-z]/.test(String(t.error ?? ''))) problems.push(`${at}: a failed tx must record its error`);
    if (t.ok === true && t.error) problems.push(`${at}: a successful tx has an error`);
    if (!t.signer || !t.receiver || !t.method) problems.push(`${at}: signer/receiver/method missing`);
    if (!/^[LV]\d+[a-z]?$/.test(String(t.step ?? ''))) problems.push(`${at}: step must look like L7, L9b or (v3) V2`);
    if (!/^\d+$/.test(String(t.gas_burnt_total ?? ''))) problems.push(`${at}: gas_burnt_total missing`);
    if (!Array.isArray(t.receipts)) problems.push(`${at}: receipts missing`);
    const text = JSON.stringify(t);
    if (/ed25519:[1-9A-HJ-NP-Za-km-z]{50,}|sk-[A-Za-z0-9]{10,}/.test(text)) problems.push(`${at}: contains something that looks like a secret`);
  });
  // Later rounds on a redeployed build (`rechecks`): every record tagged with a `round` must name a listed round, and a
  // listed round must say which wasm (sha256) and which redeploy transaction it ran against.
  const rounds = new Set();
  for (const [i, r] of (data.rechecks ?? []).entries()) {
    if (!r?.round) problems.push(`rechecks #${i}: round missing`);
    if (!/^[0-9a-f]{64}$/.test(String(r?.wasm_sha256 ?? ''))) problems.push(`rechecks #${i}: wasm_sha256 must be 64 hex characters`);
    if (!BASE58_HASH.test(String(r?.redeploy_tx ?? ''))) problems.push(`rechecks #${i}: redeploy_tx is not a base58 hash`);
    rounds.add(r?.round);
  }
  for (const [i, t] of data.txs.entries()) if (t.round !== undefined && !rounds.has(t.round)) problems.push(`tx #${i} (${t?.label ?? '?'}): round ${t.round} is not listed in rechecks`);
  if (!Array.isArray(data.checks)) problems.push('checks must be an array');
  else data.checks.forEach((c, i) => {
    const at = `check #${i} [${c.step}] ${c.name}`;
    if (c.round !== undefined && !rounds.has(c.round)) problems.push(`${at}: round ${c.round} is not listed in rechecks`);
    if (c.pass !== true) problems.push(`check #${i} did not pass: [${c.step}] ${c.name}`);
    // A self-reported pass flag proves nothing: the recorded value must itself equal the expectation.
    else if (!checkHolds(c)) problems.push(`${at}: pass is true but got ${JSON.stringify(c.got)} is not expected ${JSON.stringify(c.expected)}`);
  });
  return problems;
}

/** Documented predicate expectations: the string '>0' means "a positive integer". Anything else must be deep-equal. */
export function checkHolds(c) {
  if (c.expected === '>0') {
    try { return BigInt(String(c.got)) > 0n; } catch { return false; }
  }
  return isDeepStrictEqual(c.got, c.expected);
}

/** Compare a recorded tx with the same tx re-read from the chain. Returns a list of differences. */
export function diffRecord(recorded, fresh) {
  const out = [];
  // Who called what is part of the record: a tx cannot be relabelled as another call and still match the chain.
  for (const k of ['signer', 'receiver', 'method']) {
    if (fresh[k] !== undefined && recorded[k] !== fresh[k]) out.push(`${k} ${recorded[k]} != ${fresh[k]}`);
  }
  if (recorded.ok !== fresh.ok) out.push(`ok ${recorded.ok} != ${fresh.ok}`);
  if ((recorded.error ?? null) !== (fresh.error ?? null)) out.push(`error ${recorded.error} != ${fresh.error}`);
  if (JSON.stringify(recorded.value ?? null) !== JSON.stringify(fresh.value ?? null)) out.push('value differs');
  if (String(recorded.gas_burnt_total) !== String(fresh.gas_burnt_total)) out.push(`gas ${recorded.gas_burnt_total} != ${fresh.gas_burnt_total}`);
  if (JSON.stringify(recorded.logs) !== JSON.stringify(fresh.logs)) out.push('logs differ');
  return out;
}
