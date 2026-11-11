// Final audit, group "client": client-1, 2, 4, 5, 6, 8, 9, 10 (client-3 is app/test/replay-server-reload.test.mjs).
// Every test here fails without its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { buildLiveConfig } from '../lib/live-config.mjs';
import { signerRows, loadAttestations } from '../lib/attestation.mjs';
import { markComputedViews, chatTimePreview } from '../lib/transcript.mjs';
import { positionalArgs, flagValue } from '../lib/cli-args.mjs';
import { replayLiveRun, DEFAULT_LIVE_RUN_RPC, ARCHIVAL_LIVE_RUN_RPC } from '../lib/live-run-replay.mjs';
import { isTxNotServed } from '../lib/live-tx.mjs';
import { makeReplay } from '../lib/replay.mjs';
import { sha256Hex } from '../lib/nearai.mjs';

globalThis.location = new URL('http://127.0.0.1:8787/');
const app = await import('../../web/app.js?audit-client');
app.BINDING_RETRY.delayMs = 1;

const TOKEN = { id: 'tusdc.testnet', symbol: 'tUSDC', decimals: 6 };
const MERCHANT = 'cbp-shop-sm1110.testnet';
const BUYER = 'cbp-alice-sm1110.testnet';

// ---------- shared page harness (same shape as web-stablecoin.test.mjs) ----------
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const rpcResponse = (value) => jsonResponse({ jsonrpc: '2.0', id: 'cbp', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } });
const decodeMethod = (call) => JSON.parse(call.opts.body).params.method_name;
function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { const call = { url: String(url), opts }; calls.push(call); return handler(call); };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.fetch = real; });
}
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(), className: '', value: '', href: '', target: '', rel: '', disabled: false,
    scrollTop: 0, scrollHeight: 0, children: [], listeners: {}, _text: '',
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); this.children = []; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    remove() { this.removed = true; },
  };
}
function fakePage() {
  const ids = ['mode-badge', 'contract-link', 'order-select', 'chat-log', 'chat-input', 'chat-form',
    'merchant-log', 'bond-meter', 'btn-register-edited', 'deny-box', 'footer'];
  const els = Object.fromEntries(ids.map(id => [id, makeEl(id)]));
  globalThis.document = { getElementById: id => els[id] ?? null, createElement: tag => makeEl(tag), body: makeEl('body') };
  return els;
}
const REPLY = 'Sorry about the mug.\nPROMISE|refund|order=A123-11|bps=2000';
const BUNDLE = {
  type: 'bot-promises/receipt-bundle/v1', simulated: false, order_id: 'A123-11',
  response_b64: Buffer.from(JSON.stringify({ choices: [{ message: { content: REPLY } }] }), 'utf8').toString('base64'),
};
const BASE_CONFIG = {
  mode: 'live', network: 'testnet', rpcUrl: 'https://rpc.testnet.fastnear.com',
  contractId: 'v2.cbp-sm1110.testnet', merchantId: MERCHANT, buyerId: BUYER,
  model: 'z-ai/glm-5.3-flash', contract_api: 2, tokens: [TOKEN],
  // client-1: the startup snapshot has NO token for this order (its get_order failed at server start)
  orders: [{ order_id: 'A123-11', label: 'Broken mug', token: null, amount: null, expires_at_ms: null }],
};
const settle = async (els) => { for (let i = 0; i < 200 && els['order-select'].children.length === 0; i++) await new Promise(r => setTimeout(r, 0)); };

// ---------- client-1 ----------
test('client-1: the page takes the asset from the chain answer: a tUSDC promise with a token-less config shows 4 tUSDC, not 0.000 NEAR', async () => {
  const els = fakePage();
  await withFetch((call) => {
    if (call.url === '/api/config') return jsonResponse(BASE_CONFIG);
    if (call.url === '/api/chat') return jsonResponse({ reply: REPLY, bundle: BUNDLE, register_tx: 'reg1' });
    if (call.url === '/api/demo/claim') return jsonResponse({ ok: true, result: { ok: true, payout: '4000000', token: TOKEN.id }, claim_tx: 'c1', explorer: 'https://x/c1' });
    const method = decodeMethod(call);
    if (method === 'get_merchant') return rpcResponse({ bond: '1', reserved: '0', paid_out: '0' });
    if (method === 'get_bonds') return rpcResponse([]);
    if (method === 'get_receipt') return rpcResponse({ order_id: 'A123-11', token: TOKEN.id });
    if (method === 'preview_claim') return rpcResponse({ ok: true, token_bps: 2000, paid_bps: 2000, payout: '4000000', token: TOKEN.id });
    if (method === 'storage_balance_of') return rpcResponse({ total: '1', available: '1' });
    throw new Error(`unexpected ${method}`);
  }, async () => {
    try {
      await import('../../web/app.js?audit-client-1');
      await settle(els);
      els['chat-input'].value = 'my mug broke';
      await els['chat-form'].listeners.submit({ preventDefault() {} });
      const bot = els['chat-log'].children[1];
      assert.equal(bot.statusBadge.textContent, 'BINDING · claimable 4 tUSDC');
      assert.ok(bot.claimButton);
      await bot.claimButton.listeners.click();
      assert.equal(bot.statusBadge.textContent, 'CLAIMED · paid 4 tUSDC');
      assert.ok(!/NEAR/.test(bot.statusBadge.textContent));
    } finally { delete globalThis.document; }
  });
});

test('client-1: an amount in a token with no metadata is never rendered as NEAR; the chain answer wins over the page guess', async () => {
  assert.equal(app.formatAsset('4000000', 'other.testnet', [TOKEN]), '4000000 raw units of other.testnet (no token metadata)');
  assert.equal(app.formatAsset('400000000000000000000000', null, [TOKEN]), '0.400 NEAR');
  assert.equal(app.chainToken({ ok: true, token: 'x.testnet' }, null), 'x.testnet');
  assert.equal(app.chainToken({ ok: true, token: null }, 'x.testnet'), null, 'null = NEAR on a v2 answer');
  assert.equal(app.chainToken({ ok: true }, 'x.testnet'), 'x.testnet', 'no token field (v1): the fallback');
  await withFetch(() => jsonResponse(BASE_CONFIG), () => app.loadConfig());
  const preview = { ok: true, token_bps: 2000, paid_bps: 2000, payout: '4000000', token: TOKEN.id };
  assert.equal(app.badgeText({ receipt: { token: TOKEN.id }, preview, tokenId: null }).text, 'BINDING · claimable 4 tUSDC');
  const unknown = { ...preview, token: 'other.testnet' };
  assert.equal(app.badgeText({ receipt: {}, preview: unknown, tokenId: null }).text, 'BINDING · claimable 4000000 raw units of other.testnet (no token metadata)');
});

const v2Provider = (getOrder) => ({
  callFunction: async ({ method, args }) => {
    if (method === 'get_config') return { api: 2, allowed_tokens: [TOKEN.id] };
    if (method === 'ft_metadata') return { symbol: 'tUSDC', decimals: 6 };
    if (method === 'storage_balance_of') return { total: '1' };
    if (method === 'get_order') return getOrder(args);
    throw new Error(method);
  },
});
const liveCfg = (orders) => ({ contractId: 'v2.cbp-sm1110.testnet', merchantId: MERCHANT, buyerId: BUYER, orders });
const NO_WAIT = { tries: 3, delayMs: 0 };

test('client-1: startup retries get_order and DROPS an order whose view keeps failing or does not exist, instead of keeping it token-less', async () => {
  const logs = [];
  let calls = 0;
  const failing = v2Provider(() => { calls++; throw new Error('fetch failed'); });
  const out = await buildLiveConfig(liveCfg([{ order_id: 'A1' }]), failing, (m) => logs.push(m), NO_WAIT);
  assert.deepEqual(out.orders, []);
  assert.equal(calls, 3, 'retried');
  assert.match(logs.join('\n'), /A1 hidden: get_order failed/);

  const missing = await buildLiveConfig(liveCfg([{ order_id: 'A2' }]), v2Provider(() => null), (m) => logs.push(m), NO_WAIT);
  assert.deepEqual(missing.orders, []);
  assert.match(logs.join('\n'), /A2 hidden: it is not registered/);
});

test('client-1: a get_order that fails once and then answers keeps the order WITH its token', async () => {
  let n = 0;
  const flaky = v2Provider(() => { if (n++ === 0) throw new Error('fetch failed'); return { token: TOKEN.id, amount: '20000000', expires_at_ms: '99' }; });
  const out = await buildLiveConfig(liveCfg([{ order_id: 'A1' }]), flaky, () => {}, NO_WAIT);
  assert.equal(out.orders.length, 1);
  assert.equal(out.orders[0].token, TOKEN.id);
  assert.equal(out.orders[0].amount, '20000000');
});

// ---------- client-2 ----------
test('client-2: markComputedViews marks exactly the recomputed views and gives a v2 preview its token', () => {
  const t = {
    type: 'bot-promises/replay/v2', contract_api: 2,
    steps: [
      { kind: 'chat', order_id: 'A', views: { get_order: { token: TOKEN.id }, preview_claim: { ok: true, payout: '1' }, get_merchant: { bond: '1' }, tamper: { preview_claim: { ok: false, error: 'ERR_NO_RECEIPT_FOR_BYTES', payout: '0' } } } },
      { kind: 'chat', order_id: 'B', views: { get_order: { token: TOKEN.id }, preview_claim: { ok: true, payout: '2' }, get_merchant: { bond: '2' } } },
    ],
  };
  const m = markComputedViews(t);
  assert.equal(m.computed_views, true);
  const [a, b] = m.steps;
  assert.deepEqual(a.views.preview_claim, { ok: true, payout: '1', computed: true, token: TOKEN.id });
  assert.equal(a.views.tamper.preview_claim.computed, true);
  assert.equal(a.views.get_merchant.computed, true, 'the first step meter is arithmetic');
  assert.equal(b.views.get_merchant.computed, undefined, 'the last step meter is the live post-run view');
  assert.equal(t.steps[0].views.preview_claim.computed, undefined, 'the input is not mutated');
  assert.deepEqual(markComputedViews(m), m, 'idempotent');
});

test('client-2: the committed transcripts say which views were computed, and the replay badge says so', () => {
  for (const f of ['transcript.json', 'transcript-v2.json', 'transcript-v2-near.json']) {
    const t = JSON.parse(fs.readFileSync(path.join('fixtures/replay', f), 'utf8'));
    assert.equal(t.computed_views, true, f);
    for (const s of t.steps.filter(x => x.kind === 'chat')) {
      assert.equal(s.views.preview_claim.computed, true, `${f} ${s.order_id} preview`);
      assert.equal(s.views.tamper.preview_claim.computed, true, `${f} ${s.order_id} tamper`);
      if (t.contract_api === 2) assert.ok('token' in s.views.preview_claim, `${f}: a v2 preview carries token`);
    }
    assert.equal(t.steps.find(x => x.kind === 'chat').views.get_merchant.computed, true);
    assert.match(app.replayBadgeText(t), /recomputed/);
  }
  assert.equal(app.replayBadgeText({ recorded_at: '2026-11-10T10:00:00Z' }), 'REPLAY of a real testnet run recorded 2026-11-10', 'unmarked transcripts keep the old text');
});

test('client-2: chatTimePreview echoes the v2 order token (null = NEAR) and stays token-free for v1', () => {
  const bytes = Buffer.from(JSON.stringify({ choices: [{ message: { content: 'ok\nPROMISE|refund|order=A1|bps=2000' } }] })).toString('base64');
  const hash = sha256Hex(Buffer.from(bytes, 'base64'));
  const receipt = { order_id: 'A1', response_hash: hash };
  assert.equal(chatTimePreview({ order_id: 'A1', amount: '20000000', max_bps: 3000, token: TOKEN.id }, bytes, receipt).token, TOKEN.id);
  assert.equal(chatTimePreview({ order_id: 'A1', amount: '20000000', max_bps: 3000, token: null }, bytes, receipt).token, null);
  assert.ok(!('token' in chatTimePreview({ order_id: 'A1', amount: '20000000', max_bps: 3000 }, bytes, receipt)));
});

test('client-2: the offline v2 replay does not count the recorded (long past) expiry against today: no EXPIRED on a recorded BINDING badge', async () => {
  const replay = makeReplay('fixtures/replay/transcript-v2.json');
  const order = replay.publicConfig.orders[0];
  assert.ok(Number(order.expires_at_ms) < Date.now(), 'the recorded expiry is in the past');
  const real = globalThis.location;
  globalThis.location = new URL('http://127.0.0.1:8787/?offline=1');
  const els = fakePage();
  try {
    await withFetch(async (call) => {
      if (call.url === '/api/config') return jsonResponse(replay.publicConfig);
      if (call.url.startsWith('/fixtures/replay/')) return jsonResponse(JSON.parse(fs.readFileSync('fixtures/replay/transcript-v2.json', 'utf8')));
      if (call.url === '/api/chat') return jsonResponse(await replay.handlers.handleChat({ order_id: order.order_id }));
      throw new Error(`unexpected ${call.url}`);
    }, async () => {
      await import('../../web/app.js?audit-client-offline');
      await settle(els);
      els['chat-input'].value = 'x';
      await els['chat-form'].listeners.submit({ preventDefault() {} });
      const bot = els['chat-log'].children.find(c => c.statusBadge);
      assert.match(bot.statusBadge.textContent, /^BINDING · claimable 4 tUSDC$/);
      assert.ok(!/EXPIRED/.test(bot.statusBadge.textContent));
    });
  } finally { globalThis.location = real; delete globalThis.document; }
});

// ---------- client-4 ----------
const REAL = JSON.parse(fs.readFileSync('fixtures/live/a123.json', 'utf8'));
test('client-4: a signer that expired AFTER the receipt was registered still verifies that receipt', () => {
  const records = loadAttestations();
  const rec = records.find(r => r.signers.has(REAL.signature.signing_address.toLowerCase()));
  const signer = { kind: 'provider_tee', model_id: REAL.model, attestation_sha256: rec.sha256, expires_at_ms: '1796035518568' };
  const afterExpiry = 1796035518568 + 86_400_000;
  const registered = { registered_at_ms: '1794307600000' };
  const failing = (rows) => rows.filter(r => !r.ok).map(r => r.check);
  assert.deepEqual(failing(signerRows(signer, REAL, records, afterExpiry, registered)), [], 'valid when the receipt was registered');
  const info = signerRows(signer, REAL, records, afterExpiry, registered).find(r => /informational/.test(r.check));
  assert.ok(info && info.ok && /expired now/.test(info.detail));
  // a receipt registered after the expiry cannot exist on chain, but if it were, it must fail
  assert.deepEqual(failing(signerRows(signer, REAL, records, afterExpiry, { registered_at_ms: String(afterExpiry) })), ['signer valid when the receipt was registered']);
  // without a receipt the old rule (today's clock) still applies
  assert.deepEqual(failing(signerRows(signer, REAL, records, afterExpiry)), ['signer not expired']);
});

test('client-4: `npm run verify` is VERIFIED after the signer expiry when the receipt predates it (stub RPC)', async (t) => {
  const records = loadAttestations();
  const rec = records.find(r => r.signers.has(REAL.signature.signing_address.toLowerCase()));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const m = JSON.parse(body).params.method_name;
      const value = {
        get_config: null,
        get_signer: { kind: 'provider_tee', model_id: REAL.model, attestation_sha256: rec.sha256, added_at_ms: '1', expires_at_ms: String(Date.now() - 86_400_000) },
        get_receipt: { order_id: REAL.order_id, block_height: 1, registered_at_ms: String(Date.now() - 2 * 86_400_000) },
        preview_claim: { ok: false, error: 'ERR_ALREADY_CLAIMED' },
      }[m];
      res.setHeader('content-type', 'application/json');
      // detectApi: get_config MethodNotFound => v1
      if (m === 'get_config') { res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { error: 'wasm execution failed: MethodNotFound', logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' } })); return; }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const env = { ...process.env }; delete env.CONTRACT_ID; delete env.NEAR_RPC_URL; delete env.MERCHANT_ID;
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve('app/verify.mjs'), 'fixtures/live/a123.json', '--rpc', `http://127.0.0.1:${server.address().port}`], { env });
    let o = ''; child.stdout.on('data', d => { o += d; }); child.stderr.on('data', d => { o += d; });
    child.on('close', status => resolve({ status, out: o }));
  });
  assert.equal(out.status, 0, out.out);
  assert.match(out.out, /^PASS  signer valid when the receipt was registered/m);
  assert.match(out.out, /^PASS  signer current expiry \(informational\).*expired now/m);
  assert.equal(out.out.trimEnd().split('\n').at(-1), 'VERIFIED');
});

// ---------- client-5 ----------
test('client-5: the live-run script falls back to an archival RPC when no --rpc is given', () => {
  assert.match(ARCHIVAL_LIVE_RUN_RPC, /archival/);
  assert.doesNotMatch(DEFAULT_LIVE_RUN_RPC, /archival/, 'the archival node rate-limits a burst of 81 reads: fallback only');
  const src = fs.readFileSync('app/scripts/verify-live-run.mjs', 'utf8');
  assert.match(src, /ARCHIVAL_LIVE_RUN_RPC/);
});

test('client-5: when the default RPC stops serving a tx, that tx and the rest are read from the archival fallback', async () => {
  const txs = Array.from({ length: 5 }, (_, i) => ({ tx_hash: `H${i}`, signer: 's', label: `l${i}` }));
  const gone = Object.assign(new Error("Transaction doesn't exist"), { type: 'UNKNOWN_TRANSACTION' });
  const seen = [];
  const lines = [];
  const primary = { name: 'primary' }, archival = { name: 'archival' };
  const res = await replayLiveRun(primary, txs, {
    rpcUrl: 'https://primary', fallback: { provider: archival, url: 'https://archival' }, log: (l) => lines.push(l),
    fetchRecord: async (p, hash) => { seen.push(`${p.name}:${hash}`); if (p === primary && hash >= 'H2') throw gone; return { tx_hash: hash, ok: true, error: null, value: null, gas_burnt_total: '1', logs: [], receipts: [] }; },
  });
  assert.equal(res.usedFallback, true);
  assert.deepEqual(seen, ['primary:H0', 'primary:H1', 'primary:H2', 'archival:H2', 'archival:H3', 'archival:H4']);
  assert.ok(lines.some(l => /^NOTE .*reading it and the rest from https:\/\/archival/.test(l)));
  assert.equal(res.aborted, false);
});

test('client-5: a transaction the RPC no longer serves stops the run at once with one clear --rpc message', async () => {
  const txs = Array.from({ length: 81 }, (_, i) => ({ tx_hash: `H${i}`, signer: 'a.testnet', label: `l${i}` }));
  const lines = [];
  let fetches = 0;
  const gone = Object.assign(new Error('Transaction H0 doesn\'t exist'), { type: 'UNKNOWN_TRANSACTION' });
  const res = await replayLiveRun({}, txs, { rpcUrl: 'https://rpc.example', log: (l) => lines.push(l), fetchRecord: async () => { fetches++; throw gone; }, paceMs: 0 });
  assert.equal(fetches, 1, 'not 81 x retries');
  assert.equal(res.aborted, true);
  assert.equal(lines.filter(l => l.startsWith('FAIL')).length, 1);
  assert.match(lines.join('\n'), /ABORT .*does not keep old transactions.*--rpc https:\/\/archival/);
  assert.equal(isTxNotServed(gone), true);
  assert.equal(isTxNotServed(new Error('fetch failed')), false);
});

test('client-5: other errors are per-transaction FAILs and the run continues (no ABORT)', async () => {
  const txs = [{ tx_hash: 'A', signer: 's', label: 'a' }, { tx_hash: 'B', signer: 's', label: 'b' }];
  const lines = [];
  const res = await replayLiveRun({}, txs, { log: (l) => lines.push(l), fetchRecord: async () => { throw new Error('fetch failed'); }, paceMs: 0 });
  assert.equal(res.aborted, false);
  assert.equal(res.mismatches, 2);
  assert.ok(lines.some(l => /FAIL\s+A: fetch failed/.test(l)) && lines.some(l => /FAIL\s+B: fetch failed/.test(l)));
});

test('client-5: the script takes the first positional as the file and --rpc as the value (no --rpc: the default, not the file name)', () => {
  assert.deepEqual(positionalArgs(['fixtures/runs/x.json', '--rpc', 'http://r', '--offline'], ['--rpc']), ['fixtures/runs/x.json']);
  assert.deepEqual(positionalArgs(['--rpc', 'http://r', 'file.json'], ['--rpc']), ['file.json']);
  assert.equal(flagValue(['file.json'], '--rpc'), undefined);
  const res = spawnSync(process.execPath, ['app/scripts/verify-live-run.mjs', 'fixtures/runs/v2-live-run.json', '--offline'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /LIVE RUN WELL FORMED/);
});

// ---------- client-6 ----------
test('client-6: a flag value is never taken as the bundle path; flags may come before the file', () => {
  assert.deepEqual(positionalArgs(['--merchant', 'cbp-shop-sm1110.testnet', 'fixtures/live/a123-v2.json', '--offline'], ['--contract', '--rpc', '--merchant']), ['fixtures/live/a123-v2.json']);
  assert.equal(flagValue(['--merchant=abc', 'f.json'], '--merchant'), 'abc');
  const res = spawnSync(process.execPath, ['app/verify.mjs', '--merchant', 'cbp-shop-sm1110.testnet', 'fixtures/live/a123-v2.json', '--offline'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stdout.trimEnd().split('\n').at(-1), 'VERIFIED');
});

const runVerify = (args, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.resolve('app/verify.mjs'), ...args], { env });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('close', status => resolve({ status, out }));
});
const cleanEnv = () => { const e = { ...process.env }; delete e.CONTRACT_ID; delete e.NEAR_RPC_URL; delete e.MERCHANT_ID; return e; };
async function stubRpc(t, handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const m = JSON.parse(body).params.method_name;
      res.setHeader('content-type', 'application/json');
      const out = handler(m);
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: out.error ? { error: out.error, logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' } : { result: [...Buffer.from(JSON.stringify(out.value))], logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('client-6: a missing --merchant is its own row, not "testnet RPC unreachable"', async (t) => {
  const rpc = await stubRpc(t, (m) => ({ value: m === 'get_config' ? { api: 2, allowed_tokens: [] } : null }));
  const r = await runVerify(['fixtures/live/a123-v2.json', '--rpc', rpc, '--contract', 'v2.cbp-sm1110.testnet'], cleanEnv());
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^FAIL\s+merchant given \(a v2 contract keys receipts by merchant\)\s+pass --merchant <id> or set MERCHANT_ID/m);
  assert.doesNotMatch(r.out, /RPC unreachable/);
  assert.equal(r.out.trimEnd().split('\n').at(-1), 'NOT VERIFIED');
});

test('client-6: a contract error in the on-chain block is not blamed on the network', async (t) => {
  const rpc = await stubRpc(t, (m) => (m === 'get_config' ? { error: 'wasm execution failed: MethodNotFound' } : { error: 'wasm execution failed: Smart contract panicked: boom' }));
  const r = await runVerify(['fixtures/live/a123.json', '--rpc', rpc], cleanEnv());
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^FAIL\s+on-chain check failed\s+/m);
  assert.doesNotMatch(r.out, /RPC unreachable/);
});

// ---------- client-8 ----------
test('client-8: V2 ASSET=near does not abort on a merchant that already has its bond: it registers the orders', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client8-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  // a fake near-cli: get_merchant says the merchant exists; register_merchant / storage_deposit would FAIL (like the chain)
  fs.writeFileSync(path.join(dir, 'near'), `#!/bin/bash
echo "$*" >> "${log}"
case "$*" in
  *as-read-only*get_merchant*) echo '{"bond":"3000000000000000000000000","reserved":"0","paid_out":"0"}'; exit 0;;
  *register_merchant*|*storage_deposit*) echo ERR_MERCHANT_EXISTS >&2; exit 1;;
esac
exit 0
`, { mode: 0o755 });
  const res = spawnSync('/bin/bash', [path.resolve('app/scripts/demo-setup.sh')], {
    encoding: 'utf8', cwd: dir,
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME, V2: '1', ASSET: 'near', RUN: '77', CONTRACT_ID: 'v2.cbp-sm1110.testnet', MERCHANT_ID: MERCHANT, BUYER_ID: BUYER },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const calls = fs.readFileSync(log, 'utf8');
  assert.ok(!/register_merchant|storage_deposit/.test(calls), 'no second register_merchant / storage_deposit');
  assert.match(calls, /register_order .*A123-77/);
  assert.match(calls, /register_order .*A124-77/);
});

test('client-8: a merchant that is not registered yet still gets storage_deposit + register_merchant before the orders', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client8b-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'near'), `#!/bin/bash
echo "$*" >> "${log}"
case "$*" in
  *as-read-only*get_merchant*) echo 'null'; exit 0;;
esac
exit 0
`, { mode: 0o755 });
  const res = spawnSync('/bin/bash', [path.resolve('app/scripts/demo-setup.sh')], {
    encoding: 'utf8', cwd: dir,
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME, V2: '1', ASSET: 'near', RUN: '78', CONTRACT_ID: 'v2.cbp-sm1110.testnet', MERCHANT_ID: MERCHANT, BUYER_ID: BUYER },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const lines = fs.readFileSync(log, 'utf8').split('\n');
  const at = (re) => lines.findIndex(l => re.test(l));
  assert.ok(at(/storage_deposit/) >= 0 && at(/storage_deposit/) < at(/register_merchant/) && at(/register_merchant/) < at(/register_order/));
});

// ---------- client-9 ----------
function chatFetch({ receipts }) {
  let receiptCalls = 0;
  return (call) => {
    if (call.url === '/api/config') return jsonResponse(BASE_CONFIG);
    if (call.url === '/api/chat') return jsonResponse({ reply: REPLY, bundle: BUNDLE, register_tx: 'reg1' });
    const method = decodeMethod(call);
    if (method === 'get_merchant') return rpcResponse({ bond: '1', reserved: '0', paid_out: '0' });
    if (method === 'get_bonds') return rpcResponse([]);
    if (method === 'get_receipt') { const r = receipts[Math.min(receiptCalls++, receipts.length - 1)]; return r instanceof Error ? jsonResponse({ jsonrpc: '2.0', id: 1, error: { message: r.message } }) : rpcResponse(r); }
    if (method === 'preview_claim') return rpcResponse({ ok: true, token_bps: 2000, paid_bps: 2000, payout: '4000000', token: TOKEN.id });
    if (method === 'storage_balance_of') return rpcResponse({ total: '1' });
    throw new Error(`unexpected ${method}`);
  };
}

test('client-9: a lagging node (receipt null, then a dropped call, then the receipt) still ends in BINDING', async () => {
  const els = fakePage();
  await withFetch(chatFetch({ receipts: [null, new Error('node unavailable'), { order_id: 'A123-11', token: TOKEN.id }] }), async (calls) => {
    try {
      (await import('../../web/app.js?audit-client-9a')).BINDING_RETRY.delayMs = 1;
      await settle(els);
      els['chat-input'].value = 'my mug broke';
      await els['chat-form'].listeners.submit({ preventDefault() {} });
      const bot = els['chat-log'].children[1];
      assert.equal(bot.statusBadge.textContent, 'BINDING · claimable 4 tUSDC');
      assert.ok(bot.claimButton);
      assert.equal(calls.filter(c => c.url !== '/api/config' && c.url !== '/api/chat' && decodeMethod(c) === 'get_receipt').length, 3);
    } finally { delete globalThis.document; }
  });
});

test('client-9: when the receipt never shows up the bubble says NOT A PROMISE and offers Re-check, which can recover', async () => {
  const els = fakePage();
  const receipts = [null];
  await withFetch(chatFetch({ receipts }), async () => {
    try {
      const page = await import('../../web/app.js?audit-client-9b');
      page.BINDING_RETRY.delayMs = 1;
      await settle(els);
      els['chat-input'].value = 'my mug broke';
      await els['chat-form'].listeners.submit({ preventDefault() {} });
      const bot = els['chat-log'].children[1];
      assert.match(bot.statusBadge.textContent, /^NOT A PROMISE/);
      assert.ok(!bot.claimButton);
      const recheck = bot.recheckButton;
      assert.ok(recheck, 'a Re-check action is offered');
      receipts[0] = { order_id: 'A123-11', token: TOKEN.id }; // the node caught up
      await recheck.listeners.click();
      assert.equal(bot.statusBadge.textContent, 'BINDING · claimable 4 tUSDC');
      assert.ok(bot.claimButton);
      assert.equal(bot.recheckButton, null);
    } finally { delete globalThis.document; }
  });
});

// ---------- client-10 ----------
test('client-10: attest.mjs refuses to overwrite an existing record (a registered hash must stay matchable)', () => {
  const src = fs.readFileSync('app/scripts/attest.mjs', 'utf8');
  assert.match(src, /writeFileSync\(file, bytes, \{ flag: 'wx' \}\)/);
  assert.match(src, /REFUSING to overwrite/);
  assert.ok(!/fs\.writeFileSync\(file, bytes\);/.test(src));
  // the behaviour of the flag the script relies on
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client10-'));
  try {
    const f = path.join(dir, 'rec.json');
    fs.writeFileSync(f, 'first', { flag: 'wx' });
    assert.throws(() => fs.writeFileSync(f, 'second', { flag: 'wx' }), (e) => e.code === 'EEXIST');
    assert.equal(fs.readFileSync(f, 'utf8'), 'first');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
