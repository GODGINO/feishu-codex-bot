import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

export interface MemberProfile {
  openId: string;
  name: string;
  feishuMcpUrl?: string;
  sessions: string[];
  createdAt: number;
  updatedAt: number;
}

export class MemberManager {
  private membersDir: string;

  constructor(
    private projectRoot: string,
    private logger: Logger,
  ) {
    this.membersDir = path.join(projectRoot, 'members');
    if (!fs.existsSync(this.membersDir)) {
      fs.mkdirSync(this.membersDir, { recursive: true });
    }
  }

  /** Get or create a member profile. */
  getOrCreate(openId: string, name: string): MemberProfile {
    const existing = this.get(openId);
    if (existing) {
      // Update name if changed
      if (name && name !== existing.name) {
        existing.name = name;
        existing.updatedAt = Date.now();
        this.saveProfile(existing);
      }
      return existing;
    }

    const profile: MemberProfile = {
      openId,
      name: name || openId,
      sessions: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const dir = path.join(this.membersDir, openId);
    fs.mkdirSync(dir, { recursive: true });
    this.saveProfile(profile);

    // Create template MEMBER.md
    const mdPath = path.join(dir, 'MEMBER.md');
    if (!fs.existsSync(mdPath)) {
      fs.writeFileSync(mdPath, [
        `# ${name || openId}`,
        '',
        '## 角色',
        '<!-- 职位、部门、专业领域 -->',
        '',
        '## 职责',
        '<!-- 日常工作内容、负责的业务 -->',
        '',
        '## 偏好',
        '<!-- 沟通风格、工具偏好、工作习惯 -->',
        '',
        '## 备注',
        '<!-- 重要决策、关注重点、其他有价值的信息 -->',
        '',
      ].join('\n'));
    }

    this.logger.info({ openId, name }, 'Created new member profile');
    return profile;
  }

  /** Get a member profile, or null. */
  get(openId: string): MemberProfile | null {
    const filePath = path.join(this.membersDir, openId, 'profile.json');
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch { /* ignore */ }
    return null;
  }

  /** List all members. */
  getAll(): MemberProfile[] {
    const result: MemberProfile[] = [];
    try {
      for (const entry of fs.readdirSync(this.membersDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('ou_')) continue;
        const profile = this.get(entry.name);
        if (profile) result.push(profile);
      }
    } catch { /* ignore */ }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Update a member profile (partial). */
  update(openId: string, updates: Partial<MemberProfile>): MemberProfile | null {
    const profile = this.get(openId);
    if (!profile) return null;
    if (updates.name !== undefined) profile.name = updates.name;
    if (updates.feishuMcpUrl !== undefined) profile.feishuMcpUrl = updates.feishuMcpUrl || undefined;
    if (updates.sessions !== undefined) profile.sessions = updates.sessions;
    profile.updatedAt = Date.now();
    this.saveProfile(profile);
    return profile;
  }

  /** Add a session to the member's session list (deduplicated). */
  addSession(openId: string, sessionKey: string): void {
    const profile = this.get(openId);
    if (!profile) return;
    if (!profile.sessions.includes(sessionKey)) {
      profile.sessions.push(sessionKey);
      profile.updatedAt = Date.now();
      this.saveProfile(profile);
    }
  }

  /** Check if member is muted. */
  isMuted(openId: string): boolean {
    return fs.existsSync(path.join(this.membersDir, openId, 'muted'));
  }

  /** Set member mute state. */
  setMuted(openId: string, muted: boolean): void {
    const mutedPath = path.join(this.membersDir, openId, 'muted');
    if (muted) {
      // Ensure member dir exists
      const dir = path.join(this.membersDir, openId);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(mutedPath, 'true');
    } else {
      try { fs.unlinkSync(mutedPath); } catch { /* ignore */ }
    }
  }

  /** Read MEMBER.md content. */
  getMemberMd(openId: string): string {
    const mdPath = path.join(this.membersDir, openId, 'MEMBER.md');
    try {
      return fs.readFileSync(mdPath, 'utf-8');
    } catch { return ''; }
  }

  /** Write MEMBER.md content. */
  saveMemberMd(openId: string, content: string): void {
    const dir = path.join(this.membersDir, openId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), content);
  }

  /** Delete a member. */
  delete(openId: string): boolean {
    const dir = path.join(this.membersDir, openId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /**
   * Sync members from all group chats via Feishu API.
   * Pulls member list for each group, creates/updates profiles with real names.
   */
  async syncFromChats(sessionsDir: string, feishuClient: any): Promise<number> {
    if (!feishuClient) return 0;
    let created = 0;

    try {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('group_')) continue;
        const sessionKey = entry.name;
        const chatIdFile = path.join(sessionsDir, sessionKey, 'chat-id');
        let chatId: string;
        try {
          chatId = fs.readFileSync(chatIdFile, 'utf-8').trim();
          if (!chatId) continue;
        } catch { continue; }

        // Fetch group members via Feishu API (paginated)
        try {
          let pageToken: string | undefined;
          do {
            const resp = await feishuClient.request({
              method: 'GET',
              url: `/open-apis/im/v1/chats/${chatId}/members`,
              params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
            });
            const items = resp?.data?.items || [];
            for (const item of items) {
              const openId = item.member_id;
              const name = item.name;
              if (!openId?.startsWith('ou_')) continue;

              const existing = this.get(openId);
              if (!existing) {
                this.getOrCreate(openId, name || openId);
                created++;
              } else if (name && (existing.name === openId || existing.name === '未知用户')) {
                // Update name if we only had the openId before
                this.update(openId, { name });
              }
              this.addSession(openId, sessionKey);
            }
            pageToken = resp?.data?.page_token || undefined;
          } while (pageToken);
        } catch (err) {
          this.logger.debug({ err, chatId, sessionKey }, 'Failed to fetch chat members');
        }
      }

      // Also handle DM sessions
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('dm_ou_')) continue;
        const openId = entry.name.replace('dm_', '');
        const existing = this.get(openId);
        if (!existing) {
          // Try contact API for DM users
          try {
            const resp = await feishuClient.request({
              method: 'GET',
              url: `/open-apis/contact/v3/users/${openId}`,
              params: { user_id_type: 'open_id' },
            });
            const name = resp?.data?.user?.name;
            this.getOrCreate(openId, name || openId);
          } catch {
            this.getOrCreate(openId, openId);
          }
          created++;
        }
        this.addSession(openId, entry.name);
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to sync members from chats');
    }

    if (created > 0) this.logger.info({ created }, 'Synced members from group chats');
    return created;
  }

  /** Ensure members/ symlink exists in a session directory. */
  ensureMembersLink(sessionDir: string): void {
    const linkPath = path.join(sessionDir, 'members');
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) return; // already linked
    } catch { /* doesn't exist yet */ }
    try {
      const relative = path.relative(sessionDir, this.membersDir);
      fs.symlinkSync(relative, linkPath);
    } catch (err) {
      this.logger.debug({ err, sessionDir }, 'Failed to create members symlink');
    }
  }

  /** Migrate data from all sessions into member profiles. Scans authors.json + group-context + DM keys. */
  migrateFromAuthors(sessionsDir: string): number {
    const markerPath = path.join(this.membersDir, '.migrated');
    if (fs.existsSync(markerPath)) return 0;

    let count = 0;
    try {
      for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sessionKey = entry.name;
        const sessionDir = path.join(sessionsDir, sessionKey);

        // 1. authors.json (has name + MCP URL)
        try {
          const authorsPath = path.join(sessionDir, 'authors.json');
          if (fs.existsSync(authorsPath)) {
            const data = JSON.parse(fs.readFileSync(authorsPath, 'utf-8'));
            const authors = data.authors || {};
            for (const [openId, info] of Object.entries(authors) as [string, any][]) {
              if (!openId.startsWith('ou_')) continue;
              const profile = this.getOrCreate(openId, info.name || openId);
              if (info.feishuMcpUrl && !profile.feishuMcpUrl) {
                this.update(openId, { feishuMcpUrl: info.feishuMcpUrl });
              }
              this.addSession(openId, sessionKey);
              count++;
            }
          }
        } catch { /* skip */ }

        // 2. DM session key → member (dm_ou_xxx)
        if (sessionKey.startsWith('dm_ou_')) {
          const openId = sessionKey.replace('dm_', '');
          this.getOrCreate(openId, openId); // name will be resolved on next message
          this.addSession(openId, sessionKey);
          count++;
        }

        // 3. group-context.json (has senderId for each message)
        try {
          const ctxPath = path.join(sessionDir, 'group-context.json');
          if (fs.existsSync(ctxPath)) {
            const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
            for (const entries of Object.values(ctx) as any[]) {
              if (!Array.isArray(entries)) continue;
              for (const e of entries) {
                if (e.senderId?.startsWith('ou_')) {
                  this.getOrCreate(e.senderId, e.senderName || e.senderId);
                  this.addSession(e.senderId, sessionKey);
                  count++;
                }
              }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }

    fs.writeFileSync(markerPath, new Date().toISOString());
    this.logger.info({ count }, 'Migrated members from sessions');
    return count;
  }

  private saveProfile(profile: MemberProfile): void {
    const dir = path.join(this.membersDir, profile.openId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile, null, 2));
  }
}
