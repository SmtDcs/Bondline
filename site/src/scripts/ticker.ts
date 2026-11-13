// One requestAnimationFrame loop for every animated surface (the hero grid and the background fields).
// - Each surface registers { fps, draw(t) } and gets its own IntersectionObserver for visibility.
// - The loop runs only while at least one surface is visible and the tab is shown.
// - Each surface is throttled to its own fps.
// - Budget guard: if a surface's draw takes more than 4 ms on 3 consecutive frames, its fps is halved (minimum 4).
// Nothing here listens to scroll: surfaces keep moving while the page scrolls because they are tiny
// and the compositor does the scaling.

// draw returns false when it did not paint (a hold, a pause); anything else counts as a painted frame.
export interface SurfaceOptions { fps: number; draw: (t: number) => boolean | void }

interface Surface { fps: number; draw: (t: number) => boolean | void; visible: boolean; last: number; t0: number; slow: number }

const surfaces = new Set<Surface>();
export const stats = { frames: 0, fieldFrames: 0 };
(window as any).__pix = stats;   // frames: painted frames of any surface; fieldFrames: background-field paints (used by the tests)

let raf = 0;
function loop(ts: number) {
  raf = 0;
  if (document.hidden) return;
  let any = false;
  for (const s of surfaces) {
    if (!s.visible) continue;
    any = true;
    if (ts - s.last < 1000 / s.fps - 2) continue;
    s.last = ts;
    const a = performance.now();
    const painted = s.draw((ts - s.t0) / 1000);
    if (painted !== false) stats.frames++;
    if (performance.now() - a > 4) {
      if (++s.slow >= 3) { s.fps = Math.max(4, s.fps / 2); s.slow = 0; }
    } else s.slow = 0;
  }
  if (any) raf = requestAnimationFrame(loop);
}

function kick() {
  if (raf || document.hidden) return;
  for (const s of surfaces) if (s.visible) { raf = requestAnimationFrame(loop); return; }
}

document.addEventListener('visibilitychange', kick);

export function addSurface(el: Element, o: SurfaceOptions): void {
  const s: Surface = { fps: o.fps, draw: o.draw, visible: false, last: 0, t0: performance.now(), slow: 0 };
  surfaces.add(s);
  new IntersectionObserver((es) => { s.visible = es[es.length - 1].isIntersecting; kick(); }, { rootMargin: '100px' }).observe(el);
}
