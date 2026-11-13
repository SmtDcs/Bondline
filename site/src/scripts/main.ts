import { ringFrame, fieldFrame } from '../lib/pix';
import { mountPix, calm } from './pixcanvas';
import './story';
import './verify';

document.documentElement.classList.add('js');
const still = calm();

// Hero: the ring closes when the receipt is registered, then the loop starts again.
const ring = document.querySelector<HTMLElement>('[data-ring]');
const heroCard = document.querySelector<HTMLElement>('[data-hero-card]');
if (ring && heroCard && !still) {
  const LOOP = 11; // seconds: 4 open, 1.2 closing, 5.8 closed
  const closureAt = (t: number) => {
    const p = t % LOOP;
    if (p < 4) return 0.12;
    if (p < 5.2) { const k = (p - 4) / 1.2; return 0.12 + 0.88 * k * k * (3 - 2 * k); }
    if (p < 10.4) return 1;
    const k = (p - 10.4) / 0.6; return 1 - 0.88 * k;
  };
  let shown = '';
  mountPix(ring, (buf, cols, rows, t) => {
    ringFrame(cols, rows, t, closureAt(t), buf);
    const state = t % LOOP >= 5.1 && t % LOOP < 10.4 ? 'binding' : 'open';
    if (state !== shown) { shown = state; heroCard.dataset.state = state; }
  }, { cell: 5, fps: 24, dim: 150, bright: 244, startDelay: 1200 });
}

// Ground fields behind the hero and the footer.
if (!still) {
  document.querySelectorAll<HTMLElement>('[data-field]').forEach((wrap, i) => {
    mountPix(wrap, (buf, cols, rows, t) => fieldFrame(cols, rows, t, buf, i), { cell: 8, fps: 8, dim: 46, bright: 84, startDelay: 1500 });
  });
}

// Copy buttons.
document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => {
  b.hidden = false;
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.copy!);
      const old = b.textContent; b.textContent = 'Copied';
      setTimeout(() => (b.textContent = old), 1400);
    } catch { /* clipboard blocked: the text is selectable */ }
  });
});

// Header: mark the section on screen.
const links = [...document.querySelectorAll<HTMLAnchorElement>('.nav a[href^="#"]')];
const byId = new Map(links.map((a) => [a.getAttribute('href')!.slice(1), a]));
const io = new IntersectionObserver((es) => {
  for (const e of es) if (e.isIntersecting) {
    links.forEach((a) => a.removeAttribute('aria-current'));
    byId.get(e.target.id)?.setAttribute('aria-current', 'true');
  }
}, { rootMargin: '-45% 0px -50% 0px' });
byId.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
