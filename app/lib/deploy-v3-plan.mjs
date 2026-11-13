// The v3 deployment as data (app/scripts/deploy-v3.mjs prints it by default and runs it only with --send).
// Nothing here reads a key; the plan names which account signs each step.
//
// Order: deploy + init in ONE transaction (so nobody can call `new` in between), the market's token registration,
// the attested signer (owner), the merchant's storage balance and shop-auth key, the buyer's storage balance (the
// customer path charges the buyer), the two function-call keys, and last, only with lock=true, deleting the contract
// account's own full-access key. After that step the account has no key: nobody can redeploy it or act as it, and
// the owner (a separate account) can only manage the signer registry.
import { nearToYocto, ONE_YOCTO } from './demo-setup-plan.mjs';

export const V3_METHODS_RELAYER = ['register_receipt'];
export const V3_METHODS_BUYER = ['claim', 'register_receipt_as_buyer'];

const HEX64 = /^[0-9a-f]{64}$/;

export function planDeployV3({
  contractId, ownerId, merchantId, buyerId, tokenId = null, minOrderTtlMs = '3600000',
  wasmPath = 'contract-v3/res/bot_promises_v3.wasm',
  signer, // { publicKeyHex, model, attestationSha256, expiresAtMs }
  shopKeyHex, relayerPublicKey, buyerPublicKey,
  merchantStorage = '0.5', buyerStorage = '0.1', tokenRegistration = '0.01',
  lock = false,
}) {
  for (const [k, v] of Object.entries({ contractId, ownerId, merchantId, buyerId })) if (!v) throw new Error(`${k} is required`);
  if (ownerId === contractId) throw new Error('v3: the owner must be another account than the contract (ERR_OWNER_IS_CONTRACT)');
  if (!signer || !HEX64.test(signer.publicKeyHex) || !HEX64.test(signer.attestationSha256) || !signer.model || !signer.expiresAtMs) {
    throw new Error('signer needs publicKeyHex, model, attestationSha256 (64 hex) and expiresAtMs');
  }
  if (!HEX64.test(String(shopKeyHex))) throw new Error('shopKeyHex must be the 32-byte shop-auth public key in hex');
  const steps = [];
  steps.push({
    id: 'deploy-and-init', signer: 'contract', kind: 'actions', receiverId: contractId,
    actions: [
      { type: 'deployContract', wasmPath },
      {
        type: 'functionCall', method: 'new', tgas: 100, depositYocto: 0n,
        args: { owner: ownerId, allowed_tokens: tokenId ? [tokenId] : [], min_order_ttl_ms: String(minOrderTtlMs) },
      },
    ],
  });
  if (tokenId) {
    steps.push({
      id: 'market-on-token', signer: 'owner', kind: 'call', contractId: tokenId, method: 'storage_deposit',
      args: { account_id: contractId, registration_only: true }, depositYocto: nearToYocto(tokenRegistration), tgas: 30,
    });
  }
  steps.push({
    id: 'add-signer', signer: 'owner', kind: 'call', contractId, method: 'add_signer', depositYocto: ONE_YOCTO, tgas: 30,
    args: {
      public_key_hex: signer.publicKeyHex, kind: 'provider_tee', model_id: signer.model,
      attestation_sha256: signer.attestationSha256, expires_at_ms: String(signer.expiresAtMs),
    },
  });
  steps.push({ id: 'merchant-storage', signer: 'merchant', kind: 'call', contractId, method: 'storage_deposit', args: { account_id: merchantId }, depositYocto: nearToYocto(merchantStorage), tgas: 30 });
  steps.push({ id: 'shop-key', signer: 'merchant', kind: 'call', contractId, method: 'set_shop_key', args: { public_key_hex: shopKeyHex }, depositYocto: ONE_YOCTO, tgas: 30 });
  steps.push({ id: 'buyer-storage', signer: 'buyer', kind: 'call', contractId, method: 'storage_deposit', args: { account_id: buyerId }, depositYocto: nearToYocto(buyerStorage), tgas: 30 });
  if (relayerPublicKey) {
    steps.push({ id: 'relayer-key', signer: 'merchant', kind: 'actions', receiverId: merchantId, actions: [{ type: 'addFunctionCallAccessKey', publicKey: relayerPublicKey, contractId, methodNames: V3_METHODS_RELAYER, allowance: nearToYocto('1') }] });
  }
  if (buyerPublicKey) {
    steps.push({ id: 'buyer-key', signer: 'buyer', kind: 'actions', receiverId: buyerId, actions: [{ type: 'addFunctionCallAccessKey', publicKey: buyerPublicKey, contractId, methodNames: V3_METHODS_BUYER, allowance: nearToYocto('0.5') }] });
  }
  if (lock) {
    // The public key is read from the chain at run time (the account's ONLY key); the script refuses if there is more than one.
    steps.push({ id: 'lock-contract-account', signer: 'contract', kind: 'actions', receiverId: contractId, actions: [{ type: 'deleteOwnKey' }] });
  }
  return steps;
}

export function describeDeployStep(step) {
  const dep = (d) => (d === 0n || d === undefined ? '0' : d === ONE_YOCTO ? '1 yoctoNEAR' : `${d} yocto`);
  if (step.kind === 'call') return `+ ${step.signer} -> ${step.contractId}.${step.method} ${JSON.stringify(step.args)} deposit ${dep(step.depositYocto)}`;
  const parts = step.actions.map(a => {
    if (a.type === 'deployContract') return `deploy ${a.wasmPath}`;
    if (a.type === 'functionCall') return `call ${a.method} ${JSON.stringify(a.args)}`;
    if (a.type === 'addFunctionCallAccessKey') return `add function-call key ${a.publicKey} for ${a.contractId} [${a.methodNames.join(', ')}]`;
    if (a.type === 'deleteOwnKey') return 'DELETE the account\'s only full-access key (the contract account becomes keyless)';
    return a.type;
  });
  return `+ ${step.signer} -> ${step.receiverId}: ${parts.join(' + ')}`;
}
