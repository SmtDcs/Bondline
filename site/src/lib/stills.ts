// Build-time SVG frames drawn by the same code as the live canvases.
// They are the picture without JS, under reduced motion and under Save-Data.
import { ringFrame, framePath } from './pix';
import { scene, W, H, SHOP_X, SHOP_Y, SHOP_COLS, type Facts } from './story-model';

const r2 = (v: number) => +v.toFixed(2);

export function ringSvg(cols: number, rows: number, closure: number, t = 2): { viewBox: string; dim: string; bright: string } {
  const buf = ringFrame(cols, rows, t, closure);
  return { viewBox: `0 0 ${cols} ${rows}`, dim: framePath(buf, cols, 1), bright: framePath(buf, cols, 2) };
}

export function storySvg(u: number, facts: Facts): string {
  const s = scene(u, facts);
  const sq = 0.76;
  let out = '';
  for (let j = 0; j < s.slots; j++) {
    const x = SHOP_X + (j % SHOP_COLS), y = SHOP_Y + Math.floor(j / SHOP_COLS);
    out += `<rect x="${x + 0.03}" y="${y + 0.03}" width="${sq - 0.06}" height="${sq - 0.06}" fill="none" stroke="#fff" stroke-opacity="0.12" stroke-width="0.05"/>`;
  }
  for (const c of s.cells) {
    if (c.fill < 0.01 && c.outline < 0.01) continue;
    const fill = c.fill > 0.01 ? `fill="${c.white ? '#f4f4f2' : '#545452'}" fill-opacity="${r2(c.fill)}"` : 'fill="none"';
    const stroke = c.outline > 0.01 ? ` stroke="#f4f4f2" stroke-opacity="${r2(c.outline)}" stroke-width="0.05"` : '';
    out += `<rect x="${r2(c.x + 0.03)}" y="${r2(c.y + 0.03)}" width="${sq - 0.06}" height="${sq - 0.06}" ${fill}${stroke}/>`;
  }
  const capRows = facts[s.order].capPct / 10;
  if (s.capLine > 0.01) {
    const y = r2(capRows - 0.12);
    out += `<line x1="-0.3" x2="10.06" y1="${y}" y2="${y}" stroke="#f4f4f2" stroke-opacity="${r2(s.capLine)}" stroke-width="0.05" stroke-dasharray="0.25 0.25"/>`;
  }
  if (s.bracket > 0.01) {
    const y1 = r2(capRows - 0.24 + 0.3);
    out += `<path d="M0.3 -0.3H-0.3V${y1}H0.3M9.46 -0.3H10.06V${y1}H9.46" fill="none" stroke="#f4f4f2" stroke-opacity="${r2(s.bracket)}" stroke-width="0.05"/>`;
  }
  return out;
}

export const STORY_VIEWBOX = `-0.6 -0.6 ${W + 0.6} ${H + 0.6}`;
