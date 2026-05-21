#!/usr/bin/env bash
# check_http_status.sh — HTTP 状态 watcher（API 健康检查）
#
# Usage: bash check_http_status.sh <URL> [<EXPECT_STATUS>]
#   URL: 要监控的端点
#   EXPECT_STATUS: 期望的状态码（默认 200）。当实际状态 != 期望时触发。
#
# 状态机：only fire on TRANSITION（"healthy → unhealthy" 或 "unhealthy → healthy"）。
# 用 NEW_ID 编码状态："healthy-2026-04-27T18" 或 "unhealthy-{actual_status}-2026-04-27T18"
# 同一小时同一状态只触发一次（避免 5 分钟轮询里疯狂刷屏）。

set -euo pipefail

URL="${1:-}"
EXPECT="${2:-200}"
[ -z "$URL" ] && { echo "ERR: URL required" >&2; exit 1; }

ACTUAL=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 -A "Mozilla/5.0" "$URL" 2>/dev/null || echo "000")
NOW=$(date +%s)
HOUR=$(date +%Y-%m-%dT%H)

PY=/usr/bin/python3

if [ "$ACTUAL" = "$EXPECT" ]; then
  STATE="healthy"
  ID="${STATE}-${HOUR}"
else
  STATE="unhealthy"
  ID="${STATE}-${ACTUAL}-${HOUR}"
fi

URL="$URL" ID="$ID" STATE="$STATE" ACTUAL="$ACTUAL" EXPECT="$EXPECT" NOW="$NOW" "$PY" - <<'PYEOF'
import json, os
print(json.dumps([{
    "NEW_ID": os.environ['ID'],
    "NEW_PUBDATE": int(os.environ['NOW']),
    "NEW_URL": os.environ['URL'],
    "NEW_STATE": os.environ['STATE'],
    "NEW_ACTUAL_STATUS": os.environ['ACTUAL'],
    "NEW_EXPECT_STATUS": os.environ['EXPECT'],
}], ensure_ascii=False))
PYEOF
