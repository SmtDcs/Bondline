// Attestation records (fixtures/attestation/*.json, written by `npm run attest`) are the only evidence
// that a signing key belongs to a NEAR AI TEE. Shared by app/verify.mjs and app/scripts/verify-fixtures.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from './nearai.mjs';

/** The current deployment (stablecoin v2). verify.mjs checks this unless told otherwise. */
export const PINNED_CONTRACT = 'v2.cbp-sm1110.testnet';
/** The first deployment, kept as recorded history: its fixtures keep verifying against it. */
export const PINNED_V1_CONTRACT = 'cbp-sm1110.testnet';
/** The only contracts a bundle's own `chain.contract` may select; any other name is ignored (forged bundle). */
export const KNOWN_CONTRACTS = [PINNED_V1_CONTRACT, PINNED_CONTRACT];
export const DEFAULT_ATTEST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'attestation');

/**
 * Which contract to check: --contract flag, then CONTRACT_ID config, then the contract a bundle names IF it is
 * one of the two repo deployments (KNOWN_CONTRACTS, so the v1 fixtures keep verifying against v1), then the
 * current pinned deployment. A bundle can never select any other contract.
 */
export function resolveContract(flagValue, env = process.env, bundleContract = null) {
  if (flagValue) return flagValue;
  if (env.CONTRACT_ID) return env.CONTRACT_ID;
  if (KNOWN_CONTRACTS.includes(bundleContract)) return bundleContract;
  return PINNED_CONTRACT;
}

/** [{file, sha256, signers: Set<lowercase signingAddress verified by the SDK>, model}] for every readable record. */
export function loadAttestations(dir = DEFAULT_ATTEST_DIR) {
  const out = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return out;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    try {
      const bytes = fs.readFileSync(path.join(dir, f));
      const rec = JSON.parse(bytes.toString('utf8'));
      const signers = new Set();
      for (const v of rec.verified ?? []) if (v?.signer?.signingAddress) signers.add(String(v.signer.signingAddress).toLowerCase());
      out.push({ file: f, sha256: sha256Hex(bytes), signers, model: rec.model ?? null });
    } catch { /* an unreadable record attests nothing */ }
  }
  return out;
}

export const attestedSignerSet = (records) => new Set(records.flatMap(r => [...r.signers]));

/** Offline row: the bundle's signing_address must be a verified signer of some attestation record. */
export function attestedRow(bundle, records) {
  const addr = String(bundle.signature?.signing_address ?? '').toLowerCase();
  const rec = records.find(r => r.signers.has(addr));
  return { check: 'signing_address is a verified signer in fixtures/attestation', ok: !!rec, detail: rec ? `${addr.slice(0, 12)}... in ${rec.file}` : `${addr.slice(0, 12)}... not in any attestation record` };
}

/**
 * On-chain signer rows (get_signer result) for a real bundle: provider_tee, model matches, signer validity,
 * and attestation_sha256 is the sha256 of a record that lists this signing_address.
 *
 * Validity: a receipt is judged by whether its signer was valid WHEN IT WAS REGISTERED
 * (`receipt.registered_at_ms`, on chain), not by today's clock: receipts already on chain stay valid after the signer
 * expires (only new register_receipt calls fail). Without a receipt the signer must be unexpired at `nowMs`
 * (row name `signer not expired`). The signer's current expiry is also printed as an informational row.
 */
export function signerRows(signer, bundle, records, nowMs = Date.now(), receipt = null) {
  if (!signer) return [{ check: 'signer registered in contract (get_signer)', ok: false, detail: 'null' }];
  const addr = String(bundle.signature?.signing_address ?? '').toLowerCase();
  const rec = records.find(r => r.sha256 === String(signer.attestation_sha256 ?? '').toLowerCase());
  const expires = Number(signer.expires_at_ms);
  const registeredAt = receipt?.registered_at_ms != null ? Number(receipt.registered_at_ms) : NaN;
  const atReceipt = Number.isFinite(registeredAt);
  const validity = atReceipt
    ? { check: 'signer valid when the receipt was registered', ok: Number.isFinite(expires) && expires > registeredAt, detail: `expires_at_ms ${signer.expires_at_ms} > receipt registered_at_ms ${receipt.registered_at_ms}` }
    : { check: 'signer not expired', ok: Number.isFinite(expires) && expires > nowMs, detail: `expires_at_ms ${signer.expires_at_ms}` };
  const now = Number.isFinite(expires) ? `${new Date(expires).toISOString()} (${expires > nowMs ? 'still valid now' : 'expired now: new register_receipt calls fail, receipts already on chain stay valid'})` : 'unknown';
  return [
    { check: 'signer registered in contract (get_signer)', ok: true, detail: `${signer.kind} ${signer.model_id ?? ''} att=${String(signer.attestation_sha256).slice(0, 12)}` },
    { check: 'signer kind is provider_tee', ok: signer.kind === 'provider_tee', detail: String(signer.kind) },
    { check: 'signer model_id == bundle.model', ok: signer.model_id === bundle.model, detail: `${signer.model_id} vs ${bundle.model}` },
    validity,
    { check: 'signer attestation_sha256 is a repo attestation record listing this key', ok: !!rec && rec.signers.has(addr), detail: rec ? rec.file : 'no fixtures/attestation file has that sha256' },
    { check: 'signer current expiry (informational)', ok: true, detail: now },
  ];
}
