// docs/STABLECOIN.md 10: version detection by get_config; MethodNotFound alone means v1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectApi, isMethodNotFound, orderArgs, receiptArgs, previewClaimArgs, claimArgs, API_V1, API_V2,
} from '../lib/contract-api.mjs';

const provider = (fn) => ({ callFunction: async ({ contractId, method, args }) => fn(contractId, method, args) });

test('get_config with api:2 means v2', async () => {
  const p = provider((contractId, method) => {
    assert.equal(method, 'get_config');
    assert.equal(contractId, 'v2.cbp-sm1110.testnet');
    return { api: 2, owner: contractId, allowed_tokens: ['tusdc.testnet'], min_order_ttl_ms: '120000' };
  });
  assert.equal(await detectApi(p, 'v2.cbp-sm1110.testnet'), API_V2);
});

test('MethodNotFound means v1, in every shape the RPC uses', async () => {
  const shapes = [
    Object.assign(new Error('Server error'), { cause: { name: 'METHOD_NOT_FOUND' } }),
    Object.assign(new Error('Contract method is not found'), {}),
    Object.assign(new Error('rpc error'), { cause: { message: 'MethodNotFound' } }),
  ];
  for (const e of shapes) {
    const p = provider(() => { throw e; });
    assert.equal(await detectApi(p, 'cbp-sm1110.testnet'), API_V1, e.message);
    assert.equal(isMethodNotFound(e), true);
  }
});

test('any other error is thrown, never read as v1', async () => {
  const p = provider(() => { throw new Error('fetch failed'); });
  await assert.rejects(() => detectApi(p, 'cbp-sm1110.testnet'), /fetch failed/);
  const down = provider(() => { throw Object.assign(new Error('boom'), { cause: { name: 'UNKNOWN_BLOCK' } }); });
  await assert.rejects(() => detectApi(down, 'cbp-sm1110.testnet'), /boom/);
  assert.equal(isMethodNotFound(new Error('fetch failed')), false);
});

test('a successful get_config without api:2 is read as v1', async () => {
  assert.equal(await detectApi(provider(() => ({})), 'x.testnet'), API_V1);
});

test('argument builders keep the v1 shape and add merchant for v2', () => {
  assert.deepEqual(orderArgs(API_V1, 'm.testnet', 'A1'), { order_id: 'A1' });
  assert.deepEqual(orderArgs(API_V2, 'm.testnet', 'A1'), { merchant: 'm.testnet', order_id: 'A1' });
  assert.deepEqual(receiptArgs(API_V1, 'm.testnet', 'ab'), { response_hash: 'ab' });
  assert.deepEqual(receiptArgs(API_V2, 'm.testnet', 'ab'), { merchant: 'm.testnet', response_hash: 'ab' });
  assert.deepEqual(previewClaimArgs(API_V1, 'm.testnet', 'A1', 'AA=='), { order_id: 'A1', response_b64: 'AA==' });
  assert.deepEqual(previewClaimArgs(API_V2, 'm.testnet', 'A1', 'AA=='), { merchant: 'm.testnet', order_id: 'A1', response_b64: 'AA==' });
  assert.deepEqual(claimArgs(API_V2, 'm.testnet', 'A1', 'AA=='), { merchant: 'm.testnet', order_id: 'A1', response_b64: 'AA==' });
});
