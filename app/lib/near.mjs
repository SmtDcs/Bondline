// NEAR testnet helpers. near-api-js 7.4.0 (checked: npm tarball lib/index.d.ts, 2026-11-08).
// Account(accountId, provider, signer); account.callFunction({contractId, methodName, args, gas, deposit, waitUntil})
// provider.callFunction({contractId, method, args}) for views (note: `method`, not `methodName`).
import { Account, JsonRpcProvider, KeyPairSigner, teraToGas } from 'near-api-js';

export function makeProvider(rpcUrl) {
  return new JsonRpcProvider({ url: rpcUrl });
}

/** Read-only view call. Returns parsed JSON (or undefined for null). */
export async function view(provider, contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args });
}

/** Account that signs with ONE key from env (format "ed25519:<base58 secret>"). */
export function accountFromKey(provider, accountId, secretKey) {
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(secretKey));
}

/**
 * Change call that waits for FINAL and returns { txHash, value, outcome }.
 * Throws an Error whose message contains the contract panic string (e.g. "ERR_BAD_SIGNATURE").
 */
export async function callFinal(account, contractId, methodName, args, { tgas = 100, depositYocto = 0n } = {}) {
  const outcome = await account.callFunctionRaw({
    contractId, methodName, args,
    gas: teraToGas(tgas),
    deposit: depositYocto,
    waitUntil: 'FINAL',
  });
  const txHash = outcome.transaction_outcome?.id ?? outcome.transaction?.hash;
  const status = outcome.status;
  if (status && typeof status === 'object' && 'Failure' in status) {
    const err = new Error(`tx ${txHash} failed: ${JSON.stringify(status.Failure)}`);
    err.txHash = txHash;
    throw err;
  }
  const b64 = status?.SuccessValue;
  const value = b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : undefined;
  return { txHash, value, outcome };
}

export function explorerTx(txHash) {
  return `https://testnet.nearblocks.io/txns/${txHash}`;
}
