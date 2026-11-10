#!/usr/bin/env bash
# Usage: RUN=03 bash app/scripts/demo-setup.sh                       (v1 / NEAR flow)
#        V2=1 RUN=03 bash app/scripts/demo-setup.sh                  (v2, token bond + token orders)
#        V2=1 DRY_RUN=1 RUN=03 bash app/scripts/demo-setup.sh        (print the commands, send nothing)
#        V2=1 ASSET=near RUN=03 bash app/scripts/demo-setup.sh       (v2, NEAR bond + NEAR orders; no TOKEN_ID needed)
# Needs CONTRACT_ID MERCHANT_ID BUYER_ID in the shell or .env; V2 also needs TOKEN_ID.
#
# Deviations from TASKS T13, recorded in docs/CHANGE-REQUESTS.md CR-2:
#  - .env is parsed by node, never sourced: a value with spaces (DEMO_ORDERS labels) cannot break the run,
#    and only CONTRACT_ID / MERCHANT_ID / BUYER_ID / TOKEN_ID are read.
#  - get_merchant output is captured once and matched with a bash pattern (no pipe under pipefail, no
#    stderr silencing), so a network error aborts instead of looking like "merchant missing".
#  - the free bond is topped up when it cannot cover this run's two orders (ERR_INSUFFICIENT_FREE_BOND).
# CR-4 (docs/STABLECOIN.md 14): V2=1 wires the stablecoin demo: merchant storage balance on the
# market, the merchant and the buyer registered on the token, a token bond by ft_transfer_call and
# two orders with token + ttl_ms. DRY_RUN=1 prints the same commands and reads no key.
set -euo pipefail

env_get() { # one KEY from .env, without executing the file (the file value wins over a stale shell export)
  [ -f .env ] || return 0
  node -e '
    const fs = require("node:fs");
    const key = process.argv[1];
    const line = fs.readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith(key + "="));
    if (line === undefined) process.exit(0);
    let v = line.slice(key.length + 1).trim();
    if (v.length > 1 && (v[0] === "\"" || v[0] === "\x27") && v.at(-1) === v[0]) v = v.slice(1, -1);
    process.stdout.write(v);
  ' "$1"
}
CONTRACT_ID="${CONTRACT_ID:-$(env_get CONTRACT_ID)}"
MERCHANT_ID="${MERCHANT_ID:-$(env_get MERCHANT_ID)}"
BUYER_ID="${BUYER_ID:-$(env_get BUYER_ID)}"
TOKEN_ID="${TOKEN_ID:-$(env_get TOKEN_ID)}"
V2="${V2:-0}"
DRY_RUN="${DRY_RUN:-0}"
: "${CONTRACT_ID:?missing CONTRACT_ID (set it in the shell or .env)}"
: "${MERCHANT_ID:?missing MERCHANT_ID (set it in the shell or .env)}"
: "${BUYER_ID:?missing BUYER_ID (set it in the shell or .env)}"
: "${RUN:?set RUN, e.g. RUN=03}"

run() { # print the command when DRY_RUN=1, otherwise run it
  if [ "$DRY_RUN" = "1" ]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

ASSET="${ASSET:-token}"
if [ "$V2" = "1" ] && [ "$ASSET" = "near" ]; then
  # v2 NEAR path (docs/STABLECOIN.md L13): the merchant's storage balance, the NEAR bond (register_merchant,
  # the record's storage cost comes out of the deposit) and two NEAR orders with a TTL.
  TTL_MS="${TTL_MS:-1800000}"
  NEAR_AMOUNT_YOCTO="${NEAR_AMOUNT_YOCTO:-2000000000000000000000000}"   # 2 NEAR
  STORAGE_DEPOSIT="${STORAGE_DEPOSIT:-0.5 NEAR}"
  NEAR_ARGS=(network-config testnet sign-with-legacy-keychain send)
  run near contract call-function as-transaction "$CONTRACT_ID" storage_deposit \
    json-args "{\"account_id\":\"$MERCHANT_ID\"}" prepaid-gas '30 Tgas' attached-deposit "$STORAGE_DEPOSIT" \
    sign-as "$MERCHANT_ID" "${NEAR_ARGS[@]}"
  # register_merchant answers ERR_MERCHANT_EXISTS the second time; a DRY_RUN just prints it
  run near contract call-function as-transaction "$CONTRACT_ID" register_merchant json-args '{}' \
    prepaid-gas '30 Tgas' attached-deposit '3 NEAR' sign-as "$MERCHANT_ID" "${NEAR_ARGS[@]}"
  for ID in "A123-$RUN" "A124-$RUN"; do
    run near contract call-function as-transaction "$CONTRACT_ID" register_order \
      json-args "{\"order_id\":\"$ID\",\"buyer\":\"$BUYER_ID\",\"amount\":\"$NEAR_AMOUNT_YOCTO\",\"max_bps\":3000,\"ttl_ms\":\"$TTL_MS\"}" \
      prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$MERCHANT_ID" "${NEAR_ARGS[@]}"
  done
  if [ "$DRY_RUN" != "1" ]; then
    near contract call-function as-read-only "$CONTRACT_ID" get_bonds json-args "{\"merchant\":\"$MERCHANT_ID\"}" network-config testnet now
  fi
  echo "Now set DEMO_ORDERS=\"A123-$RUN:Broken mug:2000,A124-$RUN:Late delivery:2000:naive\" in .env"
  exit 0
fi

if [ "$V2" = "1" ]; then
  : "${TOKEN_ID:?missing TOKEN_ID (the NEP-141 token, set it in the shell or .env)}"
  TTL_MS="${TTL_MS:-1800000}"                 # 30 minutes: visible on the page, still demo-length
  AMOUNT_RAW="${AMOUNT_RAW:-20000000}"        # 20 tUSDC at 6 decimals
  BOND_RAW="${BOND_RAW:-100000000}"           # 100 tUSDC
  STORAGE_DEPOSIT="${STORAGE_DEPOSIT:-0.5 NEAR}"
  TOKEN_REGISTRATION_DEPOSIT="${TOKEN_REGISTRATION_DEPOSIT:-0.01 NEAR}"
  NEAR_ARGS=(network-config testnet sign-with-legacy-keychain send)

  # 0. the market must already be registered on the token (L1 does this once); stop with a clear
  # message instead of failing later inside ft_transfer_call.
  if [ "$DRY_RUN" != "1" ]; then
    MARKET_ON_TOKEN=$(near contract call-function as-read-only "$TOKEN_ID" storage_balance_of \
      json-args "{\"account_id\":\"$CONTRACT_ID\"}" network-config testnet now)
    if [[ "$MARKET_ON_TOKEN" != *'"total"'* ]]; then
      echo "the market $CONTRACT_ID is not registered on $TOKEN_ID: run its storage_deposit first (docs/runbook.md, L1)" >&2
      exit 1
    fi
  fi

  # 1. the merchant's prepaid storage balance on the market (orders and receipts are charged to it)
  run near contract call-function as-transaction "$CONTRACT_ID" storage_deposit \
    json-args "{\"account_id\":\"$MERCHANT_ID\"}" prepaid-gas '30 Tgas' attached-deposit "$STORAGE_DEPOSIT" \
    sign-as "$MERCHANT_ID" "${NEAR_ARGS[@]}"
  # 2. the merchant registers on the token (it must hold the tokens it deposits)
  run near contract call-function as-transaction "$TOKEN_ID" storage_deposit \
    json-args "{\"account_id\":\"$MERCHANT_ID\",\"registration_only\":true}" prepaid-gas '30 Tgas' \
    attached-deposit "$TOKEN_REGISTRATION_DEPOSIT" sign-as "$MERCHANT_ID" "${NEAR_ARGS[@]}"
  # 3. the token bond: ft_transfer_call with {"add_bond":{}} (1 yoctoNEAR is attached by the token call)
  run near contract call-function as-transaction "$TOKEN_ID" ft_transfer_call \
    json-args "{\"receiver_id\":\"$CONTRACT_ID\",\"amount\":\"$BOND_RAW\",\"msg\":\"{\\\"add_bond\\\":{}}\"}" \
    prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$MERCHANT_ID" "${NEAR_ARGS[@]}"
  # 4. the buyer registers on the token so a claim can be paid (the shop pays for its shopper)
  run near contract call-function as-transaction "$TOKEN_ID" storage_deposit \
    json-args "{\"account_id\":\"$BUYER_ID\",\"registration_only\":true}" prepaid-gas '30 Tgas' \
    attached-deposit "$TOKEN_REGISTRATION_DEPOSIT" sign-as "$MERCHANT_ID" "${NEAR_ARGS[@]}"
  # 5. the demo orders, in the token, with the chosen TTL
  for ID in "A123-$RUN" "A124-$RUN"; do
    run near contract call-function as-transaction "$CONTRACT_ID" register_order \
      json-args "{\"order_id\":\"$ID\",\"buyer\":\"$BUYER_ID\",\"amount\":\"$AMOUNT_RAW\",\"max_bps\":3000,\"token\":\"$TOKEN_ID\",\"ttl_ms\":\"$TTL_MS\"}" \
      prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$MERCHANT_ID" "${NEAR_ARGS[@]}"
  done
  if [ "$DRY_RUN" != "1" ]; then
    near contract call-function as-read-only "$CONTRACT_ID" get_bonds json-args "{\"merchant\":\"$MERCHANT_ID\"}" network-config testnet now
  fi
  echo "Now set DEMO_ORDERS=\"A123-$RUN:Broken mug:2000,A124-$RUN:Late delivery:2000:naive\" in .env and TOKEN_ID=$TOKEN_ID"
  exit 0
fi

TWO_NEAR=2000000000000000000000000
FREE_BOND_FLOOR=1200000000000000000000000 # 2 orders x 2 NEAR x 3000 bps

merchant_json() {
  near contract call-function as-read-only "$CONTRACT_ID" get_merchant json-args "{\"merchant\":\"$MERCHANT_ID\"}" network-config testnet now
}

M=$(merchant_json)
if [[ "$M" != *'"bond"'* ]]; then
  near contract call-function as-transaction "$CONTRACT_ID" register_merchant json-args '{}' prepaid-gas '30 Tgas' attached-deposit '3 NEAR' sign-as "$MERCHANT_ID" network-config testnet sign-with-legacy-keychain send
  M=$(merchant_json)
fi

BOND="" RESERVED=""
[[ "$M" =~ \"bond\"[[:space:]]*:[[:space:]]*\"([0-9]+)\" ]] && BOND="${BASH_REMATCH[1]}"
[[ "$M" =~ \"reserved\"[[:space:]]*:[[:space:]]*\"([0-9]+)\" ]] && RESERVED="${BASH_REMATCH[1]}"
if [ -z "$BOND" ] || [ -z "$RESERVED" ]; then
  echo "cannot read bond/reserved from get_merchant output:" >&2
  echo "$M" >&2
  exit 1
fi

FREE=$(node -e 'process.stdout.write((BigInt(process.argv[1]) - BigInt(process.argv[2])).toString())' "$BOND" "$RESERVED")
if [ "$(node -e 'process.stdout.write(BigInt(process.argv[1]) >= BigInt(process.argv[2]) ? "ok" : "topup")' "$FREE" "$FREE_BOND_FLOOR")" = topup ]; then
  echo "free bond $FREE yocto is below $FREE_BOND_FLOOR yocto: adding 2 NEAR to the bond"
  near contract call-function as-transaction "$CONTRACT_ID" add_bond json-args '{}' prepaid-gas '30 Tgas' attached-deposit '2 NEAR' sign-as "$MERCHANT_ID" network-config testnet sign-with-legacy-keychain send
fi

for ID in "A123-$RUN" "A124-$RUN"; do
  near contract call-function as-transaction "$CONTRACT_ID" register_order json-args "{\"order_id\":\"$ID\",\"buyer\":\"$BUYER_ID\",\"amount\":\"$TWO_NEAR\",\"max_bps\":3000}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$MERCHANT_ID" network-config testnet sign-with-legacy-keychain send
done
merchant_json
echo "Now set DEMO_ORDERS=\"A123-$RUN:Broken mug:2000,A124-$RUN:Late delivery:2000:naive\" in .env (the trailing :naive marks the badly configured bot, PLAN R4)"
