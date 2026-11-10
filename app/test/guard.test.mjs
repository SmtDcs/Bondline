// Audit relayer-web-secrets-3: the local server only answers its own dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localGuard } from '../lib/guard.mjs';

const guard = localGuard({ port: 8787 });
function run(method, headers) {
  let result = { passed: false };
  const res = { status(code) { result.status = code; return this; }, json(body) { result.body = body; } };
  guard({ method, headers }, res, () => { result.passed = true; });
  return result;
}
const good = { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'content-type': 'application/json' };

test('the dashboard POST (own Origin, JSON) passes, with or without a charset', () => {
  assert.equal(run('POST', good).passed, true);
  assert.equal(run('POST', { ...good, host: 'localhost:8787', origin: 'http://localhost:8787', 'content-type': 'application/json; charset=utf-8' }).passed, true);
});

test('a cross-site or origin-less POST is refused before anything is signed', () => {
  for (const origin of [undefined, 'null', 'https://evil.example', 'http://127.0.0.1:9999', 'http://127.0.0.1:8787.evil.example']) {
    const r = run('POST', { ...good, origin });
    assert.equal(r.passed, false, String(origin));
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'ERR_FORBIDDEN_ORIGIN');
  }
});

test('text/plain, form and missing content types are refused (the no-preflight CSRF shapes)', () => {
  for (const type of [undefined, 'text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const r = run('POST', { ...good, 'content-type': type });
    assert.equal(r.passed, false, String(type));
    assert.equal(r.status, 415);
  }
});

test('a foreign Host (DNS rebinding) is refused for GET and POST', () => {
  for (const method of ['GET', 'POST']) {
    const r = run(method, { ...good, host: 'rebind.evil.example:8787' });
    assert.equal(r.passed, false);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'ERR_FORBIDDEN_HOST');
  }
  assert.equal(run('GET', { host: '127.0.0.1:8787' }).passed, true, 'GET needs no Origin');
});
