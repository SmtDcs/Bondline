// Attestation records (fixtures/attestation/*.json, written by `npm run attest`) are the only evidence
// that a signing key belongs to a NEAR AI TEE. Shared by app/verify.mjs and app/scripts/verify-fixtures.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from './nearai.mjs';

/** The deployed contract this repo's receipts live on. verify.mjs trusts this, never the bundle's own claim. */
export const PINNED_CONTRACT = 'cbp-sm1110.testnet';
export const DEFAULT_ATTEST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'attestation');

/** Which contract to check: --contract flag, then CONTRACT_ID config, then the pinned deployment. Never the bundle. */
export function resolveContract(flagValue, env = process.env) {
  return flagValue || env.CONTRACT_ID || PINNED_CONTRACT;
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
 * On-chain signer rows (get_signer result) for a real bundle: provider_tee, model matches, not expired,
 * and attestation_sha256 is the sha256 of a record that lists this signing_address.
 */
export function signerRows(signer, bundle, records, nowMs = Date.now()) {
  if (!signer) return [{ check: 'signer registered in contract (get_signer)', ok: false, detail: 'null' }];
  const addr = String(bundle.signature?.signing_address ?? '').toLowerCase();
  const rec = records.find(r => r.sha256 === String(signer.attestation_sha256 ?? '').toLowerCase());
  const expires = Number(signer.expires_at_ms);
  return [
    { check: 'signer registered in contract (get_signer)', ok: true, detail: `${signer.kind} ${signer.model_id ?? ''} att=${String(signer.attestation_sha256).slice(0, 12)}` },
    { check: 'signer kind is provider_tee', ok: signer.kind === 'provider_tee', detail: String(signer.kind) },
    { check: 'signer model_id == bundle.model', ok: signer.model_id === bundle.model, detail: `${signer.model_id} vs ${bundle.model}` },
    { check: 'signer not expired', ok: Number.isFinite(expires) && expires > nowMs, detail: `expires_at_ms ${signer.expires_at_ms}` },
    { check: 'signer attestation_sha256 is a repo attestation record listing this key', ok: !!rec && rec.signers.has(addr), detail: rec ? rec.file : 'no fixtures/attestation file has that sha256' },
  ];
}
