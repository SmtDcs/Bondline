// DAY-0 SPIKE S4: function-call access keys do what the demo needs (testnet, no funds move).
//   node --env-file=.env app/scripts/spike-s4.mjs
// Proves with the real keys in .env:
//   relayer key (MERCHANT_ID, method_names ["register_receipt"]) CAN call register_receipt and CANNOT
//   call withdraw_bond; buyer key (BUYER_ID, method_names ["claim"]) CAN call claim and CANNOT call
//   register_receipt. The "CAN" calls use order_id NOPE-S4, which does not exist, so each one reaches
//   the contract (the access key accepted it) and panics with ERR_NO_ORDER. A refused call is rejected
//   by nearcore before execution, so it costs nothing and moves nothing; the reaching calls burn a
//   little gas paid by the key's allowance.
import { makeProvider, accountFromKey, callFinal } from '../lib/near.mjs';

const missing = ['NEAR_RPC_URL', 'MERCHANT_ID', 'CONTRACT_ID', 'RELAYER_SECRET_KEY', 'BUYER_CLAIM_SECRET_KEY']
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`S4 CANNOT RUN: missing ${missing.join(', ')} (run with node --env-file=.env)`);
  process.exit(2);
}

const p = makeProvider(process.env.NEAR_RPC_URL);
const relayer = accountFromKey(p, process.env.MERCHANT_ID, process.env.RELAYER_SECRET_KEY);
const buyer = accountFromKey(p, process.env.BUYER_ID, process.env.BUYER_CLAIM_SECRET_KEY);

const ACCESS_KEY_DENIED = /Access key does not allow method/;
const NO_ORDER = /Smart contract panicked: ERR_NO_ORDER\b/;

// args that pass the access key and stop at the contract's first order lookup (ERR_NO_ORDER)
const receiptArgs = {
  order_id: 'NOPE-S4',
  signed_text: 'z-ai/glm-5.3-flash:00:00',
  signature_hex: '00'.repeat(64),
  signer_public_key_hex: '00'.repeat(32),
};

/** Outcome of one call: 'reached' (contract ran and panicked with ERR_NO_ORDER), 'denied' (access key
 *  refused it) or 'other' (anything else: a success or an error text we did not expect). */
async function call(account, method, args) {
  try {
    const { txHash } = await callFinal(account, process.env.CONTRACT_ID, method, args);
    return { kind: 'other', message: `call succeeded (tx ${txHash})` };
  } catch (e) {
    const message = String(e.message);
    if (ACCESS_KEY_DENIED.test(message)) return { kind: 'denied', message };
    if (NO_ORDER.test(message)) return { kind: 'reached', message };
    return { kind: 'other', message };
  }
}

const cases = [
  ['relayer key cannot call withdraw_bond', 'denied', relayer, 'withdraw_bond', { amount: '1' }],
  ['relayer key CAN call register_receipt (reached the contract)', 'reached', relayer, 'register_receipt', receiptArgs],
  ['buyer key CAN call claim (reached the contract)', 'reached', buyer, 'claim', { order_id: 'NOPE-S4', response_b64: '' }],
  ['buyer key cannot call register_receipt', 'denied', buyer, 'register_receipt', receiptArgs],
];

let failed = 0;
for (const [label, want, account, method, args] of cases) {
  const r = await call(account, method, args);
  const ok = r.kind === want;
  if (!ok) failed++;
  console.log(`${ok ? 'OK' : r.kind === 'other' ? 'CHECK' : 'FAIL'} ${label}`);
  if (!ok) console.log(`      expected ${want}, got ${r.kind}: ${r.message.slice(0, 200)}`);
}

console.log(failed === 0 ? 'S4 OK (function-call keys scoped as designed)' : `S4 FAILED (${failed} of ${cases.length}) — see docs/BLOCKERS.md`);
process.exit(failed === 0 ? 0 : 1);
