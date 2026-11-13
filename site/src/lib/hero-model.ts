// The hero's live order card as a pure function of time: one 10x10 grid, one order.
// Open (a reply nobody registered) -> binding (the bond reserves the cap, the promise is marked)
// -> claimed (the promise is paid, the reservation is released) -> back to open.
import type { Cell, OrderFacts } from './story-model';

export type HeroState = 'open' | 'binding' | 'claimed';
export interface HeroScene { cells: Cell[]; state: HeroState; moving: boolean }

const HERO_LOOP = 12;      // seconds
const STAGGER = 0.015;             // seconds per cell, row-major, on every wave

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));

export function heroScene(time: number, f: OrderFacts): HeroScene {
  const t = ((time % HERO_LOOP) + HERO_LOOP) % HERO_LOOP;
  const paid = f.paidPct, cap = f.capPct;
  const cells: Cell[] = [];

  for (let i = 0; i < 100; i++) {
    const x = i % 10, y = Math.floor(i / 10);
    const s = i * STAGGER;
    // every square has its empty outline
    cells.push({ x, y, outline: 1, fill: 0, tone: 'res', edge: 'empty' });
    if (i >= cap) continue;

    const promised = i < paid;
    const reset = 1 - seg(t, 11.4 + s, 11.55 + s);          // everything fades back to the open picture
    const k1 = seg(t, 3.5 + s, 3.8 + s);                    // the bond reserves the cap
    const k2 = promised ? seg(t, 4.0 + s, 4.2 + s) : 0;     // reserved -> promised
    const k3 = promised ? seg(t, 8.3 + s, 8.6 + s) : 0;     // promised -> paid
    const k4 = promised ? 0 : seg(t, 8.0 + (i - paid) * STAGGER, 8.4 + (i - paid) * STAGGER); // reservation released

    if (promised) {
      const active = k2 * reset;
      const claimed = k3 * reset;
      // signed but not registered: a brighter outline, no fill
      const dim = 0.7 * (1 - active);
      if (dim > 0.01) cells.push({ x, y, outline: dim, fill: 0, tone: 'res', edge: 'dim' });
      const proEdge = 0.95 * active * (1 - claimed);
      if (proEdge > 0.01) cells.push({ x, y, outline: proEdge, fill: 0, tone: 'res', edge: 'pro' });
      const res = 0.9 * k1 * (1 - k2) * reset;
      if (res > 0.01) cells.push({ x, y, outline: 0, fill: res, tone: 'res', edge: 'empty' });
      const pro = 0.62 * k2 * (1 - k3) * reset;
      if (pro > 0.01) cells.push({ x, y, outline: 0, fill: pro, tone: 'pro', edge: 'empty' });
      const pd = 0.9 * claimed;
      if (pd > 0.01) cells.push({ x, y, outline: 0, fill: pd, tone: 'paid', edge: 'empty' });
    } else {
      const res = 0.9 * k1 * (1 - k4) * reset;
      if (res > 0.01) cells.push({ x, y, outline: 0, fill: res, tone: 'res', edge: 'empty' });
    }
  }

  const state: HeroState = t < 4.0 ? 'open' : t < 8.3 ? 'binding' : t < 11.7 ? 'claimed' : 'open';
  const moving = (t >= 3.5 && t < 4.6) || (t >= 8.0 && t < 9.0) || t >= 11.4;
  return { cells, state, moving };
}
