// Execute a demo-setup plan (app/lib/demo-setup-plan.mjs) with near-api-js. Shared by
// app/scripts/demo-setup-v2.mjs and app/scripts/live-v2.mjs so there is one code path.
import { sendTx, retry, txLine } from './live-tx.mjs';
import { view } from './near.mjs';

/** True when the step's one-time condition says "already done". */
export async function shouldSkip(provider, step, viewFn = view) {
  if (!step.skipIf) return false;
  const { contractId, method, args } = step.skipIf.view;
  const v = await retry(() => viewFn(provider, contractId, method, args));
  const present = v !== null && v !== undefined;
  return (step.skipIf.when === 'present') === present;
}

/**
 * Run the steps in order with `accounts[step.signer]`. `onTx(record)` gets every record (failures too).
 * Stops at the first failed step unless `step.optional`. Returns { records, skipped, stoppedAt }.
 */
export async function runPlan(provider, steps, accounts, { onTx = () => {}, log = console.log, stepName } = {}) {
  const records = [];
  const skipped = [];
  for (const s of steps) {
    if (await shouldSkip(provider, s)) { skipped.push(s.id); log(`skip ${s.id} (${s.skipIf.view.method} is ${s.skipIf.when})`); continue; }
    const account = accounts[s.signer];
    if (!account) throw new Error(`no account for signer ${s.signer}`);
    const rec = await sendTx(provider, account, {
      contractId: s.contractId, method: s.method, args: s.args, tgas: s.tgas, depositYocto: s.depositYocto,
      step: stepName ?? s.id, label: s.id,
    });
    records.push(rec);
    onTx(rec);
    log(txLine(rec));
    if (!rec.ok && !s.optional) return { records, skipped, stoppedAt: s.id };
  }
  return { records, skipped, stoppedAt: null };
}
