#!/usr/bin/env bash
# check_url_diff.sh — URL 内容变化 watcher
#
# Usage: bash check_url_diff.sh <URL> [<JQ_OR_GREP_FILTER>]
#   URL: 要监控的网页/JSON 接口
#   FILTER: 可选，jq 表达式（用于 JSON）或 grep -oE 模式（用于 HTML）
#
# 行为：拉 URL → (可选) 过滤 → 算 sha256 → 与上次 hash 比较 → 不同则触发
# state 复用 last_pubdate 字段存"最后一次 hash 的时间戳"，processed_ids 存最近 N 个 hash

set -euo pipefail

URL="${1:-}"
FILTER="${2:-}"
[ -z "$URL" ] && { echo "ERR: URL required" >&2; exit 1; }

PY=/usr/bin/python3
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

CONTENT=$(curl -fsS --max-time 15 -A "$UA" "$URL" 2>/dev/null) || { echo "ERR: fetch failed" >&2; exit 2; }

if [ -n "$FILTER" ]; then
  if echo "$CONTENT" | head -c 1 | grep -qE '[\{\[]'; then
    # JSON → jq
    if command -v jq >/dev/null 2>&1; then
      CONTENT=$(echo "$CONTENT" | jq -r "$FILTER" 2>/dev/null) || { echo "ERR: jq filter failed" >&2; exit 3; }
    fi
  else
    # HTML/text → grep -oE
    CONTENT=$(echo "$CONTENT" | grep -oE "$FILTER" | head -50 || true)
  fi
fi

HASH=$(echo -n "$CONTENT" | shasum -a 256 | awk '{print $1}' | cut -c1-16)
NOW=$(date +%s)

# Output one event with NEW_ID = hash. AlertRunner dedup will suppress if hash already in processed_ids.
URL="$URL" HASH="$HASH" NOW="$NOW" CONTENT="$CONTENT" "$PY" - <<'PYEOF'
import json, os
url = os.environ['URL']; hsh = os.environ['HASH']; now = int(os.environ['NOW'])
preview = (os.environ.get('CONTENT','') or '')[:200].replace('\n', ' ⏎ ')
print(json.dumps([{
    "NEW_ID": hsh,
    "NEW_PUBDATE": now,
    "NEW_URL": url,
    "NEW_HASH": hsh,
    "NEW_PREVIEW": preview,
}], ensure_ascii=False))
PYEOF
