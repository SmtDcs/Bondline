// docs/STABLECOIN.md 12: the page's v2 additions (token amounts, expiry, per-asset meter,
// unregistered-buyer notice) plus the v1 replay staying byte-identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.location = new URL('http://127.0.0.1:8787/');
const app = await import('../../web/app.js?stablecoin');

const TOKEN = { id: 'tusdc.testnet', symbol: 'tUSDC', decimals: 6 };
const V2_CONFIG = {
  mode: 'live', network: 'testnet', rpcUrl: 'https://rpc.testnet.fastnear.com',
  contractId: 'v2.cbp-sm1110.testnet', merchantId: 'cbp-shop-sm1110.testnet', buyerId: 'cbp-alice-sm1110.testnet',
  model: 'z-ai/glm-5.3-flash', contract_api: 2, tokens: [TOKEN],
  orders: [{ order_id: 'A123-11', label: 'Broken mug', token: 'tusdc.testnet', amount: '20000000', expires_at_ms: '1796792000000' }],
};

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const rpcResponse = (value) => jsonResponse({ jsonrpc: '2.0', id: 'cbp', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } });
const decodeArgs = (call) => JSON.parse(Buffer.from(JSON.parse(call.opts.body).params.args_base64, 'base64').toString());
const decodeMethod = (call) => JSON.parse(call.opts.body).params.method_name;

function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const call = { url: String(url), opts };
    calls.push(call);
    return handler(call);
  };
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

test('the browser amount module is the app module, byte for byte', () => {
  assert.equal(fs.readFileSync('web/amount.js', 'utf8'), fs.readFileSync('app/lib/amount.mjs', 'utf8'));
  assert.equal(app.formatAsset('4000000', 'tusdc.testnet', [TOKEN]), '4 tUSDC');
  assert.equal(app.formatAsset('1', 'tusdc.testnet', [TOKEN]), '0.000001 tUSDC');
  assert.equal(app.formatAsset(400000000000000000000000n, null, [TOKEN]), '0.400 NEAR');
});

test('badgeText formats token amounts, the cap and the expiry; v1 text is unchanged', async () => {
  await withFetch(() => jsonResponse(V2_CONFIG), () => app.loadConfig());
  assert.deepEqual(
    app.badgeText({ receipt: {}, preview: { ok: true, token_bps: 2000, paid_bps: 2000, payout: '4000000' }, tokenId: 'tusdc.testnet' }),
    { cls: 'binding', text: 'BINDING · claimable 4 tUSDC' },
  );
  assert.deepEqual(
    app.badgeText({ receipt: {}, preview: { ok: true, token_bps: 10000, paid_bps: 3000, payout: '6000000' }, tokenId: 'tusdc.testnet' }),
    { cls: 'binding', text: 'BINDING · claimable 6 tUSDC · token 100% → paid 30% (cap)' },
  );
  assert.equal(
    app.badgeText({ receipt: {}, preview: { ok: true, token_bps: 2000, paid_bps: 2000, payout: '4000000' }, tokenId: 'tusdc.testnet', expiresAtMs: 10_000, nowMs: 5_000 }).text,
    'BINDING · claimable 4 tUSDC · expires in <1m',
  );
  // v1 (no token, no expiry): exactly the old badge
  assert.deepEqual(app.badgeText({ receipt: {}, preview: { ok: true, token_bps: 2000, paid_bps: 2000, payout: '400000000000000000000000' } }), { cls: 'binding', text: 'BINDING · claimable 0.400 NEAR' });
});

test('EXPIRED and ERR_PAYOUT_FAILED badges', async () => {
  await withFetch(() => jsonResponse(V2_CONFIG), () => app.loadConfig());
  assert.deepEqual(app.badgeText({ receipt: {}, preview: { ok: false, error: 'ERR_ORDER_EXPIRED' } }), { cls: 'expired', text: 'EXPIRED' });
  assert.deepEqual(
    app.badgeText({ receipt: {}, preview: { ok: false, error: 'ERR_PAYOUT_FAILED' }, tokenId: 'tusdc.testnet' }),
    { cls: 'error', text: 'ERR_PAYOUT_FAILED · retry after registering on tUSDC' },
  );
  assert.equal(app.payoutFailedText('tusdc.testnet'), 'ERR_PAYOUT_FAILED · retry after registering on tUSDC');
});

test('expiryCountdown', () => {
  assert.equal(app.expiryCountdown(1000 + 30_000, 1000), 'expires in <1m');
  assert.equal(app.expiryCountdown(1000 + 5 * 60_000, 1000), 'expires in 5m');
  assert.equal(app.expiryCountdown(1000 + 2 * 3_600_000, 1000), 'expires in 2h');
  assert.equal(app.expiryCountdown(1000 + 3 * 86_400_000, 1000), 'expires in 3d');
  assert.equal(app.expiryCountdown(1000, 1000), 'EXPIRED');
  assert.equal(app.expiryCountdown(999, 1000), 'EXPIRED');
});

test('orderLabel shows the token total and keeps the v1 label', () => {
  assert.equal(app.orderLabel({ order_id: 'A123-11', label: 'Broken mug', token: 'tusdc.testnet', amount: '20000000' }, [TOKEN]), 'A123-11 · Broken mug · 20 tUSDC');
  assert.equal(app.orderLabel({ order_id: 'A123-11', label: 'Broken mug', token: 'tusdc.testnet', amount: '20000000', naive: true }, [TOKEN]), 'A123-11 · Broken mug · 20 tUSDC · badly configured bot');
  assert.equal(app.orderLabel({ order_id: 'A123-03', label: 'Broken mug' }, [TOKEN]), 'A123-03 · Broken mug');
});

test('the bond meter has a NEAR row and a tUSDC row', () => {
  const rows = app.bondMeterRows(
    { bond: '3000000000000000000000000', reserved: '600000000000000000000000', paid_out: '0' },
    [{ token: null, bond: '3000000000000000000000000', reserved: '600000000000000000000000', paid_out: '0' },
      { token: 'tusdc.testnet', bond: '20000000', reserved: '6000000', paid_out: '4000000' }],
    [TOKEN],
  );
  assert.deepEqual(rows.map(r => r.label), [
    'bond NEAR', 'reserved NEAR', 'free NEAR', 'paid_out NEAR',
    'bond tUSDC', 'reserved tUSDC', 'free tUSDC', 'paid_out tUSDC',
  ]);
  assert.deepEqual(rows.map(r => r.value), [
    '3.000 NEAR', '0.600 NEAR', '2.400 NEAR', '0.000 NEAR',
    '20 tUSDC', '6 tUSDC', '14 tUSDC', '4 tUSDC',
  ]);
  // A rendered meter keeps both assets (the fake element concatenates its children).
  const el = makeEl('div');
  globalThis.document = { createElement: tag => makeEl(tag) };
  try {
    app.renderBondMeter(el, { bond: '3000000000000000000000000', reserved: '0', paid_out: '0' }, { bonds: [{ token: 'tusdc.testnet', bond: '20000000', reserved: '0', paid_out: '0' }], tokens: [TOKEN] });
  } finally {
    delete globalThis.document;
  }
  assert.match(el.textContent, /bond NEAR3\.000 NEAR/);
  assert.match(el.textContent, /bond tUSDC20 tUSDC/);
});

test('the unregistered-buyer notice names the token and the account, and never blocks the claim', () => {
  const notice = app.buyerRegistrationNotice({ symbol: 'tUSDC' }, 'cbp-bob-sm1110.testnet');
  assert.match(notice, /register on tUSDC first/);
  assert.match(notice, /cbp-bob-sm1110\.testnet/);
  assert.equal(app.buyerRegistrationNotice(null, 'x'), null);
});

test('v2 receipt/preview calls carry merchant; v1 keeps the old arguments', async () => {
  const responseB64 = Buffer.from('hello').toString('base64');
  const hash = await app.sha256Hex(new TextEncoder().encode('hello'));
  await withFetch((call) => {
    if (call.url === '/api/config') return jsonResponse(V2_CONFIG);
    const method = decodeMethod(call);
    return method === 'get_receipt' ? rpcResponse({ order_id: 'A123-11' }) : rpcResponse({ ok: true, payout: '1' });
  }, async (calls) => {
    await app.loadConfig();
    await app.bindingStatus('A123-11', responseB64);
    assert.deepEqual(decodeArgs(calls[1]), { merchant: 'cbp-shop-sm1110.testnet', response_hash: hash });
    assert.deepEqual(decodeArgs(calls[2]), { merchant: 'cbp-shop-sm1110.testnet', order_id: 'A123-11', response_b64: responseB64 });
  });

  const V1_CONFIG = { ...V2_CONFIG, contract_api: 1 };
  delete V1_CONFIG.tokens;
  await withFetch((call) => {
    if (call.url === '/api/config') return jsonResponse(V1_CONFIG);
    return decodeMethod(call) === 'get_receipt' ? rpcResponse({ order_id: 'A123-11' }) : rpcResponse({ ok: true, payout: '1' });
  }, async (calls) => {
    await app.loadConfig();
    await app.bindingStatus('A123-11', responseB64);
    assert.deepEqual(decodeArgs(calls[1]), { response_hash: hash });
    assert.deepEqual(decodeArgs(calls[2]), { order_id: 'A123-11', response_b64: responseB64 });
  });
});

test('a v2 page submits a token order, formats 4 tUSDC, shows the expiry and the unregistered-buyer line', async () => {
  const els = fakePage();
  const config = {
    ...V2_CONFIG,
    orders: [{ ...V2_CONFIG.orders[0], expires_at_ms: String(Date.now() + 30 * 60_000 + 30_000) }],
  };
  await withFetch((call) => {
    if (call.url === '/api/config') return jsonResponse(config);
    if (call.url === '/api/chat') return jsonResponse({ reply: REPLY, bundle: BUNDLE, register_tx: 'reg1', explorer: 'https://testnet.nearblocks.io/txns/reg1' });
    const method = decodeMethod(call);
    if (method === 'get_merchant') return rpcResponse({ bond: '3000000000000000000000000', reserved: '600000000000000000000000', paid_out: '0' });
    if (method === 'get_bonds') return rpcResponse([
      { token: null, bond: '3000000000000000000000000', reserved: '600000000000000000000000', paid_out: '0' },
      { token: 'tusdc.testnet', bond: '20000000', reserved: '6000000', paid_out: '0' },
    ]);
    if (method === 'get_receipt') return rpcResponse({ order_id: 'A123-11', token: 'tusdc.testnet' });
    if (method === 'preview_claim') return rpcResponse({ ok: true, token_bps: 2000, paid_bps: 2000, payout: '4000000', token: 'tusdc.testnet' });
    if (method === 'storage_balance_of') return rpcResponse(null);
    throw new Error(`unexpected method ${method}`);
  }, async (calls) => {
    try {
      await import('../../web/app.js?stablecoin-ui');
      for (let i = 0; i < 200 && els['order-select'].children.length === 0; i++) await new Promise(r => setTimeout(r, 0));
      assert.equal(els['order-select'].children[0].textContent, 'A123-11 · Broken mug · 20 tUSDC');

      els['chat-input'].value = 'my mug broke';
      await els['chat-form'].listeners.submit({ preventDefault() {} });

      const bot = els['chat-log'].children[1];
      assert.equal(bot.statusBadge.className, 'badge binding');
      assert.match(bot.statusBadge.textContent, /^BINDING · claimable 4 tUSDC · expires in 30m$/);
      assert.ok(bot.claimButton, 'the unregistered buyer can still try to claim (safe failure)');
      const notice = bot.children[1].children.find(c => String(c.className).includes('warning'));
      assert.ok(notice, 'the page adds the unregistered-buyer line');
      assert.match(notice.textContent, /register on tUSDC first/);
      assert.match(notice.textContent, /cbp-alice-sm1110\.testnet/);

      const storageCall = calls.find(c => c.url === V2_CONFIG.rpcUrl && decodeMethod(c) === 'storage_balance_of');
      assert.equal(JSON.parse(storageCall.opts.body).params.account_id, 'tusdc.testnet');
      assert.deepEqual(decodeArgs(storageCall), { account_id: 'cbp-alice-sm1110.testnet' });

      // the meter has the NEAR and the tUSDC rows
      const meter = els['bond-meter'].children.map(c => c.textContent);
      assert.deepEqual(meter.slice(0, 2), ['bond NEAR', '3.000 NEAR']);
      assert.deepEqual(meter.slice(8, 10), ['bond tUSDC', '20 tUSDC']);
    } finally {
      delete globalThis.document;
    }
  });
});


test('a token order is hidden when the config has no metadata for its token', async () => {
  const els = fakePage();
  const config = { ...V2_CONFIG, tokens: [], orders: [{ order_id: 'A1', label: 'x', token: 'tusdc.testnet' }] };
  await withFetch((call) => {
    if (call.url === '/api/config') return jsonResponse(config);
    const method = decodeMethod(call);
    if (method === 'get_merchant') return rpcResponse({ bond: '1', reserved: '0', paid_out: '0' });
    if (method === 'get_bonds') return rpcResponse([]);
    throw new Error(`unexpected method ${method}`);
  }, async () => {
    try {
      await import('../../web/app.js?stablecoin-hidden');
      for (let i = 0; i < 200 && els['order-select'].children.length === 0; i++) await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 10));
      assert.equal(els['order-select'].children.length, 0, 'a token order with no token metadata is not shown');
    } finally {
      delete globalThis.document;
    }
  });
});

test('replay of a v2 token recording shows the bond meter as a token row, and loads the transcript from the config url', async () => {
  const els = fakePage();
  const tokenView = { token: TOKEN.id, bond: '94000000', reserved: '0', paid_out: '6000000' };
  const transcript = { type: 'bot-promises/replay/v2', steps: [{ kind: 'chat', order_id: 'A123-11', views: { get_merchant: tokenView } }] };
  const config = { ...V2_CONFIG, mode: 'replay', transcript_url: '/fixtures/replay/transcript-v2.json' };
  const real = globalThis.location;
  globalThis.location = new URL('http://127.0.0.1:8787/?offline=1');
  try {
    const offline = await import('../../web/app.js?stablecoin-replay-meter');
    const urls = [];
    await withFetch((call) => {
      urls.push(call.url);
      return jsonResponse(call.url === '/api/config' ? config : transcript);
    }, async () => {
      await offline.loadConfig();
      await offline.loadReplayTranscript();
      await offline.refreshBondMeter();
    });
    assert.ok(urls.includes('/fixtures/replay/transcript-v2.json'), `transcript loaded from ${urls.join(', ')}`);
    const meter = els['bond-meter'].children.map(c => c.textContent);
    assert.deepEqual(meter.slice(0, 2), ['bond tUSDC', '94 tUSDC']);
    assert.ok(!meter.includes('bond NEAR'), 'no NEAR row for a token-only recording');
  } finally {
    globalThis.location = real;
    delete globalThis.document;
  }
});
