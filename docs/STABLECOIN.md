# Contract v2: stablecoin (NEP-141) support

Implemented in `contract-v2/`, deployed on testnet as `v2.cbp-sm1110.testnet` with the mock token `sm1110-tusdc.testnet` (source in `token/`). This is the interface spec for v2; the v1 interface is `docs/INTERFACES.md`.

## What v2 adds

A merchant can hold a bond in an allowed NEP-141 token alongside a NEAR bond, and claims pay out in the bond's token. Every outgoing transfer has a callback that restores the books if it fails, so a failed payout can be retried. Storage is paid by whoever creates state, order ids are per merchant, and orders expire, releasing an unclaimed reservation.

v1 stays deployed and unchanged. v2 starts empty: no migration, no `migrate`. `parse.rs` and `ecdsa.rs` are copied from v1 byte for byte.

Out of scope, as in v1: on-chain TDX verification, other promise kinds, disputes, wallet login, mainnet, NEAR Intents.

## Accounts

| Item | Value |
| --- | --- |
| Contract | `v2.cbp-sm1110.testnet`, source in `contract-v2/`, owner = itself |
| Merchant / buyer | `cbp-shop-sm1110.testnet` / `cbp-alice-sm1110.testnet`, registered again on v2 |
| Second buyer | `cbp-bob-sm1110.testnet`, kept unregistered on the token for the failure tests |
| Token | `sm1110-tusdc.testnet`, 6 decimals |
| Function-call keys | merchant `register_receipt`, buyer `claim`, both scoped to v2 |

The client tells v1 from v2 by calling `get_config` and treating `MethodNotFound` as v1; any other error is raised.

## State

```text
Contract {
  owner: AccountId,
  allowed_tokens: Vec<AccountId>,        // fixed at init, at most 8, no duplicates
  min_order_ttl_ms: u64,
  signers:   IterableMap<String, SignerInfo>,
  bonds:     LookupMap<(AccountId, Option<AccountId>), Bond>,   // (merchant, token); None = NEAR
  orders:    LookupMap<(AccountId, String), Order>,             // (merchant, order_id)
  receipts:  LookupMap<(AccountId, String), Receipt>,           // (merchant, response_hash)
  storage:   LookupMap<AccountId, U128>,                        // prepaid storage balance
}
Bond    { token: Option<AccountId>, bond: U128, reserved: U128, paid_out: U128 }
Order   { ...v1 fields..., token: Option<AccountId>, expires_at_ms: U64 }   // open | paying | claimed | expired
Receipt { ...v1 fields..., token: Option<AccountId>, order_amount: U128 }
```

`token: None` means NEAR in storage and JSON, never the string `"near"`, since `near` is a valid account id. The token is fixed per bond, per order and per receipt, so a merchant's NEAR and tUSDC bonds never mix. Bond records are never deleted, not even at zero, so callbacks always find them and there is no storage refund.

Receipts are keyed by `(merchant, response_hash)`, so another merchant copying public `register_receipt` args only fills its own namespace. A receipt filed under the wrong order by the same merchant still blocks that reply (`ERR_RECEIPT_EXISTS`).

## Methods

Prepaid gas stays 100 Tgas. A method is compatible with v1 unless the row says otherwise.

| Method | Kind | Who | Notes |
| --- | --- | --- | --- |
| `new(owner, allowed_tokens?, min_order_ttl_ms?)` | init | deployer | the new arguments are optional, so `{"owner":"x"}` still works; `ERR_TOKEN_LIST` (duplicate or more than 8), `ERR_TTL` (zero or above the max) |
| `add_signer`, `remove_signer` | change | owner | also requires exactly 1 yoctoNEAR (`ERR_ONE_YOCTO`) |
| `register_merchant()` payable >= 1 NEAR | change | anyone, once | creates the NEAR bond; the record's storage cost comes out of the deposit, and the 1 NEAR minimum applies to the remaining bond |
| `add_bond()` payable | change | merchant | NEAR bond only; `ERR_NOT_MERCHANT` |
| `ft_on_transfer(sender_id, amount, msg)` | change | the token contract | the only token inflow, returns the unused amount |
| `withdraw_bond(amount, token?)` | change | merchant | `token` optional; pays through a callback; 1 yoctoNEAR |
| `register_order(order_id, buyer, amount, max_bps, token?, ttl_ms?)` | change | merchant | keyed by `(merchant, order_id)`; 1 yoctoNEAR |
| `release_expired(merchant, order_id)` | change | anyone | frees an expired reservation |
| `register_receipt(order_id, signed_text, signature_hex, signer_public_key_hex)` | change | the order's merchant | same arguments; the order is looked up as `(caller, order_id)` |
| `claim(merchant, order_id, response_b64)` | change | the order's buyer | gains `merchant`; pays through a callback |
| `storage_deposit(account_id?)`, `storage_withdraw(amount?)`, `storage_balance_of(account_id)` | change / view | anyone / the account | NEP-145-shaped, not full NEP-145 compliance |
| `on_claim_paid(...)`, `on_withdraw_resolved(...)` | callback | the contract (`#[private]`) | book changes after the transfer result |
| `get_owner`, `get_signer`, `get_signers` | view | anyone | unchanged |
| `get_merchant(merchant)` | view | anyone | returns the NEAR bond in the v1 shape |
| `get_bond(merchant, token?)`, `get_bonds(merchant)` | view | anyone | `get_bonds` lists the NEAR bond and each existing token bond |
| `get_order(merchant, order_id)`, `get_receipt(merchant, response_hash)`, `preview_claim(merchant, order_id, response_b64)` | view | anyone | gain `merchant`; results carry `token`; `preview_claim` never panics |
| `get_config()` | view | anyone | `{"api": 2, "owner", "allowed_tokens", "min_order_ttl_ms", "max_order_ttl_ms", "default_order_ttl_ms"}` |

`register_order` checks, in order: `ERR_ORDER_ID`, `ERR_MAX_BPS`, `ERR_AMOUNT`; `ERR_TOKEN_NOT_ALLOWED`; `ERR_TTL` (below `min_order_ttl_ms` or above 365 days; default 30 days); `ERR_ORDER_EXISTS` for `(merchant, order_id)`; `ERR_NOT_MERCHANT` when there is no bond for that `(merchant, token)`; `liability = amount * max_bps / 10000` with checked arithmetic (`ERR_AMOUNT` on overflow) and `ERR_LIABILITY_ZERO` when it rounds to 0; `ERR_INSUFFICIENT_FREE_BOND`; then the storage charge (`ERR_STORAGE_BALANCE`).

`register_receipt` also requires the order to be `open` (`ERR_ORDER_NOT_OPEN`) and unexpired (`ERR_ORDER_EXPIRED`). Its storage is charged to the merchant. Any account without an order under its own name gets `ERR_NO_ORDER`, so `ERR_NOT_ORDER_MERCHANT` is no longer produced.

Claim arithmetic is unchanged, with one addition: a payout of 0 gives `ERR_PAYOUT_ZERO`, because `ft_transfer` of 0 panics and would make the claim fail for ever. The status order in `evaluate` is `claimed` → `ERR_ALREADY_CLAIMED`, `paying` → `ERR_CLAIM_IN_PROGRESS`, `expired` or `now >= expires_at_ms` → `ERR_ORDER_EXPIRED`, then the v1 checks and `ERR_PAYOUT_ZERO`.

## Incoming tokens

```text
ft_on_transfer(sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128>   // returns the unused amount
msg for a bond deposit:  {"add_bond":{}}
```

The predecessor must be an allowed token, else the full amount is returned and nothing changes. That also covers a user calling `ft_on_transfer` directly.

`sender_id` and `amount` come from the function arguments, which only the token contract can supply. The msg parses into `enum FtMsg { AddBond {} }` with `deny_unknown_fields`, so a msg carrying its own `sender_id`, `amount` or `merchant` is rejected and the bond is always credited to `sender_id`.

Anything unexpected returns the full amount and never panics: an unparseable or empty msg, an unknown variant, a msg over 256 bytes, `amount == 0`, a bond overflow, or no storage balance for a new bond record. Each writes a plain `REFUND:<reason>` log, not an `EVENT_JSON` line, with one of `TOKEN_NOT_ALLOWED`, `BAD_MSG`, `ZERO_AMOUNT`, `OVERFLOW`, `NO_STORAGE`. On success the bond grows, a new record's storage is charged to `sender_id`, and `bond_added` carries the token.

The allow-list is trusted. A token that lies about balances, charges a transfer fee, rebases or freezes accounts breaks the books, and since the list is fixed at init, adding a token means a new deployment.

## Storage deposit

Whoever creates state pays for it, measured rather than estimated. Each account holds a prepaid storage balance: `storage_deposit(account_id?)` is payable and anyone may fund anyone, `storage_withdraw(amount?)` takes only the available part and needs exactly 1 yoctoNEAR, and `storage_balance_of(account_id)` returns `{total, available}` or null. The first deposit pays for its own record.

A prepaid balance rather than an attached deposit, because the relayer's function-call key cannot attach one and `ft_on_transfer` carries tokens, not NEAR.

Every state-creating call measures `env::storage_usage()` before and after and charges `(after - before) * env::storage_byte_cost()`:

| Call | Creates | Charged to |
| --- | --- | --- |
| `register_merchant` | NEAR bond record | the merchant, from the attached deposit |
| `ft_on_transfer` add_bond, first time | token bond record | `sender_id`; short balance returns the deposit |
| `register_order` | order | the merchant |
| `register_receipt` | receipt | the merchant |
| `storage_deposit`, first time | storage record | the account, from the deposit |

A short balance makes change calls panic with `ERR_STORAGE_BALANCE` and store nothing. `ft_on_transfer` cannot panic, so it inserts, flushes, measures, removes the record again and returns the full amount.

`near_sdk::store` collections write to storage only on `flush()`, and `env::storage_usage()` is wrong until then, so every measurement flushes the changed map first. A unit test pins exact charges. Nothing is deleted, so the balance only goes down apart from `storage_withdraw`.

The contract's own free NEAR, which covers code storage, never pays for user state. It still needs a few yoctoNEAR per outgoing `ft_transfer`. Before creating orders, the shop checks `storage_balance_of(merchant).available` against its expected receipt cost; the demo deposits 0.5 NEAR, since a receipt is about 1 KB.

## Outgoing transfers

Every transfer, token or NEAR, is a promise with a callback, and the books change only in the callback. Gas budgets: `GAS_FT_TRANSFER = 20 Tgas`, `GAS_CALLBACK = 15 Tgas`. Measured, a paid tUSDC claim burns 2.7 Tgas in `claim`, 1.8 in `ft_transfer` and 2.2 in `on_claim_paid`, about 7.7 in all; unused gas is refunded, so the budgets leave room. `claim` and `withdraw_bond` panic with `ERR_NOT_ENOUGH_GAS` before touching state when fewer than `GAS_FT_TRANSFER + GAS_CALLBACK + 10` Tgas remain.

Token transfers call `ft_transfer(receiver_id, amount, memo = None)` with exactly 1 yoctoNEAR attached, then the callback. NEAR transfers use `Promise::transfer` the same way.

**Claim.** The buyer runs `evaluate` and the call panics on any error. The order moves to `paying` while `bond`, `reserved` and `paid_out` stay untouched, so the shop cannot withdraw the reservation and the claim can be put back. A second `claim` or a `release_expired` during `paying` gives `ERR_CLAIM_IN_PROGRESS`. Then the transfer is sent and chained to `on_claim_paid`, and `claim` returns that promise.

`on_claim_paid` never panics. If the order is not `paying`, it does nothing and returns `ok:false, error:"ERR_CALLBACK_STATE"`. On a successful transfer it moves the money, sets the order `claimed`, emits `promise_claimed` and returns `ok:true`. On a failed transfer the order goes back to `open` with the books exactly as before, a plain `PAYOUT_FAILED:<order_id>` log is written and it returns `ok:false, error:"ERR_PAYOUT_FAILED"`.

The transaction succeeds either way, so a client must read `result.ok`. The shopper retries the same claim after fixing the cause, as long as the order has not expired.

**Withdraw.** `0 < amount <= bond - reserved` (`ERR_WITHDRAW_EXCEEDS_FREE_BOND`), and `ERR_NO_BOND` when the record does not exist. `bond` is debited immediately so two quick calls cannot double spend; on success `bond_withdrawn` fires after the transfer, on failure the bond is re-credited and a plain `WITHDRAW_FAILED:<token>` log is written.

There is no owner rescue method, so a callback that ran out of gas would leave an order `paying`. The gas guard and its unit test make that unlikely.

## Expiry

`register_order` stores `expires_at_ms = now + ttl_ms`, which the client shows with the order and as a countdown. At or after it, `claim`, `preview_claim` and `register_receipt` answer `ERR_ORDER_EXPIRED`; the boundary is `now >= expires_at_ms`.

`release_expired(merchant, order_id)` may be called by anyone, including a keeper bot. It needs an `open`, expired order: `ERR_NO_ORDER`, `ERR_ORDER_NOT_OPEN`, `ERR_CLAIM_IN_PROGRESS`, `ERR_ORDER_NOT_EXPIRED`. It frees `liability` in that token's bond, sets `expired` and emits `order_expired {order_id, merchant, token, released}`.

The TTL is the buyer's protection: the merchant picks it but not below `min_order_ttl_ms`, it is visible before the promise matters, and registration is refused once it passes. A promise never claimed before expiry is gone.

A failed payout returns the order to `open`; if that happens after expiry, it can be released at once, so the client warns when a payout failed with under 10 minutes left.

## Token registration

NEP-141 tokens refuse transfers to an account with no storage on the token, which is the main way a payout fails.

| Account | Registered on the token | Who pays |
| --- | --- | --- |
| The market contract | yes, to receive bonds | operator, once after deploy: `storage_deposit {registration_only: true}` with about 0.00125 NEAR; `setup` and `verify` stop with a clear message when `storage_balance_of` is null, and the page hides token orders |
| Merchant | yes, it holds the tokens it deposits | the merchant, before the first deposit; a failed withdrawal shows `ERR_WITHDRAW_FAILED` and the bond is restored |
| Buyer | yes, to receive a claim | the buyer or the merchant on their behalf; the demo setup registers the buyer while creating the orders |
| Relayer keys | n/a | cannot attach a deposit, so setup uses the full-access keys in `~/.near-credentials` through near-cli |

Before showing Claim, the client checks `storage_balance_of(buyer)`; if null it keeps BINDING and adds `register on tUSDC first` with the exact command, without blocking the button. A claim to an unregistered buyer returns `ERR_PAYOUT_FAILED`, leaves the order `open` with the bond unchanged, and can be repeated after registration.

## Amounts in the client

Amounts on chain are raw `u128` decimal strings; nothing on chain knows decimals. `app/lib/amount.mjs` provides `formatAmount(raw, decimals, {maxFraction})` and `parseAmount(text, decimals)`, both BigInt only, also served to `web/`.

`decimals` and `symbol` come from the token's `ft_metadata` (NEP-148), read once per token and cached; `/api/config` returns `tokens: [{id, symbol, decimals}]` for every allowed token, and the client rejects a token whose `decimals` is not 0..=36. NEAR keeps its present display so the v1 replay is unchanged. The promise grammar carries a ratio, not an amount, so it does not change; only the prompt mentions the currency (`total 20 tUSDC`).

## Compatibility with v1

Kept: every NEAR-path method name, the token grammar, the v1 error strings, the `botpromise` event standard, the signed-text and signature checks, and the `ClaimPreview` shape with one added field.

Changed on purpose:

1. `claim`, `preview_claim`, `get_order` and `get_receipt` take `merchant`.
2. `register_merchant` takes the record's storage cost out of the deposit.
3. `claim` pays through a callback, so `promise_claimed` means the money moved and a successful transaction can carry `ok:false`.
4. `bond_withdrawn` fires after the transfer succeeds.
5. A non-merchant calling `register_receipt` gets `ERR_NO_ORDER`, not `ERR_NOT_ORDER_MERCHANT`.
6. Event `version` is `1.1.0` and every event gains `token`.
7. New errors: `ERR_TOKEN_LIST`, `ERR_TTL`, `ERR_TOKEN_NOT_ALLOWED`, `ERR_NO_BOND`, `ERR_LIABILITY_ZERO`, `ERR_STORAGE_BALANCE`, `ERR_ORDER_NOT_OPEN`, `ERR_ORDER_EXPIRED`, `ERR_ORDER_NOT_EXPIRED`, `ERR_CLAIM_IN_PROGRESS`, `ERR_PAYOUT_ZERO`, `ERR_PAYOUT_FAILED`, `ERR_CALLBACK_STATE`, `ERR_NOT_ENOUGH_GAS`.
8. New order statuses `paying` and `expired`.
