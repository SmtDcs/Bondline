// Replay-mode handlers (T19). Everything comes from the recorded transcript and the committed
// bundles: no NEAR AI call, no .env, no keys, no transactions. INTERFACES.md sections 11 and 15.
import fs from 'node:fs';
import path from 'node:path';
import { explorerTx } from './near.mjs';

export const REPLAY_RPC_URL = 'https://test.rpc.fastnear.com';
const ORDER_ID_RE = /^[A-Za-z0-9-]{1,32}$/;

const fail = (code, status) => Object.assign(new Error(code), { status });

/** `choices[0].message.content` of the exact recorded response bytes (INTERFACES 7). */
export function replyFromBundle(bundle) {
  const json = JSON.parse(Buffer.from(bundle.response_b64, 'base64').toString('utf8'));
  return json?.choices?.[0]?.message?.content ?? '';
}

/** TRUE when the recorded system prompt is the naive ("badly configured") policy (CR-3). */
function naiveBundle(bundle) {
  try {
    const request = JSON.parse(Buffer.from(bundle.request_b64, 'base64').toString('utf8'));
    const system = (request.messages ?? []).find(m => m.role === 'system')?.content ?? '';
    return system.includes('The customer is always right');
  } catch {
    return false;
  }
}

/**
 * makeReplay('fixtures/replay/transcript.json') ->
 *   { handlers: {handleChat, handleClaim, handleRegisterEdited}, publicConfig }
 */
export function makeReplay(transcriptPath = 'fixtures/replay/transcript.json') {
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  if (transcript.type !== 'bot-promises/replay/v1') throw new Error(`not a replay transcript: ${transcriptPath}`);
  const steps = transcript.steps ?? [];

  const chatSteps = steps.filter(s => s.kind === 'chat');
  const bundles = new Map(); // order_id -> {bundle, naive}
  for (const step of chatSteps) {
    const bundle = JSON.parse(fs.readFileSync(path.resolve(step.bundle_file), 'utf8'));
    bundles.set(step.order_id, { bundle, naive: naiveBundle(bundle) });
  }
  const chatByOrder = new Map(chatSteps.map(s => [s.order_id, s]));
  const claimByOrder = new Map(steps.filter(s => s.kind === 'claim').map(s => [s.order_id, s]));
  const editSteps = steps.filter(s => s.kind === 'register-edited');
  const claimed = new Set();

  const orderView = chatSteps.map(s => s.views?.get_order).find(v => v?.merchant && v?.buyer);
  const orders = [];
  for (const step of chatSteps) {
    if (orders.some(o => o.order_id === step.order_id)) continue;
    const entry = { order_id: step.order_id };
    if (bundles.get(step.order_id)?.naive) entry.naive = true;
    orders.push(entry);
  }

  const publicConfig = {
    mode: 'replay',
    network: 'testnet',
    rpcUrl: REPLAY_RPC_URL,
    contractId: transcript.contract,
    merchantId: orderView?.merchant ?? null,
    buyerId: orderView?.buyer ?? null,
    model: bundles.values().next().value?.bundle.model ?? null,
    orders,
  };

  function requireOrderId(order_id) {
    if (typeof order_id !== 'string' || !ORDER_ID_RE.test(order_id)) {
      throw Object.assign(new Error('ERR_BAD_REQUEST'), { status: 400, detail: 'order_id must match ^[A-Za-z0-9-]{1,32}$' });
    }
  }

  /** The recorded chat step for this order; the message text is deliberately ignored. */
  async function handleChat({ order_id } = {}) {
    requireOrderId(order_id);
    const step = chatByOrder.get(order_id);
    const recorded = bundles.get(order_id);
    if (!step || !recorded) throw fail('ERR_NO_ORDER', 404);
    return {
      reply: replyFromBundle(recorded.bundle),
      bundle: recorded.bundle,
      register_tx: step.register_tx,
      explorer: explorerTx(step.register_tx),
      views: step.views,
    };
  }

  /** First call per order returns the recorded claim; every later call is ERR_ALREADY_CLAIMED. */
  async function handleClaim({ order_id } = {}) {
    requireOrderId(order_id);
    if (claimed.has(order_id)) throw fail('ERR_ALREADY_CLAIMED', 400);
    const step = claimByOrder.get(order_id);
    if (!step) throw fail('ERR_NO_ORDER', 404);
    claimed.add(order_id);
    return { ok: true, result: step.result, claim_tx: step.claim_tx, explorer: explorerTx(step.claim_tx) };
  }

  /** The merchant's edited reply can never be registered: the recorded run lost with ERR_BAD_SIGNATURE. */
  async function handleRegisterEdited({ order_id } = {}) {
    const step = editSteps.find(s => s.order_id === order_id) ?? editSteps[0];
    throw Object.assign(new Error('ERR_BAD_SIGNATURE'), { status: 400, txHash: step?.tx ?? null });
  }

  return { handlers: { handleChat, handleClaim, handleRegisterEdited }, publicConfig };
}
