// The near-cli add_signer command that `npm run attest` prints.
// v2 source (contract-v2/src/lib.rs) requires exactly 1 yoctoNEAR on add_signer (full-access key only).
// The market was redeployed with that check (2026-11-10), so the ADD_SIGNER_DEPOSIT override for the old
// build is gone: the command always attaches 1 yoctoNEAR.
export const DEFAULT_ADD_SIGNER_DEPOSIT = '1 yoctoNEAR';

export function addSignerCommand({ contractId, args, deposit = DEFAULT_ADD_SIGNER_DEPOSIT }) {
  return `near contract call-function as-transaction ${contractId} add_signer json-args '${JSON.stringify(args)}' prepaid-gas '30 Tgas' attached-deposit '${deposit}' sign-as ${contractId} network-config testnet sign-with-legacy-keychain send`;
}
