// Tamper button (edit the exact reply bytes -> ERR_NO_RECEIPT_FOR_BYTES + both hashes) and
// the double-claim beat (the Claim button stays clickable, the second click shows the 400
// ERR_ALREADY_CLAIMED). jsdom is not a dependency, so this drives web/app.js with
// a minimal document, exactly like app/test/web-merchant.test.mjs does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

globalThis.location = new URL('http://127.0.0.1:8787/');

const CONFIG = {
  mode: 'live',
  network: 'testnet',
  rpcUrl: 'https://rpc.testnet.fastnear.com',
  contractId: 'cbp-sm1110.testnet',
  merchantId: 'cbp-shop-sm1110.testnet',
  buyerId: 'cbp-alice-sm1110.testnet',
  model: 'z-ai/glm-5.3-flash',
  orders: [{ order_id: 'A123-06', label: 'Broken mug' }],
};

const HONEST = 'My mug from order A123-06 arrived broken. Can I get a partial refund?';
const REPLY = 'Sorry about the broken mug. I can offer a 20% refund on order A123-06.\nPROMISE|refund|order=A123-06|bps=2000';
const REPLY_BYTES = Buffer.from(JSON.stringify({ choices: [{ message: { content: REPLY } }] }), 'utf8');
const RESPONSE_B64 = REPLY_BYTES.toString('base64');
const RESPONSE_HASH = createHash('sha256').update(REPLY_BYTES).digest('hex');
const BUNDLE = {
  type: 'bot-promises/receipt-bundle/v1', simulated: false, order_id: 'A123-06',
  response_b64: RESPONSE_B64, response_hash: RESPONSE_HASH,
};
const MERCHANT = { bond: '4600000000000000000000000', reserved: '3600000000000000000000000', paid_out: '2400000000000000000000000' };

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const rpcResponse = (value) => jsonResponse({ jsonrpc: '2.0', id: 'cbp', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } });
const decodeArgs = (call) => JSON.parse(Buffer.from(JSON.parse(call.opts.body).params.args_base64, 'base64').toString());
const methodOf = (call) => JSON.parse(call.opts.body).params.method_name;
const hash12 = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    value: '',
    href: '',
    target: '',
    rel: '',
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
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
    'merchant-log', 'bond-meter', 'btn-register-edited', 'deny-box', 'footer'];
  const els = Object.fromEntries(ids.map(id => [id, makeEl(id)]));
  const body = makeEl('body');
  globalThis.document = { getElementById: id => els[id] ?? null, createElement: tag => makeEl(tag), body };
  return { els, body };
}

function stubFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const call = { url: String(url), opts };
    calls.push(call);
    return handler(call);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

async function waitFor(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 0));
  }
  throw new Error('timed out waiting for the page');
}

async function submit(els, message) {
  els['chat-input'].value = message;
  els['order-select'].value = 'A123-06';
  await els['chat-form'].listeners.submit({ preventDefault() {} });
}

/** Live-mode stub: the honest bytes are BINDING, the tampered bytes have no receipt. */
function liveHandler({ tamperedB64 = () => null } = {}) {
  return (call) => {
    if (call.url === '/api/config') return jsonResponse(CONFIG);
    if (call.url === '/api/chat') {
      return jsonResponse({ reply: REPLY, bundle: BUNDLE, register_tx: 'reg1', explorer: 'https://testnet.nearblocks.io/txns/reg1' });
    }
    if (call.url === '/api/demo/claim') {
      return jsonResponse({
        ok: true,
        result: { ok: true, token_bps: 2000, paid_bps: 2000, payout: '400000000000000000000000' },
        claim_tx: 'claim1',
        explorer: 'https://testnet.nearblocks.io/txns/claim1',
      });
    }
    const method = methodOf(call);
    if (method === 'get_merchant') return rpcResponse(MERCHANT);
    if (method === 'get_receipt') {
      return rpcResponse(decodeArgs(call).response_hash === RESPONSE_HASH ? { order_id: 'A123-06', response_hash: RESPONSE_HASH } : null);
    }
    // preview_claim
    if (decodeArgs(call).response_b64 === tamperedB64()) {
      return rpcResponse({ ok: false, error: 'ERR_NO_RECEIPT_FOR_BYTES', token_bps: 0, paid_bps: 0, payout: '0' });
    }
    return rpcResponse({ ok: true, token_bps: 2000, paid_bps: 2000, payout: '400000000000000000000000' });
  };
}

test('tamperText rewrites bps=2000 to bps=3000 and otherwise the first bps digit to 3', async () => {
  const app = await import('../../web/app.js?tamper-text');
  assert.equal(app.tamperText('PROMISE|refund|order=A123-06|bps=2000'), 'PROMISE|refund|order=A123-06|bps=3000');
  // Only the first bps=2000 is changed, and the rest of the bytes stay identical.
  assert.equal(app.tamperText('a bps=2000 b bps=2000'), 'a bps=3000 b bps=2000');
  // No bps=2000 (injection reply): the first digit after bps= becomes 3.
  assert.equal(app.tamperText('PROMISE|refund|order=A124-06|bps=10000'), 'PROMISE|refund|order=A124-06|bps=30000');
  assert.equal(app.tamperText('no token here'), null);
  assert.equal(app.tamperText('bps=x'), null);
});

test('tamperResponseB64 decodes the exact bundle bytes, edits the token and re-encodes', async () => {
  const app = await import('../../web/app.js?tamper-b64');
  const edited = app.tamperResponseB64(RESPONSE_B64);
  const text = Buffer.from(edited, 'base64').toString('utf8');
  assert.equal(text, REPLY_BYTES.toString('utf8').replace('bps=2000', 'bps=3000'));
  assert.notEqual(edited, RESPONSE_B64);
  assert.equal(app.tamperResponseB64(Buffer.from('no token').toString('base64')), null);
});

test('every bot bubble gets a Tamper button; clicking it shows ERR_NO_RECEIPT_FOR_BYTES and both hashes', async () => {
  const { els, body } = fakePage();
  const editedB64 = Buffer.from(REPLY_BYTES.toString('utf8').replace('bps=2000', 'bps=3000'), 'utf8').toString('base64');
  const { calls, restore } = stubFetch(liveHandler({ tamperedB64: () => editedB64 }));
  try {
    const app = await import('../../web/app.js?tamper-dom');
    assert.equal(app.tamperResponseB64(RESPONSE_B64), editedB64, 'the button sends exactly these edited bytes');
    await waitFor(() => els['order-select'].children.length > 0);
    await submit(els, HONEST);

    const bot = els['chat-log'].children[1];
    assert.ok(bot.tamperButton, 'bot bubble has a Tamper button');
    assert.equal(bot.tamperButton.textContent, 'Tamper');
    assert.equal(bot.tamperButton.className, 'tamper');
    assert.equal(bot.tamperButton.disabled, false);

    await bot.tamperButton.listeners.click();

    // The page asked the contract about the EDITED bytes.
    const preview = calls.filter(c => c.url === CONFIG.rpcUrl && methodOf(c) === 'preview_claim').at(-1);
    assert.equal(decodeArgs(preview).response_b64, editedB64);
    assert.equal(Buffer.from(decodeArgs(preview).response_b64, 'base64').toString('utf8').includes('bps=3000'), true);
    const receipt = calls.filter(c => c.url === CONFIG.rpcUrl && methodOf(c) === 'get_receipt').at(-1);
    assert.notEqual(decodeArgs(receipt).response_hash, RESPONSE_HASH, 'the edited hash has no receipt');

    assert.equal(bot.statusBadge.className, 'badge error');
    assert.equal(bot.statusBadge.textContent, 'ERR_NO_RECEIPT_FOR_BYTES');

    const result = bot.tamperResult;
    assert.ok(result, 'the bubble shows a tamper result line');
    assert.equal(result.children[0].className, 'badge error');
    assert.equal(result.children[0].textContent, 'ERR_NO_RECEIPT_FOR_BYTES');
    const editedBytes = Buffer.from(editedB64, 'base64');
    assert.equal(result.children[1].textContent, `orig ${hash12(REPLY_BYTES)} · edited ${hash12(editedBytes)}`);
    assert.notEqual(hash12(REPLY_BYTES), hash12(editedBytes));
    assert.equal(bot.tamperButton.disabled, false, 'Tamper stays clickable');
    assert.equal(body.children.length, 0, 'no error toast on a successful tamper');
  } finally {
    restore();
    delete globalThis.document;
  }
});

test('after a claim the Claim button stays clickable and the second click shows the 400 ERR_ALREADY_CLAIMED', async () => {
  const { els, body } = fakePage();
  const editedB64 = Buffer.from(REPLY_BYTES.toString('utf8').replace('bps=2000', 'bps=3000'), 'utf8').toString('base64');
  let claimPosts = 0;
  const handler = (call) => {
    if (call.url === '/api/demo/claim') {
      claimPosts += 1;
      if (claimPosts === 1) {
        return jsonResponse({
          ok: true,
          result: { ok: true, token_bps: 2000, paid_bps: 2000, payout: '400000000000000000000000' },
          claim_tx: 'claim1',
          explorer: 'https://testnet.nearblocks.io/txns/claim1',
        });
      }
      return jsonResponse({ error: 'ERR_ALREADY_CLAIMED', detail: 'tx claim2 failed', tx: 'claim2', explorer: 'https://testnet.nearblocks.io/txns/claim2' }, 400);
    }
    // Keep the views stale-BINDING on purpose: the red text must come from the 400 response.
    return liveHandler({ tamperedB64: () => editedB64 })(call);
  };
  const { calls, restore } = stubFetch(handler);
  try {
    await import('../../web/app.js?double-claim');
    await waitFor(() => els['order-select'].children.length > 0);
    await submit(els, HONEST);

    const bot = els['chat-log'].children[1];
    assert.equal(bot.statusBadge.textContent, 'BINDING · claimable 0.400 NEAR');
    assert.ok(bot.claimButton, 'BINDING bubble has a Claim button');

    await bot.claimButton.listeners.click();
    assert.equal(claimPosts, 1);
    assert.equal(bot.claimButton.disabled, false, 'claim button re-enabled after the claim');
    assert.equal(body.children.at(-1).children[0].textContent, 'paid 0.400 NEAR');

    await bot.claimButton.listeners.click();
    assert.equal(claimPosts, 2, 'the second click really reached the server');
    assert.equal(bot.statusBadge.className, 'badge error');
    assert.equal(bot.statusBadge.textContent, 'ERR_ALREADY_CLAIMED');
    assert.equal(body.children.at(-1).className, 'toast error');
    assert.equal(body.children.at(-1).children[0].textContent, 'ERR_ALREADY_CLAIMED');
    assert.equal(bot.claimButton.disabled, false, 'and it stays clickable after the 400');

    const posts = calls.filter(c => c.url === '/api/demo/claim');
    assert.equal(posts.length, 2);
    assert.deepEqual(JSON.parse(posts[1].opts.body), { order_id: 'A123-06', response_b64: RESPONSE_B64 });
  } finally {
    restore();
    delete globalThis.document;
  }
});
