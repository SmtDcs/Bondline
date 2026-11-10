// Request guard for the local demo server (audit relayer-web-secrets-3). The server signs real
// testnet transactions with function-call keys and spends NEAR AI credit, so a web page the operator
// happens to have open must not be able to drive it:
//  - Host must be the loopback name we listen on (stops DNS rebinding),
//  - every POST must come from the dashboard itself (Origin = this server) and be application/json
//    (a cross-site form or no-cors fetch can only send text/plain, urlencoded or multipart).
// Called with `node`-style (req, res, next) so it works as Express middleware and in plain tests.

export function allowedHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

const reject = (res, status, error, detail) => res.status(status).json({ error, detail, tx: null });

export function localGuard({ port }) {
  const hosts = allowedHosts(port);
  const origins = hosts.map(h => `http://${h}`);
  return (req, res, next) => {
    const host = String(req.headers?.host ?? '').toLowerCase();
    if (!hosts.includes(host)) return reject(res, 403, 'ERR_FORBIDDEN_HOST', `Host must be one of ${hosts.join(', ')}`);
    if (req.method === 'POST') {
      const origin = String(req.headers?.origin ?? '').toLowerCase();
      if (!origins.includes(origin)) return reject(res, 403, 'ERR_FORBIDDEN_ORIGIN', 'POST requires the dashboard Origin');
      const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') return reject(res, 415, 'ERR_BAD_CONTENT_TYPE', 'Content-Type must be application/json');
    }
    next();
  };
}
