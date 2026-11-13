// Screenshots and checks against a running `astro preview` (http://127.0.0.1:4321).
// node scripts/shots.mjs [what...]   what: top sections beats nojs reduced verify axe jank (default: all)
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4321/';
const OUT = 'shots';
fs.mkdirSync(OUT, { recursive: true });
const want = new Set(process.argv.slice(2));
const on = (k) => want.size === 0 || want.has(k);
const sizes = [{ name: 'd', width: 1440, height: 900 }, { name: 'm', width: 390, height: 844 }];
const browser = await chromium.launch();
const problems = [];

async function page(size, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, javaScriptEnabled: opts.js !== false, reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
  const p = await ctx.newPage();
  if (opts.blockScripts) await p.route('**/_astro/*.js', (r) => r.abort());
  p.on('console', (m) => { if (!opts.blockScripts && ['error', 'warning'].includes(m.type())) problems.push(`${size.name} console ${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => problems.push(`${size.name} pageerror: ${e.message}`));
  p.on('response', (r) => { if (r.status() >= 400 && !opts.blockScripts) problems.push(`${size.name} ${r.status()} ${r.url()}`); });
  await p.goto(BASE + (opts.query ?? ''), { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(opts.wait ?? 300);
  return p;
}
const sections = ['#top', '.nums-band', '#h-problem', '#run', '#verify', '#near', '#limits', '#try', '.footer'];

for (const s of sizes) {
  if (on('top')) {
    const p = await page(s, { wait: 3500 });
    await p.screenshot({ path: `${OUT}/${s.name}-top.png` });
    await p.screenshot({ path: `${OUT}/${s.name}-full.png`, fullPage: false });
    await p.context().close();
  }
  if (on('sections')) {
    const p = await page(s, { wait: 2500 });
    for (const sel of sections) {
      if (sel === '#run') continue;
      await p.locator(sel).first().evaluate((el) => el.closest('section,footer').scrollIntoView({ block: 'start' }));
      await p.waitForTimeout(400);
      await p.screenshot({ path: `${OUT}/${s.name}-sec-${sel.replace(/[#.]/g, '')}.png` });
    }
    await p.context().close();
  }
  if (on('beats')) {
    const p = await page(s, { wait: 600 });
    const live = await p.evaluate(() => document.querySelector('.story').classList.contains('is-live'));
    if (!live) problems.push(`${s.name}: story not live`);
    // scroll to the sticky part, then force each beat
    await p.evaluate(() => { const d = document.querySelector('.story-driver'); scrollTo(0, d.getBoundingClientRect().top + scrollY + 10); });
    for (const [i, u] of [[0, 0.9], [1, 1.6], [2, 2.5], [3, 3.24], [4, 3.82], [5, 4.4], [6, 4.99]]) {
      await p.evaluate((u) => window.__story.force(u), u);
      await p.waitForTimeout(450);
      await p.screenshot({ path: `${OUT}/${s.name}-beat-${i}.png` });
    }
    // real scroll mapping: last frame
    await p.evaluate(() => window.__story.force(null));
    await p.evaluate(() => { const d = document.querySelector('.story-driver'); scrollTo(0, d.getBoundingClientRect().top + scrollY + d.offsetHeight - innerHeight - 5); });
    await p.waitForTimeout(1200);
    await p.screenshot({ path: `${OUT}/${s.name}-beat-scrollend.png` });
    await p.context().close();
  }
  if (on('nojs')) {
    const p = await page(s, { js: false });
    await p.screenshot({ path: `${OUT}/${s.name}-nojs-full.png`, fullPage: true });
    await p.context().close();
  }
  if (on('reduced')) {
    const p = await page(s, { reduced: true, wait: 1500 });
    await p.screenshot({ path: `${OUT}/${s.name}-reduced-full.png`, fullPage: true });
    await p.context().close();
  }
  if (on('verify')) {
    const p = await page(s);
    await p.locator('#verify').scrollIntoViewIfNeeded();
    await p.waitForTimeout(600);
    const read = () => p.evaluate(() => [...document.querySelectorAll('#verify .v-res')].map((x) => x.textContent).join(' | '));
    const r0 = await read();
    await p.click('[data-act="edit"]'); await p.waitForTimeout(300);
    const r1 = await read();
    await p.click('[data-act="forge"]'); await p.waitForTimeout(300);
    const r2 = await read();
    await p.locator('#verify').screenshot({ path: `${OUT}/${s.name}-verify-forged.png` });
    await p.click('[data-act="reset"]'); await p.waitForTimeout(300);
    const r3 = await read();
    console.log(`${s.name} verify: start [${r0}] edit [${r1}] forge [${r2}] reset [${r3}]`);
    if (!r0.startsWith('MATCH | VALID | SELF-CONSISTENT') || !r1.startsWith('MISMATCH') || !r2.includes('INVALID') || r3 !== r0) problems.push(`${s.name}: verify states wrong`);
    await p.context().close();
  }
}

if (on('axe')) {
  // axe-core injected directly: @axe-core/playwright's AxeBuilder hangs on this page with Playwright 1.65.
  const axeSrc = fs.readFileSync('node_modules/axe-core/axe.min.js', 'utf8');
  const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
  for (const s of sizes) for (const mode of ['js', 'nojs', 'reduced', 'verify-edited', 'story-mid']) {
    const p = await page(s, { blockScripts: mode === 'nojs', reduced: mode === 'reduced', wait: 800 });
    if (mode === 'verify-edited') { await p.locator('#verify').scrollIntoViewIfNeeded(); await p.waitForTimeout(400); await p.click('[data-act="edit"]'); await p.waitForTimeout(300); }
    if (mode === 'story-mid') { await p.evaluate(() => { const d = document.querySelector('.story-driver'); scrollTo(0, d.getBoundingClientRect().top + scrollY + d.offsetHeight * 0.6); }); await p.waitForTimeout(1200); }
    await p.addScriptTag({ content: axeSrc });
    const r = await p.evaluate((tags) => axe.run(document, { runOnly: tags }), tags);
    console.log(`axe ${s.name} ${mode}: ${r.violations.length} violations`);
    for (const v of r.violations) problems.push(`axe ${s.name} ${mode}: ${v.id} (${v.nodes.length}) ${v.help} :: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
    await p.context().close();
  }
}

if (on('jank')) {
  for (const s of sizes) {
    const p = await page(s, { wait: 3000 });
    const r = await p.evaluate(async () => {
      const d = document.querySelector('.story-driver');
      const start = d.getBoundingClientRect().top + scrollY, end = start + d.offsetHeight - innerHeight;
      const deltas = []; const ms = [];
      let last = performance.now();
      const t0 = last;
      await new Promise((res) => {
        const f = (ts) => {
          deltas.push(ts - last); last = ts;
          const k = Math.min(1, (ts - t0) / 2000);
          scrollTo(0, start + (end - start) * k);
          ms.push(window.__story.ms);
          if (k < 1) requestAnimationFrame(f); else res();
        };
        requestAnimationFrame(f);
      });
      deltas.shift(); deltas.sort((a, b) => a - b);
      ms.sort((a, b) => a - b);
      return { n: deltas.length, p95: deltas[Math.floor(deltas.length * 0.95)], max: deltas[deltas.length - 1], drawMedian: ms[ms.length >> 1], drawMax: ms[ms.length - 1] };
    });
    console.log(`jank ${s.name}: frames ${r.n}, p95 ${r.p95.toFixed(1)} ms, max ${r.max.toFixed(1)} ms, draw median ${r.drawMedian.toFixed(2)} ms, max ${r.drawMax.toFixed(2)} ms`);
    if (r.p95 > 20 || r.max >= 50) problems.push(`jank ${s.name}: p95 ${r.p95.toFixed(1)} max ${r.max.toFixed(1)}`);
    await p.context().close();
  }
}

await browser.close();
console.log(problems.length ? `PROBLEMS (${problems.length}):\n` + problems.join('\n') : 'no problems');
