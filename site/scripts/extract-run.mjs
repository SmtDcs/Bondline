// Writes src/data/run.json from the recorded fixtures. Nothing on the page is typed by hand:
// every value below is read from a fixture and asserted. If a fixture disagrees, the build stops.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(repo, p), 'utf8'));
const must = (cond, what) => { if (!cond) { console.error(`extract-run: ASSERT FAILED: ${what}`); process.exit(1); } };
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Deploying only site/ (e.g. `vercel deploy` from this folder) leaves the fixtures behind: then the
// committed src/data/run.json is used. That is an explicit mode, not a silent one: the artifact must
// carry its provenance, so a deploy says which commit it was generated from instead of pretending the
// numbers were just re-read.
const committed = path.join(here, '../src/data/run.json');
if (!fs.existsSync(path.join(repo, 'fixtures/replay/transcript-v2.json'))) {
  must(fs.existsSync(committed), 'fixtures missing and no committed src/data/run.json');
  const prev = JSON.parse(fs.readFileSync(committed, 'utf8'));
  must(prev.numbers && prev.numbers.sourceCommit, 'the committed run.json has no numbers.sourceCommit (regenerate it from the full repo)');
  must(prev.numbers.sourceCommit === 'uncommitted' || /^[0-9a-f]{7,40}(-dirty)?$/.test(prev.numbers.sourceCommit),
    `committed run.json sourceCommit looks wrong: ${prev.numbers.sourceCommit}`);
  console.log(`extract-run: fixtures not present (site-only build), keeping the committed src/data/run.json from ${prev.numbers.sourceCommit}`);
  process.exit(0);
}
const T = read('fixtures/replay/transcript-v2.json');
must(T.type === 'bot-promises/replay/v2', 'transcript type');
must(T.contract === 'v2.cbp-sm1110.testnet', 'contract id');
must(T.computed_views === true, 'transcript marks computed views');
const tok = T.tokens[0];
must(tok.symbol === 'tUSDC' && tok.decimals === 6, 'token is tUSDC with 6 decimals');
const units = (raw) => Number(raw) / 10 ** tok.decimals;

const kinds = T.steps.map((s) => s.kind).join(',');
must(kinds === 'chat,claim,chat,claim,register-edited,claim-again', `step order (${kinds})`);
const [chatA, claimA, chatB, claimB, edited, again] = T.steps;

function content(bundle) {
  const bytes = Buffer.from(bundle.response_b64, 'base64');
  return { bytes, text: JSON.parse(bytes.toString('utf8')).choices[0].message.content };
}

function verifyBundle(bundle) {
  const { bytes } = content(bundle);
  must(sha256hex(bytes) === bundle.response_hash, `${bundle.order_id}: sha256(response bytes) == response_hash`);
  must(sha256hex(Buffer.from(bundle.request_b64, 'base64')) === bundle.request_hash, `${bundle.order_id}: request hash`);
  const s = bundle.signature;
  must(s.signing_algo === 'ed25519' && s.signature_kind === 'provider_tee', `${bundle.order_id}: signature kind`);
  must(s.text === `${bundle.model}:${bundle.request_hash}:${bundle.response_hash}`, `${bundle.order_id}: signed text shape`);
  const key = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(s.signing_address, 'hex')]),
    format: 'der', type: 'spki',
  });
  must(crypto.verify(null, Buffer.from(s.text, 'utf8'), key, Buffer.from(s.signature, 'hex')), `${bundle.order_id}: ed25519 signature verifies`);
}

function order(chat, claim) {
  const bundle = read(chat.bundle_file);
  must(bundle.simulated === false, `${chat.order_id}: bundle is not simulated`);
  must(bundle.order_id === chat.order_id && claim.order_id === chat.order_id, `${chat.order_id}: ids line up`);
  verifyBundle(bundle);
  const { text } = content(bundle);
  const lines = text.split('\n');
  const token = lines[lines.length - 1];
  const m = /^PROMISE\|refund\|order=([A-Za-z0-9-]{1,32})\|bps=(\d+)$/.exec(token);
  must(m && m[1] === chat.order_id, `${chat.order_id}: token line`);
  const o = chat.views.get_order, r = chat.views.get_receipt, p = chat.views.preview_claim;
  must(Number(m[2]) === claim.result.token_bps, `${chat.order_id}: token bps == claim token_bps`);
  must(claim.result.ok === true && claim.result.error === null, `${chat.order_id}: claim ok`);
  must(Number(o.liability) === Number(o.amount) * o.max_bps / 10000, `${chat.order_id}: liability == amount * max_bps`);
  must(claim.result.paid_bps === Math.min(claim.result.token_bps, o.max_bps), `${chat.order_id}: paid_bps == min(bps, max_bps)`);
  must(Number(claim.result.payout) === Number(o.amount) * claim.result.paid_bps / 10000, `${chat.order_id}: payout`);
  must(p.computed === true && Number(p.payout) === Number(claim.result.payout), `${chat.order_id}: preview is computed and equals the claim`);
  must(r.response_hash === bundle.response_hash && r.signature_kind === 'provider_tee', `${chat.order_id}: receipt`);
  const system = JSON.parse(Buffer.from(bundle.request_b64, 'base64').toString('utf8')).messages[0].content;
  return {
    bundle, system,
    out: {
      id: chat.order_id,
      amount: units(o.amount), maxBps: o.max_bps, reserved: units(o.liability),
      message: chat.message,
      reply: lines.slice(0, -1).join('\n').trim(),
      token,
      tokenBps: claim.result.token_bps, paidBps: claim.result.paid_bps, paid: units(claim.result.payout),
      registerTx: chat.register_tx, claimTx: claim.claim_tx, block: r.block_height,
      previewComputed: true,
    },
  };
}

const A = order(chatA, claimA);
const B = order(chatB, claimB);
must(A.out.amount === 20 && A.out.maxBps === 3000 && A.out.reserved === 6 && A.out.tokenBps === 2000 && A.out.paid === 4, 'order A: 20 tUSDC, cap 30%, promise 20%, paid 4');
must(B.out.amount === 20 && B.out.maxBps === 3000 && B.out.tokenBps === 10000 && B.out.paidBps === 3000 && B.out.paid === 6, 'order B: promise 100%, paid 30% = 6');
must(/partial refund of 2000 basis points/.test(A.system), 'order A: the shop prompt allows 2000 bps');
must(/partial refund of 10000 basis points/.test(B.system) && /customer is always right/.test(B.system), 'order B: the shop prompt itself allows 10000 bps');

// Refusals.
must(edited.error === 'ERR_BAD_SIGNATURE' && edited.order_id === A.out.id && edited.tx, 'edited reply -> ERR_BAD_SIGNATURE with a tx');
must(again.error === 'ERR_ALREADY_CLAIMED' && again.order_id === A.out.id, 'second claim -> ERR_ALREADY_CLAIMED');
const tam = chatA.views.tamper;
must(tam.preview_claim.error === 'ERR_NO_RECEIPT_FOR_BYTES' && tam.preview_claim.computed === true && tam.get_receipt === null, 'tamper -> ERR_NO_RECEIPT_FOR_BYTES (computed)');
const tamBytes = Buffer.from(tam.response_b64, 'base64');
must(sha256hex(tamBytes) === tam.response_hash && tam.response_hash !== A.bundle.response_hash, 'tampered bytes hash differently');
must(content({ response_b64: tam.response_b64 }).text.endsWith('bps=3000'), 'tamper edits 2000 -> 3000');
// The page makes the same edit in the browser: check it gives the same bytes as the recorded tamper.
const orig = Buffer.from(A.bundle.response_b64, 'base64').toString('utf8');
must(orig.split('bps=2000').length === 2, 'the token appears exactly once in the raw bytes');
must(Buffer.from(orig.replace('bps=2000', 'bps=3000'), 'utf8').equals(tamBytes), 'in-page tamper == recorded tamper');

// Reservation: the whole per-order cap leaves `reserved` after a claim (recorded final view after both claims).
const mEnd = chatB.views.get_merchant, mStart = chatA.views.get_merchant;
must(mStart.computed === true && !mEnd.computed, 'first bond view is computed, the last is recorded');
must(units(mStart.reserved) - units(mEnd.reserved) === A.out.reserved + B.out.reserved, 'reserved falls by both caps');
must(units(mStart.bond) - units(mEnd.bond) === A.out.paid + B.out.paid, 'bond falls by both payouts');

// Live-run numbers.
const L = read('fixtures/runs/v2-live-run.json');
const txs = L.txs.length, failures = L.txs.filter((t) => t.ok === false).length;
must(txs === 91 && failures === 32, `live run: 91 txs, 32 failures (got ${txs}, ${failures})`);
const paidTusdc = L.gas.claims.filter((c) => c.outcome === 'paid' && c.ft_transfer_T != null).map((c) => c.total_T);
must(paidTusdc.length >= 3 && paidTusdc.every((g) => g > 7.6 && g < 7.8), 'a paid tUSDC claim burns about 7.7 Tgas');

// Test counts come from the repo README, not from this file: the page must never show a number the
// README contradicts. A change to the README's "Numbers" section fails the build until run.json is
// regenerated (and a site-only deploy keeps the committed run.json, which carries its source commit).
const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
// The "## Numbers" section only, matched as an exact level-two heading at the start of a line.
const section = (() => {
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## Numbers (all re-checkable in this repo)' || l.trim() === '## Numbers');
  must(start >= 0, 'README has an exact "## Numbers" heading');
  const next = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, next < 0 ? undefined : next).join('\n');
})();
// Exactly one total, so a second contradictory count cannot be ignored.
const totals = [...section.matchAll(/\*\*(\d+) tests\*\*/g)].map((m) => Number(m[1]));
must(totals.length === 1, `README Numbers section has exactly one "**<n> tests**" line (found ${totals.length})`);
const numbersLine = section.split('\n').find((l) => /\*\*\d+ tests\*\*/.test(l));
const one = (re, what, text) => {
  const all = [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
  must(all.length === 1, `README numbers: expected exactly one "${what}" (found ${all.length})`);
  return Number(all[0][1]);
};
const testsTotal = one(/\*\*(\d+) tests\*\*/, 'total tests', numbersLine);
const testsJs = one(/(\d+) JS\b/, 'JS tests', numbersLine);
const testsV1 = one(/(\d+) Rust on v1\b/, 'v1 Rust tests', numbersLine);
const testsV2 = one(/(\d+) Rust on v2\b/, 'v2 Rust tests', numbersLine);
const dates = [...numbersLine.matchAll(/all passed on (\d{4}-\d{2}-\d{2})/g)];
must(dates.length === 1, 'README numbers line: expected exactly one pass date');
const testsDate = dates[0][1];
must(testsJs + testsV1 + testsV2 === testsTotal,
  `README numbers add up: ${testsJs} JS + ${testsV1} v1 + ${testsV2} v2 === ${testsTotal}`);
const receipts = one(/\*\*(\d+) real NEAR AI receipts\*\*/, 'receipts', section);
const tampered = one(/(\d+) deliberately edited/, 'tampered receipts', section);
// Provenance: the commit that last changed the INPUTS (the README numbers and the fixtures this file
// reads), not HEAD. Using HEAD would rewrite run.json on every unrelated commit and leave the tree
// dirty forever; this value is stable until the numbers themselves change. A dirty input says
// "uncommitted" instead of naming a commit a visitor cannot check out.
let sourceCommit = 'uncommitted';
const readmeSha = sha256hex(Buffer.from(readme, 'utf8')).slice(0, 16);
try {
  const inputs = ['README.md', 'fixtures/replay/transcript-v2.json', 'fixtures/runs/v2-live-run.json'];
  const dirty = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', ...inputs],
    { encoding: 'utf8' }).trim();
  if (!dirty) {
    sourceCommit = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%h', '--', ...inputs],
      { encoding: 'utf8' }).trim() || 'uncommitted';
  }
} catch { /* a site-only checkout has no git history: the committed run.json keeps the value it was built with */ }
const tgas = paidTusdc.reduce((a, b) => a + b, 0) / paidTusdc.length;

const s = A.bundle.signature;
const out = {
  generatedFrom: ['README.md', 'fixtures/replay/transcript-v2.json', chatA.bundle_file, chatB.bundle_file, 'fixtures/runs/v2-live-run.json'],
  contract: T.contract, recordedAt: T.recorded_at, token: tok.symbol,
  orders: { a: A.out, b: B.out },
  refusals: {
    edited: { error: edited.error, tx: edited.tx },
    tamper: { error: tam.preview_claim.error, computed: true, hash: tam.response_hash },
    again: { error: again.error },
  },
  bond: { start: { bond: units(mStart.bond), reserved: units(mStart.reserved), computed: true }, end: { bond: units(mEnd.bond), reserved: units(mEnd.reserved) } },
  liveRun: { txs, failures },
  numbers: {
    tests: { total: testsTotal, js: testsJs, v1: testsV1, v2: testsV2, date: testsDate },
    txs, failures, receipts, tampered, tgas: Math.round(tgas * 10) / 10,
    sourceCommit, readmeSha,
  },
  verify: {
    orderId: A.out.id, model: A.bundle.model,
    responseB64: A.bundle.response_b64, requestHash: A.bundle.request_hash, responseHash: A.bundle.response_hash,
    signedText: s.text, signatureHex: s.signature, publicKeyHex: s.signing_address,
  },
};
const dest = path.join(here, '../src/data/run.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`extract-run: ok (${T.steps.length} steps, 2 bundles verified, ${txs} txs / ${failures} failures) -> src/data/run.json`);
