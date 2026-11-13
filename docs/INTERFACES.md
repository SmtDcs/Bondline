# Interfaces (v1)

The v1 contract (`contract/`), the relayer, the web page and the CLI tools follow this file. Names, arguments, types, error strings and formats are fixed. v2 keeps them and lists its differences in `docs/STABLECOIN.md`.

## Words used

| Word | Meaning |
| --- | --- |
| contract | `bot_promises.wasm` at `CONTRACT_ID`, on testnet. Its owner is `CONTRACT_ID` itself. |
| owner | The account that adds and removes TEE signers, set once in `new(owner)`. |
| merchant | A NEAR account that called `register_merchant` with a bond. |
| relayer | The merchant's bot server (`app/server.mjs`), signing with a function-call key that may call only `register_receipt`. |
| buyer / shopper | The account in the order. Only it can claim. |
| signer | A NEAR AI Cloud signing key (32-byte ed25519 public key, 64 lowercase hex), registered by the owner after checking its attestation off chain. |
| receipt | On-chain record of a TEE-signed reply for an order, keyed by sha256 of the exact response bytes. |
| bps | Basis points, 10000 = 100%. |
| yocto | 1 NEAR = 10^24 yoctoNEAR. Amounts in JSON are `U128` strings. |

## State

Crate `bot-promises`, near-sdk `=5.30.1`, Rust 1.95.0.

```text
signers    Map<pubkey hex, SignerInfo>     merchants  Map<account, Merchant>
orders     Map<order_id, Order>            receipts   Map<response_hash, Receipt>

SignerInfo { kind: "provider_tee" | "gateway", model_id: Option<String>,   // Some(model) iff provider_tee
             attestation_sha256, added_at_ms, expires_at_ms }
Merchant   { bond: U128, reserved: U128, paid_out: U128 }
Order      { order_id, merchant, buyer, amount: U128, max_bps: u16, liability: U128,
             created_at_ms, status: "open" | "claimed", paid: U128, paid_bps: u16, receipt_count: u32 }
Receipt    { order_id, merchant, signer_public_key_hex, signature_kind, model_id: Option<String>,
             signed_text, signature_hex: 128 hex, request_hash, response_hash,
             registered_at_ms, block_height }
ClaimPreview { ok: bool, error: Option<String>,   // an ERR_ string when ok == false
               token_bps: u16, paid_bps: u16, payout: U128, response_hash }
```

Orders share one global namespace. `liability = amount * max_bps / 10000` is reserved at order time; `paid_bps = min(token_bps, max_bps)`.

Constants: `BPS_DENOMINATOR = 10_000`, `MIN_BOND_YOCTO = 10^24`. Money invariant: `reserved <= bond` for every merchant, and `withdraw_bond` may only take `bond - reserved`. Storage staking for orders and receipts comes from the contract account's own balance, so it must keep at least 3 NEAR of its own beyond all bonds.

## Change methods

100 Tgas prepaid unless stated. A panic string aborts the whole call: no state change, no transfer.

| Method | Who | Effect |
| --- | --- | --- |
| `new(owner)` | once, at deploy | sets the owner |
| `add_signer(public_key_hex, kind, model_id, attestation_sha256, expires_at_ms)` | owner (`ERR_NOT_OWNER`) | registers a TEE key; `kind` and `model_id` must agree (`ERR_SIGNER_KIND`), `attestation_sha256` is 32 bytes hex (`ERR_ATTESTATION_HASH`), expiry in the future (`ERR_EXPIRY_IN_PAST`) |
| `remove_signer(public_key_hex) -> bool` | owner | old receipts stay valid |
| `register_merchant()` payable >= 1 NEAR | any account, once | creates the bond; `ERR_BOND_TOO_SMALL`, `ERR_MERCHANT_EXISTS` |
| `add_bond()` payable | merchant | `ERR_NOT_MERCHANT`, `ERR_ZERO_DEPOSIT` |
| `withdraw_bond(amount)` | merchant | `0 < amount <= bond - reserved` (`ERR_WITHDRAW_EXCEEDS_FREE_BOND`) |
| `register_order(order_id, buyer, amount, max_bps)` | merchant | `^[A-Za-z0-9-]{1,32}$` (`ERR_ORDER_ID`), `1 <= max_bps <= 10000` (`ERR_MAX_BPS`), `amount > 0` (`ERR_AMOUNT`), id unused (`ERR_ORDER_EXISTS`), free bond covers the liability (`ERR_INSUFFICIENT_FREE_BOND`) |
| `register_receipt(order_id, signed_text, signature_hex, signer_public_key_hex)` | the order's merchant (`ERR_NOT_ORDER_MERCHANT`), in practice the relayer's key | see below |
| `claim(order_id, response_b64)` | the order's buyer (`ERR_NOT_BUYER`) | see below |

`register_receipt` steps, in order: the order exists (`ERR_NO_ORDER`) and the caller is its merchant; the signer is registered (`ERR_UNKNOWN_SIGNER`) and unexpired (`ERR_SIGNER_EXPIRED`); `parse_signed_text` succeeds (`ERR_SIGNED_TEXT_FORMAT`); the parsed model equals `signer.model_id` (`ERR_MODEL_MISMATCH`); `signature_hex` decodes to 64 bytes (`ERR_HEX`, `ERR_HEX_LENGTH`; a leading `0x` is allowed); `env::ed25519_verify` passes (`ERR_BAD_SIGNATURE`); no receipt exists for the response hash (`ERR_RECEIPT_EXISTS`). It stores the receipt and increments `receipt_count`, so only the hashes, signature and signed text are on chain.

`claim` takes the standard base64 (with padding) of the exact response body bytes and runs the same code as `preview_claim`: status open (`ERR_ALREADY_CLAIMED`), a receipt for `sha256(bytes)` (`ERR_NO_RECEIPT_FOR_BYTES`), the receipt belongs to this order (`ERR_RECEIPT_ORDER_MISMATCH`), the bytes decode to `choices[0].message.content` (`ERR_RESPONSE_JSON`, `ERR_RESPONSE_NO_CHOICE`, `ERR_RESPONSE_NO_CONTENT`), exactly one token parses, its order matches (`ERR_TOKEN_ORDER_MISMATCH`). Then `reserved -= liability`, `bond -= payout`, `paid_out += payout`, status `claimed`, and the payout leaves as a detached transfer. A 2 NEAR order at `max_bps` 3000 pays `400000000000000000000000` for `bps=2000` and `600000000000000000000000` for `bps=10000`.

## View methods

`near contract call-function as-read-only <CONTRACT_ID> <method> json-args '<json>' network-config testnet now`, or JSON-RPC `query` / `call_function` from the browser.

| Method | Args | Returns |
| --- | --- | --- |
| `get_owner` | `{}` | the owner account |
| `get_signer` | `{"public_key_hex":"<64 hex>"}` | `SignerInfo` or `null` |
| `get_signers` | `{}` | `[["<64 hex>", SignerInfo], ...]` |
| `get_merchant` | `{"merchant":"<account>"}` | `Merchant` or `null` |
| `get_order` | `{"order_id":"A123-01"}` | `Order` or `null` |
| `get_receipt` | `{"response_hash":"<64 hex>"}` | `Receipt` or `null` |
| `preview_claim` | `{"order_id":"A123-01","response_b64":"<base64>"}` | `ClaimPreview`, never panicking; an unknown order gives `ok:false, error:"ERR_NO_ORDER"` |

BINDING rule, fixed for every client: a reply is shown as BINDING only if `get_receipt(sha256(response bytes))` is not null and `preview_claim(order_id, bytes).ok` is true. Anything else is "NOT A PROMISE (no receipt on chain)" or the error string.

## Events

One log line: `EVENT_JSON:` plus `{"standard":"botpromise","version":"1.0.0","event":"<name>","data":[{...}]}` (NEP-297 shape).

| event | data |
| --- | --- |
| `signer_added` | `public_key_hex, kind, model_id, expires_at_ms` |
| `signer_removed` | `public_key_hex` |
| `merchant_registered` | `merchant, bond` |
| `bond_added` | `merchant, amount, bond` |
| `bond_withdrawn` | `merchant, amount` |
| `order_registered` | `order_id, merchant, buyer, amount, max_bps, liability` |
| `receipt_registered` | `order_id, response_hash, request_hash, signer_public_key_hex, signature_kind` |
| `promise_claimed` | `order_id, buyer, token_bps, paid_bps, payout, response_hash` |

Key order inside `data` may differ; parse it as JSON.

## Error strings

```
ERR_NOT_OWNER, ERR_HEX, ERR_HEX_LENGTH, ERR_SIGNER_KIND, ERR_ATTESTATION_HASH, ERR_EXPIRY_IN_PAST,
ERR_MERCHANT_EXISTS, ERR_BOND_TOO_SMALL, ERR_ZERO_DEPOSIT, ERR_NOT_MERCHANT, ERR_WITHDRAW_EXCEEDS_FREE_BOND,
ERR_ORDER_ID, ERR_MAX_BPS, ERR_AMOUNT, ERR_ORDER_EXISTS, ERR_INSUFFICIENT_FREE_BOND, ERR_NO_ORDER,
ERR_NOT_ORDER_MERCHANT, ERR_UNKNOWN_SIGNER, ERR_SIGNER_EXPIRED, ERR_SIGNED_TEXT_FORMAT, ERR_MODEL_MISMATCH,
ERR_BAD_SIGNATURE, ERR_RECEIPT_EXISTS, ERR_NOT_BUYER, ERR_ALREADY_CLAIMED, ERR_NO_RECEIPT_FOR_BYTES,
ERR_RECEIPT_ORDER_MISMATCH, ERR_RESPONSE_JSON, ERR_RESPONSE_NO_CHOICE, ERR_RESPONSE_NO_CONTENT,
ERR_NO_PROMISE_TOKEN, ERR_MULTIPLE_PROMISE_TOKENS, ERR_TOKEN_GRAMMAR, ERR_TOKEN_ORDER_ID, ERR_TOKEN_BPS,
ERR_TOKEN_ORDER_MISMATCH
```

A failed call on testnet reads `FunctionCallError(ExecutionError("Smart contract panicked: ERR_BAD_SIGNATURE"))`; the app matches `/ERR_[A-Z_]+/`.

## PROMISE token

Exact bytes, case-sensitive, no spaces:

```
PROMISE|refund|order=<ORDER_ID>|bps=<BPS>
ORDER_ID := 1..32 characters from [A-Za-z0-9-]
BPS      := 1..5 ASCII digits, value 1..10000; followed by end-of-text or a non-digit
```

`contract/src/parse.rs` implements this and `app/lib/promise.mjs` mirrors it. Only `choices[0].message.content` is searched; `reasoning_content` is ignored. Zero occurrences of `PROMISE|` give `ERR_NO_PROMISE_TOKEN`, more than one `ERR_MULTIPLE_PROMISE_TOKENS`. After `PROMISE|` the text must continue with `refund|order=` (`ERR_TOKEN_GRAMMAR`), the id up to `|bps=` (`ERR_TOKEN_GRAMMAR` when missing, `ERR_TOKEN_ORDER_ID` when bad), then the digits (`ERR_TOKEN_BPS`).

| content | result |
| --- | --- |
| `Sorry.\nPROMISE\|refund\|order=A123\|bps=2000` | order `A123`, bps 2000 |
| `no promise here` | `ERR_NO_PROMISE_TOKEN` |
| two tokens | `ERR_MULTIPLE_PROMISE_TOKENS` |
| `PROMISE\|discount\|order=A1\|bps=1` | `ERR_TOKEN_GRAMMAR` |
| `PROMISE\|refund\|order=A 1\|bps=1` | `ERR_TOKEN_ORDER_ID` |
| `...bps=0`, `...bps=10001`, `...bps=123456`, `...bps=x` | `ERR_TOKEN_BPS` |

## Signed text and signature

- Request: `POST https://cloud-api.near.ai/v1/chat/completions` with `Authorization: Bearer $NEARAI_API_KEY`, `x-no-aliasing: true`, `Accept-Encoding: identity` and `"stream": false`. The body is built once (`buildRequestBytes` in `app/lib/nearai.mjs`); both hashes are the lowercase hex sha256 of the exact request and response bytes.
- Signature: `GET https://cloud-api.near.ai/v1/signature/<response json "id">?model=<model>&signing_algo=ed25519` with the same key. A 404 means not stored yet: retry every second, at most 20 times. A 200 carrying `error_code` is unavailable.
- Signature JSON: `{"text","signature","signing_address","signing_algo":"ed25519","signature_kind":"provider_tee"}`.
- `text` is `<MODEL_ID>:<request_hash>:<response_hash>` for `provider_tee` and `<request_hash>:<response_hash>` for `gateway`.
- ed25519: `signature` is 64 bytes hex, `signing_address` the 32-byte public key hex, and the UTF-8 bytes of `text` are signed.

`parse_signed_text` splits from the right on `:` into `resp`, `req` and an optional `model`. `resp` and `req` must be exactly 64 `[0-9a-f]` characters and `model`, if present, non-empty; else `ERR_SIGNED_TEXT_FORMAT`.

| contract arg | from signature JSON |
| --- | --- |
| `signed_text` | `text` |
| `signature_hex` | `signature` |
| `signer_public_key_hex` | `signing_address` |

## Receipt bundle (receipt-bundle/v1)

One file per reply, written by the relayer to `data/bundles/<chat_id>.json` (gitignored), and copied to `fixtures/live/` for the recorded demo.

```json
{
  "type": "bot-promises/receipt-bundle/v1",
  "simulated": false,
  "order_id": "A123-01",
  "model": "z-ai/glm-5.3-flash",
  "chat_id": "<32 hex>",
  "created_at": "2026-11-10T12:00:00.000Z",
  "request_b64": "<exact request bytes>",
  "response_b64": "<exact response bytes>",
  "request_hash": "<64 hex>",
  "response_hash": "<64 hex>",
  "signature": {"text":"…","signature":"<128 hex>","signing_address":"<64 hex>","signing_algo":"ed25519","signature_kind":"provider_tee"},
  "attestation": {"record_file":"fixtures/attestation/…json","record_sha256":"<64 hex>"},
  "chain": {"network":"testnet","contract":"cbp-demo.testnet","register_tx":"<tx hash>","claim_tx":null}
}
```

`simulated: true` bundles are signed with the fake test key and must say so in every UI.

## Test vectors

`contract/tests/vectors.json`, from `app/scripts/make-test-vectors.mjs`. SIMULATED vectors sign with a fake ed25519 key whose 32-byte seed is `0x01` repeated.

| field | value |
| --- | --- |
| signer_public_key_hex | `8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c` |
| honest.order_id | `A123` |
| honest.signed_text | `z-ai/glm-5.3-flash:2ef15efaeac088a5c02976f5b4b6c1e0c59c091f54fec14270e501afebd9ee89:7757126f0501cc6f5f95c44ed9768f68a1f235e86f26b70a83af4e2be0ae1b22` |
| honest.signature_hex | `b810a32da1f5033b10701af7a7ebf3f6a57dfe952dc674bc5050fd0bde9b2fd2dd44ff9e05634f4581afa74157297549c167f129a4243d1628cdd01350dcd701` |
| honest content | `Sorry about the broken mug. I can offer a 20% refund on order A123.\nPROMISE\|refund\|order=A123\|bps=2000` |
| injection.order_id / content | `A124` / `…PROMISE\|refund\|order=A124\|bps=10000` |

One real ECDSA vector from the tee-receipts MIT fixture (`Qwen/Qwen3.8-27B`, 2026-11-01) is used by the `ecdsa.rs` test: text `Qwen/Qwen3.8-27B:75947b824e6dc3ecc863c82a6ee32601806d8247a6fcbdc819063700efac3031:2ff07dd89fbb69f49578f026bb1f132f9082a772619e40c9cdb9ff548d451283`, signature `0x66528b8b195b6ce203147826cb7348778234a15b9b66e61d9350dfedbf30b0db4af05e90705aad29c17188ba0bad77caf1d739e19a4a2fd06f2a28b70af230511c`, address `0x835ab53d20294ef795906dff21ae4c045336aa26`. The first real ed25519 vector is `fixtures/live/spike-s1.json`.

## HTTP API (app/server.mjs)

Express 5.3.0 on `http://127.0.0.1:$PORT`, default 8787. Errors are HTTP 4xx/5xx with `{"error":"<string>","detail":"<string>"}`, and a contract panic gives the `ERR_` string as `error`.

| Method and path | Body | Response |
| --- | --- | --- |
| `GET /api/config` | - | `{"mode":"live"\|"replay","network","rpcUrl","contractId","merchantId","buyerId","model","orders":[{"order_id","label"}]}` |
| `POST /api/chat` | `{"order_id","message"}` | `{"reply","bundle","register_tx","explorer"}`, returned only after `register_receipt` reaches FINAL |
| `POST /api/demo/claim` | `{"order_id","response_b64"}` | `{"ok":true,"result":<ClaimPreview>,"claim_tx","explorer"}`, or 400 `{"error":"ERR_ALREADY_CLAIMED","tx"}` |
| `POST /api/demo/register-edited` | `{"order_id","bundle","edit":{"from","to"}}` | 400 `{"error":"ERR_BAD_SIGNATURE","tx","explorer"}` |
| `GET /api/bundles/:chat_id` | - | the bundle |
| `GET /` | - | `web/index.html` and static files |

`/api/demo/claim` is demo only and signs as the buyer with `BUYER_CLAIM_SECRET_KEY`. The server keeps per-order chat history in memory. In replay mode (`MODE=replay`) `/api/chat` returns the next recorded step from `fixtures/replay/transcript.json` with no NEAR AI call and no transaction, and `/api/demo/*` return the recorded result; the browser still runs the BINDING check live, or with `?offline=1` uses the recorded views.

## CLI commands

From the repo root on Node 22.22.2+.

| Command | Expected last line |
| --- | --- |
| `npm run build:contract` | `Contract successfully built!` |
| `npm run test:contract` | `test result: ok. 16 passed` |
| `npm run test:js` | `# fail 0` |
| `npm run attest -- --model z-ai/glm-5.3-flash` | `ATTESTED <pubkey> record_sha256=<hex>` |
| `npm run signature:live` | `S1 GO (provider_tee ed25519)` |
| `npm run verify -- fixtures/live/a123.json` | `VERIFIED` |
| `npm run verify -- fixtures/simulated/honest.json --offline` | `VERIFIED` |
| `npm run verify:fixtures` | `ALL VERIFIED (n bundles)` |
| `npm run dev` | `listening on http://127.0.0.1:8787 mode=live` |
| `npm run demo:replay` | `listening on http://127.0.0.1:8787 mode=replay` |

## Environment variables

`.env` is never committed; `.env.example` holds empty values.

| Name | Used by |
| --- | --- |
| `MODE` (`live`), `PORT` (`8787`) | server |
| `NEAR_RPC_URL`, `CONTRACT_ID` | all |
| `MERCHANT_ID`, `BUYER_ID`, `MODEL`, `SIGNING_ALGO`, `DEMO_ORDERS` | server |
| `RELAYER_SECRET_KEY` (function-call key, `register_receipt`) | server |
| `BUYER_CLAIM_SECRET_KEY` (function-call key, `claim`, demo only) | server |
| `NEARAI_API_KEY` | server, signature check, attest |

`DEMO_ORDERS` is `order_id:label:policy_bps` entries.

## Attestation record

`npm run attest` writes `fixtures/attestation/<model with / replaced by _>-<algo>-<YYYY-MM-DD>.json`; the `attestation_sha256` passed to `add_signer` is the sha256 hex of its exact bytes.

```json
{
  "type": "bot-promises/attestation-record/v1",
  "model": "z-ai/glm-5.3-flash",
  "signing_algo": "ed25519",
  "fetched_at": "…",
  "nonce": "<64 hex, from the SDK client>",
  "sdk": "@nearai/inference-sdk@0.3.0",
  "verified": [{"signer":{"signingAlgo":"ed25519","signingAddress":"5a02…caff"},"tcbStatus":"UpToDate","gpuEvidence":"verified","advisoryIds":[]}],
  "reports": [ <raw ModelAttestation objects from fetchModelAttestations> ]
}
```

Keys rotate, so register what `npm run attest` prints on the day.

## Replay transcript

```json
{
  "type": "bot-promises/replay/v1",
  "recorded_at": "2026-11-12T10:00:00Z",
  "contract": "cbp-demo.testnet",
  "steps": [
    {"kind":"chat","order_id":"A123-01","message":"…","bundle_file":"fixtures/live/a123.json","register_tx":"<hash>",
     "views":{"get_receipt":{…},"preview_claim":{…}}},
    {"kind":"claim","order_id":"A123-01","claim_tx":"<hash>","result":{…}},
    {"kind":"register-edited","order_id":"A123-01","tx":"<hash>","error":"ERR_BAD_SIGNATURE"},
    {"kind":"claim-again","order_id":"A123-01","error":"ERR_ALREADY_CLAIMED"}
  ]
}
```

## ECDSA fallback

`contract/src/ecdsa.rs` covers models that only offer ECDSA signatures, behind the cargo feature `ecdsa`, which turns on near-sdk `unstable` for `env::ecrecover`:

1. `msg = "\x19Ethereum Signed Message:\n" + decimal(len(text in bytes)) + text`
2. `digest = keccak256(msg)`
3. `sig` is 65 bytes with `v = sig[64] >= 27 ? sig[64] - 27 : sig[64]`, and `v` must be 0 or 1
4. `pub = env::ecrecover(&digest, &sig[..64], v, true)`, rejecting high-s
5. `address = keccak256(pub)[12..32]` must equal the 20-byte `signing_address`

With the feature on, `public_key_hex` becomes the 20-byte address (40 hex) and `register_receipt` calls `ecdsa::verify_eip191` for a 40-character key. This is the only allowed interface change.
