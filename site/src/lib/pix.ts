// The background fields: "orders settling". The field is a lattice of 10x10 blocks, one block per order,
// with 2-cell gutters. About 6% of the blocks run a 6 s mini lifecycle at any time: a prefix of k cells
// (k fixed per block, 10 to 30) tints reserved, then promised, then paid, then fades.
// It writes packed RGBA straight into a Uint32Array view of the canvas ImageData, with no noise functions.
import { FIELD_RGB, FIELD_PACKED, pack } from './palette';

const BLOCK = 10, PITCH = 12;      // cells per block, cells per block + gutter
const LIFE = 6, PERIOD = 100;      // 6 s lifecycle, once per 100 s per block: 6% of blocks are live

function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
function mix(a: readonly number[], b: readonly number[], k: number): number {
  return pack(Math.round(lerp(a[0], b[0], k)), Math.round(lerp(a[1], b[1], k)), Math.round(lerp(a[2], b[2], k)));
}

// per-block scratch, reused between frames
let cut = new Uint8Array(0), kk = new Uint8Array(0), colA = new Uint32Array(0), colB = new Uint32Array(0);

/** Writes one frame of the ledger field into `out` (cols * rows packed RGBA pixels). */
export function ledgerFrame(cols: number, rows: number, t: number, out: Uint32Array, seed = 0): void {
  const nbx = Math.ceil(cols / PITCH), nby = Math.ceil(rows / PITCH), nb = nbx * nby;
  if (cut.length < nb) { cut = new Uint8Array(nb); kk = new Uint8Array(nb); colA = new Uint32Array(nb); colB = new Uint32Array(nb); }
  const { base, res, pro, paid } = FIELD_PACKED;

  for (let by = 0; by < nby; by++) {
    for (let bx = 0; bx < nbx; bx++) {
      const b = by * nbx + bx;
      const age = (t + hash(bx + seed * 131, by + seed * 7 + 1) * PERIOD) % PERIOD;
      if (age >= LIFE) { kk[b] = 0; cut[b] = 0; continue; }
      const k = 10 + Math.floor(hash(by * 31 + 5, bx + seed * 977 + 3) * 21);   // 10..30 cells
      const p = age / LIFE;
      let c = 0, a = res, bb = base;
      if (p < 0.3) { c = p / 0.3; a = res; bb = base; }
      else if (p < 0.55) { c = (p - 0.3) / 0.25; a = pro; bb = res; }
      else if (p < 0.8) { c = (p - 0.55) / 0.25; a = paid; bb = pro; }
      else { c = 1; a = mix(FIELD_RGB.paid, FIELD_RGB.base, (p - 0.8) / 0.2); bb = a; }
      kk[b] = k; cut[b] = Math.floor(k * c); colA[b] = a; colB[b] = bb;
    }
  }

  for (let y = 0; y < rows; y++) {
    const ly = y % PITCH, row = y * cols;
    if (ly >= BLOCK) { out.fill(0, row, row + cols); continue; }
    const brow = Math.floor(y / PITCH) * nbx;
    for (let x = 0; x < cols; x++) {
      const lx = x % PITCH;
      if (lx >= BLOCK) { out[row + x] = 0; continue; }
      const b = brow + (x - lx) / PITCH, j = ly * BLOCK + lx;
      out[row + x] = j < cut[b] ? colA[b] : j < kk[b] ? colB[b] : base;
    }
  }
}
