# Reference details (moved out of the README)

The README keeps what a judge needs. This file holds the long reference text that used to sit in it: notes on the "Try it" steps, the signer renewal,
the v1 limitation table, the full contract v2 section, both contract surfaces and the list of fixtures. Nothing here was shortened; where a fact was stale
(2026-11-11 audit) it was corrected in place.

## Notes on the "Try it in 2 minutes" steps

**Step 3 (`npm run verify`) in full:**
The contract checked is `--contract`, then `$CONTRACT_ID`, then the contract the bundle names **only if it is one of the two repo deployments** (`cbp-sm1110.testnet` v1 history, `v2.cbp-sm1110.testnet`), then the pinned current `v2.cbp-sm1110.testnet`. Any other contract named inside a bundle is ignored and a `WARN` line says so. That is why the v1 fixtures keep verifying against v1 with no flag. A v2 contract needs `--merchant cbp-shop-sm1110.testnet` (receipts are keyed by merchant; without it the run prints its own `FAIL merchant given` row, and flags may come before or after the file), for example `npm run verify -- fixtures/live/a123-v2.json --merchant cbp-shop-sm1110.testnet` (verified on 2026-11-10: `VERIFIED`, the token, the amount `20000000` and the allowed-token and market-registration rows are printed).

**Proxy note (step 3):**
**Behind an HTTP(S) proxy:** `verify` uses Node's built-in `fetch`, which ignores `HTTP_PROXY` / `HTTPS_PROXY`. Without help it prints `FAIL  testnet RPC unreachable` and `NOT VERIFIED` (exit 1). Set `NODE_USE_ENV_PROXY=1` (Node 22.21+ or 24), for example `NODE_USE_ENV_PROXY=1 npm run verify -- fixtures/live/a123.json`, or skip testnet with `--offline`. Node prints an `UNDICI-EHPA` experimental warning; ignore it.

**Step 4 (`npm run demo:replay`) in full:**
4. `npm run demo:replay`, then open **http://127.0.0.1:8787/?offline=1** - click through the recorded demo (beats below). `?offline=1` is what makes the replayed badges and the Claim button show up. **Which views are recorded and which are recomputed:** the recorder ran after both claims, when the live `preview_claim` can only answer `ERR_ALREADY_CLAIMED`, so the chat-time `BINDING · claimable …` badges, the Tamper results (`ERR_NO_RECEIPT_FOR_BYTES`) and the first pre-claim bond meter are **recomputed** by `app/lib/transcript.mjs` (a JS mirror of the contract's rules) from the recorded bytes, `get_receipt` and `get_order`; they were never returned by the contract. Each such view carries `computed: true` in the transcript (top-level `computed_views: true`) and the replay badge says so. The payouts they show equal the real recorded claim results (0.4 / 0.6 NEAR, 4 / 6 tUSDC). The receipts, orders, claim results and transaction hashes are real recorded chain data. The replay's recorded expiry is not counted against today's clock. Reloading the page starts the replay again (the server forgets the claims on every `/api/config`), so the Claim beat can be played repeatedly without restarting `npm run demo:replay`; the plain URL http://127.0.0.1:8787 runs the same replay but asks testnet for the BINDING check, and both recorded orders are already claimed on chain, so it shows `ERR_ALREADY_CLAIMED` (the honest live state) instead of the claimable badges. `?offline=1` touches nothing but localhost.

**Step 8 (`npm run verify:live-run`) in full:**
8. `npm run verify:live-run` - re-reads all 81 recorded v2 transactions from the testnet RPC and compares success/failure, error, returned value, logs and gas burnt (`LIVE RUN REPLAYED`); `-- --offline` only checks the file's structure. Ordinary public RPC nodes drop transaction outcomes after a few epochs (the default RPC, `https://rpc.testnet.fastnear.com`, will stop serving the 2026-11-10 run within days): when it no longer serves a transaction, that one and the rest are read from `https://archival-rpc.testnet.fastnear.com` automatically (a `NOTE` line says so; the archival node rate-limits bursts, so it is not the first choice). With an explicit `-- --rpc <url>` there is no fallback; if that RPC does not serve a transaction the run stops at once with an `ABORT` line naming the archival URL. Behind a proxy set `NODE_USE_ENV_PROXY=1`.

## TEE signer expiry and renewal

The TEE signer registered with `add_signer` has an expiry (`expires_at_ms`, `--days N` in `npm run attest`). After it, `register_receipt` fails with the signer error; receipts already on chain stay valid. To renew: `npm run attest -- --model z-ai/glm-5.3-flash --days N`, then run the `add_signer` command it prints (owner key). **Current state (renewed 2026-11-10 10:45 UTC by the operator (on-chain `added_at_ms` 1794307533875 = 2026-11-10T10:45:33Z)):** the signer `5a0210f2…caff` was re-attested (TCB UpToDate, GPU verified) and re-registered with `add_signer` (tx `DMnrwVT2vV7Mb6u33t79PkvqUtzw2CRr1r3DrrBQcQZX`); `expires_at_ms` is now 1796035518568 = 2026-11-30 10:45 UTC, after the judging window. `get_signers` shows `attestation_sha256` `520bedd1a170147cf13b84ad168440c1db011060fc525da1a434f76e6c126a65` = sha256 of `fixtures/attestation/z-ai_glm-5.3-flash-ed25519-2026-11-10-renewed.json`. The first record `fixtures/attestation/z-ai_glm-5.3-flash-ed25519-2026-11-10.json` (sha256 `dce1c116…2365`) is kept: `verify` loads every record in `fixtures/attestation/`. Receipts already on chain stay valid; after expiry only new `register_receipt` calls fail with `ERR_SIGNER_EXPIRED`. `npm run attest` refuses to overwrite an existing record (it would break the match with an `attestation_sha256` already on chain). To renew again: `npm run attest -- --model z-ai/glm-5.3-flash --days N --out-dir <tmp>`, copy the record into `fixtures/attestation/` under a new name, then run the printed `add_signer` command (owner key).

## Known limitations (contract v1)
The contract on testnet (`cbp-sm1110.testnet`, wasm sha256 `c4d88ead…`) is frozen for the submission. These are known and understood; the last column says how v2 (`contract-v2/`, deployed at `v2.cbp-sm1110.testnet`) addresses each one. **Both limits below are now fixed in v2 and the fixes were shown on testnet** (L11, L12, L7, L10 in `docs/STABLECOIN.md` section 12, recorded in `fixtures/runs/v2-live-run.json` and `docs/build-log.md`); one sub-case (liability rounds to 0 -> `ERR_LIABILITY_ZERO`) is covered by a unit test only. The v1 contract itself is unchanged and still has both limits:

| # | Limitation | Scenario | Impact | v2 fix |
| --- | --- | --- | --- | --- |
| 1 | No storage deposit (**fixed in v2, live: L11, L12, L7**) | Anyone calls `register_merchant` with 1 NEAR, withdraws it (`reserved = 0`), then `register_order` with `amount=1, max_bps=1` (liability rounds to 0) in a loop, and `register_receipt` stores data even for claimed orders. Every byte is staked from the contract's own balance, which also holds all merchants' bonds. | A spammer can drain the contract's free balance toward insolvency; once the contract cannot cover storage, a detached `claim` transfer can fail (`LackBalanceForState`) after the order is already marked paid and the bond lowered, so the shopper loses that payout. Testnet demo only: the contract keeps its own storage buffer (R4 check: >= 3 NEAR beyond bonds) and nobody holds real money. | Done in v2: every state-creating call measures `env::storage_usage()` before/after and charges the account that creates the state from its own storage balance (live, L11: each `register_order` charged the shop exactly 246 bytes x 10^19 yocto = 2.46e21; the market's own balance did not pay), `register_merchant` takes the record cost from the deposit, `liability > 0` is required (`ERR_LIABILITY_ZERO`, unit test only), and `claim`/`withdraw_bond` pay through a callback that restores the books when the transfer fails (live for tUSDC: L7, L9b; the NEAR payout/withdraw restore is unit-tested only: `failed_near_payout_restores_open`, `near_withdraw_restores_on_failure`). |
| 2 | Global order-id namespace (**fixed in v2, live: L12**) | `orders` is keyed by `order_id` alone, not `(merchant, order_id)`. Another registered merchant can register an id first (`ERR_ORDER_EXISTS` for the real shop), naming any buyer. Only that order's merchant can then register receipts for it. | Order-id squatting: a hostile merchant can block or confuse ids of another shop. It cannot take money from another merchant's bond (each order is paid from its own merchant's bond) or register receipts for orders it does not own. | Done in v2: orders and receipts are keyed by `(merchant, id)` / `(merchant, response_hash)` and `claim` takes the merchant (live, L12: two merchants registered the same id `N123-21`; a claim with the wrong merchant gave `ERR_NO_ORDER`, with the other merchant's order `ERR_NOT_BUYER`). |

## Stablecoin support: contract v2 (deployed on testnet, live runs L1-L14 recorded)

`contract-v2/` (crate `bot-promises-v2`) implements the design in `docs/STABLECOIN.md`. State on
2026-11-10, **only what was checked**:

| Item | Value |
| --- | --- |
| Market contract | `v2.cbp-sm1110.testnet`, owner = itself (the account still has a full-access key, see Trust boundaries), `get_config` -> `api 2`, `allowed_tokens ["sm1110-tusdc.testnet"]`, `min_order_ttl_ms 120000` (a demo setting; the contract default is 1 hour) |
| Code | `contract-v2/res/bot_promises_v2.wasm`, 299151 bytes, sha256 `095bb43efde677c2fe531ddcdc4fb3554b9c1c35e897a8b6f23ae5908c9b9721` (with the 1-yocto fix); the on-chain `code_hash` of the account is the same (checked by the L1 script by RPC `view_account` on 2026-11-10). It replaced the first build (sha256 `399c5af6…08bd`, 299448 bytes) in place: redeploy tx `CbDQ6rL6GzTchuEE9GKqdGEHi8eUyxFKZkoJwJ51h3tC` (operator), state kept |
| Created / funded / deployed | create tx `7w6riZo57TqQXaqSuY19aCkfCwxCKcmBL5f4A8c8CBVz`, funding tx `CbD75d7Ro1e4HmDFNrstxhXoZA31d8CxpvMisN8ug4z` (7 NEAR), deploy + `new` tx `BY57K2VSfnuTg236uwVsa1frUJbyD2TyebYcFaJq1bA5` (operator; each tx was re-read with RPC `tx`: success) |
| Market registered on the token | tx `9MfE4aApnDg6zH4XuTQoXEAuKm9D7Qqc8AFPFU3URnJn`; `storage_balance_of` on the token is `1250000000000000000000` |
| TEE signer on v2 | `add_signer` tx `B4GGMbPTthfEhztR5fXqN7iJFuZet9PCBADYwLeTtGDR` (first build, 0 deposit). The redeployed build requires exactly 1 yoctoNEAR: in L1 the same record was added again with 1 yoctoNEAR (tx `Ds5DRC9mVhnhpmwRmEvzexbwzNXCmHv9bsf8zXZDjndn`; only `added_at_ms` moved) and the 0-deposit call failed `ERR_ONE_YOCTO` (tx `4G2yjF6g1go5vpmoNs3mgr9CsGxj5YqMVWw6rQyS3uKQ`); `get_signers` shows `5a0210f2…caff`, attestation `520bedd1…6a65`, expires 2026-11-30 |
| Function-call keys on v2 | shop `register_receipt` (tx `7E1q3roU8iSeTTzXqjvrLak1uN1qyFcgEd79e3jiXvYe`), alice `claim` (tx `5qygwdQQTorxucw9kojQSY1ZS7Z2zxJTYLdcZK9yWAie`); both work, see below |
| Token | `sm1110-tusdc.testnet`, **a testnet mock** (NEP-141 + NEP-145 + NEP-148, symbol `tUSDC`, 6 decimals, owner-only mint), wasm sha256 `66d6fc0a1c29683a8802bda397e8448ead45c74df1d591cc5ddf2b6d213570c1` (the on-chain code hash matches), deploy tx `2b3hMb4qHXo3XFan4y4gCG3zow5MEaQCzvg1eYrJgBDJ`. **The token's source and wasm are not in this repository** and the upstream it was built from is not named, so "owner-only mint" and the NEP compliance are the operator's description, checkable only through views and the recorded behaviour (see `docs/wasm-sha256.txt`) |
| Accounts (read by RPC on 2026-11-11) | shop 9777 tUSDC, alice 10024 tUSDC, `cbp-bob-sm1110.testnet` 4 tUSDC. Bob was deliberately **not** registered on the token at first (the failure-case account for L7); the L7 run registered him (`storage_balance_of` total `1250000000000000000000`) and paid him, so **he can no longer reproduce `ERR_PAYOUT_FAILED`: repeating L7 needs a fresh, unregistered account**. The shop's tUSDC bond is 195 (reserved 9, paid_out 28) and the market holds 195 tUSDC; right after L1-L14 these were shop 9877, alice 10014, bond 105 (reserved 9, paid_out 18): the later browser session added a 100 tUSDC top-up and paid 10 tUSDC (`docs/build-log.md`). Merchants on v2: the shop (NEAR bond and tUSDC bond) and alice (a second merchant with a NEAR bond, used for the namespace test) |

**tUSDC is a mock token that this team deployed for the testnet; it is not a real stablecoin and
has no backing.** On mainnet the allow-list would hold the token account of the issuer's native USDC
(read its account id and `ft_metadata` from the issuer, do not take it from this README), which is a
new deployment because the list is fixed at init. Nothing is deployed on mainnet.

**What was run on v2 (2026-11-10, Claude Sonnet 5.5, near-api-js, the repository's own testnet accounts).**
All of `docs/STABLECOIN.md` section 12 except the second-token half of L4 (no second mock token; nothing may be deployed in this round):
L1 state and the 1-yocto fix; L2 storage deposit and the 100 tUSDC bond; L3 wrong msg refunded; L4(a) direct `ft_on_transfer` refused; L5 first
bond without a storage balance refunded; L6 real chat -> TEE-signed reply -> receipt -> claim, 4 tUSDC; L6b tamper and edited-reply beats; L7 claim to
an unregistered receiver: tx succeeds with `ok:false` / `ERR_PAYOUT_FAILED`, order stays open, bond unchanged, after registering the retry pays,
a third claim gives `ERR_ALREADY_CLAIMED`; L8 injection capped (`bps=10000` -> 6 tUSDC of a 20 tUSDC / 30% order); L9 withdraw, and L9b a withdraw to a
merchant that had unregistered from the token was restored by the callback; L10 expiry and `release_expired`; L11 storage accounting; L12 namespace;
L13 the v1 NEAR demo on v2; L14 `npm run verify` on the v2 bundles, `fixtures/replay/transcript-v2.json`. Every transaction **of the L1-L14 run** (81, of which 27 are
failures the contract was expected to give) is in `fixtures/runs/v2-live-run.json` and in the table in `docs/build-log.md`, with 128 checks the script
computed itself (all pass); `npm run verify:live-run` re-reads all 81 from the RPC and they match. The chat, receipt and claim steps went through the
real app (`npm run dev`, headless): NEAR AI `z-ai/glm-5.3-flash`, the relayer's function-call key and alice's claim-only key.
The later real-browser session (orders `A123-31` / `A124-31`, behind the README's hero screenshot) is **not** in that file: its five transaction hashes are in `docs/build-log.md` ("Browser session"); no bundles of it were kept in `fixtures/live/`.

**Gas (measured, not guessed):** a tUSDC `claim` burns 2.7 Tgas, its `ft_transfer` 1.8 Tgas and the `on_claim_paid` callback 2.2 Tgas (a whole claim
about 7.7 Tgas). The constants `GAS_FT_TRANSFER = 20` and `GAS_CALLBACK = 15` Tgas are budgets, unused gas is refunded, and they were **kept**: the mock
uses a tenth and a seventh of them and a heavier real token has room. This is one mock token; a real USDC contract should be measured the same way.

**Not shown live, said plainly:** the second-token refund (L4b) and `ERR_LIABILITY_ZERO` (unit tests only); the replayed transcript has no
`claim-failed` beat (the unregistered-receiver failure is in the live-run log, on bob's order); live v2 mode was checked in a real browser by Claude Opus 5.5 on 2026-11-10 (not by a human); the `?offline=1` replay click-through and any human check are still open.
The 0.5 NEAR storage deposit is enough for the demo (a receipt cost 7.58e21 yocto and an order 2.46e21 yocto).

- Build: `npm run build:contract:v2` -> `contract-v2/res/bot_promises_v2.wasm` (see the table).
- Tests (run 2026-11-10 after the live run; counts updated where re-run on 2026-11-11): `npm run test:contract:v2` -> `127 passed` (re-run 2026-11-11); `npm run test:contract` (v1) ->
  `16 passed`; `npm run test:js` -> 239 tests, all passed (re-run 2026-11-11; in a sandbox the quoted glob of the npm script can exit 255 silently, then `node --test app/test/*.test.mjs` gives the same result); `npm run verify:fixtures` ->
  `ALL VERIFIED (7 real bundles + 3 tampered (correctly rejected) + 2 SIMULATED (fake key, not TEE evidence))`; `npm run verify:live-run` -> 81/81 transactions match the chain.
- NEP-141 bonds: a merchant adds a bond in an allowed token with `ft_transfer_call` and
  `{"add_bond":{}}`; the market credits `sender_id` only. The design text is the spec
  (`docs/STABLECOIN.md` sections 4-5). NEAR stays `token = null`.
- Per-bond money: every `(merchant, token)` pair is one bond, so a NEAR bond and a tUSDC bond never
  mix; orders and receipts record their token and pay out in it.
- Prepaid storage: `storage_deposit` / `storage_withdraw` / `storage_balance_of` (shaped like
  NEP-145, not the full interface). Every state-creating call measures `storage_usage` and charges the
  account that creates the state (the relayer's function-call key cannot attach a deposit). Calls
  that cannot pay panic with `ERR_STORAGE_BALANCE`; `ft_on_transfer` refunds instead of panicking.
- Namespaced ids: orders and receipts are keyed by `(merchant, id)` / `(merchant, response_hash)`, so
  one shop's order id or public receipt args cannot block another's.
- Expiry: `register_order(..., ttl_ms)` stores `expires_at_ms`; at or after it claim and receipt
  registration are refused, and anyone may call `release_expired` to free the reservation. The
  deployed contract's minimum TTL is 2 minutes (`min_order_ttl_ms 120000`, a demo setting) so L10 could be run live; the contract default TTL is
  30 days and the default minimum is 1 hour when `new` is called without `min_order_ttl_ms`.
- Payouts through callbacks: `claim` and `withdraw_bond` send the transfer and only change the books
  in the callback. A failed transfer puts the order back to `open` (or restores the bond) and the
  transaction still succeeds with `ok:false` / `ERR_PAYOUT_FAILED`; **a client must read `result.ok`,
  a successful transaction is not a successful payout**. The shopper retries the same claim after
  fixing the cause. No owner rescue method exists on purpose.
- NEP-145 registration (who must be registered on the token): the market contract, the merchant and
  the buyer. The operator registers the market once (runbook L1); the setup
  script checks that registration, then registers the merchant and the buyer, and `verify` prints a
  FAIL row when the market has no storage on an allowed token. The server hides a token order when
  its token metadata or the market registration check fails (the page never shows it as NEAR). A claim to an unregistered buyer fails safely and can
  be retried after registration. The page shows `register on tUSDC first` next to BINDING and does
  not block the Claim button.
- Allow-list trust: the token list is fixed at init (at most 8). A token that lies about balances,
  charges a fee on transfer, rebases or freezes accounts breaks the books; adding a token means a new
  deployment. The design's NEP-145 command hints and the exact v2 surface are in
  `docs/STABLECOIN.md`; `docs/CHANGE-REQUESTS.md` CR-4 lists every deliberate v1 -> v2 break.
- Build notes, the fail-without-feature spot checks, the deployment record and the live-run results
  are at the end of `docs/STABLECOIN.md`.
- Setting up a v2 demo without near-cli: `RUN=21 node app/scripts/demo-setup-v2.mjs` (tUSDC: market storage balance, bond by `ft_transfer_call`, shop and shopper on the token, orders `A123-21`/`A124-21`) or `RUN=22 ASSET=near node app/scripts/demo-setup-v2.mjs` (NEAR path); `DRY_RUN=1` prints the steps and reads no key; keys come from `.env` (`CBP_SHOP_ACCOUNT`/`CBP_SHOP_KEY`), parsed by the script and never printed; behind a proxy set `NODE_USE_ENV_PROXY=1`. `register_order` always attaches exactly 1 yoctoNEAR (the old 0-deposit overrides are gone). `app/scripts/live-v2.mjs` is the operator script that ran L1-L13 (it needs the app running for the chat steps).
- Recording a v2 run: `node app/scripts/record-transcript.mjs A123-nn A124-nn` (needs `MERCHANT_ID` in `.env`). Against a v2 contract it writes `fixtures/live/a123-v2.json`, `a124-v2.json`, `a123-v2-tampered.json` and
  `fixtures/replay/transcript-v2.json`, never the v1 files (the recorder marks the views it recomputes `computed: true`; record while the orders are still open to keep live ones; `node app/scripts/mark-computed-views.mjs <transcript>` marks older recordings) (`RECORD_SUFFIX=near` writes `...-v2-near...` files beside them); `npm run demo:replay:v2` replays it.

## Contract surface (v1, deployed)
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
| `claim(order_id, response_b64)` | change | the order's buyer | sha256 -> receipt -> token -> `min(bps, max_bps)` -> transfer |
| `get_owner, get_signer, get_signers, get_merchant, get_order, get_receipt, preview_claim` | view | anyone | reads, including the never-panicking `preview_claim` |

Errors are the frozen strings in `docs/plan/INTERFACES.md` section 6 (`ERR_BAD_SIGNATURE`, `ERR_NO_RECEIPT_FOR_BYTES`, `ERR_ALREADY_CLAIMED`, and so on). Every state change emits an `EVENT_JSON` log (NEP-297 shape) with standard `botpromise`.

### Contract surface (v2, deployed at `v2.cbp-sm1110.testnet`)
| Method | Kind | Who | Effect |
| --- | --- | --- | --- |
| `new(owner, allowed_tokens?, min_order_ttl_ms?)` | init | deployer | allow-list (<= 8, no duplicates) and the TTL floor; both arguments optional, so `{"owner":"x"}` works |
| `add_signer`, `remove_signer` | change | owner | unchanged, plus exactly 1 yoctoNEAR (`ERR_ONE_YOCTO`, live since the redeploy) |
| `register_merchant()` payable >= 1 NEAR | change | anyone once | creates the NEAR bond; the record's measured storage cost comes out of the deposit |
| `add_bond()` payable | change | merchant | NEAR bond top-up |
| `ft_on_transfer(sender_id, amount, msg)` | change | the token contract | the only token inflow; `{"add_bond":{}}`; anything else is refunded (`REFUND:*`) |
| `withdraw_bond(amount, token?)` | change | merchant | free part only, paid through a callback; needs exactly 1 yoctoNEAR |
| `register_order(order_id, buyer, amount, max_bps, token?, ttl_ms?)` | change | merchant | reserves in that token's bond; `expires_at_ms`; needs exactly 1 yoctoNEAR |
| `release_expired(merchant, order_id)` | change | anyone | frees an expired reservation, emits `order_expired` |
| `register_receipt(order_id, signed_text, signature_hex, signer_public_key_hex)` | change | the order's merchant | same frozen checks; keyed by `(merchant, response_hash)`; refused for settled/expired orders |
| `claim(merchant, order_id, response_b64)` | change | the order's buyer | pays through `ft_transfer`/transfer + `on_claim_paid`; `ok:false` on a failed payout |
| `storage_deposit`, `storage_withdraw`, `storage_balance_of` | change/view | anyone / the account | prepaid storage, shaped like NEP-145; `storage_withdraw` needs exactly 1 yoctoNEAR |
| `on_claim_paid`, `on_withdraw_resolved` | callback | the contract itself | book changes after the transfer result; never panic on a failed transfer |
| views | view | anyone | `get_config` (api 2), `get_bond(s)`, `get_merchant` (v1 shape), `get_order(merchant, id)`, `get_receipt(merchant, hash)`, `preview_claim(merchant, id, b64)` |

Errors: the v1 strings plus `ERR_TOKEN_LIST`, `ERR_TTL`, `ERR_TOKEN_NOT_ALLOWED`, `ERR_NO_BOND`,
`ERR_LIABILITY_ZERO`, `ERR_STORAGE_BALANCE`, `ERR_ORDER_NOT_OPEN`, `ERR_ORDER_EXPIRED`,
`ERR_ORDER_NOT_EXPIRED`, `ERR_CLAIM_IN_PROGRESS`, `ERR_PAYOUT_ZERO`, `ERR_PAYOUT_FAILED` (callback
value, not a panic), `ERR_CALLBACK_STATE`, `ERR_NOT_ENOUGH_GAS`, `ERR_NOT_PRIVATE`. Events are
`botpromise` version `1.1.0` and every event carries `token` (`null` for NEAR).

## Data in this repository
- `fixtures/live/spike-s1.json` - the first live `provider_tee` ed25519 signature (Spike S1), registered on testnet.
- `fixtures/live/a123.json` - honest reply `PROMISE|refund|order=A123-11|bps=2000`, register tx `ANGY8bVshxV16ovVNG4gHpbmAnSymrF9SqM8DtqTBjpv`.
- `fixtures/live/a124.json` - injection reply `PROMISE|refund|order=A124-11|bps=10000`; the contract paid the 30% cap.
- `fixtures/live/a123-tampered.json` - the same reply with `2000` edited to `3000`; must fail every check.
- `fixtures/simulated/honest.json`, `fixtures/simulated/injection.json` - SIMULATED bundles signed with the fake ed25519 key whose seed is `0x01` repeated 32 times; they are labelled SIMULATED in every UI.
- `fixtures/attestation/z-ai_glm-5.3-flash-ed25519-2026-11-10.json` - the first attestation record (sha256 `dce1c116…2365`), registered for the recorded run.
- `fixtures/attestation/z-ai_glm-5.3-flash-ed25519-2026-11-10-renewed.json` - the renewal record (sha256 `520bedd1…6a65`), registered on 2026-11-10 10:45 UTC with a 20-day validity; this is the one `get_signers` shows now.
- `fixtures/replay/transcript.json` - the `replay/v1` transcript of the recorded run.
- `fixtures/live/a123-v2.json`, `a124-v2.json`, `a123-v2-tampered.json` and `fixtures/replay/transcript-v2.json` - the v2 tUSDC run (orders A123-23 honest, A124-21 injection capped), `fixtures/live/a123-v2-near.json`, `a124-v2-near.json`, `a123-v2-near-tampered.json` and `fixtures/replay/transcript-v2-near.json` - the NEAR regression run on v2 (A123-22, A124-22). Verify with `--merchant cbp-shop-sm1110.testnet`.
- `fixtures/runs/v2-live-run.json` - all 81 transactions of the v2 live run L1-L14 (not the later browser session, see `docs/build-log.md`) (arguments, result, gas burnt per receipt, logs) and the 128 checks; `npm run verify:live-run` replays it against the chain.
