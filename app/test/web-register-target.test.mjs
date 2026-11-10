// Audit relayer-web-secrets-1/-4: "Register an edited reply" acts on the bubble the merchant flow
// means (A123 in the scripted demo, where A124 is chatted before the click), and the offline replay
// bond meter follows the claims that were actually replayed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.location = new URL('http://127.0.0.1:8787/');

const CONFIG = {
  mode: 'live', network: 'testnet', rpcUrl: 'https://rpc.testnet.fastnear.com',
  contractId: 'cbp-sm1110.testnet', merchantId: 'cbp-shop-sm1110.testnet', buyerId: 'cbp-alice-sm1110.testnet',
  model: 'z-ai/glm-5.3-flash',
  orders: [{ order_id: 'A123-03', label: 'Broken mug' }, { order_id: 'A124-03', label: 'Late delivery', naive: true }],
};
const b64Of = (text) => Buffer.from(JSON.stringify({ choices: [{ message: { content: text } }] }), 'utf8').toString('base64');
const BUNDLES = {
  'A123-03': { type: 'bot-promises/receipt-bundle/v1', simulated: false, order_id: 'A123-03', response_b64: b64Of('20% it is.\nPROMISE|refund|order=A123-03|bps=2000') },
  'A124-03': { type: 'bot-promises/receipt-bundle/v1', simulated: false, order_id: 'A124-03', response_b64: b64Of('Full refund.\nPROMISE|refund|order=A124-03|bps=10000') },
};
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const rpcResponse = (value) => jsonResponse({ jsonrpc: '2.0', id: 'cbp', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } });

function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(), className: '', value: '', href: '', target: '', rel: '', disabled: false,
    scrollTop: 0, scrollHeight: 0, children: [], listeners: {}, _text: '',
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); this.children = []; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
}
function fakePage() {
  const ids = ['mode-badge', 'contract-link', 'order-select', 'chat-log', 'chat-input', 'chat-form',
    'merchant-log', 'bond-meter', 'btn-register-edited', 'deny-box', 'footer'];
  const els = Object.fromEntries(ids.map(id => [id, makeEl(id)]));
  const body = makeEl('body');
  globalThis.document = { getElementById: id => els[id] ?? null, createElement: tag => makeEl(tag), body };
  return { els, body };
}
function stubFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { const call = { url: String(url), opts }; calls.push(call); return handler(call); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
async function waitFor(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 0)); }
  throw new Error('timed out waiting for the page');
}
const handler = (call) => {
  if (call.url === '/api/config') return jsonResponse(CONFIG);
  if (call.url === '/api/chat') {
    const { order_id } = JSON.parse(call.opts.body);
    return jsonResponse({ reply: 'x', bundle: BUNDLES[order_id], register_tx: 'reg', explorer: 'https://testnet.nearblocks.io/txns/reg' });
  }
  if (call.url === '/api/demo/register-edited') return jsonResponse({ error: 'ERR_BAD_SIGNATURE', tx: 'bad1', explorer: 'https://testnet.nearblocks.io/txns/bad1' }, 400);
  const method = JSON.parse(call.opts.body).params.method_name;
  if (method === 'get_merchant') return rpcResponse({ bond: '3000000000000000000000000', reserved: '0', paid_out: '0' });
  if (method === 'get_receipt') return rpcResponse({ order_id: 'x' });
  return rpcResponse({ ok: true, token_bps: 2000, paid_bps: 2000, payout: '400000000000000000000000' });
};
async function chat(els, order) {
  els['chat-input'].value = 'hi';
  els['order-select'].value = order;
  await els['chat-form'].listeners.submit({ preventDefault() {} });
}
const posted = (calls) => JSON.parse(calls.filter(c => c.url === '/api/demo/register-edited').at(-1).opts.body);

test('scripted demo order: A123 chat, A124 chat, then Register edited acts on the A123 bubble (not the last one)', async () => {
  const { els } = fakePage();
  const { calls, restore } = stubFetch(handler);
  try {
    await import('../../web/app.js?target-demo');
    await waitFor(() => els['order-select'].children.length > 0);
    await chat(els, 'A123-03');
    await chat(els, 'A124-03');
    assert.equal(els['chat-log'].children.length, 4);
    await els['btn-register-edited'].listeners.click();
    const body = posted(calls);
    assert.equal(body.order_id, 'A123-03');
    assert.deepEqual(body.bundle, BUNDLES['A123-03']);
    assert.deepEqual(body.edit, { from: 'bps=2000', to: 'bps=3000' });
  } finally { restore(); delete globalThis.document; }
});

test('Register edited targets the bubble the shopper tampered with, with an edit that exists in it', async () => {
  const { els } = fakePage();
  const { calls, restore } = stubFetch(handler);
  try {
    await import('../../web/app.js?target-tampered');
    await waitFor(() => els['order-select'].children.length > 0);
    await chat(els, 'A123-03');
    await chat(els, 'A124-03');
    const a124 = els['chat-log'].children[3];
    await a124.tamperButton.listeners.click();
    await els['btn-register-edited'].listeners.click();
    const body = posted(calls);
    assert.equal(body.order_id, 'A124-03');
    assert.deepEqual(body.edit, { from: 'bps=10000', to: 'bps=30000' });
    assert.ok(Buffer.from(body.bundle.response_b64, 'base64').toString().includes(body.edit.from), 'the edit is present in the targeted bytes');
  } finally { restore(); delete globalThis.document; }
});

test('editForReply rewrites the first bps token and is null without one', async () => {
  const app = await import('../../web/app.js?target-helpers');
  assert.deepEqual(app.editForReply('a bps=2000'), { from: 'bps=2000', to: 'bps=3000' });
  assert.deepEqual(app.editForReply('bps=10000'), { from: 'bps=10000', to: 'bps=30000' });
  assert.deepEqual(app.editForReply('bps=3000'), { from: 'bps=3000', to: 'bps=2000' });
  assert.equal(app.editForReply('nothing'), null);
});

test('replayMeterView follows the claims replayed so far (offline replay bond meter)', async () => {
  const app = await import('../../web/app.js?target-meter');
  const transcript = JSON.parse(fs.readFileSync('fixtures/replay/transcript.json', 'utf8'));
  const [c1, c2] = transcript.steps.filter(s => s.kind === 'claim');
  const initial = app.replayInitialMerchantView(transcript);
  const final = app.replayMerchantView(transcript);
  assert.deepEqual(app.replayMeterView(transcript, new Set()), initial);
  assert.deepEqual(app.replayMeterView(transcript, new Set([c1.order_id, c2.order_id])), final);
  const afterFirst = app.replayMeterView(transcript, new Set([c1.order_id]));
  // bond falls by exactly the first payout, paid_out rises by it, reserved falls by that order's liability
  assert.equal(BigInt(initial.bond) - BigInt(afterFirst.bond), BigInt(c1.result.payout));
  assert.equal(BigInt(afterFirst.paid_out) - BigInt(initial.paid_out), BigInt(c1.result.payout));
  assert.equal(BigInt(initial.reserved) - BigInt(afterFirst.reserved), 600000000000000000000000n);
  assert.notDeepEqual(afterFirst, final);
});
