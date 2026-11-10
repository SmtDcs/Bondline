#!/usr/bin/env node
// Usage: node app/scripts/attest.mjs --model z-ai/glm-5.3-flash [--algo ed25519] [--days 5] [--out-dir fixtures/attestation]
// Fetches NEAR model attestation with a fresh nonce, verifies EVERY candidate with @nearai/inference-sdk
// (Intel TDX quote via dcap-qvl, nonce + signer binding, RTMR3 replay, MRCONFIGID, NVIDIA GPU evidence),
// writes the attestation record file (INTERFACES.md section 14) and prints the add_signer command.
// No NEAR AI API key needed. No blockchain transaction is sent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { addSignerCommand } from '../lib/add-signer-command.mjs';
import { AttestationClient, verifyModelAttestation } from '@nearai/inference-sdk/node';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const model = opt('--model', 'z-ai/glm-5.3-flash');
const algo = opt('--algo', 'ed25519');
const days = Number(opt('--days', '5'));
const outDir = opt('--out-dir', 'fixtures/attestation');
const contractId = process.env.CONTRACT_ID ?? '<CONTRACT_ID>';

const client = new AttestationClient({ baseUrl: 'https://cloud-api.near.ai/v1' });
const fetched = await client.fetchModelAttestations({ model, signingAlgo: algo });
if (!fetched.attestations.length) { console.error('NO MODEL ATTESTATIONS returned: stop, see PLAN.md risk R2'); process.exit(1); }
const verified = [];
for (const a of fetched.attestations) {
  const v = await verifyModelAttestation({ attestation: a, clientBinding: fetched.clientBinding }); // throws on any failed check
  verified.push({ signer: v.signer, tcbStatus: v.tcbStatus, gpuEvidence: v.gpuEvidence, advisoryIds: v.advisoryIds });
}
const fetchedAt = new Date().toISOString();
const record = {
  type: 'bot-promises/attestation-record/v1', model, signing_algo: algo, fetched_at: fetchedAt,
  nonce: fetched.clientBinding.nonce, sdk: '@nearai/inference-sdk@0.3.0', verified, reports: fetched.attestations,
};
const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n', 'utf8');
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${model.replaceAll('/', '_')}-${algo}-${fetchedAt.slice(0, 10)}.json`);
fs.writeFileSync(file, bytes);
const expires = Date.now() + days * 86_400_000;
for (const v of verified) {
  const pk = v.signer.signingAddress.replace(/^0x/, '').toLowerCase();
  console.log(`ATTESTED ${pk} tcb=${v.tcbStatus} gpu=${v.gpuEvidence} record=${file} record_sha256=${sha}`);
  const args = JSON.stringify({ public_key_hex: pk, kind: 'provider_tee', model_id: model, attestation_sha256: sha, expires_at_ms: String(expires) });
  console.log(addSignerCommand({ contractId, args: JSON.parse(args), deposit: process.env.ADD_SIGNER_DEPOSIT || undefined }));
}
