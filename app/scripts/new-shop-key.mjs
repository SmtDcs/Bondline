// v3: makes a NEW shop-auth key, appends its seed to .env as SHOP_AUTH_SEED_HEX and prints only the PUBLIC key
// (register it with set_shop_key; app/scripts/deploy-v3.mjs does that). Never prints the seed.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { publicKeyFromSeed } from '../lib/shop-auth.mjs';

if (fs.existsSync('.env') && /^SHOP_AUTH_SEED_HEX=./m.test(fs.readFileSync('.env', 'utf8'))) {
  console.error('.env already has SHOP_AUTH_SEED_HEX; remove it first if you really want a new key');
  process.exit(1);
}
const seed = crypto.randomBytes(32).toString('hex');
fs.appendFileSync('.env', `\nSHOP_AUTH_SEED_HEX=${seed}\n`);
console.log('SHOP_AUTH_PUBLIC_KEY_HEX', publicKeyFromSeed(seed));
