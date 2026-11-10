// docs/STABLECOIN.md 5/9/10: NEP-141/145/148 helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ftMetadata, storageBalanceOf, buildAddBondMsg, ftTransferCallArgs, registrationHint,
  FT_TRANSFER_CALL_TGAS, FT_TRANSFER_CALL_DEPOSIT_YOCTO,
} from '../lib/token.mjs';

const provider = (answer) => ({ callFunction: async ({ contractId, method, args }) => answer(contractId, method, args) });

test('ftMetadata reads ft_metadata and validates decimals', async () => {
  const p = provider((contractId, method) => {
    assert.equal(contractId, 'tusdc.testnet');
    assert.equal(method, 'ft_metadata');
    return { spec: 'ft-1.0.0', name: 'Test USDC', symbol: 'tUSDC', decimals: 6 };
  });
  assert.deepEqual(await ftMetadata(p, 'tusdc.testnet'), { id: 'tusdc.testnet', symbol: 'tUSDC', decimals: 6 });

  for (const decimals of [-1, 37, 6.5, '6', null]) {
    const bad = provider(() => ({ symbol: 'X', decimals }));
    await assert.rejects(() => ftMetadata(bad, 'tusdc.testnet'), /invalid decimals/, String(decimals));
  }
  await assert.rejects(() => ftMetadata(provider(() => ({ decimals: 6 })), 'tusdc.testnet'), /no symbol/);
});

test('storageBalanceOf: null means the account is not registered', async () => {
  const args = [];
  const p = provider((_c, method, a) => {
    assert.equal(method, 'storage_balance_of');
    args.push(a);
    return null;
  });
  assert.equal(await storageBalanceOf(p, 'tusdc.testnet', 'cbp-bob-sm1110.testnet'), null);
  assert.deepEqual(args, [{ account_id: 'cbp-bob-sm1110.testnet' }]);

  const registered = provider(() => ({ total: '1250000000000000000000', available: '0' }));
  assert.deepEqual(await storageBalanceOf(registered, 'tusdc.testnet', 'alice.testnet'), {
    total: '1250000000000000000000',
    available: '0',
  });
});

test('buildAddBondMsg is exactly the documented msg', () => {
  assert.equal(buildAddBondMsg(), '{"add_bond":{}}');
});

test('ftTransferCallArgs carries strings plus 1 yocto and gas', () => {
  const args = ftTransferCallArgs('v2.cbp-sm1110.testnet', 20000000n);
  assert.deepEqual(args, { receiver_id: 'v2.cbp-sm1110.testnet', amount: '20000000', msg: '{"add_bond":{}}' });
  assert.equal(typeof args.amount, 'string');
  assert.equal(typeof args.msg, 'string');
  assert.equal(ftTransferCallArgs('x.testnet', 5, 'hello').msg, 'hello');
  assert.equal(FT_TRANSFER_CALL_DEPOSIT_YOCTO, 1n);
  assert.equal(FT_TRANSFER_CALL_TGAS, 30);
  assert.throws(() => ftTransferCallArgs('x.testnet', '1e3'), /amount/);
});

test('the registration hint names the token and the account', () => {
  const hint = registrationHint('tusdc.testnet', 'cbp-bob-sm1110.testnet');
  assert.match(hint, /cbp-bob-sm1110\.testnet/);
  assert.match(hint, /tusdc\.testnet/);
  assert.match(hint, /storage_deposit/);
});
