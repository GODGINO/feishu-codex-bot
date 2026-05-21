#!/usr/bin/env bash
# check_dir_new.sh — 文件夹新文件 watcher
#
# Usage: bash check_dir_new.sh <DIR> [<PATTERN>]
#   DIR: 要监控的目录（绝对路径）
#   PATTERN: glob 模式，默认 "*"（如 "*.pdf"、"*.mp4"）
#
# 检测 DIR 下 mtime > last_pubdate 的文件。

set -euo pipefail

DIR="${1:-}"
PATTERN="${2:-*}"
[ -z "$DIR" ] && { echo "ERR: DIR required" >&2; exit 1; }
[ ! -d "$DIR" ] && { echo "ERR: not a directory: $DIR" >&2; exit 2; }

PY=/usr/bin/python3

DIR="$DIR" PATTERN="$PATTERN" "$PY" - <<'PYEOF'
import os, json, fnmatch
DIR = os.environ['DIR']
PATTERN = os.environ['PATTERN']
try:
    wm = json.loads(os.environ.get('WATERMARK_JSON') or '{}')
except Exception:
    wm = {}
LAST = int(wm.get('last_pubdate') or 0)

out = []
try:
    for entry in os.scandir(DIR):
        if not entry.is_file(): continue
        if not fnmatch.fnmatch(entry.name, PATTERN): continue
        st = entry.stat()
        mtime = int(st.st_mtime)
        if mtime <= LAST: continue
        out.append({
            "NEW_ID": entry.path,
            "NEW_PUBDATE": mtime,
            "NEW_PATH": entry.path,
            "NEW_NAME": entry.name,
            "NEW_SIZE": st.st_size,
        })
except Exception as e:
    import sys
    print(f"ERR: scandir failed: {e}", file=sys.stderr)
    sys.exit(3)

out.sort(key=lambda x: x['NEW_PUBDATE'])
print(json.dumps(out, ensure_ascii=False))
PYEOF
