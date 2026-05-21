#!/bin/bash
# Memory CLI — HTTP client for claude-mem worker
# Usage:
#   bash memory-cli.sh remember "记忆内容" [--title "标题"] [--type note|discovery|decision|preference]
#   bash memory-cli.sh recall [--query "搜索词"] [--limit 20]

set -euo pipefail

WORKER_PORT="${CLAUDE_MEM_WORKER_PORT:-37777}"
WORKER_HOST="127.0.0.1"
BASE_URL="http://${WORKER_HOST}:${WORKER_PORT}"

if [ -z "${SESSION_KEY:-}" ]; then
  echo "Error: SESSION_KEY environment variable is required" >&2
  exit 1
fi

cmd="${1:-}"
shift || true

case "$cmd" in
  remember)
    text="${1:-}"
    shift || true
    if [ -z "$text" ]; then
      echo "Error: text argument is required"
      echo "Usage: bash memory-cli.sh remember \"要记住的内容\" [--title \"标题\"] [--type note]"
      exit 1
    fi

    title=""
    type="note"
    while [ $# -gt 0 ]; do
      case "$1" in
        --title) title="$2"; shift 2 ;;
        --type) type="$2"; shift 2 ;;
        *) shift ;;
      esac
    done

    # Build JSON payload
    json=$(jq -n \
      --arg text "$text" \
      --arg title "$title" \
      --arg type "$type" \
      --arg project "$SESSION_KEY" \
      '{text: $text, type: $type, project: $project} + (if $title != "" then {title: $title} else {} end)')

    result=$(curl -s -X POST "${BASE_URL}/api/memory/save" \
      -H "Content-Type: application/json" \
      -d "$json" \
      --max-time 10)

    # Parse and display result
    if echo "$result" | jq -e '.success' >/dev/null 2>&1; then
      id=$(echo "$result" | jq -r '.id // "?"')
      saved_title=$(echo "$result" | jq -r '.title // "(untitled)"')
      echo "Saved memory #${id}: ${saved_title}"
    else
      echo "Failed to save: $result"
      exit 1
    fi
    ;;

  recall)
    query=""
    limit=20
    while [ $# -gt 0 ]; do
      case "$1" in
        --query) query="$2"; shift 2 ;;
        --limit) limit="$2"; shift 2 ;;
        *) shift ;;
      esac
    done

    # Fetch memories for this session
    encoded_key=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$SESSION_KEY'))")
    url="${BASE_URL}/api/observations?project=${encoded_key}&limit=200&orderBy=created_at_epoch&order=desc"
    result=$(curl -s "$url" --max-time 10)

    if [ -n "$query" ]; then
      # Client-side filter by query (case-insensitive)
      echo "$result" | jq -r --arg q "$query" --argjson limit "$limit" '
        .items // [] |
        map(select(
          ([.title, .subtitle, .narrative, .text, .facts, .concepts] | map(select(. != null)) | join(" ") | ascii_downcase) |
          contains($q | ascii_downcase)
        )) |
        .[:$limit] |
        if length == 0 then "No memories found for \"\($q)\""
        else
          "Found \(length) memories:\n\n" +
          (map(
            "#\(.id) [\(.type // "note")] \(.title // "(untitled)")" +
            if .narrative then "\n   \(.narrative[:200])" else "" end
          ) | join("\n\n"))
        end
      '
    else
      echo "$result" | jq -r --argjson limit "$limit" '
        .items // [] | .[:$limit] |
        if length == 0 then "No memories saved yet for this session."
        else
          "Found \(length) memories:\n\n" +
          (map(
            "#\(.id) [\(.type // "note")] \(.title // "(untitled)")" +
            if .narrative then "\n   \(.narrative[:200])" else "" end
          ) | join("\n\n"))
        end
      '
    fi
    ;;

  *)
    echo "Usage:"
    echo "  bash memory-cli.sh remember \"记忆内容\" [--title \"标题\"] [--type note|discovery|decision|preference]"
    echo "  bash memory-cli.sh recall [--query \"搜索词\"] [--limit 20]"
    exit 1
    ;;
esac
