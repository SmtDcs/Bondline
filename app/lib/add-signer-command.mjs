// The near-cli add_signer command that `npm run attest` prints.
// v2 source (contract-v2/src/lib.rs) requires exactly 1 yoctoNEAR on add_signer (full-access key only).
// The v2 build that is live on testnet today predates that check and rejects any deposit, so the
// deposit can be overridden with ADD_SIGNER_DEPOSIT (for example '0 NEAR') until the market is redeployed.
export const DEFAULT_ADD_SIGNER_DEPOSIT = '1 yoctoNEAR';

export function addSignerCommand({ contractId, args, deposit = DEFAULT_ADD_SIGNER_DEPOSIT }) {
  return `near contract call-function as-transaction ${contractId} add_signer json-args '${JSON.stringify(args)}' prepaid-gas '30 Tgas' attached-deposit '${deposit}' sign-as ${contractId} network-config testnet sign-with-legacy-keychain send`;
}
