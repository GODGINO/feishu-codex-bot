import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage } from '../feishu/event-handler.js';
import type { MessageSender } from '../feishu/message-sender.js';
import type { TypingIndicator } from '../feishu/typing.js';
import type { ClaudeRunner, ImageAttachment } from '../claude/runner.js';
import type { LiveUsage } from '../claude/stream-parser.js';
import { SessionManager } from '../claude/session-manager.js';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { isNoReply, FORM_SUBMIT_ACTION, detectBareImagePaths, type SelectInfo, type MultiSelectInfo, type CheckerInfo, type ToastInfo } from '../feishu/card-builder.js';
import { CommandHandler } from './command-handler.js';
import { MessageQueue, type Job } from './message-queue.js';
import { GroupContextBuffer } from './group-context.js';
import { EmailSetup } from './email-setup.js';
import type { IdleMonitor } from '../email/idle-monitor.js';
import type { EmailProcessor, RawEmail } from '../email/email-processor.js';
import { formatPushNotification } from '../email/email-processor.js';
import type { EmailAccount } from '../email/account-store.js';
import { CardStreamer } from '../feishu/card-streamer.js';
import type { MemberManager } from '../members/member-manager.js';
import type { WechatBridge } from '../wechat/wechat-bridge.js';
import { ParallelRunner } from '../claude/parallel-runner.js';

const TITLE_INSTRUCTION = '\n\n[当你的回复包含 markdown 格式（表格、列表、代码块、加粗、链接、分隔线等）时，必须在第一行写 <<TITLE:简短标题|颜色>>，然后空一行写正文。颜色可选：blue（默认/信息/成功/完成）/ green（上涨/增长/积极行情）/ red（失败/紧急/下跌）/ orange（警告）/ yellow（提醒/亮点）/ wathet（次级信息/数据播报）/ turquoise（进展中）/ carmine（严重警告）/ violet/purple/indigo（特殊场景）/ grey（中立/不活跃）。不指定颜色时省略 |颜色 即可（默认 blue）。示例：<<TITLE:部署完成>>、<<TITLE:沪指 -1.5%|orange>>、<<TITLE:茅台涨停|green>>。标题10字以内，概括主题；标题里如果你想加 emoji（如 ✅ ❌ ⚠️ 💡 🔄 🚨 ✨ 📊 等）可以自己加，系统不会再自动追加任何 emoji。纯文字短回复（打招呼、一两句话确认）不要写标题。]';

/**
 * Get feishu MCP tool restriction hint for a specific user in group chat.
 * Returns empty string for DM or if user has no feishu MCP configured.
 */
function getFeishuMcpHint(sessionDir: string, userId: string): string {
  try {
    // Read from members/{userId}/profile.json (via symlink)
    const profilePath = path.join(sessionDir, 'members', userId, 'profile.json');
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
      if (profile.feishuMcpUrl) {
        return `[身份绑定: 当前操作者是「${profile.name}」(${userId})。所有操作（编写文档、日报、创建内容等）必须以此人身份执行。飞书MCP仅限调用 mcp__feishu_${userId}__* 系列工具，严禁使用其他用户的飞书MCP工具。文档署名、作者信息必须是「${profile.name}」，不得使用群内其他人的姓名。使用 feishu-tools MCP 的任务/日历/多维表格工具时，user_id 参数传 ${userId}。如果工具返回未授权错误，先调用 feishu_auth_start 引导用户完成飞书 OAuth 授权。]`;
      }
      return `[身份: 当前操作者是「${profile.name}」(${userId})，但尚未绑定飞书 MCP。如果用户需要使用飞书文档/表格/日历/任务等功能，引导用户访问 https://open.feishu.cn/page/mcp 获取 MCP URL 并发送给我完成绑定。使用 feishu-tools MCP 的任务/日历/多维表格工具时，user_id 参数传 ${userId}。]`;
    }
  } catch { /* ignore */ }
  return `[使用 feishu-tools MCP 的任务/日历/多维表格工具时，user_id 参数传 ${userId}。如果工具返回未授权错误，先调用 feishu_auth_start 引导用户完成飞书 OAuth 授权。]`;
}

export class MessageBridge {
  private runningTasks = new Set<string>();
  private abortControllers = new Map<string, AbortController>();
  // Cache finalized card state for button/select-form click updates (cardId → card data).
  // `selects` / `multiSelects` are populated when the original reply used SELECT/MSELECT tags,
  // so the form-submit handler can map field names back to placeholder + option labels.
  private buttonCardCache = new Map<string, { cardJson: object; sequence: number; expiresAt: number; selects?: SelectInfo[]; multiSelects?: MultiSelectInfo[]; checkers?: CheckerInfo[]; toast?: ToastInfo }>();
  private commandHandler: CommandHandler;
  private queue: MessageQueue;
  private groupContext: GroupContextBuffer;
  private emailSetup: EmailSetup;
  private parallelRunner: ParallelRunner;
  /**
   * Set of parent sessionKeys whose main-path process should be respawned
   * before the next message — populated when a fork finishes (signals to main
   * "you missed some jsonl writes, refresh on your next turn"). If main is
   * currently idle when a fork finishes, we respawn immediately. If main is
   * busy mid-turn, we defer until its finally block.
   */
  private pendingRespawn = new Set<string>();
  // Dedup: Feishu WebSocket can re-deliver events on reconnect, bypassing event-handler dedup
  private recentMessageIds = new Set<string>();
  private memberMgr?: MemberManager;
  private wechatBridge?: WechatBridge;
  private adminChat?: import('../admin/admin-chat.js').AdminChatServer;
  private emailProcessor?: EmailProcessor;
  // Track original text per session for cross-channel echo
  private wechatPendingEcho = new Map<string, string>();
  private feishuPendingEcho = new Map<string, string>();
  // Track active card streamers per session — used to finalize stale agent cards on new turn
  private activeStreamers = new Map<string, import('../feishu/card-streamer.js').CardStreamer>();
  private adminChatPendingEcho = new Map<string, { text: string; echo: boolean; showSource: boolean }>();


  constructor(
    private sender: MessageSender,
    private typing: TypingIndicator,
    private runner: ClaudeRunner,
    private sessionMgr: SessionManager,
    private config: Config,
    private logger: Logger,
  ) {
    this.queue = new MessageQueue(config.maxQueuePerSession, logger);
    this.groupContext = new GroupContextBuffer(logger);
    this.emailSetup = new EmailSetup(sender, sessionMgr, logger);
    this.commandHandler = new CommandHandler(
      sender,
      sessionMgr,
      runner,
      this.runningTasks,
      this.abortControllers,
      logger,
    );
    this.commandHandler.setEmailSetup(this.emailSetup);
    // /并行 slot allocator (max 2 concurrent forks per parent session).
    // The actual run goes through the standard executeAndReply pipeline via
    // runParallelAgent() so fork agents look identical to normal messages.
    this.parallelRunner = new ParallelRunner(2);
    this.commandHandler.setParallelRunner(this.parallelRunner);
    this.commandHandler.setRunParallel((opts) => this.runParallelAgent(opts));

    // Periodically clean up expired button card cache entries
    setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.buttonCardCache) {
        if (entry.expiresAt < now) this.buttonCardCache.delete(id);
      }
    }, 60 * 60 * 1000).unref();

    // Handle unsolicited output from background agents
    this.runner.onUnsolicitedResult(async (sessionKey, result) => {
      if (!result.fullText) return;
      try {
        const session = this.sessionMgr.getOrCreate(sessionKey);
        // Read chatId from file (saved when message was first received)
        const chatIdFile = path.join(session.sessionDir, 'chat-id');
        const chatId = fs.readFileSync(chatIdFile, 'utf-8').trim();
        if (!chatId) return;

        this.logger.info(
          { sessionKey, textLen: result.fullText.length },
          'Sending unsolicited result (background agent completion)',
        );
        await this.sender.sendReply(chatId, result.fullText, undefined, session.sessionDir);
        await this.sendMentionedFiles(chatId, result.fullText, session.sessionDir, undefined, undefined, sessionKey);
      } catch (err) {
        this.logger.warn({ err, sessionKey }, 'Failed to send unsolicited result');
      }
    });

  }

  /**
   * Set the IDLE monitor reference (for email add/remove notifications).
   */
  setIdleMonitor(monitor: IdleMonitor): void {
    this.emailSetup.setIdleMonitor(monitor);
    this.commandHandler.setIdleMonitor(monitor);
  }

  /** Set the EmailProcessor reference (used by enqueueEmailProcess). */
  setEmailProcessor(processor: EmailProcessor): void {
    this.emailProcessor = processor;
  }

  /**
   * Public entry called by IdleMonitor when new emails arrive. Routes the
   * spam-classification + push-notification through the user session's
   * unified queue so it cannot run concurrently with the user's own
   * Claude tasks. Classification itself still uses the isolated
   * `_email_processor` session inside emailProcessor.process so the
   * user's transcript stays clean.
   */
  enqueueEmailProcess(sessionKey: string, chatId: string, emails: RawEmail[], account: EmailAccount, sessionDir: string): void {
    if (emails.length === 0) return;
    void this.enqueueOrRunJob({ kind: 'claude-email-process', sessionKey, chatId, emails, account, sessionDir });
  }

  /**
   * Run a queued email-process Job. Holds the user sessionKey lock so
   * the LLM-based spam filter does not contend with the user's own
   * Claude tasks for the same session.
   */
  private async runEmailProcessJob(job: Extract<Job, { kind: 'claude-email-process' }>): Promise<void> {
    const { sessionKey, chatId, emails, account, sessionDir } = job;
    if (!this.emailProcessor) {
      this.logger.error({ sessionKey, accountId: account.id }, 'emailProcessor not set — dropping job');
      return;
    }

    this.runningTasks.add(sessionKey);
    try {
      const processed = await this.emailProcessor.process(emails, account, sessionDir);
      const toNotify = processed.filter(e => !e.isSpam);
      if (toNotify.length > 0) {
        const text = formatPushNotification(toNotify);
        await this.sender.sendReply(chatId, text);
      }
      const spamCount = processed.length - toNotify.length;
      if (spamCount > 0) {
        this.logger.debug({ sessionKey, accountId: account.id, spamCount }, 'Filtered spam emails');
      }
    } catch (err) {
      this.logger.error({ err, sessionKey, accountId: account.id }, 'Email process job failed');
    } finally {
      this.runningTasks.delete(sessionKey);
      await this.processQueue(sessionKey);
    }
  }

  /** Set the MemberManager for per-user profile tracking. */
  setMemberManager(mgr: MemberManager): void {
    this.memberMgr = mgr;
  }

  /** Set the WeChat bridge for dual-send and message routing. */
  setWechatBridge(bridge: WechatBridge): void {
    this.wechatBridge = bridge;
    this.commandHandler.setWechatBridge(bridge);
    // Register callback for WeChat → Claude message routing
    bridge.onWechatMessage(async (sessionKey, text, wechatUserId, attachments) => {
      await this.handleWechatMessage(sessionKey, text, wechatUserId, attachments);
    });
  }

  /** Set the Admin Chat server for three-way echo and message routing. */
  setAdminChat(adminChat: import('../admin/admin-chat.js').AdminChatServer): void {
    this.adminChat = adminChat;
    adminChat.onMessage = async (sessionKey: string, text: string, echo: boolean, showSource: boolean) => {
      await this.handleAdminChatMessage(sessionKey, text, echo, showSource);
    };
    adminChat.onSendAsSigma = async (sessionKey: string, text: string, addToContext: boolean) => {
      await this.handleSendAsSigma(sessionKey, text, addToContext);
    };
  }

  /** Send a message directly as Sigma bot — no Claude processing, no queueing (admin manual action). */
  private async handleSendAsSigma(sessionKey: string, text: string, addToContext: boolean): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);
    const chatIdFile = path.join(session.sessionDir, 'chat-id');
    let chatId = '';
    try { chatId = fs.readFileSync(chatIdFile, 'utf-8').trim(); } catch { /* ignore */ }
    if (!chatId) {
      this.logger.warn({ sessionKey }, 'No chat-id for Send as Sigma');
      return;
    }

    this.logger.info({ sessionKey, textLen: text.length, addToContext }, 'Send as Sigma');

    // Send to Feishu as Sigma bot
    await this.sender.sendReply(chatId, text, undefined, session.sessionDir);

    // Send to WeChat if bound
    if (this.wechatBridge?.isActive(sessionKey)) {
      this.wechatBridge.sendToWechat(sessionKey, text).catch(err => {
        this.logger.warn({ err, sessionKey }, 'Failed to send Sigma message to WeChat');
      });
    }

    // Optionally add to context (as bot message, not user message)
    if (addToContext) {
      if (!this.groupContext['buffers'].has(chatId)) {
        this.groupContext.load(session.sessionDir, chatId);
      }
      this.groupContext.add(chatId, {
        timestamp: Date.now(),
        senderName: 'Sigma',
        senderId: 'bot',
        text: '(Send as Sigma)',
        botReply: text.length > 50000 ? text.slice(0, 50000) + '...[truncated]' : text,
      });
      this.groupContext.save(session.sessionDir, chatId);
    }
  }

  /** Handle a message from Admin Chat — route through unified queue. */
  private async handleAdminChatMessage(sessionKey: string, text: string, echo: boolean, showSource: boolean): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);
    const chatIdFile = path.join(session.sessionDir, 'chat-id');
    let chatId = '';
    try { chatId = fs.readFileSync(chatIdFile, 'utf-8').trim(); } catch { /* ignore */ }
    if (!chatId) {
      this.logger.warn({ sessionKey }, 'No chat-id for admin chat routing');
      this.adminChat?.sendError(sessionKey, 'No chat-id found for this session');
      return;
    }
    await this.enqueueOrRunJob({ kind: 'claude-admin-chat', sessionKey, chatId, text, echo, showSource });
  }

  /** Handle a message from WeChat — route through unified queue. */
  private async handleWechatMessage(sessionKey: string, text: string, wechatUserId: string, attachments?: import('../wechat/wechat-bridge.js').WechatAttachment[]): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);
    const chatIdFile = path.join(session.sessionDir, 'chat-id');
    let chatId = '';
    try { chatId = fs.readFileSync(chatIdFile, 'utf-8').trim(); } catch { /* ignore */ }
    if (!chatId) {
      this.logger.warn({ sessionKey }, 'No chat-id for WeChat message routing');
      return;
    }

    // Build prompt with sender context
    const userId = sessionKey.replace('dm_', '');
    const senderName = this.resolveSenderName(undefined, userId);
    const mcpHint = getFeishuMcpHint(session.sessionDir, userId);
    const safeName = senderName.replace(/[\n\r\]]/g, ' ');
    const safeId = userId.replace(/[\n\r\]]/g, '');
    const prompt = `[发送者: ${safeName} | id: ${safeId}]${mcpHint}\n${text}`;

    // Build image attachments for Claude (vision)
    let images: ImageAttachment[] | undefined;
    if (attachments) {
      const imgAtts = attachments.filter(a => a.base64 && a.mediaType.startsWith('image/'));
      if (imgAtts.length > 0) {
        images = imgAtts.map(a => ({ base64: a.base64!, mediaType: a.mediaType }));
      }
    }

    await this.enqueueOrRunJob({ kind: 'claude-wechat', sessionKey, chatId, prompt, images });
    // Echo + group context recording happen inside runWechatJob just before Claude runs,
    // so they are correctly ordered with respect to other jobs in the queue.
    // Capture the original wechat text so it can be picked up at run time.
    this.wechatPendingEcho.set(sessionKey, text);
  }

  /** Resolve a display name: event name → member profile name → fallback. */
  private resolveSenderName(eventName: string | undefined, userId: string): string {
    if (eventName) return eventName;
    if (this.memberMgr) {
      const member = this.memberMgr.get(userId);
      if (member?.name && member.name !== userId) return member.name;
    }
    return '未知用户';
  }

  /**
   * Extract all <<REACT:emoji>> tags from text, send reactions, return text with tags stripped.
   * REACT is an annotation — can coexist with text and tool calls.
   */
  private async processReactions(text: string, messageId: string): Promise<string> {
    const pattern = /<{1,2}\s*REACT\s*[:：]\s*(\w+)\s*>{1,2}\s*/gi;
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0) return text;
    for (const match of matches) {
      this.typing.start(messageId, match[1]).catch(() => {});
      this.logger.info({ messageId, emojiType: match[1] }, 'Sending reaction');
    }
    return text.replace(pattern, '').trim();
  }

  /**
   * Main entry point for incoming messages.
   */
  async handleMessage(msg: IncomingMessage): Promise<void> {
    // Dedup guard: reject duplicate messageIds (Feishu WebSocket may re-deliver on reconnect)
    if (this.recentMessageIds.has(msg.messageId)) {
      this.logger.warn({ messageId: msg.messageId }, 'Duplicate message in bridge, ignoring');
      return;
    }
    this.recentMessageIds.add(msg.messageId);
    setTimeout(() => this.recentMessageIds.delete(msg.messageId), 600_000);

    // For interactive (card) messages — event payload may be truncated.
    // Fetch full content via API (esp. for forwarded emails).
    if (msg.messageType === 'interactive') {
      try {
        const fullText = await this.sender.fetchMessageText(msg.messageId);
        if (fullText && fullText.length > msg.text.length) {
          this.logger.info({ messageId: msg.messageId, oldLen: msg.text.length, newLen: fullText.length }, 'Fetched full interactive content');
          msg.text = fullText;
        }
      } catch (err) {
        this.logger.warn({ err, messageId: msg.messageId }, 'Failed to fetch full interactive content');
      }
    }

    const sessionKey = SessionManager.getSessionKey(msg.chatType, msg.userId, msg.chatId);

    // Persist chatId mapping for cron job delivery (DM sessionKey can't derive chatId)
    const session = this.sessionMgr.getOrCreate(sessionKey);
    try {
      fs.writeFileSync(path.join(session.sessionDir, 'chat-id'), msg.chatId);
    } catch { /* ignore */ }

    // Check if session is muted (admin-only toggle)
    try {
      if (fs.existsSync(path.join(session.sessionDir, 'muted'))) {
        this.logger.debug({ sessionKey }, 'Session muted, ignoring message');
        return;
      }
    } catch { /* ignore */ }

    // Check if individual member is muted (across all sessions)
    try {
      if (fs.existsSync(path.join(session.sessionDir, 'members', msg.userId, 'muted'))) {
        this.logger.debug({ sessionKey, userId: msg.userId }, 'Member muted, ignoring message');
        return;
      }
    } catch { /* ignore */ }

    // Ensure member exists (sync already creates most, this is fallback for new users)
    if (this.memberMgr && msg.userId.startsWith('ou_')) {
      const existing = this.memberMgr.get(msg.userId);
      if (!existing) {
        // New user not yet synced — resolve name via API
        const resolvedName = await this.sender.resolveUserName(msg.userId) || msg.senderName || null;
        this.memberMgr.getOrCreate(msg.userId, resolvedName || msg.userId);
      } else if (existing.name === msg.userId && msg.senderName) {
        // Has profile but no real name yet — update from event
        this.memberMgr.update(msg.userId, { name: msg.senderName });
      }
      this.memberMgr.addSession(msg.userId, sessionKey);
    }

    // Check for slash commands
    const isCommand = await this.commandHandler.handle(msg.text, {
      chatId: msg.chatId,
      messageId: msg.messageId,
      sessionKey,
      userId: msg.userId,
      senderName: msg.senderName,
      msg,
    });
    if (isCommand) return;

    // Check if email setup flow is active — route messages there instead of Claude
    if (this.emailSetup.isActive(sessionKey)) {
      const handled = await this.emailSetup.handleMessage(
        sessionKey, msg.chatId, msg.messageId, msg.text,
      );
      if (handled) return;
    }

    // ─── Parallel-agent dispatch ─────────────────────────────────────────
    // Three entry points to fork, in priority order:
    //   1. Explicit `// <prompt>` prefix → always fork (whether main is busy or not)
    //   2. Legacy `/btw` `/parallel` etc. prefix → hint user about new syntax, drop
    //   3. auto-fork mode on + main is busy → silent fork
    //
    // Fork dispatch capacity check: if `parallelRunner.canSpawn()` returns false
    // (slot saturated), fall through to normal queue path.

    // (1) Manual fork via `// <prompt>` — requires space separator to avoid `//comment`
    const manualForkMatch = msg.text.match(/^\/\/\s+(.+)/s);
    if (manualForkMatch) {
      const forkPrompt = manualForkMatch[1].trim();
      if (this.parallelRunner.canSpawn(sessionKey)) {
        // Build a synthetic msg with the prompt-only text so runParallelAgent
        // sees the user's intent cleanly. Original msg.text is replaced in-place
        // (msg is a per-event object, no other consumer reads it after this).
        msg.text = forkPrompt;
        // Explicit `// ` = user clearly wants a reply → forceMention defaults to true
        this.runParallelAgent({ parentSessionKey: sessionKey, prompt: forkPrompt, msg, forceMention: true })
          .catch((err) => this.logger.error({ err, sessionKey }, 'manual `//` fork crashed'));
        return;
      }
      // Saturated — fall through to normal queue (with prompt stripped of `// `)
      msg.text = forkPrompt;
      this.logger.info({ sessionKey, active: this.parallelRunner.activeCount(sessionKey), max: this.parallelRunner.getMax() }, '`//` fork requested but slots full, queueing as normal message');
    }

    // (2) Legacy prefix hint — softly redirect users with muscle memory for old syntax
    const legacyPrefix = msg.text.match(/^(\/btw|\/parallel|\/parallel-agent|\/顺便|\/分身)\s+(.+)/s);
    if (legacyPrefix) {
      const oldCmd = legacyPrefix[1];
      const restPrompt = legacyPrefix[2].trim().slice(0, 40);
      await this.sender.sendText(
        msg.chatId,
        `ℹ️ \`${oldCmd}\` 触发词已废弃。\n\n• 手动 fork：\`// ${restPrompt}${restPrompt.length === 40 ? '…' : ''}\`\n• 开关自动 fork：\`/并行 on\` / \`/并行 off\``,
        msg.messageId,
      );
      return;
    }

    // (3) Auto-fork — only kicks in when main is busy AND flag file exists
    const autoForkOn = (() => {
      try { return fs.existsSync(path.join(session.sessionDir, 'parallel-auto')); } catch { return false; }
    })();
    if (this.runningTasks.has(sessionKey) && autoForkOn && this.parallelRunner.canSpawn(sessionKey)) {
      this.logger.info({ sessionKey, active: this.parallelRunner.activeCount(sessionKey), max: this.parallelRunner.getMax() }, 'auto-fork: main busy, dispatching as fork');
      // Auto-fork = silent fork, NOT user-explicit. Honor /auto reply mode so
      // background group chatter doesn't force a reply (THINKING typing + NO_REPLY allowed).
      this.runParallelAgent({ parentSessionKey: sessionKey, prompt: msg.text, msg, forceMention: false })
        .catch((err) => this.logger.error({ err, sessionKey }, 'auto-fork crashed'));
      return;
    }
    // ────────────────────────────────────────────────────────────────────

    // Check if session is busy — silently queue message (FIFO, processed when current task ends)
    if (this.runningTasks.has(sessionKey)) {
      const queued = this.queue.enqueue(sessionKey, { kind: 'claude-user-msg', sessionKey, msg, enqueuedAt: Date.now() });
      if (queued) {
        this.logger.info(
          { sessionKey, isMentioned: msg.isMentioned, queueSize: this.queue.queueSize(sessionKey) },
          'Message queued (session busy)',
        );
      } else {
        // Queue full — still record non-@mention in context buffer
        if (!msg.isMentioned && msg.chatType === 'group') {
          const session = this.sessionMgr.getOrCreate(sessionKey);
          if (!this.groupContext['buffers'].has(msg.chatId)) {
            this.groupContext.load(session.sessionDir, msg.chatId);
          }
          this.groupContext.add(msg.chatId, {
            timestamp: Date.now(),
            senderName: this.resolveSenderName(msg.senderName, msg.userId),
            senderId: msg.userId,
            text: msg.text,
          });
          this.groupContext.save(session.sessionDir, msg.chatId);
        }
      }

      return;
    }

    // Check global concurrent limit
    if (this.runner.activeCount >= this.config.maxConcurrent) {
      if (msg.isMentioned) {
        await this.sender.sendText(msg.chatId, '⏳ 系统繁忙，请稍后重试', msg.messageId);
      }
      return;
    }

    // Load context buffer if needed (group and DM chats)
    {
      const session = this.sessionMgr.getOrCreate(sessionKey);
      if (!this.groupContext['buffers'].has(msg.chatId)) {
        this.groupContext.load(session.sessionDir, msg.chatId);
      }
    }

    // Auto-reply check: buffer non-@mention messages when appropriate
    if (msg.chatType === 'group' && !msg.isMentioned) {
      let autoReply = 'on';
      try { autoReply = fs.readFileSync(path.join(session.sessionDir, 'auto-reply'), 'utf-8').trim(); } catch {}

      // Skip without sending to Claude:
      // 1. auto=off: all non-@bot messages are buffered
      // 2. auto=on but message @mentions others (not bot): clearly not for Sigma
      const shouldBuffer = autoReply === 'off' || (autoReply === 'on' && msg.hasMentions);
      if (shouldBuffer) {
        this.groupContext.add(msg.chatId, {
          timestamp: Date.now(),
          senderName: this.resolveSenderName(msg.senderName, msg.userId),
          senderId: msg.userId,
          text: msg.text,
        });
        this.groupContext.save(session.sessionDir, msg.chatId);
        return;
      }
    }

    // Store Feishu message for combined WeChat echo+reply (sent after Claude replies)
    if (this.wechatBridge?.isActive(sessionKey) && msg.chatType === 'p2p') {
      this.feishuPendingEcho.set(sessionKey, msg.text);
    }

    // Unified: all messages go through executeMessage
    await this.executeMessage(msg, sessionKey);
  }

  private async executeMessage(msg: IncomingMessage, sessionKey: string): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);
    this.runningTasks.add(sessionKey);

    const abortController = new AbortController();
    this.abortControllers.set(sessionKey, abortController);

    // Check auto-reply mode: 'always' treats all group messages as @mentioned
    let autoReplyMode = 'on';
    if (msg.chatType === 'group') {
      try { autoReplyMode = fs.readFileSync(path.join(session.sessionDir, 'auto-reply'), 'utf-8').trim(); } catch {}
    }
    const isNonMentionGroup = msg.chatType === 'group' && !msg.isMentioned && autoReplyMode !== 'always';

    // Thread reply: only follow thread if message is actually in a thread (has thread_id).
    // root_id alone may just be from quote-reply (not a real thread).
    const existingRootId = msg.threadId ? msg.rootId : undefined;
    let threadRootId: string | undefined = existingRootId;

    // Start typing indicator (THINKING for non-@mention, MeMeMe for @mention).
    // Mutable: when a non-@mention group bot decides to reply, we swap
    // THINKING → MeMeMe (via onWillReply hook below) and the reactionId
    // changes — finally block stops whatever the latest id is.
    let reactionId = await this.typing.start(msg.messageId, isNonMentionGroup ? 'THINKING' : undefined);

    try {
      // Resolve user name: member profile (already created in handleMessage), then fallback
      let userName: string | null = null;
      if (this.memberMgr) {
        const member = this.memberMgr.get(msg.userId);
        if (member?.name && member.name !== msg.userId) userName = member.name;
      }
      if (!userName) userName = msg.senderName || null;
      // Build prompt with context
      let prompt = msg.text;

      // Add user identity prefix (for group chats or general context)
      if (userName) {
        const mcpHint = getFeishuMcpHint(session.sessionDir, msg.userId);
        const safeUserName = userName.replace(/[\n\r\]]/g, ' ');
        const safeMsgUserId = msg.userId.replace(/[\n\r\]]/g, '');
        prompt = `[发送者: ${safeUserName} | id: ${safeMsgUserId}]${mcpHint ? ' ' + mcpHint : ''} ${prompt}`;
      }

      // Inject MEMBER.md (per-user profile, via symlinked members/ dir)
      try {
        const memberMdPath = path.join(session.sessionDir, 'members', msg.userId, 'MEMBER.md');
        if (fs.existsSync(memberMdPath)) {
          const memberMd = fs.readFileSync(memberMdPath, 'utf-8').trim();
          if (memberMd && memberMd.length > 50) { // skip near-empty templates
            const truncated = memberMd.length > 1000 ? memberMd.slice(0, 1000) + '\n...(truncated)' : memberMd;
            prompt = `[用户档案]\n${truncated}\n[/用户档案]\n\n${prompt}`;
          }
        }
      } catch { /* ignore */ }

      // Group messages: the Claude subprocess is persistent and manages its own context.
      // We only inject missed messages (buffered while auto-reply=off or bot was busy).
      // @mention vs non-@mention: same flow, different hint.
      if (msg.chatType === 'group') {
        // Inject missed messages (only non-empty when auto-reply=off had buffered messages)
        const missedStr = this.groupContext.formatMissed(msg.chatId);
        if (missedStr) {
          prompt = `${missedStr}\n\n${prompt}`;
        }

        // Add behavior hint
        if (isNonMentionGroup) {
          prompt = `[群聊消息，未@你。请从第一个 token 开始判断：不需要回复（闲聊、表情、"好的/收到"等无关消息）→ 只输出 NO_REPLY；以下情况正常回复：有人提问、下达指令或任务、用户的消息与你上一条回复高度相关（追问/补充/确认）、讨论你擅长的话题、提到 Sigma。]\n${prompt}`;
        } else {
          prompt = `[你被@提及，必须回复]\n${prompt}`;
        }

        // Record + mark sent (for admin dashboard + missed message tracking)
        this.groupContext.add(msg.chatId, {
          timestamp: Date.now(),
          senderName: userName || this.resolveSenderName(msg.senderName, msg.userId),
          senderId: msg.userId,
          text: msg.text,
        });
        this.groupContext.markSent(msg.chatId);
      } else if (msg.chatType === 'p2p') {
        // Record DM message (for admin dashboard only)
        this.groupContext.add(msg.chatId, {
          timestamp: Date.now(),
          senderName: userName || this.resolveSenderName(msg.senderName, msg.userId),
          senderId: msg.userId,
          text: msg.text,
        });
      }

      // Add quoted message context if present
      if (msg.parentId) {
        // First check local group-context: bot-sent cards return only a fallback
        // string ("请升级至最新版本客户端") via IM get_message, so look up the
        // original markdown by message_id from our own buffer.
        let quotedText: string | null | undefined = this.groupContext.lookupBotReply(msg.chatId, msg.parentId);
        if (!quotedText) {
          quotedText = await this.sender.fetchMessageText(msg.parentId);
        }
        if (quotedText) {
          prompt = `[用户引用了一条消息]\n引用内容: "${quotedText}"\n\n${prompt}`;
        }
      }

      // Fetch merge_forward child messages if present
      if (msg.messageType === 'merge_forward') {
        const mergeContent = await this.sender.fetchMergeForwardContent(msg.messageId);
        if (mergeContent) {
          prompt = prompt.replace('[合并转发消息]', mergeContent);
        }
      }

      // Download images if present
      let images: ImageAttachment[] | undefined;
      if (msg.images && msg.images.length > 0) {
        images = [];
        const savedPaths: string[] = [];
        for (const imgInfo of msg.images) {
          const downloaded = await this.sender.downloadImage(msg.messageId, imgInfo.imageKey);
          if (downloaded) {
            images.push({ base64: downloaded.base64, mediaType: downloaded.mediaType });
            // Save image to session directory so tools (e.g. image-gen-api) can access it
            try {
              const ext = downloaded.mediaType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
              const imgPath = path.join(session.sessionDir, `upload-${Date.now()}-${savedPaths.length}.${ext}`);
              fs.writeFileSync(imgPath, Buffer.from(downloaded.base64, 'base64'));
              savedPaths.push(imgPath);
              this.logger.info({ imageKey: imgInfo.imageKey, imgPath }, 'Saved image to session dir');
            } catch (e) {
              this.logger.warn({ error: e }, 'Failed to save image file');
            }
          }
        }
        if (images.length === 0) images = undefined;
        if (savedPaths.length > 0) {
          prompt += `\n[用户发送的图片已保存: ${savedPaths.join(', ')}]`;
        }
      }

      // Download files if present
      if (msg.files && msg.files.length > 0) {
        const filePaths: string[] = [];
        for (const fileInfo of msg.files) {
          const filePath = await this.sender.downloadFile(msg.messageId, fileInfo.fileKey, fileInfo.fileName, session.sessionDir);
          if (filePath) {
            filePaths.push(filePath);
          }
        }
        if (filePaths.length > 0) {
          prompt += `\n[用户发送的文件已保存: ${filePaths.join(', ')}]`;
        }
      }

      // Execute and reply using the shared pipeline
      await this.executeAndReply({
        sessionKey,
        chatId: msg.chatId,
        prompt,
        sessionDir: session.sessionDir,
        replyToMessageId: msg.messageId,
        existingRootId,
        isNonMentionGroup,
        abortSignal: abortController.signal,
        images,
        // For non-@mention groups: when bot first writes anything, upgrade
        // THINKING → MeMeMe (signal "I've decided to insert a reply").
        onWillReply: isNonMentionGroup
          ? async () => { reactionId = await this.typing.swap(msg.messageId, reactionId, 'MeMeMe'); }
          : undefined,
      });


    } catch (err) {
      this.logger.error({ err, sessionKey }, 'Failed to process message');
      await this.sender.sendReply(msg.chatId, '❌ 处理消息时出错，请重试', undefined, undefined, existingRootId);
    } finally {
      // Stop typing indicator and release lock
      await this.typing.stop(msg.messageId, reactionId);
      this.runningTasks.delete(sessionKey);
      this.abortControllers.delete(sessionKey);

      // If a fork finished while main was busy, the fork bumped pendingRespawn
      // for this sessionKey — respawn now so the next main turn picks up the
      // new jsonl writes (the fork's outputs).
      if (this.pendingRespawn.has(sessionKey)) {
        this.pendingRespawn.delete(sessionKey);
        try { this.runner.respawn(sessionKey); } catch { /* ignore */ }
      }

      // Process next queued message
      await this.processQueue(sessionKey);
    }
  }

  /**
   * Send the Claude result as a reply (shared by quick and background paths).
   */
  private async sendResult(
    msg: IncomingMessage,
    sessionKey: string,
    session: { sessionDir: string },
    result: { fullText: string; error?: string; sessionId?: string },
    reactionId: string | undefined,
    threadRootId?: string,
  ): Promise<void> {
    const replyText = result.fullText || '(空回复)';
    let sentMsgId: string | null = null;
    if (result.error && !result.fullText) {
      await this.sender.sendReply(msg.chatId, `❌ 出错了: ${result.error}`, undefined, undefined, threadRootId);
    } else {
      sentMsgId = await this.sender.sendReply(msg.chatId, replyText, undefined, session.sessionDir, threadRootId);
      await this.sendMentionedFiles(msg.chatId, replyText, session.sessionDir, undefined, threadRootId, sessionKey);
    }

    // Write bot reply to context buffer
    if (msg.chatType === 'group' || msg.chatType === 'p2p') {
      const entries = this.groupContext['buffers'].get(msg.chatId);
      if (entries && entries.length > 0) {
        entries[entries.length - 1].botReply = replyText.length > 50000
          ? replyText.slice(0, 50000) + '...[truncated]' : replyText;
      }
      if (sentMsgId) {
        this.groupContext.setLastBotReplyMessageId(msg.chatId, sentMsgId);
      }
      this.groupContext.save(session.sessionDir, msg.chatId);
    }
  }

  /**
   * Execute a cron job through the standard reply pipeline.
   * No typing indicator, no引用回复, no NO_REPLY injection.
   */
  async executeCronJob(sessionKey: string, chatId: string, prompt: string, jobName: string): Promise<void> {
    // Mute check happens here (before queueing) so muted sessions don't fill the queue
    try {
      const session = this.sessionMgr.getOrCreate(sessionKey);
      if (fs.existsSync(path.join(session.sessionDir, 'muted'))) {
        this.logger.info({ sessionKey, jobName }, 'Session muted, skipping cron job');
        return;
      }
    } catch { /* ignore */ }

    await this.enqueueOrRunJob({ kind: 'claude-cron', sessionKey, chatId, prompt, jobName });
  }

  /**
   * Public entry for non-user producers (cron, alert, wechat, admin chat,
   * IDLE email, agent unsolicited results). Routes the Job through the
   * unified per-session FIFO queue: runs immediately if no task is busy,
   * otherwise enqueues. Caller must not assume completion on return.
   */
  async enqueueOrRunJob(job: Job): Promise<void> {
    if (this.runningTasks.has(job.sessionKey)) {
      const queued = this.queue.enqueue(job.sessionKey, job);
      if (queued) {
        this.logger.info(
          { sessionKey: job.sessionKey, kind: job.kind, queueSize: this.queue.queueSize(job.sessionKey) },
          'Job queued (session busy)',
        );
      } else {
        this.logger.warn({ sessionKey: job.sessionKey, kind: job.kind }, 'Job dropped — queue full');
      }
      return;
    }
    // No task running — execute immediately. runJob's per-kind handler
    // owns the runningTasks lock + finally processQueue chain.
    await this.runJob(job);
  }

  /**
   * Run a queued cron Job. Holds runningTasks lock for the session.
   */
  private async runCronJob(job: Extract<Job, { kind: 'claude-cron' }>): Promise<void> {
    const { sessionKey, chatId, prompt, jobName } = job;
    const session = this.sessionMgr.getOrCreate(sessionKey);
    const cronPrompt = `[定时任务执行: ${jobName}] ${prompt}\n[这是定时任务，必须输出实际文字内容发送给用户]`;

    this.logger.info({ sessionKey, jobName }, 'Executing cron job via reply pipeline');

    this.runningTasks.add(sessionKey);
    const abortController = new AbortController();
    this.abortControllers.set(sessionKey, abortController);

    try {
      await this.executeAndReply({
        sessionKey,
        chatId,
        prompt: cronPrompt,
        sessionDir: session.sessionDir,
        replyToMessageId: undefined,
        existingRootId: undefined,
        isNonMentionGroup: false,
        isCronJob: true,
        abortSignal: abortController.signal,
      });
    } catch (err) {
      this.logger.error({ err, sessionKey, jobName }, 'Cron job execution failed');
      try {
        await this.sender.sendReply(chatId, `⚠️ 定时任务 **${jobName}** 执行失败: ${(err as Error).message}`);
      } catch { /* ignore */ }
    } finally {
      this.runningTasks.delete(sessionKey);
      this.abortControllers.delete(sessionKey);
      await this.processQueue(sessionKey);
    }
  }

  /**
   * Run a queued user-message Job. If the message has been waiting >2s
   * we re-fetch it via Feishu API in case the user edited it while
   * waiting. If the fetch fails (likely because the message was just
   * recalled and the recall event hasn't reached us yet), the job is
   * silently dropped.
   *
   * Note: only text/post messages are re-fetched. Image/file/interactive
   * payloads are immutable in Feishu so refetch adds no value.
   */
  private async runUserMsgJob(job: Extract<Job, { kind: 'claude-user-msg' }>): Promise<void> {
    const waitedMs = job.enqueuedAt ? Date.now() - job.enqueuedAt : 0;
    const refetchable = job.msg.messageType === 'text' || job.msg.messageType === 'post';
    if (waitedMs > 2000 && refetchable) {
      try {
        const fresh = await this.sender.fetchMessageText(job.msg.messageId);
        if (fresh == null) {
          this.logger.warn({ messageId: job.msg.messageId, waitedMs }, 'Queued message gone (likely recalled) — dropping job');
          return;
        }
        if (fresh !== job.msg.text) {
          this.logger.info(
            { messageId: job.msg.messageId, waitedMs, oldLen: job.msg.text.length, newLen: fresh.length },
            'Queued message edited while waiting — using latest content',
          );
          job.msg.text = fresh;
        }
      } catch (err) {
        this.logger.warn({ err, messageId: job.msg.messageId, waitedMs }, 'Failed to refetch queued message — dropping job');
        return;
      }
    }
    await this.executeMessage(job.msg, job.sessionKey);
  }

  /**
   * Public handler for Feishu recall events. Removes the matching job
   * from the queue if it is still waiting. If the message has already
   * been dequeued or finished, this is a no-op (the in-flight LLM
   * task is intentionally NOT cancelled — too disruptive).
   */
  handleRecall(messageId: string, chatId: string): void {
    const removed = this.queue.removeByMessageId(messageId);
    if (removed) {
      this.logger.info(
        { messageId, chatId, kind: removed.kind, sessionKey: removed.sessionKey },
        'Removed recalled message from queue',
      );
    } else {
      this.logger.debug(
        { messageId, chatId },
        'Recall event for message not in queue (already processed or unknown)',
      );
    }
  }

  /**
   * Run a queued WeChat Job. Holds runningTasks lock for the session.
   */
  private async runWechatJob(job: Extract<Job, { kind: 'claude-wechat' }>): Promise<void> {
    const { sessionKey, chatId, prompt, images } = job;
    const session = this.sessionMgr.getOrCreate(sessionKey);

    this.logger.info({ sessionKey, textLen: prompt.length }, 'Running WeChat job via reply pipeline');

    this.runningTasks.add(sessionKey);
    const abortController = new AbortController();
    this.abortControllers.set(sessionKey, abortController);

    try {
      await this.executeAndReply({
        sessionKey,
        chatId,
        prompt,
        sessionDir: session.sessionDir,
        replyToMessageId: undefined,
        existingRootId: undefined,
        isNonMentionGroup: false,
        abortSignal: abortController.signal,
        images,
      });
    } catch (err) {
      this.logger.error({ err, sessionKey }, 'WeChat job execution failed');
    } finally {
      this.runningTasks.delete(sessionKey);
      this.abortControllers.delete(sessionKey);
      await this.processQueue(sessionKey);
    }
  }

  /**
   * Run a queued Admin Chat Job. Holds runningTasks lock for the session.
   */
  private async runAdminChatJob(job: Extract<Job, { kind: 'claude-admin-chat' }>): Promise<void> {
    const { sessionKey, chatId, text, echo, showSource } = job;
    const session = this.sessionMgr.getOrCreate(sessionKey);

    this.logger.info({ sessionKey, textLen: text.length, echo }, 'Running admin chat job via reply pipeline');

    // Stash echo metadata for the streamer to consume after Claude replies
    this.adminChatPendingEcho.set(sessionKey, { text, echo, showSource });

    // Record admin message to group context (chat history persistence)
    if (!this.groupContext['buffers'].has(chatId)) {
      this.groupContext.load(session.sessionDir, chatId);
    }
    this.groupContext.add(chatId, {
      timestamp: Date.now(),
      senderName: 'Admin',
      senderId: 'admin',
      text,
    });
    this.groupContext.save(session.sessionDir, chatId);

    this.runningTasks.add(sessionKey);
    const abortController = new AbortController();
    this.abortControllers.set(sessionKey, abortController);

    try {
      await this.executeAndReply({
        sessionKey,
        chatId,
        prompt: `<admin>${text}</admin>`,
        sessionDir: session.sessionDir,
        replyToMessageId: undefined,
        isNonMentionGroup: false,
        abortSignal: abortController.signal,
      });
    } catch (err) {
      this.logger.error({ err, sessionKey }, 'Admin chat job execution failed');
    } finally {
      this.runningTasks.delete(sessionKey);
      this.abortControllers.delete(sessionKey);
      await this.processQueue(sessionKey);
    }
  }

  /**
   * Look up the cached `<<TOAST:>>` for a form-submit on this card. Used by
   * the event-handler to relay a floating toast back to Feishu in the callback
   * response, before we await any of the actual business work.
   *
   * Returns the model-declared toast if present, otherwise a default success
   * acknowledgement so the user always gets visual confirmation that the submit
   * was received (even if Claude is still busy processing).
   */
  getFormSubmitToast(cardId: string | undefined): { type: 'info' | 'success' | 'warning' | 'error'; content: string } {
    if (!cardId) return { type: 'success', content: '✓ 已提交' };
    const cached = this.buttonCardCache.get(cardId);
    if (cached?.toast) return cached.toast;
    return { type: 'success', content: '✓ 已提交' };
  }

  /**
   * Execute a card action — either a plain button click or a SELECT-form submit.
   * For form submits the click is sent as `[<user> 选择了: name=label / ...]`.
   * Respects the same runningTasks queue as normal messages.
   */
  async executeButtonAction(
    sessionKey: string,
    chatId: string,
    actionId: string,
    label: string,
    userName: string,
    operatorId: string,
    cardId?: string,
    messageId?: string,
    formValue?: Record<string, string | string[]>,
  ): Promise<void> {
    // The submit button always carries FORM_SUBMIT_ACTION; Feishu, however, *omits* form_value
    // entirely when the user clicks submit without filling anything — so we cannot rely on
    // `!!formValue` to detect "this is a form submit". Identify by actionId only and treat
    // missing form_value as the empty case.
    const isFormSubmit = actionId === FORM_SUBMIT_ACTION;

    // Empty-form guard: if the user clicks submit without picking *any* field, silently drop
    // the action. Don't disable the form (so they can pick + retry), don't trigger Claude.
    // Treat `'none'` value (synthetic "不选" option we prepend to every single-select) as
    // equivalent to unselected.
    if (isFormSubmit) {
      const fv = formValue || {};
      const anyFilled = Object.values(fv).some((v) => {
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v !== 'string') return false;
        return v.length > 0 && v !== 'none';
      });
      if (!anyFilled) {
        this.logger.info({ sessionKey, cardId, userName, hasFormValue: !!formValue }, 'Empty form submit ignored');
        return;
      }
    }

    // Update original card immediately (disable buttons / collapse form) — don't wait for queue
    if (cardId) {
      if (isFormSubmit) {
        await this.updateCardSelectState(cardId, formValue!, userName);
      } else {
        await this.updateCardButtonState(cardId, label, userName);
      }
    }

    // If actionId is a slash command, route it through the command handler
    // (same path as if the user had typed it). This lets buttons trigger /model, /effort, etc.
    // Form submits never go through the command handler.
    if (!isFormSubmit && actionId?.startsWith('/')) {
      const handled = await this.commandHandler.handle(actionId, {
        chatId,
        messageId: messageId || '',
        sessionKey,
        userId: operatorId,
        senderName: userName,
      });
      if (handled) {
        this.logger.info({ sessionKey, actionId, userName }, 'Button routed to command handler');
        return;
      }
    }

    // Check if session is muted
    const session = this.sessionMgr.getOrCreate(sessionKey);
    try {
      if (fs.existsSync(path.join(session.sessionDir, 'muted'))) {
        this.logger.debug({ sessionKey }, 'Session muted, ignoring card action');
        return;
      }
    } catch { /* ignore */ }

    // Compose the Claude-facing prompt up-front so both immediate and queued execution
    // see the exact same text.
    const prompt = isFormSubmit
      ? this.buildFormSubmitPrompt(userName, formValue!, cardId)
      : `[${userName} 点击了按钮: ${label}]`;

    // If session is busy, queue the action into the unified Job queue
    if (this.runningTasks.has(sessionKey)) {
      // Pre-rendered prompt is stashed via `label` for form submits (label is unused
      // by runButtonAction beyond the prompt template). To stay backward-compatible
      // with the existing queue Job shape we override `label` to the synthesized text.
      const queued = this.queue.enqueue(sessionKey, {
        kind: 'claude-button',
        sessionKey,
        chatId,
        actionId,
        label: isFormSubmit ? prompt : label,
        userName,
        operatorId,
        cardId,
        messageId,
      });
      if (queued) {
        this.logger.info({ sessionKey, isFormSubmit, queueSize: this.queue.queueSize(sessionKey) }, 'Card action queued (session busy)');
      } else {
        this.logger.warn({ sessionKey, isFormSubmit }, 'Card action dropped — queue full');
      }
      return;
    }

    await this.runButtonAction(sessionKey, chatId, isFormSubmit ? prompt : label, userName, messageId, isFormSubmit);
  }

  /**
   * Render the form_value payload as `[<user> 选择了: name1=label1 / name2=labelA,labelB]`.
   * Looks up each field's option label from the buttonCardCache so Claude sees human-readable
   * text. Multi-select values arrive as string[] (one per chosen option) and get joined with commas.
   */
  private buildFormSubmitPrompt(userName: string, formValue: Record<string, string | string[] | boolean>, cardId?: string): string {
    const cached = cardId ? this.buttonCardCache.get(cardId) : undefined;
    const selects: SelectInfo[] = cached?.selects || [];
    const multiSelects: MultiSelectInfo[] = cached?.multiSelects || [];
    const checkers: CheckerInfo[] = cached?.checkers || [];
    const checkerNames = new Set(checkers.map(c => c.name));
    const selectParts: string[] = [];
    const checkLines: string[] = [];
    for (const [name, value] of Object.entries(formValue)) {
      // Skip noise from Feishu — the submit button gets reported as `undefined: null` when
      // it has no `name` field. CHECK values are booleans (false is meaningful: explicitly
      // unchecked), so don't drop them like we drop null/empty SELECT values.
      if (name === 'undefined' || name === '') continue;
      if (checkerNames.has(name)) {
        const chk = checkers.find(c => c.name === name);
        const checked = value === true || value === 'true';
        checkLines.push(`  ${checked ? '☑' : '☐'} ${chk?.text || name}`);
        continue;
      }
      if (value == null) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        const msel = multiSelects.find((s) => s.name === name);
        const labels = value.map((v) => msel?.options.find((o) => o.key === v)?.label || v);
        selectParts.push(`${name}=${labels.join(',')}`);
      } else {
        if (typeof value === 'string' && value.length === 0) continue;
        if (value === 'none') continue;
        const sel = selects.find((s) => s.name === name);
        const opt = sel?.options.find((o) => o.key === value);
        const labelText = opt?.label || value;
        selectParts.push(`${name}=${labelText}`);
      }
    }
    if (selectParts.length === 0 && checkLines.length === 0) return `[${userName} 提交了表单]`;
    const header = `[${userName} 选择了:`;
    const body: string[] = [];
    if (checkLines.length > 0) body.push(...checkLines);
    if (selectParts.length > 0) body.push(`  ${selectParts.join(' / ')}`);
    return `${header}\n${body.join('\n')}\n]`;
  }

  /**
   * Actually run a button action (called when session is free).
   * If `labelIsPrompt` is true, `label` is treated as the fully-rendered prompt
   * (used for form-submit actions whose prompt was built up-front from form_value).
   */
  private async runButtonAction(sessionKey: string, chatId: string, label: string, userName: string, messageId?: string, labelIsPrompt = false): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);
    const prompt = labelIsPrompt ? label : `[${userName} 点击了按钮: ${label}]`;

    this.logger.info({ sessionKey, label, userName, messageId, labelIsPrompt }, 'Executing button action via reply pipeline');

    // Store button echo for WeChat dual-send
    if (this.wechatBridge?.isActive(sessionKey)) {
      this.feishuPendingEcho.set(sessionKey, labelIsPrompt
        ? prompt.replace(/^\[|\]$/g, '')
        : `${userName} 点击了按钮: ${label}`);
    }

    this.runningTasks.add(sessionKey);
    const abortController = new AbortController();
    this.abortControllers.set(sessionKey, abortController);

    // Add MeMeMe reaction to the card message (same as @bot messages)
    let reactionId: string | null = null;
    if (messageId) {
      reactionId = await this.typing.start(messageId);
    }

    try {
      await this.executeAndReply({
        sessionKey,
        chatId,
        prompt,
        sessionDir: session.sessionDir,
        replyToMessageId: messageId || undefined,
        existingRootId: undefined,
        isNonMentionGroup: false,
        abortSignal: abortController.signal,
      });
    } catch (err) {
      this.logger.error({ err, sessionKey, label }, 'Button action execution failed');
      await this.sender.sendReply(chatId, `⚠️ 按钮操作失败: ${(err as Error).message}`);
    } finally {
      // Remove typing indicator from card message
      if (messageId && reactionId) {
        await this.typing.stop(messageId, reactionId);
      }
      this.runningTasks.delete(sessionKey);
      this.abortControllers.delete(sessionKey);

      // Process next queued item (messages or button actions)
      await this.processQueue(sessionKey);
    }
  }

  /**
   * Update original card to disable callback buttons and show who clicked.
   * Link buttons (behaviors[0].type === 'open_url') stay enabled — they're stateless.
   * Modifies the clicked button label to "label@userName".
   */
  private async updateCardButtonState(cardId: string, clickedLabel: string, userName: string): Promise<void> {
    const cached = this.buttonCardCache.get(cardId);
    this.logger.info({ cardId, cacheHit: !!cached, cacheSize: this.buttonCardCache.size }, 'Button card cache lookup');
    if (!cached) {
      return;
    }

    try {
      const cardJson = JSON.parse(JSON.stringify(cached.cardJson)) as any; // deep clone
      const elements = cardJson?.body?.elements;
      if (!Array.isArray(elements)) return;

      // Find the column_set containing buttons and update them
      for (const el of elements) {
        if (el.tag === 'column_set' && Array.isArray(el.columns)) {
          for (const col of el.columns) {
            if (!Array.isArray(col.elements)) continue;
            for (const btn of col.elements) {
              if (btn.tag !== 'button') continue;
              const isLinkButton = btn.behaviors?.[0]?.type === 'open_url';
              if (!isLinkButton) {
                btn.disabled = true;
              }
              // Mark the clicked button with "label@userName"
              const btnLabel = btn.behaviors?.[0]?.value?.label || btn.text?.content;
              if (btnLabel === clickedLabel) {
                btn.text = { tag: 'plain_text', content: `${clickedLabel} @${userName}` };
                btn.type = 'primary'; // highlight the clicked one
              }
            }
          }
        }
      }

      const newSequence = cached.sequence + 1;
      await (this.sender.larkClient.cardkit as any).v1.card.update({
        path: { card_id: cardId },
        data: {
          card: { type: 'card_json', data: JSON.stringify(cardJson) },
          sequence: newSequence,
        },
      });
      cached.sequence = newSequence;
      this.logger.info({ cardId, clickedLabel, userName }, 'Updated card button state');
    } catch (err) {
      this.logger.warn({ err, cardId }, 'Failed to update card button state');
    }
  }

  /**
   * Collapse a SELECT-form card after submission:
   *   - replace each `select_static` with a read-only `**<placeholder>**：<选中 label>` markdown line
   *   - disable the form's submit button and rewrite its text to `✓ 已提交 @<userName>`.
   *
   * The form element is wrapped in a `column_set`-like or `form` tag — we walk the
   * top-level `body.elements` and any nested `elements` array to find it.
   */
  private async updateCardSelectState(cardId: string, formValue: Record<string, string | string[] | boolean>, userName: string): Promise<void> {
    const cached = this.buttonCardCache.get(cardId);
    this.logger.info({ cardId, cacheHit: !!cached, cacheSize: this.buttonCardCache.size }, 'Select-form card cache lookup');
    if (!cached) return;

    const selects: SelectInfo[] = cached.selects || [];
    const multiSelects: MultiSelectInfo[] = cached.multiSelects || [];
    const checkers: CheckerInfo[] = cached.checkers || [];

    try {
      const cardJson = JSON.parse(JSON.stringify(cached.cardJson)) as any; // deep clone
      const elements = cardJson?.body?.elements;
      if (!Array.isArray(elements)) return;

      // Find the form element and rebuild its `elements` list in-place.
      let replaced = false;
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (el?.tag !== 'form' || !Array.isArray(el.elements)) continue;

        const newFormElements: object[] = [];
        for (const child of el.elements) {
          if (child?.tag === 'select_static') {
            const name: string = child.name;
            const raw = formValue[name];
            const chosenKey = Array.isArray(raw) ? raw[0] : raw;
            const sel = selects.find((s) => s.name === name);
            const placeholder = sel?.placeholder || name;
            // `none` is our synthetic "不选" sentinel — render as 未选.
            const isUnselected = !chosenKey || chosenKey === 'none';
            // Render every option for auditability: ✓ marks the selected one,
            // unselected options stay as plain text joined by `·`. Unselected
            // state shows `(未选)` followed by the alternatives.
            const visibleOptions = (sel?.options || []).filter(o => o.key !== 'none');
            const chosenLabel = !isUnselected
              ? (visibleOptions.find(o => o.key === chosenKey)?.label || chosenKey || '')
              : '';
            const recapParts = isUnselected
              ? ['(未选)', ...visibleOptions.map(o => o.label)]
              : visibleOptions.map(o => o.label === chosenLabel ? `✓ ${o.label}` : o.label);
            newFormElements.push({
              tag: 'markdown',
              content: `**${placeholder}**：${recapParts.join(' · ')}`,
            });
          } else if (child?.tag === 'multi_select_static') {
            const name: string = child.name;
            const raw = formValue[name];
            const chosenKeys: string[] = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? [raw] : []);
            const msel = multiSelects.find((s) => s.name === name);
            const placeholder = msel?.placeholder || name;
            const chosenSet = new Set(chosenKeys);
            const recapParts = (msel?.options || []).map(o =>
              chosenSet.has(o.key) ? `✓ ${o.label}` : o.label
            );
            const content = chosenKeys.length === 0
              ? `**${placeholder}**：(未选) · ${recapParts.join(' · ')}`
              : `**${placeholder}**：${recapParts.join(' · ')}`;
            newFormElements.push({
              tag: 'markdown',
              content,
            });
          } else if (child?.tag === 'checker') {
            const name: string = child.name;
            const raw = formValue[name];
            const checked = raw === true || raw === 'true';
            const chk = checkers.find((c) => c.name === name);
            const text = chk?.text || child.text?.content || name;
            // ☑/☐ unicode squared chars render reliably across Feishu desktop/mobile;
            // matches the form-submit-prompt format Claude sees for consistency.
            newFormElements.push({
              tag: 'markdown',
              content: `${checked ? '☑' : '☐'} ${text}`,
            });
          } else if (child?.tag === 'button') {
            // Submit button — rewrite text + disable. @ the operator on this button only.
            newFormElements.push({
              ...child,
              text: { tag: 'plain_text', content: `✓ 已提交 @${userName}` },
              type: 'primary',
              disabled: true,
            });
          } else {
            newFormElements.push(child);
          }
        }
        el.elements = newFormElements;
        replaced = true;
        break;
      }

      if (!replaced) {
        this.logger.warn({ cardId }, 'updateCardSelectState: no form element found in cached card');
        return;
      }

      const newSequence = cached.sequence + 1;
      await (this.sender.larkClient.cardkit as any).v1.card.update({
        path: { card_id: cardId },
        data: {
          card: { type: 'card_json', data: JSON.stringify(cardJson) },
          sequence: newSequence,
        },
      });
      cached.sequence = newSequence;
      this.logger.info({ cardId, fields: Object.keys(formValue), userName }, 'Updated card select-form state');
    } catch (err) {
      this.logger.warn({ err, cardId }, 'Failed to update card select-form state');
    }
  }

  /**
   * `/并行` driver. Spawns a parallel agent that reuses the *exact same* reply
   * pipeline as normal messages — typing indicator, reply quote, streaming
   * card, MCP tools — so users can't tell the difference from regular ops.
   *
   * Mechanism: synthesize a fork sessionKey (so ProcessPool gives us a fresh
   * Claude child with its own transcript) while pointing it at the parent
   * sessionDir (so CLAUDE.md, .claude/skills, members, git, mcp-servers.json,
   * Chrome MCP — everything — is shared). The fork's process is killed and
   * its slot freed on completion.
   *
   * Concurrency: ParallelRunner caps at 2 forks per parent session.
   * Tradeoff: fork does NOT see parent's prior conversation history yet —
   * future work will copy the parent transcript jsonl into a new sessionId
   * and pre-seed savedSessionIds so the fork can `--resume` it.
   */

  /**
   * Helper: compute Claude Code's jsonl path for a sessionDir + sessionId.
   * Claude Code encodes `<projectDir>` by replacing `/` and `_` with `-`,
   * then stores the transcript at `~/.claude/projects/<encoded>/<sessionId>.jsonl`.
   * Returns null if either input is missing.
   */
  private jsonlPathFor(sessionDir: string | undefined, sessionId: string | null | undefined): string | null {
    if (!sessionDir || !sessionId) return null;
    const encoded = sessionDir.replace(/[/_.]/g, '-');
    return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
  }

  /** Helper: fs.statSync mtime in ms, or 0 if path missing. */
  private jsonlMtimeMs(jsonlPath: string | null): number {
    if (!jsonlPath) return 0;
    try { return fs.statSync(jsonlPath).mtimeMs; } catch { return 0; }
  }

  async runParallelAgent(opts: {
    parentSessionKey: string;
    prompt: string;
    msg: IncomingMessage;
    /**
     * `true` (default) → fork bypasses the "is-this-msg-for-me" check: always
     * treated as @mentioned, must reply, MeMeMe typing. Used for explicit `// `
     * prefix where the user is clearly asking the bot to do something.
     *
     * `false` → fork behaves like a regular group message: honors `/auto` mode,
     * uses THINKING typing for non-@-mention groups, lets Claude decide via
     * NO_REPLY. Used for auto-fork mode (main busy → silent fork) so background
     * chatter doesn't generate spam replies.
     */
    forceMention?: boolean;
  }): Promise<void> {
    const { msg, forceMention = true } = opts;

    const parentSession = this.sessionMgr.getOrCreate(opts.parentSessionKey);
    const parentSessionId = this.runner.getSavedSessionId(opts.parentSessionKey);
    const jsonlPath = this.jsonlPathFor(parentSession.sessionDir, parentSessionId);
    const currentMtime = this.jsonlMtimeMs(jsonlPath);

    // Try to reuse a warm agent first. Warm = an agent that finished last in
    // this pool and was kept alive specifically to absorb the next message.
    // `takeWarmIfFresh` returns it only when its captured jsonl mtime matches
    // current — if drifted, fall through to spawn fresh.
    let warm = this.parallelRunner.takeWarmIfFresh(opts.parentSessionKey, currentMtime);
    let forkSessionKey: string;
    if (warm) {
      forkSessionKey = warm.syntheticKey;
      this.logger.info({ parentSessionKey: opts.parentSessionKey, forkSessionKey, currentMtime },
        'Reusing warm agent (jsonl mtime match)');
    } else {
      // No reusable warm. Evict any stale warm first (mtime drifted) — kill it
      // since we'd need to respawn anyway, and we may need its slot.
      const staleKey = this.parallelRunner.evictWarm(opts.parentSessionKey);
      if (staleKey) {
        try { this.runner.reset(staleKey); } catch { /* ignore */ }
        this.logger.info({ parentSessionKey: opts.parentSessionKey, staleKey },
          'Evicted stale warm agent (jsonl drifted)');
      }
      if (!this.parallelRunner.canSpawn(opts.parentSessionKey)) {
        await this.sender.sendText(
          msg.chatId,
          `⚠️ 已达并行上限 (${this.parallelRunner.getMax()})，请等当前并行任务完成`,
          msg.messageId,
        );
        return;
      }
      const entry = this.parallelRunner.spawn(opts.parentSessionKey);
      forkSessionKey = entry.syntheticKey;
    }
    // forceMention=true → always treated as @mention. forceMention=false → defer
    // to normal auto-reply judgement: non-@ in a group with auto-reply!=always
    // becomes "isNonMentionGroup" (lets the model emit NO_REPLY for chatter).
    let autoReplyMode = 'on';
    if (msg.chatType === 'group') {
      try { autoReplyMode = fs.readFileSync(path.join(parentSession.sessionDir, 'auto-reply'), 'utf-8').trim(); } catch {}
    }
    const isNonMentionGroup = !forceMention
      && msg.chatType === 'group'
      && !msg.isMentioned
      && autoReplyMode !== 'always';

    // CORE: clone the parent's Claude sessionId onto the fork sessionKey so the
    // fork agent boots with `--resume <parentSessionId>` and sees the parent's
    // full conversation history. Fork and parent then write to the same jsonl —
    // from the agent's POV they're the same logical agent with one transcript.
    // (parentSessionId captured at top of function for jsonl mtime check.)
    if (parentSessionId && !warm) {
      this.runner.setSavedSessionId(forkSessionKey, parentSessionId);
    }

    this.logger.info(
      { parentSessionKey: opts.parentSessionKey, forkSessionKey, parentSessionId, reused: !!warm },
      'Parallel agent dispatching',
    );

    let prompt = opts.prompt;

    // 1) User identity prefix + mcpHint (mirrors onMessage line 510-525)
    let userName: string | null = null;
    if (this.memberMgr) {
      const m = this.memberMgr.get(msg.userId);
      if (m?.name && m.name !== msg.userId) userName = m.name;
    }
    if (!userName) userName = msg.senderName || null;
    if (userName) {
      const mcpHint = getFeishuMcpHint(parentSession.sessionDir, msg.userId);
      const safeUserName = userName.replace(/[\n\r\]]/g, ' ');
      const safeUserId = msg.userId.replace(/[\n\r\]]/g, '');
      prompt = `[发送者: ${safeUserName} | id: ${safeUserId}]${mcpHint ? ' ' + mcpHint : ''} ${prompt}`;
    }

    // 2) MEMBER.md per-user profile (mirrors onMessage line 527-537)
    try {
      const memberMdPath = path.join(parentSession.sessionDir, 'members', msg.userId, 'MEMBER.md');
      if (fs.existsSync(memberMdPath)) {
        const memberMd = fs.readFileSync(memberMdPath, 'utf-8').trim();
        if (memberMd && memberMd.length > 50) {
          const truncated = memberMd.length > 1000 ? memberMd.slice(0, 1000) + '\n...(truncated)' : memberMd;
          prompt = `[用户档案]\n${truncated}\n[/用户档案]\n\n${prompt}`;
        }
      }
    } catch { /* ignore */ }

    // 3) Group context: missed messages + behavior hint + record into history
    if (msg.chatType === 'group') {
      if (!this.groupContext['buffers'].has(msg.chatId)) {
        this.groupContext.load(parentSession.sessionDir, msg.chatId);
      }
      const missedStr = this.groupContext.formatMissed(msg.chatId);
      if (missedStr) prompt = `${missedStr}\n\n${prompt}`;
      // Behavior hint depends on isNonMentionGroup (computed up-top from forceMention).
      // Mirrors handleMessage normal-path branch at line ~603.
      if (isNonMentionGroup) {
        prompt = `[群聊消息，未@你。请从第一个 token 开始判断：不需要回复（闲聊、表情、"好的/收到"等无关消息）→ 只输出 NO_REPLY；以下情况正常回复：有人提问、下达指令或任务、用户的消息与你上一条回复高度相关（追问/补充/确认）、讨论你擅长的话题、提到 Sigma。]\n${prompt}`;
      } else {
        prompt = `[你被@提及，必须回复]\n${prompt}`;
      }
      this.groupContext.add(msg.chatId, {
        timestamp: Date.now(),
        senderName: userName || this.resolveSenderName(msg.senderName, msg.userId),
        senderId: msg.userId,
        text: msg.text,
      });
      this.groupContext.markSent(msg.chatId);
    } else if (msg.chatType === 'p2p') {
      this.groupContext.add(msg.chatId, {
        timestamp: Date.now(),
        senderName: userName || this.resolveSenderName(msg.senderName, msg.userId),
        senderId: msg.userId,
        text: msg.text,
      });
    }

    // 4) Quoted message
    if (msg.parentId) {
      let quotedText: string | null | undefined = this.groupContext.lookupBotReply(msg.chatId, msg.parentId);
      if (!quotedText) quotedText = await this.sender.fetchMessageText(msg.parentId);
      if (quotedText) prompt = `[用户引用了一条消息]\n引用内容: "${quotedText}"\n\n${prompt}`;
    }

    // 5) merge_forward
    if (msg.messageType === 'merge_forward') {
      const mergeContent = await this.sender.fetchMergeForwardContent(msg.messageId);
      if (mergeContent) prompt = prompt.replace('[合并转发消息]', mergeContent);
    }

    // 6) Image attachments — download + inject paths so tools can pick them up
    let images: ImageAttachment[] | undefined;
    if (msg.images && msg.images.length > 0) {
      images = [];
      const savedPaths: string[] = [];
      for (const imgInfo of msg.images) {
        const downloaded = await this.sender.downloadImage(msg.messageId, imgInfo.imageKey);
        if (downloaded) {
          images.push({ base64: downloaded.base64, mediaType: downloaded.mediaType });
          try {
            const ext = downloaded.mediaType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
            const imgPath = path.join(parentSession.sessionDir, `upload-${Date.now()}-${savedPaths.length}.${ext}`);
            fs.writeFileSync(imgPath, Buffer.from(downloaded.base64, 'base64'));
            savedPaths.push(imgPath);
          } catch { /* ignore */ }
        }
      }
      if (images.length === 0) images = undefined;
      if (savedPaths.length > 0) prompt += `\n[用户发送的图片已保存: ${savedPaths.join(', ')}]`;
    }

    // 7) File attachments — same as onMessage
    if (msg.files && msg.files.length > 0) {
      const filePaths: string[] = [];
      for (const fileInfo of msg.files) {
        const filePath = await this.sender.downloadFile(msg.messageId, fileInfo.fileKey, fileInfo.fileName, parentSession.sessionDir);
        if (filePath) filePaths.push(filePath);
      }
      if (filePaths.length > 0) prompt += `\n[用户发送的文件已保存: ${filePaths.join(', ')}]`;
    }

    // Typing reaction — THINKING for non-@ groups (matches main path), MeMeMe otherwise.
    // For non-@ we also pass onWillReply so when the model actually emits a reply
    // (not NO_REPLY), the reaction swaps THINKING → MeMeMe to signal "I'm in".
    let reactionId: string | null = await this.typing.start(
      msg.messageId,
      isNonMentionGroup ? 'THINKING' : undefined,
    ).catch(() => null);

    try {
      await this.executeAndReply({
        sessionKey: forkSessionKey,
        chatId: msg.chatId,
        prompt,
        sessionDir: parentSession.sessionDir,
        replyToMessageId: msg.messageId,
        existingRootId: msg.threadId ? msg.rootId : undefined,
        isNonMentionGroup,
        images,
        onWillReply: isNonMentionGroup
          ? async () => { reactionId = await this.typing.swap(msg.messageId, reactionId, 'MeMeMe'); }
          : undefined,
      });
    } finally {
      if (reactionId) {
        this.typing.stop(msg.messageId, reactionId).catch(() => {});
      }
      // Decide: am I the latest-spawned agent? If yes → stay alive as warm
      // standby (next dispatch may reuse me cheaply). Else → suicide.
      const postMtime = this.jsonlMtimeMs(jsonlPath);
      const decision = this.parallelRunner.complete(opts.parentSessionKey, forkSessionKey, postMtime);
      if (decision === 'suicide') {
        try { this.runner.reset(forkSessionKey); } catch { /* ignore */ }
      } else {
        // 'warm' — keep child process alive; ProcessPool's own 30-min idle
        // checker will eventually reclaim it if no one reuses it.
        this.logger.info(
          { parentSessionKey: opts.parentSessionKey, forkSessionKey, jsonlMtimeMs: postMtime },
          'Agent kept as warm standby (latest-spawned)',
        );
      }

      // Preemptive main respawn: a fork just wrote to jsonl, so the long-lived
      // main process at parentSessionKey now has a stale in-memory history.
      // If main is idle, kill it now (next user msg will fresh-spawn). If main
      // is busy mid-turn, defer via pendingRespawn — its finally block will
      // pick this up. The runner.respawn keeps savedSessionId, so spawn-time
      // --resume reads the latest jsonl. Skip if main is the same key as this
      // fork (impossible with synthetic keys, but defensive).
      if (this.runningTasks.has(opts.parentSessionKey)) {
        this.pendingRespawn.add(opts.parentSessionKey);
      } else {
        try { this.runner.respawn(opts.parentSessionKey); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Shared reply pipeline: run Claude, stream results, send reply.
   * Used by both normal messages and cron jobs.
   */
  private async executeAndReply(opts: {
    sessionKey: string;
    chatId: string;
    prompt: string;
    sessionDir: string;
    replyToMessageId?: string;
    existingRootId?: string;
    isNonMentionGroup: boolean;
    abortSignal?: AbortSignal;
    images?: ImageAttachment[];
    isCronJob?: boolean;
    /** Fire-once hook: invoked the moment the bot first writes anything
     *  visible in Feishu (streaming card sent OR plain-text reply about
     *  to be sent). Used to upgrade THINKING → MeMeMe in non-@ groups. */
    onWillReply?: () => Promise<void> | void;
  }): Promise<void> {
    const { sessionKey, chatId, prompt, sessionDir, replyToMessageId, existingRootId, isNonMentionGroup, abortSignal, images, isCronJob, onWillReply } = opts;

    this.logger.info({ sessionKey, isNonMentionGroup, isCronJob }, 'Entering reply pipeline');

    // If previous turn's card is still waiting for agents, finalize it now.
    const prevStreamer = this.activeStreamers.get(sessionKey);
    if (prevStreamer?.isWaitingForAgents()) {
      this.logger.info({ sessionKey }, 'New turn started — finalizing stale agent card from previous turn');
      prevStreamer.finalizeAfterAgents();
    }

    // Start WeChat typing indicator if bound
    if (this.wechatBridge?.isActive(sessionKey)) {
      this.wechatBridge.startTyping(sessionKey).catch(() => {});
    }

    const streamer = new CardStreamer(this.sender.larkClient, this.logger);
    this.activeStreamers.set(sessionKey, streamer);

    // Pass session info to streamer for button rendering + card cache
    streamer.sessionKey = sessionKey;
    streamer.sessionDir = sessionDir;
    streamer.chatId = chatId;
    streamer.buttonCardCache = this.buttonCardCache;

    // If /stop fires the abort signal mid-stream, flag the streamer so the
    // finalized card uses ⏹ "已暂停" instead of ✅.
    if (abortSignal) {
      const onAbort = () => streamer.markAborted();
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    // First-visible-output hook (THINKING → MeMeMe in non-@ groups). Streaming
    // path fires when the card IM message is delivered; plain-text path fires
    // just before sendReply below. Fire-once, so wrap with a guard.
    let willReplyFired = false;
    const fireWillReply = async () => {
      if (willReplyFired || !onWillReply) return;
      willReplyFired = true;
      try { await onWillReply(); } catch (err) {
        this.logger.warn({ err, sessionKey }, 'onWillReply hook threw');
      }
    };
    if (onWillReply) {
      streamer.onCardSent = () => { void fireWillReply(); };
    }

    let cardCreated = false;
    let cardCreating = false;
    let bufferedText = '';

    const ensureCard = () => {
      if (cardCreated || cardCreating) return;
      cardCreating = true;
      this.logger.info({ sessionKey }, 'Creating streaming card');
      const p = streamer.start(chatId, replyToMessageId, existingRootId, replyToMessageId).then(() => {
        cardCreating = false;
        cardCreated = true;
        if (bufferedText) streamer.updateText(bufferedText);
      });
      streamer.startPromise = p;
    };

    const onText = (key: string, text: string, liveUsage?: LiveUsage & { model?: string }) => {
      if (key !== sessionKey) return;
      bufferedText = text;
      if (liveUsage) streamer.updateLiveUsage(liveUsage);
      if (cardCreated && !cardCreating) {
        streamer.updateText(text);
      }
    };
    const onTool = (key: string, event: { type: 'start' | 'end'; toolName: string; toolInput?: string; toolUseId?: string; isError?: boolean }) => {
      if (key !== sessionKey) return;
      if (event.type === 'start' && !cardCreated && !cardCreating) {
        ensureCard();
      }
      if (event.type === 'start') {
        streamer.addToolCall(event.toolName, event.toolInput, event.toolUseId);
      } else if (event.type === 'end' && event.toolUseId) {
        streamer.updateToolCall(event.toolUseId, event.isError ? 'failed' : 'complete');
      }
    };
    const onThinking = (key: string, thinking: string) => {
      if (key !== sessionKey) return;
      if (!cardCreated && !cardCreating) ensureCard();
      streamer.addThinking(thinking);
    };
    this.runner.onTextStream(sessionKey, onText);
    this.runner.onToolStream(sessionKey, onTool);
    this.runner.onThinkingStream(sessionKey, onThinking);

    // Track running subagents — only real background agents (local_agent), not background bash tasks
    const runningAgents = new Map<string, { toolUseId?: string; description?: string }>();
    this.runner.onSubagentStream(sessionKey, (_key, event) => {
      if (event.type === 'started') {
        // Only track local_agent as a real background agent that should block card completion.
        // local_bash and other task types complete within the same turn and don't need waiting.
        if (event.taskType && event.taskType !== 'local_agent') return;
        runningAgents.set(event.taskId, { toolUseId: event.toolUseId, description: event.description });
        if (event.toolUseId) streamer.registerSubagent(event.taskId, event.toolUseId);
      } else if (event.type === 'progress') {
        if (event.toolName) streamer.addSubagentStep(event.taskId, event.toolName, event.description);
      } else {
        const agent = runningAgents.get(event.taskId);
        runningAgents.delete(event.taskId);
        streamer.completeSubagentSteps(event.taskId);
        if (agent?.toolUseId) streamer.updateToolCall(agent.toolUseId, event.type === 'completed' ? 'complete' : 'failed');
        if (runningAgents.size === 0 && streamer.isWaitingForAgents()) {
          this.logger.info({ sessionKey }, 'All subagents completed, finalizing card');
          streamer.finalizeAfterAgents();
          this.runner.onSubagentStream(sessionKey, undefined);
        }
      }
    });

    try {
      const result = await this.runner.run({
        sessionKey,
        message: prompt + TITLE_INSTRUCTION,
        sessionDir,
        abortSignal,
        images,
      });

      const isFromWechat = this.wechatPendingEcho.has(sessionKey);
      const isFromAdmin = this.adminChatPendingEcho.has(sessionKey);

      let rawText = result.fullText || '';
      // Process <<REACT:emoji>> — send reactions only if there's a real message to react to
      // For WeChat/Admin messages: keep REACT tags, apply them after the echo is sent
      if (replyToMessageId) {
        rawText = await this.processReactions(rawText, replyToMessageId);
      } else if (!isFromWechat && !isFromAdmin) {
        // Cron job or other no-reply context: strip REACT tags
        rawText = rawText.replace(/<{1,2}\s*REACT\s*[:：]\s*\w+\s*>{1,2}\s*/gi, '').trim();
      }
      // For isFromWechat: REACT tags stay in rawText, extracted later in dual-send
      const replyText = rawText.replace(/<{1,2}\s*THREAD\s*>{1,2}\s*/gi, '').trim();
      const streamRootId = existingRootId;
      const cleanText = replyText;
      let plainTextSentMsgId: string | null = null;

      // Detect bare absolute image paths the model wrote without <<IMG:>> wrapper.
      // Used for two things below: (a) force card route so they render inline,
      // (b) feed to sendMentionedFiles as excludePaths so we don't dup-send them
      // as standalone image messages.
      const projectRootForBare = path.resolve(sessionDir, '..', '..');
      const bareImagePaths = detectBareImagePaths(rawText, {
        sessionDir,
        projectRoot: projectRootForBare,
      });
      const bareImageExcludeSet = bareImagePaths.length > 0 ? new Set(bareImagePaths) : undefined;
      const hasBareImagePaths = bareImagePaths.length > 0;

      if (isNoReply(replyText) || (!cardCreated && !cardCreating && isNonMentionGroup && !replyText) || (!cardCreated && !cardCreating && !replyText)) {
        // NO_REPLY or empty text without card — finalize card if it was already created
        if (cardCreated || cardCreating) {
          if (streamer.startPromise) await streamer.startPromise;
          await streamer.complete(bufferedText || '(无回复)');
        }
      } else if (isFromWechat && cardCreated) {
        // WeChat message with tools → card already streaming on Feishu.
        // Complete the card with echo prepended, no separate text message needed.
        const wechatEchoText = this.wechatPendingEcho.get(sessionKey);
        const echoPrefix = wechatEchoText ? `> [来自微信] ${wechatEchoText}\n\n` : '';
        await streamer.complete(echoPrefix + rawText || '(空回复)', {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheCreationTokens: result.cacheCreationTokens,
          peakCallInputTokens: result.peakCallInputTokens,
          peakCallCacheReadTokens: result.peakCallCacheReadTokens,
          peakCallCacheCreationTokens: result.peakCallCacheCreationTokens,
          model: result.model,
          costUsd: result.costUsd,
        });
        await this.sendMentionedFiles(chatId, cleanText, sessionDir, undefined, undefined, sessionKey, bareImageExcludeSet);
        this.wechatPendingEcho.delete(sessionKey); // consumed by card, skip dual-send Feishu
        this.runner.onSubagentStream(sessionKey, undefined);
      } else if (isFromWechat) {
        // WeChat message without tools → no card, dual-send handles combined Feishu message.
        this.logger.info({ sessionKey, textLen: cleanText.length }, 'WeChat message — Feishu reply deferred to dual-send');
        await this.sendMentionedFiles(chatId, cleanText, sessionDir, undefined, undefined, sessionKey);
        this.runner.onSubagentStream(sessionKey, undefined);
      } else if (isFromAdmin) {
        // Admin chat message → Feishu reply deferred to echo in finally block (if echo enabled)
        this.logger.info({ sessionKey, textLen: cleanText.length }, 'Admin chat — Feishu reply deferred to echo');
        await this.sendMentionedFiles(chatId, cleanText, sessionDir, undefined, undefined, sessionKey);
        this.runner.onSubagentStream(sessionKey, undefined);
      } else if (runningAgents.size > 0) {
        if (!cardCreated) ensureCard();
        if (streamer.startPromise) await streamer.startPromise;
        streamer.completeTextOnly(rawText || '(空回复)');
        await this.sendMentionedFiles(chatId, cleanText, sessionDir, undefined, streamRootId, sessionKey, bareImageExcludeSet);
        this.logger.info({ sessionKey, runningAgents: runningAgents.size }, 'Turn done but agents still running');
        setTimeout(() => {
          if (streamer.isWaitingForAgents()) {
            this.logger.warn({ sessionKey }, 'Agent timeout — finalizing card');
            streamer.finalizeAfterAgents();
            this.runner.onSubagentStream(sessionKey, undefined);
          }
        }, 30 * 60 * 1000);
      } else if (!cardCreated && !cardCreating && !rawText.includes('<<BUTTON:') && !rawText.includes('<<SELECT:') && !rawText.includes('<<MSELECT:') && !rawText.includes('<<IMG:') && !rawText.includes('<<CHECK:') && !rawText.includes('<<TOAST:') && !hasBareImagePaths) {
        // No card, no buttons, no inline images — send as plain text
        this.logger.info({ sessionKey, textLen: cleanText.length }, 'No tools used, sending plain text reply');
        await fireWillReply();
        plainTextSentMsgId = await this.sender.sendReply(chatId, cleanText || '(空回复)', replyToMessageId, sessionDir, streamRootId);
        await this.sendMentionedFiles(chatId, cleanText, sessionDir, undefined, streamRootId, sessionKey);
        this.runner.onSubagentStream(sessionKey, undefined);
      } else {
        // Card exists (or in flight), or buttons present — complete as card
        if (!cardCreated) {
          // Card still being created (race) or buttons present without card — wait/create
          if (!cardCreating) ensureCard();
          if (streamer.startPromise) await streamer.startPromise;
        }
        await streamer.complete(rawText || '(空回复)', {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheCreationTokens: result.cacheCreationTokens,
          peakCallInputTokens: result.peakCallInputTokens,
          peakCallCacheReadTokens: result.peakCallCacheReadTokens,
          peakCallCacheCreationTokens: result.peakCallCacheCreationTokens,
          model: result.model,
          costUsd: result.costUsd,
        });
        await this.sendMentionedFiles(chatId, cleanText, sessionDir, undefined, streamRootId, sessionKey, bareImageExcludeSet);
        this.runner.onSubagentStream(sessionKey, undefined);
      }

      // Write bot reply to context buffer
      const cleanReply = replyText.replace(/<{1,2}\s*THREAD\s*>{1,2}\s*/gi, '');
      if (cleanReply && !isNoReply(cleanReply)) {
        if (!this.groupContext['buffers'].has(chatId)) {
          this.groupContext.load(sessionDir, chatId);
        }
        const entries = this.groupContext['buffers'].get(chatId);
        const cappedReply = cleanReply.length > 50000
          ? cleanReply.slice(0, 50000) + '...[truncated]' : cleanReply;
        if (isCronJob) {
          // Cron: add as new context entry
          this.groupContext.add(chatId, {
            timestamp: Date.now(),
            senderName: `⏰ 定时任务`,
            text: prompt,
            botReply: cappedReply,
          });
        } else if (entries && entries.length > 0) {
          entries[entries.length - 1].botReply = cappedReply;
        }
        // Capture the Feishu message_id of whatever was actually sent — card or
        // plain text — so future `引用` of this reply can be reverse-looked-up.
        // Card creation can race; getMessageId() may be null if streamer.start
        // hadn't completed yet, in which case we just skip the index update.
        const cardMsgId = cardCreated ? streamer.getMessageId() : null;
        const sentMsgId = cardMsgId || plainTextSentMsgId;
        if (sentMsgId) {
          this.groupContext.setLastBotReplyMessageId(chatId, sentMsgId);
        }
        this.groupContext.save(sessionDir, chatId);
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        this.logger.info({ sessionKey }, 'Task stopped by user');
        await streamer.complete(streamer.getCurrentText() || '⏹ 任务已中止');
      } else {
        this.logger.error({ err, sessionKey }, 'Reply pipeline failed');
        await streamer.abort(`❌ 出错了: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.runner.onSubagentStream(sessionKey, undefined);
    } finally {
      this.runner.onTextStream(sessionKey, undefined);
      this.runner.onToolStream(sessionKey, undefined);
      this.runner.onThinkingStream(sessionKey, undefined);

      // Admin echo info — read early so WeChat dual-send can check it
      const adminEchoInfo = this.adminChatPendingEcho.get(sessionKey);
      this.adminChatPendingEcho.delete(sessionKey);

      // WeChat dual-send (skip if message is from admin — admin echo handles WeChat separately)
      if (this.wechatBridge?.isActive(sessionKey) && bufferedText && !isNoReply(bufferedText) && !adminEchoInfo) {
        const wechatEcho = this.wechatPendingEcho.get(sessionKey);
        const feishuEcho = this.feishuPendingEcho.get(sessionKey);
        this.wechatPendingEcho.delete(sessionKey);
        this.feishuPendingEcho.delete(sessionKey);

        if (wechatEcho) {
          // Message from WeChat → send reply to WeChat + combined echo+reply to Feishu
          this.wechatBridge.sendToWechat(sessionKey, bufferedText).catch(err => {
            this.logger.warn({ err, sessionKey }, 'Failed to send reply to WeChat');
          });
          // Strip REACT tags from display text, collect them for the Feishu message
          const reactPattern = /<{1,2}\s*REACT\s*[:：]\s*(\w+)\s*>{1,2}\s*/gi;
          const reactEmojis: string[] = [];
          let displayText = bufferedText.replace(reactPattern, (_, emoji) => { reactEmojis.push(emoji); return ''; }).trim();
          const combined = `> [来自微信] ${wechatEcho}\n\n${displayText}`;
          this.sender.sendReply(chatId, combined, undefined, sessionDir, undefined, { sessionKey, chatId }).then(msgId => {
            // Apply REACT emojis to the sent Feishu echo message
            if (msgId && reactEmojis.length > 0) {
              for (const emoji of reactEmojis) {
                this.processReactions(`<<REACT:${emoji}>>`, msgId).catch(() => {});
              }
            }
          }).catch(err => {
            this.logger.warn({ err, sessionKey }, 'Failed to send combined WeChat echo to Feishu');
          });
        } else {
          // Message from Feishu → send combined echo+reply to WeChat
          if (feishuEcho) {
            // Strip markers from reply, then combine with echo prefix
            this.wechatBridge.sendToWechat(sessionKey, `\`[来自飞书] ${feishuEcho}\`\n\n${bufferedText}`).catch(err => {
              this.logger.warn({ err, sessionKey }, 'Failed to send reply to WeChat');
            });
          } else {
            this.wechatBridge.sendToWechat(sessionKey, bufferedText).catch(err => {
              this.logger.warn({ err, sessionKey }, 'Failed to send reply to WeChat');
            });
          }
        }
      }

      // Admin Chat echo

      if (bufferedText && !isNoReply(bufferedText)) {
        // Echo TO admin (when message is from Feishu/WeChat)
        if (this.adminChat?.isConnected(sessionKey) && !adminEchoInfo) {
          const wEcho = this.wechatPendingEcho.get(sessionKey);
          const fEcho = this.feishuPendingEcho.get(sessionKey);
          const source = wEcho ? '微信' : '飞书';
          const originalText = wEcho || fEcho || '';
          if (originalText) {
            this.adminChat.sendEcho(sessionKey, source, originalText, bufferedText);
          } else {
            this.adminChat.sendToAdmin(sessionKey, bufferedText);
          }
        }

        // Echo FROM admin to Feishu + WeChat (when echo checkbox was on)
        if (adminEchoInfo?.echo) {
          // Extract REACT tags before building display text
          const reactPattern = /<{1,2}\s*REACT\s*[:：]\s*(\w+)\s*>{1,2}\s*/gi;
          const reactEmojis: string[] = [];
          const cleanReply = bufferedText.replace(reactPattern, (_, emoji) => { reactEmojis.push(emoji); return ''; }).trim();

          // showSource: true → "[ECHO] 原文\n\n回复", false → 仅回复
          const feishuText = adminEchoInfo.showSource
            ? `> [ECHO] ${adminEchoInfo.text}\n\n${cleanReply}`
            : cleanReply;
          const wechatText = adminEchoInfo.showSource
            ? `\`[ECHO] ${adminEchoInfo.text}\`\n\n${cleanReply}`
            : cleanReply;

          this.sender.sendReply(chatId, feishuText, undefined, sessionDir, undefined, { sessionKey, chatId }).then(msgId => {
            // Apply REACT emojis to the sent Feishu echo message
            if (msgId && reactEmojis.length > 0) {
              for (const emoji of reactEmojis) {
                this.processReactions(`<<REACT:${emoji}>>`, msgId).catch(() => {});
              }
            }
          }).catch(err => {
            this.logger.warn({ err, sessionKey }, 'Failed to send admin echo to Feishu');
          });
          if (this.wechatBridge?.isActive(sessionKey)) {
            this.wechatBridge.sendToWechat(sessionKey, wechatText).catch(err => {
              this.logger.warn({ err, sessionKey }, 'Failed to send admin echo to WeChat');
            });
          }
        }
      }

      const pipelineElapsed = Date.now() - streamer['startTime'];
      const replyMode = cardCreated ? 'card' : (bufferedText ? 'text' : 'empty');
      this.logger.info({ sessionKey, replyMode, elapsed: pipelineElapsed, isCronJob }, 'Reply pipeline done');
    }
  }

  /**
   * Scan Claude's reply for file paths and send them via Feishu.
   * Matches paths in session directory and /tmp/.
   */
  private async sendMentionedFiles(
    chatId: string,
    replyText: string,
    sessionDir: string,
    replyToMessageId?: string,
    rootId?: string,
    sessionKey?: string,
    excludePaths?: Set<string>,
  ): Promise<void> {
    try {
      // Strip <<IMG:path|alt?>> tags — any path referenced by IMG has already been
      // embedded into the card by CardStreamer.complete(), so we must NOT also send
      // it as a standalone image message (would be a duplicate).
      const scanText = replyText.replace(/<{1,2}\s*IMG\s*[:：][^>]+>{1,2}\s*/gi, '');

      // Match absolute paths that look like files (with extensions). The char
      // class includes CJK ideographs so Chinese filenames like "报告.xlsx" are
      // captured. Without this, the regex silently drops paths and the file
      // never reaches the user.
      const escapedDir = sessionDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const projectRoot = path.resolve(sessionDir, '..', '..');
      const escapedRoot = projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pathChar = '[\\w./\\-一-鿿]+';
      const patterns = [
        new RegExp(escapedDir + '/' + pathChar + '\\.\\w+', 'g'),
        new RegExp(escapedRoot + '/' + pathChar + '\\.\\w+', 'g'),
        new RegExp('/tmp/' + pathChar + '\\.\\w+', 'g'),
      ];
      const allMatches: string[] = [];
      for (const p of patterns) {
        const m = scanText.match(p);
        if (m) allMatches.push(...m);
      }
      if (allMatches.length === 0) return;
      const matches = excludePaths && excludePaths.size > 0
        ? allMatches.filter(p => !excludePaths.has(p))
        : allMatches;
      if (matches.length === 0) return;

      // Deduplicate
      const uniquePaths = [...new Set(matches)];
      const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

      for (const filePath of uniquePaths) {
        if (!fs.existsSync(filePath)) continue;

        // Skip very large files (> 30MB, Feishu IM upload API limit)
        const stat = fs.statSync(filePath);
        if (stat.size > 30 * 1024 * 1024) {
          this.logger.warn({ filePath, sizeMB: Math.round(stat.size / 1024 / 1024) }, 'File too large to send');
          continue;
        }

        const ext = path.extname(filePath).toLowerCase();
        if (imageExts.has(ext)) {
          await this.sender.sendImage(chatId, filePath, undefined, rootId);
        } else {
          await this.sender.sendFile(chatId, filePath, undefined, rootId);
        }
        this.logger.info({ filePath }, 'Sent file to Feishu');

        // Also send to WeChat if bound
        if (sessionKey && this.wechatBridge?.isActive(sessionKey)) {
          this.wechatBridge.sendFileToWechat(sessionKey, filePath).catch(err => {
            this.logger.warn({ err, filePath }, 'Failed to send file to WeChat');
          });
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to send mentioned files');
    }
  }

  /**
   * Dequeue the next Job for a session and dispatch by kind.
   * Single FIFO queue covers all Job kinds — messages, buttons, cron, alert,
   * wechat, admin-chat, and broadcast — so they reach the user in order.
   */
  private async processQueue(sessionKey: string): Promise<void> {
    const job = this.queue.dequeue(sessionKey);
    if (!job) return;
    await this.runJob(job);
  }

  /**
   * Execute a single Job. Caller must ensure runningTasks lock is not held
   * by another task in the same session.
   */
  private async runJob(job: Job): Promise<void> {
    this.logger.info({ sessionKey: job.sessionKey, kind: job.kind }, 'Running job');
    switch (job.kind) {
      case 'claude-user-msg':
        await this.runUserMsgJob(job);
        return;
      case 'claude-button': {
        // For form submits the prompt was pre-rendered into `label` at enqueue time;
        // detect that case by actionId so runButtonAction skips the prompt template.
        const labelIsPrompt = job.actionId === FORM_SUBMIT_ACTION;
        await this.runButtonAction(job.sessionKey, job.chatId, job.label, job.userName, job.messageId, labelIsPrompt);
        return;
      }
      case 'claude-cron':
        await this.runCronJob(job);
        return;
      case 'claude-wechat':
        await this.runWechatJob(job);
        return;
      case 'claude-admin-chat':
        await this.runAdminChatJob(job);
        return;
      case 'claude-email-process':
        await this.runEmailProcessJob(job);
        return;
      // Phase 3c will add: claude-alert. Pure broadcasts (Alert
      // message_only, agent results, admin-as-sigma) intentionally
      // bypass the queue — they are <200ms sends that must reach the
      // user immediately and don't risk Claude concurrency.
      default:
        this.logger.error({ kind: (job as Job).kind }, 'Unhandled job kind — Phase 3 not yet wired');
        return;
    }
  }
}
