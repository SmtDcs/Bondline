# Technical details

Reference material behind the README: the verify tool, the replay, the deployment, both contract surfaces, the recorded
runs and the data in this repository.

## `npm run verify`

The contract checked is `--contract`, then `$CONTRACT_ID`, then the contract the bundle names **only if it is one of the two
deployments of this repository** (`cbp-sm1110.testnet` v1, `v2.cbp-sm1110.testnet` v2), then the pinned `v2.cbp-sm1110.testnet`.
Any other contract named inside a bundle is ignored and a `WARN` line says so. That is why the v1 fixtures verify against v1 with
no flag.

A v2 contract keys receipts by merchant, so a v2 bundle needs `--merchant cbp-shop-sm1110.testnet`, for example
`npm run verify -- fixtures/live/a123-v2.json --merchant cbp-shop-sm1110.testnet`. Without it the run prints
`FAIL  merchant given` and `NOT VERIFIED`. Flags may come before or after the file.

The on-chain rows: the signer is registered, is `provider_tee` for the bundle's model and **was valid when the receipt was
registered** (receipts keep verifying after the signer expires), its `attestation_sha256` equals the sha256 of a record in
`fixtures/attestation/` that lists the key, the receipt is on chain, and `preview_claim` accepts the bytes. An already claimed
order answers `ERR_ALREADY_CLAIMED`, which still passes: the signer and receipt checks are the point.

SIMULATED bundles (`fixtures/simulated/`) are signed with a publicly known fake key (seed `0x01` × 32). With `--offline` they end in
`SIMULATED (fake key, proves nothing about a TEE)`; online they end in `NOT VERIFIED`. They never print `VERIFIED`.

**Behind an HTTP(S) proxy:** Node's built-in `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY`, so `verify` prints
`FAIL  testnet RPC unreachable`. Set `NODE_USE_ENV_PROXY=1` (Node 22.21+ or 24), or use `--offline`.

**What the attestation row proves.** The `verified` signer list in `fixtures/attestation/*.json` is the output of
`npm run attest`, which verifies the Intel TDX quote, the nonce / signing-address binding, the compose hash and the NVIDIA GPU
evidence through `@nearai/inference-sdk`. `verify` and `verify:fixtures` do not re-run that (it needs Node 24 and a NEAR AI key
for a fresh report). What anyone can confirm offline: the record file's sha256 equals the `attestation_sha256` on chain, and the
key in the bundle is a key the record lists.

## The replay

`npm run demo:replay` (v1) and `npm run demo:replay:v2` serve the recorded run from `fixtures/replay/`. Open
http://127.0.0.1:8787/?offline=1: the page then uses the views recorded in the transcript and touches nothing but localhost.

The receipts, orders, claim results and transaction hashes are real recorded chain data. The recorder ran after both claims, when
the live `preview_claim` can only answer `ERR_ALREADY_CLAIMED`, so three kinds of view are **recomputed** from the recorded bytes by
`app/lib/transcript.mjs` (a JavaScript mirror of the contract's rules): the chat-time `BINDING · claimable …` badges, the Tamper
results and the first pre-claim bond meter. Each carries `computed: true` and the replay badge says so; their payouts equal the real
recorded claim results (0.4 / 0.6 NEAR, 4 / 6 tUSDC).

Reloading the page resets the replay, so the Claim beat can be played again. Without `?offline=1` the page asks testnet for the
BINDING check, and since both recorded orders are claimed on chain it shows `ERR_ALREADY_CLAIMED`.

## `npm run verify:live-run`

Re-reads every transaction in `fixtures/runs/v2-live-run.json` from the testnet RPC and compares success or failure, the error,
the returned value, the logs and the gas burnt (`LIVE RUN REPLAYED`). `-- --offline` only checks the file's structure. Public RPC
nodes drop old transaction outcomes after a few epochs; the tool then falls back to `https://archival-rpc.testnet.fastnear.com`
automatically. With an explicit `-- --rpc <url>` there is no fallback.

## Deployment on testnet

| Item | Value |
| --- | --- |
| Market (v2) | `v2.cbp-sm1110.testnet`, owner = itself, `get_config`: `api 2`, `allowed_tokens ["sm1110-tusdc.testnet"]`, `min_order_ttl_ms 120000` (a demo value; the contract default floor is 1 hour) |
| v2 code | `contract-v2/res/bot_promises_v2.wasm`, 299447 bytes, sha256 `8f4abd257e5dcb3809dfde681dca78a1eae95aacb4d7b399c68adb8a3a2656b8` = on-chain `code_hash` `AeMQDGx2PUj5LXwFHrKZZR2wGjxrExLHZEcEJvbMhMe7`; redeployed in place on 2026-11-11, tx `FRTpSjjFbJ13JWeG7ASC17e3zBeHVagjSFL92JqMp63M` |
| v1 contract | `cbp-sm1110.testnet`, `contract/res/bot_promises.wasm`, sha256 `c4d88ead840e3300356aba35072a8cd1ef897edaa3ce9d2ac2590326bd7d8941` = `code_hash` `EFQS8Avk5ujFyS8xUtZPUAFsdbb58Q47jJjhCe3JAd4C`, deploy tx `9g8gNoE6sTocnLGm95LnExkNS15bn4SB7uX7MoVFXtKX` |
| Mock token | `sm1110-tusdc.testnet` (tUSDC, 6 decimals, owner-only mint), source in `token/`, on-chain sha256 `66d6fc0a1c29683a8802bda397e8448ead45c74df1d591cc5ddf2b6d213570c1`, deploy tx `2b3hMb4qHXo3XFan4y4gCG3zow5MEaQCzvg1eYrJgBDJ` |
| Shop / shopper | `cbp-shop-sm1110.testnet` / `cbp-alice-sm1110.testnet`; `cbp-bob-sm1110.testnet` is the failure-case buyer |
| TEE signer | `5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff` (ed25519), `attestation_sha256` `520bedd1a170147cf13b84ad168440c1db011060fc525da1a434f76e6c126a65` = sha256 of `fixtures/attestation/z-ai_glm-5.3-flash-ed25519-2026-11-10-renewed.json`, expires 2026-11-30 10:45 UTC (renewal tx `DMnrwVT2vV7Mb6u33t79PkvqUtzw2CRr1r3DrrBQcQZX`) |
| Function-call keys (v2) | shop: `register_receipt` only (tx `7E1q3roU8iSeTTzXqjvrLak1uN1qyFcgEd79e3jiXvYe`); alice: `claim` only (tx `5qygwdQQTorxucw9kojQSY1ZS7Z2zxJTYLdcZK9yWAie`) |

Hashes, build environment and what they do and do not prove: `docs/wasm-sha256.txt`.

## The recorded runs

**v1 (2026-11-10, `fixtures/replay/transcript.json`).** Honest reply for A123-11: register tx
[`ANGY8bVs…`](https://testnet.nearblocks.io/txns/ANGY8bVshxV16ovVNG4gHpbmAnSymrF9SqM8DtqTBjpv), claim tx
[`eM3n99AV…`](https://testnet.nearblocks.io/txns/eM3n99AVorEeASQKjHCpLA1SNYZwZvqBcCcxzRZ3Kei), 0.4 NEAR. Naive bot for A124-11:
`bps=10000`, claim tx [`9RY21rAq…`](https://testnet.nearblocks.io/txns/9RY21rAq2jSF6VkMreSdUqxKNA556kubR2bghL36nShq),
`token_bps 10000, paid_bps 3000`, 0.6 NEAR. The shop registering an edited reply failed with `ERR_BAD_SIGNATURE`
([`G8E1jxjv…`](https://testnet.nearblocks.io/txns/G8E1jxjvBUtZEnHSH2NPgmnJs3D12CefGo4iRzm32Az5)).

**v2 live flows L1-L14 (2026-11-10, `fixtures/runs/v2-live-run.json`).** Run with near-api-js (`app/scripts/live-v2.mjs`) and the
real app for the chat steps (NEAR AI `z-ai/glm-5.3-flash`, the relayer's function-call key, alice's claim-only key):

| Step | What it showed |
| --- | --- |
| L1 | deployment state; the money methods refuse a call without exactly 1 yoctoNEAR (`ERR_ONE_YOCTO`) |
| L2 | storage deposit and a 100 tUSDC bond by `ft_transfer_call` |
| L3, L4(a), L5 | a wrong `msg`, a direct `ft_on_transfer` and a bond without storage balance are refunded, not credited |
| L6, L6b | real chat → TEE-signed reply → receipt → claim, 4 tUSDC; the tamper and edited-reply refusals |
| L7 | a claim to a buyer not registered on the token: the tx succeeds with `ok:false` / `ERR_PAYOUT_FAILED`, the order stays open and the bond unchanged; after registering, the retry pays; a third claim gives `ERR_ALREADY_CLAIMED` |
| L8 | the naive bot's `bps=10000` pays 6 tUSDC of a 20 tUSDC / 30% order |
| L9, L9b | bond withdrawal; a withdrawal to a merchant that unregistered from the token is restored by the callback |
| L10 | expiry: `ERR_ORDER_EXPIRED`, `release_expired` by a third account, the freed bond is withdrawn |
| L11 | storage accounting: each `register_order` charged the shop exactly 246 bytes × 10^19 yocto; the market's own balance did not pay |
| L12 | namespaces: two merchants register the same order id; a claim with the wrong merchant gives `ERR_NO_ORDER` |
| L13 | the v1 NEAR demo on v2 (0.4 NEAR, the 0.6 NEAR cap, tamper, edited reply, double claim) |
| L14 | `npm run verify` on the v2 bundles and the v2 replay transcript |

On 2026-11-11 the final build was redeployed in place and re-checked (L1r: code hash and signer-key rules; L6r, L6s: a fresh
tUSDC claim and its failure cases). The other steps were not repeated on that build. In total the file holds 91 transactions
(32 of them deliberate failures) and 152 checks computed by the script. Not run live: the second-token refund (L4b) and
`ERR_LIABILITY_ZERO` (unit tests only).

**Gas (measured):** a tUSDC `claim` burns 2.7 Tgas, its `ft_transfer` 1.8 Tgas and the `on_claim_paid` callback 2.2 Tgas, about
7.7 Tgas for a whole claim. The budgets `GAS_FT_TRANSFER = 20` and `GAS_CALLBACK = 15` Tgas were kept (unused gas is refunded)
so a heavier real token has room.

## Contract v3

`claimable-promises.testnet` lets the customer register the signed reply (`register_receipt_as_buyer`), with every request
authorized by the shop's server. Design, contract surface, accounts, deploy and live-run transactions, residual trust and hashes:
[`V3.md`](V3.md).

## Contract v1 limitations, fixed in v2

| Limitation (v1) | Impact | v2 |
| --- | --- | --- |
| No storage deposit | anyone can grow state paid from the contract's own balance, which also holds the bonds | every state-creating call measures `env::storage_usage()` and charges the caller's prepaid storage balance (live: L11); `liability > 0` is required; payouts go through a callback that restores the books on failure (live: L7, L9b) |
| Global order-id namespace | another merchant can squat an order id | orders and receipts are keyed by `(merchant, id)` / `(merchant, response_hash)` (live: L12) |
| No expiry | a reservation is locked forever | `ttl_ms` per order, `release_expired` by anyone (live: L10) |

The v1 contract on testnet is unchanged and still has these limits.

## Contract surface (v1)

| Method | Kind | Who | Effect |
| --- | --- | --- | --- |
| `new(owner)` | init | deployer | sets the owner |
| `add_signer(public_key_hex, kind, model_id, attestation_sha256, expires_at_ms)` | change | owner | registers an attested TEE key |
| `remove_signer(public_key_hex)` | change | owner | removes a key; old receipts stay valid |
| `register_merchant()` payable >= 1 NEAR | change | anyone once | creates the bond |
| `add_bond()` payable | change | merchant | adds to the bond |
| `withdraw_bond(amount)` | change | merchant | only `bond - reserved` |
| `register_order(order_id, buyer, amount, max_bps)` | change | merchant | reserves `amount * max_bps / 10000` |
| `register_receipt(order_id, signed_text, signature_hex, signer_public_key_hex)` | change | the order's merchant | ed25519 check on chain; stores the receipt by response hash |
| `claim(order_id, response_b64)` | change | the order's buyer | sha256 → receipt → token → `min(bps, max_bps)` → transfer |
| `get_owner`, `get_signer`, `get_signers`, `get_merchant`, `get_order`, `get_receipt`, `preview_claim` | view | anyone | reads; `preview_claim` never panics |

Error strings are listed in `docs/INTERFACES.md` section 6. Every state change emits an `EVENT_JSON` log (NEP-297 shape) with
standard `botpromise`.

## Contract surface (v2)

| Method | Kind | Who | Effect |
| --- | --- | --- | --- |
| `new(owner, allowed_tokens?, min_order_ttl_ms?)` | init | deployer | allow-list (<= 8, no duplicates) and the TTL floor |
| `add_signer`, `remove_signer` | change | owner | as v1, plus exactly 1 yoctoNEAR |
| `register_merchant()` payable >= 1 NEAR | change | anyone once | NEAR bond; the record's storage cost comes out of the deposit |
| `add_bond()` payable | change | merchant | NEAR bond top-up |
| `ft_on_transfer(sender_id, amount, msg)` | change | the token contract | the only token inflow; `{"add_bond":{}}`, anything else is refunded |
| `withdraw_bond(amount, token?)` | change | merchant | free part only, paid through a callback; 1 yoctoNEAR |
| `register_order(order_id, buyer, amount, max_bps, token?, ttl_ms?)` | change | merchant | reserves in that token's bond, sets `expires_at_ms`; 1 yoctoNEAR |
| `release_expired(merchant, order_id)` | change | anyone | frees an expired reservation |
| `register_receipt(order_id, signed_text, signature_hex, signer_public_key_hex)` | change | the order's merchant | as v1; refused for settled or expired orders |
| `claim(merchant, order_id, response_b64)` | change | the order's buyer | pays through `ft_transfer` / transfer + `on_claim_paid`; `ok:false` on a failed payout |
| `storage_deposit`, `storage_withdraw`, `storage_balance_of` | change / view | anyone / the account | prepaid storage shaped like NEP-145; `storage_withdraw` needs 1 yoctoNEAR |
| `on_claim_paid`, `on_withdraw_resolved` | callback | the contract | book changes after the transfer result; never panic on a failed transfer |
| views | view | anyone | `get_config`, `get_bond(s)`, `get_merchant`, `get_order(merchant, id)`, `get_receipt(merchant, hash)`, `preview_claim(merchant, id, b64)` |

A successful transaction is not a successful payout: clients must read `result.ok`. New errors and the full design:
`docs/STABLECOIN.md`.

NEP-145 registration: the market, the merchant and the buyer must be registered on the token. The setup script registers the
merchant and the buyer; `verify` prints a FAIL row when the market has no storage on an allowed token; the server hides a token order
whose token metadata or market registration check fails. A claim to an unregistered buyer fails safely and can be retried.

## Data in this repository

| Path | What it is |
| --- | --- |
| `fixtures/live/a123.json`, `a124.json` | v1 receipt bundles: the honest reply (`bps=2000`) and the naive bot's reply (`bps=10000`, paid at the 30% cap) |
| `fixtures/live/spike-s1.json` | the first live `provider_tee` ed25519 signature, registered on testnet |
| `fixtures/live/a123-v2.json`, `a124-v2.json` | the v2 tUSDC run (A123-23 honest, A124-21 capped) |
| `fixtures/live/a123-v2-near.json`, `a124-v2-near.json` | the NEAR run on v2 (A123-22, A124-22) |
| `fixtures/live/*-tampered.json` | copies with `2000` edited to `3000`; every check must reject them |
| `fixtures/simulated/` | SIMULATED bundles signed with the public fake key; labelled SIMULATED everywhere |
| `fixtures/attestation/` | the first attestation record (sha256 `dce1c116…2365`) and the renewal (`520bedd1…6a65`, the one on chain now) |
| `fixtures/replay/` | replay transcripts: v1, v2 tUSDC, v2 NEAR |
| `fixtures/runs/v2-live-run.json` | every transaction of the v2 live run and the re-check, with arguments, results, gas and logs |
| `fixtures/live/v3-*.json` | the v3 live run's bundles: the genuine replies (registered by the customer) and the refused self-made, forged-tag and wrong-buyer requests |
| `fixtures/runs/v3-live-run.json` | every transaction and check of the v3 live run |
