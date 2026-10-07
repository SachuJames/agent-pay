#!/usr/bin/env bash
# AgentPay end-to-end demo.
#
# Starts a local solana-test-validator and the API, then walks a full payment
# lifecycle: create wallets -> fund -> pay within limit -> over-limit payment
# held for approval -> approve -> settle on Solana -> settle on EVM.
# Everything happens locally; no mainnet, no external services.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PINNED_211="$HOME/workspace/.solana/solana-2.1.21/solana-release/bin"
if [ -x "$PINNED_211/solana-test-validator" ]; then
  SOLANA_BIN="$PINNED_211"
else
  SOLANA_BIN="$(dirname "$(command -v solana-test-validator)")"
fi
export PATH="$SOLANA_BIN:$PATH"
VALIDATOR="$SOLANA_BIN/solana-test-validator"
SOLANA="$SOLANA_BIN/solana"
RPC="http://127.0.0.1:8899"
API="http://127.0.0.1:8787"

udp_sendto_blocked() {
  ! python3 -c "import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.sendto(b'x', ('127.0.0.1', 9))" 2>/dev/null
}
if udp_sendto_blocked; then
  if [ ! -f "$ROOT/scripts/udp_shim.so" ] && [ -f "$ROOT/scripts/udp_sendto_shim.c" ] && command -v gcc >/dev/null 2>&1; then
    echo "    UDP sendto() is blocked; building preload shim..."
    gcc -shared -fPIC -o "$ROOT/scripts/udp_shim.so" "$ROOT/scripts/udp_sendto_shim.c" -ldl -lpthread
  fi
  [ -f "$ROOT/scripts/udp_shim.so" ] && export LD_PRELOAD="$ROOT/scripts/udp_shim.so"
fi

TMPD="$(mktemp -d)"
VALIDATOR_PID=""; API_PID=""
RESULT="FAILED"
cleanup() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "$VALIDATOR_PID" ] && kill "$VALIDATOR_PID" 2>/dev/null || true
  rm -rf "$TMPD"
  echo "----------------------------------------"
  echo "DEMO RESULT: $RESULT"
}
trap cleanup EXIT

start_api() {
  cd "$ROOT/api"
  DB_PATH="$TMPD/demo.db" PORT=8787 \
    ${SETTLEMENT_MINT:+SETTLEMENT_MINT="$SETTLEMENT_MINT"} \
    ${SETTLEMENT_PAYER:+SETTLEMENT_PAYER="$SETTLEMENT_PAYER"} \
    SOLANA_RPC_URL="$RPC" node dist/index.js >"$TMPD/api.log" 2>&1 &
  API_PID=$!
  cd "$ROOT"
  for i in $(seq 1 30); do
    curl -sf "$API/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "api failed to start"; cat "$TMPD/api.log"; exit 1
}

echo "== AgentPay demo =="
echo "[1/8] Building API..."
(cd "$ROOT/api" && npm run build >/dev/null 2>&1)

echo "[2/8] Starting solana-test-validator..."
cd "$TMPD"
$VALIDATOR --reset -q --ledger "$TMPD/ledger" >validator.log 2>&1 &
VALIDATOR_PID=$!
cd "$ROOT"
for i in $(seq 1 60); do
  $SOLANA cluster-version --url "$RPC" >/dev/null 2>&1 && break
  sleep 1
done
echo "    validator is up"

echo "[3/8] Starting API..."
start_api
MASTER=$(grep -o 'MASTER_API_KEY=[^ ]*' "$TMPD/api.log" | cut -d= -f2)
AKEY=$(curl -s -X POST "$API/v1/api-keys" -H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json' \
  -d '{"name":"demo-agent","scopes":["admin"]}' | python3 -c "import json,sys; print(json.load(sys.stdin)['key'])")
AUTH="Authorization: Bearer $AKEY"

echo "[4/8] Creating wallets..."
WA=$(curl -s -X POST "$API/v1/wallets" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"agent_id":"agent-alpha","name":"ops wallet","per_tx_cap":5000,"daily_cap":20000,"weekly_cap":100000}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
WB=$(curl -s -X POST "$API/v1/wallets" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"agent_id":"agent-beta","name":"vendor wallet"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
SOLA=$(curl -s "$API/v1/wallets/$WA" -H "$AUTH" | python3 -c "import json,sys; print(json.load(sys.stdin)['solana_address'])")
SOLB=$(curl -s "$API/v1/wallets/$WB" -H "$AUTH" | python3 -c "import json,sys; print(json.load(sys.stdin)['solana_address'])")
echo "    A=$WA  B=$WB"

echo "[5/8] Setting up Solana settlement (mint + funding token accounts)..."
export WALLET_ADDRESSES="[\"$SOLA\",\"$SOLB\"]"
export FAUCET_KEYPAIR="$TMPD/ledger/faucet-keypair.json"
export PAYER_OUT="$TMPD/payer.json"
export SOLANA_RPC_URL="$RPC"
MINT_LINE=$(cd "$ROOT/api" && node scripts/setup-solana.mjs | grep '^MINT=')
export SETTLEMENT_MINT="${MINT_LINE#MINT=}"
export SETTLEMENT_PAYER=$(python3 -c "import json,base64; print(base64.b64encode(bytes(json.load(open('$TMPD/payer.json')))).decode())")
echo "    mint=$SETTLEMENT_MINT"

echo "[6/8] Restarting API with settlement config..."
kill "$API_PID" 2>/dev/null || true
sleep 1
start_api

echo "[7/8] Running payment lifecycle..."
curl -s -X POST "$API/v1/wallets/$WA/fund" -H "$AUTH" -H 'Content-Type: application/json' -d '{"amount":50000}' >/dev/null
echo "    funded A with \$500.00"

P1=$(curl -s -X POST "$API/v1/payments" -H "$AUTH" -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' \
  -d "{\"from_wallet\":\"$WA\",\"to_wallet\":\"$WB\",\"amount\":3000,\"memo\":\"within limit\"}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['id'], d['status'])")
echo "    payment within limit: $P1"

P1B=$(curl -s -X POST "$API/v1/payments" -H "$AUTH" -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' \
  -d "{\"from_wallet\":\"$WA\",\"to_wallet\":\"$WB\",\"amount\":3000,\"memo\":\"within limit\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ "${P1%% *}" = "$P1B" ] && echo "    idempotency check passed (same payment id returned)"

P2=$(curl -s -X POST "$API/v1/payments" -H "$AUTH" -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-2' \
  -d "{\"from_wallet\":\"$WA\",\"to_wallet\":\"$WB\",\"amount\":8000,\"memo\":\"over per-tx cap\"}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['id'], d['status'], d['reason_code'])")
echo "    over-limit payment: $P2"
P2ID="${P2%% *}"

APPR=$(curl -s -X POST "$API/v1/approvals/$P2ID/approve" -H "$AUTH" -H 'Content-Type: application/json' -d '{"reason_code":"demo_approval"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
echo "    approval decision: $APPR"

echo "[8/8] Settling..."
P1ID="${P1%% *}"
STL=$(curl -s -X POST "$API/v1/payments/$P1ID/settle" -H "$AUTH" -H 'Content-Type: application/json' -d '{"rail":"solana"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['status'], d['tx_hash'][:16])")
echo "    solana settlement: $STL"
STL2=$(curl -s -X POST "$API/v1/payments/$P2ID/settle" -H "$AUTH" -H 'Content-Type: application/json' -d '{"rail":"evm"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['status'])")
echo "    evm settlement: $STL2 (local record)"

echo "== Verification =="
BALA=$(curl -s "$API/v1/wallets/$WA" -H "$AUTH" | python3 -c "import json,sys; print(json.load(sys.stdin)['balance'])")
BALB=$(curl -s "$API/v1/wallets/$WB" -H "$AUTH" | python3 -c "import json,sys; print(json.load(sys.stdin)['balance'])")
echo "    ledger balances: A=\$$BALA B=\$$BALB"
[ "$BALA" = "390.00" ] && [ "$BALB" = "110.00" ] || { echo "BALANCE MISMATCH"; exit 1; }

ONCHAIN=$(cd "$ROOT/api" && MINT="$SETTLEMENT_MINT" A="$SOLA" B="$SOLB" node --input-type=module -e "
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
const c = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const m = new PublicKey(process.env.MINT);
for (const a of [process.env.A, process.env.B]) {
  const ata = await getAssociatedTokenAddress(m, new PublicKey(a));
  const acc = await getAccount(c, ata);
  console.log(a.slice(0,6) + '=' + acc.amount.toString());
}")
echo "    on-chain token balances: $ONCHAIN"
echo "$ONCHAIN" | grep -q "997000" || { echo "ONCHAIN A MISMATCH"; exit 1; }
echo "$ONCHAIN" | grep -q "1003000" || { echo "ONCHAIN B MISMATCH"; exit 1; }

AUDIT=$(curl -s "$API/v1/audit?limit=100" -H "$AUTH" | python3 -c "
import json,sys
acts = [a['action'] for a in json.load(sys.stdin)['audit']]
for need in ['wallet.created','wallet.funded','payment.completed','payment.held_for_approval','payment.approved','payment.settled']:
    assert need in acts, f'missing {need}'
print(len(acts), 'audit entries, all expected actions present')")
echo "    audit: $AUDIT"

RESULT="ALL CHECKS PASSED"
