// docs/STABLECOIN.md 12/14: `npm run verify` against a v2 contract: version detection, the required
// merchant argument, the token/amount lines and the allowed-token check. v1 behaviour stays as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { sha256Hex } from '../lib/nearai.mjs';

const SCRIPT = path.resolve('app/verify.mjs');
const REAL = JSON.parse(fs.readFileSync('fixtures/live/a123.json', 'utf8'));
const ATT_FILE = fs.readdirSync('fixtures/attestation').find(f => f.endsWith('.json'));
const ATT_SHA = sha256Hex(fs.readFileSync(path.join('fixtures/attestation', ATT_FILE)));
const MERCHANT = 'cbp-shop-sm1110.testnet';
const TOKEN = 'tusdc.testnet';

const cleanEnv = () => { const e = { ...process.env }; delete e.CONTRACT_ID; delete e.NEAR_RPC_URL; delete e.MERCHANT_ID; return e; };
const lastLine = (out) => out.trimEnd().split('\n').at(-1);

function tmpBundle(t) {
  const dir = fs.mkdtempSync(path.join('app/test', '.verify-v2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bundle.json');
  fs.writeFileSync(file, JSON.stringify(REAL));
  return file;
}

async function stubV2(t, { marketRegistered = true } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const params = JSON.parse(body).params;
      calls.push({ account: params.account_id, method: params.method_name, args: JSON.parse(Buffer.from(params.args_base64, 'base64').toString('utf8')) });
      const value = {
        get_config: { api: 2, owner: 'v2.cbp-sm1110.testnet', allowed_tokens: [TOKEN], min_order_ttl_ms: '120000' },
        get_signer: { kind: 'provider_tee', model_id: REAL.model, attestation_sha256: ATT_SHA, added_at_ms: '1', expires_at_ms: String(Date.now() + 86_400_000) },
        get_receipt: { order_id: REAL.order_id, merchant: MERCHANT, token: TOKEN, order_amount: '20000000', block_height: 1 },
        storage_balance_of: marketRegistered ? { total: '1250000000000000000000', available: '1250000000000000000000' } : null,
        preview_claim: { ok: true, token_bps: 2000, paid_bps: 2000, payout: '4000000', token: TOKEN },
      }[params.method_name];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

const runAsync = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SCRIPT, ...args], { env: cleanEnv() });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('close', status => resolve({ status, out }));
});

test('a v2 contract is checked with merchant and prints the token and raw amount', async (t) => {
  const rpc = await stubV2(t);
  const r = await runAsync([tmpBundle(t), '--rpc', rpc.url, '--contract', 'v2.cbp-sm1110.testnet', '--merchant', MERCHANT]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^token tusdc\.testnet  order_amount 20000000 \(raw units\)$/m);
  assert.match(r.out, /^PASS  market is registered on tusdc\.testnet \(storage_balance_of\)  registered$/m);
  assert.match(r.out, /^PASS  receipt token is in get_config\(\)\.allowed_tokens  tusdc\.testnet/m);
  assert.equal(lastLine(r.out), 'VERIFIED');
  const receipt = rpc.calls.find(c => c.method === 'get_receipt');
  assert.deepEqual(receipt.args, { merchant: MERCHANT, response_hash: REAL.response_hash });
  const preview = rpc.calls.find(c => c.method === 'preview_claim');
  assert.deepEqual(preview.args, { merchant: MERCHANT, order_id: REAL.order_id, response_b64: REAL.response_b64 });
  assert.ok(rpc.calls.filter(c => c.method !== 'storage_balance_of').every(c => c.account === 'v2.cbp-sm1110.testnet'));
  assert.ok(rpc.calls.filter(c => c.method === 'storage_balance_of').every(c => c.account === TOKEN));
});

test('a v2 contract without a merchant is NOT VERIFIED and says how to pass it', async (t) => {
  const rpc = await stubV2(t);
  const r = await runAsync([tmpBundle(t), '--rpc', rpc.url, '--contract', 'v2.cbp-sm1110.testnet']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /pass --merchant <id> or set MERCHANT_ID/);
  assert.equal(lastLine(r.out), 'NOT VERIFIED');
  assert.ok(!rpc.calls.some(c => c.method === 'get_receipt'), 'no receipt lookup without a merchant');
});


test('a market that is not registered on the token is NOT VERIFIED', async (t) => {
  const rpc = await stubV2(t, { marketRegistered: false });
  const r = await runAsync([tmpBundle(t), '--rpc', rpc.url, '--contract', 'v2.cbp-sm1110.testnet', '--merchant', MERCHANT]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^FAIL  market is registered on tusdc\.testnet \(storage_balance_of\)  null: deposit storage on the token/m);
  assert.equal(lastLine(r.out), 'NOT VERIFIED');
});
