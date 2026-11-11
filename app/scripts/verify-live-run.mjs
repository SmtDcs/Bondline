#!/usr/bin/env node
// Usage: node app/scripts/verify-live-run.mjs [file] [--offline] [--rpc <url>]
// Replays fixtures/runs/v2-live-run.json: checks its structure, then (unless --offline) re-reads EVERY recorded
// transaction from the testnet RPC and compares success/failure, error, returned value, logs and gas burnt.
// The default RPC is the ordinary public one; non-archival nodes drop old transaction outcomes after a few epochs, so a
// transaction it no longer serves is read (with every later one) from the archival RPC. With an explicit --rpc there
// is no fallback: if that RPC no longer serves a transaction the run stops at once with a message naming --rpc. Needs no key. Behind an HTTP proxy set NODE_USE_ENV_PROXY=1.
import fs from 'node:fs';
import { makeProvider } from '../lib/near.mjs';
import { checkLiveRunStructure } from '../lib/live-run-check.mjs';
import { replayLiveRun, DEFAULT_LIVE_RUN_RPC, ARCHIVAL_LIVE_RUN_RPC } from '../lib/live-run-replay.mjs';
import { positionalArgs, flagValue } from '../lib/cli-args.mjs';

const argv = process.argv.slice(2);
const file = positionalArgs(argv, ['--rpc'])[0] ?? 'fixtures/runs/v2-live-run.json';
const offline = argv.includes('--offline');
const rpcFlag = flagValue(argv, '--rpc');
const rpc = rpcFlag ?? DEFAULT_LIVE_RUN_RPC;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const problems = checkLiveRunStructure(data);
for (const p of problems) console.log(`FAIL  ${p}`);
console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'}  structure: ${data.txs.length} txs (${data.txs.filter(t => !t.ok).length} recorded as failures), ${data.checks.length} checks`);
let mismatches = 0;
if (!offline) {
  const provider = makeProvider(rpc);
  // No --rpc: the ordinary RPC first, the archival one only for what the ordinary one no longer serves.
  const fallback = rpcFlag ? null : { provider: makeProvider(ARCHIVAL_LIVE_RUN_RPC), url: ARCHIVAL_LIVE_RUN_RPC };
  const run = await replayLiveRun(provider, data.txs, { rpcUrl: rpc, fallback, paceMs: 100 });
  mismatches = run.mismatches;
  if (run.aborted) console.log(`FAIL  replay: stopped after ${run.checked} of ${data.txs.length} transactions (see ABORT above)`);
  else console.log(`${mismatches === 0 ? 'PASS' : 'FAIL'}  replay: ${data.txs.length - mismatches}/${data.txs.length} transactions match the chain`);
}
const ok = problems.length === 0 && mismatches === 0;
console.log(ok ? (offline ? 'LIVE RUN WELL FORMED (offline: the chain was not read)' : 'LIVE RUN REPLAYED') : 'LIVE RUN NOT VERIFIED');
process.exit(ok ? 0 : 1);
