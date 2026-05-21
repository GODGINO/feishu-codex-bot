#!/usr/bin/env node
/**
 * Remote Browser MCP Server (stdio transport)
 *
 * Spawned by Claude as a subprocess. Translates MCP tool calls into
 * HTTP POST requests to the relay server, which forwards them to
 * the browser extension via WebSocket.
 *
 * Usage: node remote-browser-mcp.js <sessionKey> [relayUrl]
 *   relayUrl defaults to http://localhost:3333
 */

import * as readline from 'node:readline';

const SESSION_KEY = process.argv[2];
const RELAY_URL = process.argv[3] || 'http://localhost:3333';

if (!SESSION_KEY) {
  process.stderr.write('Usage: remote-browser-mcp.js <sessionKey> [relayUrl]\n');
  process.exit(1);
}

// ── Tool definitions (mirrors chrome-devtools MCP tools) ──

const TOOLS = [
  {
    name: 'take_snapshot',
    description: 'Take a text snapshot of the page based on the a11y tree. Returns element UIDs for interaction.',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Include all a11y info. Default false.' },
      },
    },
  },
  {
    name: 'take_screenshot',
    description: 'Take a screenshot of the page or element.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Element uid to screenshot. Omit for full page.' },
        fullPage: { type: 'boolean', description: 'Capture full page instead of viewport.' },
      },
    },
  },
  {
    name: 'click',
    description: 'Click on an element by its uid from the snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'The uid of the element to click' },
        dblClick: { type: 'boolean', description: 'Double click. Default false.' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'fill',
    description: 'Type text into an input/textarea or select an option.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'The uid of the input element' },
        value: { type: 'string', description: 'The value to fill in' },
      },
      required: ['uid', 'value'],
    },
  },
  {
    name: 'navigate_page',
    description: 'Navigate the page to a URL or back/forward/reload.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        type: { type: 'string', enum: ['url', 'back', 'forward', 'reload'], description: 'Navigation type' },
      },
    },
  },
  {
    name: 'evaluate_script',
    description: 'Execute JavaScript in the page context.',
    inputSchema: {
      type: 'object',
      properties: {
        function: { type: 'string', description: 'JavaScript function to execute' },
        args: {
          type: 'array',
          items: { type: 'object', properties: { uid: { type: 'string' } } },
          description: 'Optional element arguments',
        },
      },
      required: ['function'],
    },
  },
  {
    name: 'type_text',
    description: 'Type text using keyboard into a previously focused input.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to type' },
        submitKey: { type: 'string', description: 'Key to press after typing (e.g., Enter)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a key or key combination (e.g., "Enter", "Control+A").',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key or combination to press' },
      },
      required: ['key'],
    },
  },
  {
    name: 'list_pages',
    description: 'Get a list of pages open in the browser.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'select_page',
    description: 'Select a page as context for future tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'number', description: 'The page ID to select' },
      },
      required: ['pageId'],
    },
  },
  {
    name: 'new_page',
    description: 'Open a new page with the given URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open' },
      },
      required: ['url'],
    },
  },
  {
    name: 'close_page',
    description: 'Close a page by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'number', description: 'The page ID to close' },
      },
      required: ['pageId'],
    },
  },
  {
    name: 'hover',
    description: 'Hover over an element.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'The uid of the element to hover' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'fill_form',
    description: 'Fill out multiple form elements at once.',
    inputSchema: {
      type: 'object',
      properties: {
        elements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              uid: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['uid', 'value'],
          },
        },
      },
      required: ['elements'],
    },
  },
  {
    name: 'wait_for',
    description: 'Wait for text to appear on the page.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'array',
          items: { type: 'string' },
          description: 'Texts to wait for (resolves when any appears)',
        },
        timeout: { type: 'integer', description: 'Max wait time in ms' },
      },
      required: ['text'],
    },
  },
];

// ── JSON-RPC helpers ──

function jsonrpcResponse(id: number | string | null, result: unknown) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonrpcError(id: number | string | null, code: number, message: string) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── Relay communication ──

async function relayCommand(tool: string, params: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(`${RELAY_URL}/api/relay/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionKey: SESSION_KEY, tool, params }),
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as any;
    throw new Error(body.error || `Relay HTTP ${resp.status}`);
  }

  const data = await resp.json() as any;
  return data.result;
}

// ── MCP protocol handler ──

async function handleRequest(msg: any): Promise<string | null> {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return jsonrpcResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'remote-browser', version: '1.0.0' },
      });

    case 'notifications/initialized':
      return null; // No response needed for notifications

    case 'tools/list':
      return jsonrpcResponse(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = await relayCommand(name, args || {});
        // MCP expects content array
        const content = typeof result === 'string'
          ? [{ type: 'text', text: result }]
          : [{ type: 'text', text: JSON.stringify(result, null, 2) }];
        return jsonrpcResponse(id, { content });
      } catch (err: any) {
        return jsonrpcResponse(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }

    default:
      return jsonrpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ── stdio transport ──

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  try {
    const msg = JSON.parse(line);
    const response = await handleRequest(msg);
    if (response) {
      process.stdout.write(response + '\n');
    }
  } catch (err: any) {
    process.stderr.write(`Parse error: ${err.message}\n`);
  }
});

process.stderr.write(`Remote browser MCP started for session ${SESSION_KEY}\n`);
