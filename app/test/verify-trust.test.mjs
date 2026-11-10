// Audit tee-proof-1 / tee-proof-3: verify.mjs pins the contract (never the bundle's own claim),
// ties the signer to an attestation record, and never prints plain VERIFIED for SIMULATED bundles.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { sha256Hex } from '../lib/nearai.mjs';
import { loadAttestations, signerRows, resolveContract, PINNED_CONTRACT, PINNED_V1_CONTRACT, KNOWN_CONTRACTS } from '../lib/attestation.mjs';

const SCRIPT = path.resolve('app/verify.mjs');
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const REAL = load('fixtures/live/a123.json');
const ATT_FILE = fs.readdirSync('fixtures/attestation').find(f => f.endsWith('.json'));
const ATT_SHA = sha256Hex(fs.readFileSync(path.join('fixtures/attestation', ATT_FILE)));
const cleanEnv = () => { const e = { ...process.env }; delete e.CONTRACT_ID; delete e.NEAR_RPC_URL; return e; };
const lastLine = (out) => out.trimEnd().split('\n').at(-1);

function tmpBundle(t, bundle) {
  const dir = fs.mkdtempSync(path.join('app/test', '.verify-trust-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bundle.json');
  fs.writeFileSync(file, JSON.stringify(bundle));
  return file;
}

/** A stub testnet RPC: answers get_signer/get_receipt/preview_claim and records which account was asked. */
async function stubRpc(t, { signer }) {
  const asked = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const p = JSON.parse(body).params;
      asked.push(p.account_id);
      const value = p.method_name === 'get_signer' ? signer
        : p.method_name === 'get_receipt' ? { order_id: REAL.order_id, block_height: 1 }
          : { ok: true, token_bps: 2000, paid_bps: 2000, payout: '1' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, asked };
}

const runAsync = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SCRIPT, ...args], { env: cleanEnv() });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('close', status => resolve({ status, out }));
});

const goodSigner = (extra = {}) => ({
  kind: 'provider_tee', model_id: REAL.model, attestation_sha256: ATT_SHA,
  added_at_ms: '1', expires_at_ms: String(Date.now() + 86_400_000), ...extra,
});

test('resolveContract: flag, then CONTRACT_ID, then a bundle naming a known repo contract, then the pinned v2', () => {
  assert.equal(PINNED_CONTRACT, 'v2.cbp-sm1110.testnet');
  assert.equal(PINNED_V1_CONTRACT, 'cbp-sm1110.testnet');
  assert.deepEqual(KNOWN_CONTRACTS, ['cbp-sm1110.testnet', 'v2.cbp-sm1110.testnet']);
  assert.equal(resolveContract(undefined, {}), 'v2.cbp-sm1110.testnet');
  assert.equal(resolveContract(undefined, { CONTRACT_ID: 'mine.testnet' }), 'mine.testnet');
  assert.equal(resolveContract('flag.testnet', { CONTRACT_ID: 'mine.testnet' }), 'flag.testnet');
  // The v1 fixtures name the v1 contract: they keep verifying against it without any flag.
  assert.equal(resolveContract(undefined, {}, 'cbp-sm1110.testnet'), 'cbp-sm1110.testnet');
  assert.equal(resolveContract(undefined, {}, 'v2.cbp-sm1110.testnet'), 'v2.cbp-sm1110.testnet');
  // An unknown name in a bundle selects nothing; a flag or CONTRACT_ID still beats a known bundle name.
  assert.equal(resolveContract(undefined, {}, 'evil-copy.testnet'), 'v2.cbp-sm1110.testnet');
  assert.equal(resolveContract('flag.testnet', {}, 'cbp-sm1110.testnet'), 'flag.testnet');
  assert.equal(resolveContract(undefined, { CONTRACT_ID: 'mine.testnet' }, 'cbp-sm1110.testnet'), 'mine.testnet');
});

test('a bundle that names the v1 repo contract is checked against v1 (history keeps verifying)', async (t) => {
  const rpc = await stubRpc(t, { signer: goodSigner() });
  const r = await runAsync([tmpBundle(t, { ...REAL, chain: { ...REAL.chain, contract: 'cbp-sm1110.testnet' } }), '--rpc', rpc.url]);
  assert.deepEqual([...new Set(rpc.asked)], ['cbp-sm1110.testnet']);
  assert.doesNotMatch(r.out, /^WARN/m);
});

test('a forged bundle naming the forger\'s own contract is checked against the pinned contract, with a warning', async (t) => {
  const forged = { ...REAL, chain: { ...REAL.chain, contract: 'evil-copy.testnet' } };
  const rpc = await stubRpc(t, { signer: goodSigner() });
  const r = await runAsync([tmpBundle(t, forged), '--rpc', rpc.url]);
  assert.deepEqual([...new Set(rpc.asked)], [PINNED_CONTRACT], 'every view went to the pinned contract');
  assert.match(r.out, /^WARN\s+bundle\.chain\.contract is evil-copy\.testnet but this check uses v2\.cbp-sm1110\.testnet/m);
  assert.equal(r.status, 0, r.out);
  assert.equal(lastLine(r.out), 'VERIFIED');
});

test('--contract overrides the pin explicitly', async (t) => {
  const rpc = await stubRpc(t, { signer: goodSigner() });
  await runAsync([tmpBundle(t, REAL), '--rpc', rpc.url, '--contract', 'other.testnet']);
  assert.deepEqual([...new Set(rpc.asked)], ['other.testnet']);
});

test('a signer added by an owner with an unrelated attestation hash is NOT VERIFIED', async (t) => {
  const rpc = await stubRpc(t, { signer: goodSigner({ attestation_sha256: 'ab'.repeat(32) }) });
  const r = await runAsync([tmpBundle(t, REAL), '--rpc', rpc.url]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^FAIL\s+signer attestation_sha256 is a repo attestation record listing this key/m);
  assert.equal(lastLine(r.out), 'NOT VERIFIED');
});

test('signerRows rejects a non-TEE kind, another model and an expired signer', () => {
  const records = loadAttestations();
  const now = Date.now();
  const failing = (signer) => signerRows(signer, REAL, records, now).filter(r => !r.ok).map(r => r.check);
  assert.deepEqual(failing(goodSigner()), []);
  assert.deepEqual(failing(goodSigner({ kind: 'gateway', model_id: null })), ['signer kind is provider_tee', 'signer model_id == bundle.model']);
  assert.deepEqual(failing(goodSigner({ model_id: 'other/model' })), ['signer model_id == bundle.model']);
  assert.deepEqual(failing(goodSigner({ expires_at_ms: String(now - 1) })), ['signer not expired']);
  assert.deepEqual(failing(null), ['signer registered in contract (get_signer)']);
});

test('--offline: a SIMULATED bundle ends in SIMULATED, never plain VERIFIED', () => {
  const res = spawnSync(process.execPath, [SCRIPT, 'fixtures/simulated/injection.json', '--offline'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(res.status, 0, res.stdout);
  assert.match(res.stdout, /^SIMULATED /m);
  assert.equal(lastLine(res.stdout), 'SIMULATED (fake key, proves nothing about a TEE)');
  assert.doesNotMatch(res.stdout, /^VERIFIED$/m);
});

test('--offline: a self-consistent real-looking bundle with an unattested key is NOT VERIFIED', (t) => {
  // Same shape as a real bundle, signed by a throwaway key that no attestation record lists.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const text = REAL.signature.text;
  const forged = {
    ...REAL, simulated: false,
    signature: { ...REAL.signature, signing_address: raw.toString('hex'), signature: crypto.sign(null, Buffer.from(text), privateKey).toString('hex') },
  };
  const res = spawnSync(process.execPath, [SCRIPT, tmpBundle(t, forged), '--offline'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /^PASS\s+ed25519 signature valid/m, 'self-consistent');
  assert.match(res.stdout, /^FAIL\s+signing_address is a verified signer in fixtures\/attestation/m);
  assert.equal(lastLine(res.stdout), 'NOT VERIFIED');
});

test('--offline: the genuine recorded bundle still VERIFIES', () => {
  const res = spawnSync(process.execPath, [SCRIPT, 'fixtures/live/a123.json', '--offline'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(res.status, 0, res.stdout);
  assert.equal(lastLine(res.stdout), 'VERIFIED');
});
