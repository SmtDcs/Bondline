// Tests for the browser module in web/app.js. jsdom is not a dependency (PLAN section 6 forbids new
// deps), so this drives the pure ES module: the frozen BINDING functions and the reply splitter.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = new URL('http://127.0.0.1:8787/');
const app = await import('../../web/app.js');

const CONFIG = {
  mode: 'live',
  network: 'testnet',
  rpcUrl: 'https://rpc.testnet.fastnear.com',
  contractId: 'cbp-sm1110.testnet',
  merchantId: 'cbp-shop-sm1110.testnet',
  buyerId: 'cbp-alice-sm1110.testnet',
  model: 'z-ai/glm-5.3-flash',
  orders: [{ order_id: 'A123-03', label: 'Broken mug' }, { order_id: 'A124-03', label: 'Late delivery' }],
};

const jsonResponse = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const bytesOf = (value) => Array.from(new TextEncoder().encode(JSON.stringify(value)));
const rpcResponse = (value) => jsonResponse({ jsonrpc: '2.0', id: 'cbp', result: { result: bytesOf(value) } });
const decodeArgs = (call) => JSON.parse(Buffer.from(JSON.parse(call.opts.body).params.args_base64, 'base64').toString());

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const call = { url: String(url), opts };
    calls.push(call);
    return handler(call);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

test('the page module exports rpcView (the T15 DevTools acceptance)', () => {
  assert.equal(typeof app.rpcView, 'function');
  assert.equal(typeof app.sha256Hex, 'function');
  assert.equal(typeof app.bindingStatus, 'function');
  assert.equal(typeof app.badgeText, 'function');
});

test('sha256Hex matches the known SHA-256 vectors', async () => {
  assert.equal(await app.sha256Hex(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await app.sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('splitTokenLine puts the PROMISE line in .token and keeps the rest as text', () => {
  const reply = 'Sorry about the broken mug. I can offer a 20% refund on order A123-03.\nPROMISE|refund|order=A123-03|bps=2000';
  const { text, token } = app.splitTokenLine(reply);
  assert.equal(token, 'PROMISE|refund|order=A123-03|bps=2000');
  assert.equal(text, 'Sorry about the broken mug. I can offer a 20% refund on order A123-03.');
  assert.deepEqual(app.splitTokenLine('no promise here'), { text: 'no promise here', token: null });
});

test('badgeText follows the frozen BINDING rule', () => {
  assert.deepEqual(app.badgeText({ receipt: null, preview: { ok: false } }), { cls: 'error', text: 'NOT A PROMISE (no receipt on chain)' });
  assert.deepEqual(app.badgeText({ receipt: {}, preview: { ok: false, error: 'ERR_NO_RECEIPT_FOR_BYTES' } }), { cls: 'error', text: 'ERR_NO_RECEIPT_FOR_BYTES' });
  assert.deepEqual(
    app.badgeText({ receipt: {}, preview: { ok: true, token_bps: 2000, paid_bps: 2000, payout: '400000000000000000000000' } }),
    { cls: 'binding', text: 'BINDING · claimable 0.400 NEAR' },
  );
  assert.deepEqual(
    app.badgeText({ receipt: {}, preview: { ok: true, token_bps: 10000, paid_bps: 3000, payout: '600000000000000000000000' } }),
    { cls: 'binding', text: 'BINDING · claimable 0.600 NEAR · token 100% → paid 30% (cap)' },
  );
});

test('loadConfig reads /api/config and rpcView sends the JSON-RPC call_function body', async () => {
  await withFetch((call) => (call.url === '/api/config' ? jsonResponse(CONFIG) : rpcResponse({ ok: true })), async (calls) => {
    assert.deepEqual(await app.loadConfig(), CONFIG);

    const out = await app.rpcView('get_receipt', { response_hash: 'ab'.repeat(32) });
    assert.deepEqual(out, { ok: true });

    const rpc = calls[1];
    assert.equal(rpc.url, CONFIG.rpcUrl);
    assert.equal(rpc.opts.method, 'POST');
    assert.equal(rpc.opts.headers['Content-Type'], 'application/json');
    const body = JSON.parse(rpc.opts.body);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.method, 'query');
    assert.deepEqual(body.params.request_type, 'call_function');
    assert.equal(body.params.finality, 'final');
    assert.equal(body.params.account_id, CONFIG.contractId);
    assert.equal(body.params.method_name, 'get_receipt');
    assert.deepEqual(decodeArgs(rpc), { response_hash: 'ab'.repeat(32) });
  });
});

test('rpcView throws on a JSON-RPC error and on result.error', async () => {
  await withFetch(() => jsonResponse({ error: { cause: { name: 'UNKNOWN_BLOCK' }, message: 'boom' } }), async () => {
    await assert.rejects(() => app.rpcView('get_receipt', {}), /UNKNOWN_BLOCK/);
  });
  await withFetch(() => jsonResponse({ result: { error: 'ERR_INTERNAL' } }), async () => {
    await assert.rejects(() => app.rpcView('get_receipt', {}), /ERR_INTERNAL/);
  });
});

test('bindingStatus hashes the exact response bytes and asks get_receipt + preview_claim', async () => {
  const responseB64 = Buffer.from('hello').toString('base64');
  const hash = await app.sha256Hex(new TextEncoder().encode('hello'));
  const receipt = { order_id: 'A123-03', response_hash: hash };
  const preview = { ok: true, token_bps: 2000, paid_bps: 2000, payout: '400000000000000000000000' };
  await withFetch((call) => {
    if (call.url === '/api/config') return jsonResponse(CONFIG);
    return JSON.parse(call.opts.body).params.method_name === 'get_receipt' ? rpcResponse(receipt) : rpcResponse(preview);
  }, async (calls) => {
    await app.loadConfig();
    const out = await app.bindingStatus('A123-03', responseB64);

    assert.equal(calls.length, 3);
    assert.deepEqual(decodeArgs(calls[1]), { response_hash: hash });
    assert.deepEqual(decodeArgs(calls[2]), { order_id: 'A123-03', response_b64: responseB64 });
    assert.equal(out.hash, hash);
    assert.deepEqual(out.receipt, receipt);
    assert.deepEqual(out.preview, preview);
    assert.deepEqual(app.badgeText(out), { cls: 'binding', text: 'BINDING · claimable 0.400 NEAR' });
  });
});

test('?offline=1 uses recorded views and makes no network call', async () => {
  globalThis.location = new URL('http://127.0.0.1:8787/?offline=1');
  try {
    const offline = await import('../../web/app.js?offline=1');
    const recorded = {
      get_receipt: { order_id: 'A123-03' },
      preview_claim: { ok: true, token_bps: 2000, paid_bps: 2000, payout: '400000000000000000000000' },
    };
    await withFetch(() => {
      throw new Error('fetch must not be called with recorded views');
    }, async () => {
      const out = await offline.bindingStatus('A123-03', 'AAAA', recorded);
      assert.deepEqual(out, { receipt: recorded.get_receipt, preview: recorded.preview_claim });
      assert.deepEqual(offline.badgeText(out), { cls: 'binding', text: 'BINDING · claimable 0.400 NEAR' });
    });
  } finally {
    globalThis.location = new URL('http://127.0.0.1:8787/');
  }
});

// --- UI wiring: a minimal document (jsdom is not a dependency) -----------------

function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    value: '',
    href: '',
    target: '',
    rel: '',
    children: [],
    listeners: {},
    _text: '',
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); this.children = []; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
}

function fakePage() {
  const ids = ['mode-badge', 'contract-link', 'order-select', 'chat-log', 'chat-input', 'chat-form',
    'merchant-log', 'bond-meter', 'btn-register-edited'];
  const els = Object.fromEntries(ids.map(id => [id, makeEl(id)]));
  globalThis.document = { getElementById: id => els[id] ?? null, createElement: tag => makeEl(tag) };
  return els;
}

const HONEST = 'My mug from order A123-03 arrived broken. Can I get a partial refund?';
const REPLY = "I'm sorry to hear your mug arrived broken! I can offer you a partial refund of 2000 basis points (20%) on order A123-03, which comes to 0.4 NEAR out of the 2 NEAR total.\nPROMISE|refund|order=A123-03|bps=2000";
const TOKEN = 'PROMISE|refund|order=A123-03|bps=2000';
const BUNDLE = { type: 'bot-promises/receipt-bundle/v1', simulated: false, order_id: 'A123-03', response_b64: 'aGVsbG8=' };

async function openPage(query, chatResponse) {
  const els = fakePage();
  globalThis.location = new URL('http://127.0.0.1:8787/');
  const calls = [];
  await withFetch((call) => {
    calls.push(call);
    if (call.url === '/api/config') return jsonResponse(CONFIG);
    if (call.url === '/api/chat') return chatResponse();
    const method = JSON.parse(call.opts.body).params.method_name;
    return method === 'get_receipt'
      ? rpcResponse({ order_id: 'A123-03' })
      : rpcResponse({ ok: true, token_bps: 2000, paid_bps: 2000, payout: '400000000000000000000000' });
  }, async () => {
    await import(`../../web/app.js?${query}`);
    const select = els['order-select'];
    for (let i = 0; i < 100 && select.children.length === 0; i++) await new Promise(r => setTimeout(r, 0));
    els['chat-input'].value = HONEST;
    els['order-select'].value = 'A123-03';
    await els['chat-form'].listeners.submit({ preventDefault() {} });
  });
  return { els, calls };
}

test('init fills mode/contract/orders and submit renders reply + token + tx + BINDING badge', async () => {
  try {
    const { els } = await openPage('dom1', () => jsonResponse({
      reply: REPLY,
      bundle: BUNDLE,
      register_tx: 'abc',
      explorer: 'https://testnet.nearblocks.io/txns/abc',
    }));

    assert.equal(els['mode-badge'].textContent, 'live');
    assert.equal(els['order-select'].children.length, 2);
    assert.equal(els['order-select'].children[0].value, 'A123-03');
    assert.equal(els['order-select'].children[0].textContent, 'A123-03 · Broken mug');
    assert.equal(els['contract-link'].children[0].href, 'https://testnet.nearblocks.io/address/cbp-sm1110.testnet');
    assert.equal(els['contract-link'].children[0].textContent, 'cbp-sm1110.testnet');

    const log = els['chat-log'];
    assert.equal(log.children.length, 2);
    const [user, bot] = log.children;
    assert.equal(user.className, 'msg user');
    assert.equal(user.children[0].textContent, HONEST);

    assert.equal(bot.className, 'msg bot');
    const [bubble, meta] = bot.children;
    assert.match(bubble.textContent, /partial refund of 2000 basis points/);
    assert.equal(bubble.children[0].className, 'token');
    assert.equal(bubble.children[0].textContent, TOKEN);

    const [status, links] = meta.children;
    assert.equal(meta.children.length, 2, 'no SIMULATED badge for a live bundle');
    assert.equal(status.className, 'badge binding');
    assert.equal(status.textContent, 'BINDING · claimable 0.400 NEAR');
    assert.equal(links.children[0].textContent, 'receipt tx');
    assert.equal(links.children[0].href, 'https://testnet.nearblocks.io/txns/abc');
    assert.deepEqual(bot.bundle, BUNDLE);
    assert.deepEqual(bubble.bundle, BUNDLE);
  } finally {
    delete globalThis.document;
  }
});

test('a simulated bundle adds the SIMULATED badge', async () => {
  try {
    const simulated = { ...BUNDLE, simulated: true };
    const { els } = await openPage('dom2', () => jsonResponse({
      reply: REPLY,
      bundle: simulated,
      register_tx: 'abc',
      explorer: 'https://testnet.nearblocks.io/txns/abc',
    }));
    const meta = els['chat-log'].children[1].children[1];
    assert.equal(meta.children.length, 3);
    assert.equal(meta.children[2].className, 'badge simulated');
    assert.equal(meta.children[2].textContent, 'SIMULATED');
  } finally {
    delete globalThis.document;
  }
});

test('an API error puts the error string in a red badge', async () => {
  try {
    const { els, calls } = await openPage('dom3', () => new Response(
      JSON.stringify({ error: 'ERR_ALREADY_CLAIMED' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    const [user, bot] = els['chat-log'].children;
    assert.equal(user.className, 'msg user');
    const [bubble, meta] = bot.children;
    assert.equal(bubble.textContent, '');
    assert.equal(meta.children[0].className, 'badge error');
    assert.equal(meta.children[0].textContent, 'ERR_ALREADY_CLAIMED');
    assert.equal(calls.filter(c => c.url === CONFIG.rpcUrl).length, 0, 'no RPC view after a failed chat');
  } finally {
    delete globalThis.document;
  }
});
