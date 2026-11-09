import { AttestationClient, verifyModelAttestation } from '@nearai/inference-sdk/node';
const model = process.argv[2] || 'z-ai/glm-5.3-flash';
const algo = process.argv[3] || 'ed25519';
const client = new AttestationClient({ baseUrl: 'https://cloud-api.near.ai/v1' });
const fetched = await client.fetchModelAttestations({ model, signingAlgo: algo });
console.log('candidates', fetched.attestations.length);
for (const a of fetched.attestations) {
  try {
    const v = await verifyModelAttestation({ attestation: a, clientBinding: fetched.clientBinding });
    console.log('VERIFIED', JSON.stringify({ signer: v.signer, tcbStatus: v.tcbStatus, gpu: v.gpuEvidence, advisories: v.advisoryIds.length }));
  } catch (e) { console.log('FAILED', e?.code, e?.message); }
}
