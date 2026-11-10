// docs/STABLECOIN.md 10: exact decimal formatting, BigInt only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAmount, parseAmount } from '../lib/amount.mjs';

test('formatAmount with 6 decimals', () => {
  assert.equal(formatAmount('4000000', 6), '4');
  assert.equal(formatAmount('1', 6), '0.000001');
  assert.equal(formatAmount('0', 6), '0');
  assert.equal(formatAmount('1500000', 6), '1.5');
  assert.equal(formatAmount(4000000n, 6), '4');
  assert.equal(formatAmount('1000000000000000000000000000000', 6), '1000000000000000000000000');
});

test('formatAmount with 24 decimals and maxFraction', () => {
  assert.equal(formatAmount('1000000000000000000000000', 24), '1');
  assert.equal(formatAmount('1', 24), '0.000000000000000000000001');
  assert.equal(formatAmount('1234500', 6, { maxFraction: 3 }), '1.234');
  assert.throws(() => formatAmount('1', 6, { maxFraction: 7 }), /maxFraction/);
});

test('formatAmount never uses floats: values above 2^53 stay exact', () => {
  assert.equal(formatAmount('9007199254740993', 0), '9007199254740993');
  assert.equal(formatAmount('9007199254740993000000', 6), '9007199254740993');
  assert.equal(formatAmount(2n ** 200n, 0), (2n ** 200n).toString());
});

test('parseAmount accepts the documented forms', () => {
  assert.equal(parseAmount('4', 6), 4000000n);
  assert.equal(parseAmount('0.000001', 6), 1n);
  assert.equal(parseAmount('1.5', 6), 1500000n);
  assert.equal(parseAmount('0', 6), 0n);
  assert.equal(parseAmount('9007199254740993', 0), 9007199254740993n);
});

test('parseAmount rejects malformed text', () => {
  for (const bad of ['1.0000001', '-1', '1e3', '', ' 1', '0x10', '.5', '1.', '1,5', 'abc', 1, null, undefined]) {
    assert.throws(() => parseAmount(bad, 6), /amount/, String(bad));
  }
  assert.throws(() => parseAmount('1', -1), /decimals/);
  assert.throws(() => parseAmount('1', 37), /decimals/);
});

test('format/parse round trip, including values above 2^53', () => {
  const values = [0n, 1n, 999999n, 1000000n, 1500000n, 9007199254740993n, 10n ** 30n];
  for (const v of values) assert.equal(parseAmount(formatAmount(v, 6), 6), v);
  for (let i = 0; i < 100; i++) {
    const v = BigInt(Math.floor(Math.random() * 1e9)) * 10n ** 18n + BigInt(i);
    assert.equal(parseAmount(formatAmount(v, 6), 6), v);
  }
});
