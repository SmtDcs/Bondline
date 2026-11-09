#!/usr/bin/env bash
# Usage: RUN=02 bash app/scripts/demo-setup.sh     (needs CONTRACT_ID MERCHANT_ID BUYER_ID in the shell or .env)
set -euo pipefail
[ -f .env ] && set -a && . ./.env && set +a
: "${RUN:?set RUN, e.g. RUN=02}"
TWO_NEAR=2000000000000000000000000
if ! near contract call-function as-read-only "$CONTRACT_ID" get_merchant json-args "{\"merchant\":\"$MERCHANT_ID\"}" network-config testnet now 2>/dev/null | grep -q bond; then
  near contract call-function as-transaction "$CONTRACT_ID" register_merchant json-args '{}' prepaid-gas '30 Tgas' attached-deposit '3 NEAR' sign-as "$MERCHANT_ID" network-config testnet sign-with-legacy-keychain send
fi
for ID in "A123-$RUN" "A124-$RUN"; do
  near contract call-function as-transaction "$CONTRACT_ID" register_order json-args "{\"order_id\":\"$ID\",\"buyer\":\"$BUYER_ID\",\"amount\":\"$TWO_NEAR\",\"max_bps\":3000}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$MERCHANT_ID" network-config testnet sign-with-legacy-keychain send
done
near contract call-function as-read-only "$CONTRACT_ID" get_merchant json-args "{\"merchant\":\"$MERCHANT_ID\"}" network-config testnet now
echo "Now set DEMO_ORDERS=A123-$RUN:Broken mug:2000,A124-$RUN:Late delivery:2000 in .env"
