import { Router } from 'express';
import type { Request, Response } from 'express';
import type * as lark from '@larksuiteoapi/node-sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0] : v;
}

export function createRoutes(sessionsDir: string, feishuClient?: lark.Client): Router {
  const router = Router();

  // ── Caches (persisted to disk) ──
  const nameCache = new Map<string, string>();      // open_id → user name
  const chatNameCache = new Map<string, string>();   // chat_id → group name
  const projectRoot = path.dirname(sessionsDir);
  const nameCachePath = path.join(projectRoot, '.name-cache.json');
  const chatNameCachePath = path.join(projectRoot, '.chat-name-cache.json');

  // Load persisted cache
  try {
    const saved = JSON.parse(fs.readFileSync(nameCachePath, 'utf-8'));
    for (const [k, v] of Object.entries(saved)) {
      nameCache.set(k, v as string);
    }
  } catch { /* no cache file yet */ }

  // Load chat name cache
  try {
    const saved = JSON.parse(fs.readFileSync(chatNameCachePath, 'utf-8'));
    for (const [k, v] of Object.entries(saved)) {
      chatNameCache.set(k, v as string);
    }
  } catch { /* no cache file yet */ }

  function persistNameCache() {
    try {
      fs.writeFileSync(nameCachePath, JSON.stringify(Object.fromEntries(nameCache), null, 2));
    } catch { /* ignore */ }
  }

  function persistChatNameCache() {
    try {
      fs.writeFileSync(chatNameCachePath, JSON.stringify(Object.fromEntries(chatNameCache), null, 2));
    } catch { /* ignore */ }
  }

  async function resolveUserName(openId: string): Promise<string | null> {
    if (nameCache.has(openId)) return nameCache.get(openId)!;
    if (!feishuClient) return null;
    try {
      const resp = await (feishuClient as any).request({
        method: 'GET',
        url: `/open-apis/contact/v3/users/${openId}`,
        params: { user_id_type: 'open_id' },
      });
      const name = resp?.data?.user?.name;
      if (name) {
        nameCache.set(openId, name);
        persistNameCache();
        return name;
      }
    } catch { /* API error, skip */ }
    return null;
  }

  // Batch resolve multiple open_ids (fire and forget for background warming)
  async function resolveOpenIds(openIds: string[]): Promise<void> {
    const unresolved = openIds.filter(id => !nameCache.has(id));
    await Promise.allSettled(unresolved.map(id => resolveUserName(id)));
  }

  async function resolveChatName(chatId: string): Promise<string | null> {
    if (chatNameCache.has(chatId)) return chatNameCache.get(chatId)!;
    if (!feishuClient) return null;
    try {
      const resp = await (feishuClient as any).request({
        method: 'GET',
        url: `/open-apis/im/v1/chats/${chatId}`,
      });
      const name = resp?.data?.name;
      if (name) {
        chatNameCache.set(chatId, name);
        persistChatNameCache();
        return name;
      }
    } catch { /* API error, skip */ }
    return null;
  }

  // Background: warm caches on startup
  if (feishuClient) {
    setTimeout(async () => {
      const openIds = new Set<string>();
      const chatIds = new Set<string>();
      try {
        const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          // Extract open_ids from DM session keys
          if (e.name.startsWith('dm_ou_')) {
            openIds.add(e.name.replace('dm_', ''));
          }
          // Extract chat_id for group sessions
          if (e.name.startsWith('group_')) {
            const chatId = readText(path.join(sessionsDir, e.name, 'chat-id')) || e.name.replace('group_', '');
            if (chatId && !chatNameCache.has(chatId)) chatIds.add(chatId);
          }
          // Extract from group-context.json senderOpenId
          const ctx = readJson(path.join(sessionsDir, e.name, 'group-context.json'));
          if (Array.isArray(ctx)) {
            for (const msg of ctx) {
              if (msg.senderOpenId) openIds.add(msg.senderOpenId);
            }
          }
        }
      } catch { /* ignore */ }
      await Promise.all([
        resolveOpenIds([...openIds]),
        Promise.allSettled([...chatIds].map(id => resolveChatName(id))),
      ]);
    }, 2000);
  }

  // Shared (built-in) skill folder names
  const sharedSkillsDir = path.join(process.cwd(), 'skills');
  const builtinSkillFolders = new Set<string>();
  try {
    for (const e of fs.readdirSync(sharedSkillsDir, { withFileTypes: true })) {
      if (e.isDirectory()) builtinSkillFolders.add(e.name);
    }
  } catch { /* ignore */ }

  // Helper: scan a directory for env var references ($VAR or ${VAR})
  function scanEnvVarRefs(dir: string): string[] {
    const refs = new Set<string>();
    const scanFile = (filePath: string) => {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const matches = content.matchAll(/\$\{?([A-Z][A-Z0-9_]*)\}?/g);
        for (const m of matches) refs.add(m[1]);
      } catch { /* skip */ }
    };
    try {
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.sh') || e.name === 'SKILL.md') scanFile(p);
        }
      };
      walk(dir);
    } catch { /* skip */ }
    return [...refs];
  }

  // Also scan session root for standalone scripts that reference env vars
  function scanSessionScriptRefs(sessionDir: string): Map<string, string[]> {
    // Map script basename -> env var refs
    const result = new Map<string, string[]>();
    try {
      for (const e of fs.readdirSync(sessionDir, { withFileTypes: true })) {
        if (!e.isFile() || !e.name.endsWith('.sh')) continue;
        const refs = new Set<string>();
        try {
          const content = fs.readFileSync(path.join(sessionDir, e.name), 'utf-8');
          // Check if script mentions "session.env" or env var comments
          const matches = content.matchAll(/\$\{?([A-Z][A-Z0-9_]*)\}?/g);
          for (const m of matches) refs.add(m[1]);
        } catch { /* skip */ }
        if (refs.size > 0) result.set(e.name, [...refs]);
      }
    } catch { /* skip */ }
    return result;
  }

  // Helper: read skills from session directory
  function readSkills(sessionDir: string, envKeys?: Set<string>): { folder: string; name: string; description: string; content: string; disabled: boolean; builtin: boolean; envVars: string[] }[] {
    const skillsDir = path.join(sessionDir, '.claude', 'skills');
    try {
      if (!fs.existsSync(skillsDir)) return [];
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      const skills: { folder: string; name: string; description: string; content: string; disabled: boolean; builtin: boolean; envVars: string[] }[] = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const skillFile = path.join(skillsDir, e.name, 'SKILL.md');
        try {
          const content = fs.readFileSync(skillFile, 'utf-8');
          // Parse YAML frontmatter if present
          let name = e.name;
          let description = '';
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const fm = fmMatch[1];
            const nameMatch = fm.match(/^name:\s*(.+)/m);
            const descMatch = fm.match(/^description:\s*(?:>\s*)?\n?\s*(.+(?:\n\s+.+)*)/m);
            if (nameMatch) name = nameMatch[1].trim();
            if (descMatch) description = descMatch[1].replace(/\n\s+/g, ' ').trim();
          }
          // Fallback: use first heading as description
          if (!description) {
            const headingMatch = content.match(/^#\s+(.+)/m);
            if (headingMatch) description = headingMatch[1].trim();
          }
          const disabled = fs.existsSync(path.join(skillsDir, e.name, '.disabled'));
          const builtin = builtinSkillFolders.has(e.name);
          // Scan for env var references, filter to only those in session.env
          let envVars: string[] = [];
          if (envKeys && envKeys.size > 0) {
            const refs = scanEnvVarRefs(path.join(skillsDir, e.name));
            envVars = refs.filter(r => envKeys.has(r));
          }
          skills.push({ folder: e.name, name, description, content, disabled, builtin, envVars });
        } catch { /* skip unreadable */ }
      }
      return skills;
    } catch {
      return [];
    }
  }

  // Helper: write signal file
  function signalMcpChanged(sessionDir: string): void {
    try { fs.writeFileSync(path.join(sessionDir, '.mcp-changed'), String(Date.now())); } catch { /* ignore */ }
  }
  function signalCronChanged(sessionDir: string): void {
    try { fs.writeFileSync(path.join(sessionDir, '.cron-changed'), String(Date.now())); } catch { /* ignore */ }
  }
  function signalAlertsChanged(sessionDir: string): void {
    try { fs.writeFileSync(path.join(sessionDir, '.alerts-changed'), String(Date.now())); } catch { /* ignore */ }
  }

  // Helper: validate session key (prevent path traversal)
  function validSessionKey(key: string): boolean {
    return /^(group_|dm_)[a-zA-Z0-9_]+$/.test(key);
  }
  function validFolder(name: string): boolean {
    return !!name && !name.includes('/') && !name.includes('..') && !name.includes('\0');
  }

  // Helper: read JSON file safely
  function readJson(filePath: string): any {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  // Helper: read text file safely
  function readText(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8').trim();
    } catch {
      return null;
    }
  }

  // Helper: get session summary
  function getSessionSummary(key: string) {
    const dir = path.join(sessionsDir, key);
    const isGroup = key.startsWith('group_');
    const isDm = key.startsWith('dm_');
    const chatId = readText(path.join(dir, 'chat-id')) || (isGroup ? key.replace('group_', '') : null);
    const autoReply = readText(path.join(dir, 'auto-reply'));
    const cronJobs = readJson(path.join(dir, 'cron-jobs.json'));
    const alerts = readJson(path.join(dir, 'alerts.json'));
    const context = readJson(path.join(dir, 'group-context.json'));
    const hasEmail = fs.existsSync(path.join(dir, 'email-accounts.json'));
    const hasKnowledge = fs.existsSync(path.join(dir, 'CLAUDE.md'));
    const skills = readSkills(dir);

    // Collect members from group-context (actual message senders) + DM owner
    const memberNames = new Map<string, string>();
    const membersDir = path.join(dir, 'members');

    // From group-context: real senders in this session
    if (context) {
      const entries = Array.isArray(context) ? context : Object.values(context).flat();
      for (const msg of entries as any[]) {
        const sid = msg?.senderId;
        if (sid?.startsWith('ou_') && !memberNames.has(sid)) {
          memberNames.set(sid, msg.senderName && msg.senderName !== '未知用户' ? msg.senderName : sid);
        }
      }
    }

    // DM: ensure the owner is included
    if (isDm) {
      const openId = key.replace('dm_', '');
      if (!memberNames.has(openId)) memberNames.set(openId, openId);
    }

    // Enrich names from member profiles
    try {
      if (fs.existsSync(membersDir)) {
        for (const [openId] of memberNames) {
          try {
            const profile = readJson(path.join(membersDir, openId, 'profile.json'));
            if (profile?.name && profile.name !== openId) memberNames.set(openId, profile.name);
          } catch { /* skip */ }
        }
      }
    } catch { /* ignore */ }

    // Enrich from name cache
    for (const [id] of memberNames) {
      const cached = nameCache.get(id);
      if (cached) memberNames.set(id, cached);
    }

    // Determine display name
    let name = key;
    // For groups: prefer chat name from Feishu API, then member names
    if (isGroup && chatId && chatNameCache.has(chatId)) {
      name = chatNameCache.get(chatId)!;
    } else {
      const uniqueNames = [...new Set(memberNames.values())].filter(n => n && !n.startsWith('ou_'));
      if (uniqueNames.length > 0) {
        name = uniqueNames.join('、');
      } else if (isDm) {
        const openId = key.replace('dm_', '');
        const cached = nameCache.get(openId);
        if (cached) name = cached;
      }
    }

    // Last active time from context
    let lastActiveAt: number | null = null;
    if (Array.isArray(context) && context.length > 0) {
      lastActiveAt = context[context.length - 1].timestamp || null;
    }

    return {
      key,
      name,
      type: isGroup ? 'group' : isDm ? 'dm' : 'other',
      chatId,
      autoReply,
      memberCount: memberNames.size,
      cronJobCount: Array.isArray(cronJobs) ? cronJobs.length : 0,
      alertCount: Array.isArray(alerts) ? alerts.length : 0,
      messageCount: Array.isArray(context) ? context.length : 0,
      hasEmail,
      hasKnowledge,
      skillCount: skills.length,
      skillNames: skills.map(s => s.name),
      lastActiveAt,
    };
  }

  // POST /api/refresh-names — force refresh all name caches from Feishu API
  router.post('/api/refresh-names', async (_req: Request, res: Response) => {
    if (!feishuClient) { res.json({ ok: false, error: 'No Feishu client' }); return; }
    // Clear caches to force re-fetch
    nameCache.clear();
    chatNameCache.clear();
    const openIds = new Set<string>();
    const chatIds = new Set<string>();
    try {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('dm_ou_')) openIds.add(e.name.replace('dm_', ''));
        if (e.name.startsWith('group_')) {
          const chatId = readText(path.join(sessionsDir, e.name, 'chat-id')) || e.name.replace('group_', '');
          if (chatId) chatIds.add(chatId);
        }
      }
    } catch { /* ignore */ }
    await Promise.all([
      resolveOpenIds([...openIds]),
      Promise.allSettled([...chatIds].map(id => resolveChatName(id))),
    ]);
    res.json({ ok: true, users: nameCache.size, chats: chatNameCache.size });
  });

  // GET /api/sessions — all sessions
  router.get('/api/sessions', (_req: Request, res: Response) => {
    try {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      const sessions = entries
        .filter(e => e.isDirectory() && (e.name.startsWith('group_') || e.name.startsWith('dm_')))
        .map(e => getSessionSummary(e.name))
        .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
      res.json(sessions);
    } catch {
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  // GET /api/sessions/:key — session detail
  router.get('/api/sessions/:key', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const dir = path.join(sessionsDir, key);
    if (!fs.existsSync(dir)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const summary = getSessionSummary(key);
    // Build members from summary (already includes context-derived members)
    const sessionMembers: Record<string, { name: string; feishuMcpUrl?: string }> = {};
    const membersDir = path.join(dir, 'members');
    // summary.memberCount already has the list from getSessionSummary
    // Re-extract from context for the detail view
    const ctx = readJson(path.join(dir, 'group-context.json'));
    const ctxEntries = ctx ? (Array.isArray(ctx) ? ctx : Object.values(ctx).flat()) : [];
    for (const msg of ctxEntries as any[]) {
      const sid = msg?.senderId;
      if (sid?.startsWith('ou_') && !sessionMembers[sid]) {
        sessionMembers[sid] = { name: msg.senderName && msg.senderName !== '未知用户' ? msg.senderName : sid };
      }
    }
    if (key.startsWith('dm_ou_')) {
      const openId = key.replace('dm_', '');
      if (!sessionMembers[openId]) sessionMembers[openId] = { name: openId };
    }
    // Enrich from member profiles
    try {
      if (fs.existsSync(membersDir)) {
        for (const openId of Object.keys(sessionMembers)) {
          try {
            const profile = readJson(path.join(membersDir, openId, 'profile.json'));
            if (profile?.name && profile.name !== openId) sessionMembers[openId].name = profile.name;
            if (profile?.feishuMcpUrl) sessionMembers[openId].feishuMcpUrl = profile.feishuMcpUrl;
          } catch { /* skip */ }
        }
      }
    } catch { /* ignore */ }
    const sshPubKeyPath = path.join(dir, 'ssh_key', 'id_ed25519.pub');
    const sshPublicKey = readText(sshPubKeyPath)?.trim() || null;
    const model = readText(path.join(dir, 'model'))?.trim() || null;
    const wechatBinding = readJson(path.join(dir, 'wechat-binding.json'));
    res.json({ ...summary, authors: sessionMembers, sshPublicKey, model, wechatBinding });
  });

  // DELETE /api/sessions/:key/wechat — unbind WeChat
  router.delete('/api/sessions/:key/wechat', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const dir = path.join(sessionsDir, key);
    if (!fs.existsSync(dir)) { res.status(404).json({ error: 'Session not found' }); return; }
    for (const f of ['wechat-binding.json', 'wechat-sync.json', 'wechat-contexts.json']) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
    }
    res.json({ ok: true });
  });

  // GET /api/sessions/:key/knowledge — CLAUDE.md
  router.get('/api/sessions/:key/knowledge', (req: Request, res: Response) => {
    const filePath = path.join(sessionsDir, param(req, 'key'), 'CLAUDE.md');
    const content = readText(filePath);
    if (content === null) {
      res.json({ content: '' });
      return;
    }
    res.json({ content });
  });

  // PUT /api/sessions/:key/knowledge — update CLAUDE.md
  router.put('/api/sessions/:key/knowledge', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const filePath = path.join(sessionsDir, key, 'CLAUDE.md');
    const { content } = req.body;
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Missing content' });
      return;
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    res.json({ ok: true });
  });

  // GET /api/sessions/:key/skills — skills list
  router.get('/api/sessions/:key/skills', (req: Request, res: Response) => {
    const dir = path.join(sessionsDir, param(req, 'key'));
    const envVars = parseSessionEnv(dir);
    const envKeys = new Set(envVars.map(v => v.key));
    res.json(readSkills(dir, envKeys));
  });

  // GET /api/sessions/:key/cron — cron jobs
  router.get('/api/sessions/:key/cron', (req: Request, res: Response) => {
    const filePath = path.join(sessionsDir, param(req, 'key'), 'cron-jobs.json');
    const jobs = readJson(filePath);
    res.json(Array.isArray(jobs) ? jobs : []);
  });

  // GET /api/sessions/:key/chat — chat history from group-context.json
  router.get('/api/sessions/:key/chat', (req: Request, res: Response) => {
    const sessionKey = param(req, 'key');
    const sessionDir = path.join(sessionsDir, sessionKey);
    const contextFile = path.join(sessionDir, 'group-context.json');

    let entries: Array<{
      timestamp: number;
      senderName: string;
      senderId?: string;
      text: string;
      botReply?: string;
    }> = [];

    if (fs.existsSync(contextFile)) {
      try {
        entries = JSON.parse(fs.readFileSync(contextFile, 'utf-8'));
        if (!Array.isArray(entries)) entries = [];
      } catch { entries = []; }
    }

    // Pagination (newest first)
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const reversed = [...entries].reverse();
    const total = reversed.length;
    const start = (page - 1) * limit;
    const pageEntries = reversed.slice(start, start + limit);

    // Convert to message format for frontend
    const messages = pageEntries.map(e => ({
      role: 'user' as const,
      senderName: e.senderName,
      senderId: e.senderId,
      text: e.text,
      botReply: e.botReply,
      timestamp: new Date(e.timestamp).toISOString(),
    }));

    res.json({ messages, total, page, limit });
  });

  // GET /api/sessions/:key/email — email config (sanitized)
  router.get('/api/sessions/:key/email', (req: Request, res: Response) => {
    const dir = path.join(sessionsDir, param(req, 'key'));
    const hasAccounts = fs.existsSync(path.join(dir, 'email-accounts.json'));
    const pushTarget = readText(path.join(dir, 'push-target.json'));
    const emailRules = readText(path.join(dir, 'email-rules.txt'));
    res.json({
      configured: hasAccounts,
      pushTarget: pushTarget ? readJson(path.join(dir, 'push-target.json')) : null,
      rules: emailRules || null,
    });
  });

  // Helper: parse session.env file
  function parseSessionEnv(sessionDir: string): { key: string; value: string }[] {
    const envPath = path.join(sessionDir, 'session.env');
    const content = readText(envPath);
    if (!content) return [];
    const vars: { key: string; value: string }[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        vars.push({ key: trimmed.slice(0, eqIdx).trim(), value: trimmed.slice(eqIdx + 1).trim() });
      }
    }
    return vars;
  }

  // GET /api/sessions/:key/env — session environment variables with skill grouping
  router.get('/api/sessions/:key/env', (req: Request, res: Response) => {
    const key = param(req, 'key');
    if (!validSessionKey(key)) { res.status(400).json({ error: 'Invalid session key' }); return; }
    const dir = path.join(sessionsDir, key);
    const rawVariables = parseSessionEnv(dir);
    // Mask sensitive values (password, secret, token, key)
    const variables = rawVariables.map(v => {
      if (/password|secret|token|key|credential/i.test(v.key) && v.value) {
        return { key: v.key, value: v.value.slice(0, 3) + '***' };
      }
      return v;
    });
    const envKeys = new Set(rawVariables.map(v => v.key));

    // Build skill -> env var mapping
    const skillEnvMap: Record<string, string[]> = {};
    const skills = readSkills(dir, envKeys);
    for (const skill of skills) {
      if (skill.envVars.length > 0) {
        skillEnvMap[skill.name] = skill.envVars;
      }
    }

    // Also check standalone scripts in session root
    const scriptRefs = scanSessionScriptRefs(dir);
    for (const [script, refs] of scriptRefs) {
      const matched = refs.filter(r => envKeys.has(r));
      if (matched.length > 0) {
        const scriptName = script.replace(/\.sh$/, '');
        // Only add if not already covered by a skill
        const alreadyCovered = Object.values(skillEnvMap).flat();
        const uncovered = matched.filter(m => !alreadyCovered.includes(m));
        if (uncovered.length > 0) {
          skillEnvMap[scriptName] = [...(skillEnvMap[scriptName] || []), ...uncovered];
        }
      }
    }

    res.json({ variables, skillEnvMap });
  });

  // PUT /api/sessions/:key/env — update session environment variables
  router.put('/api/sessions/:key/env', (req: Request, res: Response) => {
    const key = param(req, 'key');
    if (!validSessionKey(key)) { res.status(400).json({ error: 'Invalid session key' }); return; }
    const dir = path.join(sessionsDir, key);
    if (!fs.existsSync(dir)) { res.status(404).json({ error: 'Session not found' }); return; }
    const { variables } = req.body as { variables: { key: string; value: string }[] };
    if (!Array.isArray(variables)) { res.status(400).json({ error: 'Invalid variables' }); return; }
    // Blocklist: prevent overriding dangerous environment variables
    const BLOCKED_VARS = new Set(['PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
      'NODE_OPTIONS', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PYTHONPATH', 'RUBYLIB', 'PERL5LIB']);
    const lines = variables
      .filter(v => v.key && typeof v.key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key.trim()))
      .filter(v => !BLOCKED_VARS.has(v.key.trim().toUpperCase()))
      .map(v => `${v.key.trim()}=${v.value ?? ''}`);
    fs.writeFileSync(path.join(dir, 'session.env'), lines.join('\n') + '\n');
    res.json({ ok: true });
  });

  // GET /api/session-names — resolve session keys to display names (no auth)
  router.get('/api/session-names', (req: Request, res: Response) => {
    const keysParam = req.query.keys as string;
    if (!keysParam) { res.json({}); return; }
    const keys = keysParam.split(',').filter(Boolean);
    const result: Record<string, { name: string; type: string }> = {};
    for (const key of keys) {
      const dir = path.join(sessionsDir, key);
      if (fs.existsSync(dir)) {
        const summary = getSessionSummary(key);
        result[key] = { name: summary.name, type: summary.type };
      }
    }
    res.json(result);
  });

  // GET /api/stats — global stats
  router.get('/api/stats', (_req: Request, res: Response) => {
    try {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      const sessionDirs = entries.filter(
        e => e.isDirectory() && (e.name.startsWith('group_') || e.name.startsWith('dm_')),
      );

      let totalCronJobs = 0;
      let totalAlerts = 0;
      let totalEmailAccounts = 0;
      let totalMessages = 0;
      let todayMessages = 0;
      let totalSkills = 0;
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayTs = todayStart.getTime();

      for (const d of sessionDirs) {
        const cron = readJson(path.join(sessionsDir, d.name, 'cron-jobs.json'));
        if (Array.isArray(cron)) totalCronJobs += cron.length;
        const alertsArr = readJson(path.join(sessionsDir, d.name, 'alerts.json'));
        if (Array.isArray(alertsArr)) totalAlerts += alertsArr.length;
        if (fs.existsSync(path.join(sessionsDir, d.name, 'email-accounts.json'))) {
          totalEmailAccounts++;
        }
        const ctx = readJson(path.join(sessionsDir, d.name, 'group-context.json'));
        if (Array.isArray(ctx)) {
          totalMessages += ctx.length;
          todayMessages += ctx.filter((m: any) => (m.timestamp || 0) >= todayTs).length;
        }
        const skillsDir = path.join(sessionsDir, d.name, '.claude', 'skills');
        try {
          if (fs.existsSync(skillsDir)) {
            totalSkills += fs.readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory()).length;
          }
        } catch { /* ignore */ }
      }

      // Memory observations count
      let totalObservations = 0;
      const db = openMemDb();
      if (db) {
        try {
          const row = db.prepare('SELECT COUNT(*) as cnt FROM observations').get() as any;
          totalObservations = row?.cnt || 0;
          db.close();
        } catch { try { db.close(); } catch {} }
      }

      res.json({
        totalSessions: sessionDirs.length,
        groupSessions: sessionDirs.filter(d => d.name.startsWith('group_')).length,
        dmSessions: sessionDirs.filter(d => d.name.startsWith('dm_')).length,
        totalMessages,
        todayMessages,
        totalCronJobs,
        totalAlerts,
        totalEmailAccounts,
        totalSkills,
        totalObservations,
      });
    } catch {
      res.status(500).json({ error: 'Failed to compute stats' });
    }
  });

  // ── Sigma-switcher endpoints ──
  // Read-only state aggregator + thin proxy to the local switcher daemon (127.0.0.1:17222).
  // On-demand only; no polling, no caching, no extra load on bot/daemon.

  const SWITCHER_HOME = path.join(process.env.HOME || '', '.sigma-switcher');
  const SWITCHER_DAEMON = 'http://127.0.0.1:17222';

  // Tail last ~2KB of a file (cheap; usage line is always within the last few lines).
  function tailFileBytes(filePath: string, maxBytes = 2048): string {
    try {
      const stat = fs.statSync(filePath);
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      return buf.toString('utf-8');
    } catch { return ''; }
  }

  // Parse accounts list out of config.yaml without pulling in a yaml dep.
  // Format is fixed by switcher: each entry is two lines `- email: x` + `  label: y`.
  function parseSwitcherAccounts(yamlPath: string): Array<{ email: string; label: string }> {
    try {
      const txt = fs.readFileSync(yamlPath, 'utf-8');
      const out: Array<{ email: string; label: string }> = [];
      const lines = txt.split('\n');
      let cur: { email?: string; label?: string } = {};
      let inAccounts = false;
      for (const raw of lines) {
        const line = raw.trimEnd();
        if (/^accounts\s*:/.test(line)) { inAccounts = true; continue; }
        if (inAccounts && /^[a-z_]+\s*:/.test(line) && !/^\s/.test(raw)) break;
        if (!inAccounts) continue;
        const emailMatch = line.match(/-\s*email\s*:\s*(\S+)/);
        if (emailMatch) {
          if (cur.email) { out.push({ email: cur.email, label: cur.label || cur.email }); }
          cur = { email: emailMatch[1] };
          continue;
        }
        const labelMatch = line.match(/^\s+label\s*:\s*(\S+)/);
        if (labelMatch) cur.label = labelMatch[1];
      }
      if (cur.email) out.push({ email: cur.email, label: cur.label || cur.email });
      return out;
    } catch { return []; }
  }

  // Pull usage breakdown from the last `current=... usage=N [...]` line in switcher.log.
  function parseLastUsage(logTail: string): { usage: number | null; breakdown: Record<string, number> } {
    const re = /current=\S+\s+usage=(\d+)\s+\[([^\]]+)\]/g;
    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(logTail)) !== null) last = m;
    if (!last) return { usage: null, breakdown: {} };
    const breakdown: Record<string, number> = {};
    for (const part of last[2].split(',')) {
      const kv = part.trim().match(/^(.+?)=(\d+)%$/);
      if (kv) breakdown[kv[1].trim()] = parseInt(kv[2], 10);
    }
    return { usage: parseInt(last[1], 10), breakdown };
  }

  // GET /api/switcher/status — aggregated read-only snapshot
  router.get('/api/switcher/status', (_req: Request, res: Response) => {
    try {
      const yamlPath = path.join(SWITCHER_HOME, 'config.yaml');
      const statePath = path.join(SWITCHER_HOME, 'state.json');
      const logPath = path.join(SWITCHER_HOME, 'logs', 'switcher.log');
      const pausedPath = path.join(SWITCHER_HOME, 'PAUSED');

      const accounts = parseSwitcherAccounts(yamlPath);
      let state: any = {};
      try { state = JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch { /* missing */ }
      const { usage, breakdown } = parseLastUsage(tailFileBytes(logPath, 4096));
      const paused = fs.existsSync(pausedPath);

      res.json({
        current: state.current || null,
        switchCount: state.switch_count || 0,
        lastSwitchTs: state.last_switch_ts || null,
        cooldowns: state.cooldowns || {},
        paused,
        usage,
        breakdown,
        accounts,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Helper to proxy a POST to the local switcher daemon.
  async function proxySwitcher(daemonPath: string, body: Record<string, unknown> = {}): Promise<Response> {
    return fetch(`${SWITCHER_DAEMON}${daemonPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    } as any) as any;
  }

  router.post('/api/switcher/pause', async (_req: Request, res: Response) => {
    try {
      const r = await proxySwitcher('/pause');
      const data = await (r as any).json();
      res.status((r as any).status).json(data);
    } catch (err) { res.status(502).json({ error: 'switcher daemon unreachable: ' + (err as Error).message }); }
  });

  router.post('/api/switcher/resume', async (_req: Request, res: Response) => {
    try {
      const r = await proxySwitcher('/resume');
      const data = await (r as any).json();
      res.status((r as any).status).json(data);
    } catch (err) { res.status(502).json({ error: 'switcher daemon unreachable: ' + (err as Error).message }); }
  });

  router.post('/api/switcher/trigger', async (req: Request, res: Response) => {
    const email = (req.body && (req.body as any).email) as string | undefined;
    if (!email) { res.status(400).json({ error: 'missing email' }); return; }
    try {
      const r = await proxySwitcher('/trigger_switch', { email });
      const data = await (r as any).json();
      res.status((r as any).status).json(data);
    } catch (err) { res.status(502).json({ error: 'switcher daemon unreachable: ' + (err as Error).message }); }
  });

  // ── Memory (claude-mem) endpoints ──

  const CLAUDE_MEM_DB = path.join(process.env.HOME || '', '.claude-mem', 'claude-mem.db');

  function openMemDb(): Database.Database | null {
    try {
      if (!fs.existsSync(CLAUDE_MEM_DB)) return null;
      return new Database(CLAUDE_MEM_DB, { readonly: true });
    } catch { return null; }
  }

  // GET /api/sessions/:key/memory — observations for a session
  router.get('/api/sessions/:key/memory', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const search = (req.query.search as string || '').trim();
    const type = (req.query.type as string || '').trim();

    const db = openMemDb();
    if (!db) { res.json({ observations: [], total: 0, page, limit }); return; }

    try {
      const conditions = ['project = ?'];
      const params: any[] = [key];

      if (type) {
        conditions.push('type = ?');
        params.push(type);
      }
      if (search) {
        conditions.push("(title LIKE ? OR narrative LIKE ? OR facts LIKE ?)");
        const like = `%${search}%`;
        params.push(like, like, like);
      }

      const where = conditions.join(' AND ');
      const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM observations WHERE ${where}`).get(...params) as any;
      const total = countRow?.cnt || 0;
      const offset = (page - 1) * limit;
      const rows = db.prepare(
        `SELECT id, type, title, narrative, facts, concepts, files_read, files_modified, created_at_epoch, project
         FROM observations WHERE ${where} ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?`
      ).all(...params, limit, offset);

      db.close();
      res.json({ observations: rows, total, page, limit });
    } catch (err) {
      db.close();
      res.status(500).json({ error: 'Failed to query memory' });
    }
  });

  // GET /api/sessions/:key/memory/summaries — session summaries
  router.get('/api/sessions/:key/memory/summaries', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));

    const db = openMemDb();
    if (!db) { res.json({ summaries: [], total: 0 }); return; }

    try {
      const countRow = db.prepare('SELECT COUNT(*) as cnt FROM session_summaries WHERE project = ?').get(key) as any;
      const total = countRow?.cnt || 0;
      const offset = (page - 1) * limit;
      const rows = db.prepare(
        `SELECT id, project, request, investigated, learned, completed, next_steps, created_at_epoch
         FROM session_summaries WHERE project = ? ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?`
      ).all(key, limit, offset);

      db.close();
      res.json({ summaries: rows, total });
    } catch {
      db.close();
      res.status(500).json({ error: 'Failed to query summaries' });
    }
  });

  // ── Management endpoints ──

  // DELETE /api/sessions/:key/skills/:folder — delete skill
  router.delete('/api/sessions/:key/skills/:folder', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const folder = param(req, 'folder');
    if (!validSessionKey(key) || !validFolder(folder)) { res.status(400).json({ error: 'Invalid parameters' }); return; }
    const skillDir = path.join(sessionsDir, key, '.claude', 'skills', folder);
    if (!fs.existsSync(skillDir)) { res.status(404).json({ error: 'Skill not found' }); return; }
    fs.rmSync(skillDir, { recursive: true, force: true });
    signalMcpChanged(path.join(sessionsDir, key));
    res.json({ ok: true });
  });

  // PUT /api/sessions/:key/skills/:folder/toggle — disable/enable skill
  router.put('/api/sessions/:key/skills/:folder/toggle', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const folder = param(req, 'folder');
    if (!validSessionKey(key) || !validFolder(folder)) { res.status(400).json({ error: 'Invalid parameters' }); return; }
    const skillDir = path.join(sessionsDir, key, '.claude', 'skills', folder);
    if (!fs.existsSync(skillDir)) { res.status(404).json({ error: 'Skill not found' }); return; }
    const markerPath = path.join(skillDir, '.disabled');
    const { disabled } = req.body;
    if (disabled) {
      fs.writeFileSync(markerPath, '');
    } else {
      try { fs.unlinkSync(markerPath); } catch { /* already gone */ }
    }
    signalMcpChanged(path.join(sessionsDir, key));
    res.json({ ok: true, disabled: !!disabled });
  });

  // POST /api/sessions/:key/skills/:folder/transfer — copy skill to another session
  router.post('/api/sessions/:key/skills/:folder/transfer', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const folder = param(req, 'folder');
    const { targetSession, transferEnvVars } = req.body;
    if (!validSessionKey(key) || !validFolder(folder) || !validSessionKey(targetSession)) {
      res.status(400).json({ error: 'Invalid parameters' }); return;
    }
    const srcDir = path.join(sessionsDir, key, '.claude', 'skills', folder);
    if (!fs.existsSync(srcDir)) { res.status(404).json({ error: 'Source skill not found' }); return; }
    const destBase = path.join(sessionsDir, targetSession, '.claude', 'skills');
    fs.mkdirSync(destBase, { recursive: true });
    fs.cpSync(srcDir, path.join(destBase, folder), {
      recursive: true,
      filter: (src) => !src.endsWith('.env'),
    });

    // Optionally transfer env vars used by this skill
    if (transferEnvVars) {
      const srcEnv = parseSessionEnv(path.join(sessionsDir, key));
      const envKeys = new Set(srcEnv.map(v => v.key));
      const skillRefs = scanEnvVarRefs(srcDir).filter(r => envKeys.has(r));
      if (skillRefs.length > 0) {
        const destEnv = parseSessionEnv(path.join(sessionsDir, targetSession));
        const destKeys = new Set(destEnv.map(v => v.key));
        // Only add vars that don't already exist in target
        const toAdd = srcEnv.filter(v => skillRefs.includes(v.key) && !destKeys.has(v.key));
        if (toAdd.length > 0) {
          const allVars = [...destEnv, ...toAdd];
          const lines = allVars.map(v => `${v.key}=${v.value}`);
          fs.writeFileSync(path.join(sessionsDir, targetSession, 'session.env'), lines.join('\n') + '\n');
        }
      }
    }

    signalMcpChanged(path.join(sessionsDir, targetSession));
    res.json({ ok: true });
  });

  // DELETE /api/sessions/:key/cron/:jobId — delete cron job
  router.delete('/api/sessions/:key/cron/:jobId', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const jobId = param(req, 'jobId');
    if (!validSessionKey(key)) { res.status(400).json({ error: 'Invalid session key' }); return; }
    const filePath = path.join(sessionsDir, key, 'cron-jobs.json');
    const jobs: any[] = readJson(filePath) || [];
    const idx = jobs.findIndex((j: any) => j.id === jobId);
    if (idx === -1) { res.status(404).json({ error: 'Job not found' }); return; }
    jobs.splice(idx, 1);
    fs.writeFileSync(filePath, JSON.stringify(jobs, null, 2));
    signalCronChanged(path.join(sessionsDir, key));
    res.json({ ok: true });
  });

  // PUT /api/sessions/:key/cron/:jobId/toggle — toggle cron job enabled
  router.put('/api/sessions/:key/cron/:jobId/toggle', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const jobId = param(req, 'jobId');
    if (!validSessionKey(key)) { res.status(400).json({ error: 'Invalid session key' }); return; }
    const filePath = path.join(sessionsDir, key, 'cron-jobs.json');
    const jobs: any[] = readJson(filePath) || [];
    const job = jobs.find((j: any) => j.id === jobId);
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
    job.enabled = !!req.body.enabled;
    fs.writeFileSync(filePath, JSON.stringify(jobs, null, 2));
    signalCronChanged(path.join(sessionsDir, key));
    res.json({ ok: true, enabled: job.enabled });
  });

  // GET /api/sessions/:key/alerts — list alerts
  router.get('/api/sessions/:key/alerts', (req: Request, res: Response) => {
    const key = param(req, 'key');
    if (!validSessionKey(key)) { res.status(400).json({ error: 'Invalid session key' }); return; }
    const filePath = path.join(sessionsDir, key, 'alerts.json');
    const alerts = readJson(filePath);
    res.json(Array.isArray(alerts) ? alerts : []);
  });

  // DELETE /api/sessions/:key/alerts/:alertId — delete alert
  router.delete('/api/sessions/:key/alerts/:alertId', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const alertId = param(req, 'alertId');
    if (!validSessionKey(key)) { res.status(400).json({ error: 'Invalid session key' }); return; }
    const filePath = path.join(sessionsDir, key, 'alerts.json');
    const alerts: any[] = readJson(filePath) || [];
    const idx = alerts.findIndex((a: any) => a.id === alertId);
    if (idx === -1) { res.status(404).json({ error: 'Alert not found' }); return; }
    alerts.splice(idx, 1);
    fs.writeFileSync(filePath, JSON.stringify(alerts, null, 2));
    signalAlertsChanged(path.join(sessionsDir, key));
    res.json({ ok: true });
  });

  // PUT /api/sessions/:key/alerts/:alertId/toggle — toggle alert enabled
  router.put('/api/sessions/:key/alerts/:alertId/toggle', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const alertId = param(req, 'alertId');
    if (!validSessionKey(key)) { res.status(400).json({ error: 'Invalid session key' }); return; }
    const filePath = path.join(sessionsDir, key, 'alerts.json');
    const alerts: any[] = readJson(filePath) || [];
    const a = alerts.find((x: any) => x.id === alertId);
    if (!a) { res.status(404).json({ error: 'Alert not found' }); return; }
    a.enabled = !!req.body.enabled;
    fs.writeFileSync(filePath, JSON.stringify(alerts, null, 2));
    signalAlertsChanged(path.join(sessionsDir, key));
    res.json({ ok: true, enabled: a.enabled });
  });

  // PUT /api/sessions/:key/alerts/:alertId/reset — reset watermark + stats
  router.put('/api/sessions/:key/alerts/:alertId/reset', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const alertId = param(req, 'alertId');
    if (!validSessionKey(key)) { res.status(400).json({ error: 'Invalid session key' }); return; }
    const filePath = path.join(sessionsDir, key, 'alerts.json');
    const alerts: any[] = readJson(filePath) || [];
    const a = alerts.find((x: any) => x.id === alertId);
    if (!a) { res.status(404).json({ error: 'Alert not found' }); return; }
    a.state = {
      watermark: { last_pubdate: 0, processed_ids: [], max_processed_size: 200 },
      stats: { polls: 0, triggers: 0, failures: 0 },
    };
    fs.writeFileSync(filePath, JSON.stringify(alerts, null, 2));
    signalAlertsChanged(path.join(sessionsDir, key));
    res.json({ ok: true });
  });

  // DELETE /api/sessions/:key/authors/:openId — remove member from session
  router.delete('/api/sessions/:key/authors/:openId', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const openId = param(req, 'openId');
    if (!validSessionKey(key)) { res.status(400).json({ error: 'Invalid session key' }); return; }
    const mgr = (req as any).memberMgr;
    if (mgr) {
      const profile = mgr.get(openId);
      if (profile) {
        profile.sessions = profile.sessions.filter((s: string) => s !== key);
        mgr.update(openId, { sessions: profile.sessions });
      }
    }
    signalMcpChanged(path.join(sessionsDir, key));
    res.json({ ok: true });
  });

  // GET /api/sessions/:key/config/:name — read a session config file
  router.get('/api/sessions/:key/config/:name', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const name = param(req, 'name');
    if (!validSessionKey(key) || !validFolder(name)) { res.status(400).json({ error: 'Invalid parameters' }); return; }
    const value = readText(path.join(sessionsDir, key, name)) || '';
    res.json({ value });
  });

  // PUT /api/sessions/:key/config/:name — write a session config file
  router.put('/api/sessions/:key/config/:name', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const name = param(req, 'name');
    if (!validSessionKey(key) || !validFolder(name)) { res.status(400).json({ error: 'Invalid parameters' }); return; }
    const dir = path.join(sessionsDir, key);
    if (!fs.existsSync(dir)) { res.status(404).json({ error: 'Session not found' }); return; }
    const { value } = req.body;
    if (typeof value !== 'string') { res.status(400).json({ error: 'Invalid value' }); return; }
    const filePath = path.join(dir, name);
    if (value) {
      fs.writeFileSync(filePath, value);
    } else {
      // Empty value = delete the config file
      try { fs.unlinkSync(filePath); } catch { /* ignore if not exists */ }
    }
    res.json({ ok: true });
  });

  // PUT /api/sessions/:key/authors/:openId — update member profile
  router.put('/api/sessions/:key/authors/:openId', (req: Request, res: Response) => {
    const key = param(req, 'key');
    const openId = param(req, 'openId');
    if (!validSessionKey(key)) { res.status(400).json({ error: 'Invalid session key' }); return; }
    const mgr = (req as any).memberMgr;
    if (!mgr) { res.status(500).json({ error: 'Member manager not initialized' }); return; }
    const profile = mgr.get(openId);
    if (!profile) { res.status(404).json({ error: 'Member not found' }); return; }
    const { name, feishuMcpUrl } = req.body;
    mgr.update(openId, { ...(name !== undefined ? { name } : {}), ...(feishuMcpUrl !== undefined ? { feishuMcpUrl } : {}) });
    signalMcpChanged(path.join(sessionsDir, key));
    res.json({ ok: true });
  });


  // ─── Members API ──────────────────────────────────────────

  const membersDir = path.join(path.dirname(sessionsDir), 'members');

  router.get('/api/members', (req: Request, res: Response) => {
    const mgr = (req as any).memberMgr;
    if (!mgr) return res.json([]);
    const members = mgr.getAll().map((m: any) => ({ ...m, muted: mgr.isMuted(m.openId) }));
    res.json(members);
  });

  router.get('/api/members/:openId', (req: Request, res: Response) => {
    const mgr = (req as any).memberMgr;
    if (!mgr) return res.status(500).json({ error: 'Member manager not initialized' });
    const openId = param(req, 'openId');
    const profile = mgr.get(openId);
    if (!profile) return res.status(404).json({ error: 'Member not found' });
    const memberMd = mgr.getMemberMd(openId);
    res.json({ ...profile, muted: mgr.isMuted(openId), memberMd });
  });

  router.put('/api/members/:openId', (req: Request, res: Response) => {
    const mgr = (req as any).memberMgr;
    if (!mgr) return res.status(500).json({ error: 'Member manager not initialized' });
    const openId = param(req, 'openId');
    const updated = mgr.update(openId, req.body);
    if (!updated) return res.status(404).json({ error: 'Member not found' });
    res.json({ ok: true, profile: updated });
  });

  router.put('/api/members/:openId/mute', (req: Request, res: Response) => {
    const mgr = (req as any).memberMgr;
    if (!mgr) return res.status(500).json({ error: 'Member manager not initialized' });
    const openId = param(req, 'openId');
    mgr.setMuted(openId, !!req.body.muted);
    res.json({ ok: true });
  });

  router.get('/api/members/:openId/member-md', (req: Request, res: Response) => {
    const mgr = (req as any).memberMgr;
    if (!mgr) return res.status(500).json({ error: 'Member manager not initialized' });
    const content = mgr.getMemberMd(param(req, 'openId'));
    res.json({ content });
  });

  router.put('/api/members/:openId/member-md', (req: Request, res: Response) => {
    const mgr = (req as any).memberMgr;
    if (!mgr) return res.status(500).json({ error: 'Member manager not initialized' });
    mgr.saveMemberMd(param(req, 'openId'), req.body.content || '');
    res.json({ ok: true });
  });

  router.delete('/api/members/:openId', (req: Request, res: Response) => {
    const mgr = (req as any).memberMgr;
    if (!mgr) return res.status(500).json({ error: 'Member manager not initialized' });
    const ok = mgr.delete(param(req, 'openId'));
    res.json({ ok });
  });

  return router;
}
