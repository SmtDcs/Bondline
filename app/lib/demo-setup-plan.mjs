// The V2 demo setup as data: a list of steps (signer, contract, method, args, deposit, gas).
// app/scripts/demo-setup-v2.mjs prints it (--dry-run, reads no key) or sends it with near-api-js.
// Ported from the V2 branches of app/scripts/demo-setup.sh (which used near-cli). After the 1-yocto fix
// (docs/STABLECOIN.md section 20) `register_order` always attaches exactly 1 yoctoNEAR: there is no
// override for the old build any more.
import { buildAddBondMsg, ftTransferCallArgs } from './token.mjs';

const YOCTO_PER_NEAR = 10n ** 24n;

/** "0.5" -> 500000000000000000000000n. Decimal text only, up to 24 fraction digits. */
export function nearToYocto(text) {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(String(text).trim());
  if (!m) throw new Error(`not a NEAR amount: ${JSON.stringify(text)}`);
  return BigInt(m[1]) * YOCTO_PER_NEAR + BigInt((m[2] ?? '').padEnd(24, '0') || '0');
}

export const ONE_YOCTO = 1n;

/** 500000000000000000000000n -> "0.5" (exact, trailing zeros removed). */
export function yoctoToNearText(yocto) {
  const v = BigInt(yocto);
  const whole = v / YOCTO_PER_NEAR;
  const frac = (v % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * @param {object} o
 * @param {'token'|'near'} o.asset
 * @param {string} o.run              e.g. "21" -> orders A123-21 / A124-21
 * @param {string} o.contractId  o.merchantId  o.buyerId  o.tokenId
 * Returns steps: { id, signer: 'merchant', contractId, method, args, tgas, depositYocto, skipIf? }
 * `skipIf` = { view: {contractId, method, args}, when: 'present' | 'absent' } is evaluated just before sending,
 * so a re-run does not repeat a one-time step (registration, merchant creation).
 */
export function planSetup({
  asset = 'token', run, contractId, merchantId, buyerId, tokenId,
  ttlMs = '1800000', amountRaw = '20000000', bondRaw = '100000000',
  nearAmountYocto = '2000000000000000000000000', maxBps = 3000,
  storageDeposit = '0.5', tokenRegistrationDeposit = '0.01', merchantBond = '3',
}) {
  if (!run) throw new Error('run is required (orders are A123-<run> and A124-<run>)');
  if (!contractId || !merchantId || !buyerId) throw new Error('contractId, merchantId and buyerId are required');
  if (asset === 'token' && !tokenId) throw new Error('tokenId is required for the token path');
  const steps = [];
  const add = (s) => steps.push({ signer: 'merchant', tgas: 30, depositYocto: 0n, ...s });
  add({
    id: 'market-storage', contractId, method: 'storage_deposit', args: { account_id: merchantId },
    depositYocto: nearToYocto(storageDeposit),
    // A second run does not add another deposit; top up by hand (or with STORAGE_DEPOSIT after unsetting) if it runs low.
    skipIf: { view: { contractId, method: 'storage_balance_of', args: { account_id: merchantId } }, when: 'present' },
  });
  if (asset === 'token') {
    add({
      id: 'merchant-on-token', contractId: tokenId, method: 'storage_deposit',
      args: { account_id: merchantId, registration_only: true }, depositYocto: nearToYocto(tokenRegistrationDeposit),
      skipIf: { view: { contractId: tokenId, method: 'storage_balance_of', args: { account_id: merchantId } }, when: 'present' },
    });
    add({
      id: 'token-bond', contractId: tokenId, method: 'ft_transfer_call', tgas: 100, depositYocto: ONE_YOCTO,
      args: ftTransferCallArgs(contractId, bondRaw, buildAddBondMsg()),
    });
    add({
      id: 'buyer-on-token', contractId: tokenId, method: 'storage_deposit',
      args: { account_id: buyerId, registration_only: true }, depositYocto: nearToYocto(tokenRegistrationDeposit),
      skipIf: { view: { contractId: tokenId, method: 'storage_balance_of', args: { account_id: buyerId } }, when: 'present' },
    });
  } else {
    add({
      id: 'register-merchant', contractId, method: 'register_merchant', args: {}, depositYocto: nearToYocto(merchantBond),
      skipIf: { view: { contractId, method: 'get_merchant', args: { merchant: merchantId } }, when: 'present' },
    });
  }
  for (const id of [`A123-${run}`, `A124-${run}`]) {
    add({
      id: `order-${id}`, contractId, method: 'register_order', depositYocto: ONE_YOCTO,
      args: {
        order_id: id, buyer: buyerId,
        amount: asset === 'token' ? String(amountRaw) : String(nearAmountYocto),
        max_bps: maxBps,
        ...(asset === 'token' ? { token: tokenId } : {}),
        ttl_ms: String(ttlMs),
      },
    });
  }
  return steps;
}

/** One printable line per step (dry run). Contains account ids and amounts only. */
export function describeStep(step, accounts = { merchant: 'MERCHANT' }) {
  const dep = step.depositYocto === 0n ? '0' : step.depositYocto === ONE_YOCTO ? '1 yoctoNEAR' : `${yoctoToNearText(step.depositYocto)} NEAR`;
  const skip = step.skipIf ? ` (skipped when ${step.skipIf.view.method} is ${step.skipIf.when})` : '';
  return `+ ${accounts[step.signer] ?? step.signer} -> ${step.contractId}.${step.method} ${JSON.stringify(step.args)} deposit ${dep} gas ${step.tgas}Tgas${skip}`;
}

export function demoOrdersLine(run) {
  return `DEMO_ORDERS="A123-${run}:Broken mug:2000,A124-${run}:Late delivery:2000:naive"`;
}
