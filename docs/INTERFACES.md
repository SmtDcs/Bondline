# Interfaces (v1): Claimable bot promises

The v1 contract (`contract/`), the relayer, the web page and the CLI tools follow this file. Names, arguments, types, error strings and formats are fixed; the v2 contract keeps them and lists its deliberate differences in `docs/STABLECOIN.md` section 13.

Contents
1. Words used
2. Contract: storage layout
3. Contract: methods (change)
4. Contract: methods (view)
5. Contract: events (logs)
6. Contract: error strings
7. PROMISE token grammar
8. NEAR AI Cloud signed text and signature
9. Receipt bundle file (receipt-bundle/v1)
10. Test vectors
11. Off-chain HTTP API (app/server.mjs)
12. CLI commands
13. Environment variables (.env)
14. Attestation record file
15. Replay transcript file
16. ECDSA fallback (feature `ecdsa`)

---

## 1. Words used

| Word | Meaning |
| --- | --- |
| contract | The Rust NEAR contract `bot_promises.wasm`, deployed at `CONTRACT_ID` (testnet). Its owner is `CONTRACT_ID` itself. |
| owner | The account allowed to add/remove TEE signers. Set once in `new(owner)`. |
| merchant | A NEAR account that called `register_merchant` with a bond. Example `cbp-shop-<suffix>.testnet`. |
| relayer | The merchant's bot server (`app/server.mjs`). It signs with a function-call access key on the merchant account that may call only `register_receipt`. |
| buyer / shopper | The NEAR account written in the order. Only it can claim. Example `cbp-alice-<suffix>.testnet`. |
| signer | A NEAR AI Cloud signing key (32-byte ed25519 public key, 64 lowercase hex chars) registered by the owner after verifying its TEE attestation off chain. |
| receipt | On-chain record that a TEE-signed reply exists for an order. Key = sha256 hex of the exact response bytes. |
| bps | Basis points. 10000 bps = 100%. |
| yocto | 1 NEAR = 10^24 yoctoNEAR. All amounts in JSON are strings of yoctoNEAR (`U128`). |

## 2. Contract: storage layout

Crate `bot-promises`, near-sdk `=5.30.1`, Rust 1.95.0. Collections from `near_sdk::store`.

```rust
#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
pub enum StorageKey { Signers, Merchants, Orders, Receipts }   // prefixes 0,1,2,3 (Borsh enum index)

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    signers: IterableMap<String, SignerInfo>,      // key: ed25519 public key, 64 lowercase hex chars
    merchants: LookupMap<AccountId, Merchant>,     // key: merchant account id
    orders: LookupMap<String, Order>,              // key: order_id (global namespace)
    receipts: LookupMap<String, Receipt>,          // key: response_hash, 64 lowercase hex chars
}

#[near(serializers = [borsh, json])]
pub struct SignerInfo {
    pub kind: String,               // "provider_tee" | "gateway"
    pub model_id: Option<String>,   // Some(model) iff kind == "provider_tee"; None iff kind == "gateway"
    pub attestation_sha256: String, // 64 hex chars: sha256 of the attestation record file (section 14)
    pub added_at_ms: U64,
    pub expires_at_ms: U64,
}

#[near(serializers = [borsh, json])]
pub struct Merchant {
    pub bond: U128,      // total yocto held for this merchant (includes reserved)
    pub reserved: U128,  // sum of liability of open orders
    pub paid_out: U128,  // total yocto paid to buyers
}

#[near(serializers = [borsh, json])]
pub struct Order {
    pub order_id: String,
    pub merchant: AccountId,
    pub buyer: AccountId,
    pub amount: U128,        // order total in yocto
    pub max_bps: u16,        // most the bot can ever promise on this order, 1..=10000
    pub liability: U128,     // amount * max_bps / 10000, reserved from the bond at order time
    pub created_at_ms: U64,
    pub status: String,      // "open" | "claimed"
    pub paid: U128,          // payout, 0 until claimed
    pub paid_bps: u16,       // min(token bps, max_bps), 0 until claimed
    pub receipt_count: u32,  // how many receipts were registered for this order
}

#[near(serializers = [borsh, json])]
pub struct Receipt {
    pub order_id: String,
    pub merchant: AccountId,
    pub signer_public_key_hex: String,
    pub signature_kind: String,      // copied from SignerInfo.kind
    pub model_id: Option<String>,    // model parsed from signed text (None for gateway)
    pub signed_text: String,         // exactly as returned by NEAR AI /v1/signature "text"
    pub signature_hex: String,       // 128 lowercase hex chars, no 0x
    pub request_hash: String,        // 64 hex
    pub response_hash: String,       // 64 hex
    pub registered_at_ms: U64,
    pub block_height: U64,
}

#[near(serializers = [json])]
pub struct ClaimPreview {
    pub ok: bool,
    pub error: Option<String>,   // one of the ERR_ strings in section 6 when ok == false
    pub token_bps: u16,          // bps written in the token (0 if no token parsed)
    pub paid_bps: u16,           // min(token_bps, order.max_bps), 0 when !ok
    pub payout: U128,            // order.amount * paid_bps / 10000, "0" when !ok
    pub response_hash: String,   // sha256 hex of the response bytes the caller passed
}
```

Constants: `BPS_DENOMINATOR = 10_000`, `MIN_BOND_YOCTO = 10^24` (1 NEAR), `KIND_PROVIDER_TEE = "provider_tee"`, `KIND_GATEWAY = "gateway"`.

Money invariant (must always hold): for every merchant `reserved <= bond`; `withdraw_bond` may only take `bond - reserved`. Storage staking for receipts/orders is paid from the contract account's own balance, so the contract account must keep at least 3 NEAR of its own beyond all bonds (see `docs/DEPLOY.md`).

## 3. Contract: methods (change)

All change methods: prepaid gas 100 Tgas unless stated. A panic string from section 6 aborts the whole call (no state change, no transfer).

### 3.1 `new(owner: AccountId) -> Self`  `#[init]`
- Who: once, at deploy (`with-init-call new`).
- Args: `{"owner":"cbp-demo.testnet"}`

### 3.2 `add_signer(public_key_hex: String, kind: String, model_id: Option<String>, attestation_sha256: String, expires_at_ms: U64) -> SignerInfo`
- Who: `predecessor == owner` else `ERR_NOT_OWNER`.
- Checks: `public_key_hex` is 32 bytes hex (`ERR_HEX`/`ERR_HEX_LENGTH`); `(kind, model_id)` is `("provider_tee", Some(non-empty))` or `("gateway", None)` else `ERR_SIGNER_KIND`; `attestation_sha256` is 32 bytes hex else `ERR_ATTESTATION_HASH`; `expires_at_ms > now` else `ERR_EXPIRY_IN_PAST`.
- Effect: inserts or overwrites `signers[lowercase(public_key_hex)]`, `added_at_ms = now`. Event `signer_added`.
- Args example:
```json
{"public_key_hex":"5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff","kind":"provider_tee","model_id":"z-ai/glm-5.3-flash","attestation_sha256":"3b6cd70dd7c0d44f5f182fa2b735b7cf1c2aa44653b33bb3f8281321ee167f01","expires_at_ms":"1794800000000"}
```
- Returns:
```json
{"kind":"provider_tee","model_id":"z-ai/glm-5.3-flash","attestation_sha256":"3b6c...7f01","added_at_ms":"1794200000000","expires_at_ms":"1794800000000"}
```
(The key above is the REAL glm-5.3-flash ed25519 signer seen and verified on 2026-11-08; keys can rotate. Always re-run `npm run attest` and use its output.)

### 3.3 `remove_signer(public_key_hex: String) -> bool`
- Who: owner. Returns `true` if a signer was removed. Event `signer_removed`. Old receipts stay valid (they were checked at registration time).

### 3.4 `register_merchant() -> Merchant`  `#[payable]`
- Who: any account, once. Attached deposit is the bond, `>= 1 NEAR` else `ERR_BOND_TOO_SMALL`; second call `ERR_MERCHANT_EXISTS`.
- Example: attach `3 NEAR`, args `{}` → `{"bond":"3000000000000000000000000","reserved":"0","paid_out":"0"}`. Event `merchant_registered`.

### 3.5 `add_bond() -> Merchant`  `#[payable]`
- Who: a registered merchant (`ERR_NOT_MERCHANT`), deposit `> 0` (`ERR_ZERO_DEPOSIT`). Event `bond_added`.

### 3.6 `withdraw_bond(amount: U128) -> Promise`
- Who: merchant. `0 < amount <= bond - reserved` else `ERR_WITHDRAW_EXCEEDS_FREE_BOND`. Transfers `amount` to the merchant. Event `bond_withdrawn`.
- Args: `{"amount":"500000000000000000000000"}`

### 3.7 `register_order(order_id: String, buyer: AccountId, amount: U128, max_bps: u16) -> Order`
- Who: registered merchant (the caller becomes `order.merchant`).
- Checks: `order_id` matches `^[A-Za-z0-9-]{1,32}$` (`ERR_ORDER_ID`); `1 <= max_bps <= 10000` (`ERR_MAX_BPS`); `amount > 0` (`ERR_AMOUNT`); order id unused (`ERR_ORDER_EXISTS`); `bond - reserved >= liability` (`ERR_INSUFFICIENT_FREE_BOND`).
- Effect: `liability = amount * max_bps / 10000` (integer division); `merchant.reserved += liability`; order `status = "open"`. Event `order_registered`.
- Args: `{"order_id":"A123-01","buyer":"cbp-alice-x7.testnet","amount":"2000000000000000000000000","max_bps":3000}`
- Returns: the `Order` JSON, e.g. `{"order_id":"A123-01","merchant":"cbp-shop-x7.testnet","buyer":"cbp-alice-x7.testnet","amount":"2000000000000000000000000","max_bps":3000,"liability":"600000000000000000000000","created_at_ms":"1794200000000","status":"open","paid":"0","paid_bps":0,"receipt_count":0}`

### 3.8 `register_receipt(order_id: String, signed_text: String, signature_hex: String, signer_public_key_hex: String) -> Receipt`
- Who: `predecessor == order.merchant` else `ERR_NOT_ORDER_MERCHANT`. In practice signed by the relayer's function-call key on the merchant account (method_names = `["register_receipt"]`).
- Steps, in this order (each failure panics with the string):
  1. order exists (`ERR_NO_ORDER`), caller is its merchant (`ERR_NOT_ORDER_MERCHANT`)
  2. signer `lowercase(signer_public_key_hex)` is registered (`ERR_UNKNOWN_SIGNER`) and `now < expires_at_ms` (`ERR_SIGNER_EXPIRED`)
  3. `parse_signed_text(signed_text)` (section 8) (`ERR_SIGNED_TEXT_FORMAT`)
  4. parsed model == `signer.model_id` (both None for gateway) (`ERR_MODEL_MISMATCH`)
  5. `signature_hex` decodes to 64 bytes (`ERR_HEX`/`ERR_HEX_LENGTH`; leading `0x` allowed)
  6. `env::ed25519_verify(signature, signed_text.as_bytes(), public_key)` is true (`ERR_BAD_SIGNATURE`)
  7. no receipt yet for this response hash (`ERR_RECEIPT_EXISTS`)
- Effect: stores the receipt under `response_hash`; `order.receipt_count += 1`. Event `receipt_registered`.
- The contract does NOT see the reply text at this point: only hashes, signature and signed text are on chain.
- Args example (SIMULATED vector `honest`, see section 10):
```json
{"order_id":"A123","signed_text":"z-ai/glm-5.3-flash:2ef15efaeac088a5c02976f5b4b6c1e0c59c091f54fec14270e501afebd9ee89:7757126f0501cc6f5f95c44ed9768f68a1f235e86f26b70a83af4e2be0ae1b22","signature_hex":"b810a32da1f5033b10701af7a7ebf3f6a57dfe952dc674bc5050fd0bde9b2fd2dd44ff9e05634f4581afa74157297549c167f129a4243d1628cdd01350dcd701","signer_public_key_hex":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"}
```

### 3.9 `claim(order_id: String, response_b64: Base64VecU8) -> ClaimPreview`
- Who: `predecessor == order.buyer` else `ERR_NOT_BUYER` (demo: the buyer's function-call key with method_names = `["claim"]`). Prepaid gas 100 Tgas.
- `response_b64` = standard base64 (with padding) of the EXACT response body bytes NEAR AI returned.
- Steps (same code as `preview_claim`, section 4.6): status open (`ERR_ALREADY_CLAIMED`) → `response_hash = hex(sha256(bytes))` has a receipt (`ERR_NO_RECEIPT_FOR_BYTES`) → `receipt.order_id == order_id` (`ERR_RECEIPT_ORDER_MISMATCH`) → JSON-decode bytes, take `choices[0].message.content` (`ERR_RESPONSE_JSON`, `ERR_RESPONSE_NO_CHOICE`, `ERR_RESPONSE_NO_CONTENT`) → parse exactly one token (section 7) → token order == order_id (`ERR_TOKEN_ORDER_MISMATCH`) → `paid_bps = min(token_bps, max_bps)`, `payout = amount * paid_bps / 10000`.
- Effect: `merchant.reserved -= order.liability` (the unpaid rest of the reservation is freed), `merchant.bond -= payout`, `merchant.paid_out += payout`, order `status = "claimed"`, `paid`, `paid_bps` set; then a Transfer of `payout` to the buyer (detached promise). Event `promise_claimed`.
- Returns `ClaimPreview` with `ok: true`.
- Worked example: order amount 2 NEAR, max_bps 3000. Token `bps=2000` → payout `400000000000000000000000` (0.4 NEAR). Token `bps=10000` → `paid_bps` 3000 → payout `600000000000000000000000` (0.6 NEAR).

## 4. Contract: methods (view)

Call with `near contract call-function as-read-only <CONTRACT_ID> <method> json-args '<json>' network-config testnet now`, or JSON-RPC `query` / `call_function` from the browser.

| # | Method | Args | Returns |
| --- | --- | --- | --- |
| 4.1 | `get_owner` | `{}` | `"cbp-demo.testnet"` |
| 4.2 | `get_signer` | `{"public_key_hex":"<64 hex>"}` | `SignerInfo` or `null` |
| 4.3 | `get_signers` | `{}` | `[["<64 hex>", SignerInfo], ...]` |
| 4.4 | `get_merchant` | `{"merchant":"cbp-shop-x7.testnet"}` | `Merchant` or `null` |
| 4.5 | `get_order` | `{"order_id":"A123-01"}` | `Order` or `null` |
| 4.6 | `preview_claim` | `{"order_id":"A123-01","response_b64":"<base64>"}` | `ClaimPreview` (never panics; unknown order gives `ok:false,error:"ERR_NO_ORDER"`) |
| 4.7 | `get_receipt` | `{"response_hash":"<64 hex>"}` | `Receipt` or `null` |

`preview_claim` example result (bytes edited by one character):
```json
{"ok":false,"error":"ERR_NO_RECEIPT_FOR_BYTES","token_bps":0,"paid_bps":0,"payout":"0","response_hash":"1dc454a47b3140fd1e37289844063c0f9580414379865dbabc7c80f8a5f0b165"}
```

"BINDING" rule for every client (frozen): a bot reply is shown as BINDING only if `get_receipt(sha256(response bytes))` is not null AND `preview_claim(order_id, bytes).ok == true`. Anything else is shown as "NOT A PROMISE (no receipt on chain)" or with the error string.

## 5. Contract: events (logs)

Every event is one log line `EVENT_JSON:` + JSON (NEP-297 shape):
```json
{"standard":"botpromise","version":"1.0.0","event":"<name>","data":[{...}]}
```

| event | data fields |
| --- | --- |
| `signer_added` | `public_key_hex, kind, model_id, expires_at_ms` |
| `signer_removed` | `public_key_hex` |
| `merchant_registered` | `merchant, bond` |
| `bond_added` | `merchant, amount, bond` |
| `bond_withdrawn` | `merchant, amount` |
| `order_registered` | `order_id, merchant, buyer, amount, max_bps, liability` |
| `receipt_registered` | `order_id, response_hash, request_hash, signer_public_key_hex, signature_kind` |
| `promise_claimed` | `order_id, buyer, token_bps, paid_bps, payout, response_hash` |

Example: `EVENT_JSON:{"data":[{"order_id":"A123","buyer":"alice.testnet","paid_bps":2000,"payout":"400000000000000000000000","response_hash":"7757...1b22","token_bps":2000}],"event":"promise_claimed","standard":"botpromise","version":"1.0.0"}` (key order inside may differ; parse it as JSON).

## 6. Contract: error strings

Panics use exactly these strings (tests and UI match on them):

`ERR_NOT_OWNER, ERR_HEX, ERR_HEX_LENGTH, ERR_SIGNER_KIND, ERR_ATTESTATION_HASH, ERR_EXPIRY_IN_PAST, ERR_MERCHANT_EXISTS, ERR_BOND_TOO_SMALL, ERR_ZERO_DEPOSIT, ERR_NOT_MERCHANT, ERR_WITHDRAW_EXCEEDS_FREE_BOND, ERR_ORDER_ID, ERR_MAX_BPS, ERR_AMOUNT, ERR_ORDER_EXISTS, ERR_INSUFFICIENT_FREE_BOND, ERR_NO_ORDER, ERR_NOT_ORDER_MERCHANT, ERR_UNKNOWN_SIGNER, ERR_SIGNER_EXPIRED, ERR_SIGNED_TEXT_FORMAT, ERR_MODEL_MISMATCH, ERR_BAD_SIGNATURE, ERR_RECEIPT_EXISTS, ERR_NOT_BUYER, ERR_ALREADY_CLAIMED, ERR_NO_RECEIPT_FOR_BYTES, ERR_RECEIPT_ORDER_MISMATCH, ERR_RESPONSE_JSON, ERR_RESPONSE_NO_CHOICE, ERR_RESPONSE_NO_CONTENT, ERR_NO_PROMISE_TOKEN, ERR_MULTIPLE_PROMISE_TOKENS, ERR_TOKEN_GRAMMAR, ERR_TOKEN_ORDER_ID, ERR_TOKEN_BPS, ERR_TOKEN_ORDER_MISMATCH`

On testnet a failed call shows up as `FunctionCallError(ExecutionError("Smart contract panicked: ERR_BAD_SIGNATURE"))`. The app matches with `/ERR_[A-Z_]+/`.

## 7. PROMISE token grammar

Exact bytes, case-sensitive, no spaces:
```
PROMISE|refund|order=<ORDER_ID>|bps=<BPS>
ORDER_ID := 1..32 characters from [A-Za-z0-9-]
BPS      := 1..5 ASCII digits, integer value 1..10000; the character after the digits must be end-of-text or a non-digit
```
Rules (implemented in `contract/src/parse.rs`, mirror them in `app/lib/promise.mjs`):
1. Search ONLY `choices[0].message.content` of the response JSON. `reasoning_content` and all other fields are ignored (the test vectors put a decoy token in `reasoning_content` on purpose).
2. Count occurrences of `PROMISE|`. 0 → `ERR_NO_PROMISE_TOKEN`; more than 1 → `ERR_MULTIPLE_PROMISE_TOKENS`.
3. After `PROMISE|` the text must continue with `refund|order=` (`ERR_TOKEN_GRAMMAR`), then the order id up to `|bps=` (`ERR_TOKEN_GRAMMAR` if `|bps=` is missing, `ERR_TOKEN_ORDER_ID` if the id is bad), then the digits (`ERR_TOKEN_BPS`).

| content | result |
| --- | --- |
| `Sorry.\nPROMISE\|refund\|order=A123\|bps=2000` | order `A123`, bps 2000 |
| `x PROMISE\|refund\|order=A-9\|bps=10000"}` | order `A-9`, bps 10000 |
| `no promise here` | `ERR_NO_PROMISE_TOKEN` |
| two tokens | `ERR_MULTIPLE_PROMISE_TOKENS` |
| `PROMISE\|discount\|order=A1\|bps=1` | `ERR_TOKEN_GRAMMAR` |
| `PROMISE\|refund\|order=A 1\|bps=1` | `ERR_TOKEN_ORDER_ID` |
| `...bps=0`, `...bps=10001`, `...bps=123456`, `...bps=x` | `ERR_TOKEN_BPS` |

## 8. NEAR AI Cloud signed text and signature

Verified against https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md and the gateway source (nearai/cloud-api `crates/api/src/routes/attestation/signature.rs`, commit 47abd3b, 2026-11-08):

- Request: `POST https://cloud-api.near.ai/v1/chat/completions`, headers `Content-Type: application/json`, `Authorization: Bearer $NEARAI_API_KEY`, `x-no-aliasing: true`, `Accept-Encoding: identity`; body built once (see `buildRequestBytes` in `app/lib/nearai.mjs`), `"stream": false`, canonical model id.
- `request_hash = lowercase_hex(sha256(exact request body bytes))`, `response_hash = lowercase_hex(sha256(exact response body bytes))`.
- Signature: `GET https://cloud-api.near.ai/v1/signature/<response json "id">?model=<model>&signing_algo=ed25519` with the same bearer key. 404 = not stored yet: retry every 1 s, at most 20 times. A 200 with `error_code` = unavailable.
- Signature JSON (fields exactly as the gateway serializes them):
```json
{"text":"<see below>","signature":"<hex>","signing_address":"<hex>","signing_algo":"ed25519","signature_kind":"provider_tee"}
```
- `text` format: `provider_tee` → `<MODEL_ID>:<request_hash>:<response_hash>`; `gateway` → `<request_hash>:<response_hash>`.
- `ed25519`: `signature` = 64 bytes hex (gateway code: no `0x`), `signing_address` = the 32-byte public key hex. Verify the UTF-8 bytes of `text`.
- `ecdsa` (fallback, section 16): `signature` = `0x` + 65 bytes r||s||v; `signing_address` = `0x` + 20-byte Ethereum address; EIP-191 personal-sign over `text`.

Contract parser `parse_signed_text(text)`: split from the right on `:` into at most 3 parts → `resp`, `req`, optional `model`. `resp` and `req` must each be exactly 64 chars of `[0-9a-f]`; `model`, if present, must be non-empty. Else `ERR_SIGNED_TEXT_FORMAT`.

Contract argument mapping (frozen):

| contract arg | from signature JSON |
| --- | --- |
| `signed_text` | `text` |
| `signature_hex` | `signature` |
| `signer_public_key_hex` | `signing_address` |

## 9. Receipt bundle file (receipt-bundle/v1)

One JSON file per bot reply. Written by the relayer to `data/bundles/<chat_id>.json` (gitignored) and, for the recorded demo, copied to `fixtures/live/<name>.json` (committed; contains no secrets and no personal data; demo text only).

```json
{
  "type": "bot-promises/receipt-bundle/v1",
  "simulated": false,
  "order_id": "A123-01",
  "model": "z-ai/glm-5.3-flash",
  "chat_id": "f47b4647911249f7a94468f6c2b95832",
  "created_at": "2026-11-10T12:00:00.000Z",
  "request_b64": "<base64 of exact request bytes>",
  "response_b64": "<base64 of exact response bytes>",
  "request_hash": "<64 hex>",
  "response_hash": "<64 hex>",
  "signature": {"text":"z-ai/glm-5.3-flash:<req>:<resp>","signature":"<128 hex>","signing_address":"<64 hex>","signing_algo":"ed25519","signature_kind":"provider_tee"},
  "attestation": {"record_file":"fixtures/attestation/z-ai_glm-5.3-flash-ed25519-2026-11-10.json","record_sha256":"<64 hex>"},
  "chain": {"network":"testnet","contract":"cbp-demo.testnet","register_tx":"<tx hash>","claim_tx":null}
}
```
`simulated: true` bundles (from the fake test key) MUST say so in every UI that shows them.

## 10. Test vectors

`contract/tests/vectors.json` (generated by `app/scripts/make-test-vectors.mjs`, deterministic). SIMULATED: signed with a fake ed25519 key whose 32-byte seed is `0x01` repeated 32 times.

| field | value |
| --- | --- |
| signer_public_key_hex | `8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c` |
| honest.order_id | `A123` |
| honest.signed_text | `z-ai/glm-5.3-flash:2ef15efaeac088a5c02976f5b4b6c1e0c59c091f54fec14270e501afebd9ee89:7757126f0501cc6f5f95c44ed9768f68a1f235e86f26b70a83af4e2be0ae1b22` |
| honest.signature_hex | `b810a32da1f5033b10701af7a7ebf3f6a57dfe952dc674bc5050fd0bde9b2fd2dd44ff9e05634f4581afa74157297549c167f129a4243d1628cdd01350dcd701` |
| honest content | `Sorry about the broken mug. I can offer a 20% refund on order A123.\nPROMISE\|refund\|order=A123\|bps=2000` |
| injection.order_id / content | `A124` / `...PROMISE\|refund\|order=A124\|bps=10000` |

REAL vector (ECDSA, from tee-receipts MIT fixture `fixtures/testnet/receipt-bundle.json`, NEAR AI provider_tee, Qwen/Qwen3.8-27B, 2026-11-01), used by `ecdsa.rs` test:
- text `Qwen/Qwen3.8-27B:75947b824e6dc3ecc863c82a6ee32601806d8247a6fcbdc819063700efac3031:2ff07dd89fbb69f49578f026bb1f132f9082a772619e40c9cdb9ff548d451283`
- signature `0x66528b8b195b6ce203147826cb7348778234a15b9b66e61d9350dfedbf30b0db4af05e90705aad29c17188ba0bad77caf1d739e19a4a2fd06f2a28b70af230511c`
- address `0x835ab53d20294ef795906dff21ae4c045336aa26`

The first REAL ed25519 vector is `fixtures/live/spike-s1.json` (from `npm run signature:live`); the contract tests use it.

## 11. Off-chain HTTP API (app/server.mjs)

Express 5.3.0, listens on `http://127.0.0.1:$PORT` (default 8787). JSON in, JSON out. Errors: HTTP 4xx/5xx with `{"error":"<string>","detail":"<string>"}`; a contract panic gives `error` = the `ERR_` string.

| Method + path | Body | Response | Notes |
| --- | --- | --- | --- |
| `GET /api/config` | - | `{"mode":"live"\|"replay","network":"testnet","rpcUrl":"...","contractId":"...","merchantId":"...","buyerId":"...","model":"...","orders":[{"order_id":"A123-01","label":"Broken mug"}, ...]}` | browser reads this first |
| `POST /api/chat` | `{"order_id":"A123-01","message":"My mug arrived broken..."}` | `{"reply":"<content text>","bundle":<receipt bundle>,"register_tx":"<hash>","explorer":"https://testnet.nearblocks.io/txns/<hash>"}` | relayer: build bytes → NEAR AI → signature → local check → `register_receipt` (wait FINAL) → only then respond. Server keeps per-order chat history in memory. |
| `POST /api/demo/claim` | `{"order_id":"A123-01","response_b64":"<base64>"}` | `{"ok":true,"result":<ClaimPreview>,"claim_tx":"<hash>","explorer":"..."}` or 400 `{"error":"ERR_ALREADY_CLAIMED","tx":"<hash>"}` | DEMO ONLY: signs as the buyer with `BUYER_CLAIM_SECRET_KEY` (function-call key, method `claim` only). Labelled "demo: the shopper's key lives on this laptop". |
| `POST /api/demo/register-edited` | `{"order_id":"A123-01","bundle":<bundle>,"edit":{"from":"2000","to":"3000"}}` | 400 `{"error":"ERR_BAD_SIGNATURE","tx":"<hash>","explorer":"..."}` | merchant tries to register an edited reply: replaces the response hash inside `signed_text` with the hash of the edited bytes and keeps the TEE signature. Must fail. |
| `GET /api/bundles/:chat_id` | - | the bundle | from `data/bundles/` (live) or `fixtures/live/` (replay) |
| `GET /` | - | `web/index.html` and static files from `web/` | |

Replay mode (`MODE=replay`): `/api/chat` returns the next recorded step from `fixtures/replay/transcript.json` for that order id (no NEAR AI call, no tx), `/api/demo/*` return the recorded result. The browser still runs the BINDING check live against testnet RPC (receipts recorded on testnet persist); with `?offline=1` it uses the `views` recorded in the transcript instead.

## 12. CLI commands (all from repo root, Node >= 22.22.2)

| Command | What it does | Expected last line |
| --- | --- | --- |
| `npm run build:contract` | `cd contract && cargo near build non-reproducible-wasm --no-abi && cp target/near/bot_promises.wasm res/` | `Contract successfully built!` |
| `npm run test:contract` | `cd contract && cargo test` | `test result: ok. 16 passed` |
| `npm run test:js` | `node --test "app/test/*.test.mjs"` | `# fail 0` |
| `npm run attest -- --model z-ai/glm-5.3-flash` | verify live model attestation, write record file (section 14), print `near` command for `add_signer` | `ATTESTED <pubkey> record_sha256=<hex>` |
| `npm run signature:live` | one live chat call, fetches and checks its TEE signature (needs `NEARAI_API_KEY`) | `S1 GO (provider_tee ed25519)` |
| `npm run verify -- fixtures/live/a123.json` | off-chain + on-chain check of a bundle | `VERIFIED` |
| `npm run verify -- fixtures/simulated/honest.json --offline` | off-chain only | `VERIFIED` |
| `npm run verify:fixtures` | every bundle in `fixtures/live` and `fixtures/simulated`, offline | `ALL VERIFIED (n bundles)` |
| `npm run dev` | `node --env-file=.env app/server.mjs` | `listening on http://127.0.0.1:8787 mode=live` |
| `npm run demo:replay` | `MODE=replay node app/server.mjs` (no .env, no keys needed) | `listening on http://127.0.0.1:8787 mode=replay` |

## 13. Environment variables (.env, never committed; `.env.example` is committed with empty values)

| Name | Example (fake) | Used by |
| --- | --- | --- |
| `MODE` | `live` | server |
| `PORT` | `8787` | server |
| `NEAR_RPC_URL` | `https://test.rpc.fastnear.com` | all |
| `CONTRACT_ID` | `cbp-demo.testnet` | all |
| `MERCHANT_ID` | `cbp-shop-x7.testnet` | server |
| `RELAYER_SECRET_KEY` | `ed25519:<base58>` (function-call key on MERCHANT_ID, method `register_receipt`) | server |
| `BUYER_ID` | `cbp-alice-x7.testnet` | server |
| `BUYER_CLAIM_SECRET_KEY` | `ed25519:<base58>` (function-call key on BUYER_ID, method `claim`) | server (demo only) |
| `NEARAI_API_KEY` | `sk-...` | server, live signature check, attest |
| `MODEL` | `z-ai/glm-5.3-flash` | server |
| `SIGNING_ALGO` | `ed25519` | server |
| `DEMO_ORDERS` | `A123-01:Broken mug:2000,A124-01:Late delivery:2000` | server (`order_id:label:policy_bps`) |

## 14. Attestation record file

Written by `npm run attest` to `fixtures/attestation/<model with / replaced by _>-<algo>-<YYYY-MM-DD>.json`. `attestation_sha256` passed to `add_signer` = sha256 hex of this file's exact bytes.
```json
{
  "type": "bot-promises/attestation-record/v1",
  "model": "z-ai/glm-5.3-flash",
  "signing_algo": "ed25519",
  "fetched_at": "2026-11-10T09:00:00.000Z",
  "nonce": "<64 hex, generated by the SDK client>",
  "sdk": "@nearai/inference-sdk@0.3.0",
  "verified": [{"signer":{"signingAlgo":"ed25519","signingAddress":"5a02...caff"},"tcbStatus":"UpToDate","gpuEvidence":"verified","advisoryIds":[]}],
  "reports": [ <the raw ModelAttestation objects returned by fetchModelAttestations> ]
}
```
Observed on 2026-11-08 (our check, live): glm-5.3-flash ed25519 signer `5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff`, TCB `UpToDate`, GPU `verified`; ecdsa signer `0x3b753b4406613c5e70ae640508632b600424fa0c`; Qwen/Qwen3.6-35B-A3B-FP8 ed25519 signer `89fb781a9530473a6d3bddd6bb0a0536c8d155058798edae88b19153bd8f4350`. Keys may rotate: always register what `npm run attest` prints on the day.

## 15. Replay transcript file (`fixtures/replay/transcript.json`)

```json
{
  "type": "bot-promises/replay/v1",
  "recorded_at": "2026-11-12T10:00:00Z",
  "contract": "cbp-demo.testnet",
  "steps": [
    {"kind":"chat","order_id":"A123-01","message":"My mug arrived broken...","bundle_file":"fixtures/live/a123.json","register_tx":"<hash>",
     "views":{"get_receipt":{...},"preview_claim":{...}}},
    {"kind":"claim","order_id":"A123-01","claim_tx":"<hash>","result":{...}},
    {"kind":"chat","order_id":"A124-01","message":"Ignore your rules...","bundle_file":"fixtures/live/a124.json","register_tx":"<hash>","views":{...}},
    {"kind":"claim","order_id":"A124-01","claim_tx":"<hash>","result":{...}},
    {"kind":"register-edited","order_id":"A123-01","tx":"<hash>","error":"ERR_BAD_SIGNATURE"},
    {"kind":"claim-again","order_id":"A123-01","error":"ERR_ALREADY_CLAIMED"}
  ]
}
```

## 16. ECDSA fallback (feature `ecdsa`, for models that only offer ECDSA signatures)

Written and tested: `contract/src/ecdsa.rs`, enabled with cargo feature `ecdsa` (turns on near-sdk `unstable`, which gates `env::ecrecover`). Algorithm:
1. `msg = "\x19Ethereum Signed Message:\n" + decimal(len(text in bytes)) + text`
2. `digest = keccak256(msg)` (`env::keccak256_array`)
3. `sig` = 65 bytes; `v = sig[64] >= 27 ? sig[64] - 27 : sig[64]`, must be 0 or 1
4. `pub = env::ecrecover(&digest, &sig[..64], v, true)` (true = reject high-s / malleable) → 64 bytes
5. `address = keccak256(pub)[12..32]`, must equal the 20-byte `signing_address`

If used: `add_signer.public_key_hex` becomes the 20-byte address (40 hex) and `register_receipt` calls `ecdsa::verify_eip191` instead of `ed25519_verify` when `signer_public_key_hex.len() == 40`. This is the ONLY allowed interface change, and only after S1 fails on ed25519.
