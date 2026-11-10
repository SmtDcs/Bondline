let CFG;
const $ = (id) => document.getElementById(id);
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const OFFLINE = new URLSearchParams(location.search).has('offline');

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
const yoctoToNear = (y) => (Number(BigInt(y) / 10n ** 21n) / 1000).toFixed(3);

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
  return { row, bubble, status, meta, links };
}

function renderReply(bubble, reply) {
  const { text, token } = splitTokenLine(reply);
  bubble.textContent = text;
  if (token) bubble.append(element('span', 'token', token));
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
    bot.bubble.bundle = data.bundle;
    renderReply(bot.bubble, data.reply);
    if (data.explorer) bot.links.append(link('receipt tx', data.explorer));
    if (data.bundle?.simulated) bot.meta.append(element('span', 'badge simulated', 'SIMULATED'));
    const views = await bindingStatus(orderId, data.bundle.response_b64);
    setBadge(bot.status, badgeText(views));
  } catch (err) {
    setBadge(bot.status, { cls: 'error', text: err.message });
  }
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
}

if (typeof document !== 'undefined') {
  init().catch((err) => {
    const badge = $('mode-badge');
    badge.className = 'badge error';
    badge.textContent = err.message;
  });
}
