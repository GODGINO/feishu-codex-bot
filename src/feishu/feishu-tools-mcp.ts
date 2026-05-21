#!/usr/bin/env node
/**
 * Feishu Tools MCP server (stdio).
 * Provides task, calendar, and bitable operations using OAuth Device Flow for user auth.
 * Uses @larksuiteoapi/node-sdk for API calls with User Access Token.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import * as path from 'node:path';
import {
  startDeviceFlow,
  pollDeviceToken,
  getValidToken,
  saveToken,
  getAuthStatus,
} from './feishu-auth.js';

const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const SESSION_DIR = process.env.SESSION_DIR || '';
const TOKEN_DIR = path.join(SESSION_DIR, 'feishu-tokens');

const ALL_SCOPES = [
  'task:task:write', 'task:task:read', 'task:tasklist:write', 'task:tasklist:read',
  'calendar:calendar:read', 'calendar:calendar.event:create', 'calendar:calendar.event:read',
  'calendar:calendar.event:update', 'calendar:calendar.event:delete',
  'base:record:create', 'base:record:retrieve', 'base:record:update', 'base:record:delete',
  'minutes:minutes.basic:read', 'minutes:minutes.transcript:export',
];

// Pending device flows (in-memory, keyed by user_id)
const pendingFlows = new Map<string, { deviceCode: string; interval: number; expiresAt: number }>();

// Lark SDK client (for API calls)
const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(msg: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
}

/**
 * Get user access token or return auth error message.
 */
async function getUserToken(userId: string): Promise<{ token?: string; error?: ReturnType<typeof err> }> {
  const token = await getValidToken(TOKEN_DIR, userId, APP_ID, APP_SECRET);
  if (!token) {
    const status = getAuthStatus(TOKEN_DIR, userId);
    const msg = status === 'expired'
      ? '用户授权已过期，请重新授权。调用 feishu_auth_start 开始授权流程。'
      : '用户尚未授权飞书账号。请调用 feishu_auth_start 开始 OAuth 授权流程。';
    return { error: err(msg) };
  }
  return { token };
}

/**
 * Call Feishu API with user access token via lark SDK withUserAccessToken option.
 */
function withUAT(accessToken: string): any {
  return lark.withUserAccessToken(accessToken);
}

// ============ Server Setup ============

const server = new McpServer({
  name: 'feishu-tools',
  version: '1.0.0',
});

// ============ Auth Tools ============

server.tool(
  'feishu_auth_start',
  'Start Feishu OAuth authorization. Returns a verification URL for the user to visit and authorize. After the user authorizes, call feishu_auth_poll to complete the flow.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
  },
  async (args) => {
    try {
      const status = getAuthStatus(TOKEN_DIR, args.user_id);
      if (status === 'authorized') {
        return ok('用户已授权，无需重新授权。');
      }

      const result = await startDeviceFlow(APP_ID, APP_SECRET, ALL_SCOPES);
      pendingFlows.set(args.user_id, {
        deviceCode: result.deviceCode,
        interval: result.interval,
        expiresAt: Date.now() + result.expiresIn * 1000,
      });

      const authUrl = result.verificationUri.includes('?')
        ? `${result.verificationUri}&user_code=${result.userCode}`
        : `${result.verificationUri}?user_code=${result.userCode}`;

      return ok(JSON.stringify({
        message: '请让用户打开以下链接完成飞书授权',
        verification_url: authUrl,
        user_code: result.userCode,
        expires_in_seconds: result.expiresIn,
        next_step: '用户授权后，调用 feishu_auth_poll 完成认证',
      }, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_auth_poll',
  'Poll for OAuth authorization completion after user has visited the auth URL. Call this after feishu_auth_start and after the user says they have authorized.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
  },
  async (args) => {
    try {
      const flow = pendingFlows.get(args.user_id);
      if (!flow) {
        return err('没有进行中的授权流程。请先调用 feishu_auth_start。');
      }

      if (Date.now() > flow.expiresAt) {
        pendingFlows.delete(args.user_id);
        return err('授权流程已超时，请重新调用 feishu_auth_start。');
      }

      const result = await pollDeviceToken(APP_ID, APP_SECRET, flow.deviceCode);

      if (result.status === 'pending') {
        return ok('用户尚未完成授权，请等待用户操作后再次调用此工具。');
      }

      if (result.status === 'expired') {
        pendingFlows.delete(args.user_id);
        return err('授权流程已过期，请重新调用 feishu_auth_start。');
      }

      // Success
      pendingFlows.delete(args.user_id);
      if (result.token) {
        result.token.userOpenId = args.user_id;
        saveToken(TOKEN_DIR, result.token);
      }
      return ok('授权成功！现在可以使用飞书任务、日历、多维表格等功能了。');
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_auth_status',
  'Check if a user has authorized their Feishu account.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
  },
  async (args) => {
    const status = getAuthStatus(TOKEN_DIR, args.user_id);
    return ok(JSON.stringify({ user_id: args.user_id, status }));
  },
);

// ============ Task Tools (Task v2 API) ============

server.tool(
  'feishu_task_create',
  'Create a new Feishu task.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    summary: z.string().describe('Task title/summary'),
    description: z.string().optional().describe('Task description (rich text)'),
    due: z.string().optional().describe('Due date in ISO 8601 format (e.g. "2026-03-15T18:00:00+08:00")'),
    origin_href: z.string().optional().describe('Link back to the source'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const taskData: any = { summary: args.summary };
      if (args.description) {
        taskData.description = args.description;
      }
      if (args.due) {
        taskData.due = { timestamp: String(new Date(args.due).getTime()) };
      }
      if (args.origin_href) {
        taskData.origin = { platform_i18n_name: '{"zh_cn": "Sigma Bot"}', href: { url: args.origin_href } };
      }

      const resp = await (client.task.v2.task.create as any)({
        data: taskData,
        params: { user_id_type: 'open_id' },
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Task create failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok(JSON.stringify(resp.data?.task || resp.data, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_task_list',
  'List tasks. Returns the user\'s tasks.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    page_size: z.number().min(1).max(100).default(20).describe('Number of tasks'),
    page_token: z.string().optional().describe('Pagination token'),
    completed: z.boolean().optional().describe('Filter: true for completed, false for incomplete'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const params: any = {
        page_size: args.page_size,
        user_id_type: 'open_id',
      };
      if (args.page_token) params.page_token = args.page_token;
      if (args.completed !== undefined) params.completed = args.completed;

      const resp = await (client.task.v2.task.list as any)({
        params,
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Task list failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok(JSON.stringify({
        items: resp.data?.items || [],
        has_more: resp.data?.has_more,
        page_token: resp.data?.page_token,
      }, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_task_get',
  'Get details of a specific task.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    task_guid: z.string().describe('Task GUID'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const resp = await (client.task.v2.task.get as any)({
        path: { task_guid: args.task_guid },
        params: { user_id_type: 'open_id' },
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Task get failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok(JSON.stringify(resp.data?.task || resp.data, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_task_update',
  'Update a task. Specify only the fields you want to change.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    task_guid: z.string().describe('Task GUID'),
    summary: z.string().optional().describe('New summary'),
    description: z.string().optional().describe('New description'),
    due: z.string().optional().describe('New due date in ISO 8601 format'),
    completed_at: z.string().optional().describe('Set to "0" to mark incomplete, or ISO 8601 to mark complete'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const task: any = {};
      const updateFields: string[] = [];

      if (args.summary !== undefined) {
        task.summary = args.summary;
        updateFields.push('summary');
      }
      if (args.description !== undefined) {
        task.description = args.description;
        updateFields.push('description');
      }
      if (args.due !== undefined) {
        task.due = { timestamp: String(new Date(args.due).getTime()) };
        updateFields.push('due');
      }
      if (args.completed_at !== undefined) {
        if (args.completed_at === '0') {
          task.completed_at = '0';
        } else {
          task.completed_at = String(new Date(args.completed_at).getTime());
        }
        updateFields.push('completed_at');
      }

      if (updateFields.length === 0) {
        return err('No fields specified to update.');
      }

      const resp = await (client.task.v2.task.patch as any)({
        path: { task_guid: args.task_guid },
        data: { task, update_fields: updateFields },
        params: { user_id_type: 'open_id' },
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Task update failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok(JSON.stringify(resp.data?.task || resp.data, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_task_list_tasklists',
  'List task lists (task folders/groups).',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    page_size: z.number().min(1).max(100).default(20).describe('Number of items'),
    page_token: z.string().optional().describe('Pagination token'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const params: any = { page_size: args.page_size, user_id_type: 'open_id' };
      if (args.page_token) params.page_token = args.page_token;

      const resp = await (client.task.v2.tasklist.list as any)({
        params,
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Tasklist list failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok(JSON.stringify({
        items: resp.data?.items || [],
        has_more: resp.data?.has_more,
        page_token: resp.data?.page_token,
      }, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

// ============ Calendar Tools (Calendar v4 API) ============

/**
 * Get the user's primary calendar ID.
 */
async function getPrimaryCalendarId(accessToken: string): Promise<string> {
  const resp = await (client.calendar.calendar.primary as any)({}, withUAT(accessToken));
  if (resp?.code !== 0) {
    throw new Error(`Failed to get primary calendar: ${resp?.msg}`);
  }
  const calendars = resp.data?.calendars || [];
  if (calendars.length === 0) throw new Error('No calendars found');
  return calendars[0].calendar?.calendar_id;
}

/**
 * Convert ISO 8601 date string to Feishu calendar timestamp format (seconds string).
 */
function toCalendarTimestamp(isoDate: string): { timestamp: string } {
  return { timestamp: String(Math.floor(new Date(isoDate).getTime() / 1000)) };
}

server.tool(
  'feishu_calendar_list_events',
  'List calendar events in a date range (max 40 days). Uses the user\'s primary calendar.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    start_time: z.string().describe('Start time in ISO 8601 (e.g. "2026-03-10T00:00:00+08:00")'),
    end_time: z.string().describe('End time in ISO 8601 (e.g. "2026-03-17T00:00:00+08:00")'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const calendarId = await getPrimaryCalendarId(auth.token!);
      const startTs = String(Math.floor(new Date(args.start_time).getTime() / 1000));
      const endTs = String(Math.floor(new Date(args.end_time).getTime() / 1000));

      const resp = await (client.calendar.calendarEvent as any).instanceView({
        path: { calendar_id: calendarId },
        params: { start_time: startTs, end_time: endTs, user_id_type: 'open_id' },
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Calendar list failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok(JSON.stringify({
        items: resp.data?.items || [],
        has_more: resp.data?.has_more,
        page_token: resp.data?.page_token,
      }, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_calendar_create_event',
  'Create a calendar event on the user\'s primary calendar.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    summary: z.string().describe('Event title'),
    start_time: z.string().describe('Start time in ISO 8601'),
    end_time: z.string().describe('End time in ISO 8601'),
    description: z.string().optional().describe('Event description'),
    location: z.string().optional().describe('Event location'),
    attendee_ids: z.array(z.string()).optional().describe('Array of attendee open IDs (ou_xxx)'),
    need_notification: z.boolean().optional().default(true).describe('Send notification to attendees'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const calendarId = await getPrimaryCalendarId(auth.token!);

      const eventData: any = {
        summary: args.summary,
        start_time: toCalendarTimestamp(args.start_time),
        end_time: toCalendarTimestamp(args.end_time),
      };
      if (args.description) eventData.description = args.description;
      if (args.location) eventData.location = { name: args.location };

      const resp = await (client.calendar.calendarEvent.create as any)({
        path: { calendar_id: calendarId },
        data: eventData,
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Event create failed: ${resp?.msg || JSON.stringify(resp)}`);
      }

      const event = resp.data?.event;
      const eventId = event?.event_id;

      // Add attendees if specified
      if (args.attendee_ids && args.attendee_ids.length > 0 && eventId) {
        const attendees = args.attendee_ids.map(id => ({
          type: 'user',
          user_id: id,
        }));
        // Also add the creator so event shows in their calendar
        if (!args.attendee_ids.includes(args.user_id)) {
          attendees.push({ type: 'user', user_id: args.user_id });
        }

        await (client.calendar.calendarEventAttendee.create as any)({
          path: { calendar_id: calendarId, event_id: eventId },
          params: { user_id_type: 'open_id' },
          data: {
            attendees,
            need_notification: args.need_notification,
          },
        }, withUAT(auth.token!));
      }

      return ok(JSON.stringify(event, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_calendar_get_event',
  'Get details of a specific calendar event.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    event_id: z.string().describe('Event ID'),
    calendar_id: z.string().optional().describe('Calendar ID (uses primary if omitted)'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const calendarId = args.calendar_id || await getPrimaryCalendarId(auth.token!);
      const resp = await (client.calendar.calendarEvent.get as any)({
        path: { calendar_id: calendarId, event_id: args.event_id },
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Event get failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok(JSON.stringify(resp.data?.event || resp.data, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_calendar_update_event',
  'Update a calendar event.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    event_id: z.string().describe('Event ID'),
    calendar_id: z.string().optional().describe('Calendar ID (uses primary if omitted)'),
    summary: z.string().optional().describe('New event title'),
    start_time: z.string().optional().describe('New start time in ISO 8601'),
    end_time: z.string().optional().describe('New end time in ISO 8601'),
    description: z.string().optional().describe('New description'),
    location: z.string().optional().describe('New location'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const calendarId = args.calendar_id || await getPrimaryCalendarId(auth.token!);
      const updateData: any = {};
      if (args.summary) updateData.summary = args.summary;
      if (args.start_time) updateData.start_time = toCalendarTimestamp(args.start_time);
      if (args.end_time) updateData.end_time = toCalendarTimestamp(args.end_time);
      if (args.description) updateData.description = args.description;
      if (args.location) updateData.location = { name: args.location };

      const resp = await (client.calendar.calendarEvent.patch as any)({
        path: { calendar_id: calendarId, event_id: args.event_id },
        data: updateData,
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Event update failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok(JSON.stringify(resp.data?.event || resp.data, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_calendar_delete_event',
  'Delete a calendar event.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    event_id: z.string().describe('Event ID'),
    calendar_id: z.string().optional().describe('Calendar ID (uses primary if omitted)'),
    need_notification: z.boolean().optional().default(true).describe('Notify attendees'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const calendarId = args.calendar_id || await getPrimaryCalendarId(auth.token!);
      const resp = await (client.calendar.calendarEvent.delete as any)({
        path: { calendar_id: calendarId, event_id: args.event_id },
        params: { need_notification: args.need_notification },
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Event delete failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok('日历事件已删除。');
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_calendar_search_events',
  'Search calendar events by keyword.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    query: z.string().describe('Search keyword'),
    calendar_id: z.string().optional().describe('Calendar ID (uses primary if omitted)'),
    page_size: z.number().min(1).max(50).default(20).describe('Number of results'),
    page_token: z.string().optional().describe('Pagination token'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const calendarId = args.calendar_id || await getPrimaryCalendarId(auth.token!);
      const params: any = { page_size: args.page_size };
      if (args.page_token) params.page_token = args.page_token;

      const resp = await (client.calendar.calendarEvent as any).search({
        path: { calendar_id: calendarId },
        params,
        data: { query: args.query },
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Event search failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok(JSON.stringify({
        items: resp.data?.items || [],
        has_more: resp.data?.has_more,
        page_token: resp.data?.page_token,
      }, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

// ============ Bitable Tools (Bitable v1 API) ============

server.tool(
  'feishu_bitable_list_records',
  'Search/list records from a Feishu Bitable (multi-dimensional table).',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    app_token: z.string().describe('Bitable app token'),
    table_id: z.string().describe('Table ID'),
    view_id: z.string().optional().describe('View ID to filter by'),
    field_names: z.array(z.string()).optional().describe('Only return these fields'),
    filter: z.string().optional().describe('Filter expression (e.g. AND(CurrentValue.[Status]="Active")'),
    sort: z.array(z.object({
      field_name: z.string(),
      desc: z.boolean().optional(),
    })).optional().describe('Sort by fields'),
    page_size: z.number().min(1).max(500).default(20).describe('Number of records'),
    page_token: z.string().optional().describe('Pagination token'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const data: any = { automatic_fields: true };
      if (args.view_id) data.view_id = args.view_id;
      if (args.field_names) data.field_names = args.field_names;
      if (args.filter) data.filter = args.filter;
      if (args.sort) data.sort = args.sort;

      const params: any = {
        user_id_type: 'open_id',
        page_size: args.page_size,
      };
      if (args.page_token) params.page_token = args.page_token;

      const resp = await (client.bitable.appTableRecord as any).search({
        path: { app_token: args.app_token, table_id: args.table_id },
        params,
        data,
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Record list failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok(JSON.stringify({
        items: resp.data?.items || [],
        total: resp.data?.total,
        has_more: resp.data?.has_more,
        page_token: resp.data?.page_token,
      }, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_bitable_create_record',
  'Create a record in a Feishu Bitable table.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    app_token: z.string().describe('Bitable app token'),
    table_id: z.string().describe('Table ID'),
    fields: z.record(z.string(), z.any()).describe('Field name-value pairs. Text: string, Number: number, Select: string, Multi-select: string[], Date: number (ms timestamp), Checkbox: boolean, Person: [{id: "ou_xxx"}]'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const resp = await (client.bitable.appTableRecord.create as any)({
        path: { app_token: args.app_token, table_id: args.table_id },
        params: { user_id_type: 'open_id' },
        data: { fields: args.fields },
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Record create failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok(JSON.stringify(resp.data?.record || resp.data, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_bitable_update_record',
  'Update a record in a Feishu Bitable table.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    app_token: z.string().describe('Bitable app token'),
    table_id: z.string().describe('Table ID'),
    record_id: z.string().describe('Record ID'),
    fields: z.record(z.string(), z.any()).describe('Field name-value pairs to update'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const resp = await (client.bitable.appTableRecord.update as any)({
        path: { app_token: args.app_token, table_id: args.table_id, record_id: args.record_id },
        params: { user_id_type: 'open_id' },
        data: { fields: args.fields },
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Record update failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok(JSON.stringify(resp.data?.record || resp.data, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_bitable_delete_record',
  'Delete a record from a Feishu Bitable table.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    app_token: z.string().describe('Bitable app token'),
    table_id: z.string().describe('Table ID'),
    record_id: z.string().describe('Record ID'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const resp = await (client.bitable.appTableRecord.delete as any)({
        path: { app_token: args.app_token, table_id: args.table_id, record_id: args.record_id },
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Record delete failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok('记录已删除。');
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_bitable_batch_create',
  'Batch create records in a Feishu Bitable table (max 500).',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    app_token: z.string().describe('Bitable app token'),
    table_id: z.string().describe('Table ID'),
    records: z.array(z.object({
      fields: z.record(z.string(), z.any()),
    })).max(500).describe('Array of records with field name-value pairs'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const resp = await (client.bitable.appTableRecord as any).batchCreate({
        path: { app_token: args.app_token, table_id: args.table_id },
        params: { user_id_type: 'open_id' },
        data: { records: args.records },
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Batch create failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      return ok(JSON.stringify({
        records: resp.data?.records || [],
        total: resp.data?.records?.length || 0,
      }, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

// ============ Minutes (妙记) Tools ============

server.tool(
  'feishu_minutes_get_info',
  'Get meeting minutes (妙记) metadata: title, duration, participants, cover image, URL. Extract minute_token from a minutes URL like https://xxx.feishu.cn/minutes/obcnxxxxxx — the token is the last path segment.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    minute_token: z.string().describe('Minutes token (from URL path, e.g. obcnxxxxxx)'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const resp = await (client.minutes.v1.minute.get as any)({
        path: { minute_token: args.minute_token },
        params: { user_id_type: 'open_id' },
      }, withUAT(auth.token!));

      if (resp?.code !== 0) {
        return err(`Minutes get failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      const data = resp.data?.minute || {};
      return ok(JSON.stringify({
        title: data.title,
        url: data.url,
        duration: data.duration ? `${Math.floor(data.duration / 60)}m${data.duration % 60}s` : undefined,
        owner: data.owner,
        create_time: data.create_time,
        cover: data.cover,
        note_id: data.note_id,
      }, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

server.tool(
  'feishu_minutes_get_transcript',
  'Export meeting minutes (妙记) transcript text with speaker identification. Returns the full transcription with speaker names and optional timestamps.',
  {
    user_id: z.string().describe('User open ID (ou_xxx)'),
    minute_token: z.string().describe('Minutes token (from URL path)'),
    need_speaker: z.boolean().default(true).describe('Include speaker names in transcript'),
    need_timestamp: z.boolean().default(false).describe('Include timestamps in transcript'),
  },
  async (args) => {
    const auth = await getUserToken(args.user_id);
    if (auth.error) return auth.error;

    try {
      const resp = await (client.minutes.v1.minuteTranscript.get as any)({
        path: { minute_token: args.minute_token },
        params: {
          need_speaker: args.need_speaker,
          need_timestamp: args.need_timestamp,
          file_format: 'txt',
        },
      }, withUAT(auth.token!));

      // Transcript API returns binary file stream — convert to string
      if (resp instanceof Buffer) {
        return ok(resp.toString('utf-8'));
      }
      if (resp instanceof ArrayBuffer) {
        return ok(new TextDecoder().decode(resp));
      }
      // Some SDK versions return the data differently
      if (resp?.code !== undefined && resp.code !== 0) {
        return err(`Transcript export failed: ${resp?.msg || JSON.stringify(resp)}`);
      }
      // If resp is already a string or has data
      if (typeof resp === 'string') return ok(resp);
      if (resp?.data) return ok(typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data));
      return ok(String(resp));
    } catch (e: any) {
      return err(e.message);
    }
  },
);

// ============ Start Server ============

async function main() {
  if (!APP_ID || !APP_SECRET) {
    console.error('FEISHU_APP_ID and FEISHU_APP_SECRET environment variables are required');
    process.exit(1);
  }
  if (!SESSION_DIR) {
    console.error('SESSION_DIR environment variable is required');
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
