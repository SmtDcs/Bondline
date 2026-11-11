// JS mirror of contract-v2/src/parse.rs (INTERFACES.md section 7). Same error strings. Used by the UI and tests.
// The contract is the authority: app/test/promise.test.mjs runs this file against the SAME vectors as the Rust
// tests (contract-v2/tests/parser_vectors.json), so the two cannot drift apart unnoticed.
//
// extractContent mirrors serde_json + the derived structs in parse.rs, not JSON.parse: a duplicate `choices` /
// `message` / `content` key, a second choice without `message`, a non-string `content`, a lone surrogate escape,
// invalid UTF-8 and a leading BOM are all ERR_RESPONSE_JSON there, and arrays are read positionally by serde.
// Known gap: nesting deeper than the JS call stack (thousands of levels) is ERR_RESPONSE_JSON here and accepted in Rust.

const JSON_ERROR = { error: 'ERR_RESPONSE_JSON' };
class Bad extends Error {}

/** Strict JSON reader that keeps duplicate keys. Values: {t:'obj',e:[[k,v]..]} {t:'arr',v:[..]} {t:'str',v} {t:'null'} {t:'other'}. */
function readStrictJson(text) {
  let i = 0;
  const fail = () => { throw new Bad(); };
  const ws = () => { while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r') i++; };
  const hex4 = () => {
    const h = text.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) fail();
    i += 4;
    return parseInt(h, 16);
  };
  function str() {
    i++; // opening quote
    let out = '';
    for (;;) {
      const c = text[i];
      if (c === undefined) fail();
      const code = c.charCodeAt(0);
      if (c === '"') { i++; return out; }
      if (code < 0x20) fail();
      if (c !== '\\') { out += c; i++; continue; }
      i++;
      const e = text[i++];
      if (e === 'u') {
        const u = hex4();
        if (u >= 0xd800 && u <= 0xdbff) {
          if (text[i] !== '\\' || text[i + 1] !== 'u') fail();
          i += 2;
          const lo = hex4();
          if (lo < 0xdc00 || lo > 0xdfff) fail();
          out += String.fromCharCode(u, lo);
        } else if (u >= 0xdc00 && u <= 0xdfff) fail();
        else out += String.fromCharCode(u);
      } else if (e !== undefined && '"\\/bfnrt'.includes(e)) out += { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e] ?? e;
      else fail();
    }
  }
  function value() {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      const e = [];
      if (text[i] === '}') { i++; return { t: 'obj', e }; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const k = str(); ws();
        if (text[i++] !== ':') fail();
        e.push([k, value()]); ws();
        const d = text[i++];
        if (d === '}') return { t: 'obj', e };
        if (d !== ',') fail();
      }
    }
    if (c === '[') {
      i++; ws();
      const v = [];
      if (text[i] === ']') { i++; return { t: 'arr', v }; }
      for (;;) {
        v.push(value()); ws();
        const d = text[i++];
        if (d === ']') return { t: 'arr', v };
        if (d !== ',') fail();
      }
    }
    if (c === '"') return { t: 'str', v: str() };
    for (const [lit, v] of [['true', { t: 'other' }], ['false', { t: 'other' }], ['null', { t: 'null' }]]) {
      if (text.startsWith(lit, i)) { i += lit.length; return v; }
    }
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 4000));
    if (!m) fail();
    i += m[0].length;
    return { t: 'other' };
  }
  const v = value();
  ws();
  if (i !== text.length) fail();
  return v;
}

/** serde derive semantics for a struct with the given field names: a map (keys matched exactly, duplicates and a missing
 *  required field are errors, unknown keys ignored) or a sequence of exactly `fields.length` elements. */
function structFields(v, fields, optional = []) {
  if (v.t === 'arr') {
    if (v.v.length !== fields.length) throw new Bad();
    return Object.fromEntries(fields.map((f, n) => [f, v.v[n]]));
  }
  if (v.t !== 'obj') throw new Bad();
  const out = {};
  for (const [k, val] of v.e) {
    if (!fields.includes(k)) continue;
    if (Object.hasOwn(out, k)) throw new Bad(); // duplicate field
    out[k] = val;
  }
  for (const f of fields) if (!Object.hasOwn(out, f) && !optional.includes(f)) throw new Bad();
  return out;
}

export function extractContent(responseBytes) {
  let top;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(responseBytes);
    top = readStrictJson(text);
  } catch (e) {
    if (e instanceof Bad || e instanceof TypeError || e instanceof RangeError) return JSON_ERROR;
    throw e;
  }
  let messages;
  try {
    const { choices } = structFields(top, ['choices']);
    if (choices.t !== 'arr') throw new Bad();
    messages = choices.v.map((choice) => structFields(structFields(choice, ['message']).message, ['content'], ['content']));
  } catch (e) {
    if (e instanceof Bad) return JSON_ERROR;
    throw e;
  }
  if (messages.length === 0) return { error: 'ERR_RESPONSE_NO_CHOICE' };
  const content = messages[0].content; // `Option<String>`: absent and null are None, any other type is a JSON error
  if (content === undefined || content.t === 'null') return { error: 'ERR_RESPONSE_NO_CONTENT' };
  if (content.t !== 'str') return JSON_ERROR;
  return { content: content.v };
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
