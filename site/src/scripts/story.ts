import { scene, W, H, SHOP_X, SHOP_Y, SHOP_COLS, type Facts } from '../lib/story-model';
import { drawCells } from '../lib/grid-draw';
import { HEX } from '../lib/palette';
import { calm } from './pixcanvas';

const root = document.querySelector<HTMLElement>('[data-story]');
const canvas = root?.querySelector<HTMLCanvasElement>('canvas');
const ctx = canvas?.getContext('2d');
const force = new URLSearchParams(location.search).has('live');

if (root && canvas && ctx && (force || !calm())) {
  const facts: Facts = JSON.parse(root.dataset.facts!);
  const text = JSON.parse(root.dataset.text!) as {
    a: { id: string; chips: Record<string, string> }; b: { id: string; chips: Record<string, string> };
    refusals: string[]; token: string; unit: number;
  };
  const driver = root.querySelector<HTMLElement>('.story-driver')!;
  const stage = root.querySelector<HTMLElement>('.story-stage')!;
  const beats = [...root.querySelectorAll<HTMLElement>('.beat')];
  const ticks = [...root.querySelectorAll<HTMLElement>('.story-ticks li')];
  const refusalItems = [...root.querySelectorAll<HTMLElement>('[data-refusal]')];
  const el = (k: string) => root.querySelector<HTMLElement>(`[data-out="${k}"]`)!;
  const out = { order: el('order'), chip: el('chip'), reserved: el('reserved'), paid: el('paid') };
  const N = beats.length;

  root.classList.add('is-live');

  let w = 0, h = 0, dpr = 1, lastW = -1, lastH = -1;
  function size() {
    const r = canvas!.getBoundingClientRect();
    const nw = Math.round(r.width), nh = Math.round(r.height);
    // Android's address bar show/hide changes the viewport by a fraction: do not
    // reallocate (and so clear) the canvas unless the CSS size really changed.
    if (nw === lastW && nh === lastH) return;
    lastW = nw; lastH = nh;
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    w = nw; h = nh;
    canvas!.width = Math.round(w * dpr); canvas!.height = Math.round(h * dpr);
  }

  let lastKey = '';
  function hud(s: ReturnType<typeof scene>, beat: number) {
    const o = text[s.order];
    let chip = o.chips[s.status];
    let bad = false;
    if (s.refusal >= 0) { chip = text.refusals[s.refusal]; bad = true; }
    const key = `${s.order}|${chip}|${s.reservedPct}|${s.paidPct}|${beat}|${s.refusal}`;
    if (key === lastKey) return;
    lastKey = key;
    out.order.textContent = o.id;
    out.chip.textContent = chip;
    out.chip.dataset.kind = bad ? 'bad'
      : s.status === 'none' ? 'none'
      : s.status === 'binding' || s.status === 'capped' ? 'binding'
      : 'paid';   // claimed, paid-capped
    out.reserved.textContent = `${+(s.reservedPct * text.unit).toFixed(1)} ${text.token}`;
    out.paid.textContent = `${+(s.paidPct * text.unit).toFixed(1)} ${text.token}`;
    beats.forEach((b, i) => b.classList.toggle('is-on', i === beat));
    ticks.forEach((t, i) => { t.classList.toggle('is-on', i === beat); t.classList.toggle('is-done', i < beat); });
    refusalItems.forEach((r, i) => r.classList.toggle('is-on', i === s.refusal));
  }

  // a label on a dark plate, so it stays readable over the squares
  function plate(label: string, x: number, y: number, a: number) {
    const tw = ctx!.measureText(label).width;
    ctx!.fillStyle = `rgba(10,10,10,${0.92 * a})`;
    ctx!.fillRect(x - 4, y - 9, tw + 8, 18);
    ctx!.fillStyle = `rgba(244,244,242,${a})`;
    ctx!.fillText(label, x, y);
  }

  const trayRows = Math.ceil(Math.max(facts.a.paidPct, facts.b.paidPct) / SHOP_COLS);

  function draw(u: number) {
    const t0 = performance.now();
    const s = scene(u, facts);
    const unit = Math.max(4, Math.floor(Math.min(w / (W + 2.5), h / (H + 2.4))));
    const gap = Math.max(2, Math.round(unit * 0.24));
    const sq = unit - gap;
    // the row ruler takes 1.7 units to the left of the order grid
    const ox = Math.round((w - unit * (W + 1.7) + gap) / 2 + 1.7 * unit), oy = Math.round((h - unit * H + gap) / 2);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx!.clearRect(0, 0, w, h);
    ctx!.lineWidth = 1;
    ctx!.textBaseline = 'middle';

    // row ruler: 10% ... 100%
    ctx!.font = `500 10px "Geist Mono Variable", ui-monospace, monospace`;
    ctx!.textAlign = 'right';
    ctx!.fillStyle = HEX.dim;
    for (let r = 0; r < 10; r++) ctx!.fillText(`${(r + 1) * 10}%`, ox - 12, Math.round(oy + r * unit + sq / 2));
    ctx!.textAlign = 'left';

    // shopper tray: a frame around the slots, padded by gap * 2
    const pad = gap * 2;
    const tx = ox + SHOP_X * unit - pad, ty = oy + SHOP_Y * unit - pad;
    ctx!.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx!.strokeRect(tx + 0.5, ty + 0.5, SHOP_COLS * unit - gap + pad * 2 - 1, trayRows * unit - gap + pad * 2 - 1);
    ctx!.fillStyle = HEX.dim;
    ctx!.fillText('shopper', tx, ty - 11);
    ctx!.fillText('order', ox, oy - 20);

    // shopper slots
    ctx!.strokeStyle = 'rgba(255,255,255,0.1)';
    for (let j = 0; j < s.slots; j++) {
      const x = ox + (SHOP_X + (j % SHOP_COLS)) * unit, y = oy + (SHOP_Y + Math.floor(j / SHOP_COLS)) * unit;
      ctx!.strokeRect(x + 0.5, y + 0.5, sq - 1, sq - 1);
    }
    drawCells(ctx!, s.cells, { ox, oy, unit, gap });
    const rowsCap = facts[s.order].capPct / 10;
    ctx!.font = `500 11px "Geist Mono Variable", ui-monospace, monospace`;
    if (s.capLine > 0.01) {
      const y = oy + rowsCap * unit - gap / 2;
      ctx!.strokeStyle = `rgba(244,244,242,${s.capLine})`;
      ctx!.setLineDash([4, 4]);
      ctx!.beginPath(); ctx!.moveTo(ox - 6, y + 0.5); ctx!.lineTo(ox + 10 * unit - gap + 6, y + 0.5); ctx!.stroke();
      ctx!.setLineDash([]);
      plate(`max_bps ${facts[s.order].capPct * 100}`, ox, y + 13, s.capLine);
    }
    if (s.bracket > 0.01) {
      const x0 = ox - 7, x1 = ox + 10 * unit - gap + 7, y0 = oy - 7, y1 = oy + rowsCap * unit - gap + 7;
      ctx!.strokeStyle = `rgba(244,244,242,${s.bracket})`;
      const k = 10;
      ctx!.beginPath();
      ctx!.moveTo(x0 + k, y0 + 0.5); ctx!.lineTo(x0 + 0.5, y0 + 0.5); ctx!.lineTo(x0 + 0.5, y1 + 0.5); ctx!.lineTo(x0 + k, y1 + 0.5);
      ctx!.moveTo(x1 - k, y0 + 0.5); ctx!.lineTo(x1 - 0.5, y0 + 0.5); ctx!.lineTo(x1 - 0.5, y1 + 0.5); ctx!.lineTo(x1 - k, y1 + 0.5);
      ctx!.stroke();
      plate('reserved · cannot be withdrawn', ox, y1 + 13, s.bracket);
    }
    hud(s, Math.min(N - 1, Math.floor(u)));
    (window as any).__story.ms = performance.now() - t0;
  }

  // Geometry is cached here and refreshed only when something may have moved it,
  // so the scroll path never forces layout.
  let driverTop = 0, span = 0, stick = 0;
  function layout() {
    driverTop = driver.getBoundingClientRect().top + scrollY;
    span = driver.offsetHeight - stage.offsetHeight;
    stick = parseFloat(getComputedStyle(stage).top) || 0;
  }

  // progress: 4% hold at each end, then a time-normalised lerp
  let target = 0, cur = 0, raf = 0, prev = 0, visible = false, forced: number | null = null;
  function measure() {
    const p = span > 0 ? Math.min(1, Math.max(0, (scrollY + stick - driverTop) / span)) : 0;
    target = Math.min(1, Math.max(0, (p - 0.04) / 0.92)) * N * 0.99999;
  }
  const coarse = matchMedia('(pointer: coarse)').matches;
  function tick(ts: number) {
    raf = 0;
    const dt = Math.min(64, ts - prev || 16); prev = ts;
    measure();
    if (forced !== null) cur = forced;
    else if (coarse) cur = target;
    else {
      cur += (target - cur) * (1 - Math.pow(1 - 0.14, dt / 16.7));
      if (Math.abs(target - cur) < 0.0005) cur = target;
    }
    draw(cur);
    if (forced === null && Math.abs(target - cur) > 0.0005 && visible && !document.hidden) raf = requestAnimationFrame(tick);
  }
  const kick = () => { if (!raf) { prev = performance.now(); raf = requestAnimationFrame(tick); } };

  (window as any).__story = { ms: 0, force(u: number | null) { forced = u; kick(); } };

  size(); layout(); measure(); cur = target; draw(cur);
  addEventListener('scroll', () => { if (visible) kick(); }, { passive: true });
  const ro = new ResizeObserver(() => { size(); layout(); measure(); kick(); });
  ro.observe(canvas); ro.observe(driver); ro.observe(document.body);
  new IntersectionObserver((es) => {
    visible = es[es.length - 1].isIntersecting;
    if (visible) { layout(); measure(); kick(); }
  }).observe(driver);
  addEventListener('load', () => { layout(); measure(); kick(); });
  document.fonts?.ready.then(() => { layout(); measure(); kick(); });

  // A link inside a beat that is not on screen can take keyboard focus: bring its beat into view.
  beats.forEach((b, i) => b.addEventListener('focusin', () => {
    if (b.classList.contains('is-on')) return;
    const span = driver.offsetHeight - stage.offsetHeight;
    const top = driver.getBoundingClientRect().top + scrollY;
    scrollTo({ top: top + span * (0.04 + 0.92 * ((i + 0.5) / N)), behavior: 'instant' as ScrollBehavior });
  }));
  ticks.forEach((t, i) => t.querySelector('button')?.addEventListener('click', () => {
    const span = driver.offsetHeight - stage.offsetHeight;
    const top = driver.getBoundingClientRect().top + scrollY;
    scrollTo({ top: top + span * (0.04 + 0.92 * ((i + 0.55) / N)), behavior: 'smooth' });
  }));
}
