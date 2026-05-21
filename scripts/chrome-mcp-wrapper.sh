#!/bin/bash
# Wrapper script: starts chrome-devtools-mcp connecting to session's Chrome instance.
# If Chrome is not running on the specified port, starts it first via start-chrome.sh.
# Usage: chrome-mcp-wrapper.sh <port> <user-data-dir> [extra mcp args...]

PORT="$1"
USER_DATA_DIR="$2"
shift 2

# Ensure Chrome is running on the expected port before starting MCP.
# This prevents chrome-devtools-mcp from auto-launching Chrome on a default port (e.g. 9350).
if ! curl -s --max-time 2 "http://127.0.0.1:${PORT}/json/version" > /dev/null 2>&1; then
  # Try to find and run start-chrome.sh from the session directory
  SESSION_DIR="$(dirname "${USER_DATA_DIR}")"
  if [ -f "${SESSION_DIR}/start-chrome.sh" ]; then
    bash "${SESSION_DIR}/start-chrome.sh" > /dev/null 2>&1 &
    # Wait up to 10 seconds for Chrome to be ready
    for i in $(seq 1 10); do
      if curl -s --max-time 1 "http://127.0.0.1:${PORT}/json/version" > /dev/null 2>&1; then
        break
      fi
      sleep 1
    done
  fi
fi

# Start the MCP server, connecting to our session's Chrome instance.
exec npx -y chrome-devtools-mcp@latest \
  --browser-url="http://127.0.0.1:${PORT}" \
  --userDataDir="${USER_DATA_DIR}" \
  "$@"
