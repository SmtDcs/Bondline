// A background field: a canvas that holds one canvas pixel per cell (about 155x80 for the hero),
// GPU-backed (no willReadFrequently). CSS gives it the same size in px and scales it up with
// `transform: scale(var(--k))`, so the compositor does the scaling and the texture stays tiny.
// A static ::after overlay on the wrapper cuts the gutters between cells, and a static ::before
// overlay fades the field out (no mask-image over the animated canvas).
import { ledgerFrame } from '../lib/pix';
import { addSurface, stats } from './ticker';

export interface FieldOptions {
  cell: number;        // CSS px per cell (sets --cell and --k on the wrapper)
  fps: number;
  seed: number;
  startDelay?: number; // ms after load before the first frame
}

export function mountField(wrap: HTMLElement, o: FieldOptions): void {
  const canvas = wrap.querySelector('canvas');
  const ctx = canvas?.getContext('2d', { alpha: true });
  if (!canvas || !ctx) return;

  let cols = 0, rows = 0, img: ImageData | null = null, px = new Uint32Array(0), lastT = 0;
  function size() {
    const c = Math.max(1, Math.floor(wrap.clientWidth / o.cell)), r = Math.max(1, Math.floor(wrap.clientHeight / o.cell));
    if (c === cols && r === rows) return false;   // reallocate (and so clear) only on a real change
    cols = c; rows = r;
    canvas!.width = cols; canvas!.height = rows;
    canvas!.style.width = `${cols}px`;
    canvas!.style.height = `${rows}px`;
    img = ctx!.createImageData(cols, rows);
    px = new Uint32Array(img.data.buffer);
    return true;
  }
  function paint(t: number) {
    if (!img) return;
    lastT = t;
    ledgerFrame(cols, rows, t, px, o.seed);
    ctx!.putImageData(img, 0, 0);
    stats.fieldFrames++;
  }

  const begin = () => {
    wrap.style.setProperty('--cell', `${o.cell}px`);
    wrap.style.setProperty('--k', String(o.cell));
    size();
    paint(0);
    wrap.classList.add('is-live');
    addSurface(wrap, { fps: o.fps, draw: paint });
    new ResizeObserver(() => { if (size()) paint(lastT); }).observe(wrap);
  };
  const afterLoad = () => setTimeout(() => ('requestIdleCallback' in window ? requestIdleCallback(begin) : begin()), o.startDelay ?? 0);
  if (document.readyState === 'complete') afterLoad(); else addEventListener('load', afterLoad, { once: true });
}

export const calm = () =>
  matchMedia('(prefers-reduced-motion: reduce)').matches || (navigator as any).connection?.saveData === true;
