# Contract v2: stablecoin (NEP-141) support - design

Status: **implemented in `contract-v2/` and the client, deployed on testnet** as `v2.cbp-sm1110.testnet` with the mock token `sm1110-tusdc.testnet` (2026-11-10; section 19), redeployed in place with the 1-yocto fix (section 21), and **the live flows L1-L14 were run and recorded on 2026-11-10** (section 21; L4(b) was not run). The gas constants were measured and kept (section 7 and 21).

Written by Claude Sonnet 5.5 (design). The build is meant for DeepSeek V4.1 Flash, with Claude Sonnet 5.5 reviewing and fixing, and Claude Opus 5.5 doing the final review and the testnet deploys as operator. `docs/plan/` is the locked original plan and is not edited; this file is the interface spec for v2, and the deviations from `docs/plan/INTERFACES.md` are listed in section 13 (to be copied into `docs/CHANGE-REQUESTS.md` as CR-4 when the build starts).

What was read for this design: `README.md`, `docs/runbook.md`, `docs/CHANGE-REQUESTS.md`, `contract/src/lib.rs` and `tests.rs`, `app/lib/relayer.mjs`, `app/lib/near.mjs`, `app/server.mjs`, `app/lib/promise.mjs`, `web/app.js`, `web/index.html`, the scripts that call the contract, `docs/plan/INTERFACES.md` (sections 2-6), and the mock token at `../test-usdc` (NEP-141 + NEP-145 + NEP-148, `decimals = 6`, symbol `tUSDC`).

## 1. Scope

In scope:

1. NEP-141 bonds. A merchant can add a bond in an allowed token with `ft_transfer_call`. Promises (orders) and receipts record the token and amount. Claims pay out in the bond's token.
2. Payouts that can fail safely: every outgoing transfer (token or NEAR) has a callback that puts the books back if the transfer failed, so the user can retry.
3. The three limits the README lists as code problems: storage deposit accounting (whoever creates state pays), a per-merchant order-id namespace, and order expiry that releases an unclaimed reservation back to the bond.
4. A new contract account. The v1 deployment stays as history.

Out of scope (unchanged from v1): on-chain TDX verification, other promise kinds, disputes, wallet login, mainnet. No NEAR Intents.

## 2. Accounts, versions, migration

| Item | v1 (history, stays as is) | v2 (this design) |
| --- | --- | --- |
| Contract | `cbp-sm1110.testnet`, wasm sha256 `c4d88ead…8941`, source in `contract/` | `v2.cbp-sm1110.testnet`, source in `contract-v2/` |
| Owner | itself | itself (`v2.cbp-sm1110.testnet`), same trust model and same README caveat about the full-access key |
| Merchant | `cbp-shop-sm1110.testnet` | same account, registered again on v2 (state is per contract) |
| Buyer | `cbp-alice-sm1110.testnet` | same account |
| Second buyer, for failure tests | - | `cbp-bob-sm1110.testnet`, **never registered on the token** until a test does it (operator creates it) |
| Token | - | `$TOKEN_ID`, the shared mock tUSDC; the operator gives the account id later |
| Function-call keys | scoped to `cbp-sm1110.testnet` | new key pairs scoped to `v2.cbp-sm1110.testnet` (merchant: `register_receipt`; buyer: `claim`). A key can have only one permission per account, so the v1 keys are left in place and the new ones are different keys |

Decisions:

- **No state migration and no `migrate` method.** v2 starts empty. v1 merchants, orders, receipts and the claimed history stay on v1, and v1 keeps working. `contract/` (v1 source and its 16 tests) is **not touched**: v2 lives in a new crate `contract-v2/` so the v1 wasm stays reproducible and no v1 test is edited. `parse.rs` and `ecdsa.rs` are copied byte for byte (the build step checks with `cmp`).
- **Sub-account creation.** `v2.cbp-sm1110.testnet` can only be created by `cbp-sm1110.testnet`. That account's balance backs the v1 bonds, so the operator creates the sub-account with a small deposit (0.2 NEAR) and funds the real storage cost (about 6 NEAR for wasm plus a buffer, *tune*) from the merchant account or another operator account, never from the v1 contract's own free balance. If the operator cannot do this, the fallback is a faucet-created top-level account such as `cbp2-sm1110.testnet`, and every id in this file is then replaced by it.
- **Init.** `new(owner, allowed_tokens, min_order_ttl_ms)`. The testnet deploy passes `[$TOKEN_ID]` and a `min_order_ttl_ms` of 120000 (2 minutes) so expiry can be recorded live. The README must say the 2 minute minimum is a demo setting; the contract default is 1 hour.
- **The TEE signer** is registered again on v2 with `add_signer` (a new contract has an empty signer list). The operator re-runs `npm run attest` for a fresh record or reuses `fixtures/attestation/z-ai_glm-5.3-flash-ed25519-2026-11-10-renewed.json` if its hash is still the right evidence; either way `expires_at_ms` must be after the judging window.
- **The client works against both versions.** `npm run verify` must keep verifying the committed v1 fixtures against `cbp-sm1110.testnet` (the judge dry run depends on it). The client detects the version by calling the new view `get_config` and treats a `MethodNotFound` error as v1; any other error is raised, never read as v1 (section 10).

## 3. Contract v2: state

```text
Contract {
  owner: AccountId,
  allowed_tokens: Vec<AccountId>,        // fixed at init, at most 8, no duplicates, never changes
  min_order_ttl_ms: u64,                 // fixed at init
  signers:   IterableMap<String, SignerInfo>,            // unchanged
  bonds:     LookupMap<(AccountId, Option<AccountId>), Bond>,   // (merchant, token); None = NEAR
  orders:    LookupMap<(AccountId, String), Order>,             // (merchant, order_id)
  receipts:  LookupMap<(AccountId, String), Receipt>,           // (merchant, response_hash)
  storage:   LookupMap<AccountId, U128>,                        // prepaid storage balance (section 6)
}
Bond    { token: Option<AccountId>, bond: U128, reserved: U128, paid_out: U128 }
Order   { ...v1 fields..., token: Option<AccountId>, expires_at_ms: U64 }   // status: open | paying | claimed | expired
Receipt { ...v1 fields..., token: Option<AccountId>, order_amount: U128 }
```

- `token: None` means NEAR, in storage and in JSON (`null`). The text `"near"` is not used because `near` is a valid account id.
- **The token kind is fixed per bond, per order and per receipt.** A bond is one `(merchant, token)` pair, so a merchant can hold a NEAR bond and a tUSDC bond side by side, and they never mix. `register_order` picks the bond with its `token` argument and stores that token on the order; the receipt copies it. `amount`, `liability` and every payout are raw `u128` in that token's smallest unit.
- Bond records are never deleted (not even at zero). So there is no storage refund logic, and the callbacks always find the record.
- Storage keys: a new `StorageKey` enum with new prefixes. v2 never reads v1 state.
- Receipts move to `(merchant, response_hash)`. This also removes the v1 case where another merchant copies the public `register_receipt` args and blocks the reply for good: it now only fills that other merchant's own namespace. A receipt filed under the wrong order by the same merchant still blocks that reply (`ERR_RECEIPT_EXISTS`, unchanged limit, stays in the README).

## 4. Contract v2: methods

Prepaid gas stays 100 Tgas for the existing calls. "Compatible" means same name, same arguments, same errors as v1 unless the line says otherwise.

| Method | Kind | Who | Change from v1 |
| --- | --- | --- | --- |
| `new(owner, allowed_tokens: Option<Vec<AccountId>>, min_order_ttl_ms: Option<U64>)` | init | deployer | Both new arguments are optional, so `{"owner":"x"}` still works (no tokens, 1 hour minimum TTL). Panics: `ERR_TOKEN_LIST` (duplicate, more than 8), `ERR_TTL` (zero or above the max). |
| `add_signer`, `remove_signer` | change | owner | None in the interface; final review F1 (section 20) now also requires exactly 1 yoctoNEAR. |
| `register_merchant()` payable >= 1 NEAR | change | anyone, once | Creates the **NEAR** bond. The storage cost of the new record is taken from the attached deposit: `bond = deposit - storage cost`, and the 1 NEAR minimum applies to that `bond`. |
| `add_bond()` payable | change | merchant | NEAR bond only, as before (needs a NEAR bond, else `ERR_NOT_MERCHANT`). |
| `ft_on_transfer(sender_id, amount, msg) -> PromiseOrValue<U128>` | change | the token contract | **New.** The only way tokens come in (section 5). |
| `withdraw_bond(amount, token: Option<AccountId>)` | change | merchant | `token` is optional, `None` = NEAR, so v1 calls work. Pays out with a callback (section 7). Final review F1: needs exactly 1 yoctoNEAR (section 20). |
| `register_order(order_id, buyer, amount, max_bps, token: Option<AccountId>, ttl_ms: Option<U64>)` | change | merchant | Two optional arguments. Key is `(merchant, order_id)`. New checks below. Final review F1: needs exactly 1 yoctoNEAR (section 20). |
| `release_expired(merchant, order_id)` | change | anyone | **New.** Releases the reservation of an expired order (section 8). |
| `register_receipt(order_id, signed_text, signature_hex, signer_public_key_hex)` | change | the order's merchant | Same arguments. The order is looked up as `(caller, order_id)`. New checks below. |
| `claim(merchant, order_id, response_b64)` | change | the order's buyer | **Gains `merchant`** (required, because order ids are per merchant). Pays through a callback (section 7). |
| `storage_deposit(account_id: Option<AccountId>)` payable, `storage_withdraw(amount: Option<U128>)`, `storage_balance_of(account_id)` | change/view | anyone / the account | **New** (section 6). Shaped like NEP-145; the design does not claim full NEP-145 compliance. |
| `on_claim_paid(...)`, `on_withdraw_resolved(...)` | callback | the contract itself (`#[private]`) | **New** (section 7). |
| `get_owner`, `get_signer`, `get_signers` | view | anyone | none |
| `get_merchant(merchant)` | view | anyone | Returns the NEAR bond in the v1 shape `{bond, reserved, paid_out}`, so old readers still work. |
| `get_bond(merchant, token: Option<AccountId>)` / `get_bonds(merchant)` | view | anyone | **New.** `get_bonds` lists the NEAR bond and one entry for each allowed token that exists. |
| `get_order(merchant, order_id)` | view | anyone | **Gains `merchant`.** Result has `token`, `expires_at_ms`. |
| `get_receipt(merchant, response_hash)` | view | anyone | **Gains `merchant`.** Result has `token`, `order_amount`. |
| `preview_claim(merchant, order_id, response_b64)` | view | anyone | **Gains `merchant`.** Result has `token`. Never panics. |
| `get_config()` | view | anyone | **New.** `{ "api": 2, "owner", "allowed_tokens", "min_order_ttl_ms", "max_order_ttl_ms", "default_order_ttl_ms" }`. Used by clients to tell v2 from v1. |

`register_order` checks, in this order: `ERR_ORDER_ID`, `ERR_MAX_BPS`, `ERR_AMOUNT`; `ERR_TOKEN_NOT_ALLOWED` (a `Some` token that is not in the list); `ERR_TTL` (`ttl_ms` below `min_order_ttl_ms` or above 365 days; default 30 days); `ERR_ORDER_EXISTS` for `(merchant, order_id)` only; `ERR_NOT_MERCHANT` (no bond for that `(merchant, token)`); `liability = amount * max_bps / 10000` with checked arithmetic (`ERR_AMOUNT` on overflow) and **`ERR_LIABILITY_ZERO`** when it is 0 (closes the v1 "liability rounds to 0" spam case); `ERR_INSUFFICIENT_FREE_BOND`; then the storage charge (`ERR_STORAGE_BALANCE`).

`register_receipt` extra checks: the order must be `open` (`ERR_ORDER_NOT_OPEN`) and not past `expires_at_ms` (`ERR_ORDER_EXPIRED`), so no state is stored for settled orders. The receipt's storage is charged to the merchant (section 6). A shopper or any other account calling it gets `ERR_NO_ORDER` (it has no order under its own name); `ERR_NOT_ORDER_MERCHANT` is no longer reachable and is dropped from the v2 list.

Claim arithmetic is unchanged (`paid_bps = min(token_bps, max_bps)`, `payout = amount * paid_bps / 10000`, checked) with one addition: a payout of 0 gives `ERR_PAYOUT_ZERO` and nothing moves, because `ft_transfer` of 0 panics and would make the claim fail for ever.

`ClaimPreview` gets `token: Option<AccountId>`. The status check order in the shared `evaluate` function is: `claimed` -> `ERR_ALREADY_CLAIMED`; `paying` -> `ERR_CLAIM_IN_PROGRESS`; `expired` or `now >= expires_at_ms` -> `ERR_ORDER_EXPIRED`; then the v1 order (receipt, receipt order, JSON, token, token order) and `ERR_PAYOUT_ZERO`.

## 5. Incoming tokens: `ft_on_transfer`

```text
ft_on_transfer(sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128>   // returns the UNUSED amount
msg for a bond deposit:  {"add_bond":{}}
```

Rules:

1. `token = env::predecessor_account_id()`. If `token` is not in `allowed_tokens`, return the full `amount` and change nothing. This also covers a user calling `ft_on_transfer` directly: they are not an allowed token, so nothing is credited.
2. `sender_id` and `amount` come only from the function arguments (which only the token contract can supply, by rule 1). The msg is parsed into `enum FtMsg { AddBond {} }` with `deny_unknown_fields` on the variant. A msg that carries its own `sender_id`, `amount`, `merchant` or any other field is therefore "unexpected" and is returned. The bond is always credited to `sender_id`; nobody can fund a bond that belongs to someone else.
3. Anything unexpected returns the full amount, never a panic: unparseable msg, empty msg, unknown variant, msg longer than 256 bytes, `amount == 0`, bond overflow (`checked_add`), or no storage balance for a new bond record. For each case the contract writes a plain log line `REFUND:<reason>` (not an `EVENT_JSON` line) with one of `TOKEN_NOT_ALLOWED`, `BAD_MSG`, `ZERO_AMOUNT`, `OVERFLOW`, `NO_STORAGE`.
4. On success: `bonds[(sender_id, Some(token))].bond += amount`; if the record is new, its storage is charged to `sender_id`'s storage balance (section 6); return `0`; event `bond_added` with `token`.
5. Deposits never touch another token's bond or the NEAR bond.

The contract has no `ft_on_transfer` path that can reach `register_order`, `claim` or any other method. A new purpose needs a new msg variant and a new design.

Accepted risk, to be written in the README: the allow-list is trusted. A token that lies about balances, charges a fee on transfer, rebases or can freeze accounts breaks the books. The allow-list is fixed at init, so adding a token means a new deployment. This is fine for tUSDC (mock) and native USDC.

## 6. Storage deposit accounting

**Rule: whoever creates state pays for it, from their own money, measured, not estimated.**

- Each account that creates orders or receipts keeps a prepaid **storage balance** in the contract: `storage_deposit(account_id?)` (payable, anyone may fund anyone), `storage_withdraw(amount?)` (the account, only the `available` part; final review F1 (section 20) now requires exactly 1 yoctoNEAR, the first design did not), `storage_balance_of(account_id) -> {total, available} | null`. The first deposit pays for its own record, so `total` is the deposit minus that cost.
- Why a prepaid balance and not an attached deposit: the relayer's key is a function-call key and a function-call key cannot attach a deposit, and `ft_on_transfer` carries tokens, not NEAR. A prepaid balance is the only way the relayer can create receipts and the only way a first token bond can pay for its record.
- Every state-creating call measures `env::storage_usage()` before and after, and charges `(after - before) * env::storage_byte_cost()` to the right account:

| Call | Creates | Charged to | Source of the money |
| --- | --- | --- | --- |
| `register_merchant` | NEAR bond record | the merchant | the attached deposit (so the bond is smaller by that amount) |
| `ft_on_transfer` add_bond, first time | token bond record | `sender_id` | storage balance; if short, the deposit is returned (rule 3 above) |
| `register_order` | order | the merchant | storage balance |
| `register_receipt` | receipt | the merchant (the caller) | storage balance |
| `storage_deposit`, first time | storage record | the account | the deposit itself |

- If the balance is short, change calls panic with `ERR_STORAGE_BALANCE` and nothing is stored (the panic reverts the call). `ft_on_transfer` cannot panic, so it inserts the record, flushes, measures, and removes the record again (flush again) when the balance is short, then returns the full amount.
- **Implementation trap:** `near_sdk::store` collections cache writes and write them to storage only on `flush()` or when dropped. `env::storage_usage()` is wrong until the touched map is flushed. Every measurement must call `.flush()` on the changed map first. A unit test pins exact charges (section 11, group E) so this cannot regress silently.
- Nothing is ever deleted (receipts and orders stay), so there is no refund path and the storage balance only goes down, apart from `storage_withdraw` of the unused part.
- Invariant, with a test: the contract's own free NEAR (the operator's buffer for code storage) never pays for user state. Every byte added by a user call is covered by a matching decrease of that user's storage balance or deposit.
- The v1 "R4 buffer" (3 NEAR beyond bonds) is no longer needed for user state. The contract still needs its code storage and a few yoctoNEAR per `ft_transfer` (1 yoctoNEAR is attached to each outgoing token transfer and comes from the contract's own balance).
- Client rule: before creating orders the shop's setup checks `storage_balance_of(merchant).available` against `receipts_per_order * measured receipt cost`; the demo setup deposits 0.5 NEAR (*tune* from the measured live cost; a receipt is about 1 KB, which is about 0.01 NEAR at 10^19 yocto per byte).

## 7. Outgoing transfers and callbacks

Every outgoing transfer, token or NEAR, is a promise with a callback, and money records change **only in the callback**, once the result is known.

Gas constants: `GAS_FT_TRANSFER = 20 Tgas`, `GAS_CALLBACK = 15 Tgas`. **Measured live (section 21): a paid tUSDC claim burns 2.7 Tgas in `claim`, 1.8 Tgas in `ft_transfer`, 2.2 Tgas in `on_claim_paid` (failed payout 2.7 / 1.5 / 1.8); `withdraw_bond` 2.5 / 1.8 / 1.6. Kept as they are: they are budgets, unused gas is refunded.** `claim` and `withdraw_bond` panic with `ERR_NOT_ENOUGH_GAS` before touching state when `prepaid_gas - used_gas < GAS_FT_TRANSFER + GAS_CALLBACK + 10 Tgas`. The client keeps 100 Tgas.

Token transfer: `ft_transfer(receiver_id, amount, memo = None)` on the token contract with **exactly 1 yoctoNEAR** attached, `.then(callback)`. NEAR transfer: `Promise::transfer(...)`, `.then(callback)`. Both always have the `then()`.

### Claim

1. `claim(merchant, order_id, response_b64)`: buyer only (`ERR_NOT_BUYER`), run `evaluate`. Panic on any error (as v1).
2. Set `order.status = "paying"`. **Do not change `bond`, `reserved` or `paid_out` yet.** The reservation stays in place, so the shop cannot withdraw it and the claim can be put back. While `paying`: `claim` gives `ERR_CLAIM_IN_PROGRESS`, `release_expired` gives `ERR_CLAIM_IN_PROGRESS`.
3. Send the transfer (to `order.buyer`, `payout`, in the order's token) and `.then(on_claim_paid(merchant, order_id, payout, token_bps, paid_bps, response_hash))`. `claim` returns that promise, so the transaction's final value is the callback's value.
4. `on_claim_paid` (`#[private]`, never panics on a failed transfer):
   - If the order is not `paying`, do nothing and return `ok:false, error:"ERR_CALLBACK_STATE"` (no double debit if a callback is ever replayed).
   - **Transfer succeeded:** `reserved -= liability`, `bond -= payout`, `paid_out += payout`, status `claimed`, `paid`, `paid_bps` set, then emit `promise_claimed` (with `token`). Return `ClaimPreview{ok:true,...}`.
   - **Transfer failed** (receiver not registered on the token, closed NEAR account, token paused): status back to `open`; `bond`, `reserved` and `paid_out` are exactly as before the claim. Write the plain log `PAYOUT_FAILED:<order_id>` (not an `EVENT_JSON` line). Return `ClaimPreview{ok:false, error:"ERR_PAYOUT_FAILED", ...}`.
5. The transaction as a whole succeeds in both cases (the callback does not panic, so its state change is kept). **A client must read `result.ok`**; a successful transaction status is not a successful payout. The shopper retries the same `claim` after fixing the cause (registering on the token), as long as the order has not expired.
6. Money moves only in the callback, so `promise_claimed` exists only for payouts that really happened (events only for succeeded transfers).

### Withdraw

`withdraw_bond(amount, token?)`: `0 < amount <= bond - reserved` (`ERR_WITHDRAW_EXCEEDS_FREE_BOND`), `ERR_NO_BOND` if the record does not exist. Debit `bond` now (so two quick calls cannot double spend), send the transfer, `.then(on_withdraw_resolved(merchant, token, amount))`. On success emit `bond_withdrawn`. On failure re-credit `bond += amount`, log `WITHDRAW_FAILED:<token>` (plain log), no event. The v1 `bond_withdrawn` event moves from "before the transfer" to "after it succeeded".

### Residual risk

If a callback ever ran out of gas, an order would stay `paying`. The gas guard above and a unit test on the guard make this unlikely; there is no owner rescue method on purpose (the owner must not be able to touch money). The README should say so.

## 8. Order expiry

- `register_order` stores `expires_at_ms = now + ttl_ms`. It is part of the order the shopper can read (`get_order`), and the client shows it in the order label and a countdown.
- At or after `expires_at_ms`: `claim` and `preview_claim` return `ERR_ORDER_EXPIRED`, and `register_receipt` is refused (`ERR_ORDER_EXPIRED`). The boundary is `now >= expires_at_ms`, so there is no overlap.
- `release_expired(merchant, order_id)`: **anyone** may call it (the effect is fixed by the rules, so no permission is needed, and an automatic keeper bot can call it). Checks: order exists (`ERR_NO_ORDER`); status `open` (`ERR_ORDER_NOT_OPEN` for claimed or already expired, `ERR_CLAIM_IN_PROGRESS` for paying); `now >= expires_at_ms` (`ERR_ORDER_NOT_EXPIRED`). Effect: `reserved -= liability` in that order's token bond, status `expired`, event `order_expired {order_id, merchant, token, released}`. The released amount is free bond again and can be withdrawn.
- Buyer protection is the TTL: the merchant chooses it, but it cannot be below the contract's `min_order_ttl_ms`, it is visible before the shopper pays attention to the promise, and the relayer's receipt registration is refused once expired. The UI shows the remaining time next to BINDING, and shows `EXPIRED` in the badge after the fact. A promise that was never claimed before its expiry is gone; this is the intended trade (the shop's bond is not locked for ever) and goes into the README.
- A failed payout puts the order back to `open`. If that happens after `expires_at_ms`, the order can be released at once and the shopper can no longer claim. The client therefore warns when `payout failed` and fewer than 10 minutes remain.

## 9. NEP-145 registration: who registers whom on the token

NEP-141 tokens (including tUSDC) refuse `ft_transfer` and `ft_transfer_call` to an account that has no storage on the token. This is the main way a payout fails.

| Account | Must be registered on the token | Who pays and when | What the client does |
| --- | --- | --- | --- |
| The market contract `v2.cbp-sm1110.testnet` | Yes, to receive bonds | Operator, once, right after deploy: `storage_deposit {account_id: <market>, registration_only: true}` with about 0.00125 NEAR (the mock's value; read `storage_balance_bounds` from the token for the real number) | `setup` and `verify` read `storage_balance_of(market)` on the token and stop with a clear message if it is null. The web page hides token orders when the config check fails |
| Merchant | Yes, it holds the tokens it deposits, and needs it for withdrawals | The merchant, before the first deposit (it cannot hold tokens otherwise) | Setup checks it. A failed withdrawal shows `ERR_WITHDRAW_FAILED` text and the bond is restored |
| Buyer (shopper) | Yes, to receive a claim | The buyer, or the merchant/operator on the buyer's behalf. The demo setup registers the buyer when it creates the orders (the merchant's own money, which is the "whoever benefits pays" rule for the shop) | Before showing Claim, the client calls `storage_balance_of(buyer)` on the token. If null: the badge keeps BINDING but adds `register on tUSDC first`, with the exact `storage_deposit` command. The client does **not** block the claim button: the contract cannot know, and a failed claim is safe |
| Relayer / keys | n/a | n/a | The relayer's function-call key cannot attach a deposit, so it cannot register anyone. Setup uses the full-access keys in `~/.near-credentials` through near-cli, never the relayer |

A claim to an unregistered buyer returns `ERR_PAYOUT_FAILED`, leaves the order `open` with the bond unchanged, and can be repeated after registration. That is test L7 in section 12.

## 10. Decimals and amounts in the client

- On chain every amount is a raw `u128` as a decimal string. Nothing on chain knows decimals.
- A new `app/lib/amount.mjs` has `formatAmount(raw, decimals, {maxFraction})` and `parseAmount(text, decimals)`, both BigInt only (no `Number`), exported also to `web/app.js` (the web page cannot import from `app/`: the file will be served or copied under `web/`, decided at build time, with a test that both copies are identical or that one file is served at both paths).
- `decimals` and `symbol` come from the token's `ft_metadata` (NEP-148), read once per token over RPC and cached; `/api/config` returns `tokens: [{id, symbol, decimals}]` for every token in the contract's `get_config().allowed_tokens`. The client rejects a token whose `decimals` is not an integer 0..=36.
- NEAR keeps its present display (`yoctoToNear`, 3 decimals) so the v1 replay and every v1 test stay as they are. tUSDC shows as `4 tUSDC` / `0.000001 tUSDC`; trailing zeros are removed.
- The bot prompt carries the order total in the order's currency. For a NEAR order the system prompt bytes stay **identical** to today (the S1 request hash is pinned by `app/test/prompt.test.mjs`); for a token order it says `total 20 tUSDC`. The promise token grammar `PROMISE|refund|order=...|bps=...` does not change, because it carries a ratio, not an amount.

## 11. Rust test list (`contract-v2/src/tests.rs`)

Rules: no v1 test is deleted or loosened. All 16 v1 tests are carried over: the 12 in `tests.rs` are ported with the same assertions, the 4 in `parse.rs` come with the copied file. The only change is the new argument (`claim(merchant, ...)`, `get_order(merchant, ...)` and so on, and `ERR_NO_ORDER` instead of `ERR_NOT_ORDER_MERCHANT` in the shopper-registers-receipt test, with the reason written in a comment). The v1 crate keeps running its own 16. Every new test below must fail on the code that does not have the feature (the build step checks this by temporarily removing the feature or its guard, and records which tests failed).

Callbacks are tested by calling `on_claim_paid` / `on_withdraw_resolved` directly after `testing_env!` with the promise result set to `Successful` or `Failed` (the builder confirms the exact macro form for near-sdk 5.30.1) and with the predecessor equal to the contract. Outgoing promises are checked with `get_created_receipts()` (action type, receiver, method, args, deposit, gas).

**A. Ported v1 tests (12 from `tests.rs` + 4 from `parse.rs` = 16):** `honest_claim_pays_20_percent`, `injection_is_clipped_to_max_bps`, `tampered_bytes_have_no_receipt`, `receipt_for_other_order_rejected`, `edited_signed_text_fails_signature`, `shopper_cannot_register_receipt`, `only_buyer_can_claim`, `reserved_bond_cannot_be_withdrawn`, `expired_signer_rejected`, `real_near_ai_ed25519_receipt_registers`, `real_near_ai_one_changed_byte_has_no_receipt`, `real_near_ai_receipt_with_edited_hash_fails`, plus the 4 tests in `parse.rs` (copied file, copied tests). That is the 16 of the v1 run (12 in `tests.rs`, 4 in `parse.rs`); the one test in `ecdsa.rs` only builds with the `ecdsa` feature, is not in the 16, and is copied with its file. The two claim tests now run the callback with `Successful` before asserting bond and reserved.

**B. Init and allow-list**
1. `new` without tokens: NEAR flow works, `get_config().allowed_tokens` is empty.
2. `new` with `[tusdc.testnet]`: stored and returned.
3. Duplicate token and 9 tokens: `ERR_TOKEN_LIST`.
4. `min_order_ttl_ms` zero or above the max: `ERR_TTL`.
5. `get_config` has `api == 2`.

**C. `ft_on_transfer` (all with a registered storage balance unless the test says otherwise)**
1. Valid `{"add_bond":{}}` from the allowed token: creates the bond for `sender_id`, returns `0`, emits `bond_added` with the token.
2. A second deposit adds to the bond; `reserved` and `paid_out` stay.
3. **Wrong token:** the predecessor is `evil.testnet`, not in the list: returns the full amount, no state change (`storage_usage` equal before and after), no event.
4. **Direct call by a user:** predecessor `mallory.testnet` calls `ft_on_transfer("victim.testnet", 1000, ...)`: full refund, no bond for anyone.
5. **Wrong msg**, each returns the full amount and changes nothing: empty string, `not json`, `{}`, `{"pay_invoice":{}}`, `{"add_bond":1}`, `{"add_bond":{},"x":1}`, a 300 byte msg.
6. **Msg cannot choose the beneficiary or the amount:** `{"add_bond":{"sender_id":"victim.testnet","amount":"999"}}` and `{"add_bond":{"merchant":"victim.testnet"}}` are refused (unknown fields); and a valid msg credits `sender_id` and the `amount` argument.
7. `amount == 0`: returns `0`, no bond record created.
8. No storage balance for a first deposit: full refund, and `storage_usage` is exactly what it was (the insert is undone).
9. Overflow (`bond` near `u128::MAX` plus another deposit): full refund, bond unchanged.
10. Two allowed tokens: separate bonds; a deposit in one does not change the other or the NEAR bond.
11. `get_bonds` lists the NEAR bond and each existing token bond, and nothing for a token never deposited.

**D. Orders with tokens**
1. `register_order` with an unlisted token: `ERR_TOKEN_NOT_ALLOWED`.
2. No bond for that token: `ERR_NOT_MERCHANT`.
3. Reserves only in the chosen token's bond; the NEAR bond's `reserved` stays 0.
4. `ERR_INSUFFICIENT_FREE_BOND` is judged against the token bond, not the NEAR bond.
5. The order and the receipt both store `token` and `amount` (`order_amount`), and `register_order`'s event carries them.
6. NEAR order and tUSDC order for the same merchant at the same time keep separate `reserved`.
7. `liability` of 0 (amount 1, max_bps 1): `ERR_LIABILITY_ZERO`.
8. `amount * max_bps` overflow: `ERR_AMOUNT`, no panic from arithmetic.
9. Existing v1 NEAR call `register_order(order_id, buyer, amount, max_bps)` (no new arguments) works and uses the default TTL.
10. `register_receipt` for a `claimed`, `paying` or `expired` order: `ERR_ORDER_NOT_OPEN` / `ERR_ORDER_EXPIRED`.

**E. Storage accounting**
1. `storage_deposit` credits `total = deposit - own record cost`; `storage_balance_of` for an unknown account is null.
2. A third party can fund a merchant's balance.
3. `register_order` lowers `available` by exactly `(storage_usage_after - storage_usage_before) * storage_byte_cost` (pins the flush trap).
4. `register_receipt` does the same and charges the merchant, not the contract.
5. Short balance: `register_order` and `register_receipt` panic with `ERR_STORAGE_BALANCE` and the state is unchanged (`storage_usage` equal, no reservation).
6. `storage_withdraw` above `available`: panic; exactly `available`: works; the used part stays.
7. `register_merchant`: `bond = deposit - cost of the record`; a deposit of exactly 1 NEAR now fails with `ERR_BOND_TOO_SMALL` because the record cost comes out of it (documented difference, pins the rule).
8. Spam loop: with `available` for 5 orders, order 6 fails, and the sum of all decreases equals the sum of all `storage_usage` growth times the byte cost. The contract's own balance accounting (`account_balance` minus the sum of bonds minus the sum of storage balances) does not shrink beyond code storage.
9. First token bond record charged to `sender_id` only.

**F. Order-id namespace**
1. Two merchants register the same `order_id`: both succeed, separate `reserved`.
2. A merchant registers an id that another merchant already took: no `ERR_ORDER_EXISTS` (the v1 squatting case).
3. The same merchant registering the same id twice: `ERR_ORDER_EXISTS`.
4. A receipt registered by merchant A (same response hash) does not satisfy a claim on merchant B's order: `ERR_NO_RECEIPT_FOR_BYTES`; and B registering the same signed text works (`(merchant, hash)` key), so a copy of A's public args cannot block B.
5. `claim` with the wrong `merchant` argument: `ERR_NO_ORDER`; the buyer of A's order cannot claim B's order with the same id.
6. `register_receipt` by a non-merchant: `ERR_NO_ORDER`.

**G. Expiry**
1. Default TTL is 30 days, a custom `ttl_ms` is stored, below `min_order_ttl_ms` and above 365 days give `ERR_TTL`.
2. Claim before expiry works; at exactly `expires_at_ms` it gives `ERR_ORDER_EXPIRED`; `preview_claim` says the same; `register_receipt` after expiry is refused.
3. `release_expired` before expiry: `ERR_ORDER_NOT_EXPIRED`.
4. After expiry, called by a third account: `reserved` falls by `liability` in the right token bond only, status `expired`, one `order_expired` event, and `withdraw_bond` can now take the released amount.
5. Second release: `ERR_ORDER_NOT_OPEN`. Release of a claimed order: `ERR_ORDER_NOT_OPEN`. Release of a `paying` order: `ERR_CLAIM_IN_PROGRESS`.
6. A claimed order's reservation is not released twice (`reserved` never goes below 0; test with checked arithmetic).

**H. Claim and payout**
1. Token order: `claim` creates exactly one `ft_transfer` receipt to the token contract, args `receiver_id == buyer`, `amount == payout`, deposit `1`, gas `GAS_FT_TRANSFER`, followed by a callback with `GAS_CALLBACK`. State right after the claim: status `paying`, `bond`, `reserved`, `paid_out` unchanged, **no `promise_claimed` event**.
2. NEAR order: the receipt is a `Transfer` action followed by the same callback.
3. Callback with `Successful`: `bond -= payout`, `reserved -= liability`, `paid_out += payout`, status `claimed`, exactly one `promise_claimed` event with the token, returned preview `ok == true`.
4. **Callback failure** (`Failed`, token order, the unregistered-receiver case): status `open`, `bond`, `reserved`, `paid_out` equal to the values before the claim, **no `EVENT_JSON` log at all**, returned `ok == false` and `error == ERR_PAYOUT_FAILED`.
5. The same for a NEAR order (closed account).
6. **Retry after a failure:** claim again succeeds and (with `Successful`) pays once.
7. **Double claim:** a second `claim` after success: `ERR_ALREADY_CLAIMED` and no transfer receipt is created. A second `claim` while `paying`: `ERR_CLAIM_IN_PROGRESS`, no transfer receipt.
8. Callback called twice (second time after the order is `claimed`) or on an order that is not `paying`: no state change, `ERR_CALLBACK_STATE`, no event. This pins no double debit.
9. Callback not called by the contract itself: panics (`#[private]`).
10. `ERR_NOT_ENOUGH_GAS` when prepaid gas is below the guard, and the state is unchanged.
11. `ERR_PAYOUT_ZERO` (amount 100 raw units, token says `bps=1`): nothing moves, order stays `open`.
12. Payout maths in 6 decimals: 20 tUSDC order (`20_000_000`), `max_bps` 3000, honest token `bps=2000` -> payout `4_000_000`; injection `bps=10000` -> `6_000_000`.
13. A buyer that is not `order.buyer`: `ERR_NOT_BUYER` (unchanged); a different buyer cannot trigger the callback.

**I. Withdraw**
1. Token withdraw of the free part: debits `bond` at once, creates an `ft_transfer` (receiver the merchant, deposit 1) and a callback.
2. Callback `Successful`: one `bond_withdrawn` event with the token. Callback `Failed`: `bond` restored, no event.
3. Two quick withdrawals cannot exceed the free bond (second sees the lowered bond).
4. Above free bond: `ERR_WITHDRAW_EXCEEDS_FREE_BOND`; reserved part of a token order cannot be withdrawn; no bond for the token: `ERR_NO_BOND`; a v1 call without `token` still withdraws NEAR.
5. NEAR withdraw uses the same callback and restores on failure.

**J. Events and views**
1. Every event has `standard "botpromise"`, `version "1.1.0"`, the new `token` field (null for NEAR), and is valid JSON after `EVENT_JSON:`.
2. `get_merchant` still returns `{bond, reserved, paid_out}` for the NEAR bond; `get_bond` and `get_order(merchant, id)`, `get_receipt(merchant, hash)` shapes are pinned with a JSON snapshot.
3. `preview_claim` for an unknown order or merchant: `ERR_NO_ORDER`, never panics, including for every error path above.

Commands (heavy, through the slot runner): `$CONDUCTOR_BIN slot run -- npm run test:contract:v2` and `... npm run test:contract` (v1, must still say `16 passed`). New npm scripts: `build:contract:v2`, `test:contract:v2`.

## 12. Client tests and the live testnet runs

### Client tests (`node --test`, no network, no keys)

The existing 101 tests stay as they are and keep passing. New files unless noted.

- `app/test/amount.test.mjs`: `formatAmount` and `parseAmount` for 6 decimals (`4000000` -> `4`, `1` -> `0.000001`, `0` -> `0`, `1500000` -> `1.5`, `10^30`) and 24 decimals; `parseAmount` rejects `1.0000001`, `-1`, `1e3`, `''`, `' 1'`, `0x10`, `.5`; round trip for random values; no float use (a value above 2^53 stays exact).
- `app/test/token.test.mjs`: `ftMetadata` through a stub provider (symbol, decimals, rejects bad decimals); `storageBalanceOf` null means unregistered; `buildAddBondMsg()` is exactly `{"add_bond":{}}`; `ftTransferCallArgs` (receiver, amount as string, msg as a string, 1 yocto, gas); the registration hint text names the token and the account.
- `app/test/api-detect.test.mjs`: `get_config` returns `api: 2` -> v2; `MethodNotFound` -> v1; a network error or any other error is thrown, **not** read as v1.
- `app/test/relayer.test.mjs` (additions): v2 `get_order` is called with `{merchant, order_id}` and v1 with the old arguments; a token order puts `total 20 tUSDC` into the prompt, the NEAR order bytes and S1 request hash are unchanged (`prompt.test.mjs` keeps its pins and gets one new pinned tUSDC case); `handleClaim` with `result.ok === true` is a normal success; with `result.ok === false` and `ERR_PAYOUT_FAILED` it throws a 502 `ERR_PAYOUT_FAILED` with the tx hash and the registration hint, `claims.log` gets an error row (not a success row), and a second call is allowed (retry); `ERR_ORDER_EXPIRED`, `ERR_CLAIM_IN_PROGRESS` map to HTTP 400 with their code; `errCode` reads the new strings; an expired order refuses `handleChat` (no NEAR AI call, no receipt).
- `app/test/server.test.mjs` (additions): `/api/config` has `contract_api`, `tokens: [{id,symbol,decimals}]`, per-order `token`, and still no keys; the v1 shape is unchanged for a v1 config.
- `app/test/web-*.test.mjs` (additions, same fake `document` style): `rpcView` sends `merchant` for v2; `badgeText` shows `BINDING · claimable 4 tUSDC` and the cap text with the token; `EXPIRED` and `ERR_PAYOUT_FAILED` badges; the unregistered-buyer line; the bond meter shows a NEAR row and a tUSDC row; the expiry countdown; `orderLabel` shows token and amount; the v1 replay transcript still renders exactly as before.
- `app/test/verify-rpc.test.mjs` / `verify-trust.test.mjs` (additions): `verify` against a stub v2 contract passes `merchant`, prints token and amount and checks the token is in `get_config().allowed_tokens`; against a v1 stub it behaves as today; `npm run verify:fixtures` ends in the same last line as today.
- `app/test/replay.test.mjs` / `record-transcript.test.mjs` (additions): a `replay/v2` transcript (adds `token`, token metadata and the payout-failed step) loads; the v1 transcript still loads; the recorder writes only successful payouts as `claim` steps and the failed one as a `claim-failed` step.
- `app/test/demo-setup.test.mjs` (new): `bash -n` on the v2 setup script, and a `DRY_RUN=1` run that prints the exact commands in the right order (storage deposit, token bond with `ft_transfer_call`, token registration of the buyer, orders with `token` and `ttl_ms`) without sending anything and without reading any secret.

### Live testnet runs (operator, recorded afterwards in `docs/build-log.md` with tx links)

Each run records the tx hash, the explorer link and the exact result; a failure is recorded as a failure.

- **L1** Create `v2.cbp-sm1110.testnet`, fund it, deploy, `new` with `[$TOKEN_ID]`; `get_config`; record the wasm size and sha256. Register the market on the token; add the TEE signer (`add_signer`) and the v2 function-call keys.
- **L2** Merchant `storage_deposit`, then `ft_transfer_call` of tUSDC with `{"add_bond":{}}`: `get_bond` and the token `ft_balance_of` of the market and the merchant before and after.
- **L3 Wrong msg:** `ft_transfer_call` with `""` and with `{"bogus":1}`: the transaction succeeds, the sender's token balance is the same afterwards, `get_bonds` unchanged.
- **L4 Wrong token:** (a) `ft_on_transfer` called directly by `cbp-bob-sm1110.testnet`: no credit. (b) if the operator has a second mock token, `ft_transfer_call` with it: refunded in full.
- **L5 No storage balance:** a first token bond from an account without storage balance is refunded in full.
- **L6 Token order, chat, claim:** `register_order` (20 tUSDC, `max_bps` 3000, TTL 30 min) -> real NEAR AI chat -> `register_receipt` -> `claim` with a registered buyer: `ft_balance_of(buyer)` rises by `4000000` (honest) and the order is `claimed`. Gas burnt of `claim` and the callback are written down and the constants in section 7 are corrected.
- **L7 Unregistered receiver:** an order for `cbp-bob-sm1110.testnet`: `claim` -> tx succeeds with `ok:false` `ERR_PAYOUT_FAILED`, `get_order` is `open`, `get_bond` unchanged, no `promise_claimed` log. Then register bob on the token and `claim` again: paid. Then `claim` a third time: `ERR_ALREADY_CLAIMED`, balance unchanged.
- **L8 Injection cap in tUSDC:** the naive bot's `bps=10000` pays `6000000` for the 20 tUSDC / 30% order.
- **L9 Withdraw:** `withdraw_bond` of the free token part: merchant's token balance rises, `get_bond` falls. A withdraw to a merchant that unregistered on the token (if easy to arrange) is restored; otherwise covered by unit tests only, and the README says which.
- **L10 Expiry:** `register_order` with TTL 2 minutes, wait, `release_expired` by a third account (`cbp-bob-sm1110.testnet`): `reserved` falls and `order_expired` is in the logs; `claim` -> `ERR_ORDER_EXPIRED`; `withdraw_bond` takes the released amount.
- **L11 Storage accounting:** `storage_balance_of(merchant)` before and after a `register_order` and a `register_receipt`; an order without storage balance fails with `ERR_STORAGE_BALANCE`; five orders in a row lower only the merchant's storage balance, and the contract account's `view-account` shows no loss beyond the deploy.
- **L12 Namespace:** two accounts register the same `order_id` (alice becomes a second merchant with a 1 NEAR bond); a claim with the wrong `merchant` fails.
- **L13 NEAR regression:** the full v1 demo on v2: `register_merchant`, order, chat, receipt, claim (0.4 NEAR), the cap beat (0.6 NEAR), tamper (`ERR_NO_RECEIPT_FOR_BYTES`), edited reply (`ERR_BAD_SIGNATURE`), double claim.
- **L14** `npm run verify` on a v2 bundle (new fixtures under `fixtures/live/`), `npm run verify:fixtures` for the old ones (must still pass), a new `fixtures/replay/transcript-v2.json`, and `npm run test:js` + both `cargo test` counts, copied from the real output.

## 13. Compatibility and deviations from `docs/plan/INTERFACES.md`

Kept: all NEAR-path method names (`add_signer`, `remove_signer`, `register_merchant`, `add_bond`, `withdraw_bond`, `register_order`, `register_receipt`, `claim`, the views), the token grammar, the error strings of section 6, the event standard `botpromise`, the frozen signed-text and signature checks, and the `claim` result shape (`ClaimPreview`, one added field).

Changed (each is a deliberate break of the v1 interface, to go into `docs/CHANGE-REQUESTS.md` as CR-4):

1. `claim`, `preview_claim`, `get_order`, `get_receipt` take `merchant` (order ids and receipts are per merchant).
2. `register_merchant`: the record's storage cost comes out of the deposit.
3. `claim` pays through a callback: `promise_claimed` is emitted when the money moved, not when `claim` was called, and a successful transaction can carry `ok:false`.
4. `bond_withdrawn` is emitted after the transfer succeeds.
5. `ERR_NOT_ORDER_MERCHANT` is no longer produced; a non-merchant gets `ERR_NO_ORDER`.
6. Event `version` becomes `1.1.0`; every event gains `token`.
7. New errors: `ERR_TOKEN_LIST`, `ERR_TTL`, `ERR_TOKEN_NOT_ALLOWED`, `ERR_NO_BOND`, `ERR_LIABILITY_ZERO`, `ERR_STORAGE_BALANCE`, `ERR_ORDER_NOT_OPEN`, `ERR_ORDER_EXPIRED`, `ERR_ORDER_NOT_EXPIRED`, `ERR_CLAIM_IN_PROGRESS`, `ERR_PAYOUT_ZERO`, `ERR_PAYOUT_FAILED` (value of the callback, not a panic), `ERR_CALLBACK_STATE`, `ERR_NOT_ENOUGH_GAS`.
8. New order statuses `paying` and `expired`.

## 14. Client, app and docs changes (checklist for the build)

Client and app:

- `app/lib/amount.mjs` (new), `app/lib/token.mjs` (new: `ftMetadata`, `storageBalanceOf`, `buildAddBondMsg`, `ftTransferCallArgs`, registration hint), `app/lib/near.mjs` (`callFinal` keeps its behaviour; a helper that reads the final callback value and says whether `ok` is false), `app/lib/contract-api.mjs` (new: `detectApi`, per-version argument builders for `get_order`, `get_receipt`, `preview_claim`, `claim`).
- `app/lib/relayer.mjs`: use the argument builders; token amount text for the prompt; `handleClaim` result check (502 `ERR_PAYOUT_FAILED`, retryable, logged as an error); `handleChat` refuses expired orders before calling NEAR AI; `publicConfig` adds `contract_api`, `tokens`, per-order `token`/`expires_at_ms`. `app/lib/nearai.mjs`: the prompt takes an amount label; NEAR bytes stay identical.
- `app/server.mjs`: nothing new except the config fields (no new endpoint). Registering a buyer on the token is not a relayer job (section 9).
- `app/verify.mjs`: version detection, `merchant` argument, token and amount lines, allowed-token check.
- `web/app.js`, `web/index.html`, `web/style.css`: formatted amounts with the token symbol, per-asset bond meter, expiry countdown, `EXPIRED` and `ERR_PAYOUT_FAILED` states, the unregistered-buyer notice, token name in the order label. Real browser checks stay a human item in `docs/runbook.md` (no browser was or will be opened by the AI).
- `app/scripts/demo-setup.sh`: a v2 variant (or a `V2=1` mode) with `DRY_RUN=1`: merchant storage deposit, token bond by `ft_transfer_call`, buyer registration on the token, orders with `token` and `ttl_ms`; reads only `CONTRACT_ID`, `MERCHANT_ID`, `BUYER_ID`, `TOKEN_ID` from `.env`, never sources it, never prints a key.
- `app/scripts/record-transcript.mjs` and `accept-t*.mjs`: v2 arguments; transcript `replay/v2`. `.env.example`: `TOKEN_ID` (scripts only) and a comment that `CONTRACT_ID` points at v2.
- `package.json`: `build:contract:v2`, `test:contract:v2`; `npm test` runs both contract suites only if Rust is present (as today it does not run cargo).

Docs (after the code and the live runs exist; none of this is edited by the design step):

- `README.md`: new contract id and the v1 history; contract surface table; "Known limits" and "Known limitations (contract v1)": items 1 (storage) and 2 (namespace) and "no order expiry" are marked fixed in v2 **only after** the live runs L11, L12, L10 are recorded; the v1 table stays as history. Add the allow-list trust, the "fixed at init" rule, the expiry trade, the `ok:false` payout rule, the NEP-145 table, the stablecoin demo beat, the real test counts (copied from real output), the libraries (unchanged unless the build changes them), and "What this is not" (the stablecoin line changes from "not a real stablecoin bond" to "tUSDC is a mock; mainnet would use native USDC and is not deployed").
- `docs/runbook.md`: v2 steps (create, fund, deploy, init with the token, register the market on the token, add signer, keys, setup), live state table for v2, the ids from section 2.
- `docs/demo-script.md`: a tUSDC beat (bond in tUSDC, claim 4 tUSDC) and the unregistered-buyer retry beat.
- `docs/CHANGE-REQUESTS.md`: CR-4 (section 13). `docs/SUBMISSION.md`: the new contract id if the submission uses v2. `docs/build-log.md`: the live runs L1-L14.
- AI-use paragraph in `README.md`: this round DeepSeek V4.1 Flash built, Claude Sonnet 5.5 designed, reviewed and fixed, Claude Opus 5.5 did the final review and the operator deploys. Only what really happened is written, per round.
- `docs/plan/` is never edited.

## 15. Build order (each step ends with its tests green and one commit)

1. `contract-v2/` skeleton, copied `parse.rs` and `ecdsa.rs`, the 16 ported tests green. (v1 `cargo test` still 16.)
2. State layout, `get_config`, init, namespace (F), views.
3. Storage accounting (E) and `register_order` / `register_receipt` changes (D), with the flush test first.
4. `ft_on_transfer` (C).
5. Claim, withdraw and callbacks (H, I), expiry (G).
6. Client: amount, token, api-detect, relayer, verify (client tests).
7. Web page and replay v2.
8. Scripts and docs.
9. Review, then the operator runs L1-L14 and records them; docs that claim "fixed" are edited only after that.

## 16. Open points and assumptions (decided here, to be confirmed)

- A merchant can hold one bond per token, plus NEAR. The alternative (one bond per merchant) was rejected because a shop that wants NEAR and tUSDC orders would need two merchant accounts.
- The storage balance is a small own implementation, not the full NEP-145 interface (no `storage_unregister`, no `storage_balance_bounds`).
- `min_order_ttl_ms` is an init argument so live expiry can be recorded in minutes; the production default is 1 hour.
- Gas constants and the 0.5 NEAR demo storage deposit are first guesses until L6 and L11.
- The sub-account `v2.cbp-sm1110.testnet` is the first choice; the fallback id and the funding source are the operator's call (section 2).
- Not verified in this design step, to be checked against near-sdk 5.30.1 by the builder: `store::LookupMap::flush` behaviour with `env::storage_usage()` in unit tests, the `testing_env!` form for promise results, `get_created_receipts()` fields, and serde `deny_unknown_fields` on an enum struct variant. If the unit-test VM does not track `storage_usage` exactly, test E3 asserts the charge against the real byte sizes and L11 becomes the proof.
- The mock token must keep `decimals = 6` and the NEP-145 behaviour seen in `../test-usdc`; the operator confirms the deployed account's `ft_metadata` before L1.

## 17. Build notes (2026-11-10, DeepSeek V4.1 Flash build)

*Historical record of the build step. Its "not deployed" and "no live runs" statements were true then; section 19 has the current state.*

What was built and run locally:

- `contract-v2/` (new crate, `bot-promises-v2`), `contract/` untouched. `parse.rs` and `ecdsa.rs`
  are byte-identical copies (`cmp` was run); the test data (`tests/vectors.json`,
  `tests/live_vector.json`) is copied too.
- `npm run build:contract:v2` -> `contract-v2/res/bot_promises_v2.wasm`, 301572 bytes, sha256
  `7fda513ae25f2639c12c5a4a7bdc6b8fc2127d29ac09dd4f2b7f4f43490a42e2`.
- `npm run test:contract:v2` -> `test result: ok. 88 passed; 0 failed` (the 4 `parse.rs` tests and
  84 v2 tests; the 12 ported v1 tests are among them, `get_order`/`claim`/`preview_claim` now take
  `merchant`). `npm run test:contract` (v1) still -> `test result: ok. 16 passed`.
- `npm run test:js` -> `# tests 148  # pass 148  # fail 0` (the 101 old tests plus 47 new ones).
- `npm run verify:fixtures` -> `ALL VERIFIED (3 real bundles + 1 tampered (correctly rejected) + 2 SIMULATED (fake key, not TEE evidence))` (unchanged).
- The wasm was built, not deployed. `contract-v2/res/` holds the build output like `contract/res/`.

Deviations from the design, and why (all behaviour-preserving unless stated):

1. **Storage record shape.** The state sketch says `storage: LookupMap<AccountId, U128>`. It is a
   `StorageBalance { total, used }` record: `storage_balance_of` must return `available`, and
   `used` is the only way to know it without re-measuring the whole state on every view.
2. **`ft_on_transfer` msg parsing** uses an explicit strict check (`serde_json::Value`, exactly one
   key `add_bond` whose value is an empty object, msg length <= 256) instead of serde
   `deny_unknown_fields`. The accepted/refused inputs and the `REFUND:*` logs are exactly the ones
   in section 5; the explicit form was chosen because `deny_unknown_fields` on enum struct variants
   is the one serde interaction the design itself listed as unverified.
3. **An explicit private guard in the callbacks.** `#[private]` is enforced in the generated
   `extern "C"` wrapper, which a Rust unit test calling the method directly bypasses; the callbacks
   also `require!(predecessor == current_account, "ERR_NOT_PRIVATE")` so test H9 is meaningful and
   the guard holds on any call path.
4. **Receipt token mismatch** answers `ERR_RECEIPT_ORDER_MISMATCH` (the existing "wrong receipt"
   error) instead of inventing a new string. An order's token never changes after creation, so this
   is a defensive consistency check, not a reachable user state.
5. `release_expired` returns the updated `Order`; `on_withdraw_resolved` returns a bool (the design
   did not pin either return type).
6. `register_merchant` and `add_bond` return the v2 `Bond` (with `token`). `get_merchant` is the one
   view pinned to the v1 `{bond, reserved, paid_out}` shape.
7. `min_order_ttl_ms` at init is bounded by the same 365-day maximum as an order TTL (`ERR_TTL`), so
   no deployment can configure a minimum that no order can meet.
8. Ported test setup: `register_merchant` now takes the record cost out of the deposit, so the ported
   v1 tests top the NEAR bond up to exactly 3 NEAR with `add_bond` before asserting the v1 numbers.
   The assertions themselves are unchanged; the only edited ported test is
   `shopper_cannot_register_receipt`, which now expects `ERR_NO_ORDER` (section 13, item 5) with the
   reason in a comment.

Fail-without-feature check (the design asked for this; only a spot check was done, not every test):

| Guard temporarily removed | Tests that failed |
| --- | --- |
| `ERR_LIABILITY_ZERO` check in `register_order` | `liability_zero_rejected` |
| the storage charge (`charge_storage` always true) | `first_token_bond_is_charged_to_the_sender_only`, `first_token_bond_without_storage_balance_is_refunded_and_undone`, `register_receipt_charges_the_merchant`, `register_order_charges_exactly_the_measured_bytes`, `short_balance_panics_and_leaves_no_order`, `short_balance_panics_on_receipt_too`, `spam_loop_stops_when_the_storage_balance_runs_out` |
| the `now >= expires_at_ms` check in `evaluate` | `claim_and_register_receipt_stop_at_the_expiry_boundary` |
| the allowed-token check in `ft_on_transfer` | `wrong_token_is_refunded_and_changes_nothing` |
| the failed-payout restore in `on_claim_paid` | `failed_near_payout_restores_open`, `failed_token_payout_restores_open_and_changes_nothing`, `retry_after_a_failure_pays_once` |

Not done (honest list):

- **No live runs.** L1-L14 were not executed: no `v2.cbp-sm1110.testnet` account was created, no v2
  wasm was deployed, no token was registered, no live tx exists. The gas constants (20/15 Tgas), the
  0.5 NEAR demo storage deposit and the 2-minute demo TTL are still the design's first guesses.
- **No live v2 fixtures and no `replay/v2` transcript file** in this repository. The recorder and the
  replay server understand `claim-failed` and `contract_api: 2`, and a synthetic `replay/v2`
  transcript is tested, but the committed transcript is still the recorded v1 run.
- **`verify` needs `--merchant` (or `MERCHANT_ID`) against v2** because receipts are keyed by
  merchant and the bundle does not carry one. This is in the CLI help above the run.
- Section 9's market-registration check is implemented in three places, locally tested but never run
  against a live token: `verify` adds a `market is registered on <token>` row, the v2 setup script
  reads `storage_balance_of(market)` and stops with a clear message, and the server drops a token
  order (and its token metadata) when the check fails, so the page hides it instead of showing it as
  NEAR. `loadTokenConfig` is the shared helper.
- The web page was driven through its own module with a fake `document` (no browser was opened);
  the real browser click-through is still the human item in `docs/runbook.md`.
- `storage_unregister`, full NEP-145 compliance, multiple bond tokens beyond the init allow-list and
  any owner rescue path for a stuck `paying` order are deliberately absent (sections 6, 7, 16).
- `npm test` still does not run cargo (that predates this build); `npm run test:contract:v2` is the
  v2 command. The new scripts are `build:contract:v2` and `test:contract:v2`.

Docs: README, `docs/runbook.md`, `docs/demo-script.md`, `docs/CHANGE-REQUESTS.md` (CR-4),
`docs/SUBMISSION.md` and `docs/build-log.md` describe v2 as **v-next, not deployed yet**. The v1
contract, its deployment and the recorded v1 replay are unchanged and remain the submission as it
stands. `docs/plan/` was not edited.

## 18. Review round (2026-11-10, Claude Sonnet 5.5)

Strict review of everything since the design commit, against this file. What it found and changed:

1. **Contract, money: a successful transfer that returned data was read as a failure.**
   `promise_succeeded` used `env::promise_result_checked(0, 0)`, which returns `Err(TooLong)` for any
   non-empty result. `on_claim_paid` and `on_withdraw_resolved` then restored the books (order `open`,
   bond re-credited) **after the money had moved**: the shopper could claim again, or the merchant
   withdraw again. The mock tUSDC returns nothing, so the tests and the mock never showed it; a token or a
   wrapper that returns a value would. Fixed: only `PromiseError::Failed` is a failure. Tests:
   `claim_callback_treats_a_non_empty_successful_result_as_paid`,
   `withdraw_callback_treats_a_non_empty_successful_result_as_paid` (both fail on the old code).
2. **Page: the claim toast showed `paid 0.000 NEAR` for a tUSDC claim.** `claimToastText` was NEAR-only.
   It now takes the order's token. The NEAR text is unchanged. Test in `app/test/review-fixes.test.mjs`.
3. **Relayer: a failed NEAR payout told the shopper to register on a token** whenever `TOKEN_ID` was set in
   the env. The hint now follows the token named by the callback (`null` = NEAR gets a NEAR hint).
4. **Relayer: a chat on a `paying` order answered `ERR_ALREADY_CLAIMED`.** It now answers
   `ERR_CLAIM_IN_PROGRESS` (section 8 names that code).
5. **Server: a failing version check at startup was logged and then read as "no version", so the page got
   no `contract_api` and would have sent v1 arguments to a v2 contract.** The startup logic moved to
   `app/lib/live-config.mjs` and a non-`MethodNotFound` error now aborts the start (section 2 says so).
   Test: `startup does not read a network error as v1` (the old inline code in `server.mjs` could not be
   tested, so this test only runs against the new module).
6. **Runbook:** the `create-account` command had no key option (interactive) and took its 0.2 NEAR from
   the v1 contract account; it now tops that account up from the shop first and generates the key.

Checked and found fine (no change): receipt keys per merchant, the `storage_usage` flush before each
measurement, `ft_on_transfer` never panicking and refunding on every unexpected input, no event on a
failed transfer, the claim/withdraw state before the callback, the order of `register_order` checks, and
the NEAR path (same names, `merchant` argument added only for v2 through `contract-api.mjs`).

Known and left as they are (documented limits, not bugs): a callback that ran out of gas leaves an order
`paying` (no owner rescue, by design); `storage_withdraw` sends NEAR without a callback, so an account
that no longer exists loses that amount; `register_merchant` now needs more than 1 NEAR.

Numbers after the review: `contract-v2` `cargo test` -> `90 passed`; `contract` -> `16 passed`;
`node --test app/test/*.test.mjs` -> 153 tests, 149 passed, 4 failed in the review sandbox (the four
`demo-setup.test.mjs` tests spawn `bash`, which the sandbox refused with `spawnSync bash EPERM`; the script
was checked by hand with `bash -n` and a `DRY_RUN=1` run); `verify:fixtures` -> `ALL VERIFIED (3 real
bundles + 1 tampered (correctly rejected) + 2 SIMULATED ...)`. New wasm: `contract-v2/res/bot_promises_v2.wasm`,
299448 bytes, sha256 `399c5af66e90a5800658f86a25c29fa76c62018f7d77d40b47e139e71f9b08bd`
(`cargo near build non-reproducible-wasm --no-abi`, run directly because `npm run` printed nothing under the
slot wrapper). Not deployed at the time of this review (deployed afterwards, see section 19).

## 19. Deployment and live-run status (2026-11-10, after the operator deploy)

*Historical: this is the state before the live run. The "not run" lines in this section were true then; section 21 has the live-run results, and the code hash below is the first build, replaced by the redeploy in section 21.*

Source of each line: **[chain]** = read by RPC in the session that wrote this section; **[operator]** = the
operator's deploy report, not repeated by me.

### Deployed (L1 and the token)

- **Token** `sm1110-tusdc.testnet` [chain: code hash `66d6fc0a1c29683a8802bda397e8448ead45c74df1d591cc5ddf2b6d213570c1`; `ft_metadata`: `Test USD Coin (testnet mock)`, symbol `tUSDC`, 6 decimals]. A mock. Deploy + init tx `2b3hMb4qHXo3XFan4y4gCG3zow5MEaQCzvg1eYrJgBDJ` [chain: success]. Owner-only mint; shop and alice hold 10000 tUSDC [chain: `ft_balance_of` = `10000000000` each], bob 0.
- **Market** `v2.cbp-sm1110.testnet`. Created by `cbp-sm1110.testnet` after a 0.5 NEAR top-up from the shop (tx `CcwHujYu9zimDYV2yyvhvfGUDwfZktBVsSfW22PRdfez`), create tx `7w6riZo57TqQXaqSuY19aCkfCwxCKcmBL5f4A8c8CBVz`, funded 7 NEAR by the shop (tx `CbD75d7Ro1e4HmDFNrstxhXoZA31d8CxpvMisN8ug4z`), deploy + `new{owner, allowed_tokens [sm1110-tusdc.testnet], min_order_ttl_ms 120000}` tx `BY57K2VSfnuTg236uwVsa1frUJbyD2TyebYcFaJq1bA5` [chain: all four success]. `get_config` -> `{api:2, owner v2.cbp-sm1110.testnet, allowed_tokens [sm1110-tusdc.testnet], min_order_ttl_ms "120000", max_order_ttl_ms "31536000000", default_order_ttl_ms "2592000000"}` [chain]. On-chain `code_hash` = `399c5af66e90a5800658f86a25c29fa76c62018f7d77d40b47e139e71f9b08bd` = sha256 of `contract-v2/res/bot_promises_v2.wasm` (299448 bytes) [chain + local]. Balance about 7.2 NEAR, storage 300085 bytes [chain].
- **Market registered on the token**: tx `9MfE4aApnDg6zH4XuTQoXEAuKm9D7Qqc8AFPFU3URnJn` [chain: success]; `storage_balance_of(market)` on the token = `{total: 1250000000000000000000, available: 0}` [chain].
- **TEE signer on v2**: `add_signer` tx `B4GGMbPTthfEhztR5fXqN7iJFuZet9PCBADYwLeTtGDR` [chain: success]. `get_signers` has `5a0210f2…caff`, `provider_tee`, `z-ai/glm-5.3-flash`, attestation `520bedd1…6a65`, `expires_at_ms 1796035518568` (2026-11-30) [chain]. A first attempt failed because `add_signer` is not payable: attach `0 NEAR` (the command `npm run attest` prints already does; the runbook now says so).
- **Function-call keys on v2**: shop `register_receipt` (tx `7E1q3roU8iSeTTzXqjvrLak1uN1qyFcgEd79e3jiXvYe`), alice `claim` (tx `5qygwdQQTorxucw9kojQSY1ZS7Z2zxJTYLdcZK9yWAie`) [chain: both success; the shop's key list shows a `register_receipt` key with receiver `v2.cbp-sm1110.testnet` next to the v1 one].
- Function-call key smoke test (my own, with the keys from `.env`): shop relayer key `register_receipt` for a non-existent order -> failed with `ERR_NO_ORDER`, tx `9CNgE7gV126NSPSdBuNQZzc3jaSLLE3Jx1nsF7VkYWEP`; alice's key `claim` for a non-existent order -> failed with `ERR_NO_ORDER`, tx `HqLPDJDYsKqrsdYY8DNzjdf5bQ91RH9kjMdTDLY98asE` [chain: both recorded as failed, as intended]. This only shows that the keys are accepted by v2 and that the contract refuses an unknown order; it is not one of L2-L14.
- Not registered on the token: `cbp-bob-sm1110.testnet`, on purpose (the failure-case account). Any other new account must be registered with `storage_deposit` on the token first (0.00125 NEAR at the mock's bound); the setup script does it for the merchant and the buyer.

### Live runs L2-L14: status

| Run | Status | Why |
| --- | --- | --- |
| L1 create / deploy / market registration / signer / keys | **done** (above) | |
| L2 merchant storage deposit and the tUSDC bond | **not run** | needs a transaction signed with the shop's full-access key |
| L3 wrong msg, L4 wrong token, L5 no storage balance | **not run** | L3 and L5 need a full-access key (shop or bob); L4(a) needs bob's key |
| L6 token order, chat, claim | **not run** | `register_order` needs the shop's full-access key; chat, `register_receipt` and `claim` themselves use only the function-call keys in `.env` and the NEAR AI key and can be run as soon as an order exists |
| L7 unregistered receiver, retry | **not run** | order for bob needs the shop's key; the retry needs bob's key (`storage_deposit` on the token) |
| L8 injection cap in tUSDC | **not run** | same as L6 (second, naive order) |
| L9 withdraw | **not run** | merchant full-access key |
| L10 expiry and `release_expired` | **not run** | merchant key for the order; `release_expired` is callable by anyone but needs bob's key as designed |
| L11 storage accounting | **not run** | merchant key |
| L12 namespace | **not run** | needs alice's full-access key to register her as a second merchant |
| L13 NEAR regression on v2 | **not run** | `register_merchant` and `register_order` need the shop's key |
| L14 `verify` on a v2 bundle, `replay/v2` transcript | **not run** | there is no v2 bundle yet |

The blocker is mechanical, not a decision: the session had only the two function-call secrets from
`.env`. The shop, alice and bob full-access keys live in `~/.near-credentials`, which that sandbox
does not allow reading, and near-cli could not complete TLS to the RPC from the sandbox (rustls
certificate error through the proxy). Nothing was worked around. The operator (or any shell with the
keychain) runs the merchant-side commands below; everything after the orders exist can be run with
only `.env`.

Merchant-side commands that are left (shop = `cbp-shop-sm1110.testnet`, `NEAR_RPC_URL=https://rpc.testnet.fastnear.com`):

```bash
V2=1 RUN=21 bash app/scripts/demo-setup.sh              # tUSDC path: storage deposit, shop and alice on the token, 100 tUSDC bond, 2 orders A123-21 / A124-21
V2=1 ASSET=near RUN=22 bash app/scripts/demo-setup.sh   # NEAR path on v2: storage deposit (a second one just adds to the balance), register_merchant 3 NEAR, 2 orders A123-22 / A124-22
# failure case L7: an order for bob (not registered on the token), then claim from bob's key, see runbook
```

Then in `.env` set `DEMO_ORDERS` to the new ids, run `npm run dev`, drive chat and claim through
`/api/chat` and `/api/demo/claim` (or the page), and record with
`node app/scripts/record-transcript.mjs A123-21 A124-21`. For a v2 contract it writes
`fixtures/live/a123-v2.json`, `a124-v2.json`, `a123-v2-tampered.json` and
`fixtures/replay/transcript-v2.json`; the recorded v1 files are never touched.

### Client changes in this step (each has a test)

- `app/lib/attestation.mjs`: `PINNED_CONTRACT` is now `v2.cbp-sm1110.testnet`; `PINNED_V1_CONTRACT` and `KNOWN_CONTRACTS` keep v1 as history. `resolveContract(flag, env, bundleContract)` takes a bundle's own `chain.contract` only if it is one of those two, so the v1 fixtures still verify against v1 with no flag and a forged bundle still cannot choose a contract. `app/test/verify-trust.test.mjs` (the two old assertions about the default were updated to v2; two tests added). Checked live: `node app/verify.mjs fixtures/live/a123.json --rpc https://rpc.testnet.fastnear.com` -> 13 PASS rows, `VERIFIED`, against v1.
- `app/lib/transcript.mjs` `outputPaths(api)` and `app/scripts/record-transcript.mjs`: a v2 recording writes `-v2` files, so it can no longer overwrite the recorded v1 fixtures (before this change it would have). For a token order the meter basis is `get_bond(merchant, token)`, and `merchantBeforeClaims` keeps the `token` field. `app/lib/replay.mjs` adds `transcript_url` to the config for a non-default transcript, `app/server.mjs` accepts `REPLAY_FILE`, `npm run demo:replay:v2`, and the page shows a token row from a recorded token bond view. Tests: `record-transcript`, `replay-v2`, `web-stablecoin`.
- `app/scripts/demo-setup.sh`: `V2=1 ASSET=near` sets up the NEAR path on v2. Test in `app/test/demo-setup.test.mjs`. The four existing `demo-setup` tests now call `/bin/bash` and run in an empty working directory (they failed under a sandbox that blocks PATH lookup, and one depended on `.env` having no `TOKEN_ID`); the assertions are unchanged.
- The RPC default in the code (`https://test.rpc.fastnear.com`) was left as it is; `.env` sets `NEAR_RPC_URL`. Use `https://rpc.testnet.fastnear.com` on a machine where the old host flakes.

### Numbers (run 2026-11-10)

`contract-v2` `cargo test` -> `90 passed; 0 failed`; `contract` -> `16 passed; 0 failed`;
`node --test app/test/*.test.mjs` -> `# tests 159  # pass 159  # fail 0`; `npm run verify:fixtures` ->
`ALL VERIFIED (3 real bundles + 1 tampered (correctly rejected) + 2 SIMULATED (fake key, not TEE evidence))`.

## 20. Final review fixes (F1, F2)

**F1: money methods need exactly 1 yoctoNEAR.** In the first build `register_order`, `withdraw_bond`
and `storage_withdraw` were non-payable and did not look at the deposit, so any function-call access
key of the merchant could call them. A wallet that creates a function-call key for the market with an
empty `method_names` list gives that key every non-payable method. Someone who obtains such a key (a
malicious frontend, XSS) could call `register_order(buyer = attacker, amount = the free bond,
max_bps = 10000)`, get a `PROMISE|refund|order=X|bps=10000` reply signed by the shared NEAR AI model
key from their own NEAR AI account, register it with the same key and claim: the merchant's free bond
goes to the attacker. The demo keys name their methods, so the demo is not exposed.

Fix in `contract-v2/src/lib.rs`: `register_order`, `withdraw_bond`, `storage_withdraw`, `add_signer` and
`remove_signer` are `#[payable]` and panic with `ERR_ONE_YOCTO` unless the attached deposit is exactly
1 yoctoNEAR (the NEP-141 / NEP-145 convention). A function-call key cannot attach a deposit, so only a
full-access key passes. `register_receipt` and `claim` keep working with a deposit of 0 so the relayer and
shopper function-call keys still work. Unit tests: `register_order_needs_exactly_one_yocto`,
`withdraw_bond_needs_exactly_one_yocto`, `storage_withdraw_needs_exactly_one_yocto`,
`add_and_remove_signer_need_exactly_one_yocto` (0 and 2 yocto panic with `ERR_ONE_YOCTO` and nothing
changes; 1 works) and `register_receipt_and_claim_stay_callable_with_a_zero_deposit`. The first four
fail on the old code. The 1 yoctoNEAR stays in the contract.

This changes the deployed interface, so it **needed a redeploy** (done, section 21): the first v2 build (code hash
`399c5af6...`) did not have the check. Until then `add_signer` and `register_order` must be called with
0 deposit on the live contract; `npm run attest` prints `1 yoctoNEAR` by default (`ADD_SIGNER_DEPOSIT='0 NEAR'`
for the live build) and `app/scripts/demo-setup.sh` attaches `$REGISTER_ORDER_DEPOSIT` (default
`1 yoctoNEAR`, `'0 NEAR'` for the live build) on the v2 path.

**F2: the v2 account still has a full-access key.** `view_access_key_list` (public RPC, 2026-11-10)
returns one `FullAccess` key each for `v2.cbp-sm1110.testnet` and the tUSDC mock `sm1110-tusdc.testnet`
(`get_owner` on the mock returns itself). The guarantees in this design hold for the code; the operator can
still redeploy the market or mint tUSDC. README Trust boundaries now says so. The owner actions of the
market do not need that key (the owner is the contract itself), so deleting it after the live runs is
possible; it has not been deleted.

## 21. Redeploy and the live run L1-L14 (2026-11-10, Claude Sonnet 5.5; redeploy by the operator, Claude Opus 5.5)

**Redeploy.** The operator redeployed `v2.cbp-sm1110.testnet` in place with the F1 fix: tx
`CbDQ6rL6GzTchuEE9GKqdGEHi8eUyxFKZkoJwJ51h3tC`, wasm `contract-v2/res/bot_promises_v2.wasm`, 299151 bytes, sha256
`095bb43efde677c2fe531ddcdc4fb3554b9c1c35e897a8b6f23ae5908c9b9721`; state kept (api 2, TEE signer registered). The L1 script compared the account's
on-chain `code_hash` with the sha256 of that file: equal. `ADD_SIGNER_DEPOSIT` / `REGISTER_ORDER_DEPOSIT` (the 0-deposit overrides for the first
build) were removed from `npm run attest`, `demo-setup.sh` and the plan; every `register_order` now attaches exactly 1 yoctoNEAR.

**How it was run.** Every transaction was signed with near-api-js (no near-cli) using the keys of `.env`: `app/scripts/live-v2.mjs` (steps L1 ... L13),
`app/scripts/demo-setup-v2.mjs` (the port of the V2 setup branches of `demo-setup.sh`; run for real for tUSDC `RUN=21` and NEAR `ASSET=near RUN=22`),
and the headless app (`npm run dev`) for chat -> NEAR AI reply -> signed receipt (relayer key) -> claim (alice's claim-only key). Every transaction,
failures included, is in `fixtures/runs/v2-live-run.json` (81 txs, 27 failures, 128 checks computed by the script, all pass; per-receipt gas and logs
are in each record); the same table with explorer hashes is in `docs/build-log.md`. `npm run verify:live-run` re-reads all 81 from the RPC and compares:
81/81 match.

| Run | Result (details and tx hashes: `docs/build-log.md`) |
| --- | --- |
| L1 | state matches; the 1-yocto check is live (`add_signer`, `register_order`, `storage_withdraw` with 0 deposit: `ERR_ONE_YOCTO`; `add_signer` with 1 yocto works) |
| L2 | storage deposit 0.5 NEAR, 100 tUSDC bond by `ft_transfer_call`, `bond_added` with the token, balances moved 1:1 |
| L3 | empty and unknown msg: refunded in full (`REFUND:BAD_MSG`), `get_bonds` unchanged |
| L4 | (a) done: direct `ft_on_transfer` by bob refused (`REFUND:TOKEN_NOT_ALLOWED`). **(b) not run**: no second token (nothing may be deployed this round); unit test only |
| L5 | first token bond without a storage balance refunded in full (`REFUND:NO_STORAGE`) |
| L6 | real bot reply `bps=2000`, receipt, claim: `4000000` tUSDC to the registered buyer; bond, reserved, paid_out moved by exactly that; one `promise_claimed` with the token |
| L7 | unregistered receiver: tx ok with `ok:false` / `ERR_PAYOUT_FAILED`, order `open`, bond unchanged, no `promise_claimed`, `PAYOUT_FAILED:` log; after bob registered, claim paid `4000000`; third claim `ERR_ALREADY_CLAIMED` |
| L8 | naive bot `bps=10000` -> payout `6000000` (30% cap of 20 tUSDC) |
| L9 | `withdraw_bond` of the free token part paid; above the free bond refused. **Also done (L9b, beyond the list):** a merchant unregistered from the token: withdraw callback `false`, bond restored, `WITHDRAW_FAILED:` log |
| L10 | 2 minute TTL: early `release_expired` refused, relayer refused a chat after expiry, claim `ERR_ORDER_EXPIRED`, a third account released it (reserved fell 6 tUSDC, `order_expired`), second release `ERR_ORDER_NOT_OPEN`, the previously impossible withdraw now works |
| L11 | five orders each charged the shop exactly 246 bytes x 10^19 yocto; shop `available` fell by exactly the added bytes x 10^19; the market account's `amount` rose by 5 yocto only. A receipt cost 7.58e21 yocto (758 bytes). Order without storage balance: `ERR_STORAGE_BALANCE` (L12, alice) |
| L12 | alice a second merchant; same order id `N123-21` under two merchants; same merchant twice `ERR_ORDER_EXISTS`; wrong merchant `ERR_NO_ORDER` / `ERR_NOT_BUYER` |
| L13 | the NEAR demo on v2: 0.4 NEAR, cap 0.6 NEAR, `ERR_NO_RECEIPT_FOR_BYTES`, `ERR_BAD_SIGNATURE`, `ERR_ALREADY_CLAIMED` |
| L14 | `npm run verify -- fixtures/live/a123-v2.json --merchant cbp-shop-sm1110.testnet` and the other three v2 bundles `VERIFIED`, tampered copy `NOT VERIFIED`; `fixtures/replay/transcript-v2.json` (tUSDC) and `transcript-v2-near.json`; `npm run verify:fixtures` -> `ALL VERIFIED (7 real bundles + 3 tampered (correctly rejected) + 2 SIMULATED ...)` |

**Measured behaviour that the design text did not spell out.** After a claim the order is `claimed` and the status check wins: a tampered-bytes claim
gives `ERR_ALREADY_CLAIMED` and registering an edited reply gives `ERR_ORDER_NOT_OPEN`, not the signature errors (those show on an open order, L6b, L13).
A shop that withdraws almost its whole bond cannot register the next order (`ERR_INSUFFICIENT_FREE_BOND`), as designed.

**Gas.** See section 7. The constants were not changed, so the contract source and the deployed wasm are unchanged by this round.

**Found by the live run (client, fixed with a test):** `record-transcript.mjs` called v2 `get_order` with `merchant: null`; it now needs `MERCHANT_ID`.
New option `RECORD_SUFFIX` records a second v2 run beside the first.

**Not done:** L4(b); `ERR_LIABILITY_ZERO` live; a `claim-failed` beat inside the replayed transcript; a real-browser check; measuring a real USDC token's gas.
The market and the token still hold a full-access key each (F2 unchanged).
