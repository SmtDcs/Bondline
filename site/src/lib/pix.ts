// Pure pixel generators shared by the build (static SVG frames) and the browser (canvas).
// A frame is a Uint8Array of cols*rows cells: 0 off, 1 dim, 2 bright.

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
export const bayer = (x: number, y: number) => BAYER4[(x & 3) + ((y & 3) << 2)];

const TAU = Math.PI * 2;

/**
 * A dithered ring (torus), tilted toward the viewer and slowly turning.
 * closure 0..1: 0 leaves a wide gap (a reply nobody registered), 1 is a closed ring (a receipt on chain).
 */
export function ringFrame(cols: number, rows: number, t: number, closure: number, out?: Uint8Array): Uint8Array {
  const n = cols * rows;
  const buf = out && out.length === n ? out : new Uint8Array(n);
  buf.fill(0);
  const lum = new Float32Array(n);
  const depth = new Float32Array(n).fill(-1e9);

  const R = 1, r = 0.34;
  const tilt = 1.02 + Math.sin(t * 0.21) * 0.08;
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const roll = Math.sin(t * 0.13) * 0.22;
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const spin = t * 0.35;
  const scale = Math.min(cols / 2 / 1.5, rows / 2 / 1.02);
  const cx = cols / 2, cy = rows / 2;
  // light from upper left, toward the viewer
  const lx = -0.48, ly = -0.62, lz = 0.62;

  const gap = (1 - closure) * 1.9;
  const u0 = gap / 2, u1 = TAU - gap / 2;
  const US = Math.max(120, Math.round(scale * 9)), VS = Math.max(24, Math.round(scale * 2.4));
  for (let i = 0; i <= US; i++) {
    const u = u0 + ((u1 - u0) * i) / US + spin;
    const cu = Math.cos(u), su = Math.sin(u);
    // taper the two ends of an open ring
    const edge = closure >= 1 ? 1 : Math.min(1, Math.min(i, US - i) / (US * 0.06));
    const rr = r * (0.35 + 0.65 * edge);
    for (let j = 0; j < VS; j++) {
      const v = (TAU * j) / VS;
      const cv = Math.cos(v), sv = Math.sin(v);
      // torus in the XY plane, normal (cv*cu, cv*su, sv)
      let x = (R + rr * cv) * cu, y = (R + rr * cv) * su, z = rr * sv;
      let nx = cv * cu, ny = cv * su, nz = sv;
      // tilt around X
      let y2 = y * ct - z * st, z2 = y * st + z * ct; y = y2; z = z2;
      y2 = ny * ct - nz * st; z2 = ny * st + nz * ct; ny = y2; nz = z2;
      // roll around Z
      let x2 = x * cr - y * sr; y2 = x * sr + y * cr; x = x2; y = y2;
      x2 = nx * cr - ny * sr; y2 = nx * sr + ny * cr; nx = x2; ny = y2;
      const px = Math.round(cx + x * scale), py = Math.round(cy + y * scale);
      if (px < 0 || py < 0 || px >= cols || py >= rows) continue;
      const k = px + py * cols;
      if (z <= depth[k]) continue;
      depth[k] = z;
      const d = Math.max(0, nx * lx + ny * ly + nz * lz);
      lum[k] = 0.1 + 0.9 * d * (0.75 + 0.25 * closure);
    }
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const k = x + y * cols;
      const l = lum[k];
      if (l <= 0) continue;
      const th = bayer(x, y);
      if (l * 1.25 > th) buf[k] = l > 0.5 + th * 0.25 ? 2 : 1;
    }
  }
  return buf;
}

function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** A drifting field of pixels with dithered edges. It gives the page its ground; it means nothing. */
export function fieldFrame(cols: number, rows: number, t: number, out?: Uint8Array, seed = 0): Uint8Array {
  const n = cols * rows;
  const buf = out && out.length === n ? out : new Uint8Array(n);
  const dx = t * 0.6 + seed * 37.1;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const a = vnoise((x + dx) * 0.038, y * 0.062 + seed);
      const b = vnoise((x + dx * 1.7) * 0.11 + 40, y * 0.14 + 9 + seed);
      const v = a * 0.78 + b * 0.22;
      const th = 0.58 + (bayer(x, y) - 0.5) * 0.2;
      let c = 0;
      if (v > th) c = v > th + 0.07 ? 2 : 1;
      else if (hash(x + 7919 * (1 + seed), y + Math.floor(t * 0.5)) > 0.9965) c = 1; // stray pixels
      buf[x + y * cols] = c;
    }
  }
  return buf;
}

/** One SVG path of unit squares for every cell at the given level (build-time static frames). */
export function framePath(buf: Uint8Array, cols: number, level: number, inset = 0.14): string {
  const s = 1 - inset * 2;
  let d = '';
  for (let k = 0; k < buf.length; k++) {
    if (buf[k] !== level) continue;
    const x = k % cols, y = (k - x) / cols;
    d += `M${+(x + inset).toFixed(2)} ${+(y + inset).toFixed(2)}h${s}v${s}h${-s}z`;
  }
  return d;
}
