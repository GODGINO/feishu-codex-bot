#!/usr/bin/env bash
# check_gh_pr_comments.sh — GitHub PR 新评论 watcher
#
# Usage: bash check_gh_pr_comments.sh <REPO> <PR_NUM>
#   REPO: 格式 owner/name（例如 anthropics/claude-code）
#   PR_NUM: PR 编号
#
# 用 gh CLI 拉 PR 的 review comments + issue comments，按 created_at 时间戳过滤。

set -euo pipefail

REPO="${1:-}"
PR="${2:-}"
[ -z "$REPO" ] || [ -z "$PR" ] && { echo "ERR: REPO and PR_NUM required" >&2; exit 1; }
command -v gh >/dev/null || { echo "ERR: gh CLI not installed" >&2; exit 5; }

PY=/usr/bin/python3
LAST_PUBDATE=$(echo "${WATERMARK_JSON:-{}}" | "$PY" -c "import sys,json; d=json.load(sys.stdin); print(d.get('last_pubdate',0))")

# 同时拉 issue comments（PR 主线程）和 review comments（行内评论）
ISSUE_COMMENTS=$(gh api "repos/${REPO}/issues/${PR}/comments" 2>/dev/null || echo '[]')
REVIEW_COMMENTS=$(gh api "repos/${REPO}/pulls/${PR}/comments" 2>/dev/null || echo '[]')

REPO="$REPO" PR="$PR" LAST="$LAST_PUBDATE" "$PY" - <<PYEOF "$ISSUE_COMMENTS" "$REVIEW_COMMENTS"
import json, os, sys
from datetime import datetime
import time

def to_epoch(iso):
    return int(time.mktime(datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").timetuple()))

last = int(os.environ['LAST'])
out = []
for raw, kind in zip(sys.argv[1:3], ['issue', 'review']):
    try:
        items = json.loads(raw)
    except Exception:
        items = []
    for c in items:
        ts = to_epoch(c['created_at'])
        if ts <= last: continue
        out.append({
            "NEW_ID": f"{kind}-{c['id']}",
            "NEW_PUBDATE": ts,
            "NEW_URL": c['html_url'],
            "NEW_AUTHOR": c['user']['login'],
            "NEW_BODY": (c.get('body') or '')[:500],
            "NEW_KIND": kind,
        })

out.sort(key=lambda x: x['NEW_PUBDATE'])
print(json.dumps(out, ensure_ascii=False))
PYEOF
