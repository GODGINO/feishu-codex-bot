#!/bin/bash
# Session-scoped memory MCP server wrapper
# Usage: memory-mcp-wrapper.sh (reads SESSION_KEY from environment)
exec node "$(dirname "$0")/memory-mcp.cjs"
