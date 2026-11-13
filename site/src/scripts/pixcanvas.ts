// Draws a pix.ts frame into a canvas that holds one canvas pixel per cell. CSS scales it up
// (image-rendering: pixelated) and a CSS grid overlay on the wrapper cuts the gaps between cells.

type Draw = (buf: Uint8Array, cols: number, rows: number, t: number) => void;

// While the page is scrolling, animated repaints (putImageData on the ring and
// fields) are what makes scrolling stutter on a phone. Pause them until the
// scroll has been quiet for a moment.
let scrolling = false;
let scrollTimer: ReturnType<typeof setTimeout> | undefined;
addEventListener('scroll', () => {
  scrolling = true;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => { scrolling = false; }, 150);
}, { passive: true });

export interface PixOptions {
  cell: number;        // CSS px per cell
  fps: number;
  dim: number;         // grey level 0..255 for level 1
  bright: number;      // grey level for level 2
  startDelay?: number; // ms after load before the first animated frame
}

export function mountPix(wrap: HTMLElement, draw: Draw, o: PixOptions): { redraw(): void } | null {
  const canvas = wrap.querySelector('canvas');
  const ctx = canvas?.getContext('2d', { willReadFrequently: true });
  if (!canvas || !ctx) return null;

  let cols = 0, rows = 0, buf = new Uint8Array(0), img: ImageData | null = null;
  function size() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const c = Math.max(1, Math.floor(w / o.cell)), r = Math.max(1, Math.floor(h / o.cell));
    if (c === cols && r === rows) return;
    cols = c; rows = r;
    canvas!.width = cols; canvas!.height = rows;
    canvas!.style.width = `${cols * o.cell}px`;
    canvas!.style.height = `${rows * o.cell}px`;
    buf = new Uint8Array(cols * rows);
    img = ctx!.createImageData(cols, rows);
  }
  function paint(t: number) {
    if (!img) return;
    draw(buf, cols, rows, t);
    const d = img.data;
    for (let k = 0, p = 0; k < buf.length; k++, p += 4) {
      const v = buf[k];
      if (v === 0) { d[p + 3] = 0; continue; }
      const g = v === 2 ? o.bright : o.dim;
      d[p] = g; d[p + 1] = g; d[p + 2] = g; d[p + 3] = 255;
    }
    ctx!.putImageData(img, 0, 0);
  }

  size();
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  let visible = false, raf = 0, last = 0, started = false;
  const frame = (ts: number) => {
    raf = 0;
    if (!visible || document.hidden) return;
    if (!scrolling && ts - last >= 1000 / o.fps) { last = ts; paint(now()); }
    raf = requestAnimationFrame(frame);
  };
  const kick = () => { if (started && !raf && visible && !document.hidden) raf = requestAnimationFrame(frame); };

  new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; kick(); }).observe(wrap);
  document.addEventListener('visibilitychange', kick);
  new ResizeObserver(() => { size(); paint(now()); }).observe(wrap);

  paint(0);
  wrap.classList.add('is-live');
  const begin = () => { started = true; kick(); };
  const afterLoad = () => setTimeout(() => ('requestIdleCallback' in window ? requestIdleCallback(begin) : begin()), o.startDelay ?? 0);
  if (document.readyState === 'complete') afterLoad(); else addEventListener('load', afterLoad, { once: true });

  return { redraw: () => paint(now()) };
}

export const calm = () =>
  matchMedia('(prefers-reduced-motion: reduce)').matches || (navigator as any).connection?.saveData === true;
