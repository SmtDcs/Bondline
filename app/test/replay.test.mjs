// Replay-mode handlers. Everything is driven by the committed transcript and bundles:
// no .env, no NEAR AI call, no network, no transactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeReplay, replyFromBundle, REPLAY_RPC_URL } from '../lib/replay.mjs';
import { wrap } from '../lib/http.mjs';
import { explorerTx } from '../lib/near.mjs';

const TRANSCRIPT_FILE = 'fixtures/replay/transcript.json';
const transcript = JSON.parse(fs.readFileSync(TRANSCRIPT_FILE, 'utf8'));
const readBundle = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const make = () => makeReplay(TRANSCRIPT_FILE);
const chatSteps = transcript.steps.filter(s => s.kind === 'chat');
const claimStep = transcript.steps.find(s => s.kind === 'claim');
const editedStep = transcript.steps.find(s => s.kind === 'register-edited');
const recordedBundle = (orderId) => readBundle(chatSteps.find(c => c.order_id === orderId).bundle_file);
const claimBytes = recordedBundle(claimStep.order_id).response_b64;
const editedRequest = () => ({ order_id: editedStep.order_id, bundle: recordedBundle(editedStep.order_id), edit: { from: 'bps=2000', to: 'bps=3000' } });

const call = (handler, body = {}) => new Promise((resolve) => {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { resolve({ status: this.statusCode, body: payload }); },
  };
  handler({ body, path: '/api/test' }, res);
});

test('publicConfig is derived from the transcript and the bundles', () => {
  const { publicConfig } = make();
  const orderView = chatSteps[0].views.get_order;
  assert.equal(publicConfig.mode, 'replay');
  assert.equal(publicConfig.network, 'testnet');
  assert.equal(publicConfig.rpcUrl, REPLAY_RPC_URL);
  assert.equal(publicConfig.rpcUrl, 'https://test.rpc.fastnear.com');
  assert.equal(publicConfig.contractId, transcript.contract);
  assert.equal(publicConfig.merchantId, orderView.merchant);
  assert.equal(publicConfig.buyerId, orderView.buyer);
  assert.equal(publicConfig.model, readBundle(chatSteps[0].bundle_file).model);
  assert.deepEqual(publicConfig.orders.map(o => o.order_id), [...new Set(chatSteps.map(s => s.order_id))]);
  assert.doesNotMatch(JSON.stringify(publicConfig), /ed25519:|sk-|SECRET/);
});

test('the recorded injection order keeps its "badly configured bot" flag', () => {
  const naive = make().publicConfig.orders.filter(o => o.naive === true);
  assert.equal(naive.length, 1);
  assert.ok(naive[0].order_id.startsWith('A124-'));
});

test('handleChat returns the recorded step for the order and ignores the message text', async () => {
  const { handlers } = make();
  const step = chatSteps[0];
  const bundle = readBundle(step.bundle_file);

  const out = await handlers.handleChat({ order_id: step.order_id, message: 'x' });
  assert.equal(out.reply, replyFromBundle(bundle));
  assert.match(out.reply, new RegExp(`PROMISE\\|refund\\|order=${step.order_id}\\|bps=2000`));
  assert.deepEqual(out.bundle, bundle);
  assert.equal(out.register_tx, step.register_tx);
  assert.equal(out.explorer, explorerTx(step.register_tx));
  assert.deepEqual(out.views, step.views);

  // Same result with no message and a later call: the recorded step is not consumed.
  assert.deepEqual(await handlers.handleChat({ order_id: step.order_id }), out);
});

test('handleChat answers ERR_NO_ORDER for an order that was not recorded', async () => {
  const { handlers } = make();
  await assert.rejects(
    () => handlers.handleChat({ order_id: 'NOPE-99', message: 'x' }),
    (e) => e.message === 'ERR_NO_ORDER' && e.status === 404,
  );
});

test('handleClaim returns the recorded claim once, then ERR_ALREADY_CLAIMED', async () => {
  const { handlers } = make();
  const first = await handlers.handleClaim({ order_id: claimStep.order_id, response_b64: readBundle(chatSteps.find(c => c.order_id === claimStep.order_id).bundle_file).response_b64 });
  assert.deepEqual(first, {
    ok: true,
    result: claimStep.result,
    claim_tx: claimStep.claim_tx,
    explorer: explorerTx(claimStep.claim_tx),
  });
  await assert.rejects(
    () => handlers.handleClaim({ order_id: claimStep.order_id }),
    (e) => e.message === 'ERR_ALREADY_CLAIMED' && e.status === 400,
  );
  // A fresh replay server starts unclaimed again.
  assert.deepEqual(
    await make().handlers.handleClaim({ order_id: claimStep.order_id, response_b64: claimBytes }),
    first,
  );
});

test('reset() (a fresh page load) lets the claim beat play again', async () => {
  const r = make();
  const first = await r.handlers.handleClaim({ order_id: claimStep.order_id, response_b64: claimBytes });
  await assert.rejects(() => r.handlers.handleClaim({ order_id: claimStep.order_id, response_b64: claimBytes }), (e) => e.message === 'ERR_ALREADY_CLAIMED');
  r.reset();
  assert.deepEqual(await r.handlers.handleClaim({ order_id: claimStep.order_id, response_b64: claimBytes }), first);
});

test('handleRegisterEdited loses with ERR_BAD_SIGNATURE and the recorded tx for the recorded request', async () => {
  const { handlers } = make();
  await assert.rejects(
    () => handlers.handleRegisterEdited(editedRequest()),
    (e) => e.message === 'ERR_BAD_SIGNATURE' && e.status === 400 && e.txHash === editedStep.tx,
  );
});

test('replay never fabricates an edited-reply outcome or borrows another order\'s tx', async () => {
  const { handlers } = make();
  const notRecorded = (e) => e.message === 'ERR_NOT_RECORDED' && e.status === 404 && e.txHash === undefined;
  const other = chatSteps.find(c => c.order_id !== editedStep.order_id);
  // another order (the demo-script click after the A124 chat): the A123-11 tx must not be returned
  await assert.rejects(() => handlers.handleRegisterEdited({ order_id: other.order_id, bundle: recordedBundle(other.order_id), edit: { from: 'bps=10000', to: 'bps=30000' } }), notRecorded);
  // empty / garbage bodies
  await assert.rejects(() => handlers.handleRegisterEdited({}), (e) => e.message === 'ERR_BAD_REQUEST' && e.status === 400);
  await assert.rejects(() => handlers.handleRegisterEdited({ order_id: '../x' }), (e) => e.message === 'ERR_BAD_REQUEST');
  // right order, but a bundle that is not the recorded one, or an edit that is not in the bytes
  await assert.rejects(() => handlers.handleRegisterEdited({ ...editedRequest(), bundle: {} }), notRecorded);
  await assert.rejects(() => handlers.handleRegisterEdited({ ...editedRequest(), bundle: recordedBundle(other.order_id) }), notRecorded);
  await assert.rejects(() => handlers.handleRegisterEdited({ ...editedRequest(), edit: { from: 'zzz', to: 'y' } }), notRecorded);
  await assert.rejects(() => handlers.handleRegisterEdited({ ...editedRequest(), edit: undefined }), notRecorded);
});

test('replay claim for other bytes is ERR_NO_RECEIPT_FOR_BYTES and consumes nothing', async () => {
  const { handlers } = make();
  await assert.rejects(() => handlers.handleClaim({ order_id: claimStep.order_id, response_b64: 'AAAA' }), (e) => e.message === 'ERR_NO_RECEIPT_FOR_BYTES' && e.status === 400);
  await assert.rejects(() => handlers.handleClaim({ order_id: claimStep.order_id }), (e) => e.message === 'ERR_NO_RECEIPT_FOR_BYTES');
  assert.equal((await handlers.handleClaim({ order_id: claimStep.order_id, response_b64: claimBytes })).ok, true);
});

test('the HTTP wrappers answer the INTERFACES 11 shapes', async () => {
  const { handlers } = make();
  const step = chatSteps[0];

  const chat = await call(wrap(handlers.handleChat), { order_id: step.order_id, message: 'x' });
  assert.equal(chat.status, 200);
  assert.equal(chat.body.reply, replyFromBundle(readBundle(step.bundle_file)));
  assert.equal(chat.body.register_tx, step.register_tx);
  assert.deepEqual(chat.body.views, step.views);

  const firstClaim = await call(wrap(handlers.handleClaim), { order_id: claimStep.order_id, response_b64: claimBytes });
  assert.equal(firstClaim.status, 200);
  assert.equal(firstClaim.body.ok, true);
  assert.equal(firstClaim.body.claim_tx, claimStep.claim_tx);

  const second = await call(wrap(handlers.handleClaim, () => {}), { order_id: claimStep.order_id });
  assert.equal(second.status, 400);
  assert.equal(second.body.error, 'ERR_ALREADY_CLAIMED');

  const edited = await call(wrap(handlers.handleRegisterEdited, () => {}), editedRequest());
  assert.equal(edited.status, 400);
  assert.equal(edited.body.error, 'ERR_BAD_SIGNATURE');
  assert.equal(edited.body.tx, editedStep.tx);
  assert.equal(edited.body.explorer, explorerTx(editedStep.tx));
});
