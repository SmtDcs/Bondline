// Frontend regressions: each test fails without its fix.
//  - ?offline=1 on a v2 recording must touch nothing but localhost (the storage_balance_of leak)
//  - loadConfig must fail loudly on a non-JSON/error body instead of "Unexpected token"
//  - one /api/chat at a time (a double Enter must not buy two live replies)
//  - a failed claim keeps the server's tx link and detail
//  - index.html carries the viewport, labels and live regions a screen reader needs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.location = new URL('http://127.0.0.1:8787/');

const TOKEN = { id: 'tusdc.testnet', symbol: 'tUSDC', decimals: 6 };
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const rpcResponse = (value) => jsonResponse({ jsonrpc: '2.0', id: 'cbp', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } });
const decodeMethod = (call) => JSON.parse(call.opts.body).params.method_name;

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
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 0));
  }
  throw new Error('timed out waiting for the page');
}

const REPLY = 'Sorry about the mug.\nPROMISE|refund|order=A123-11|bps=2000';
const BUNDLE = {
  type: 'bot-promises/receipt-bundle/v1', simulated: false, order_id: 'A123-11',
  response_b64: Buffer.from(JSON.stringify({ choices: [{ message: { content: REPLY } }] }), 'utf8').toString('base64'),
};
const V2_LIVE = {
  mode: 'live', network: 'testnet', rpcUrl: 'https://rpc.testnet.fastnear.com',
  contractId: 'v2.cbp-sm1110.testnet', merchantId: 'cbp-shop-sm1110.testnet', buyerId: 'cbp-alice-sm1110.testnet',
  contract_api: 2, tokens: [TOKEN],
  orders: [{ order_id: 'A123-11', label: 'Broken mug', token: TOKEN.id, amount: '20000000' }],
};

test('offline v2 replay never asks the token contract for storage_balance_of', async () => {
  const realLocation = globalThis.location;
  globalThis.location = new URL('http://127.0.0.1:8787/?offline=1');
  const { els } = fakePage();
  const config = {
    ...V2_LIVE,
    mode: 'replay',
    orders: [{ order_id: 'A123-11', token: TOKEN.id }],
  };
  const views = {
    get_receipt: { order_id: 'A123-11', token: TOKEN.id, order_amount: '20000000' },
    preview_claim: { ok: true, token_bps: 2000, paid_bps: 2000, payout: '4000000', token: TOKEN.id },
    get_merchant: { bond: '20000000', reserved: '6000000', paid_out: '0', token: TOKEN.id },
  };
  const { calls, restore } = stubFetch((call) => {
    if (call.url === '/api/config') return jsonResponse(config);
    if (call.url.startsWith('/fixtures/replay/')) return jsonResponse({ type: 'bot-promises/replay/v2', recorded_at: '2026-11-10T12:00:00Z', steps: [] });
    if (call.url === '/api/chat') return jsonResponse({ reply: REPLY, bundle: BUNDLE, register_tx: 'reg1', views });
    throw new Error(`unexpected URL ${call.url}`);
  });
  try {
    await import('../../web/app.js?fixes-offline-v2');
    await waitFor(() => els['order-select'].children.length > 0);
    els['chat-input'].value = 'my mug broke';
    await els['chat-form'].listeners.submit({ preventDefault() {} });

    const bot = els['chat-log'].children.find(c => c.statusBadge);
    assert.match(bot.statusBadge.textContent, /^BINDING · claimable 4 tUSDC$/);
    assert.ok(bot.claimButton, 'the offline replay is still claimable');
    assert.ok(calls.every(c => c.url.startsWith('/')), 'no testnet call in ?offline=1 replay, not even storage_balance_of');
    assert.equal(calls.filter(c => c.url.startsWith('/') && /storage_balance_of/.test(c.opts?.body ?? '')).length, 0);
  } finally {
    restore();
    globalThis.location = realLocation;
    delete globalThis.document;
  }
});

test('a live v2 page still checks the buyer storage balance', async () => {
  const realLocation = globalThis.location;
  globalThis.location = new URL('http://127.0.0.1:8787/');
  const { els } = fakePage();
  const { calls, restore } = stubFetch((call) => {
    if (call.url === '/api/config') return jsonResponse(V2_LIVE);
    if (call.url === '/api/chat') return jsonResponse({ reply: REPLY, bundle: BUNDLE, register_tx: 'reg1' });
    const method = decodeMethod(call);
    if (method === 'get_merchant') return rpcResponse({ bond: '1', reserved: '0', paid_out: '0' });
    if (method === 'get_bonds') return rpcResponse([]);
    if (method === 'get_receipt') return rpcResponse({ order_id: 'A123-11', token: TOKEN.id });
    if (method === 'preview_claim') return rpcResponse({ ok: true, token_bps: 2000, paid_bps: 2000, payout: '4000000', token: TOKEN.id });
    if (method === 'storage_balance_of') return rpcResponse(null);
    throw new Error(`unexpected ${method}`);
  });
  try {
    const app = await import('../../web/app.js?fixes-live-v2');
    app.BINDING_RETRY.delayMs = 1;
    await waitFor(() => els['order-select'].children.length > 0);
    els['chat-input'].value = 'my mug broke';
    await els['chat-form'].listeners.submit({ preventDefault() {} });
    assert.ok(calls.some(c => c.url.startsWith('https://') && decodeMethod(c) === 'storage_balance_of'),
      'live mode still asks the token contract (the notice is a live feature)');
  } finally {
    restore();
    globalThis.location = realLocation;
    delete globalThis.document;
  }
});

test('loadConfig fails with the HTTP status instead of a JSON parse error', async () => {
  const app = await import('../../web/app.js?fixes-loadconfig');
  const { restore } = stubFetch(() => new Response('<html>not json</html>', { status: 500, headers: { 'content-type': 'text/html' } }));
  try {
    await assert.rejects(() => app.loadConfig('/api/config'), /config HTTP 500/);
  } finally {
    restore();
  }
});

test('a double Enter opens exactly one /api/chat call', async () => {
  const { els } = fakePage();
  let chatCalls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { restore } = stubFetch(async (call) => {
    if (call.url === '/api/config') return jsonResponse(V2_LIVE);
    if (call.url === '/api/chat') {
      chatCalls += 1;
      await gate;
      return jsonResponse({ reply: REPLY, bundle: BUNDLE, register_tx: 'reg1' });
    }
    const method = decodeMethod(call);
    if (method === 'get_merchant') return rpcResponse({ bond: '1', reserved: '0', paid_out: '0' });
    if (method === 'get_bonds') return rpcResponse([]);
    if (method === 'get_receipt') return rpcResponse({ order_id: 'A123-11', token: TOKEN.id });
    if (method === 'preview_claim') return rpcResponse({ ok: true, token_bps: 2000, paid_bps: 2000, payout: '4000000', token: TOKEN.id });
    if (method === 'storage_balance_of') return rpcResponse({ total: '1' });
    throw new Error(`unexpected ${method}`);
  });
  try {
    await import('../../web/app.js?fixes-double-submit');
    await waitFor(() => els['order-select'].children.length > 0);
    els['chat-input'].value = 'my mug broke';
    const first = els['chat-form'].listeners.submit({ preventDefault() {} });
    const second = els['chat-form'].listeners.submit({ preventDefault() {} });
    release();
    await Promise.all([first, second]);
    assert.equal(chatCalls, 1, 'the second submit is dropped while the first is in flight');
    assert.equal(els['chat-log'].children.length, 2, 'one user bubble and one bot bubble');
  } finally {
    restore();
    delete globalThis.document;
  }
});

test('a failed claim toast keeps the tx link and the server detail', async () => {
  const { els, body } = fakePage();
  const { restore } = stubFetch((call) => {
    if (call.url === '/api/config') return jsonResponse(V2_LIVE);
    if (call.url === '/api/chat') return jsonResponse({ reply: REPLY, bundle: BUNDLE, register_tx: 'reg1' });
    if (call.url === '/api/demo/claim') {
      return jsonResponse({
        error: 'ERR_PAYOUT_FAILED',
        detail: 'payout failed (receiver not registered); the order is open again. register on tUSDC first',
        tx: 'fail1',
        explorer: 'https://testnet.nearblocks.io/txns/fail1',
      }, 502);
    }
    const method = decodeMethod(call);
    if (method === 'get_merchant') return rpcResponse({ bond: '1', reserved: '0', paid_out: '0' });
    if (method === 'get_bonds') return rpcResponse([]);
    if (method === 'get_receipt') return rpcResponse({ order_id: 'A123-11', token: TOKEN.id });
    if (method === 'preview_claim') return rpcResponse({ ok: true, token_bps: 2000, paid_bps: 2000, payout: '4000000', token: TOKEN.id });
    if (method === 'storage_balance_of') return rpcResponse({ total: '1' });
    throw new Error(`unexpected ${method}`);
  });
  try {
    await import('../../web/app.js?fixes-claim-fail');
    await waitFor(() => els['order-select'].children.length > 0);
    els['chat-input'].value = 'my mug broke';
    await els['chat-form'].listeners.submit({ preventDefault() {} });

    const bot = els['chat-log'].children.find(c => c.statusBadge);
    await bot.claimButton.listeners.click();

    const toast = body.children.at(-1);
    assert.equal(toast.className, 'toast error');
    assert.match(toast.textContent, /ERR_PAYOUT_FAILED/);
    assert.match(toast.textContent, /register on tUSDC first/, 'the server detail is shown');
    const link = toast.children.find(c => c.tagName === 'A');
    assert.equal(link.textContent, 'failed tx');
    assert.equal(link.href, 'https://testnet.nearblocks.io/txns/fail1');
  } finally {
    restore();
    delete globalThis.document;
  }
});

test('the plain replay URL explains why the badges are red (add ?offline=1)', async () => {
  const realLocation = globalThis.location;
  globalThis.location = new URL('http://127.0.0.1:8787/');
  const { els } = fakePage();
  const hint = makeEl('span');
  els['mode-badge'].after = (node) => { hint.textContent = node.textContent; hint.className = node.className; };
  const { restore } = stubFetch((call) => {
    if (call.url === '/api/config') return jsonResponse({
      mode: 'replay', network: 'testnet', rpcUrl: 'https://test.rpc.fastnear.com',
      contractId: 'cbp-sm1110.testnet', merchantId: 'cbp-shop-sm1110.testnet', buyerId: 'cbp-alice-sm1110.testnet',
      orders: [{ order_id: 'A123-11' }],
    });
    if (call.url.startsWith('/fixtures/replay/')) return jsonResponse({ type: 'bot-promises/replay/v1', steps: [] });
    if (call.url === 'https://test.rpc.fastnear.com') return rpcResponse({ bond: '1', reserved: '0', paid_out: '0' });
    throw new Error(`unexpected ${call.url}`);
  });
  try {
    await import('../../web/app.js?fixes-plain-replay');
    await waitFor(() => els['order-select'].children.length > 0);
    assert.match(hint.textContent, /add \?offline=1/);
    assert.equal(hint.className, 'badge warning');
  } finally {
    restore();
    globalThis.location = realLocation;
    delete globalThis.document;
  }
});

test('index.html has the viewport meta, labelled inputs and live regions', () => {
  const html = fs.readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<label for="order-select">/);
  assert.match(html, /id="order-select"[^>]*aria-label=/);
  assert.match(html, /id="chat-input"[^>]*aria-label=/);
  assert.match(html, /id="deny-box"[^>]*aria-label=/);
  assert.match(html, /id="chat-log"[^>]*role="log"[^>]*aria-live="polite"/);
  assert.match(html, /<button type="submit">Send<\/button>/);
});
