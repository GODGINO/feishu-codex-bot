#!/usr/bin/env bash
# check_bili_uploader.sh — Bilibili UP-master new-video watcher
#
# Usage:   bash check_bili_uploader.sh <UID>
# Input env: WATERMARK_JSON  ({"last_pubdate": <unix>, "processed_ids": ["BVxxx", ...]})
# Output:  JSON array of new videos, sorted by NEW_PUBDATE asc:
#          [{"NEW_ID":"BVxxx","NEW_TITLE":"...","NEW_URL":"...","NEW_PUBDATE":1777250122,"NEW_OWNER":"..."}]
# Exit:    0 = success (array may be empty), !=0 = check failed (network/parse)
#
# B 站 /x/space/wbi/arc/search needs WBI signing + buvid3 cookie.
# We pre-warm the cookie jar by hitting bilibili.com homepage.
# See: shared/sigma-alert-plan.md (chapter 九)

set -euo pipefail

UID_ARG="${1:-}"
[ -z "$UID_ARG" ] && { echo "ERR: UID required" >&2; exit 1; }

PY=/usr/bin/python3

UID_ARG="$UID_ARG" WATERMARK_JSON="${WATERMARK_JSON:-}" "$PY" - <<'PYEOF'
import asyncio, json, os, sys
import httpx

try:
    from bilix.sites.bilibili.api import _add_sign
except Exception as e:
    print(f"ERR: bilix not installed or api changed: {e}", file=sys.stderr)
    sys.exit(5)

UID = os.environ.get("UID_ARG", "")
WM_RAW = os.environ.get("WATERMARK_JSON") or "{}"
try:
    WM = json.loads(WM_RAW)
except Exception:
    WM = {}
LAST_PUBDATE = int(WM.get("last_pubdate") or 0)
PROCESSED = set(WM.get("processed_ids") or [])

async def main():
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://space.bilibili.com/",
    }
    async with httpx.AsyncClient(headers=headers, timeout=10.0, follow_redirects=True) as client:
        # Pre-warm cookies (buvid3 is set by visiting bilibili)
        try:
            await client.get("https://www.bilibili.com/")
        except Exception:
            pass
        # Some endpoints also need b_nut and bili_ticket; visit space too
        try:
            await client.get(f"https://space.bilibili.com/{UID}")
        except Exception:
            pass

        params = {"mid": UID, "order": "pubdate", "ps": 10, "pn": 1, "keyword": ""}
        try:
            await _add_sign(client, params)
        except Exception as e:
            print(f"ERR: WBI sign failed: {e}", file=sys.stderr)
            sys.exit(2)

        try:
            r = await client.get("https://api.bilibili.com/x/space/wbi/arc/search", params=params)
            r.raise_for_status()
        except Exception as e:
            print(f"ERR: B站 API request failed: {e}", file=sys.stderr)
            sys.exit(3)

        try:
            d = r.json()
        except Exception as e:
            print(f"ERR: response not JSON: {e}", file=sys.stderr)
            sys.exit(4)

        if d.get("code") != 0:
            print(f"ERR: B站 API code={d.get('code')} msg={d.get('message')}", file=sys.stderr)
            sys.exit(4)

        vlist = ((d.get("data") or {}).get("list") or {}).get("vlist") or []

        new_items = []
        for v in vlist:
            bvid = v.get("bvid")
            pubdate = int(v.get("created") or 0)
            if not bvid or pubdate <= LAST_PUBDATE or bvid in PROCESSED:
                continue
            new_items.append({
                "NEW_ID": bvid,
                "NEW_TITLE": v.get("title") or "",
                "NEW_URL": f"https://www.bilibili.com/video/{bvid}",
                "NEW_PUBDATE": pubdate,
                "NEW_OWNER": v.get("author") or "",
                "NEW_DURATION_S": v.get("length") or "",
                "NEW_DESC": (v.get("description") or "")[:500],
            })

        new_items.sort(key=lambda x: x["NEW_PUBDATE"])
        print(json.dumps(new_items, ensure_ascii=False))

asyncio.run(main())
PYEOF
