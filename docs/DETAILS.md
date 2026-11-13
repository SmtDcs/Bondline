# Technical details

The verify tool, the replay, the deployment, the recorded runs and the data in this repository.

## `npm run verify`

The contract checked is `--contract`, then `$CONTRACT_ID`, then the contract named inside the bundle but only if it is one of this repository's deployments, then `v2.cbp-sm1110.testnet`. Any other contract named in a bundle is ignored with a `WARN` line, which is why the v1 fixtures verify against v1 with no flag. A v2 bundle needs `--merchant cbp-shop-sm1110.testnet`; without it the run prints `FAIL  merchant given` and `NOT VERIFIED`. Flags may come before or after the file.

The on-chain rows check that the signer is registered, is `provider_tee` for the bundle's model and was valid when the receipt was registered (receipts keep verifying after the signer expires); that its `attestation_sha256` equals the sha256 of a record in `fixtures/attestation/` listing the key; that the receipt is on chain; and that `preview_claim` accepts the bytes. An already claimed order answers `ERR_ALREADY_CLAIMED`, which passes.

Bundles in `fixtures/simulated/` are signed with a publicly known fake key (seed `0x01` × 32), and end in `SIMULATED (fake key, proves nothing about a TEE)` offline or `NOT VERIFIED` online. Behind an HTTP(S) proxy Node's `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY`, so `verify` prints `FAIL  testnet RPC unreachable`; set `NODE_USE_ENV_PROXY=1` (Node 22.21+ or 24) or use `--offline`.

The `verified` list in an attestation record is the output of `npm run attest`, which checks the Intel TDX quote, the nonce and signing-address binding, the compose hash and the NVIDIA GPU evidence through `@nearai/inference-sdk`. `verify` and `verify:fixtures` do not re-run that, since it needs Node 24 and a NEAR AI key. Offline, anyone can confirm that the record file's sha256 equals the `attestation_sha256` on chain and that the bundle's key is one the record lists.

## The replay

`npm run demo:replay` (v1) and `npm run demo:replay:v2` serve the recorded run from `fixtures/replay/`; with `?offline=1` the page uses the recorded views and touches nothing but localhost.

Receipts, orders, claim results and transaction hashes are recorded chain data. The recorder ran after both claims, when a live `preview_claim` can only answer `ERR_ALREADY_CLAIMED`, so three kinds of view are recomputed from the recorded bytes by `app/lib/transcript.mjs`, a JavaScript mirror of the contract's rules: the chat-time `BINDING` badges, the Tamper results and the first pre-claim bond meter. Each carries `computed: true`, the replay badge says so, and their payouts equal the recorded results (0.4 / 0.6 NEAR, 4 / 6 tUSDC). Reloading resets the replay, so the Claim beat can be played again; without `?offline=1` the page asks testnet and, since both orders are claimed there, shows `ERR_ALREADY_CLAIMED`.

## `npm run verify:live-run`

Re-reads every transaction in `fixtures/runs/v2-live-run.json` from the testnet RPC and compares success or failure, error, returned value, logs and gas burnt (`LIVE RUN REPLAYED`). `-- --offline` only checks the file's structure. Public RPC nodes drop old outcomes after a few epochs, so the tool falls back to `https://archival-rpc.testnet.fastnear.com`; with an explicit `-- --rpc <url>` there is no fallback.

## Deployment on testnet

| Item | Value |
| --- | --- |
| Market (v2) | `v2.cbp-sm1110.testnet`, owner = itself; `get_config`: `api 2`, `allowed_tokens ["sm1110-tusdc.testnet"]`, `min_order_ttl_ms 120000` (a demo value; the default floor is 1 hour) |
| v2 code | `contract-v2/res/bot_promises_v2.wasm`, 299447 bytes, redeployed in place on 2026-11-11 |
| v1 contract | `cbp-sm1110.testnet`, `contract/res/bot_promises.wasm` |
| Mock token | `sm1110-tusdc.testnet` (tUSDC, 6 decimals, owner-only mint), source in `token/` |
| Shop / shopper | `cbp-shop-sm1110.testnet` / `cbp-alice-sm1110.testnet`; `cbp-bob-sm1110.testnet` is the failure-case buyer |
| TEE signer | `5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff` (ed25519), `attestation_sha256` `520bedd1a170147cf13b84ad168440c1db011060fc525da1a434f76e6c126a65`, expires 2026-11-30 10:45 UTC |
| Function-call keys (v2) | shop: `register_receipt` only; alice: `claim` only |

Hashes, build environment and what they prove: `docs/wasm-sha256.txt`. Method-level reference: `docs/INTERFACES.md` for v1, `docs/STABLECOIN.md` for v2.

## The recorded runs

**v1 (2026-11-10, `fixtures/replay/transcript.json`).** Honest reply for A123-11: register tx
[`ANGY8bVs…`](https://testnet.nearblocks.io/txns/ANGY8bVshxV16ovVNG4gHpbmAnSymrF9SqM8DtqTBjpv), claim tx
[`eM3n99AV…`](https://testnet.nearblocks.io/txns/eM3n99AVorEeASQKjHCpLA1SNYZwZvqBcCcxzRZ3Kei), 0.4 NEAR. Naive bot for A124-11: `bps=10000`, claim tx
[`9RY21rAq…`](https://testnet.nearblocks.io/txns/9RY21rAq2jSF6VkMreSdUqxKNA556kubR2bghL36nShq), `token_bps 10000, paid_bps 3000`, 0.6 NEAR. The shop registering an edited reply failed with `ERR_BAD_SIGNATURE`
([`G8E1jxjv…`](https://testnet.nearblocks.io/txns/G8E1jxjvBUtZEnHSH2NPgmnJs3D12CefGo4iRzm32Az5)).

**v2 live flows L1-L14 (2026-11-10, `fixtures/runs/v2-live-run.json`).** Run with near-api-js (`app/scripts/live-v2.mjs`) and the real app for the chat steps.

| Step | What it showed |
| --- | --- |
| L1 | the money methods refuse a call without exactly 1 yoctoNEAR (`ERR_ONE_YOCTO`) |
| L2 | a 100 tUSDC bond came in by `ft_transfer_call` |
| L3, L4(a), L5 | a wrong `msg`, a direct `ft_on_transfer` and a bond without storage balance were refunded, not credited |
| L6, L6b | real chat → TEE-signed reply → receipt → claim, 4 tUSDC; the tamper and edited-reply refusals |
| L7 | a claim to a buyer not registered on the token succeeded with `ok:false` / `ERR_PAYOUT_FAILED`, leaving the order open and the bond unchanged; the retry after registration paid, a third claim gave `ERR_ALREADY_CLAIMED` |
| L8 | the naive bot's `bps=10000` paid 6 tUSDC of a 20 tUSDC / 30% order |
| L9, L9b | bond withdrawal; a withdrawal to a merchant that unregistered from the token was restored by the callback |
| L10 | expiry: `ERR_ORDER_EXPIRED`, `release_expired` by a third account, the freed bond withdrawn |
| L11 | each `register_order` charged the shop exactly 246 bytes × 10^19 yocto; the market's own balance did not pay |
| L12 | two merchants registered the same order id; a claim with the wrong merchant gave `ERR_NO_ORDER` |
| L13 | the v1 NEAR demo on v2: 0.4 NEAR, the 0.6 NEAR cap, tamper, edited reply, double claim |
| L14 | `verify` passed on the v2 bundles and transcript |

On 2026-11-11 the final build was redeployed in place and re-checked (code hash and signer-key rules, a fresh tUSDC claim and its failure cases); the other steps were not repeated. The file holds 91 transactions (32 deliberate failures) and 152 checks. Not run live: the second-token refund and `ERR_LIABILITY_ZERO` (unit tests only).

A tUSDC `claim` burns 2.7 Tgas, its `ft_transfer` 1.8 Tgas and the `on_claim_paid` callback 2.2 Tgas, about 7.7 Tgas for a whole claim. The budgets `GAS_FT_TRANSFER = 20` and `GAS_CALLBACK = 15` Tgas were kept so a heavier token has room; unused gas is refunded.

## Contract v3

`claimable-promises.testnet` lets the customer register the signed reply (`register_receipt_as_buyer`), with every request authorized by the shop's server. Design, surface, accounts, deploy and live run: [`V3.md`](V3.md).

## Contract v1 limitations, fixed in v2

| Limitation (v1) | Impact | v2 |
| --- | --- | --- |
| No storage deposit | anyone can grow state paid from the contract's own balance, which also holds the bonds | every state-creating call measures `env::storage_usage()` and charges the caller's prepaid storage balance; `liability > 0` is required; payouts go through a callback that restores the books on failure |
| Global order-id namespace | another merchant can squat an order id | orders and receipts are keyed by `(merchant, id)` / `(merchant, response_hash)` |
| No expiry | a reservation is locked forever | `ttl_ms` per order, `release_expired` by anyone |

The v1 contract on testnet is unchanged and still has these limits.

## Data in this repository

| Path | What it is |
| --- | --- |
| `fixtures/live/a123.json`, `a124.json` | v1 bundles: the honest reply (`bps=2000`) and the naive bot's reply (`bps=10000`, paid at the 30% cap) |
| `fixtures/live/spike-s1.json` | the first live `provider_tee` ed25519 signature registered on testnet |
| `fixtures/live/a123-v2*.json`, `a124-v2*.json` | the v2 tUSDC and NEAR runs |
| `fixtures/live/*-tampered.json` | copies with `2000` edited to `3000`; every check rejects them |
| `fixtures/simulated/` | bundles signed with the public fake key |
| `fixtures/attestation/` | the first attestation record (`dce1c116…2365`) and the renewal on chain now (`520bedd1…6a65`) |
| `fixtures/replay/` | replay transcripts: v1, v2 tUSDC, v2 NEAR |
| `fixtures/runs/v2-live-run.json`, `v3-live-run.json` | every transaction and check of the v2 and v3 live runs |
| `fixtures/live/v3-*.json` | the v3 bundles: genuine replies registered by the customer, and the refused self-made, forged-tag and wrong-buyer requests |
