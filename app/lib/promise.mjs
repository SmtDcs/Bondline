// JS mirror of contract/src/parse.rs (INTERFACES.md section 7). Same error strings. Used by the UI and tests.
export function extractContent(responseBytes) {
  let j;
  try { j = JSON.parse(new TextDecoder().decode(responseBytes)); } catch { return { error: 'ERR_RESPONSE_JSON' }; }
  if (!Array.isArray(j?.choices) || j.choices.length === 0) return { error: 'ERR_RESPONSE_NO_CHOICE' };
  const c = j.choices[0]?.message?.content;
  if (typeof c !== 'string') return { error: 'ERR_RESPONSE_NO_CONTENT' };
  return { content: c };
}

export function parsePromise(content) {
  const count = content.split('PROMISE|').length - 1;
  if (count === 0) return { error: 'ERR_NO_PROMISE_TOKEN' };
  if (count > 1) return { error: 'ERR_MULTIPLE_PROMISE_TOKENS' };
  let rest = content.slice(content.indexOf('PROMISE|'));
  if (!rest.startsWith('PROMISE|refund|order=')) return { error: 'ERR_TOKEN_GRAMMAR' };
  rest = rest.slice('PROMISE|refund|order='.length);
  const sep = rest.indexOf('|bps=');
  if (sep < 0) return { error: 'ERR_TOKEN_GRAMMAR' };
  const orderId = rest.slice(0, sep);
  if (!/^[A-Za-z0-9-]{1,32}$/.test(orderId)) return { error: 'ERR_TOKEN_ORDER_ID' };
  const digits = (rest.slice(sep + 5).match(/^[0-9]*/) ?? [''])[0];
  if (digits.length === 0 || digits.length > 5) return { error: 'ERR_TOKEN_BPS' };
  const bps = Number(digits);
  if (bps < 1 || bps > 10000) return { error: 'ERR_TOKEN_BPS' };
  return { orderId, bps };
}
