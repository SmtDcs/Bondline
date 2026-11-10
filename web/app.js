let CFG;
const $ = (id) => document.getElementById(id);
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const OFFLINE = new URLSearchParams(location.search).has('offline');

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

/** The bot's reply keeps its text, but the PROMISE token line gets its own element. */
export function splitTokenLine(reply) {
  const lines = String(reply ?? '').split('\n');
  const i = lines.findIndex(line => line.includes('PROMISE|'));
  if (i < 0) return { text: lines.join('\n'), token: null };
  return { text: lines.filter((_, j) => j !== i).join('\n').trimEnd(), token: lines[i].trim() };
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
  try {
    const res = await fetch('/api/demo/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: row.orderId, response_b64: bundle.response_b64 }),
    });
    const data = await res.json();
    if (!res.ok) {
      setBadge(row.statusBadge, { cls: 'error', text: data.error ?? `HTTP ${res.status}` });
      showToast(data.error ?? `HTTP ${res.status}`, null, 'toast error');
      return;
    }
    showToast(claimToastText(data.result.payout), data.explorer);
  } catch (err) {
    showToast(err.message, null, 'toast error');
  } finally {
    btn.disabled = false;
    try {
      const views = await bindingStatus(row.orderId, bundle.response_b64);
      setBadge(row.statusBadge, badgeText(views));
    } catch (err) {
      setBadge(row.statusBadge, { cls: 'error', text: err.message });
    }
    await refreshBondMeter().catch(() => {});
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
    bot.bubble.bundle = data.bundle;
    renderReply(bot.bubble, data.reply);
    if (data.explorer) bot.links.append(link('receipt tx', data.explorer));
    if (data.bundle?.simulated) bot.meta.append(element('span', 'badge simulated', 'SIMULATED'));
    updateRegisterEdited();
    const views = await bindingStatus(orderId, data.bundle.response_b64);
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
  $('mode-badge').textContent = cfg.mode;
  $('contract-link').replaceChildren(link(cfg.contractId, `https://testnet.nearblocks.io/address/${cfg.contractId}`));
  const select = $('order-select');
  for (const order of cfg.orders ?? []) {
    const option = element('option', '', order.label ? `${order.order_id} · ${order.label}` : order.order_id);
    option.value = order.order_id;
    select.append(option);
  }
  $('chat-form').addEventListener('submit', onSubmit);
  $('btn-register-edited').addEventListener('click', onRegisterEdited);
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
