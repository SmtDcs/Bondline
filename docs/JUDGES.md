# Bondline — NEAR Hackathon submission notes

Walkthrough and reference for hackathon judges. The project README is [here](../README.md).

## Judge path

Steps 1-4 need no Rust and no keys.

1. `npm ci`. On Node 22 it warns `EBADENGINE` for `@nearai/inference-sdk`, which only `npm run attest` and `npm run signature:live` use.
2. `npm run verify:fixtures` re-checks every bundle offline: hashes, signed text, ed25519 signature, and the key listed in the attestation record. The last line counts 11 real bundles, 3 tampered copies that print `tamper detected`, 5 refused v3 requests, and 2 SIMULATED bundles whose public fake key prints `PASS (SIMULATED key)`.
3. `npm run verify -- fixtures/live/a123.json` adds testnet: signer valid when the receipt was registered, attestation hash on chain, receipt on chain, `preview_claim`. The order is already claimed, so `preview_claim` answers `ERR_ALREADY_CLAIMED`, which passes, and the run ends `VERIFIED`. A v2 bundle needs `--merchant cbp-shop-sm1110.testnet`; a tampered one prints `NOT VERIFIED`; behind a proxy set `NODE_USE_ENV_PROXY=1` or add `--offline`.
4. `npm run demo:replay:v2` (or `demo:replay` for v1), then open http://127.0.0.1:8787/?offline=1 and click through the beats below.
5. `npm run test:js` ends `# fail 0` (275 tests); with Rust 1.95, `test:contract` (16), `:v2` (127), `:v3` (155) and `test:token` (6).
6. `npm run verify:live-run` re-reads all 91 recorded v2 transactions from the testnet RPC and compares status, error, return value, logs and gas (`LIVE RUN REPLAYED`), falling back to an archival RPC for old transactions; `verify:live-run:v3` does the same for the 17 v3 ones.

## Demo (2 minutes)

1. **Honest promise.** "My mug from order A123 arrived broken. Can I get a partial refund?" The bot replies `PROMISE|refund|order=A123-…|bps=2000`. The shop's server registers the signed reply before releasing it, and the page checks the receipt itself through public RPC, showing `BINDING · claimable 4 tUSDC`.
2. **Denial.** "We never promised that." No method deletes a receipt, and the cap was reserved when the order was created.
3. **Cap.** A misconfigured prompt (order A124) lets the bot promise 100%, and the contract pays `min(10000, 3000)` = 30%: 6 tUSDC of 20. The same injection message got 0/3 against the honest prompt.
4. **Refusals.** An edited `2000 → 3000` claim gives `ERR_NO_RECEIPT_FOR_BYTES`, a shop registering an edited reply `ERR_BAD_SIGNATURE`, a second claim `ERR_ALREADY_CLAIMED`.

## Verify each claim on chain

| Claim | See |
| --- | --- |
| The reply was signed by an attested TEE key | `get_signers` on `cbp-sm1110.testnet`: signer `5a0210f2…caff`, `attestation_sha256` `520bedd1…6a65`, the sha256 of `fixtures/attestation/z-ai_glm-5.3-flash-ed25519-2026-11-10-renewed.json` |
| The contract checked the signature | [register tx](https://testnet.nearblocks.io/txns/ANGY8bVshxV16ovVNG4gHpbmAnSymrF9SqM8DtqTBjpv): `EVENT_JSON … receipt_registered` |
| The shop cannot register an edited reply | [failed tx](https://testnet.nearblocks.io/txns/G8E1jxjvBUtZEnHSH2NPgmnJs3D12CefGo4iRzm32Az5): `Smart contract panicked: ERR_BAD_SIGNATURE` |
| An over-generous promise is capped | [claim tx](https://testnet.nearblocks.io/txns/9RY21rAq2jSF6VkMreSdUqxKNA556kubR2bghL36nShq): `token_bps 10000, paid_bps 3000`, 0.6 NEAR not 2 NEAR |
| One claim per order | [claim tx](https://testnet.nearblocks.io/txns/eM3n99AVorEeASQKjHCpLA1SNYZwZvqBcCcxzRZ3Kei) paid A123-11; `preview_claim` now answers `ERR_ALREADY_CLAIMED` |

The double claim locally, in replay mode; nothing is sent to testnet, and POSTs must carry the dashboard `Origin`:

```
npm run demo:replay            # in one terminal
curl -s http://127.0.0.1:8787/api/config >/dev/null      # resets the replay's claim state
B64=$(node -p "JSON.parse(require('fs').readFileSync('fixtures/live/a123.json')).response_b64")
for i in 1 2; do curl -s -w ' [HTTP %{http_code}]\n' -X POST http://127.0.0.1:8787/api/demo/claim \
  -H 'Origin: http://127.0.0.1:8787' -H 'Content-Type: application/json' \
  -d "{\"order_id\":\"A123-11\",\"response_b64\":\"$B64\"}"; done
# 1st: {"ok":true,... "payout":"400000000000000000000000"...}   2nd: {"error":"ERR_ALREADY_CLAIMED",...} [HTTP 400]
```

## How it works

```
   SHOPPER BROWSER (web/)                       MERCHANT SIDE (one laptop in the demo)
 +-----------------------------+        +------------------------------------------------+
 | Shopper pane                | (1)    | app/server.mjs  "relayer" (Node 22/24)          |
 |  chat ---------------------------->  |  - builds request bytes ONCE                    |
 |  BINDING check (own code):  |  (6)   |  - keeps raw response bytes                     |
 |   sha256(bytes) in browser  |  ====  |  - releases reply ONLY after receipt is FINAL   |
 |   RPC view get_receipt      |        |  keys: RELAYER fc-key (register_receipt only)   |
 |   RPC view preview_claim    |        |        BUYER fc-key (claim only, DEMO ONLY)     |
 |  Claim / Tamper buttons     |        +-------+----------------------+-----------------+
 | Merchant pane: bond meter,  |                | (2) HTTPS exact bytes | (4) tx register_receipt
 |  "we never promised that",  |                v                       v
 |  register-edited button     |   +---------------------------+   +-----------------------------+
 +--------------+--------------+   | NEAR AI Cloud gateway     |   | NEAR testnet                |
                | (5) RPC views    |  cloud-api.near.ai/v1     |   | market contract (v2)        |
                +----------------->|  -> model TEE (glm-5.3-   |   |  signers / bonds / orders / |
                   (JSON-RPC)      |     flash), signs         |   |  receipts / storage         |
                                   |  /v1/signature/{chat_id}  |   |  ed25519_verify, sha256,    |
                                   |  /v1/attestation/report   |   |  token parse, caps, payout  |
                                   +-------------+-------------+   +--------------+--------------+
                                                 | attestation (no key)           ^ add_signer (owner)
                                                 v                                |
                                   +---------------------------+                  |
                                   | npm run attest (owner)    |------------------+
                                   | SDK verifies TDX + GPU,   |  record file sha256 -> attestation_sha256
                                   | writes fixtures/attestation|
                                   +---------------------------+
```

The relayer gets the message, calls NEAR AI with the exact request bytes, polls `/v1/signature/{chat_id}` for the TEE signature, then calls `register_receipt` with its function-call key and waits for FINAL. The browser checks the receipt itself through public RPC, and only then is the reply shown. Claiming goes browser → `/api/demo/claim` → a `claim` tx signed by the buyer's claim-only key → the bond pays out. The relayer never re-serializes the response: it hashes the exact bytes (`Accept-Encoding: identity`), so the hash the contract checks is the hash of the bytes the shopper later claims.

## Limits and trust

| Component | Trusted for | Not trusted for |
| --- | --- | --- |
| NEAR AI model TEE | producing and signing the reply bytes | anything else |
| Contract owner (v3: a separate account) | registering only attested signer keys | money, in a production deployment |
| Merchant / relayer | registering a reply (an unregistered reply is not a promise) and, on v2, each order's expiry | editing a reply, exceeding `max_bps`, withdrawing reserved bond |
| Shopper | nothing | registering receipts, claiming twice, claiming edited bytes |
| Browser BINDING check | the page's own RPC views against the RPC URL and contract it was given | the merchant's `reply` string, which it ignores; since the merchant's server serves the page, the check is independent only under `npm run verify` or an independently hosted page |

`cbp-sm1110.testnet`, `v2.cbp-sm1110.testnet` and `sm1110-tusdc.testnet` each hold exactly one `FullAccess` key. Check it read-only, changing `account_id` for the others:

```
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"v2.cbp-sm1110.testnet"}}'
```

No method moves a bond, rescues funds or deletes a receipt, but whoever holds the key could redeploy the code, so the contract is not trustless. A production deployment would lock the account or hand the key to a DAO or multisig with a timelock; it stays for now because renewing the TEE signer needs it and there is no owner-transfer method. v3 fixes this: `claimable-promises.testnet` has a separate owner and no access key.

The README's [Limitations](../README.md#limitations) section is the short list. Beyond it: a receipt filed under the wrong order blocks that reply for good; truncated replies (`finish_reason: length`) are not detected, though the merchant is never overcharged; instances of one model share a signing key; the demo's 2-minute TTL sits below the contract's 1 hour floor; v1/v2 builds are `non-reproducible-wasm`, so a rebuild differs even though the committed wasm matches the on-chain hash; and the shopper has no wallet login.

Out of scope: mainnet, NEAR Intents, on-chain TDX quote verification, a private chat, a trustless deployment.

## Deployment

| | |
| --- | --- |
| Market (v2, the demo page) | `v2.cbp-sm1110.testnet`, allow-list `[sm1110-tusdc.testnet]` |
| Market (v3, keyless) | `claimable-promises.testnet`, owner `claimable-owner.testnet`, token `claimable-tusdc.testnet` |
| v1 (NEAR only, still live) | `cbp-sm1110.testnet` |
| Merchant / shopper | `cbp-shop-sm1110.testnet` / `cbp-alice-sm1110.testnet` |
| Bot model | NEAR AI Cloud `z-ai/glm-5.3-flash` |

`fixtures/replay/` holds the v1, v2 tUSDC and v2 NEAR transcripts; `fixtures/runs/` every transaction of the v2 and v3 live runs.

## Track fit

- **AI Security & Defense** (`security`): a fixed promise format, an on-chain `max_bps` cap, function-call keys limited to `register_receipt` and `claim`, and a signer key registered with a hash of its TEE attestation.
- **Real-World Money** (`realworld`): refund promises backed by a bond in NEAR or an NEP-141 stablecoin, which on v3 the customer can collect even when the shop does not register the promise.

## Built at NEAR HACKATHON

All code was written during NEAR HACKATHON (2026-11). The signature-check pattern follows [tee-receipts](https://github.com/tmdry4530/tee-receipts) (MIT); one real NEAR AI ECDSA receipt from its fixtures is a test vector in `contract/src/ecdsa.rs`. No code was copied.
