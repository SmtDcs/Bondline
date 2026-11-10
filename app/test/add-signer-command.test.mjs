// Final review F1: the add_signer command `npm run attest` prints attaches exactly 1 yoctoNEAR by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addSignerCommand, DEFAULT_ADD_SIGNER_DEPOSIT } from '../lib/add-signer-command.mjs';

const args = { public_key_hex: 'ab'.repeat(32), kind: 'provider_tee', model_id: 'm', attestation_sha256: 'cd'.repeat(32), expires_at_ms: '1' };

test('add_signer command attaches 1 yoctoNEAR by default', () => {
  assert.equal(DEFAULT_ADD_SIGNER_DEPOSIT, '1 yoctoNEAR');
  const cmd = addSignerCommand({ contractId: 'v2.example.testnet', args });
  assert.match(cmd, /attached-deposit '1 yoctoNEAR'/);
  assert.match(cmd, /sign-as v2\.example\.testnet /);
  assert.ok(cmd.includes(JSON.stringify(args)));
});

test('the deposit can be overridden for the pre-redeploy build', () => {
  assert.match(addSignerCommand({ contractId: 'c.testnet', args, deposit: '0 NEAR' }), /attached-deposit '0 NEAR'/);
});

test('the ADD_SIGNER_DEPOSIT override for the pre-redeploy build is gone from `npm run attest`', async () => {
  const { readFileSync } = await import('node:fs');
  assert.doesNotMatch(readFileSync(new URL('../scripts/attest.mjs', import.meta.url), 'utf8'), /ADD_SIGNER_DEPOSIT/);
});
