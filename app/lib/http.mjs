// Express wrapper shared by app/server.mjs. Kept in its own module so node tests can drive it
// without starting the server (server.mjs listens on import).
import { errCode } from './relayer.mjs';
import { explorerTx } from './near.mjs';

/**
 * Wrap an async route handler: a thrown Error becomes {error, detail, tx, explorer}.
 * INTERFACES 11: a failed on-chain call answered with `tx` must also carry the explorer link
 * (T17 tamper beat, T18 replay transcript).
 */
export const wrap = (fn, log = console.error) => async (req, res) => {
  try { res.json(await fn(req.body ?? {})); }
  catch (e) {
    const code = errCode(e);
    log(new Date().toISOString(), req.path, code, e?.message?.slice(0, 300));
    res.status(e.status ?? 400).json({
      error: code,
      detail: e.detail ?? String(e.message ?? '').slice(0, 300),
      tx: e.txHash ?? null,
      explorer: e.txHash ? explorerTx(e.txHash) : undefined,
    });
  }
};
