// Prints two NEW public keys and appends the secrets to .env (never prints secrets).
import fs from 'node:fs';
import { KeyPair } from 'near-api-js';
const relayer = KeyPair.fromRandom('ed25519');
const buyer = KeyPair.fromRandom('ed25519');
fs.appendFileSync('.env', `\nRELAYER_SECRET_KEY=${relayer.toString()}\nBUYER_CLAIM_SECRET_KEY=${buyer.toString()}\n`);
console.log('RELAYER_PUBLIC_KEY', relayer.getPublicKey().toString());
console.log('BUYER_CLAIM_PUBLIC_KEY', buyer.getPublicKey().toString());
