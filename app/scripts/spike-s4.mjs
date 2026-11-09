import { makeProvider, accountFromKey, callFinal } from '../lib/near.mjs';
const p = makeProvider(process.env.NEAR_RPC_URL);
const relayer = accountFromKey(p, process.env.MERCHANT_ID, process.env.RELAYER_SECRET_KEY);
try { await callFinal(relayer, process.env.CONTRACT_ID, 'withdraw_bond', { amount: '1' }); console.log('FAIL: relayer key could call withdraw_bond'); }
catch (e) { console.log(/MethodNameMismatch|method_name|not allowed|does not allow/i.test(String(e.message)) ? 'OK relayer key cannot call withdraw_bond' : `CHECK: ${String(e.message).slice(0, 200)}`); }
