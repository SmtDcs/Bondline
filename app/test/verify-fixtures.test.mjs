// T20 review: run the real verify-fixtures script against a throwaway fixture tree.
// A normal bad bundle and a "tampered" file that verifies must both exit 1; a good set exits 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.resolve('app/scripts/verify-fixtures.mjs');
const load = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const honest = load('fixtures/simulated/honest.json');
const injection = load('fixtures/simulated/injection.json');

function tempRepo(t, dirs = ['fixtures/live', 'fixtures/simulated']) {
  const root = fs.mkdtempSync(path.join('app/test', '.verify-fixtures-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
  return root;
}

function write(root, rel, value) {
  fs.writeFileSync(path.join(root, rel), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}

function run(root) {
  const res = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
  if (res.error) throw res.error;
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const lastLine = (out) => out.trimEnd().split('\n').at(-1);

test('a good set exits 0 with the bundle count', (t) => {
  const root = tempRepo(t);
  write(root, 'fixtures/simulated/honest.json', honest);
  write(root, 'fixtures/simulated/injection.json', injection);

  const r = run(root);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS fixtures\/simulated\/honest\.json/);
  assert.match(r.out, /PASS fixtures\/simulated\/injection\.json/);
  assert.equal(lastLine(r.out), 'ALL VERIFIED (2 bundles)');
});

test('a bad non-tampered bundle exits 1 with the first failed check', (t) => {
  const root = tempRepo(t);
  write(root, 'fixtures/live/good.json', honest);
  write(root, 'fixtures/live/bad.json', { ...honest, response_b64: Buffer.from('edited reply', 'utf8').toString('base64') });

  const r = run(root);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL fixtures\/live\/bad\.json sha256\(response bytes\)/);
  assert.equal(lastLine(r.out), 'SOME FAILED');
});

test('a tampered file that verifies exits 1 (name alone is not a detection)', (t) => {
  const root = tempRepo(t);
  write(root, 'fixtures/live/good-tampered.json', honest);

  const r = run(root);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL fixtures\/live\/good-tampered\.json tamper not detected/);
  assert.equal(lastLine(r.out), 'SOME FAILED');
});

test('a corrupt tampered file is not counted as tamper detected', (t) => {
  const root = tempRepo(t);
  write(root, 'fixtures/live/broken-tampered.json', 'not json');

  const r = run(root);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL fixtures\/live\/broken-tampered\.json tamper not detected \(first failure: cannot read bundle/);
  assert.doesNotMatch(r.out, /tamper detected/);
  assert.equal(lastLine(r.out), 'SOME FAILED');
});

test('empty fixture directories exit 1 instead of ALL VERIFIED (0 bundles)', (t) => {
  const root = tempRepo(t);

  const r = run(root);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL no fixture bundles found/);
  assert.equal(lastLine(r.out), 'SOME FAILED');
});

test('a missing fixture directory exits 1 and says so', (t) => {
  const root = tempRepo(t, ['fixtures/live']);
  write(root, 'fixtures/live/good.json', honest);

  const r = run(root);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL fixtures\/simulated \(missing directory\)/);
  assert.equal(lastLine(r.out), 'SOME FAILED');
});
