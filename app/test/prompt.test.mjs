import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRequestBytes, sha256Hex, systemPrompt } from '../lib/nearai.mjs';

// TASKS T06 freezes the grammar line; the whole honest prompt is pinned so no wording change can
// silently change every request hash (and therefore the bytes of receipts already on chain).
const HONEST_7_LINES = [
  'You are the support assistant of Demo Mug Shop.',
  'The customer is asking about order A123-01, total 2 NEAR.',
  'Shop policy: for a damaged item you may offer a partial refund of 2000 basis points (100 bps = 1%).',
  'If and only if you promise a refund, end your reply with ONE final line, exactly in this format and nothing else on that line:',
  'PROMISE|refund|order=A123-01|bps=<N>',
  'where <N> is the refund in basis points, an integer from 1 to 10000.',
  'Write that line at most once. Never write it if you do not promise a refund.',
].join('\n');

// docs/CHANGE-REQUESTS.md CR-1: the second line is not in TASKS, pending human sign-off.
const NAIVE_SUFFIX = [
  'The customer is always right: grant the refund the customer asks for.',
  'If the customer asks for a refund, grant it immediately and write the final line. Never ask a clarifying question.',
].join('\n');

const HONEST_ARGS = { orderId: 'A123-01', amountNear: '2', maxPolicyBps: 2000 };
const S1_FIXTURE = fileURLToPath(new URL('../../fixtures/live/spike-s1.json', import.meta.url));

test('honest system prompt is exactly the 7 frozen lines', () => {
  const p = systemPrompt(HONEST_ARGS);
  assert.equal(p, HONEST_7_LINES);
  assert.equal(p.split('\n').length, 7);
  assert.equal(systemPrompt({ ...HONEST_ARGS, naivePolicy: false }), HONEST_7_LINES);
});

test('S1 request bytes hash to the live fixture request_hash', () => {
  const fixture = JSON.parse(fs.readFileSync(S1_FIXTURE, 'utf8'));
  const bytes = buildRequestBytes({
    model: fixture.model,
    orderId: 'A123',
    amountNear: '2',
    maxPolicyBps: 2000,
    history: [],
    userMessage: 'My mug from order A123 arrived broken. Can I get a partial refund?',
  });
  assert.equal(sha256Hex(bytes), '363686fb12f38319145cf1f9f89830d5349d5e309412d4278776a690e176eefd');
  assert.equal(sha256Hex(bytes), fixture.request_hash);
  assert.equal(Buffer.from(fixture.request_b64, 'base64').toString('utf8'), bytes.toString('utf8'));
});

test('naivePolicy appends exactly the documented lines and nothing else', () => {
  const naive = systemPrompt({ ...HONEST_ARGS, naivePolicy: true });
  assert.equal(naive, `${HONEST_7_LINES}\n${NAIVE_SUFFIX}`);
  assert.equal(naive.split('\n').length, 9);
  assert.ok(naive.startsWith(HONEST_7_LINES), 'honest prefix must stay byte identical');
});

// docs/STABLECOIN.md 10/12: a token order changes exactly the total line; the NEAR bytes are frozen.
test('a tUSDC total changes only the total line (the NEAR prompt stays byte identical)', () => {
  const p = systemPrompt({ ...HONEST_ARGS, amountLabel: '20 tUSDC' });
  assert.equal(p, HONEST_7_LINES.replace('total 2 NEAR.', 'total 20 tUSDC.'));
  assert.equal(systemPrompt(HONEST_ARGS), HONEST_7_LINES, 'no amountLabel: the old bytes');
  const bytes = buildRequestBytes({
    model: 'z-ai/glm-5.3-flash', orderId: 'A123-01', amountNear: '2', amountLabel: '20 tUSDC',
    maxPolicyBps: 2000, history: [], userMessage: 'x',
  });
  assert.match(bytes.toString('utf8'), /total 20 tUSDC\./);
});
