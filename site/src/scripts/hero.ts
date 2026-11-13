// The hero card's 10x10 grid. It draws only while it moves: a steady hold costs nothing.
// The canvas is GPU-backed and sized to CSS size x min(devicePixelRatio, 2).
import { heroScene } from '../lib/hero-model';
import { drawCells } from '../lib/grid-draw';
import type { OrderFacts } from '../lib/story-model';
import { addSurface } from './ticker';
import { calm } from './pixcanvas';

const vis = document.querySelector<HTMLElement>('[data-hero-grid]');
const card = document.querySelector<HTMLElement>('[data-hero-card]');
const canvas = vis?.querySelector('canvas');
const ctx = vis && card && canvas && !calm() ? canvas.getContext('2d') : null;

if (vis && card && canvas && ctx) {
  const facts = JSON.parse(vis.dataset.facts!) as OrderFacts;
  const START = 5;   // seconds into the loop: begin in the binding hold, the picture the static SVG shows

  let w = 0, h = 0, dpr = 1, unit = 0, gap = 0, ox = 0, oy = 0;
  function size() {
    const nw = canvas!.clientWidth, nh = canvas!.clientHeight;
    if (nw === w && nh === h) return false;
    w = nw; h = nh;
    dpr = Math.min(devicePixelRatio || 1, 2);
    canvas!.width = Math.round(w * dpr); canvas!.height = Math.round(h * dpr);
    unit = Math.max(4, Math.floor(Math.min(w, h) / 10));
    gap = Math.max(2, Math.round(unit * 0.3));   // squares are 0.70 of the pitch, like the SVG still
    ox = Math.round((w - (unit * 10 - gap)) / 2); oy = Math.round((h - (unit * 10 - gap)) / 2);
    return true;
  }

  let shown = 'binding', painted = '', lastT = 0;
  let pausedAt = -1, offset = 0;   // loop clock = ticker time - offset; frozen while the card is hovered or focused
  function paint(t: number): boolean {
    const s = heroScene(START + t, facts);
    if (s.state !== shown) { shown = s.state; card!.dataset.state = s.state; }
    if (!s.moving && s.state === painted) return false;   // steady hold: leave the canvas alone
    painted = s.moving ? '' : s.state;                     // keep painting every frame while moving
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx!.clearRect(0, 0, w, h);
    drawCells(ctx!, s.cells, { ox, oy, unit, gap });
    return true;
  }
  // Pause flags. Hover only counts where a real hover exists (on touch it sticks after a tap); focus counts everywhere.
  let hovered = false, focused = false;
  if (matchMedia('(hover: hover)').matches) {
    card.addEventListener('pointerenter', () => { hovered = true; });
    card.addEventListener('pointerleave', () => { hovered = false; });
  }
  card.addEventListener('focusin', () => { focused = true; });
  card.addEventListener('focusout', (e) => { focused = !!e.relatedTarget && card.contains(e.relatedTarget as Node); });
  function draw(t: number): boolean {
    if (hovered || focused) {   // let people read the card: freeze the loop clock
      if (pausedAt < 0) pausedAt = t;
      return false;
    }
    if (pausedAt >= 0) { offset += t - pausedAt; pausedAt = -1; }
    lastT = t - offset;
    return paint(lastT);
  }

  const begin = () => {
    size();
    paint(0);
    vis!.classList.add('is-live');
    addSurface(vis, { fps: 30, draw });
    new ResizeObserver(() => { if (size()) { painted = ''; paint(lastT); } }).observe(vis);
  };
  // 600 ms after load, so it does not compete with the LCP
  const afterLoad = () => setTimeout(() => ('requestIdleCallback' in window ? requestIdleCallback(begin) : begin()), 600);
  if (document.readyState === 'complete') afterLoad(); else addEventListener('load', afterLoad, { once: true });
}
