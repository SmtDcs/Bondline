// docs/STABLECOIN.md 12: a `replay/v2` transcript loads (token metadata, token order fields and a
// recorded failed payout), while the committed replay/v1 transcript keeps working (replay.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeReplay } from '../lib/replay.mjs';

const TOKEN = { id: 'tusdc.testnet', symbol: 'tUSDC', decimals: 6 };
const MERCHANT = 'cbp-shop-sm1110.testnet';
const BUYER = 'cbp-alice-sm1110.testnet';

function v2Transcript(t) {
  const dir = fs.mkdtempSync(path.join('app/test', '.replay-v2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bundle = JSON.parse(fs.readFileSync('fixtures/simulated/honest.json', 'utf8'));
  const transcript = {
    type: 'bot-promises/replay/v2',
    recorded_at: '2026-11-10T12:00:00.000Z',
    contract: 'v2.cbp-sm1110.testnet',
    contract_api: 2,
    tokens: [TOKEN],
    steps: [
      {
        kind: 'chat', order_id: 'A123-01', message: 'hi', bundle_file: 'fixtures/simulated/honest.json', register_tx: 'RegTx',
        views: {
          get_order: { order_id: 'A123-01', merchant: MERCHANT, buyer: BUYER, token: TOKEN.id, amount: '20000000', max_bps: 3000, liability: '6000000', status: 'claimed', expires_at_ms: '1796792000000' },
          get_receipt: { order_id: 'A123-01', token: TOKEN.id, order_amount: '20000000' },
          preview_claim: { ok: true, token_bps: 2000, paid_bps: 2000, payout: '4000000', token: TOKEN.id },
          get_merchant: { bond: '100000000', reserved: '6000000', paid_out: '0' },
        },
      },
      { kind: 'claim-failed', order_id: 'A123-01', tx: 'FailTx', error: 'ERR_PAYOUT_FAILED' },
      { kind: 'claim', order_id: 'A123-01', claim_tx: 'ClaimTx', result: { ok: true, token_bps: 2000, paid_bps: 2000, payout: '4000000', token: TOKEN.id } },
    ],
  };
  const file = path.join(dir, 'transcript-v2.json');
  fs.writeFileSync(file, JSON.stringify(transcript, null, 2) + '\n');
  return { file, bundle };
}

test('makeReplay loads a replay/v2 transcript with tokens and per-order token fields', (t) => {
  const { file } = v2Transcript(t);
  const { publicConfig } = makeReplay(file);
  assert.equal(publicConfig.contract_api, 2);
  assert.deepEqual(publicConfig.tokens, [TOKEN]);
  assert.deepEqual(publicConfig.orders, [{ order_id: 'A123-01', token: TOKEN.id, expires_at_ms: '1796792000000' }]);
});

test('the recorded failed payout plays once, then the retry pays', async (t) => {
  const { file, bundle } = v2Transcript(t);
  const { handlers } = makeReplay(file);
  const request = { order_id: 'A123-01', response_b64: bundle.response_b64 };

  await assert.rejects(
    () => handlers.handleClaim(request),
    (e) => e.message === 'ERR_PAYOUT_FAILED' && e.status === 502 && e.txHash === 'FailTx' && /retry after registering/.test(e.detail),
  );
  const paid = await handlers.handleClaim(request);
  assert.equal(paid.ok, true);
  assert.equal(paid.claim_tx, 'ClaimTx');
  assert.equal(paid.result.token, TOKEN.id);
  await assert.rejects(() => handlers.handleClaim(request), (e) => e.message === 'ERR_ALREADY_CLAIMED' && e.status === 400);
});
