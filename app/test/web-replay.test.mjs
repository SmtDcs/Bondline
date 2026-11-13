// The web page on the replay server with ?offline=1. Drives web/app.js with a minimal
// document (jsdom is not a dependency) and a fetch stub that REFUSES any URL
// outside localhost: every beat must run from the recorded transcript alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { explorerTx } from '../lib/near.mjs';

globalThis.location = new URL('http://127.0.0.1:8787/?offline=1');

const TRANSCRIPT_FILE = 'fixtures/replay/transcript.json';
const transcript = JSON.parse(fs.readFileSync(TRANSCRIPT_FILE, 'utf8'));
const readBundle = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const chatSteps = transcript.steps.filter(s => s.kind === 'chat');
const claimSteps = transcript.steps.filter(s => s.kind === 'claim');
const editedStep = transcript.steps.find(s => s.kind === 'register-edited');
const replyOf = (bundle) => JSON.parse(Buffer.from(bundle.response_b64, 'base64').toString('utf8')).choices[0].message.content;

const orders = [...new Set(chatSteps.map(s => s.order_id))].map((order_id) => {
  const bundle = readBundle(chatSteps.find(s => s.order_id === order_id).bundle_file);
  const request = JSON.parse(Buffer.from(bundle.request_b64, 'base64').toString('utf8'));
  const system = request.messages.find(m => m.role === 'system').content;
  return { order_id, ...(system.includes('The customer is always right') ? { naive: true } : {}) };
});
const CONFIG = {
  mode: 'replay',
  network: 'testnet',
  rpcUrl: 'https://test.rpc.fastnear.com',
  contractId: transcript.contract,
  merchantId: chatSteps[0].views.get_order.merchant,
  buyerId: chatSteps[0].views.get_order.buyer,
  model: readBundle(chatSteps[0].bundle_file).model,
  orders,
};
const PRE_CLAIM_MERCHANT = chatSteps[0].views.get_merchant;
const MERCHANT = chatSteps.at(-1).views.get_merchant;
const near = (yocto) => (Number(BigInt(yocto) / 10n ** 21n) / 1000).toFixed(3);
const meterText = (m) => [
  'bond', `${near(m.bond)} NEAR`,
  'reserved', `${near(m.reserved)} NEAR`,
  'free', `${near(BigInt(m.bond) - BigInt(m.reserved))} NEAR`,
  'paid_out', `${near(m.paid_out)} NEAR`,
];

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

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
    if (!call.url.startsWith('/')) throw new Error(`unexpected network call to ${call.url}`);
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

const submit = (els) => els['chat-form'].listeners.submit({ preventDefault() {} });

test('?offline=1 replay runs every beat from the transcript, with no testnet call', async () => {
  const { els, body } = fakePage();
  const claimed = new Set();
  let claimPosts = 0;
  const { calls, restore } = stubFetch((call) => {
    if (call.url === '/api/config') return jsonResponse(CONFIG);
    if (call.url === '/fixtures/replay/transcript.json') return jsonResponse(transcript);
    if (call.url === '/api/chat') {
      const orderId = JSON.parse(call.opts.body).order_id;
      const step = chatSteps.find(s => s.order_id === orderId);
      const bundle = readBundle(step.bundle_file);
      return jsonResponse({
        reply: replyOf(bundle), bundle, register_tx: step.register_tx,
        explorer: explorerTx(step.register_tx), views: step.views,
      });
    }
    if (call.url === '/api/demo/claim') {
      claimPosts += 1;
      const { order_id } = JSON.parse(call.opts.body);
      if (!claimed.has(order_id)) {
        claimed.add(order_id);
        const step = claimSteps.find(s => s.order_id === order_id);
        return jsonResponse({ ok: true, result: step.result, claim_tx: step.claim_tx, explorer: explorerTx(step.claim_tx) });
      }
      return jsonResponse({ error: 'ERR_ALREADY_CLAIMED', detail: 'replay: already claimed', tx: null }, 400);
    }
    if (call.url === '/api/demo/register-edited') {
      return jsonResponse({
        error: 'ERR_BAD_SIGNATURE',
        detail: 'replay: the recorded merchant attempt failed',
        tx: editedStep.tx,
        explorer: explorerTx(editedStep.tx),
      }, 400);
    }
    throw new Error(`unexpected localhost endpoint ${call.url}`);
  });

  try {
    const app = await import('../../web/app.js?replay-offline');
    await waitFor(() => els['order-select'].children.length === chatSteps.length);

    // Orange badge with the transcript date, contract link, orders from the steps.
    assert.equal(els['mode-badge'].className, 'badge replay');
    // The committed transcript marks its recomputed views, so the badge says they were recomputed.
    assert.equal(transcript.computed_views, true);
    assert.equal(els['mode-badge'].textContent, `REPLAY of a real testnet run recorded ${transcript.recorded_at.slice(0, 10)} · BINDING/Tamper badges and the pre-claim meter recomputed from the recorded bytes`);
    assert.equal(els['contract-link'].children[0].href, `https://testnet.nearblocks.io/address/${transcript.contract}`);
    assert.deepEqual(els['order-select'].children.map(o => o.value), chatSteps.map(s => s.order_id));
    assert.equal(els['order-select'].children[1].textContent, `${chatSteps[1].order_id} · badly configured bot`);

    // The first order is selected and its recorded message pre-filled.
    assert.equal(els['order-select'].value, chatSteps[0].order_id);
    assert.equal(els['chat-input'].value, chatSteps[0].message);

    // The initial bond meter is the first chat step's PRE-CLAIM view (8.2 bond / 6.0 reserved).
    assert.deepEqual(els['bond-meter'].children.map(c => c.textContent), meterText(PRE_CLAIM_MERCHANT));
    assert.notDeepEqual(PRE_CLAIM_MERCHANT, MERCHANT);

    // Honest chat beat: the recorded reply comes back with the pre-claim BINDING badge.
    await submit(els);
    let chatPost = calls.find(c => c.url === '/api/chat');
    assert.deepEqual(JSON.parse(chatPost.opts.body), { order_id: chatSteps[0].order_id, message: chatSteps[0].message });
    let bot = els['chat-log'].children[1];
    assert.equal(bot.statusBadge.className, 'badge binding');
    assert.equal(bot.statusBadge.textContent, 'BINDING · claimable 0.400 NEAR');
    assert.equal(bot.children[0].children.at(-1).textContent, `PROMISE|refund|order=${chatSteps[0].order_id}|bps=2000`);
    assert.ok(bot.claimButton, 'a BINDING bubble on the replay server is claimable');

    // Tamper beat (before the claim, as recorded): the transcript's tamper views drive the badge.
    const editedB64 = app.tamperResponseB64(bot.bundle.response_b64);
    const editedHash = await app.sha256Hex(Uint8Array.from(Buffer.from(editedB64, 'base64')));
    assert.equal(chatSteps[0].views.tamper.response_hash, editedHash, 'the transcript records exactly the page edit');
    await bot.tamperButton.listeners.click();
    assert.equal(bot.statusBadge.className, 'badge error');
    assert.equal(bot.statusBadge.textContent, 'ERR_NO_RECEIPT_FOR_BYTES');
    assert.equal(bot.tamperResult.children[0].textContent, 'ERR_NO_RECEIPT_FOR_BYTES');

    // Claim beat: recorded payout. Like live mode, the paid claim shows CLAIMED (green), not the
    // chat-time BINDING view and not an error.
    await bot.claimButton.listeners.click();
    assert.equal(claimPosts, 1);
    assert.equal(body.children.at(-1).textContent, 'paid 0.400 NEARclaim tx');
    assert.equal(body.children.at(-1).children[1].href, explorerTx(claimSteps[0].claim_tx));
    assert.equal(bot.statusBadge.className, 'badge binding');
    assert.equal(bot.statusBadge.textContent, 'CLAIMED · paid 0.400 NEAR');
    // Audit relayer-web-secrets-4: after ONE claim the meter shows only that claim (bond -0.4, reserved -0.6,
    // paid_out +0.4), not the post-run view that already includes the A124 claim.
    assert.deepEqual(els['bond-meter'].children.map(c => c.textContent), ['bond', '7.800 NEAR', 'reserved', '5.400 NEAR', 'free', '2.400 NEAR', 'paid_out', '5.200 NEAR']);

    // The second click is the replay server's 400 ERR_ALREADY_CLAIMED.
    await bot.claimButton.listeners.click();
    assert.equal(claimPosts, 2);
    assert.equal(bot.statusBadge.className, 'badge error');
    assert.equal(bot.statusBadge.textContent, 'ERR_ALREADY_CLAIMED');

    // Injection chat beat: the pre-filled naive message is sent, the capped reply comes back.
    els['order-select'].value = chatSteps[1].order_id;
    els['order-select'].listeners.change();
    assert.equal(els['chat-input'].value, chatSteps[1].message);
    await submit(els);
    chatPost = calls.filter(c => c.url === '/api/chat').at(-1);
    assert.deepEqual(JSON.parse(chatPost.opts.body), { order_id: chatSteps[1].order_id, message: chatSteps[1].message });
    bot = els['chat-log'].children.at(-1);
    assert.equal(bot.statusBadge.className, 'badge binding');
    assert.equal(bot.statusBadge.textContent, 'BINDING · claimable 0.600 NEAR · token 100% → paid 30% (cap)');
    assert.equal(bot.children[0].children.at(-1).textContent, `PROMISE|refund|order=${chatSteps[1].order_id}|bps=10000`);

    // Injection claim: recorded payout, shown as CLAIMED.
    await bot.claimButton.listeners.click();
    assert.equal(claimPosts, 3);
    assert.equal(body.children.at(-1).textContent, 'paid 0.600 NEARclaim tx');
    assert.equal(body.children.at(-1).children[1].href, explorerTx(claimSteps[1].claim_tx));
    assert.equal(bot.statusBadge.textContent, 'CLAIMED · paid 0.600 NEAR');
    // Both recorded claims replayed: now the meter is the recorded post-run view.
    assert.deepEqual(els['bond-meter'].children.map(c => c.textContent), meterText(MERCHANT));

    // Merchant beat: the recorded failed registration with its tx.
    await els['btn-register-edited'].listeners.click();
    const entry = els['merchant-log'].children.at(-1);
    assert.equal(entry.className, 'entry error');
    assert.equal(entry.children[0].textContent, 'ERR_BAD_SIGNATURE');
    assert.equal(entry.children.find(c => c.tagName === 'A').href, explorerTx(editedStep.tx));

    // Everything above went through the replay server on localhost only.
    assert.ok(calls.length > 0);
    assert.ok(calls.every(c => c.url.startsWith('/')), 'no testnet RPC call in ?offline=1 replay');
  } finally {
    restore();
    delete globalThis.document;
  }
});

test('replay helpers read the transcript fields (initial meter, final meter, recorded tamper)', async () => {
  const app = await import('../../web/app.js?replay-helpers');
  assert.equal(app.replayBadgeText({ recorded_at: '2026-11-10T04:54:32.622Z' }), 'REPLAY of a real testnet run recorded 2026-11-10');
  assert.equal(app.replayBadgeText(null), 'REPLAY of a real testnet run');
  assert.equal(app.replayMessageFor(transcript, chatSteps[0].order_id), chatSteps[0].message);
  assert.equal(app.replayMessageFor(transcript, 'NOPE-99'), null);
  assert.deepEqual(app.replayInitialMerchantView(transcript), PRE_CLAIM_MERCHANT);
  assert.deepEqual(app.replayMerchantView(transcript), MERCHANT);
  const tamper = chatSteps[0].views.tamper;
  assert.ok(tamper, 'the transcript records a tamper view');
  assert.deepEqual(app.recordedTamperViews(chatSteps[0].views, tamper.response_hash), tamper);
  assert.equal(app.recordedTamperViews(chatSteps[0].views, '0'.repeat(64)), null);
});
