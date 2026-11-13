// Build-time SVG frames drawn from the same models and palette as the live canvases.
// They are the picture without JS, under reduced motion and under Save-Data.
import { PALETTE, HEX } from './palette';
import { scene, W, H, SHOP_X, SHOP_Y, SHOP_COLS, type Cell, type Facts, type OrderFacts } from './story-model';
import { heroScene } from './hero-model';

const r2 = (v: number) => +v.toFixed(2);
const SQ = 0.76;   // a square is 0.76 of its cell; the rest is gap

function cellRect(c: Cell): string {
  if (c.fill < 0.01 && c.outline < 0.01) return '';
  const fill = c.fill > 0.01 ? `fill="${PALETTE[c.tone]}" fill-opacity="${r2(Math.min(1, c.fill))}"` : 'fill="none"';
  const stroke = c.outline > 0.01 ? ` stroke="${PALETTE[c.edge]}" stroke-opacity="${r2(Math.min(1, c.outline))}" stroke-width="0.05"` : '';
  return `<rect x="${r2(c.x + 0.03)}" y="${r2(c.y + 0.03)}" width="${SQ - 0.06}" height="${SQ - 0.06}" ${fill}${stroke}/>`;
}

export function storySvg(u: number, facts: Facts): string {
  const s = scene(u, facts);
  let out = '';
  const text = (label: string, x: number, y: number, anchor = 'start') =>
    `<text x="${x}" y="${y}" font-family="'Geist Mono Variable', ui-monospace, monospace" font-size="0.32" fill="${HEX.dim}" text-anchor="${anchor}" dominant-baseline="middle">${label}</text>`;

  // row ruler: 10% ... 100%
  for (let r = 0; r < 10; r++) out += text(`${(r + 1) * 10}%`, -0.45, r2(r + SQ / 2), 'end');
  out += text('order', 0, -0.62);

  // shopper tray: a frame around the slots, with a label above its top-left corner
  const trayRows = Math.ceil(Math.max(facts.a.paidPct, facts.b.paidPct) / SHOP_COLS);
  const pad = 0.2;
  out += `<rect x="${r2(SHOP_X - pad)}" y="${r2(SHOP_Y - pad)}" width="${r2(SHOP_COLS - (1 - SQ) + pad * 2)}" height="${r2(trayRows - (1 - SQ) + pad * 2)}" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="0.03"/>`;
  out += text('shopper', SHOP_X - pad, r2(SHOP_Y - pad - 0.25));
  for (let j = 0; j < s.slots; j++) {
    const x = SHOP_X + (j % SHOP_COLS), y = SHOP_Y + Math.floor(j / SHOP_COLS);
    out += `<rect x="${x + 0.03}" y="${y + 0.03}" width="${SQ - 0.06}" height="${SQ - 0.06}" fill="none" stroke="#fff" stroke-opacity="0.12" stroke-width="0.05"/>`;
  }
  for (const c of s.cells) out += cellRect(c);

  const capRows = facts[s.order].capPct / 10;
  if (s.capLine > 0.01) {
    const y = r2(capRows - 0.12);
    out += `<line x1="-0.3" x2="10.06" y1="${y}" y2="${y}" stroke="${HEX.fg}" stroke-opacity="${r2(s.capLine)}" stroke-width="0.05" stroke-dasharray="0.25 0.25"/>`;
  }
  if (s.bracket > 0.01) {
    const y1 = r2(capRows - 0.24 + 0.3);
    out += `<path d="M0.3 -0.3H-0.3V${y1}H0.3M9.46 -0.3H10.06V${y1}H9.46" fill="none" stroke="${HEX.fg}" stroke-opacity="${r2(s.bracket)}" stroke-width="0.05"/>`;
  }
  return out;
}

export const STORY_VIEWBOX = `-1.6 -0.9 ${W + 1.6} ${H + 1.2}`;

// The hero grid and the Why grids are a plain 10x10 square: x and y run from -0.12 to 9.88.
export const GRID_VIEWBOX = '-0.12 -0.12 10 10';

/** The hero card's grid at the binding hold (what shows without JS and under reduced motion). */
export function heroGridSvg(f: OrderFacts): string {
  return heroScene(6, f).cells.map(cellRect).join('');
}

/** The two Why grids: a screenshot (nothing registered) and a signed receipt (reserved and promised). */
export function miniGridSvg(kind: 'screenshot' | 'receipt'): string {
  let out = '';
  for (let i = 0; i < 100; i++) {
    const x = i % 10, y = Math.floor(i / 10);
    const at = `x="${x + 0.03}" y="${y + 0.03}" width="${SQ - 0.06}" height="${SQ - 0.06}"`;
    if (kind === 'screenshot' && i < 20) {
      out += `<rect ${at} fill="none" stroke="${PALETTE.dim}" stroke-width="0.05" stroke-dasharray="0.16 0.1"/>`;
    } else if (kind === 'receipt' && i < 20) {
      out += `<rect ${at} fill="${PALETTE.pro}" fill-opacity="0.62" stroke="${PALETTE.pro}" stroke-opacity="0.95" stroke-width="0.05"/>`;
    } else if (kind === 'receipt' && i < 30) {
      out += `<rect ${at} fill="${PALETTE.res}" fill-opacity="0.9" stroke="${PALETTE.empty}" stroke-width="0.05"/>`;
    } else {
      out += `<rect ${at} fill="none" stroke="${PALETTE.empty}" stroke-width="0.05"/>`;
    }
  }
  return out;
}
