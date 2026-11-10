#!/usr/bin/env bash
# Usage: RUN=03 bash app/scripts/demo-setup.sh     (needs CONTRACT_ID MERCHANT_ID BUYER_ID in the shell or .env)
#
# Deviations from TASKS T13, recorded in docs/CHANGE-REQUESTS.md CR-2:
#  - .env is parsed by node, never sourced: a value with spaces (DEMO_ORDERS labels) cannot break the run,
#    and only CONTRACT_ID / MERCHANT_ID / BUYER_ID are read.
#  - get_merchant output is captured once and matched with a bash pattern (no pipe under pipefail, no
#    stderr silencing), so a network error aborts instead of looking like "merchant missing".
#  - the free bond is topped up when it cannot cover this run's two orders (ERR_INSUFFICIENT_FREE_BOND).
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
: "${CONTRACT_ID:?missing CONTRACT_ID (set it in the shell or .env)}"
: "${MERCHANT_ID:?missing MERCHANT_ID (set it in the shell or .env)}"
: "${BUYER_ID:?missing BUYER_ID (set it in the shell or .env)}"
: "${RUN:?set RUN, e.g. RUN=03}"

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
