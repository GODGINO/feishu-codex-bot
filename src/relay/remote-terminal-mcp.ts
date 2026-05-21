#!/usr/bin/env node
/**
 * Remote Terminal MCP Server (stdio transport)
 *
 * Spawned by Claude as a subprocess. Translates MCP tool calls into
 * HTTP POST requests to the relay server, which forwards them to
 * the Sigma Terminal app via WebSocket.
 *
 * Usage: node remote-terminal-mcp.js <sessionKey> [relayUrl]
 *   relayUrl defaults to http://localhost:3333
 */

import * as readline from 'node:readline';

const SESSION_KEY = process.argv[2];
const RELAY_URL = process.argv[3] || 'http://localhost:3333';

if (!SESSION_KEY) {
  process.stderr.write('Usage: remote-terminal-mcp.js <sessionKey> [relayUrl]\n');
  process.exit(1);
}

// ── Tool definitions ──

const TOOLS = [
  {
    name: 'shell_exec',
    description: 'Execute a shell command on the user\'s Mac. Returns stdout, stderr, and exitCode.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        cwd: { type: 'string', description: 'Working directory. Defaults to user home.' },
        timeout: { type: 'integer', description: 'Timeout in ms. Default 60000.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'file_read',
    description: 'Read a file from the user\'s Mac. Returns content with line numbers (like Claude Code Read).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        offset: { type: 'integer', description: 'Line number to start from (0-based). Default 0.' },
        limit: { type: 'integer', description: 'Max lines to read. Default 2000.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description: 'Write/create a file on the user\'s Mac. Overwrites if exists.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_edit',
    description: 'Edit a file by replacing a string. old_string must be unique in the file (unless replace_all). Works like Claude Code Edit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        old_string: { type: 'string', description: 'The exact string to find and replace' },
        new_string: { type: 'string', description: 'The replacement string' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences. Default false.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'glob',
    description: 'Search for files by name pattern on the user\'s Mac.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.js")' },
        path: { type: 'string', description: 'Directory to search in. Defaults to user home.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents by regex pattern on the user\'s Mac.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory to search in. Defaults to cwd.' },
        glob: { type: 'string', description: 'Glob to filter files (e.g. "*.ts")' },
        include: { type: 'string', description: 'File type filter (e.g. "ts", "js")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'system_info',
    description: 'Get system information about the user\'s Mac (OS, arch, shell, home, username, hostname).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'open',
    description: 'Open a URL, file, or application on the user\'s Mac using macOS `open` command.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'URL, file path, or app name to open' },
      },
      required: ['target'],
    },
  },
  {
    name: 'notify',
    description: 'Send a macOS notification to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title' },
        body: { type: 'string', description: 'Notification body text' },
      },
      required: ['title', 'body'],
    },
  },

  // ─── Computer Use (Mac control) ───

  {
    name: 'screenshot',
    description: 'Capture a screenshot of the user\'s Mac screen. Returns base64 PNG. Use this to see what is on the screen before clicking.',
    inputSchema: {
      type: 'object',
      properties: {
        region: {
          type: 'object',
          description: 'Optional region to capture {x, y, w, h}',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
        },
        display: { type: 'integer', description: '1-based display index. Default main display.' },
      },
    },
  },
  {
    name: 'display_info',
    description: 'Get information about all connected displays (resolution, main display).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mouse_move',
    description: 'Move the mouse cursor to absolute screen coordinates.',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'mouse_click',
    description: 'Move to (x, y) and click. Supports left/right/middle button and single/double click.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left' },
        count: { type: 'integer', description: '1 for single click, 2 for double click. Default 1.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'mouse_drag',
    description: 'Drag from one point to another (mouse down → move → mouse up). Use for reordering, drag-and-drop, selection, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        to: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        duration: { type: 'integer', description: 'Drag duration in ms. Default 500.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'mouse_scroll',
    description: 'Scroll at a position. Positive dy scrolls down, negative scrolls up.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        dx: { type: 'integer', description: 'Horizontal scroll amount. Default 0.' },
        dy: { type: 'integer', description: 'Vertical scroll amount. Default 0.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'mouse_position',
    description: 'Get the current mouse cursor position.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'keyboard_type',
    description: 'Type text via keyboard simulation. Use this for entering text into focused inputs.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        delay: { type: 'integer', description: 'Delay between keystrokes in ms. Default 12.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'keyboard_key',
    description: 'Press a key or key combination. Examples: "Enter", "Escape", "cmd+c", "ctrl+shift+t".',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'app_launch',
    description: 'Launch a macOS application by name (e.g. "Safari", "Xcode", "Finder").',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'app_list_running',
    description: 'List currently running foreground applications on the user\'s Mac.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'app_focus',
    description: 'Bring the specified application to the front.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'app_quit',
    description: 'Quit the specified application.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'window_list',
    description: 'List all windows of running applications. Returns title, position, and size for each window.',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', description: 'Filter by app name (optional)' } },
    },
  },
  {
    name: 'window_resize',
    description: 'Move and resize the front window of an application.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['app', 'x', 'y', 'width', 'height'],
    },
  },

  // ─── Phone Use (ADB control of connected Android devices) ───

  {
    name: 'adb_devices',
    description: 'List Android devices connected to the user\'s Mac via USB. Always call this first to get device serials.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'adb_device_info',
    description: 'Get detailed info about a connected Android device (model, manufacturer, Android version, SDK, ABI).',
    inputSchema: {
      type: 'object',
      properties: { serial: { type: 'string', description: 'Device serial. Optional if only one device connected.' } },
    },
  },
  {
    name: 'adb_screenshot',
    description: 'Capture the screen of a connected Android device. Returns base64 PNG. Uses `adb exec-out screencap -p` to avoid binary corruption.',
    inputSchema: {
      type: 'object',
      properties: { serial: { type: 'string', description: 'Device serial. Optional if only one device connected.' } },
    },
  },
  {
    name: 'adb_screen_size',
    description: 'Get the screen resolution of a connected Android device.',
    inputSchema: {
      type: 'object',
      properties: { serial: { type: 'string' } },
    },
  },
  {
    name: 'adb_record_screen',
    description: 'Record the screen of an Android device for a duration (max 180s) and pull the MP4 to local disk.',
    inputSchema: {
      type: 'object',
      properties: {
        serial: { type: 'string' },
        duration: { type: 'integer', description: 'Recording duration in seconds. Default 10. Max 180.' },
        outputPath: { type: 'string', description: 'Local path to save the MP4. Default /tmp/sigma-rec-*.mp4' },
      },
    },
  },
  {
    name: 'adb_tap',
    description: 'Tap at coordinates on an Android device screen.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        serial: { type: 'string' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'adb_swipe',
    description: 'Swipe (drag) from one point to another on an Android device. Use for scrolling, swiping between pages, drag operations.',
    inputSchema: {
      type: 'object',
      properties: {
        x1: { type: 'number' },
        y1: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' },
        duration: { type: 'integer', description: 'Swipe duration in ms. Default 300.' },
        serial: { type: 'string' },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
  },
  {
    name: 'adb_long_press',
    description: 'Long press at a position on an Android device.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        duration: { type: 'integer', description: 'Press duration in ms. Default 1000.' },
        serial: { type: 'string' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'adb_text',
    description: 'Type text into the currently focused input on an Android device.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        serial: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'adb_keyevent',
    description: 'Send a key event to an Android device. Supports friendly names: home, back, menu, enter, delete, power, volumeup, volumedown, recent, search, up, down, left, right. Or raw KEYCODE_*.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        serial: { type: 'string' },
      },
      required: ['key'],
    },
  },
  {
    name: 'adb_install',
    description: 'Install an APK on an Android device. Path must be on the user\'s Mac filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        apkPath: { type: 'string' },
        serial: { type: 'string' },
      },
      required: ['apkPath'],
    },
  },
  {
    name: 'adb_app_list',
    description: 'List installed packages on an Android device. By default only third-party apps.',
    inputSchema: {
      type: 'object',
      properties: {
        serial: { type: 'string' },
        includeSystem: { type: 'boolean', description: 'Include system apps. Default false.' },
      },
    },
  },
  {
    name: 'adb_app_launch',
    description: 'Launch an Android app by package name. Optionally specify activity.',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: 'Package name (e.g. com.android.chrome)' },
        activity: { type: 'string', description: 'Optional activity name' },
        serial: { type: 'string' },
      },
      required: ['package'],
    },
  },
  {
    name: 'adb_app_force_stop',
    description: 'Force stop an Android app by package name.',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string' },
        serial: { type: 'string' },
      },
      required: ['package'],
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
        serverInfo: { name: 'remote-terminal', version: '1.0.0' },
      });

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return jsonrpcResponse(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = await relayCommand(name, args || {});
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

process.stderr.write(`Remote terminal MCP started for session ${SESSION_KEY}\n`);
