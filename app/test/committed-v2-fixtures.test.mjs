// The committed v2 live-run fixtures (recorded on testnet 2026-11-10): the transcripts load in replay mode, the numbers in them are
// the ones the live run produced, and the bundles are self-consistent (offline; npm run verify and verify:live-run read the chain).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeReplay } from '../lib/replay.mjs';
import { checkBundle } from '../lib/nearai.mjs';

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('transcript-v2 (tUSDC): replay/v2, token metadata, two claims of 4 and 6 tUSDC, the beats of the page', () => {
  const t = read('fixtures/replay/transcript-v2.json');
  assert.equal(t.type, 'bot-promises/replay/v2');
  assert.equal(t.contract, 'v2.cbp-sm1110.testnet');
  assert.deepEqual(t.tokens, [{ id: 'sm1110-tusdc.testnet', symbol: 'tUSDC', decimals: 6 }]);
  assert.deepEqual(t.steps.map(s => s.kind), ['chat', 'claim', 'chat', 'claim', 'register-edited', 'claim-again']);
  const claims = t.steps.filter(s => s.kind === 'claim');
  assert.deepEqual(claims.map(c => [c.order_id, c.result.ok, c.result.paid_bps, c.result.payout, c.result.token]),
    [['A123-23', true, 2000, '4000000', 'sm1110-tusdc.testnet'], ['A124-21', true, 3000, '6000000', 'sm1110-tusdc.testnet']]);
  assert.equal(claims[1].result.token_bps, 10000, 'the injected reply asked for 100%, the cap paid 30%');
  assert.equal(t.steps.find(s => s.kind === 'register-edited').error, 'ERR_BAD_SIGNATURE');
  assert.equal(t.steps.find(s => s.kind === 'claim-again').error, 'ERR_ALREADY_CLAIMED');
  for (const s of t.steps.filter(x => x.kind === 'chat')) {
    assert.equal(s.views.get_order.token, 'sm1110-tusdc.testnet');
    assert.equal(s.views.tamper.preview_claim.error, 'ERR_NO_RECEIPT_FOR_BYTES');
  }
});

test('transcript-v2-near: the NEAR regression run on v2 pays 0.4 and 0.6 NEAR with token null', () => {
  const t = read('fixtures/replay/transcript-v2-near.json');
  assert.equal(t.type, 'bot-promises/replay/v2');
  const claims = t.steps.filter(s => s.kind === 'claim');
  assert.deepEqual(claims.map(c => [c.order_id, c.result.payout, c.result.token ?? null]),
    [['A123-22', '400000000000000000000000', null], ['A124-22', '600000000000000000000000', null]]);
});

for (const file of ['fixtures/replay/transcript-v2.json', 'fixtures/replay/transcript-v2-near.json']) {
  test(`${file} loads in replay mode and serves its orders without a key`, () => {
    const r = makeReplay(file);
    assert.equal(r.publicConfig.contract_api, 2);
    assert.equal(r.publicConfig.orders.length, 2);
    assert.ok(!JSON.stringify(r.publicConfig).match(/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/));
  });
}

test('the v2 bundles are self-consistent offline and the tampered copies fail the response-hash check', () => {
  for (const f of ['a123-v2', 'a124-v2', 'a123-v2-near', 'a124-v2-near']) {
    const b = read(`fixtures/live/${f}.json`);
    assert.equal(b.simulated, false);
    assert.equal(b.chain.contract, 'v2.cbp-sm1110.testnet');
    assert.deepEqual(checkBundle(b).filter(r => !r.ok), [], f);
  }
  for (const f of ['a123-v2-tampered', 'a123-v2-near-tampered']) {
    const first = checkBundle(read(`fixtures/live/${f}.json`)).find(r => !r.ok);
    assert.match(first.check, /^sha256\(response bytes\)/, f);
  }
});

test('no committed v2 fixture contains a key or secret', () => {
  for (const f of ['fixtures/runs/v2-live-run.json', 'fixtures/replay/transcript-v2.json', 'fixtures/replay/transcript-v2-near.json', 'fixtures/live/a123-v2.json', 'fixtures/live/a124-v2.json']) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /ed25519:[1-9A-HJ-NP-Za-km-z]{50,}|sk-[A-Za-z0-9]{10,}|private_key/, f);
  }
});
