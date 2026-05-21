#!/usr/bin/env node
'use strict';

/**
 * Session-scoped Memory MCP Server
 *
 * A lightweight MCP (Model Context Protocol) server that proxies the claude-mem
 * worker HTTP API. All reads/writes are scoped to SESSION_KEY via the `project` field.
 *
 * Tools:
 *   - remember: Save a memory (text, optional title/type)
 *   - recall:   Search memories for this session
 *
 * Environment:
 *   - SESSION_KEY: Required. Used as the `project` field for isolation.
 *   - CLAUDE_MEM_WORKER_PORT: Optional. Defaults to 37777.
 */

const http = require('node:http');

const SESSION_KEY = process.env.SESSION_KEY || '';
const WORKER_PORT = parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777', 10);
const WORKER_HOST = '127.0.0.1';

if (!SESSION_KEY) {
  process.stderr.write('[memory-mcp] WARNING: SESSION_KEY not set, memories will not be scoped\n');
}

// ─── HTTP helpers ──────────────────────────────────────────────

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: WORKER_HOST, port: WORKER_PORT, path }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: 'Invalid JSON', raw: data.slice(0, 500) }); }
      });
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('HTTP timeout')); });
  });
}

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: WORKER_HOST,
      port: WORKER_PORT,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: 'Invalid JSON', raw: data.slice(0, 500) }); }
      });
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.write(payload);
    req.end();
  });
}

// ─── Tool implementations ──────────────────────────────────────

async function handleRemember(args) {
  const { text, title, type } = args;
  if (!text) return { content: [{ type: 'text', text: 'Error: text parameter is required' }], isError: true };

  try {
    const result = await httpPost('/api/memory/save', {
      text,
      title: title || undefined,
      type: type || 'note',
      project: SESSION_KEY,
    });

    if (result.success) {
      return { content: [{ type: 'text', text: `Saved memory #${result.id}: ${result.title || title || '(untitled)'}` }] };
    }
    return { content: [{ type: 'text', text: `Failed to save: ${JSON.stringify(result)}` }], isError: true };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
}

async function handleRecall(args) {
  const { query, limit } = args;
  const maxResults = Math.min(limit || 20, 50);

  try {
    let items;

    if (query) {
      // Full-text search with project filter
      const all = await httpGet(`/api/observations?project=${encodeURIComponent(SESSION_KEY)}&limit=200&orderBy=created_at_epoch&order=desc`);
      const allItems = all.items || [];
      // Client-side filter by query (case-insensitive)
      const q = query.toLowerCase();
      items = allItems.filter((item) => {
        const searchable = [item.title, item.subtitle, item.narrative, item.text, item.facts, item.concepts]
          .filter(Boolean).join(' ').toLowerCase();
        return searchable.includes(q);
      }).slice(0, maxResults);
    } else {
      // Just get recent memories for this session
      const result = await httpGet(`/api/observations?project=${encodeURIComponent(SESSION_KEY)}&limit=${maxResults}&orderBy=created_at_epoch&order=desc`);
      items = result.items || [];
    }

    if (items.length === 0) {
      return { content: [{ type: 'text', text: query ? `No memories found for "${query}"` : 'No memories saved yet for this session.' }] };
    }

    const lines = items.map((item) => {
      const date = item.created_at ? new Date(item.created_at_epoch).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
      const title = item.title || '(untitled)';
      const narrative = item.narrative ? `\n   ${item.narrative.slice(0, 200)}` : '';
      return `#${item.id} [${item.type || 'note'}] ${title} (${date})${narrative}`;
    });

    return { content: [{ type: 'text', text: `Found ${items.length} memories:\n\n${lines.join('\n\n')}` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
}

// ─── MCP Protocol (JSON-RPC over stdio) ────────────────────────

const TOOLS = [
  {
    name: 'remember',
    description: '保存一条记忆到持久化数据库，跨会话可用。用于记住用户偏好、重要事实、待办事项等。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容（必填）' },
        title: { type: 'string', description: '简短标题（可选）' },
        type: { type: 'string', description: '类型：note/discovery/decision/preference（可选，默认 note）', enum: ['note', 'discovery', 'decision', 'preference'] },
      },
      required: ['text'],
    },
  },
  {
    name: 'recall',
    description: '搜索之前保存的记忆。不传 query 则返回最近的记忆列表。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（可选，不传则返回最近记忆）' },
        limit: { type: 'number', description: '最大返回条数（默认 20，最大 50）' },
      },
    },
  },
];

const SERVER_INFO = {
  name: 'memory',
  version: '1.0.0',
};

function handleRequest(msg) {
  const { method, params, id } = msg;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };

    case 'notifications/initialized':
      return null; // No response for notifications

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    case 'tools/call':
      // Async — handled separately
      return 'async';

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return {
        jsonrpc: '2.0', id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

async function handleToolCall(msg) {
  const { params, id } = msg;
  const toolName = params?.name;
  const args = params?.arguments || {};

  let result;
  switch (toolName) {
    case 'remember':
      result = await handleRemember(args);
      break;
    case 'recall':
      result = await handleRecall(args);
      break;
    default:
      result = { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true };
  }

  return { jsonrpc: '2.0', id, result };
}

// ─── stdio transport (Buffer-based for correct Content-Length handling) ───

let buffer = Buffer.alloc(0);

function sendMessage(msg) {
  if (!msg) return;
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json, 'utf-8')}\r\n\r\n`;
  process.stdout.write(header + json);
}

const HEADER_DELIM = Buffer.from('\r\n\r\n');

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
      const response = handleRequest(msg);

      if (response === 'async') {
        handleToolCall(msg).then(sendMessage).catch((err) => {
          sendMessage({
            jsonrpc: '2.0', id: msg.id,
            error: { code: -32603, message: err.message },
          });
        });
      } else {
        sendMessage(response);
      }
    } catch (err) {
      process.stderr.write(`[memory-mcp] Parse error: ${err.message}\n`);
    }
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

process.stdin.on('end', () => {
  process.exit(0);
});

process.stderr.write(`[memory-mcp] Started for session: ${SESSION_KEY}\n`);
