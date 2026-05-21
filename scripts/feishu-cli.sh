#!/bin/bash
# Feishu MCP HTTP Client — JSON-RPC client for Feishu MCP server
# Usage:
#   bash feishu-cli.sh list-tools                           # 列出所有可用工具
#   bash feishu-cli.sh call <tool_name> '<json_params>'     # 调用指定工具

set -euo pipefail

# Read MCP URL from session-specific config file
if [ -z "${SESSION_DIR:-}" ]; then
  echo "Error: SESSION_DIR environment variable is required" >&2
  exit 1
fi

MCP_URL_FILE="${SESSION_DIR}/feishu-mcp-url"
if [ ! -f "$MCP_URL_FILE" ]; then
  echo "Error: Feishu MCP URL not configured. File not found: $MCP_URL_FILE" >&2
  echo "Please configure the Feishu MCP URL first." >&2
  exit 1
fi

MCP_URL=$(cat "$MCP_URL_FILE" | tr -d '[:space:]')
if [ -z "$MCP_URL" ]; then
  echo "Error: Feishu MCP URL file is empty" >&2
  exit 1
fi

# Session ID cache file
SESSION_CACHE="/tmp/feishu-mcp-session-${SESSION_KEY:-default}"

# Helper: get cached session ID
get_session_id() {
  if [ -f "$SESSION_CACHE" ]; then
    cat "$SESSION_CACHE"
  fi
}

# Helper: send JSON-RPC request to MCP server
send_rpc() {
  local body="$1"
  local session_id
  session_id=$(get_session_id)

  local headers=(-H "Content-Type: application/json" -H "Accept: application/json")
  if [ -n "${session_id:-}" ]; then
    headers+=(-H "Mcp-Session-Id: $session_id")
  fi

  local response_headers
  response_headers=$(mktemp)

  local result
  result=$(curl -s -D "$response_headers" \
    "${headers[@]}" \
    -X POST "$MCP_URL" \
    -d "$body" \
    --max-time 30)

  # Extract and cache session ID from response headers
  local new_session_id
  new_session_id=$(grep -i 'mcp-session-id' "$response_headers" 2>/dev/null | sed 's/.*: //' | tr -d '[:space:]' || true)
  if [ -n "$new_session_id" ]; then
    echo "$new_session_id" > "$SESSION_CACHE"
  fi

  rm -f "$response_headers"
  echo "$result"
}

# Helper: initialize MCP session if no session ID cached
ensure_session() {
  if [ -f "$SESSION_CACHE" ]; then
    return
  fi

  local init_body
  init_body=$(jq -n '{
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "feishu-cli", version: "1.0.0" }
    }
  }')

  local init_result
  init_result=$(send_rpc "$init_body")

  # Send initialized notification
  local notify_body
  notify_body=$(jq -n '{
    jsonrpc: "2.0",
    method: "notifications/initialized"
  }')
  send_rpc "$notify_body" >/dev/null 2>&1 || true
}

# ─── Commands ──────────────────────────────────────────────────

cmd="${1:-}"
shift || true

case "$cmd" in
  list-tools)
    ensure_session

    local_body=$(jq -n '{
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    }')

    result=$(send_rpc "$local_body")

    # Pretty-print tool list
    echo "$result" | jq -r '
      .result.tools // [] |
      if length == 0 then "No tools available."
      else
        "Available tools (\(length)):\n" +
        (map(
          "  \(.name)\n    \(.description // "(no description)")"
        ) | join("\n\n"))
      end
    '
    ;;

  call)
    tool_name="${1:-}"
    shift || true
    tool_args="${1:-}"
    [ -z "$tool_args" ] && tool_args="{}"

    if [ -z "$tool_name" ]; then
      echo "Error: tool_name is required"
      echo "Usage: bash feishu-cli.sh call <tool_name> '<json_params>'"
      exit 1
    fi

    ensure_session

    # Build tools/call JSON-RPC request
    call_body=$(jq -n \
      --arg name "$tool_name" \
      --argjson args "$tool_args" \
      '{
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: $name,
          arguments: $args
        }
      }')

    result=$(send_rpc "$call_body")

    # Check for errors
    if echo "$result" | jq -e '.error' >/dev/null 2>&1; then
      echo "Error: $(echo "$result" | jq -r '.error.message // "Unknown error"')"
      exit 1
    fi

    # Print result content
    echo "$result" | jq -r '
      .result.content // [] |
      map(
        if .type == "text" then .text
        elif .type == "image" then "[Image: \(.mimeType // "unknown")]"
        else "[Unknown content type: \(.type)]"
        end
      ) | join("\n")
    '

    # Check if tool reported an error
    if echo "$result" | jq -e '.result.isError == true' >/dev/null 2>&1; then
      exit 1
    fi
    ;;

  *)
    echo "Feishu MCP CLI — HTTP client for Feishu document operations"
    echo ""
    echo "Usage:"
    echo "  bash feishu-cli.sh list-tools                           # 列出所有可用工具"
    echo "  bash feishu-cli.sh call <tool_name> '<json_params>'     # 调用指定工具"
    echo ""
    echo "Examples:"
    echo "  bash feishu-cli.sh call docx_create_document '{\"title\":\"测试\",\"folder_token\":\"xxx\"}'"
    echo "  bash feishu-cli.sh call update_document_content '{\"document_id\":\"xxx\",\"markdown\":\"# 内容\"}'"
    exit 1
    ;;
esac
