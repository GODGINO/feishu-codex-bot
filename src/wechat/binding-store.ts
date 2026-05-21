/**
 * Per-session WeChat binding storage.
 * Manages wechat-binding.json, wechat-sync.json, and wechat-contexts.json
 * within a session directory.
 */

import fs from 'node:fs';
import path from 'node:path';

// --- Types ---

export interface WechatBinding {
  wechatUserId: string;
  botToken: string;
  ilinkBotId: string;
  baseUrl: string;
  boundAt: number;
  status: 'active' | 'inactive';
}

interface SyncState {
  cursor: string;
}

type ContextMap = Record<string, string>; // wxid → context_token

// --- File names ---

const BINDING_FILE = 'wechat-binding.json';
const SYNC_FILE = 'wechat-sync.json';
const CONTEXTS_FILE = 'wechat-contexts.json';

// --- Helpers ---

function readJson<T>(filePath: string): T | null {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// --- Public API ---

export const BindingStore = {
  /** Load binding for a session. Returns null if not bound. */
  loadBinding(sessionDir: string): WechatBinding | null {
    return readJson<WechatBinding>(path.join(sessionDir, BINDING_FILE));
  },

  /** Save binding for a session. */
  saveBinding(sessionDir: string, binding: WechatBinding): void {
    writeJson(path.join(sessionDir, BINDING_FILE), binding);
  },

  /** Remove binding (delete file). */
  removeBinding(sessionDir: string): void {
    const filePath = path.join(sessionDir, BINDING_FILE);
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  },

  /** Load long-poll cursor. */
  loadCursor(sessionDir: string): string {
    const state = readJson<SyncState>(path.join(sessionDir, SYNC_FILE));
    return state?.cursor ?? '';
  },

  /** Save long-poll cursor. */
  saveCursor(sessionDir: string, cursor: string): void {
    writeJson(path.join(sessionDir, SYNC_FILE), { cursor });
  },

  /** Load all context tokens. */
  loadContexts(sessionDir: string): ContextMap {
    return readJson<ContextMap>(path.join(sessionDir, CONTEXTS_FILE)) ?? {};
  },

  /** Get context token for a specific WeChat user. */
  getContextToken(sessionDir: string, wechatUserId: string): string | null {
    const map = this.loadContexts(sessionDir);
    return map[wechatUserId] ?? null;
  },

  /** Save/update context token for a WeChat user. */
  saveContextToken(sessionDir: string, wechatUserId: string, contextToken: string): void {
    const map = this.loadContexts(sessionDir);
    map[wechatUserId] = contextToken;
    writeJson(path.join(sessionDir, CONTEXTS_FILE), map);
  },

  /** Remove all WeChat data files from session directory. */
  removeAll(sessionDir: string): void {
    for (const file of [BINDING_FILE, SYNC_FILE, CONTEXTS_FILE]) {
      try { fs.unlinkSync(path.join(sessionDir, file)); } catch { /* ignore */ }
    }
  },

  /** Check if a session has an active WeChat binding. */
  isActive(sessionDir: string): boolean {
    const binding = this.loadBinding(sessionDir);
    return binding?.status === 'active';
  },
};
