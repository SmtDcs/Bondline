let CFG;
const $ = (id) => document.getElementById(id);
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
/** The assistant text inside the exact response bytes (bundle.response_b64). */
export const replyFromBundle = (bundle) =>
  JSON.parse(new TextDecoder().decode(b64ToBytes(bundle.response_b64))).choices[0].message.content;
const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const OFFLINE = new URLSearchParams(location.search).has('offline');
let REPLAY_TRANSCRIPT = null; // T19: recorded run, loaded only when CFG.mode === 'replay'
let REPLAY_CLAIMED = false; // T19: offline replay switches the meter to the recorded post-run state

const BOND_REFRESH_MS = 10_000;
// T16: the merchant's "register edited reply" attempt rewrites the token in the reply bytes.
const EDIT_FROM = 'bps=2000';
const EDIT_TO = 'bps=3000';

export async function rpcView(method, args) {
  const json = JSON.stringify(args);
  const argsB64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  const body = { jsonrpc: '2.0', id: 'cbp', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: CFG.contractId, method_name: method, args_base64: argsB64 } };
  const res = await fetch(CFG.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  if (j.result?.error) throw new Error(j.result.error);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
}
export async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const yoctoToNear = (y) => (Number(BigInt(y) / 10n ** 21n) / 1000).toFixed(3);

/** FROZEN BINDING rule (INTERFACES 4): receipt exists AND preview_claim.ok */
export async function bindingStatus(orderId, responseB64, recordedViews) {
  if (OFFLINE && recordedViews) return { receipt: recordedViews.get_receipt, preview: recordedViews.preview_claim };
  const hash = await sha256Hex(b64ToBytes(responseB64));
  const receipt = await rpcView('get_receipt', { response_hash: hash });
  const preview = await rpcView('preview_claim', { order_id: orderId, response_b64: responseB64 });
  return { hash, receipt, preview };
}
export function badgeText({ receipt, preview }) {
  if (!receipt) return { cls: 'error', text: 'NOT A PROMISE (no receipt on chain)' };
  if (!preview.ok) return { cls: 'error', text: preview.error };
  const capped = preview.token_bps !== preview.paid_bps ? ` · token ${preview.token_bps / 100}% → paid ${preview.paid_bps / 100}% (cap)` : '';
  return { cls: 'binding', text: `BINDING · claimable ${yoctoToNear(preview.payout.toString())} NEAR${capped}` };
}

/** Reads GET /api/config into CFG. The url is overridable so node tests (and the
 *  acceptance check) can drive the same module without a browser. */
export async function loadConfig(url = '/api/config') {
  CFG = await (await fetch(url)).json();
  return CFG;
}

/** T19: the orange badge on the replay server; the date is the transcript's recorded_at. */
export function replayBadgeText(transcript) {
  const date = typeof transcript?.recorded_at === 'string' ? transcript.recorded_at.slice(0, 10) : '';
  return date ? `REPLAY of a real testnet run recorded ${date}` : 'REPLAY of a real testnet run';
}

/** T19: the recorded message for an order (the input is pre-filled with it in replay mode). */
export function replayMessageFor(transcript, orderId) {
  return (transcript?.steps ?? []).find(step => step.kind === 'chat' && step.order_id === orderId)?.message ?? null;
}

/** T19: the first chat step records the pre-claim get_merchant; offline replay starts from it. */
export function replayInitialMerchantView(transcript) {
  return (transcript?.steps ?? []).find(step => step.views?.get_merchant)?.views.get_merchant ?? null;
}

/** T19: the last recorded get_merchant is the final post-run view, shown after a claim. */
export function replayMerchantView(transcript) {
  return [...(transcript?.steps ?? [])].reverse().find(step => step.views?.get_merchant)?.views.get_merchant ?? null;
}

/** T19: the recorded Tamper outcome for exactly these edited bytes (the recorder stores the hash). */
export function recordedTamperViews(views, editedHash) {
  const tamper = views?.tamper;
  return tamper && tamper.response_hash === editedHash ? tamper : null;
}

/** T19: the transcript is public demo data, served by app/server.mjs from /fixtures. */
export async function loadReplayTranscript(url = '/fixtures/replay/transcript.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`transcript HTTP ${res.status}`);
  REPLAY_TRANSCRIPT = await res.json();
  return REPLAY_TRANSCRIPT;
}

const NAIVE_LABEL = 'badly configured bot';

/** PLAN R4: the naive (jailbroken) demo order must be labelled in the UI. */
export function orderLabel(order) {
  const base = order?.label ? `${order.order_id} · ${order.label}` : String(order?.order_id ?? '');
  return order?.naive ? `${base} · ${NAIVE_LABEL}` : base;
}

export function isNaiveOrder(orders, orderId) {
  return (orders ?? []).some(o => o && typeof o === 'object' && o.order_id === orderId && o.naive === true);
}

/** The bot's reply keeps its text, but the PROMISE token line gets its own element. */
export function splitTokenLine(reply) {
  const lines = String(reply ?? '').split('\n');
  const i = lines.findIndex(line => line.includes('PROMISE|'));
  if (i < 0) return { text: lines.join('\n'), token: null };
  return { text: lines.filter((_, j) => j !== i).join('\n').trimEnd(), token: lines[i].trim() };
}

/** T17 tamper beat: rewrite the token's bps to make the exact response bytes different.
 *  First `bps=2000` becomes `bps=3000`; with no `bps=2000`, the first digit after `bps=`
 *  becomes 3 (e.g. `bps=10000` -> `bps=30000`). Returns null when the reply has no bps=. */
export function tamperText(reply) {
  const text = String(reply ?? '');
  if (text.includes('bps=2000')) return text.replace('bps=2000', 'bps=3000');
  const m = /bps=\d/.exec(text);
  if (!m) return null;
  const digit = m.index + 'bps='.length;
  return text.slice(0, digit) + '3' + text.slice(digit + 1);
}

/** T17: edit the decoded bundle.response_b64 and re-encode it (exact edited bytes for bindingStatus). */
export function tamperResponseB64(responseB64) {
  const edited = tamperText(new TextDecoder().decode(b64ToBytes(responseB64)));
  return edited === null ? null : bytesToB64(new TextEncoder().encode(edited));
}

/** Merchant pane meter (T16): bond, reserved, free = bond - reserved, paid_out, 3 decimals. */
export function bondMeterFields(merchant) {
  const bond = BigInt(merchant?.bond ?? 0);
  const reserved = BigInt(merchant?.reserved ?? 0);
  return [
    { label: 'bond', near: yoctoToNear(bond) },
    { label: 'reserved', near: yoctoToNear(reserved) },
    { label: 'free', near: yoctoToNear(bond - reserved) },
    { label: 'paid_out', near: yoctoToNear(merchant?.paid_out ?? 0) },
  ];
}

export function renderBondMeter(el, merchant) {
  if (!el) return;
  if (!merchant) {
    el.textContent = 'merchant not registered';
    return;
  }
  el.replaceChildren(...bondMeterFields(merchant).flatMap(f => [
    element('span', 'meter-label', f.label),
    element('span', 'meter-value', `${f.near} NEAR`),
  ]));
}

export async function refreshBondMeter() {
  if (!CFG) return null;
  // T19: ?offline=1 replay must touch nothing but localhost: use the recorded merchant views.
  // Before the first claim that is the first chat step's pre-claim meter; afterwards the last one.
  if (OFFLINE && CFG.mode === 'replay') {
    const merchant = REPLAY_CLAIMED ? replayMerchantView(REPLAY_TRANSCRIPT) : replayInitialMerchantView(REPLAY_TRANSCRIPT);
    renderBondMeter($('bond-meter'), merchant);
    return merchant;
  }
  const merchant = await rpcView('get_merchant', { merchant: CFG.merchantId });
  renderBondMeter($('bond-meter'), merchant);
  return merchant;
}

/** Toast text for a claim: `paid 0.400 NEAR` (T16 acceptance). */
export function claimToastText(payout) {
  return `paid ${yoctoToNear(payout)} NEAR`;
}

/** One merchant-log row from the register-edited response; red when it is an error. */
export function merchantLogEntry(data = {}, status = 0) {
  if (data.error) {
    return { cls: 'entry error', text: data.error, detail: data.detail ?? null, tx: data.tx ?? null, explorer: data.explorer ?? null };
  }
  return { cls: 'entry', text: `registered on chain: ${data.txHash ?? 'ok'}`, detail: null, tx: null, explorer: null };
}

function element(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function link(text, href) {
  const a = element('a', '', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

function setBadge(badge, { cls, text }) {
  badge.className = `badge ${cls}`;
  badge.textContent = text;
}

function messageRow(role, text) {
  const row = element('div', `msg ${role}`);
  row.append(element('div', 'bubble', text));
  return row;
}

function botMessage() {
  const row = element('div', 'msg bot');
  const bubble = element('div', 'bubble');
  const meta = element('div', 'meta');
  const status = element('span', 'badge pending', 'registering receipt on NEAR…');
  const links = element('span', 'links');
  meta.append(status, links);
  row.append(bubble, meta);
  row.statusBadge = status;
  return { row, bubble, status, meta, links };
}

function renderReply(bubble, reply) {
  const { text, token } = splitTokenLine(reply);
  bubble.textContent = text;
  if (token) bubble.append(element('span', 'token', token));
}

/** Bottom-right toast; `href` adds the claim tx link. Auto-dismiss after 15 s. */
function showToast(text, href, cls = 'toast') {
  const host = document.body ?? $('footer');
  if (!host) return null;
  const el = element('div', cls);
  el.append(element('span', 'toast-text', text));
  if (href) el.append(link('claim tx', href));
  host.append(el);
  const timer = setTimeout(() => el.remove?.(), 15_000);
  timer?.unref?.();
  return el;
}

function lastBotRow() {
  const log = $('chat-log');
  if (!log) return null;
  const rows = [...log.children];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].className).includes('bot')) return rows[i];
  }
  return null;
}

/** T16: the merchant can only act on the last bot bubble, and only once it has a bundle. */
function updateRegisterEdited() {
  const btn = $('btn-register-edited');
  if (!btn) return;
  btn.disabled = !lastBotRow()?.bundle;
}

function addMerchantEntry(entry) {
  const log = $('merchant-log');
  if (!log) return;
  const box = element('div', entry.cls);
  box.append(element('strong', '', entry.text));
  if (entry.detail) box.append(element('div', 'mono', entry.detail));
  if (entry.tx != null) box.append(link('failed tx', entry.explorer ?? `https://testnet.nearblocks.io/txns/${entry.tx}`));
  log.append(box);
  log.scrollTop = log.scrollHeight;
}

function addClaim(row) {
  if (row.claimButton) return;
  const btn = element('button', 'claim', 'Claim');
  btn.addEventListener('click', () => claim(row, btn));
  row.claimButton = btn;
  row.append(btn);
}

async function claim(row, btn) {
  const bundle = row.bundle;
  btn.disabled = true;
  let failed = false;
  try {
    const res = await fetch('/api/demo/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: row.orderId, response_b64: bundle.response_b64 }),
    });
    const data = await res.json();
    if (!res.ok) {
      failed = true;
      setBadge(row.statusBadge, { cls: 'error', text: data.error ?? `HTTP ${res.status}` });
      showToast(data.error ?? `HTTP ${res.status}`, null, 'toast error');
      return;
    }
    showToast(claimToastText(data.result.payout), data.explorer);
  } catch (err) {
    failed = true;
    showToast(err.message, null, 'toast error');
  } finally {
    // T17: the button stays clickable after a claim; a second click shows the 400 ERR_ALREADY_CLAIMED.
    btn.disabled = false;
    if (!failed) {
      if (OFFLINE && CFG?.mode === 'replay') {
        // T19: live mode re-runs preview_claim after the claim and gets ERR_ALREADY_CLAIMED; the
        // transcript's views were recorded before the claim, so show the same post-claim error.
        REPLAY_CLAIMED = true;
        setBadge(row.statusBadge, { cls: 'error', text: 'ERR_ALREADY_CLAIMED' });
      } else {
        try {
          const views = await bindingStatus(row.orderId, bundle.response_b64, row.views);
          setBadge(row.statusBadge, badgeText(views));
        } catch (err) {
          setBadge(row.statusBadge, { cls: 'error', text: err.message });
        }
      }
    }
    await refreshBondMeter().catch(() => {});
  }
}

function addTamper(row) {
  if (row.tamperButton) return;
  const btn = element('button', 'tamper', 'Tamper');
  btn.addEventListener('click', () => tamper(row, btn));
  row.tamperButton = btn;
  row.append(btn);
}

/** T17: tamper the reply bytes, ask the contract about the edited bytes, show the badge + hashes. */
async function tamper(row, btn) {
  const editedB64 = tamperResponseB64(row.bundle.response_b64);
  if (editedB64 === null) {
    showToast('nothing to tamper: the reply has no bps=', null, 'toast error');
    return;
  }
  btn.disabled = true;
  try {
    const originalHash = row.bundle.response_hash ?? await sha256Hex(b64ToBytes(row.bundle.response_b64));
    const editedHash = await sha256Hex(b64ToBytes(editedB64));
    // T19: offline replay must not touch testnet; use the Tamper outcome the transcript recorded
    // for exactly these edited bytes (hash-checked, so a different edit is not silently "failed").
    let offlineEdited;
    if (OFFLINE && CFG?.mode === 'replay') {
      offlineEdited = recordedTamperViews(row.views, editedHash);
      if (!offlineEdited) throw new Error('no recorded tamper view for these bytes');
    }
    const views = await bindingStatus(row.orderId, editedB64, offlineEdited);
    // Surface the preview error (ERR_NO_RECEIPT_FOR_BYTES in the recorded run) instead of
    // badgeText's "NOT A PROMISE" (which is for replies that were never registered at all).
    const view = views.preview.ok ? badgeText(views) : { cls: 'error', text: views.preview.error };
    setBadge(row.statusBadge, view);
    showTamperResult(row, view, originalHash, editedHash);
  } catch (err) {
    setBadge(row.statusBadge, { cls: 'error', text: err.message });
  } finally {
    btn.disabled = false;
  }
}

function showTamperResult(row, view, originalHash, editedHash) {
  const box = row.tamperResult ?? element('div', 'tamper-result');
  box.replaceChildren(
    element('span', `badge ${view.cls}`, view.text),
    element('span', 'hash', `orig ${originalHash.slice(0, 12)} · edited ${editedHash.slice(0, 12)}`),
  );
  if (!row.tamperResult) {
    row.tamperResult = box;
    row.append(box);
  }
}

async function onRegisterEdited() {
  const row = lastBotRow();
  if (!row?.bundle) return;
  const btn = $('btn-register-edited');
  btn.disabled = true;
  try {
    const res = await fetch('/api/demo/register-edited', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: row.orderId, bundle: row.bundle, edit: { from: EDIT_FROM, to: EDIT_TO } }),
    });
    const data = await res.json();
    addMerchantEntry(merchantLogEntry(data, res.status));
  } catch (err) {
    addMerchantEntry(merchantLogEntry({ error: err.message }, 0));
  } finally {
    updateRegisterEdited();
    await refreshBondMeter().catch(() => {});
  }
}

async function onSubmit(event) {
  event.preventDefault();
  const input = $('chat-input');
  const message = input.value.trim();
  if (!message) return;
  const orderId = $('order-select').value;
  const log = $('chat-log');
  log.append(messageRow('user', message));
  const bot = botMessage();
  log.append(bot.row);
  log.scrollTop = log.scrollHeight;
  input.value = '';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId, message }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    bot.row.bundle = data.bundle;
    bot.row.orderId = orderId;
    bot.row.views = data.views; // T19 replay: the recorded views drive ?offline=1
    bot.bubble.bundle = data.bundle;
    // Show the text of the verified bytes (the ones BINDING hashes and claim uses), never the relayer's
    // separate data.reply string.
    const shown = replyFromBundle(data.bundle);
    if (typeof data.reply === 'string' && data.reply !== shown) bot.meta.append(element('span', 'badge naive', 'relayer text differed from the signed bytes'));
    renderReply(bot.bubble, shown);
    if (data.explorer) bot.links.append(link('receipt tx', data.explorer));
    if (data.bundle?.simulated) bot.meta.append(element('span', 'badge simulated', 'SIMULATED'));
    // PLAN R4: say out loud that this order's bot is the badly configured one.
    if (isNaiveOrder(CFG.orders, orderId)) bot.meta.append(element('span', 'badge naive', NAIVE_LABEL));
    updateRegisterEdited();
    // T17: every bot bubble can be tampered with, whatever the BINDING check said.
    addTamper(bot.row);
    const views = await bindingStatus(orderId, data.bundle.response_b64, data.views);
    const view = badgeText(views);
    setBadge(bot.status, view);
    if (view.cls === 'binding') addClaim(bot.row);
  } catch (err) {
    setBadge(bot.status, { cls: 'error', text: err.message });
    updateRegisterEdited();
  }
  await refreshBondMeter().catch(() => {});
}

async function init() {
  const cfg = await loadConfig();
  if (cfg.mode === 'replay') {
    await loadReplayTranscript().catch(() => {}); // badge/pre-fill fall back gracefully without it
    const badge = $('mode-badge');
    badge.className = 'badge replay';
    badge.textContent = replayBadgeText(REPLAY_TRANSCRIPT);
  } else {
    $('mode-badge').textContent = cfg.mode;
  }
  $('contract-link').replaceChildren(link(cfg.contractId, `https://testnet.nearblocks.io/address/${cfg.contractId}`));
  const select = $('order-select');
  for (const order of cfg.orders ?? []) {
    const option = element('option', '', orderLabel(order));
    option.value = order.order_id;
    select.append(option);
  }
  if (!select.value && select.children.length > 0) select.value = select.children[0].value;
  $('chat-form').addEventListener('submit', onSubmit);
  $('btn-register-edited').addEventListener('click', onRegisterEdited);
  if (cfg.mode === 'replay') {
    // T19: the recorded run's message is pre-filled for the selected order (handleChat ignores text).
    const prefill = () => {
      const message = replayMessageFor(REPLAY_TRANSCRIPT, select.value);
      if (message) $('chat-input').value = message;
    };
    select.addEventListener('change', prefill);
    prefill();
  }
  updateRegisterEdited();
  await refreshBondMeter().catch((err) => {
    const el = $('bond-meter');
    if (el) el.textContent = `bond meter: ${err.message}`;
  });
  const timer = setInterval(() => { refreshBondMeter().catch(() => {}); }, BOND_REFRESH_MS);
  timer?.unref?.();
}

if (typeof document !== 'undefined') {
  init().catch((err) => {
    const badge = $('mode-badge');
    badge.className = 'badge error';
    badge.textContent = err.message;
  });
}
