#!/usr/bin/env bash
# bili-transcribe.sh — B 站视频转写为带时间戳的 Markdown
#
# 用法：bash bili-transcribe.sh "https://www.bilibili.com/video/BVxxx"
# 输出：/tmp/{BV}.md（stdout 打印路径，stderr 进度日志）
# 退出码：0=ok, 1=URL invalid, 2=GROQ_API_KEY missing, 3=ASR failed,
#         4=video too long (>3600s), 5=tool missing, 6=network/API error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; . "$SCRIPT_DIR/.env"; set +a
fi

URL="${1:-}"
BV=$(echo "$URL" | grep -oE 'BV[a-zA-Z0-9]+' || true)
[ -z "$BV" ] && { echo "ERR: invalid Bilibili URL: $URL" >&2; exit 1; }
[ -z "${GROQ_API_KEY:-}" ] && { echo "ERR: GROQ_API_KEY not set (put it in $SCRIPT_DIR/.env)" >&2; exit 2; }
command -v ffmpeg >/dev/null || { echo "ERR: ffmpeg not installed (brew install ffmpeg)" >&2; exit 5; }

PY=/usr/bin/python3
$PY -m bilix --help >/dev/null 2>&1 || { echo "ERR: bilix not installed (pip3 install --user bilix)" >&2; exit 5; }

OUT="/tmp/${BV}.md"
WORK="/tmp/agent-reach-bili-${BV}"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

echo ">>> [1/6] Fetching metadata for $BV" >&2
curl -fsS -H "User-Agent: $UA" -H "Referer: https://www.bilibili.com/" \
  "https://api.bilibili.com/x/web-interface/view?bvid=$BV" > "$WORK/meta.json" \
  || { echo "ERR: failed to fetch metadata" >&2; exit 6; }

eval "$($PY - "$WORK/meta.json" <<'PYEOF'
import sys, json, shlex
d = json.load(open(sys.argv[1]))['data']
print(f"TITLE={shlex.quote(d['title'])}")
print(f"OWNER={shlex.quote(d['owner']['name'])}")
print(f"DURATION={d['duration']}")
print(f"AID={d['aid']}")
print(f"CID={d['cid']}")
PYEOF
)"

echo ">>> [2/6] $TITLE | UP=$OWNER | duration=${DURATION}s" >&2

if [ "$DURATION" -gt 3600 ]; then
  echo "ERR: video too long (${DURATION}s > 3600s)" >&2
  exit 4
fi

echo ">>> [3/6] Checking official subtitle" >&2
SUB_URL=$(curl -fsS -H "User-Agent: $UA" -H "Referer: https://www.bilibili.com/" \
  "https://api.bilibili.com/x/player/v2?aid=$AID&cid=$CID" \
  | $PY -c "
import sys, json
subs = json.load(sys.stdin)['data']['subtitle']['subtitles']
print(subs[0]['subtitle_url'] if subs else '')
")

if [ -n "$SUB_URL" ]; then
  echo ">>> [4/6] Using official subtitle, skipping ASR" >&2
  [[ "$SUB_URL" == //* ]] && SUB_URL="https:$SUB_URL"
  curl -fsS -H "User-Agent: $UA" -H "Referer: https://www.bilibili.com/" "$SUB_URL" \
    | $PY -c "
import sys, json
d = json.load(sys.stdin)
for seg in d['body']:
    s = int(seg['from']); h, m, sec = s//3600, (s%3600)//60, s%60
    print(f'[{h:02d}:{m:02d}:{sec:02d}] {seg[\"content\"]}')
" > "$WORK/transcript.txt"
  SOURCE="official_subtitle"
else
  echo ">>> [4/6] No subtitle, downloading audio (bilix → yt-dlp fallback)" >&2
  if ! $PY -m bilix v "$URL" --only-audio -d "$WORK" >&2; then
    echo "    bilix failed (likely B 站反爬), trying yt-dlp with session cookies" >&2
    COOKIES="$SCRIPT_DIR/bilibili-cookies.txt"
    if [ -f "$COOKIES" ] && command -v yt-dlp >/dev/null 2>&1; then
      yt-dlp --cookies "$COOKIES" -f "bestaudio" \
        -o "$WORK/%(id)s.%(ext)s" "$URL" >&2 \
        || { echo "ERR: yt-dlp fallback also failed" >&2; exit 6; }
    else
      echo "ERR: bilix failed and yt-dlp fallback unavailable" >&2
      [ -f "$COOKIES" ] || echo "  (missing $COOKIES — see bilibili-cookies-refresh.sh)" >&2
      command -v yt-dlp >/dev/null 2>&1 || echo "  (missing yt-dlp — brew install yt-dlp)" >&2
      exit 6
    fi
  fi

  AUDIO=$(find "$WORK" -maxdepth 2 -type f \( -name '*.m4a' -o -name '*.mp4' -o -name '*.aac' \) | head -1)
  [ -z "$AUDIO" ] && { echo "ERR: bilix did not produce audio file" >&2; exit 6; }
  echo "    downloaded: $AUDIO" >&2

  echo ">>> [5/6] Transcoding to 16kHz mono WAV" >&2
  ffmpeg -y -i "$AUDIO" -ar 16000 -ac 1 -loglevel error "$WORK/audio.wav" \
    || { echo "ERR: ffmpeg transcode failed" >&2; exit 6; }

  echo ">>> [6/6] Transcribing with Groq Whisper-large-v3" >&2
  curl -fsS https://api.groq.com/openai/v1/audio/transcriptions \
    -H "Authorization: Bearer $GROQ_API_KEY" \
    -F "model=whisper-large-v3" \
    -F "language=zh" \
    -F "response_format=verbose_json" \
    -F "file=@$WORK/audio.wav" > "$WORK/asr.json" \
    || { echo "ERR: Groq API call failed" >&2; exit 3; }

  $PY -c "
import sys, json
d = json.load(open('$WORK/asr.json'))
if 'segments' not in d:
    print('ERR: no segments in Groq response: ' + json.dumps(d)[:300], file=sys.stderr)
    sys.exit(1)
for seg in d['segments']:
    s = int(seg['start']); h, m, sec = s//3600, (s%3600)//60, s%60
    print(f\"[{h:02d}:{m:02d}:{sec:02d}] {seg['text'].strip()}\")
" > "$WORK/transcript.txt" || exit 3
  SOURCE="groq_whisper"
fi

cat > "$OUT" <<MDEOF
# $TITLE

- **UP主**: $OWNER
- **时长**: ${DURATION}s
- **来源**: $URL
- **转写来源**: $SOURCE
- **生成时间**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

## 转写

$(cat "$WORK/transcript.txt")
MDEOF

echo ">>> Done: $OUT" >&2
echo "$OUT"
