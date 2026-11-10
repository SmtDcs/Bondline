// T22 review: `npm run verify` must report an unreachable testnet RPC as one FAIL row
// (exit 1, `NOT VERIFIED`), not crash with a raw `TypeError: fetch failed` stack trace.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.resolve('app/verify.mjs');
const BUNDLE = path.resolve('fixtures/live/a123.json');

function run(extra) {
  // RFC 6761 reserves .invalid: DNS resolution fails without any real network, like the
  // judge's ENOTFOUND, while the off-chain checks run locally.
  const res = spawnSync(process.execPath, [SCRIPT, BUNDLE, ...extra], { encoding: 'utf8' });
  if (res.error) throw res.error;
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

test('an unreachable testnet RPC is one FAIL row and exit 1, not a stack trace', () => {
  const r = run(['--rpc', 'http://rpc.invalid']);
  assert.equal(r.status, 1, r.out);
  assert.equal(r.out.trimEnd().split('\n').at(-1), 'NOT VERIFIED');
  assert.match(r.out, /^FAIL\s+testnet RPC unreachable\s+fetch failed/m);
  assert.match(r.out, /^PASS\s+sha256\(response bytes\)/m, 'off-chain rows are still reported');
  assert.doesNotMatch(r.out, /^\s+at /m, 'no raw stack trace');
});

test('--offline is the documented fallback: off-chain checks still verify', () => {
  const r = run(['--offline']);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.trimEnd().split('\n').at(-1), 'VERIFIED');
});
