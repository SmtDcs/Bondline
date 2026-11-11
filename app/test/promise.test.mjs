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

// tests-9: the SAME vectors the Rust parser runs (contract-v2/src/parse.rs, shared_parser_vectors).
import fs from 'node:fs';
const VECTORS = JSON.parse(fs.readFileSync(new URL('../../contract-v2/tests/parser_vectors.json', import.meta.url), 'utf8'));

test('JS mirror gives the same answer as the Rust parser on every shared vector', () => {
  assert.ok(VECTORS.cases.length >= 30);
  const wrong = [];
  for (const c of VECTORS.cases) {
    const bytes = c.response_json !== undefined ? new TextEncoder().encode(c.response_json) : Buffer.from(c.response_b64, 'base64');
    const ex = extractContent(bytes);
    const got = ex.error ? ex : parsePromise(ex.content);
    const want = c.expect.error ? { error: c.expect.error } : { orderId: c.expect.order_id, bps: c.expect.bps };
    try { assert.deepEqual(got, want); } catch { wrong.push(`${c.name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); }
  }
  assert.deepEqual(wrong, []);
});

test('the vectors cover the cases the two parsers used to disagree on', () => {
  const names = VECTORS.cases.map(c => c.name).join('\n');
  for (const needle of ['empty choices', 'second choice has no message', 'duplicate content key', 'content null', 'content is a number', 'only inside reasoning_content', 'two tokens', 'leading zero', 'followed by a digit', 'lone high surrogate', '33 chars'])
    assert.ok(names.includes(needle), needle);
});
