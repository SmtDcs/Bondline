// node app/scripts/vectors-to-bundles.mjs contract/tests/vectors.json fixtures/simulated
// Turns the SIMULATED test vectors into receipt-bundle/v1 files (for offline replay and verify tests).
import fs from 'node:fs'; import path from 'node:path';
const [src, outDir] = process.argv.slice(2);
const v = JSON.parse(fs.readFileSync(src, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
for (const [name, x] of Object.entries(v)) {
  const bundle = {
    type: 'bot-promises/receipt-bundle/v1', simulated: true, order_id: x.order_id, model: x.model,
    chat_id: `chatcmpl-${name}`, created_at: '2026-11-08T00:00:00.000Z',
    request_b64: x.request_b64, response_b64: x.response_b64, request_hash: x.request_hash, response_hash: x.response_hash,
    signature: { text: x.signed_text, signature: x.signature_hex, signing_address: x.signer_public_key_hex, signing_algo: 'ed25519', signature_kind: 'provider_tee' },
    attestation: null, chain: null,
  };
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(bundle, null, 2) + '\n');
  console.log('wrote', path.join(outDir, `${name}.json`));
}
