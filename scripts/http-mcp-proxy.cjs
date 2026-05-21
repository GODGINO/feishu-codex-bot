#!/usr/bin/env node
'use strict';

/**
 * HTTP-to-stdio MCP proxy
 *
 * Wraps any Streamable HTTP MCP server as a stdio MCP server.
 * Claude Code connects via stdio; this proxy forwards JSON-RPC
 * requests to the HTTP endpoint and returns responses.
 *
 * Environment:
 *   MCP_HTTP_URL: Required. The HTTP MCP server URL.
 */

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const MCP_URL = process.env.MCP_HTTP_URL || '';
if (!MCP_URL) {
  process.stderr.write('[http-mcp-proxy] ERROR: MCP_HTTP_URL not set\n');
  process.exit(1);
}

const parsedUrl = new URL(MCP_URL);
const isHttps = parsedUrl.protocol === 'https:';
const transport = isHttps ? https : http;

// Track session ID from server (for Streamable HTTP protocol)
let sessionId = null;

function httpPost(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    const req = transport.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers,
    }, (res) => {
      // Capture session ID from response
      const sid = res.headers['mcp-session-id'];
      if (sid) sessionId = sid;

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ error: 'Invalid JSON from server', raw: data.slice(0, 500) });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.write(payload);
    req.end();
  });
}

// ─── stdio transport (Buffer-based) ───

let buffer = Buffer.alloc(0);
const HEADER_DELIM = Buffer.from('\r\n\r\n');

function sendMessage(msg) {
  if (!msg) return;
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json, 'utf-8')}\r\n\r\n`;
  process.stdout.write(header + json);
}

function processBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf(HEADER_DELIM);
    if (headerEnd === -1) break;

    const headerStr = buffer.slice(0, headerEnd).toString('utf-8');
    const match = headerStr.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break;

    const body = buffer.slice(bodyStart, bodyStart + contentLength).toString('utf-8');
    buffer = buffer.slice(bodyStart + contentLength);

    try {
      const msg = JSON.parse(body);
      handleMessage(msg);
    } catch (err) {
      process.stderr.write(`[http-mcp-proxy] Parse error: ${err.message}\n`);
    }
  }
}

async function handleMessage(msg) {
  // Notifications (no id) — forward but don't expect response
  if (msg.id === undefined || msg.id === null) {
    try {
      await httpPost(msg);
    } catch (err) {
      process.stderr.write(`[http-mcp-proxy] Notification forward error: ${err.message}\n`);
    }
    return;
  }

  // Requests — forward and relay response
  pendingRequests++;
  try {
    const response = await httpPost(msg);
    sendMessage(response);
  } catch (err) {
    sendMessage({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32603, message: `Proxy error: ${err.message}` },
    });
  } finally {
    pendingRequests--;
    if (stdinEnded && pendingRequests === 0) process.exit(0);
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

let pendingRequests = 0;
let stdinEnded = false;

process.stdin.on('end', () => {
  stdinEnded = true;
  if (pendingRequests === 0) process.exit(0);
});

process.stderr.write(`[http-mcp-proxy] Proxying to ${MCP_URL.slice(0, 50)}...\n`);
