#!/usr/bin/env node
/**
 * Bot-level Feishu IM MCP server (stdio).
 * Provides message reading capabilities using the bot's app credentials.
 * This is a standalone MCP server that Claude Code connects to via stdio.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const BASE_URL = 'https://open.feishu.cn/open-apis';

let tenantToken = '';
let tokenExpiry = 0;

async function getTenantToken(): Promise<string> {
  if (tenantToken && Date.now() < tokenExpiry) return tenantToken;

  const resp = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const data = await resp.json() as any;
  if (data.code !== 0) throw new Error(`Token error: ${data.msg}`);
  tenantToken = data.tenant_access_token;
  tokenExpiry = Date.now() + (data.expire - 60) * 1000; // Refresh 60s early
  return tenantToken;
}

async function feishuGet(path: string, params?: Record<string, string>): Promise<any> {
  const token = await getTenantToken();
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }
  }
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return resp.json();
}

const server = new McpServer({
  name: 'feishu-im',
  version: '1.0.0',
});

// Tool: Get messages from a chat
server.tool(
  'feishu_bot_get_messages',
  'Read message history from a Feishu chat (group or DM). Returns recent messages in chronological order.',
  {
    container_id: z.string().describe('Chat ID (oc_xxx for group, ou_xxx for DM)'),
    container_id_type: z.enum(['chat']).default('chat').describe('Container type, always "chat"'),
    start_time: z.string().optional().describe('Start timestamp in seconds (e.g. "1700000000")'),
    end_time: z.string().optional().describe('End timestamp in seconds'),
    page_size: z.number().min(1).max(50).default(20).describe('Number of messages to return (max 50)'),
    page_token: z.string().optional().describe('Pagination token for next page'),
    sort_type: z.enum(['ByCreateTimeAsc', 'ByCreateTimeDesc']).default('ByCreateTimeDesc').describe('Sort order'),
  },
  async (args) => {
    try {
      const params: Record<string, string> = {
        container_id_type: args.container_id_type,
        container_id: args.container_id,
        page_size: String(args.page_size),
        sort_type: args.sort_type,
      };
      if (args.start_time) params.start_time = args.start_time;
      if (args.end_time) params.end_time = args.end_time;
      if (args.page_token) params.page_token = args.page_token;

      const data = await feishuGet('/im/v1/messages', params);
      if (data.code !== 0) {
        return { content: [{ type: 'text' as const, text: `Error: ${data.msg}` }] };
      }

      const messages = (data.data?.items || []).map((m: any) => {
        let content = '';
        try {
          const parsed = JSON.parse(m.body?.content || '{}');
          if (m.msg_type === 'text') content = parsed.text || '';
          else if (m.msg_type === 'post') {
            const body = parsed.zh_cn?.content || parsed.en_us?.content || [];
            content = body.flat().filter((e: any) => e.tag === 'text').map((e: any) => e.text).join('');
          } else if (m.msg_type === 'interactive') {
            content = '[Card message]';
          } else {
            content = `[${m.msg_type}]`;
          }
        } catch { content = '[unparseable]'; }

        return {
          message_id: m.message_id,
          msg_type: m.msg_type,
          sender_id: m.sender?.id,
          sender_type: m.sender?.sender_type,
          create_time: m.create_time,
          content,
        };
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            messages,
            has_more: data.data?.has_more,
            page_token: data.data?.page_token,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] };
    }
  },
);

// Tool: Get thread (reply chain) messages
server.tool(
  'feishu_bot_get_thread',
  'Read reply thread messages for a specific message.',
  {
    message_id: z.string().describe('The parent message ID to get replies for'),
    page_size: z.number().min(1).max(50).default(20).describe('Number of replies to return'),
    page_token: z.string().optional().describe('Pagination token'),
  },
  async (args) => {
    try {
      const token = await getTenantToken();
      const url = new URL(`${BASE_URL}/im/v1/messages/${args.message_id}/replies`);
      url.searchParams.set('page_size', String(args.page_size));
      if (args.page_token) url.searchParams.set('page_token', args.page_token);

      const resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json() as any;

      if (data.code !== 0) {
        return { content: [{ type: 'text' as const, text: `Error: ${data.msg}` }] };
      }

      const items = (data.data?.items || []).map((m: any) => {
        let content = '';
        try {
          const parsed = JSON.parse(m.body?.content || '{}');
          if (m.msg_type === 'text') content = parsed.text || '';
          else content = `[${m.msg_type}]`;
        } catch { content = '[unparseable]'; }

        return {
          message_id: m.message_id,
          sender_id: m.sender?.id,
          create_time: m.create_time,
          content,
        };
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ items, has_more: data.data?.has_more, page_token: data.data?.page_token }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] };
    }
  },
);

// Tool: Search messages
server.tool(
  'feishu_bot_search_messages',
  'Search messages across chats the bot has access to.',
  {
    query: z.string().describe('Search query text'),
    chat_id: z.string().optional().describe('Limit search to a specific chat'),
    message_type: z.enum(['text', 'post', 'file', 'image']).optional().describe('Filter by message type'),
    start_time: z.string().optional().describe('Start timestamp in seconds'),
    end_time: z.string().optional().describe('End timestamp in seconds'),
    page_size: z.number().min(1).max(20).default(10).describe('Number of results'),
    page_token: z.string().optional().describe('Pagination token'),
  },
  async (args) => {
    try {
      const token = await getTenantToken();
      const url = new URL(`${BASE_URL}/im/v1/messages/search`);
      url.searchParams.set('query', args.query);
      url.searchParams.set('page_size', String(args.page_size));
      if (args.chat_id) url.searchParams.set('chat_id', args.chat_id);
      if (args.message_type) url.searchParams.set('message_type', args.message_type);
      if (args.start_time) url.searchParams.set('start_time', args.start_time);
      if (args.end_time) url.searchParams.set('end_time', args.end_time);
      if (args.page_token) url.searchParams.set('page_token', args.page_token);

      const resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json() as any;

      if (data.code !== 0) {
        return { content: [{ type: 'text' as const, text: `Error: ${data.msg}` }] };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            items: data.data?.items || [],
            has_more: data.data?.has_more,
            page_token: data.data?.page_token,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] };
    }
  },
);

// Tool: Download resource (image/file) from a message
server.tool(
  'feishu_bot_download_resource',
  'Download an image or file from a Feishu message. Returns the file path where it was saved.',
  {
    message_id: z.string().describe('The message ID containing the resource'),
    file_key: z.string().describe('The file_key or image_key of the resource'),
    type: z.enum(['image', 'file']).describe('Resource type'),
    save_path: z.string().optional().describe('Path to save the file (default: /tmp/<file_key>)'),
  },
  async (args) => {
    try {
      const token = await getTenantToken();
      const url = `${BASE_URL}/im/v1/messages/${args.message_id}/resources/${args.file_key}?type=${args.type}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!resp.ok) {
        return { content: [{ type: 'text' as const, text: `Download failed: HTTP ${resp.status}` }] };
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const savePath = args.save_path || `/tmp/${args.file_key}`;

      const { writeFile } = await import('node:fs/promises');
      await writeFile(savePath, buffer);

      return {
        content: [{
          type: 'text' as const,
          text: `Downloaded ${buffer.length} bytes to ${savePath}`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] };
    }
  },
);

// Start server
async function main() {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    console.error('FEISHU_APP_ID and FEISHU_APP_SECRET environment variables are required');
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
