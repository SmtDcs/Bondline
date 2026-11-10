import fs from 'node:fs';
const b = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(JSON.stringify({ order_id: b.order_id, signed_text: b.signature.text, signature_hex: b.signature.signature, signer_public_key_hex: b.signature.signing_address }));
