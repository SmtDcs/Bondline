// The chain half of `npm run verify:live-run`: re-read every recorded transaction and compare (client-5).
import { fetchTxRecord, isTxNotServed } from './live-tx.mjs';
import { diffRecord } from './live-run-check.mjs';

/** The ordinary public RPC: fast, but not archival (it drops old transaction outcomes after a few epochs). */
export const DEFAULT_LIVE_RUN_RPC = 'https://rpc.testnet.fastnear.com';
/** Archival fallback: keeps every transaction, but rate-limits (HTTP 429) a burst of reads, so it is only used for
 *  the transactions the default RPC no longer serves. */
export const ARCHIVAL_LIVE_RUN_RPC = 'https://archival-rpc.testnet.fastnear.com';

/**
 * Re-reads `txs` and compares each with the chain. Returns { mismatches, aborted, checked, usedFallback }.
 * When `provider` says it no longer has a transaction and a `fallback` ({provider, url}) exists, that transaction and
 * every later one are read from the fallback. When there is no fallback (an explicit --rpc) or the fallback does not
 * have it either, the run ends at once with ONE clear message (not one FAIL line and several retries per
 * transaction, about eight minutes for 81): every later one would fail the same way.
 * `fetchRecord` is injectable for tests.
 */
export async function replayLiveRun(provider, txs, {
  rpcUrl, fallback = null, log = console.log, fetchRecord = fetchTxRecord,
  retryOpts = { tries: 5, delayMs: 2000 }, paceMs = 0,
} = {}) {
  let mismatches = 0;
  let checked = 0;
  let active = { provider, url: rpcUrl };
  let usedFallback = false;
  const read = (t) => fetchRecord(active.provider, t.tx_hash, t.signer, { ...retryOpts, shouldRetry: (e) => !isTxNotServed(e) });
  for (const t of txs) {
    if (paceMs && checked + mismatches > 0) await new Promise(r => setTimeout(r, paceMs));
    let fresh;
    try {
      try {
        fresh = await read(t);
      } catch (e) {
        if (!isTxNotServed(e) || !fallback || usedFallback) throw e;
        log(`NOTE  ${active.url ?? 'the RPC'} no longer serves ${t.tx_hash} (not archival): reading it and the rest from ${fallback.url}`);
        active = fallback;
        usedFallback = true;
        fresh = await read(t);
      }
    } catch (e) {
      if (isTxNotServed(e)) {
        log(`FAIL  ${t.tx_hash}: this RPC no longer serves the transaction (${String(e.message).slice(0, 100)})`);
        log(`ABORT  ${active.url ?? 'the RPC'} does not keep old transactions (it is not archival). Re-run with an archival node: npm run verify:live-run -- --rpc ${ARCHIVAL_LIVE_RUN_RPC}`);
        return { mismatches: mismatches + 1, aborted: true, checked, usedFallback };
      }
      log(`FAIL  ${t.tx_hash}: ${String(e.message).slice(0, 120)}`);
      mismatches++;
      continue;
    }
    checked++;
    const diffs = diffRecord(t, fresh);
    if (diffs.length) { mismatches++; log(`FAIL  ${t.tx_hash} ${t.label}: ${diffs.join('; ')}`); }
  }
  return { mismatches, aborted: false, checked, usedFallback };
}
