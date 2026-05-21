import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

const MAX_ENTRIES = 1000;
const CONTEXT_FILE = 'group-context.json';

export interface ContextEntry {
  timestamp: number;
  senderName: string;
  senderId?: string;
  text: string;
  botReply?: string;
  /** Feishu message_id of the bot's reply (card or text). Used to look up the
   *  original markdown when the user later @-replies/quotes a card the bot sent —
   *  IM `get_message` returns only a fallback string for cards. */
  botReplyMessageId?: string;
}

export class GroupContextBuffer {
  private buffers = new Map<string, ContextEntry[]>();
  /** Index of the last entry that was sent to the Claude subprocess. */
  private sentIndex = new Map<string, number>();

  constructor(private logger: Logger) {}

  /**
   * Add a message entry to the buffer. Evicts oldest entries beyond MAX_ENTRIES.
   */
  add(chatId: string, entry: ContextEntry): void {
    let entries = this.buffers.get(chatId);
    if (!entries) {
      entries = [];
      this.buffers.set(chatId, entries);
    }
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
      const removed = entries.length - MAX_ENTRIES;
      entries.splice(0, removed);
      // Adjust sentIndex
      const idx = this.sentIndex.get(chatId) ?? -1;
      this.sentIndex.set(chatId, Math.max(-1, idx - removed));
    }
  }

  /**
   * Mark all current entries as "sent" to the subprocess.
   * Called after a message (including context) is sent to Claude.
   */
  markSent(chatId: string): void {
    const entries = this.buffers.get(chatId);
    if (entries) {
      this.sentIndex.set(chatId, entries.length - 1);
    }
  }

  /**
   * Format only the MISSED messages (entries added since last markSent).
   * These are messages the subprocess never saw (e.g., non-@mention while auto-reply=off,
   * or messages that arrived while bot was busy).
   */
  formatMissed(chatId: string): string {
    const entries = this.buffers.get(chatId);
    if (!entries || entries.length === 0) return '';

    const lastSent = this.sentIndex.get(chatId) ?? -1;
    // Missed = entries after lastSent, excluding the very last one (which is the current message)
    const missed = entries.slice(lastSent + 1, -1);
    if (missed.length === 0) return '';

    const lines: string[] = [`[你不在时的 ${missed.length} 条群聊消息]`];
    for (const e of missed) {
      const d = new Date(e.timestamp);
      const dt = d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
      const senderTag = e.senderId ? `${e.senderName}(${e.senderId})` : e.senderName;
      lines.push(`[${dt}] ${senderTag}: ${e.text}`);
    }
    return lines.join('\n');
  }

  /**
   * Format ALL entries (for admin dashboard / legacy use).
   */
  format(chatId: string): string {
    const entries = this.buffers.get(chatId);
    if (!entries || entries.length === 0) return '';

    const lines: string[] = ['[最近群聊消息]'];
    for (const e of entries) {
      const d = new Date(e.timestamp);
      const dt = d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
      const senderTag = e.senderId ? `${e.senderName}(${e.senderId})` : e.senderName;
      lines.push(`[${dt}] ${senderTag}: ${e.text}`);
      if (e.botReply) {
        lines.push(`[${dt}] Sigma: ${e.botReply}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Look up the original bot reply text for a given Feishu message_id.
   * Returns the `botReply` of the entry whose `botReplyMessageId === messageId`,
   * or undefined if no match is found.
   */
  lookupBotReply(chatId: string, messageId: string): string | undefined {
    const entries = this.buffers.get(chatId);
    if (!entries || entries.length === 0) return undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.botReplyMessageId === messageId) return e.botReply;
    }
    return undefined;
  }

  /**
   * Set `botReplyMessageId` on the LAST entry of the chat — but only if that
   * entry already has a `botReply` populated. No-op otherwise (we don't want
   * to attach a message_id to an entry that has no reply text to look up).
   */
  setLastBotReplyMessageId(chatId: string, messageId: string): void {
    const entries = this.buffers.get(chatId);
    if (!entries || entries.length === 0) return;
    const last = entries[entries.length - 1];
    if (!last.botReply) return;
    last.botReplyMessageId = messageId;
  }

  /**
   * Load buffer from group-context.json in the session directory.
   */
  load(sessionDir: string, chatId: string): void {
    try {
      const filePath = path.join(sessionDir, CONTEXT_FILE);
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const entries = JSON.parse(raw) as ContextEntry[];
      if (Array.isArray(entries)) {
        this.buffers.set(chatId, entries.slice(-MAX_ENTRIES));
        // Assume all loaded entries were already sent (from previous bot run)
        this.sentIndex.set(chatId, entries.length - 1);
      }
    } catch (err) {
      this.logger.warn({ err, sessionDir }, 'Failed to load group context');
    }
  }

  /**
   * Persist buffer to group-context.json in the session directory.
   */
  save(sessionDir: string, chatId: string): void {
    try {
      const entries = this.buffers.get(chatId);
      if (!entries) return;
      const filePath = path.join(sessionDir, CONTEXT_FILE);
      fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
    } catch (err) {
      this.logger.warn({ err, sessionDir }, 'Failed to save group context');
    }
  }
}
