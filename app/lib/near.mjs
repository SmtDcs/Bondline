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
  let outcome;
  try {
    outcome = await account.callFunctionRaw({
      contractId, methodName, args,
      gas: teraToGas(tgas),
      deposit: depositYocto,
      waitUntil: 'FINAL',
    });
  } catch (e) {
    // near-api-js 7 throws ContractExecutionError on a contract panic, with the outcome attached:
    // { name, blockHash, blockHeight, transactionResult: { transaction_outcome: { id }, status } }.
    // Keep the hash: the 400 body must carry tx + explorer (INTERFACES 11).
    const txHash = e?.transactionResult?.transaction_outcome?.id ?? e?.transactionResult?.transaction?.hash;
    if (!txHash) throw e;
    const err = new Error(`tx ${txHash} failed: ${e.message}`);
    err.txHash = txHash;
    err.cause = e;
    throw err;
  }
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

/**
 * A successful transaction can still be a failed payout: v2 `claim`/`withdraw_bond` return the
 * callback's ClaimPreview, and `ok:false` means the transfer failed and the books were put back.
 * Returns the failing value (so callers can read `error`/`token`) or null.
 */
export function payoutFailedValue(value) {
  return value && typeof value === 'object' && value.ok === false ? value : null;
}

export function explorerTx(txHash) {
  return `https://testnet.nearblocks.io/txns/${txHash}`;
}
