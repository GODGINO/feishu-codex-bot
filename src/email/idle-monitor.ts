import * as fs from 'node:fs';
import * as path from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { AccountStore, type EmailAccount } from './account-store.js';
import type { RawEmail } from './email-processor.js';
import type { Logger } from '../utils/logger.js';

const INITIAL_RECONNECT_DELAY = 5_000;   // 5 seconds
const MAX_RECONNECT_DELAY = 300_000;     // 5 minutes
const SCAN_INTERVAL = 60_000;            // Re-scan sessions every 60s for new accounts
const SIGNAL_CHECK_INTERVAL = 10_000;    // Check for .email-changed signal files every 10s
const EMAIL_SIGNAL_FILENAME = '.email-changed';

interface MonitorEntry {
  client: ImapFlow | null;
  account: EmailAccount;
  sessionKey: string;
  chatId: string;
  lastUid: number;
  reconnectDelay: number;
  reconnectTimer?: NodeJS.Timeout;
  stopping: boolean;
  fetching?: boolean;
}

type NewEmailCallback = (sessionKey: string, chatId: string, account: EmailAccount, emails: RawEmail[]) => Promise<void>;

/**
 * Maintains persistent IMAP IDLE connections for all push-enabled email accounts.
 * Detects new messages and invokes a callback for processing.
 */
export class IdleMonitor {
  private monitors = new Map<string, MonitorEntry>();  // key: "{sessionKey}:{accountId}"
  private scanTimer: NodeJS.Timeout | null = null;
  private signalTimer: NodeJS.Timeout | null = null;

  constructor(
    private sessionsDir: string,
    private onNewEmails: NewEmailCallback,
    private logger: Logger,
  ) {}

  /**
   * Start monitoring: scan all sessions for email accounts and begin IDLE.
   */
  start(): void {
    this.logger.info('Starting IMAP IDLE monitor');
    this.scanAllSessions();

    // Periodically re-scan for new accounts
    this.scanTimer = setInterval(() => this.scanAllSessions(), SCAN_INTERVAL);

    // Watch for .email-changed signal files (fast response when Claude adds accounts via CLI)
    this.signalTimer = setInterval(() => this.checkSignalFiles(), SIGNAL_CHECK_INTERVAL);
  }

  /**
   * Start monitoring a specific account (called when user adds a new email).
   */
  async startAccount(sessionKey: string, chatId: string, account: EmailAccount): Promise<void> {
    if (!account.pushEnabled) return;

    const key = `${sessionKey}:${account.id}`;
    if (this.monitors.has(key)) {
      this.logger.debug({ key }, 'Account already monitored, restarting');
      this.stopAccount(sessionKey, account.id);
    }

    const entry: MonitorEntry = {
      client: null,
      account,
      sessionKey,
      chatId,
      lastUid: 0,
      reconnectDelay: INITIAL_RECONNECT_DELAY,
      stopping: false,
    };

    this.monitors.set(key, entry);
    await this.connectAndIdle(key, entry);
  }

  /**
   * Stop monitoring a specific account (called when user removes an email).
   */
  stopAccount(sessionKey: string, accountId: string): void {
    const key = `${sessionKey}:${accountId}`;
    const entry = this.monitors.get(key);
    if (!entry) return;

    entry.stopping = true;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
    }
    if (entry.client) {
      entry.client.logout().catch(() => {});
    }
    this.monitors.delete(key);
    this.logger.info({ key }, 'Stopped monitoring account');
  }

  /**
   * Stop all monitors (called on shutdown).
   */
  stopAll(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.signalTimer) {
      clearInterval(this.signalTimer);
      this.signalTimer = null;
    }

    for (const [key, entry] of this.monitors) {
      entry.stopping = true;
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer);
      }
      if (entry.client) {
        entry.client.logout().catch(() => {});
      }
    }
    this.monitors.clear();
    this.logger.info('IMAP IDLE monitor stopped');
  }

  /**
   * Scan all session directories for email accounts and start monitoring new ones.
   */
  private scanAllSessions(): void {
    try {
      const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('_')) continue; // Skip internal dirs

        const sessionKey = entry.name;
        const sessionDir = path.join(this.sessionsDir, sessionKey);
        const accounts = AccountStore.load(sessionDir);

        for (const account of accounts) {
          if (!account.pushEnabled) continue;

          const key = `${sessionKey}:${account.id}`;
          if (this.monitors.has(key)) continue; // Already monitoring

          // Resolve chatId
          const chatId = this.resolveChatId(sessionKey, sessionDir);
          if (!chatId) {
            this.logger.debug({ sessionKey, accountId: account.id }, 'No push target chatId, skipping');
            continue;
          }

          // Start monitoring
          const monitorEntry: MonitorEntry = {
            client: null,
            account,
            sessionKey,
            chatId,
            lastUid: 0,
            reconnectDelay: INITIAL_RECONNECT_DELAY,
            stopping: false,
          };

          this.monitors.set(key, monitorEntry);
          this.connectAndIdle(key, monitorEntry).catch(err => {
            this.logger.error({ err, key }, 'Failed to start IDLE for account');
          });
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to scan sessions for email accounts');
    }
  }

  /**
   * Check for .email-changed signal files and trigger immediate re-scan for those sessions.
   */
  private checkSignalFiles(): void {
    try {
      const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sessionDir = path.join(this.sessionsDir, entry.name);
        const signalFile = path.join(sessionDir, EMAIL_SIGNAL_FILENAME);
        if (fs.existsSync(signalFile)) {
          try { fs.unlinkSync(signalFile); } catch { /* ignore */ }
          this.logger.info({ sessionKey: entry.name }, 'Email accounts changed, re-scanning');
          this.scanAllSessions();
          return; // One full re-scan is enough
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * Resolve the Feishu chatId from a sessionKey.
   */
  private resolveChatId(sessionKey: string, sessionDir: string): string | null {
    // Group chats: chatId is embedded in sessionKey
    if (sessionKey.startsWith('group_')) {
      return sessionKey.slice(6);
    }

    // DM chats: try push-target.json first, then fall back to chat-id file
    const pushTarget = AccountStore.loadPushTarget(sessionDir);
    if (pushTarget) return pushTarget;

    try {
      const chatIdFile = path.join(sessionDir, 'chat-id');
      const chatId = fs.readFileSync(chatIdFile, 'utf-8').trim();
      if (chatId) return chatId;
    } catch { /* ignore */ }

    return null;
  }

  /**
   * Connect to IMAP, enter INBOX, record UIDNEXT, and start IDLE loop.
   */
  private async connectAndIdle(key: string, entry: MonitorEntry): Promise<void> {
    if (entry.stopping) return;

    try {
      const client = new ImapFlow({
        host: entry.account.imap.host,
        port: entry.account.imap.port,
        secure: entry.account.imap.tls,
        auth: {
          user: entry.account.imap.user,
          pass: entry.account.imap.pass,
        },
        logger: false,
      });

      entry.client = client;

      await client.connect();
      this.logger.info({ key }, 'IMAP connected');

      const mailbox = await client.getMailboxLock('INBOX');

      try {
        // Record current UIDNEXT so we only process truly new messages
        const mb = client.mailbox as any;
        entry.lastUid = ((mb?.uidNext as number) || 1) - 1;
        this.logger.info({ key, lastUid: entry.lastUid }, 'IDLE started');

        // Reset reconnect delay on successful connection
        entry.reconnectDelay = INITIAL_RECONNECT_DELAY;

        // Listen for new messages
        client.on('exists', async (data: { path: string; count: number; prevCount: number }) => {
          if (entry.stopping) return;
          const newCount = data.count - data.prevCount;
          if (newCount <= 0) return;

          this.logger.info({ key, newCount, total: data.count }, 'New messages detected');

          try {
            await this.fetchNewMessages(key, entry);
          } catch (err) {
            this.logger.error({ err, key }, 'Failed to fetch new messages');
          }
        });

        // IDLE loop — client.idle() resolves when IDLE is interrupted (new mail, timeout)
        // We re-enter IDLE until stopped or disconnected
        while (!entry.stopping) {
          try {
            await client.idle();
          } catch (err: any) {
            if (entry.stopping) break;
            // IDLE can throw on disconnect — break to reconnect
            this.logger.warn({ err: err.message, key }, 'IDLE interrupted');
            break;
          }
        }
      } finally {
        mailbox.release();
      }

      // Clean disconnect
      if (!entry.stopping) {
        await client.logout().catch(() => {});
      }
    } catch (err: any) {
      if (entry.stopping) return;
      this.logger.warn({ err: err.message, key }, 'IMAP connection error');
    }

    // Schedule reconnect if not stopping
    if (!entry.stopping) {
      this.scheduleReconnect(key, entry);
    }
  }

  /**
   * Fetch messages newer than lastUid and invoke the callback.
   */
  private async fetchNewMessages(key: string, entry: MonitorEntry): Promise<void> {
    if (entry.fetching) return; // Prevent concurrent fetches (same UID processed twice)
    entry.fetching = true;

    const client = entry.client;
    if (!client || entry.stopping) { entry.fetching = false; return; }

    try {
      // Search for messages with UID > lastUid using IMAP UID SEARCH
      const searchResult = await client.search({ uid: `${entry.lastUid + 1}:*` }, { uid: true }) as number[];
      if (!searchResult || searchResult.length === 0) return;

      // Filter out UIDs we've already seen (UID:* can include lastUid itself)
      const newUids = searchResult.filter(uid => uid > entry.lastUid);
      if (newUids.length === 0) return;

      this.logger.info({ key, newUids: newUids.length, firstUid: newUids[0] }, 'Fetching new messages');

      const rawEmails: RawEmail[] = [];

      for (const uid of newUids) {
        try {
          // Use fetchOne with uid option to fetch by UID (not sequence number)
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true }) as any;
          if (!msg?.source) continue;

          const parsed = await simpleParser(msg.source as Buffer);

          const headers: Record<string, string> = {};
          if (parsed.headers) {
            for (const [hKey, hVal] of parsed.headers) {
              if (typeof hVal === 'string') {
                headers[hKey.toLowerCase()] = hVal;
              } else if (hVal && typeof hVal === 'object' && 'value' in hVal) {
                headers[hKey.toLowerCase()] = String(hVal.value);
              }
            }
          }

          rawEmails.push({
            uid,
            from: parsed.from?.text || '(unknown)',
            subject: parsed.subject || '(no subject)',
            date: parsed.date || new Date(),
            text: parsed.text || '',
            headers,
          });
        } catch (err) {
          this.logger.warn({ err, uid, key }, 'Failed to fetch/parse message');
        }
      }

      // Update lastUid
      const maxUid = Math.max(...newUids);
      if (maxUid > entry.lastUid) {
        entry.lastUid = maxUid;
      }

      if (rawEmails.length > 0) {
        this.logger.info({ key, count: rawEmails.length }, 'Dispatching new emails for processing');
        await this.onNewEmails(entry.sessionKey, entry.chatId, entry.account, rawEmails);
      }
    } catch (err) {
      this.logger.error({ err, key }, 'Error fetching new messages');
    } finally {
      entry.fetching = false;
    }
  }

  /**
   * Schedule a reconnection with exponential backoff.
   */
  private scheduleReconnect(key: string, entry: MonitorEntry): void {
    if (entry.stopping) return;

    const delay = entry.reconnectDelay;
    entry.reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_DELAY);

    this.logger.info({ key, delayMs: delay }, 'Scheduling IMAP reconnect');

    entry.reconnectTimer = setTimeout(() => {
      if (entry.stopping) return;
      entry.client = null;
      this.connectAndIdle(key, entry).catch(err => {
        this.logger.error({ err, key }, 'Reconnect failed');
      });
    }, delay);
  }
}
