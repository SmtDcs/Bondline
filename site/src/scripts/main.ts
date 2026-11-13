import './ticker';
import { mountField, calm } from './pixcanvas';
import './hero';
import './story';
import './verify';

document.documentElement.classList.add('js');

// Ground fields behind the hero and the footer. Fewer frames on touch screens.
if (!calm()) {
  const fps = matchMedia('(pointer: coarse)').matches ? 8 : 12;
  document.querySelectorAll<HTMLElement>('[data-field]').forEach((wrap, i) => {
    mountField(wrap, { cell: 8, fps, seed: i, startDelay: 1500 });
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
