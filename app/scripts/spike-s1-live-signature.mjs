#!/usr/bin/env node
// DAY-0 SPIKE S1 (needs NEARAI_API_KEY with a few cents of credit; makes 1-3 chat calls, NO blockchain tx).
// Usage: NEARAI_API_KEY=... node app/scripts/spike-s1-live-signature.mjs [model] [out.json]
// Proves or kills: (a) non-streaming chat + x-no-aliasing gives signature_kind=provider_tee,
// (b) signing_algo=ed25519 is available for it, (c) text == "<model>:<sha256 req>:<sha256 resp>",
// (d) the ed25519 signature verifies with node:crypto, (e) the signer equals a VERIFIED model attestation signer,
// (f) the reply contains exactly one PROMISE token in choices[0].message.content.
import fs from 'node:fs';
import { AttestationClient, verifyModelAttestation } from '@nearai/inference-sdk/node';
import { buildRequestBytes, chatExact, fetchSignature, checkBundle, sha256Hex } from '../lib/nearai.mjs';

const model = process.argv[2] ?? 'z-ai/glm-5.3-flash';
const out = process.argv[3] ?? 'fixtures/live/spike-s1.json';
const apiKey = process.env.NEARAI_API_KEY;
if (!apiKey) { console.error('NEARAI_API_KEY is required'); process.exit(2); }

// 1. preflight: verified model attestation (no key needed)
const ac = new AttestationClient({ baseUrl: 'https://cloud-api.near.ai/v1' });
const fetched = await ac.fetchModelAttestations({ model, signingAlgo: 'ed25519' });
const verified = [];
for (const a of fetched.attestations) verified.push(await verifyModelAttestation({ attestation: a, clientBinding: fetched.clientBinding }));
console.log('attested signers:', verified.map(v => `${v.signer.signingAddress} tcb=${v.tcbStatus} gpu=${v.gpuEvidence}`));

// 2. one honest chat
const requestBytes = buildRequestBytes({
  model, orderId: 'A123', amountNear: '2', maxPolicyBps: 2000, history: [],
  userMessage: 'My mug from order A123 arrived broken. Can I get a partial refund?',
});
const chat = await chatExact({ apiKey, requestBytes });
console.log('chat id', chat.chatId, 'content:', JSON.stringify(chat.json.choices?.[0]?.message?.content));

// 3. signature
const sig = await fetchSignature({ apiKey, chatId: chat.chatId, model, signingAlgo: 'ed25519' });
console.log('signature_kind', sig.signature_kind, 'algo', sig.signing_algo, 'signer', sig.signing_address);

const bundle = {
  type: 'bot-promises/receipt-bundle/v1', simulated: false, order_id: 'A123', model, chat_id: chat.chatId,
  created_at: new Date().toISOString(),
  request_b64: requestBytes.toString('base64'), response_b64: chat.responseBytes.toString('base64'),
  request_hash: sha256Hex(requestBytes), response_hash: sha256Hex(chat.responseBytes),
  signature: sig,
  attestation: { nonce: fetched.clientBinding.nonce, fetched_at: new Date().toISOString(), signers: verified.map(v => v.signer) },
  chain: null,
};
fs.mkdirSync(out.split('/').slice(0, -1).join('/') || '.', { recursive: true });
fs.writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n');

let ok = true;
for (const r of checkBundle(bundle)) { ok &&= r.ok; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}`); }
const signerAttested = verified.some(v => v.signer.signingAlgo === sig.signing_algo && v.signer.signingAddress.toLowerCase() === sig.signing_address.toLowerCase());
console.log(`${signerAttested ? 'PASS' : 'FAIL'}  signer matches a verified model attestation`);
const content = chat.json.choices?.[0]?.message?.content ?? '';
const tokens = (content.match(/PROMISE\|/g) ?? []).length;
console.log(`${tokens === 1 ? 'PASS' : 'WARN'}  exactly one PROMISE token in content (found ${tokens})`);
console.log(ok && signerAttested && sig.signature_kind === 'provider_tee' ? 'S1 GO (provider_tee ed25519)' : 'S1 see fallbacks in PLAN.md section 7');
