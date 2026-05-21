#!/usr/bin/env node
/**
 * CLI entry for the claude-mem proxy stdio MCP server.
 * The proxy module starts itself on import (it sets up readline on stdin
 * and spawns the upstream child lazily). This file just imports it.
 */
import './claude-mem-proxy-mcp.js';
