#!/usr/bin/env bash
# bilibili-cookies-refresh.sh — 从 sigma chrome 实例（已登录 B 站）拉取 cookies
# 写到 SCRIPT_DIR/bilibili-cookies.txt（Netscape 格式，yt-dlp 兼容）。
# 用途：bili-transcribe.sh 在 bilix 被 B 站反爬挡住时会用 yt-dlp + 这份 cookies fallback。
# 前置：sigma chrome 已启动（bash start-chrome.sh）且已在 B 站登录。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PORT_FILE="$SESSION_DIR/.chrome-port"
[ -f "$PORT_FILE" ] || { echo "ERR: chrome 没启动（找不到 $PORT_FILE）" >&2; exit 1; }
PORT=$(cat "$PORT_FILE")

OUT="$SCRIPT_DIR/bilibili-cookies.txt"

/usr/bin/python3 - "$PORT" "$OUT" <<'PYEOF'
import sys, json, urllib.request, os
from websocket import create_connection
port, out_path = sys.argv[1], sys.argv[2]
v = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version').read())
ws = create_connection(v['webSocketDebuggerUrl'])
ws.send(json.dumps({'id': 1, 'method': 'Storage.getCookies'}))
cookies = json.loads(ws.recv())['result']['cookies']
ws.close()
n = 0
with open(out_path, 'w') as f:
    f.write('# Netscape HTTP Cookie File\n')
    for c in cookies:
        if 'bilibili' not in c.get('domain', ''): continue
        domain = c['domain']
        flag = 'TRUE' if domain.startswith('.') else 'FALSE'
        path = c.get('path', '/')
        secure = 'TRUE' if c.get('secure') else 'FALSE'
        expiry = int(c.get('expires', 0)) if c.get('expires', -1) > 0 else 0
        f.write(f"{domain}\t{flag}\t{path}\t{secure}\t{expiry}\t{c['name']}\t{c['value']}\n")
        n += 1
os.chmod(out_path, 0o600)
sessdata = next((c for c in cookies if c['name']=='SESSDATA' and 'bilibili' in c.get('domain','')), None)
print(f"wrote {n} bilibili cookies → {out_path}", file=sys.stderr)
print(f"SESSDATA present: {'yes' if sessdata else 'NO — please log into B 站 in sigma chrome first'}", file=sys.stderr)
PYEOF
