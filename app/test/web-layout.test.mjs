import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('web/index.html');
const css = read('web/style.css');

const REQUIRED_IDS = [
  'mode-badge', 'contract-link', 'shopper', 'order-select', 'chat-log', 'chat-form',
  'chat-input', 'merchant', 'bond-meter', 'deny-box', 'btn-register-edited', 'merchant-log', 'footer',
];

test('index.html keeps every id app.js depends on', () => {
  for (const id of REQUIRED_IDS) {
    assert.match(html, new RegExp(`id="${id}"`), `missing id="${id}"`);
  }
});

test('index.html has the two panes, the order picker and the module script', () => {
  assert.match(html, /^\s*<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.equal((html.match(/<section\b/g) ?? []).length, 2);
  assert.match(html, /<link rel="stylesheet" href="style\.css">/);
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  assert.match(html, /<form id="chat-form">[\s\S]*<input id="chat-input"[^>]*>[\s\S]*<button>Send<\/button>[\s\S]*<\/form>/);
  assert.match(html, /<button id="btn-register-edited" disabled>/);
  assert.match(html, /<textarea id="deny-box"[^>]*>We never promised that\.<\/textarea>/);
});

test('style.css lays out two columns', () => {
  assert.match(css, /main\s*\{[^}]*display:\s*grid/);
  assert.match(css, /grid-template-columns:\s*1fr\s+1fr/);
  assert.match(css, /gap:\s*16px/);
});

test('style.css styles bubbles, badges and the token line', () => {
  assert.match(css, /\.msg\s*\{/);
  assert.match(css, /\.bubble\s*\{/);
  for (const kind of ['pending', 'binding', 'error', 'simulated']) {
    assert.match(css, new RegExp(`\\.badge\\.${kind}\\s*\\{[^}]*background:`), `missing .badge.${kind} background`);
  }
  assert.match(css, /\.token\s*\{[^}]*font-family:[^;]*monospace/);
});

test('app.js is an importable ES module', async () => {
  globalThis.location = new URL('http://127.0.0.1:8787/');
  const mod = await import(pathToFileURL(path.join(root, 'web/app.js')).href);
  assert.equal(typeof mod, 'object');
  assert.equal(typeof mod.rpcView, 'function');
});
