#!/usr/bin/env bash
# check_price_crypto.sh — 加密货币价格阈值 watcher
#
# Usage: bash check_price_crypto.sh <COIN_ID> <THRESHOLD> <DIRECTION>
#   COIN_ID: CoinGecko ID（如 bitcoin / ethereum / solana）
#   THRESHOLD: 阈值价格（USD）
#   DIRECTION: above | below
#
# 行为：拉 CoinGecko 实时价 → 比较阈值 → 只在状态切换时触发（above ⟷ below）
# state 用 processed_ids 存最近一次"side"（避免每次都触发，只 fire 跨越事件）

set -euo pipefail

COIN="${1:-}"
THRESHOLD="${2:-}"
DIRECTION="${3:-above}"
[ -z "$COIN" ] || [ -z "$THRESHOLD" ] && { echo "ERR: COIN_ID and THRESHOLD required" >&2; exit 1; }

PY=/usr/bin/python3
RESP=$(curl -fsS --max-time 10 "https://api.coingecko.com/api/v3/simple/price?ids=${COIN}&vs_currencies=usd" 2>/dev/null) \
  || { echo "ERR: CoinGecko fetch failed" >&2; exit 2; }

NOW=$(date +%s)
HOUR=$(date +%Y-%m-%dT%H)

COIN="$COIN" THRESHOLD="$THRESHOLD" DIRECTION="$DIRECTION" RESP="$RESP" NOW="$NOW" HOUR="$HOUR" "$PY" - <<'PYEOF'
import json, os
data = json.loads(os.environ['RESP'])
coin = os.environ['COIN']
direction = os.environ['DIRECTION']
threshold = float(os.environ['THRESHOLD'])

if coin not in data:
    print(f"ERR: coin '{coin}' not in response", __import__('sys').stderr)
    exit(3)

price = float(data[coin]['usd'])
crossed = (direction == "above" and price >= threshold) or (direction == "below" and price <= threshold)

if not crossed:
    print("[]")  # no event
    exit(0)

# 同一小时同一方向只触发一次（NEW_ID 编码方向+小时）
out = [{
    "NEW_ID": f"{direction}-{threshold}-{os.environ['HOUR']}",
    "NEW_PUBDATE": int(os.environ['NOW']),
    "NEW_COIN": coin,
    "NEW_PRICE": price,
    "NEW_THRESHOLD": threshold,
    "NEW_DIRECTION": direction,
}]
print(json.dumps(out, ensure_ascii=False))
PYEOF
