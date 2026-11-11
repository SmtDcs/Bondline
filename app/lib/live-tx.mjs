// Signing + recording helpers for the live testnet scripts (near-api-js only, no near-cli).
// Used by app/scripts/demo-setup-v2.mjs and app/scripts/live-v2.mjs.
//
// Rules:
//  - Keys come from .env, parsed here (never sourced, never printed). `readEnvFile` returns them in an object;
//    nothing in this module logs a value of a *_KEY / *_SECRET_KEY entry.
//  - Every transaction goes through `sendTx`, which returns a record (hash, args, result, gas burnt per
//    receipt, logs) whether the transaction succeeded or failed, so failures are recorded like successes.
import fs from 'node:fs';
import path from 'node:path';
import { Account, KeyPairSigner, teraToGas } from 'near-api-js';
import { explorerTx } from './near.mjs';

/** Parse KEY=value lines (optional single/double quotes). No shell, no expansion. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (v.length > 1 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    out[key] = v;
  }
  return out;
}

/** .env values with the process environment winning (same rule as `node --env-file`). */
export function readEnvFile(file = '.env', env = process.env) {
  const fromFile = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) };
}

/** Any value whose key looks like a secret is replaced before text is printed or stored. */
export function redactSecrets(text, env) {
  let out = String(text);
  for (const [k, v] of Object.entries(env ?? {})) {
    if (/KEY|SECRET|TOKEN_ENV/i.test(k) && typeof v === 'string' && v.length >= 12) out = out.split(v).join(`<${k}>`);
  }
  return out.replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{50,}/g, 'ed25519:<redacted>').replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-<redacted>');
}

export function accountFor(provider, accountId, secretKey) {
  if (!accountId || !secretKey) throw new Error(`missing account or key for ${accountId ?? '(unset)'}`);
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(secretKey));
}

const bigStr = (v) => (v === undefined || v === null ? '0' : BigInt(v).toString());

/** "Smart contract panicked: ERR_X" or the raw JSON when it is something else. */
export function failureText(failure) {
  const s = typeof failure === 'string' ? failure : JSON.stringify(failure);
  const m = /Smart contract panicked: ([^"\\]+)/.exec(s);
  return m ? m[1].trim() : s;
}

/** Decode a base64 SuccessValue as JSON, or return the raw text when it is not JSON. */
export function decodeSuccess(status) {
  const b64 = status?.SuccessValue;
  if (b64 === undefined || b64 === null || b64 === '') return undefined;
  const text = Buffer.from(b64, 'base64').toString('utf8');
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Turn an RPC transaction response (with or without `receipts`) into the plain record that is committed.
 * `receipts_outcome` is in execution order; `receipts` (only with viewTransactionStatusWithReceipts) names
 * the method of each function call. A receipt that is a refund or a data receipt has no method.
 */
export function describeOutcome(outcome) {
  const txHash = outcome.transaction_outcome?.id ?? outcome.transaction?.hash;
  const methodByReceipt = new Map();
  for (const r of outcome.receipts ?? []) {
    const actions = r.receipt?.Action?.actions ?? [];
    const calls = actions.map(a => a.FunctionCall?.method_name).filter(Boolean);
    const transfers = actions.filter(a => a.Transfer).length;
    methodByReceipt.set(r.receipt_id, {
      predecessor: r.predecessor_id,
      receiver: r.receiver_id,
      method: calls.length ? calls.join('+') : (transfers ? 'transfer' : null),
    });
  }
  const receipts = (outcome.receipts_outcome ?? []).map(ro => {
    const info = methodByReceipt.get(ro.id) ?? {};
    const st = ro.outcome?.status ?? {};
    const kind = Object.keys(st)[0] ?? 'Unknown';
    return {
      receipt_id: ro.id,
      executor: ro.outcome?.executor_id,
      predecessor: info.predecessor ?? null,
      method: info.method ?? null,
      gas_burnt: bigStr(ro.outcome?.gas_burnt),
      status: kind === 'SuccessValue' || kind === 'SuccessReceiptId' ? 'success' : kind === 'Failure' ? 'failure' : kind.toLowerCase(),
      ...(kind === 'Failure' ? { failure: failureText(st.Failure) } : {}),
      logs: ro.outcome?.logs ?? [],
    };
  });
  const txGas = bigStr(outcome.transaction_outcome?.outcome?.gas_burnt);
  const total = receipts.reduce((a, r) => a + BigInt(r.gas_burnt), BigInt(txGas));
  const status = outcome.status ?? {};
  const failed = 'Failure' in status;
  // Who signed, who was called and which method: read from the transaction itself so a replay can compare them.
  const tx = outcome.transaction;
  const txCalls = (tx?.actions ?? []).map(a => a.FunctionCall?.method_name).filter(Boolean);
  return {
    tx_hash: txHash,
    explorer: txHash ? explorerTx(txHash) : null,
    ...(tx?.signer_id ? { signer: tx.signer_id } : {}),
    ...(tx?.receiver_id ? { receiver: tx.receiver_id } : {}),
    ...(txCalls.length ? { method: txCalls.join('+') } : {}),
    ok: !failed,
    error: failed ? failureText(status.Failure) : null,
    value: failed ? undefined : decodeSuccess(status),
    gas_burnt_total: total.toString(),
    gas_burnt_tx: txGas,
    receipts,
    logs: receipts.flatMap(r => r.logs),
  };
}

/** Gas burnt of the receipt that ran `method` (first match), as Tgas with 3 decimals, or null. */
export function tgasOf(record, method, executor) {
  const r = record.receipts.find(x => x.method === method && (!executor || x.executor === executor));
  return r ? Number(BigInt(r.gas_burnt)) / 1e12 : null;
}

/** EVENT_JSON:{...} lines from a record's logs, parsed. */
export function eventsOf(record) {
  return record.logs.filter(l => l.startsWith('EVENT_JSON:')).map(l => JSON.parse(l.slice('EVENT_JSON:'.length)));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Retry a flaky RPC read a few times (the public RPC drops connections now and then). */
export async function retry(fn, { tries = 5, delayMs = 1500, shouldRetry = () => true } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (!shouldRetry(e)) throw e; if (i < tries) await sleep(delayMs); }
  }
  throw last;
}

/** client-5: true when the RPC answered "I do not have this transaction" (a non-archival node garbage-collects old
 *  outcomes after a few epochs). That answer is final for an old tx: retrying it only wastes time. */
export function isTxNotServed(e) {
  const text = `${e?.type ?? ''} ${e?.name ?? ''} ${e?.message ?? ''}`;
  return /UNKNOWN_TRANSACTION|UnknownTransaction|doesn't exist|does not exist|not found|GARBAGE_COLLECTED/i.test(text);
}

/** Fetch the full record of an existing tx (for transactions another process signed, e.g. the relayer). */
export async function fetchTxRecord(provider, txHash, signerId, retryOpts = {}) {
  const outcome = await retry(() => provider.viewTransactionStatusWithReceipts({ txHash, accountId: signerId, waitUntil: 'FINAL' }), retryOpts);
  return describeOutcome(outcome);
}

/**
 * Sign and send one function call, wait for FINAL, and always return a record.
 * `meta` = { step, label }. A contract panic is a normal result here (record.ok === false, record.error).
 * Only a transport failure with no tx hash is thrown.
 */
export async function sendTx(provider, account, { contractId, method, args = {}, tgas = 100, depositYocto = 0n, step, label }) {
  const base = {
    step: step ?? null, label: label ?? `${method}`,
    signer: account.accountId, receiver: contractId, method, args,
    deposit_yocto: depositYocto.toString(), prepaid_tgas: tgas,
    at: new Date().toISOString(),
  };
  let outcome;
  let txHash;
  try {
    outcome = await account.callFunctionRaw({ contractId, methodName: method, args, gas: teraToGas(tgas), deposit: depositYocto, waitUntil: 'FINAL' });
    txHash = outcome.transaction_outcome?.id;
  } catch (e) {
    txHash = e?.transactionResult?.transaction_outcome?.id ?? e?.transactionResult?.transaction?.hash;
    if (!txHash) throw e;
    outcome = e.transactionResult;
  }
  let described;
  try {
    // Re-read with receipts so each receipt names its method (gas per call).
    described = await fetchTxRecord(provider, txHash, account.accountId);
  } catch {
    described = describeOutcome(outcome);
  }
  return { ...base, ...described };
}

/** Collects records and writes them as one JSON file, rewritten after every append (a crash loses nothing). */
export class RunBook {
  constructor(file, header) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { ...header, txs: [], checks: [], notes: [] };
  }
  save() {
    fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n');
  }
  tx(record) {
    this.data.txs.push(record);
    this.save();
    return record;
  }
  /** A check is a comparison the script made itself: `pass` is computed, never typed in. */
  check(step, name, got, expected, pass) {
    const ok = pass === undefined ? JSON.stringify(got) === JSON.stringify(expected) : Boolean(pass);
    this.data.checks.push({ step, name, got, expected, pass: ok });
    this.save();
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${step}] ${name}: got ${JSON.stringify(got)}${pass === undefined ? ` expected ${JSON.stringify(expected)}` : ''}`);
    return ok;
  }
  note(step, text) {
    this.data.notes.push({ step, text, at: new Date().toISOString() });
    this.save();
  }
}

/** One line per transaction, for the console. */
export function txLine(rec) {
  return `${rec.ok ? 'ok  ' : 'FAIL'} ${rec.signer} -> ${rec.receiver}.${rec.method} ${rec.tx_hash}${rec.ok ? '' : ` ${rec.error}`} gas ${(Number(BigInt(rec.gas_burnt_total)) / 1e12).toFixed(2)}T`;
}
