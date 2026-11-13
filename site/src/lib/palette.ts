// The site's colour language. One square is 1% of a 20 tUSDC order, and colour only ever means state.
//
// Rules (mirrored in global.css :root):
// - Colour is never decorative. It is never used on headings, nav, buttons, labels or links.
//   The primary button stays white-on-black.
// - Chip *text* stays --fg; the state goes on the chip's square marker, border and tint.
//   --dim, --pro, --paid and --bad pass 4.5:1 on #0a0a0a. --res is about 3.7:1, so it is
//   never used for text, only for fills and swatches.
// - Background-field tints are pre-darkened versions of the state colours. They are not
//   the full-strength colours.

export const HEX = {
  bg: '#0a0a0a',
  card: '#0f0f0f',
  fg: '#f4f4f2',
  mut: '#a6a6a2',
  dim: '#8c8c88',   // not a promise / none
  res: '#5c6b7f',   // reserved from the bond
  pro: '#f2b544',   // promised / binding / capped
  paid: '#3ddc97',  // paid out / claimed / valid
  bad: '#ff5c5c',   // refused / ERR_* / invalid
} as const;

/** Fill tones and outline edges, as CSS colours for canvas and SVG. */
export const PALETTE = {
  res: HEX.res,
  pro: HEX.pro,
  paid: HEX.paid,
  bad: HEX.bad,
  dim: HEX.dim,
  empty: 'rgba(255,255,255,0.14)',  // empty square outline
} as const;

/** Pre-darkened tints for the background fields ("orders settling"). */
export const FIELD = {
  base: '#161616',
  res: '#1c2229',
  pro: '#2d2515',
  paid: '#132a20',
} as const;

const rgb = (hex: string): [number, number, number] =>
  [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

export const FIELD_RGB = { base: rgb(FIELD.base), res: rgb(FIELD.res), pro: rgb(FIELD.pro), paid: rgb(FIELD.paid) };

/** Packed RGBA for a Uint32Array view of ImageData (little-endian: 0xAABBGGRR). */
export const pack = (r: number, g: number, b: number, a = 255) => (((a << 24) | (b << 16) | (g << 8) | r) >>> 0);

export const FIELD_PACKED = {
  base: pack(...FIELD_RGB.base),
  res: pack(...FIELD_RGB.res),
  pro: pack(...FIELD_RGB.pro),
  paid: pack(...FIELD_RGB.paid),
};
