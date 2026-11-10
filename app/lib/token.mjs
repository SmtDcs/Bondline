// NEP-141/NEP-145/NEP-148 helpers (docs/STABLECOIN.md sections 5, 9, 10).
// Read-only views go through a provider; the two builders are pure so they can be pinned in tests.
import { view } from './near.mjs';

/** Gas/deposit for `ft_transfer_call` into the market contract (the token's ft_on_transfer gets the rest). */
export const FT_TRANSFER_CALL_TGAS = 30;
export const FT_TRANSFER_CALL_DEPOSIT_YOCTO = 1n;

function checkTokenId(tokenId) {
  if (typeof tokenId !== 'string' || tokenId.length === 0) throw new Error('token id must be a non-empty account id');
}

/**
 * NEP-148 metadata, validated. Returns { id, symbol, decimals }.
 * A token whose `decimals` is not an integer 0..=36 is rejected, never guessed.
 */
export async function ftMetadata(provider, tokenId) {
  checkTokenId(tokenId);
  const meta = await view(provider, tokenId, 'ft_metadata', {});
  if (!meta || typeof meta !== 'object') throw new Error(`ft_metadata(${tokenId}) returned nothing`);
  if (!Number.isInteger(meta.decimals) || meta.decimals < 0 || meta.decimals > 36) {
    throw new Error(`token ${tokenId} has invalid decimals ${JSON.stringify(meta.decimals)}`);
  }
  if (typeof meta.symbol !== 'string' || meta.symbol.length === 0) throw new Error(`token ${tokenId} has no symbol`);
  return { id: tokenId, symbol: meta.symbol, decimals: meta.decimals };
}

/** NEP-145 storage balance, or null when the account is not registered on the token. */
export async function storageBalanceOf(provider, tokenId, accountId) {
  checkTokenId(tokenId);
  const balance = await view(provider, tokenId, 'storage_balance_of', { account_id: accountId });
  if (balance === null || balance === undefined) return null;
  return { total: String(balance.total), available: String(balance.available) };
}

/** The exact msg for a bond deposit. Field order and no whitespace are pinned by tests. */
export function buildAddBondMsg() {
  return '{"add_bond":{}}';
}

/** Args for `ft_transfer_call`; amount is a decimal string, msg a string (NEP-141). */
export function ftTransferCallArgs(receiverId, amountRaw, msg = buildAddBondMsg()) {
  if (typeof amountRaw !== 'bigint' && !/^\d+$/.test(String(amountRaw))) throw new Error('amount must be a non-negative integer');
  return { receiver_id: receiverId, amount: String(amountRaw), msg: String(msg) };
}

/** A failed token transfer usually means a missing NEP-145 registration; say so with the exact account. */
export function registrationHint(tokenId, accountId) {
  const token = tokenId || 'the token';
  const account = accountId || 'the receiver';
  return `register ${account} on ${token} first: near contract call-function as-transaction ${token} storage_deposit json-args '{"account_id":"${account}","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as ${account} network-config testnet sign-with-legacy-keychain send`;
}
