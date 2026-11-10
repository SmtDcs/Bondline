// node --env-file=.env app/scripts/try-chat.mjs A123-01 "My mug arrived broken. Partial refund?"
import { loadConfig, makeRelayer } from '../lib/relayer.mjs';
const r = makeRelayer(loadConfig());
const out = await r.handleChat({ order_id: process.argv[2], message: process.argv[3] });
console.log(out.reply); console.log('register_tx', out.register_tx, out.explorer);
console.log('bundle', `data/bundles/${out.bundle.chat_id}.json`);
