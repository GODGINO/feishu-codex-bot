/**
 * WeChat Bridge — addon layer for binding WeChat to existing Feishu DM sessions.
 * Handles iLink Bot API login, long polling, message routing, and dual-send.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import QRCode from 'qrcode';
import { ILinkClient } from './ilink-client.js';
import { BindingStore, type WechatBinding } from './binding-store.js';
import { downloadAndDecrypt, encryptAndUpload, getMediaType, type CDNMedia } from './media-handler.js';
import type { MessageSender } from '../feishu/message-sender.js';
import type { SessionManager } from '../claude/session-manager.js';
import type { Logger } from '../utils/logger.js';

interface PollingEntry {
  sessionKey: string;
  sessionDir: string;
  chatId: string; // Feishu chat ID
  binding: WechatBinding;
  active: boolean;
  typingTicket?: string;
}

/** Attachment from a WeChat media message. */
export interface WechatAttachment {
  filePath: string;        // saved to session dir
  fileName: string;
  mediaType: string;       // MIME type
  base64?: string;         // for images, to pass to Claude vision
}

// Callback type for routing WeChat messages into the existing MessageBridge pipeline
type WechatMessageCallback = (sessionKey: string, text: string, wechatUserId: string, attachments?: WechatAttachment[]) => Promise<void>;

export class WechatBridge {
  private client: ILinkClient;
  private pollers = new Map<string, PollingEntry>();
  private onMessageCallback?: WechatMessageCallback;

  constructor(
    private sender: MessageSender,
    private sessionMgr: SessionManager,
    private sessionsDir: string,
    private logger: Logger,
  ) {
    this.client = new ILinkClient(logger);
  }

  /** Register the callback for routing WeChat messages to MessageBridge. */
  onWechatMessage(callback: WechatMessageCallback): void {
    this.onMessageCallback = callback;
  }

  /**
   * Scan all DM sessions for active WeChat bindings and resume polling.
   * Called once at startup.
   */
  start(): void {
    try {
      const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('dm_')) continue;
        const sessionKey = entry.name;
        const sessionDir = path.join(this.sessionsDir, sessionKey);
        const binding = BindingStore.loadBinding(sessionDir);
        if (binding?.status === 'active') {
          const chatIdFile = path.join(sessionDir, 'chat-id');
          let chatId = '';
          try { chatId = fs.readFileSync(chatIdFile, 'utf-8').trim(); } catch { /* ignore */ }
          if (chatId) {
            this.logger.info({ sessionKey, wechatUserId: binding.wechatUserId }, 'Resuming WeChat polling');
            this.startPolling(sessionKey, sessionDir, chatId, binding);
          }
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to scan for WeChat bindings');
    }
  }

  /** Stop all polling loops. Called on shutdown. */
  stopAll(): void {
    for (const [sessionKey, entry] of this.pollers) {
      entry.active = false;
      this.stopTyping(sessionKey);
      this.logger.info({ sessionKey }, 'Stopped WeChat polling');
    }
    this.pollers.clear();
  }

  // --- Binding Flow ---

  /**
   * Start the QR code binding flow.
   * Called from CommandHandler when user sends /wechat in DM.
   */
  async startBinding(sessionKey: string, chatId: string, messageId: string): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);
    const sessionDir = session.sessionDir;

    // Check if already bound
    const existing = BindingStore.loadBinding(sessionDir);
    if (existing?.status === 'active') {
      await this.sender.sendText(
        chatId,
        `✅ 已绑定微信 (${existing.wechatUserId})\n\n使用 \`/wechat unbind\` 解除绑定，或 \`/wechat rebind\` 重新绑定。`,
        messageId,
      );
      return;
    }

    // Get QR code
    let qrResp;
    try {
      qrResp = await this.client.getQrCode();
    } catch (err) {
      this.logger.error({ err }, 'Failed to get WeChat QR code');
      await this.sender.sendText(chatId, '❌ 获取微信二维码失败，请稍后重试', messageId);
      return;
    }

    const qrErrCode = qrResp.errcode ?? qrResp.ret;
    if (qrErrCode !== 0 || !qrResp.qrcode_url || !qrResp.qrcode) {
      await this.sender.sendText(chatId, `❌ 获取二维码失败 (errcode: ${qrErrCode})`, messageId);
      return;
    }

    // Generate QR code image from the URL and send to Feishu
    const qrImagePath = path.join(sessionDir, 'wechat-qr.png');
    try {
      await QRCode.toFile(qrImagePath, qrResp.qrcode_url, { width: 400, margin: 2 });
      await this.sender.sendImage(chatId, qrImagePath, messageId);
    } catch (err) {
      this.logger.warn({ err }, 'Failed to generate/send QR image, sending URL instead');
      await this.sender.sendText(chatId, `🔗 请扫描二维码绑定微信:\n${qrResp.qrcode_url}`, messageId);
    }

    await this.sender.sendText(chatId, '⏳ 请用微信扫描上方二维码（8 分钟内有效）', messageId);

    // Poll for scan status
    const qrcode = qrResp.qrcode;
    let baseUrl = 'https://ilinkai.weixin.qq.com';
    const startTime = Date.now();
    const TIMEOUT = 8 * 60 * 1000; // 8 minutes

    while (Date.now() - startTime < TIMEOUT) {
      try {
        const status = await this.client.pollQrCodeStatus(qrcode, baseUrl);

        if (status.status === 'confirmed' && status.bot_token && status.ilink_bot_id) {
          // Success!
          if (status.baseurl) baseUrl = status.baseurl;

          const binding: WechatBinding = {
            wechatUserId: '', // will be filled on first message
            botToken: status.bot_token,
            ilinkBotId: status.ilink_bot_id,
            baseUrl,
            boundAt: Date.now(),
            status: 'active',
          };
          BindingStore.saveBinding(sessionDir, binding);

          await this.sender.sendText(chatId, '🎉 微信绑定成功！现在你可以通过微信私聊 Sigma 了。');

          // Start polling
          this.startPolling(sessionKey, sessionDir, chatId, binding);

          // Clean up QR image
          try { fs.unlinkSync(qrImagePath); } catch { /* ignore */ }
          return;
        }

        if (status.status === 'scaned') {
          await this.sender.sendText(chatId, '✅ 已扫码，请在手机上确认');
        }

        if (status.status === 'expired') {
          await this.sender.sendText(chatId, '⏰ 二维码已过期，请重新发送 `/wechat` 获取新二维码');
          try { fs.unlinkSync(qrImagePath); } catch { /* ignore */ }
          return;
        }

        if (status.status === 'scaned_but_redirect' && status.baseurl) {
          baseUrl = status.baseurl;
        }

        // wait → continue polling (server-side long poll handles the delay)
      } catch (err) {
        this.logger.debug({ err }, 'QR status poll error, retrying...');
        await this.sleep(2000);
      }
    }

    await this.sender.sendText(chatId, '⏰ 等待超时，请重新发送 `/wechat` 获取新二维码');
    try { fs.unlinkSync(qrImagePath); } catch { /* ignore */ }
  }

  /** Show binding status. */
  async showStatus(sessionKey: string, chatId: string, messageId: string): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);
    const binding = BindingStore.loadBinding(session.sessionDir);

    if (!binding) {
      await this.sender.sendText(chatId, '❌ 未绑定微信。使用 `/wechat` 开始绑定。', messageId);
      return;
    }

    const isPolling = this.pollers.has(sessionKey);
    const lines = [
      '**微信绑定状态**',
      '',
      `- 微信用户: \`${binding.wechatUserId || '(等待首条消息)'}\``,
      `- 状态: ${binding.status === 'active' ? '✅ 已绑定' : '❌ 未激活'}`,
      `- 轮询: ${isPolling ? '🟢 运行中' : '🔴 已停止'}`,
      `- 绑定时间: ${new Date(binding.boundAt).toLocaleString('zh-CN')}`,
    ];
    await this.sender.sendReply(chatId, lines.join('\n'), messageId);
  }

  /** Unbind WeChat from session. */
  async unbind(sessionKey: string, chatId: string, messageId: string): Promise<void> {
    this.stopPolling(sessionKey);
    const session = this.sessionMgr.getOrCreate(sessionKey);
    BindingStore.removeAll(session.sessionDir);
    await this.sender.sendText(chatId, '✅ 微信已解除绑定', messageId);
    this.logger.info({ sessionKey }, 'WeChat unbound');
  }

  /** Rebind: unbind + start new binding flow. */
  async rebind(sessionKey: string, chatId: string, messageId: string): Promise<void> {
    this.stopPolling(sessionKey);
    const session = this.sessionMgr.getOrCreate(sessionKey);
    BindingStore.removeAll(session.sessionDir);
    this.logger.info({ sessionKey }, 'WeChat rebinding');
    await this.startBinding(sessionKey, chatId, messageId);
  }

  // --- Polling ---

  /** Start long-poll loop for a session. */
  private startPolling(sessionKey: string, sessionDir: string, chatId: string, binding: WechatBinding): void {
    if (this.pollers.has(sessionKey)) return; // already polling

    const entry: PollingEntry = {
      sessionKey,
      sessionDir,
      chatId,
      binding,
      active: true,
    };
    this.pollers.set(sessionKey, entry);

    // Fetch typing ticket (needs user ID and context token)
    if (binding.wechatUserId) {
      const ctx = BindingStore.getContextToken(sessionDir, binding.wechatUserId);
      this.client.getConfig(binding.botToken, binding.wechatUserId, ctx || undefined, binding.baseUrl)
        .then(cfg => {
          if (cfg.typing_ticket) {
            entry.typingTicket = cfg.typing_ticket;
            this.logger.info({ sessionKey, hasTicket: true }, 'Got typing ticket');
          }
        })
        .catch(err => { this.logger.warn({ err, sessionKey }, 'Failed to get typing config'); });
    }

    // Start poll loop (fire and forget)
    this.pollLoop(entry).catch(err => {
      this.logger.error({ err, sessionKey }, 'Poll loop crashed');
    });
  }

  /** Stop polling for a session. */
  private stopPolling(sessionKey: string): void {
    const entry = this.pollers.get(sessionKey);
    if (entry) {
      entry.active = false;
      this.pollers.delete(sessionKey);
      this.logger.info({ sessionKey }, 'WeChat polling stopped');
    }
  }

  /** Long-poll loop. Runs indefinitely until entry.active is set to false. */
  private async pollLoop(entry: PollingEntry): Promise<void> {
    let cursor = BindingStore.loadCursor(entry.sessionDir);
    let failCount = 0;

    while (entry.active) {
      try {
        const resp = await this.client.getUpdates(entry.binding.botToken, cursor, entry.binding.baseUrl);

        if (resp.errcode === -14) {
          // Session timeout — silent retry with backoff, bot_token may still be valid
          failCount++;
          const backoff = Math.min(30_000 * failCount, 300_000); // 30s, 60s, 90s... max 5min
          this.logger.info({ sessionKey: entry.sessionKey, failCount, backoffMs: backoff }, 'iLink session timeout (-14), retrying silently');
          await this.sleep(backoff);
          continue;
        }

        // errcode is undefined on success (API omits it), only check explicit errors
        if (resp.errcode !== undefined && resp.errcode !== 0) {
          throw new Error(`getUpdates errcode: ${resp.errcode}`);
        }

        // Success — reset counter
        if (failCount > 0) {
          this.logger.info({ sessionKey: entry.sessionKey, recoveredAfter: failCount }, 'iLink poll recovered');
        }
        failCount = 0;

        // Update cursor
        if (resp.get_updates_buf) {
          cursor = resp.get_updates_buf;
          BindingStore.saveCursor(entry.sessionDir, cursor);
        }

        // Process messages
        for (const msg of resp.msgs ?? []) {
          await this.processIncomingMessage(entry, msg);
        }
      } catch (err) {
        failCount++;
        const backoff = Math.min(2_000 * Math.pow(2, Math.min(failCount - 1, 8)), 300_000); // 2s→4s→...max 5min
        this.logger.warn({ err, sessionKey: entry.sessionKey, failCount, backoffMs: backoff }, 'getUpdates failed, retrying');
        await this.sleep(backoff);
      }
    }
  }

  /** Process a single incoming WeChat message. */
  private async processIncomingMessage(
    entry: PollingEntry,
    msg: { from_user_id: string; msg_type: number; context_token: string; item_list: any[] },
  ): Promise<void> {
    // Save context token (needed for replying)
    BindingStore.saveContextToken(entry.sessionDir, msg.from_user_id, msg.context_token);

    // Update binding with wechatUserId if not set yet
    if (!entry.binding.wechatUserId) {
      entry.binding.wechatUserId = msg.from_user_id;
      BindingStore.saveBinding(entry.sessionDir, entry.binding);
    }

    // Refresh typing ticket on each message (fresh context_token)
    if (!entry.typingTicket) {
      this.client.getConfig(entry.binding.botToken, msg.from_user_id, msg.context_token, entry.binding.baseUrl)
        .then(cfg => { if (cfg.typing_ticket) entry.typingTicket = cfg.typing_ticket; })
        .catch(() => {});
    }

    // Extract text and media from item_list
    let text = '';
    const attachments: WechatAttachment[] = [];

    for (const item of msg.item_list ?? []) {
      if (item.type === 1 && item.text_item?.text) {
        text += item.text_item.text;
      } else if (item.type === 2 && item.image_item) {
        // IMAGE
        const media: CDNMedia = item.image_item.media || {};
        const aesKeyOverride = item.image_item.aeskey; // hex key preferred for images
        const buf = await downloadAndDecrypt(media, aesKeyOverride, this.logger);
        if (buf) {
          const ext = 'png'; // WeChat images are usually JPEG but we save as generic
          const fileName = `wx-image-${Date.now()}.${ext}`;
          const filePath = path.join(entry.sessionDir, fileName);
          fs.writeFileSync(filePath, buf);
          attachments.push({
            filePath, fileName, mediaType: 'image/png',
            base64: buf.toString('base64'),
          });
          this.logger.info({ sessionKey: entry.sessionKey, fileName, size: buf.length }, 'Downloaded WeChat image');
        }
      } else if (item.type === 3 && item.voice_item) {
        // VOICE — prefer speech-to-text if available
        if (item.voice_item.text) {
          text += (text ? '\n' : '') + `[语音消息] ${item.voice_item.text}`;
        } else if (item.voice_item.media) {
          const buf = await downloadAndDecrypt(item.voice_item.media as CDNMedia, undefined, this.logger);
          if (buf) {
            const fileName = `wx-voice-${Date.now()}.silk`;
            const filePath = path.join(entry.sessionDir, fileName);
            fs.writeFileSync(filePath, buf);
            attachments.push({ filePath, fileName, mediaType: 'audio/silk' });
            text += (text ? '\n' : '') + `[语音消息已保存: ${filePath}]`;
            this.logger.info({ sessionKey: entry.sessionKey, fileName, size: buf.length }, 'Downloaded WeChat voice');
          }
        }
      } else if (item.type === 4 && item.file_item) {
        // FILE
        const media: CDNMedia = item.file_item.media || {};
        const buf = await downloadAndDecrypt(media, undefined, this.logger);
        if (buf) {
          const fileName = item.file_item.file_name || `wx-file-${Date.now()}`;
          const filePath = path.join(entry.sessionDir, fileName);
          fs.writeFileSync(filePath, buf);
          attachments.push({ filePath, fileName, mediaType: 'application/octet-stream' });
          text += (text ? '\n' : '') + `[文件已保存: ${filePath}]`;
          this.logger.info({ sessionKey: entry.sessionKey, fileName, size: buf.length }, 'Downloaded WeChat file');
        }
      } else if (item.type === 5 && item.video_item) {
        // VIDEO
        const media: CDNMedia = item.video_item.media || {};
        const buf = await downloadAndDecrypt(media, undefined, this.logger);
        if (buf) {
          const fileName = `wx-video-${Date.now()}.mp4`;
          const filePath = path.join(entry.sessionDir, fileName);
          fs.writeFileSync(filePath, buf);
          attachments.push({ filePath, fileName, mediaType: 'video/mp4' });
          text += (text ? '\n' : '') + `[视频已保存: ${filePath}]`;
          this.logger.info({ sessionKey: entry.sessionKey, fileName, size: buf.length }, 'Downloaded WeChat video');
        }
      }
    }

    if (!text && attachments.length === 0) {
      this.logger.debug({ sessionKey: entry.sessionKey, msgType: msg.msg_type }, 'Skipping empty WeChat message');
      return;
    }

    // Default text for media-only messages
    if (!text && attachments.length > 0) {
      text = `[用户发送了${attachments.length}个文件]`;
    }

    this.logger.info({ sessionKey: entry.sessionKey, from: msg.from_user_id, textLen: text.length, attachments: attachments.length }, 'WeChat message received');

    // Send media attachments to Feishu (images/files)
    for (const att of attachments) {
      try {
        if (att.mediaType.startsWith('image/')) {
          await this.sender.sendImage(entry.chatId, att.filePath);
        } else {
          await this.sender.sendFile(entry.chatId, att.filePath);
        }
      } catch (err) {
        this.logger.warn({ err, fileName: att.fileName }, 'Failed to send WeChat media to Feishu');
      }
    }

    // Route to Claude via MessageBridge callback
    if (this.onMessageCallback) {
      try {
        await this.onMessageCallback(entry.sessionKey, text, msg.from_user_id, attachments);
      } catch (err) {
        this.logger.error({ err, sessionKey: entry.sessionKey }, 'Failed to route WeChat message to Claude');
      }
    }
  }

  // --- Sending to WeChat ---

  /**
   * Send Claude's reply to WeChat.
   * Called from MessageBridge.executeAndReply() after Feishu reply is sent.
   */
  async sendToWechat(sessionKey: string, text: string, skipStrip = false): Promise<void> {
    const entry = this.pollers.get(sessionKey);
    if (!entry) return; // not bound or not polling

    // Strip Feishu-specific markers (unless caller already prepared the text)
    const cleanText = skipStrip ? text : this.stripFeishuMarkers(text);
    if (!cleanText) return;

    // Get context token for the WeChat user
    const contextToken = BindingStore.getContextToken(entry.sessionDir, entry.binding.wechatUserId);
    if (!contextToken) {
      this.logger.warn({ sessionKey }, 'No context token for WeChat reply');
      return;
    }

    // Stop typing indicator + keepalive
    await this.stopTyping(sessionKey);

    // Truncate if too long for WeChat (approx 4096 chars)
    const truncated = cleanText.length > 4000
      ? cleanText.slice(0, 4000) + '\n\n...(完整内容请查看飞书)'
      : cleanText;

    try {
      const resp = await this.client.sendMessage(
        entry.binding.botToken, entry.binding.wechatUserId,
        contextToken, truncated, entry.binding.baseUrl,
      );
      if (resp.errcode !== undefined && resp.errcode !== 0) {
        this.logger.warn({ sessionKey, errcode: resp.errcode }, 'WeChat sendMessage failed (will retry on next message)');
      } else {
        this.logger.info({ sessionKey, textLen: truncated.length }, 'Sent reply to WeChat');
      }
    } catch (err) {
      this.logger.warn({ err, sessionKey }, 'Failed to send reply to WeChat');
    }
  }

  /**
   * Sync a Feishu message to WeChat (show what user said in Feishu).
   * Called from MessageBridge.handleMessage() for DM messages.
   */
  async syncFeishuMessage(sessionKey: string, text: string): Promise<void> {
    const entry = this.pollers.get(sessionKey);
    if (!entry) return;

    const contextToken = BindingStore.getContextToken(entry.sessionDir, entry.binding.wechatUserId);
    if (!contextToken) return;

    try {
      await this.client.sendMessage(
        entry.binding.botToken, entry.binding.wechatUserId,
        contextToken, `\`[来自飞书] ${text}\``, entry.binding.baseUrl,
      );
    } catch {
      // best-effort sync
    }
  }

  /**
   * Send a file (image/video/file) to WeChat.
   * Encrypts + uploads to CDN, then sends via iLink sendMessage.
   */
  async sendFileToWechat(sessionKey: string, filePath: string): Promise<void> {
    const entry = this.pollers.get(sessionKey);
    if (!entry) return;

    const contextToken = BindingStore.getContextToken(entry.sessionDir, entry.binding.wechatUserId);
    if (!contextToken) return;

    const { mediaType, itemBuilder } = getMediaType(filePath);

    try {
      const uploaded = await encryptAndUpload(
        filePath, this.client, entry.binding.botToken,
        entry.binding.wechatUserId, mediaType, entry.binding.baseUrl, this.logger,
      );
      if (!uploaded) return;

      const item = itemBuilder(uploaded);
      await this.client.sendMediaMessage(
        entry.binding.botToken, entry.binding.wechatUserId,
        contextToken, item, entry.binding.baseUrl,
      );
      this.logger.info({ sessionKey, filePath: path.basename(filePath), mediaType }, 'Sent file to WeChat');
    } catch (err) {
      this.logger.warn({ err, sessionKey, filePath }, 'Failed to send file to WeChat');
    }
  }

  // Active typing keepalive timers per session
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  /** Start typing indicator on WeChat with 5s keepalive. */
  async startTyping(sessionKey: string): Promise<void> {
    const entry = this.pollers.get(sessionKey);
    if (!entry?.typingTicket || !entry.binding.wechatUserId) return;

    const sendTypingOnce = () => {
      this.client.sendTyping(
        entry.binding.botToken, entry.binding.wechatUserId,
        entry.typingTicket!, 1, entry.binding.baseUrl,
      ).catch(() => {});
    };

    // Send immediately
    sendTypingOnce();

    // Keepalive every 5 seconds
    this.stopTyping(sessionKey); // clear any existing timer
    const timer = setInterval(sendTypingOnce, 5_000);
    this.typingTimers.set(sessionKey, timer);
  }

  /** Stop typing indicator and clear keepalive. */
  private async stopTyping(sessionKey: string): Promise<void> {
    const timer = this.typingTimers.get(sessionKey);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(sessionKey);
    }

    const entry = this.pollers.get(sessionKey);
    if (entry?.typingTicket && entry.binding.wechatUserId) {
      this.client.sendTyping(
        entry.binding.botToken, entry.binding.wechatUserId,
        entry.typingTicket, 2, entry.binding.baseUrl,
      ).catch(() => {});
    }
  }

  /** Check if a session has an active WeChat binding. */
  isActive(sessionKey: string): boolean {
    return this.pollers.has(sessionKey);
  }

  // --- Helpers ---

  private stripFeishuMarkers(text: string): string {
    // Convert <<BUTTON:label|action|type?>> tags to numbered list
    const buttons: string[] = [];
    let cleaned = text.replace(/<{1,2}\s*BUTTON\s*:\s*([^|>]+?)\s*\|[^>]*>{1,2}\s*/gi, (_, label) => {
      buttons.push(label.trim());
      return '';
    });

    // Convert <<SELECT:...>> and <<MSELECT:...>> tags to a bulleted dropdown summary.
    // WeChat has no native dropdown — render placeholder + option labels as text.
    // MSELECT first so its longer keyword doesn't get half-eaten by SELECT's regex.
    const renderSelectTag = (suffix: string) => (_: string, body: string) => {
      const parts = String(body).split(/[|｜]/).map((p: string) => p.trim()).filter((p: string) => p.length > 0);
      if (parts.length < 3) return '';
      const placeholder = parts[0];
      const labels = parts.slice(2).map((opt: string) => {
        const eq = opt.search(/[=＝]/);
        return eq > 0 ? opt.slice(eq + 1).trim() : opt;
      });
      return `${placeholder}${suffix}：${labels.join(' / ')}\n`;
    };
    cleaned = cleaned.replace(/<{1,2}\s*MSELECT\s*[:：]\s*([^>]+?)\s*>{1,2}\s*/gi, renderSelectTag('（多选）'));
    cleaned = cleaned.replace(/<{1,2}\s*SELECT\s*[:：]\s*([^>]+?)\s*>{1,2}\s*/gi, renderSelectTag(''));

    // Convert <<IMG:url|alt?>> tags to a text placeholder — WeChat strips card-side images.
    cleaned = cleaned.replace(/<{1,2}\s*IMG\s*[:：]\s*([^>]+?)\s*>{1,2}\s*/gi, (_, body) => {
      const parts = String(body).split(/[|｜]/).map((p: string) => p.trim()).filter((p: string) => p.length > 0);
      if (parts.length === 0) return '';
      const url = parts[0];
      const alt = parts[1];
      return alt ? `[图片: ${alt} - ${url}]\n` : `[图片: ${url}]\n`;
    });

    cleaned = cleaned
      .replace(/<{1,2}\s*TITLE\s*[:：]?[^<>\n]*?[<\/\s]*>{1,2}\s*\n?|<\/\s*TITLE\s*>{0,2}\s*\n?/gi, '')
      .replace(/<{1,2}\s*REACT\s*[:：]\s*\w+\s*>{1,2}/gi, '')
      .replace(/<{1,2}\s*THREAD\s*>{1,2}/gi, '')
      .replace(/^\n+/, '')
      .trim();

    // Append buttons as numbered list
    if (buttons.length > 0) {
      cleaned += '\n\n' + buttons.map((b, i) => `${i + 1}. ${b}`).join('\n');
    }

    return cleaned;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
