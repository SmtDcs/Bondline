// NEAR AI Cloud client that keeps the EXACT request and response bytes.
// Sources: https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md
//          https://github.com/nearai/cloud-api crates/api/src/routes/attestation/signature.rs
// Rules (do not change): non-streaming, canonical model id, header x-no-aliasing: true,
// Accept-Encoding: identity, hash the raw bytes, never re-serialize JSON.
import crypto from 'node:crypto';

export const NEARAI_BASE = 'https://cloud-api.near.ai/v1';

export function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** System prompt v1 (FROZEN: changing it changes every request hash, that is fine, but keep the grammar text). */
export function systemPrompt({ orderId, amountNear, maxPolicyBps }) {
  return [
    'You are the support assistant of Demo Mug Shop.',
    `The customer is asking about order ${orderId}, total ${amountNear} NEAR.`,
    `Shop policy: for a damaged item you may offer a partial refund of ${maxPolicyBps} basis points (100 bps = 1%).`,
    'If and only if you promise a refund, end your reply with ONE final line, exactly in this format and nothing else on that line:',
    `PROMISE|refund|order=${orderId}|bps=<N>`,
    'where <N> is the refund in basis points, an integer from 1 to 10000.',
    'Write that line at most once. Never write it if you do not promise a refund.',
  ].join('\n');
}

/**
 * Build the request body ONCE. Returns a Buffer. Key order is fixed by this literal.
 * @returns {Buffer}
 */
export function buildRequestBytes({ model, orderId, amountNear, maxPolicyBps, history, userMessage }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt({ orderId, amountNear, maxPolicyBps }) },
      ...history, // [{role:'user'|'assistant', content:string}] earlier turns, plain text only
      { role: 'user', content: userMessage },
    ],
    stream: false,
    temperature: 0,
    max_tokens: 400,
    reasoning_effort: 'low', // GLM-5.3 Flash: minimal reasoning (docs.near.ai/cloud/reasoning-models.md)
  };
  return Buffer.from(JSON.stringify(body), 'utf8');
}

/** POST /v1/chat/completions with exact bytes. Returns { requestBytes, responseBytes, json, chatId }. */
export async function chatExact({ apiKey, requestBytes }) {
  const res = await fetch(`${NEARAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'x-no-aliasing': 'true',
      'Accept-Encoding': 'identity',
    },
    body: requestBytes,
  });
  const responseBytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`NEAR AI chat HTTP ${res.status}: ${responseBytes.toString('utf8').slice(0, 300)}`);
  const json = JSON.parse(responseBytes.toString('utf8'));
  return { requestBytes, responseBytes, json, chatId: json.id };
}

/** GET /v1/signature/<id>. Non-streaming provider signatures are stored asynchronously: poll on 404. */
export async function fetchSignature({ apiKey, chatId, model, signingAlgo = 'ed25519', tries = 20, delayMs = 1000 }) {
  const url = `${NEARAI_BASE}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=${signingAlgo}`;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` } });
    const text = await res.text();
    if (res.status === 404) { await new Promise(r => setTimeout(r, delayMs)); continue; }
    if (!res.ok) throw new Error(`signature HTTP ${res.status}: ${text.slice(0, 300)}`);
    const sig = JSON.parse(text);
    if (sig.error_code) throw new Error(`signature unavailable: ${sig.error_code} ${sig.message}`);
    return sig; // { text, signature, signing_address, signing_algo, signature_kind }
  }
  throw new Error(`signature not found after ${tries} tries`);
}

/** Raw 32-byte ed25519 public key (hex) -> KeyObject. */
export function ed25519PublicKey(hex) {
  const raw = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  if (raw.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
}

/**
 * Off-chain check of one bundle (same rules as the contract). Returns an array of
 * { check, ok, detail } rows. Never throws for a failed check.
 */
export function checkBundle(bundle) {
  const rows = [];
  const add = (check, ok, detail = '') => rows.push({ check, ok: !!ok, detail });
  const req = Buffer.from(bundle.request_b64, 'base64');
  const res = Buffer.from(bundle.response_b64, 'base64');
  const reqH = sha256Hex(req), resH = sha256Hex(res);
  add('sha256(request bytes) == bundle.request_hash', reqH === bundle.request_hash, reqH);
  add('sha256(response bytes) == bundle.response_hash', resH === bundle.response_hash, resH);
  const s = bundle.signature;
  const expected = s.signature_kind === 'gateway' ? `${reqH}:${resH}` : `${bundle.model}:${reqH}:${resH}`;
  add('signed text rebuilt from bytes == signature.text', s.text === expected, s.text);
  let sigOk = false;
  if (s.signing_algo === 'ed25519') {
    try {
      sigOk = crypto.verify(null, Buffer.from(s.text, 'utf8'), ed25519PublicKey(s.signing_address), Buffer.from(s.signature.replace(/^0x/, ''), 'hex'));
    } catch (e) { sigOk = false; }
  }
  add(`ed25519 signature valid for ${s.signing_address.slice(0, 12)}...`, sigOk, s.signing_algo);
  add('signature_kind', ['provider_tee', 'gateway'].includes(s.signature_kind), s.signature_kind);
  return rows;
}
