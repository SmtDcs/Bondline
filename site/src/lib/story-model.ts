// The scroll story as a pure function of progress u in [0, 5]. One beat per unit.
// The canvas (live) and the build-time SVG stills (fallback) both draw what this returns.
//
// Picture: 100 cells are one 20 tUSDC order (one cell = 0.2 tUSDC = 1%). The cap the shop reserved
// from its bond is the first `cap` cells. Cells that are paid travel to the shopper.

export interface OrderFacts { tokenPct: number; capPct: number; paidPct: number }
export interface Facts { a: OrderFacts; b: OrderFacts }

export type Tone = 'res' | 'pro' | 'paid' | 'bad';   // fill colour: reserved, promised, paid out, refused
export type Edge = 'empty' | 'dim' | 'pro' | 'bad';  // outline colour ('dim' is only used by the hero)

export interface Cell {
  x: number; y: number;     // in cell units
  outline: number;          // 0..1 alpha of the outline, in the `edge` colour
  fill: number;             // 0..1 alpha of the fill, in the `tone` colour
  tone: Tone;
  edge: Edge;
}
export interface Scene {
  order: 'a' | 'b';
  cells: Cell[];
  slots: number;            // how many shopper slots are outlined
  capLine: number;          // alpha of the cap line under the reserved rows
  bracket: number;          // alpha of the "cannot be withdrawn" bracket around the reserved rows
  refusal: -1 | 0 | 1 | 2;  // which refusal is being shown (beat 4)
  status: 'none' | 'binding' | 'claimed' | 'capped' | 'paid-capped';
  reservedPct: number;
  paidPct: number;
}

export const W = 18.5, H = 10;
export const SHOP_X = 12.5, SHOP_Y = 2.5, SHOP_COLS = 6;

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const seg = (u: number, a: number, b: number) => clamp((u - a) / (b - a));
const ease = (v: number) => v * v * (3 - 2 * v);
const home = (i: number) => ({ x: i % 10, y: Math.floor(i / 10) });
const slot = (j: number) => ({ x: SHOP_X + (j % SHOP_COLS), y: SHOP_Y + Math.floor(j / SHOP_COLS) });

export function scene(u: number, f: Facts): Scene {
  const onB = u >= 4;
  const o = onB ? f.b : f.a;
  const alpha = onB ? seg(u, 4.0, 4.12) : 1 - seg(u, 3.9, 4.0);
  const cells: Cell[] = [];
  let capLine = 0, bracket = 0, refusal: Scene['refusal'] = -1;
  let status: Scene['status'] = 'none', reservedPct = 0, paidPct = 0;

  if (!onB) {
    // 0 receipt, 1 denial, 2 claim, 3 refusals
    bracket = seg(u, 1.15, 1.4) * (1 - seg(u, 2.05, 2.2));
    if (u >= 3) {
      const w = [[3.1, 3.37], [3.4, 3.67], [3.7, 3.97]];
      w.forEach(([a, b], k) => { if (u >= a && u < b) refusal = k as 0 | 1 | 2; });
    }
    const bounce = (a: number, b: number) => Math.sin(Math.PI * seg(u, a, b));
    for (let i = 0; i < 100; i++) {
      const h = home(i);
      const appear = seg(u, 0.02 + i * 0.0012, 0.1 + i * 0.0012);
      const c: Cell = { x: h.x, y: h.y, outline: appear, fill: 0, tone: 'res', edge: 'empty' };
      if (i < o.capPct) {
        const res = seg(u, 0.18 + i * 0.008, 0.26 + i * 0.008);
        const released = seg(u, 2.6, 2.8);
        c.fill = res * (1 - released) * 0.9;
      }
      if (i < o.paidPct) {
        // promised cells: marked when the receipt lands, then paid out
        const bind = seg(u, 0.6, 0.72);
        if (bind * 0.95 > 0.16) { c.edge = 'pro'; c.outline = bind * 0.95; }
        if (bind > 0) { c.tone = 'pro'; c.fill = Math.max(c.fill * (1 - bind), 0.62 * bind); }
        const fly = ease(seg(u, 2.12 + i * 0.012, 2.42 + i * 0.012));
        if (fly > 0) {
          const s = slot(i);
          cells.push({ x: h.x, y: h.y, outline: 1, fill: 0, tone: 'res', edge: 'empty' });
          c.x = h.x + (s.x - h.x) * fly; c.y = h.y + (s.y - h.y) * fly;
          c.fill = 1; c.tone = 'paid'; c.outline = 0;
        }
      }
      cells.push(c);
    }
    // refusals: cells try to leave and come back
    if (u >= 3) {
      const tryMove = (from: number, to: number, a: number, b: number, moving: boolean) => {
        const k = bounce(a, b);
        if (k <= 0) return;
        for (let i = from; i < to; i++) {
          const h = home(i), s = slot(i);
          const d = moving ? k * 0.3 : 0;
          cells.push({ x: h.x + (s.x - h.x) * d, y: h.y + (s.y - h.y) * d, outline: 0.9 * k, fill: moving ? 0.55 * k : 0, tone: 'bad', edge: 'bad' });
        }
      };
      tryMove(o.paidPct, o.capPct, 3.1, 3.37, true);   // claim edited bytes: the extra 10%
      tryMove(o.paidPct, o.capPct, 3.4, 3.67, false);  // shop registers an edited reply
      tryMove(0, o.paidPct, 3.7, 3.97, true);          // claim again
    }
    status = u < 0.6 ? 'none' : u < 2.42 ? 'binding' : 'claimed';
    reservedPct = u < 0.3 ? Math.round(o.capPct * seg(u, 0.18, 0.5)) : u < 2.7 ? o.capPct : 0;
    paidPct = Math.round(o.paidPct * seg(u, 2.2, 2.66));
  } else {
    // 4 the over-generous bot, capped
    capLine = seg(u, 4.36, 4.5);
    for (let i = 0; i < 100; i++) {
      const h = home(i);
      const c: Cell = { x: h.x, y: h.y, outline: 1, fill: 0, tone: 'res', edge: 'empty' };
      const promised = seg(u, 4.2 + i * 0.0015, 4.3 + i * 0.0015);
      const dropped = i >= o.capPct ? seg(u, 4.5, 4.62) : 0;
      const pa = promised * (1 - dropped) * 0.95;
      if (pa > 0.16) { c.outline = pa; c.edge = dropped > 0 ? 'bad' : 'pro'; }
      if (i < o.capPct) {
        const released = seg(u, 4.9, 4.98);
        c.fill = 0.9 * (1 - released);
        const kept = seg(u, 4.36, 4.5);
        if (kept > 0) { c.tone = 'pro'; c.fill = 0.9 * (1 - kept) + 0.62 * kept; }
        const fly = ease(seg(u, 4.55 + i * 0.006, 4.8 + i * 0.006));
        if (fly > 0) {
          const s = slot(i);
          cells.push({ x: h.x, y: h.y, outline: 1, fill: 0, tone: 'res', edge: 'empty' });
          c.x = h.x + (s.x - h.x) * fly; c.y = h.y + (s.y - h.y) * fly;
          c.fill = 1; c.tone = 'paid'; c.outline = 0;
        }
      }
      cells.push(c);
    }
    status = u < 4.3 ? 'none' : u < 4.5 ? 'binding' : u < 4.9 ? 'capped' : 'paid-capped';
    reservedPct = u < 4.9 ? o.capPct : 0;
    paidPct = Math.round(o.paidPct * seg(u, 4.6, 4.95));
  }
  for (const c of cells) { c.outline *= alpha; c.fill *= alpha; }
  return { order: onB ? 'b' : 'a', cells, slots: onB ? f.b.paidPct : f.a.paidPct, capLine: capLine * alpha, bracket: bracket * alpha, refusal, status, reservedPct, paidPct };
}

/** A representative moment of each beat, used for the stills. */
export const STILL_U = [0.9, 1.6, 2.92, 3.24, 4.99];
