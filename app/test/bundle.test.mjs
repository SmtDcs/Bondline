import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkBundle } from '../lib/nearai.mjs';
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
test('simulated bundles verify', () => {
  for (const f of ['fixtures/simulated/honest.json', 'fixtures/simulated/injection.json'])
    assert.ok(checkBundle(load(f)).every(r => r.ok), f);
});
test('one edited byte fails', () => {
  const b = load('fixtures/simulated/honest.json');
  const bytes = Buffer.from(b.response_b64, 'base64').toString('utf8').replace('bps=2000', 'bps=3000');
  b.response_b64 = Buffer.from(bytes, 'utf8').toString('base64');
  const rows = checkBundle(b);
  assert.equal(rows.find(r => r.check.startsWith('sha256(response')).ok, false);
});
test('real spike bundle verifies', () => {
  assert.ok(checkBundle(load('fixtures/live/spike-s1.json')).every(r => r.ok));
});
