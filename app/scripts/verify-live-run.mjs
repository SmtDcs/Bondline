#!/usr/bin/env node
// Usage: node app/scripts/verify-live-run.mjs [file] [--offline] [--rpc <url>]
// Replays fixtures/runs/v2-live-run.json: checks its structure, then (unless --offline) re-reads EVERY recorded
// transaction from the testnet RPC and compares success/failure, error, returned value, logs and gas burnt.
// Needs no key. Behind an HTTP proxy set NODE_USE_ENV_PROXY=1.
import fs from 'node:fs';
import { makeProvider } from '../lib/near.mjs';
import { fetchTxRecord } from '../lib/live-tx.mjs';
import { checkLiveRunStructure, diffRecord } from '../lib/live-run-check.mjs';

const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--rpc') ?? 'fixtures/runs/v2-live-run.json';
const offline = argv.includes('--offline');
const rpc = argv[argv.indexOf('--rpc') + 1] ?? 'https://rpc.testnet.fastnear.com';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const problems = checkLiveRunStructure(data);
for (const p of problems) console.log(`FAIL  ${p}`);
console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'}  structure: ${data.txs.length} txs (${data.txs.filter(t => !t.ok).length} recorded as failures), ${data.checks.length} checks`);
let mismatches = 0;
if (!offline) {
  const provider = makeProvider(rpc);
  for (const t of data.txs) {
    let fresh;
    try { fresh = await fetchTxRecord(provider, t.tx_hash, t.signer); } catch (e) { console.log(`FAIL  ${t.tx_hash}: ${e.message.slice(0, 120)}`); mismatches++; continue; }
    const diffs = diffRecord(t, fresh);
    if (diffs.length) { mismatches++; console.log(`FAIL  ${t.tx_hash} ${t.label}: ${diffs.join('; ')}`); }
  }
  console.log(`${mismatches === 0 ? 'PASS' : 'FAIL'}  replay: ${data.txs.length - mismatches}/${data.txs.length} transactions match the chain`);
}
const ok = problems.length === 0 && mismatches === 0;
console.log(ok ? (offline ? 'LIVE RUN WELL FORMED (offline: the chain was not read)' : 'LIVE RUN REPLAYED') : 'LIVE RUN NOT VERIFIED');
process.exit(ok ? 0 : 1);
