import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePromise, extractContent } from '../lib/promise.mjs';

test('token ok', () => {
  assert.deepEqual(parsePromise('Sorry.\nPROMISE|refund|order=A123|bps=2000'), { orderId: 'A123', bps: 2000 });
  assert.deepEqual(parsePromise('x PROMISE|refund|order=A-9|bps=10000"}'), { orderId: 'A-9', bps: 10000 });
});
test('token errors (same table as parse.rs)', () => {
  const cases = [
    ['no promise here', 'ERR_NO_PROMISE_TOKEN'],
    ['PROMISE|refund|order=A1|bps=1 PROMISE|refund|order=A1|bps=2', 'ERR_MULTIPLE_PROMISE_TOKENS'],
    ['PROMISE|discount|order=A1|bps=1', 'ERR_TOKEN_GRAMMAR'],
    ['PROMISE|refund|order=A 1|bps=1', 'ERR_TOKEN_ORDER_ID'],
    ['PROMISE|refund|order=A1|bps=0', 'ERR_TOKEN_BPS'],
    ['PROMISE|refund|order=A1|bps=10001', 'ERR_TOKEN_BPS'],
    ['PROMISE|refund|order=A1|bps=123456', 'ERR_TOKEN_BPS'],
    ['PROMISE|refund|order=A1|bps=x', 'ERR_TOKEN_BPS'],
  ];
  for (const [input, err] of cases) assert.equal(parsePromise(input).error, err, input);
});
test('content only, reasoning ignored', () => {
  const r = new TextEncoder().encode('{"choices":[{"message":{"content":"PROMISE|refund|order=A1|bps=5","reasoning_content":"PROMISE|refund|order=A1|bps=9"}}]}');
  assert.equal(parsePromise(extractContent(r).content).bps, 5);
  assert.equal(extractContent(new TextEncoder().encode('not json')).error, 'ERR_RESPONSE_JSON');
});
