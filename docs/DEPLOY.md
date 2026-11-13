# Deploy your own copy (testnet)

Runs on NEAR testnet with throwaway accounts. You need Rust 1.95 with `cargo-near` 0.23, `near-cli-rs` 0.31, Node 22.22.2+ and a NEAR AI Cloud API key (https://cloud.near.ai).

near-cli keeps keys in `~/.near-credentials/testnet/`; the app reads its two function-call keys from `.env` (gitignored). Never paste a private key into code, chat or a commit.

## v2 (NEAR and NEP-141 bonds, order expiry)

```bash
export SUFFIX=yourname
export MARKET=cbp-$SUFFIX.testnet MERCHANT_ID=cbp-shop-$SUFFIX.testnet BUYER_ID=cbp-alice-$SUFFIX.testnet
export TOKEN_ID=tusdc-$SUFFIX.testnet

# Accounts. The market needs about 7 NEAR for code storage, the shop about 4, the shopper 0.5.
for A in $MARKET $MERCHANT_ID $BUYER_ID $TOKEN_ID; do
  near account create-account sponsor-by-faucet-service $A autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
done

# Mock token (token/, tUSDC, 6 decimals, owner-only mint). Skip if you have an NEP-141 token already.
(cd token && cargo near build non-reproducible-wasm)
near contract deploy $TOKEN_ID use-file token/target/near/test_usdc.wasm \
  with-init-call new json-args "{\"owner_id\":\"$MERCHANT_ID\",\"total_supply\":\"1000000000000\"}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send

# Market (owner = itself; min_order_ttl_ms 120000 is a demo value, the default floor is 1 hour)
npm run build:contract:v2
near contract deploy $MARKET use-file contract-v2/res/bot_promises_v2.wasm \
  with-init-call new json-args "{\"owner\":\"$MARKET\",\"allowed_tokens\":[\"$TOKEN_ID\"],\"min_order_ttl_ms\":\"120000\"}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
near contract call-function as-read-only $MARKET get_config json-args '{}' network-config testnet now

# Register the market on the token, so it can receive bonds
near contract call-function as-transaction $TOKEN_ID storage_deposit \
  json-args "{\"account_id\":\"$MARKET\",\"registration_only\":true}" \
  prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as $MARKET network-config testnet sign-with-legacy-keychain send

# Attest the model and register its TEE signer. `npm run attest` checks the TDX quote, the nonce binding
# and the GPU evidence, writes the record to fixtures/attestation/ and prints the add_signer command.
CONTRACT_ID=$MARKET npm run attest -- --model z-ai/glm-5.3-flash --days 20
# run the printed add_signer command (1 yoctoNEAR), then:
near contract call-function as-read-only $MARKET get_signers json-args '{}' network-config testnet now

# Function-call keys: the relayer may call only register_receipt, the shopper's demo key only claim.
node app/scripts/new-keys.mjs           # prints two public keys, appends the secrets to .env
near account add-key $MERCHANT_ID grant-function-call-access --allowance '1 NEAR' --contract-account-id $MARKET \
  --function-names 'register_receipt' use-manually-provided-public-key <RELAYER_PUBLIC_KEY> network-config testnet sign-with-legacy-keychain send
near account add-key $BUYER_ID grant-function-call-access --allowance '0.5 NEAR' --contract-account-id $MARKET \
  --function-names 'claim' use-manually-provided-public-key <BUYER_CLAIM_PUBLIC_KEY> network-config testnet sign-with-legacy-keychain send
```

### Demo orders

Fill `.env` from `.env.example`: `CONTRACT_ID`, `MERCHANT_ID`, `BUYER_ID`, `TOKEN_ID`, `NEARAI_API_KEY`, and the shop's full-access key as `CBP_SHOP_ACCOUNT` / `CBP_SHOP_KEY` for the setup script. An order id can be claimed once, so every run needs a new `RUN`:

```bash
DRY_RUN=1 RUN=01 node app/scripts/demo-setup-v2.mjs      # print the steps, read no key, send nothing
RUN=01 node app/scripts/demo-setup-v2.mjs                # tUSDC: storage balances, 100 tUSDC bond, orders A123-01 / A124-01
RUN=02 ASSET=near node app/scripts/demo-setup-v2.mjs     # NEAR bond and two 2 NEAR orders on the same market
```

Set `DEMO_ORDERS="A123-01:Broken mug:2000,A124-01:Late delivery:2000:naive"`, run `npm run dev` and open http://127.0.0.1:8787. The trailing `:naive` marks the misconfigured bot (`docs/PROMPT-TESTS.md`). With your keys you can also run `npm run check:keys` and `npm run check:prompt` (the honest bot promises 2000 bps, the naive one 10000).

`node app/scripts/record-transcript.mjs A123-01 A124-01` (needs `MERCHANT_ID`) writes the bundles to `fixtures/live/` and the transcript to `fixtures/replay/`; record while the orders are still open to get the live views. `npm run verify -- fixtures/live/a123-v2.json --merchant $MERCHANT_ID` checks a bundle against the chain.

## v1 (NEAR bonds only)

The same steps with `contract/`: `npm run build:contract`, deploy `contract/res/bot_promises.wasm` with `new {"owner":"<contract>"}`, then attest, keys, and `RUN=01 bash app/scripts/demo-setup.sh`. v1 takes no deposit on `register_order` and has no expiry or storage accounting (`docs/DETAILS.md`).

## Renewing the TEE signer

A signer expires after `--days`; after that, new `register_receipt` calls fail with `ERR_SIGNER_EXPIRED` and receipts already on chain stay valid. Run `npm run attest -- --model z-ai/glm-5.3-flash --days N --out-dir <tmp>`, copy the record into `fixtures/attestation/` under a new name (an existing record is never overwritten, since its sha256 may be on chain), then run the printed `add_signer` command with the owner key.
