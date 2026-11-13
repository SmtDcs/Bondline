// One canvas painter for the 1%-square grid, shared by the recorded run and the hero.
import { PALETTE } from './palette';
import type { Cell } from './story-model';

export interface GridBox { ox: number; oy: number; unit: number; gap: number }

/** Each cell: a (unit - gap) square filled in its tone at `fill` alpha, outlined in its edge colour at `outline` alpha. */
export function drawCells(ctx: CanvasRenderingContext2D, cells: Cell[], { ox, oy, unit, gap }: GridBox) {
  const sq = unit - gap;
  ctx.lineWidth = 1;
  for (const c of cells) {
    const x = Math.round(ox + c.x * unit), y = Math.round(oy + c.y * unit);
    if (c.fill > 0.01) {
      ctx.globalAlpha = c.fill > 1 ? 1 : c.fill;
      ctx.fillStyle = PALETTE[c.tone];
      ctx.fillRect(x, y, sq, sq);
    }
    if (c.outline > 0.01) {
      ctx.globalAlpha = c.outline > 1 ? 1 : c.outline;
      ctx.strokeStyle = PALETTE[c.edge];
      ctx.strokeRect(x + 0.5, y + 0.5, sq - 1, sq - 1);
    }
  }
  ctx.globalAlpha = 1;
}
