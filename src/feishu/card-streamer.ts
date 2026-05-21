/**
 * CardKit streaming card orchestrator.
 * Manages the lifecycle of a streaming card: create → stream updates → complete.
 * Uses Feishu CardKit v1 SDK methods for card operations.
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';
import { resolveAtMentions } from './message-sender.js';

/**
 * Fix Markdown for Feishu rendering:
 * 1. Code fences: ``` must be on its own line
 * 2. Tables: | rows must have a blank line before the first row
 */
function fixMarkdownForFeishu(text: string): string {
  // Fix code fences: ensure \n before ```
  text = text.replace(/([^\n])```/g, '$1\n```');
  // Fix tables: ensure \n before first | row when preceded by non-empty line
  text = text.replace(/([^\n|])\n(\|[^\n]+\|)/g, '$1\n\n$2');
  return text;
}
import {
  buildThinkingCard,
  buildStreamingCard,
  buildCompleteCard,
  extractButtons,
  parseInteractive,
  STREAMING_ELEMENT_ID,
  type ToolCallInfo,
  type ButtonInfo,
  type SelectInfo,
  type MultiSelectInfo,
  type CheckerInfo,
  type ToastInfo,
  type ImageInfo,
  type ContentSegment,
  type UsageInfo,
} from './card-builder.js';
import { uploadImageToFeishu } from './image-uploader.js';

const THROTTLE_MS = 1000; // Minimum interval between card updates — paired with
                          // print_frequency_ms below; faster than 1s buys nothing
                          // for human readability and just burns API calls.
const CARD_TEXT_LIMIT = 28000; // Feishu card markdown content limit

export class CardStreamer {
  private cardId: string | null = null;
  private messageId: string | null = null;
  private sequence = 0;
  private lastUpdateTime = 0;
  private pendingText = '';
  private toolCalls: ToolCallInfo[] = [];
  // Thinking entries captured during the turn; rendered as markdown lines interleaved
  // with tool lines in the "X 次工具调用已完成" inner panel by timestamp.
  private thinkingEntries: Array<{ text: string; at: number }> = [];
  private taskIdToToolUseId = new Map<string, string>(); // taskId → toolUseId (for subagent step routing)
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private fallback = false;
  startPromise: Promise<void> | null = null; // Track pending start() for lazy mode
  private startTime = 0;
  // Deferred IM message send (to detect <<THREAD>> in first text)
  private messageSent = false;
  private deferredChatId = '';
  private deferredReplyToMessageId?: string;
  private deferredExistingRootId?: string;
  private deferredUserMessageId?: string;
  // Track in-flight flush to prevent race with complete()
  private inflightFlush: Promise<void> | null = null;
  // For button rendering — set by caller before complete()
  sessionKey?: string;
  sessionDir?: string;
  chatId?: string;
  // Shared cache for button/select card state (set by caller).
  // `selects` / `multiSelects` are populated when the LLM emitted SELECT/MSELECT tags so
  // the form-submit handler can look up placeholder + option labels.
  buttonCardCache?: Map<string, { cardJson: object; sequence: number; expiresAt: number; selects?: SelectInfo[]; multiSelects?: MultiSelectInfo[]; checkers?: CheckerInfo[]; toast?: ToastInfo }>;
  /** Fire-once callback invoked after the card IM message is delivered.
   *  Used by MessageBridge to upgrade the typing reaction (THINKING → MeMeMe)
   *  for non-@mention groups, signaling "I've decided to reply". */
  onCardSent?: () => void;
  private completed = false;
  private aborted = false;

  /** Mark this stream as aborted (e.g. /stop). Affects emoji/labels in the
   *  finalized card so the user can tell the run was paused, not finished. */
  markAborted(): void {
    this.aborted = true;
  }
  // Latest usage snapshot pushed from the stream parser — surfaced in the live footer.
  private liveUsage?: UsageInfo;

  constructor(
    private client: lark.Client,
    private logger: Logger,
  ) {}

  /** Return the current accumulated text (for graceful stop). */
  getCurrentText(): string {
    return this.pendingText;
  }

  /**
   * Push the latest usage snapshot. Stored for the next flush — doesn't trigger
   * a card update on its own, since every usage change arrives alongside a text
   * or tool event that already schedules a flush.
   */
  updateLiveUsage(usage: UsageInfo | undefined): void {
    if (usage) this.liveUsage = usage;
  }

  /**
   * Create a CardKit card entity and prepare for streaming.
   * The actual IM message is deferred until the first text update (to detect <<THREAD>>).
   *
   * @param existingRootId - root_id from the incoming message (already in a thread)
   * @param userMessageId - the user's message ID (potential thread root if <<THREAD>> requested)
   */
  async start(chatId: string, replyToMessageId?: string, existingRootId?: string, userMessageId?: string): Promise<void> {
    this.startTime = Date.now();
    this.deferredChatId = chatId;
    this.deferredReplyToMessageId = replyToMessageId;
    this.deferredExistingRootId = existingRootId;
    this.deferredUserMessageId = userMessageId;

    try {
      // Step 1: Create card entity via CardKit SDK
      const thinkingCard = buildThinkingCard();
      this.logger.info({ cardJson: JSON.stringify(thinkingCard).slice(0, 500) }, 'CardKit create request');
      const createResp = await (this.client.cardkit as any).v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(thinkingCard),
        },
      });

      this.cardId = createResp?.data?.card_id;
      if (!this.cardId) {
        this.logger.warn({ createResp: JSON.stringify(createResp) }, 'CardKit create returned no card_id, falling back');
        this.fallback = true;
        return;
      }

      this.logger.info({ cardId: this.cardId }, 'CardKit card created');

      // Step 2: Enable streaming mode on the card
      // print_frequency_ms = 1000 → Feishu client repaints at most once per second.
      // Without this field, Feishu uses platform-specific defaults that visibly stutter
      // (~5s observed). Matches THROTTLE_MS = 1000 so there's no waste in either direction.
      this.sequence++;
      await (this.client.cardkit as any).v1.card.settings({
        path: { card_id: this.cardId },
        data: {
          settings: JSON.stringify({
            streaming_mode: true,
            print_frequency_ms: { default: 1000, android: 1000, ios: 1000 },
          }),
          sequence: this.sequence,
        },
      });

      this.logger.info({ cardId: this.cardId }, 'Streaming mode enabled');

      // Step 3 (IM message send) is DEFERRED to ensureMessageSent()
      // This allows us to detect <<THREAD>> in the first text before deciding reply mode.
    } catch (err: any) {
      const respData = err?.response?.data;
      this.logger.warn({
        err: err?.message,
        status: err?.response?.status,
        respData: respData ? JSON.stringify(respData) : undefined,
      }, 'CardKit start failed, falling back to normal reply');
      this.fallback = true;
    }
  }

  /**
   * Send the card as an IM message (deferred from start).
   * Detects <<THREAD>> in text to decide whether to use thread reply.
   */
  private async ensureMessageSent(text?: string): Promise<void> {
    if (this.messageSent || !this.cardId) return;
    this.messageSent = true;

    const wantsThread = false; // Thread creation disabled — only follow existing threads via existingRootId

    this.logger.info({
      cardId: this.cardId,
      wantsThread,
      userMessageId: this.deferredReplyToMessageId,
    }, 'Sending card IM message (deferred)');

    try {
      const content = JSON.stringify({
        type: 'card',
        data: { card_id: this.cardId },
      });

      if (this.deferredReplyToMessageId) {
        const resp = await this.client.im.message.reply({
          path: { message_id: this.deferredReplyToMessageId },
          data: {
            content,
            msg_type: 'interactive',
            ...(wantsThread ? { reply_in_thread: true } : {}),
          } as any,
        });
        this.messageId = (resp as any).data?.message_id || null;
      } else {
        const resp = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: this.deferredChatId,
            content,
            msg_type: 'interactive',
          },
        });
        this.messageId = (resp as any).data?.message_id || null;
      }

      this.logger.info({ cardId: this.cardId, messageId: this.messageId, wantsThread }, 'Card message sent');

      // First time the card becomes visible to the user — let MessageBridge
      // upgrade the typing reaction (THINKING → MeMeMe) for non-@mention groups.
      if (this.messageId && this.onCardSent) {
        try { this.onCardSent(); } catch (err) {
          this.logger.warn({ err }, 'onCardSent callback threw');
        }
        this.onCardSent = undefined; // fire-once
      }
    } catch (err: any) {
      this.logger.warn({ err: err?.message, cardId: this.cardId }, 'Failed to send card IM message');
    }
  }

  get isFallback(): boolean {
    return this.fallback;
  }

  /** Return the IM message ID of the card (available after ensureMessageSent). */
  getMessageId(): string | null {
    return this.messageId;
  }

  /**
   * Update the streaming text content. Throttled to avoid API rate limits.
   */
  async updateText(text: string): Promise<void> {
    if (this.fallback || !this.cardId || this.completed) return;

    this.pendingText = text;
    const now = Date.now();

    if (now - this.lastUpdateTime >= THROTTLE_MS) {
      const p = this.flushUpdate();
      this.inflightFlush = p;
      p.finally(() => { if (this.inflightFlush === p) this.inflightFlush = null; });
    } else if (!this.updateTimer) {
      const delay = THROTTLE_MS - (now - this.lastUpdateTime);
      this.updateTimer = setTimeout(() => {
        this.updateTimer = null;
        if (this.completed) return; // Don't flush after complete
        const p = this.flushUpdate().catch(err => {
          this.logger.warn({ err }, 'Throttled card update failed');
        });
        this.inflightFlush = p;
        p.finally(() => { if (this.inflightFlush === p) this.inflightFlush = null; });
      }, delay);
    }
  }

  /** Append a thinking block (no status — thinking is just a text entry). */
  addThinking(text: string): void {
    if (!text?.trim()) return;
    this.thinkingEntries.push({ text: text.trim(), at: Date.now() });
    this.startHeartbeatIfNeeded();
    this.updateText(this.pendingText);
  }

  addToolCall(name: string, input?: string, toolUseId?: string): void {
    let displayName = name;
    if (name === 'Agent') {
      const agentCount = this.toolCalls.filter(t => t.name.startsWith('Agent')).length + 1;
      if (agentCount > 1 || this.toolCalls.some(t => t.name.startsWith('Agent'))) {
        // Relabel all existing Agent entries with #N if not already labeled
        let idx = 1;
        for (const tc of this.toolCalls) {
          if (tc.name === 'Agent') {
            tc.name = `Agent #${idx}`;
            idx++;
          } else if (tc.name.startsWith('Agent #')) {
            idx++;
          }
        }
        displayName = `Agent #${idx}`;
      }
    }
    this.toolCalls.push({
      name: displayName,
      input: input ? (input.length > 200 ? input.slice(0, 200) + '...' : input) : undefined,
      status: 'running',
      startTime: Date.now(),
      toolUseId,
    });
    // Start heartbeat when tool calls are folded (>5), so "总用时" updates every second
    this.startHeartbeatIfNeeded();

    // Trigger card update to show tool activity
    this.updateText(this.pendingText);
  }

  updateToolCall(toolUseId: string, status: 'complete' | 'failed'): void {
    const tc = this.toolCalls.find(t => t.toolUseId === toolUseId);
    if (tc) {
      // If this tool call has a registered background agent (local_agent) still running,
      // don't mark it complete yet — completeSubagentSteps() will do it when the agent finishes.
      if (status === 'complete' && toolUseId && [...this.taskIdToToolUseId.values()].includes(toolUseId)) {
        // Background agent still running — skip completion
        return;
      }
      tc.status = status;
      tc.endTime = Date.now();
      // Cascade: when an Agent finishes, also mark any still-running children as complete.
      if (tc.children && tc.children.length > 0) {
        for (const child of tc.children) {
          if (child.status === 'running') {
            child.status = 'complete';
            child.endTime = Date.now();
          }
        }
      }
    }
    if (!tc) {
      const running = [...this.toolCalls].reverse().find(t => t.status === 'running');
      if (running) {
        running.status = status;
        running.endTime = Date.now();
        if (running.children && running.children.length > 0) {
          for (const child of running.children) {
            if (child.status === 'running') {
              child.status = 'complete';
              child.endTime = Date.now();
            }
          }
        }
      }
    }
    // Trigger card update to reflect tool status change
    this.updateText(this.pendingText);
  }


  /**
   * Finalize the card with complete content.
   */
  async complete(fullText: string, usage?: UsageInfo): Promise<void> {
    // Wait for lazy start() to finish before completing
    if (this.startPromise) {
      await this.startPromise;
      this.startPromise = null;
    }
    if (this.fallback || !this.cardId) return;

    this.completed = true;
    this.stopHeartbeat();

    // Use streaming-accumulated text if it's longer than result text.
    // The result event often contains a short summary that would overwrite
    // the full content shown during streaming.
    if (this.pendingText && this.pendingText.length > fullText.length) {
      this.logger.info(
        { pendingLen: this.pendingText.length, resultLen: fullText.length },
        'Using streaming text (longer than result text)',
      );
      fullText = this.pendingText;
    }

    // Ensure IM message is sent before completing
    await this.ensureMessageSent(fullText);

    // Strip <<THREAD>> and REACT tags from display text
    fullText = fullText.replace(/<{1,2}\s*THREAD\s*>{1,2}\s*/gi, '').replace(/<{1,2}\s*REACT\s*[:：]\s*\w+\s*>{1,2}\s*/gi, '');

    // Fix Markdown for Feishu rendering
    fullText = fixMarkdownForFeishu(fullText);

    // Resolve @mentions (e.g. @张三 → <at id=ou_xxx></at>)
    if (this.sessionDir) {
      fullText = resolveAtMentions(fullText, this.sessionDir);
    }

    // Extract <<BUTTON:...>> first (strips them from text), then parseInteractive scans the
    // rest in one pass for IMG / SELECT / MSELECT — returning ordered segments that preserve
    // each tag's position so the renderer can interleave them with markdown.
    // BUTTON is mutually exclusive with form fields (SELECT/MSELECT); if both arrive, BUTTON wins
    // and form fields are dropped with a warning. SELECT/MSELECT can coexist (one shared form).
    // IMG is independent and always renders in-place.
    const { cleanText: textWithoutButtons, buttons } = extractButtons(fullText);
    // Pass sessionDir/projectRoot so parseInteractive can lift bare absolute image
    // paths (no <<IMG:>> wrapper) into inline image segments. Lets the model write
    // "/Users/.../screenshot.png" naturally; server-side parsing makes it inline.
    const projectRoot = this.sessionDir
      ? this.sessionDir.replace(/\/sessions\/[^/]+\/?$/, '')
      : undefined;
    const parsed = parseInteractive(textWithoutButtons, {
      sessionDir: this.sessionDir,
      projectRoot,
    });
    const rawImages: ImageInfo[] = parsed.images;
    let segments: ContentSegment[] = parsed.segments;
    fullText = parsed.cleanText;
    let selects: SelectInfo[] = parsed.selects;
    let multiSelects: MultiSelectInfo[] = parsed.multiSelects;
    let checkers: CheckerInfo[] = parsed.checkers;
    if (buttons.length > 0 && (selects.length > 0 || multiSelects.length > 0 || checkers.length > 0)) {
      this.logger.warn({
        cardId: this.cardId,
        buttonCount: buttons.length,
        selectCount: selects.length,
        multiSelectCount: multiSelects.length,
        checkerCount: checkers.length,
      }, 'BUTTON + form fields both present in reply — dropping form fields (mutex)');
      selects = [];
      multiSelects = [];
      checkers = [];
      // Filter form-field segments out so they don't render orphaned.
      segments = segments.filter((s) => s.kind !== 'select' && s.kind !== 'mselect' && s.kind !== 'check');
    }

    // Resolve <<IMG:...>> tags to Feishu image_keys (upload pass). Done at complete() time,
    // not on each flush, since uploading on every throttle would burn API calls.
    // Same-URL dedup within this turn keeps repeated images cheap.
    let resolvedImages: Array<{ imageKey: string | null; url: string; alt?: string }> = [];
    if (rawImages.length > 0) {
      const cache = new Map<string, string | null>();
      for (const img of rawImages) {
        let key = cache.get(img.url);
        if (key === undefined) {
          key = await uploadImageToFeishu(this.client, img.url, this.logger);
          cache.set(img.url, key);
        }
        resolvedImages.push({ imageKey: key, url: img.url, alt: img.alt });
      }
      this.logger.info({
        cardId: this.cardId,
        imageCount: rawImages.length,
        uploaded: resolvedImages.filter((r) => r.imageKey).length,
      }, 'Resolved IMG tags');
    }

    // Truncate to avoid Feishu card size limit
    if (fullText.length > CARD_TEXT_LIMIT) {
      this.logger.warn({ len: fullText.length, limit: CARD_TEXT_LIMIT }, 'Complete card text truncated');
      fullText = fullText.slice(0, CARD_TEXT_LIMIT) + '\n\n...(内容过长，已截断显示)';
    }

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }

    // Wait for any in-flight flush to finish (prevents sequence race)
    if (this.inflightFlush) {
      await this.inflightFlush.catch(() => {});
      this.inflightFlush = null;
    }

    for (const tc of this.toolCalls) {
      if (tc.status === 'running') {
        tc.status = 'complete';
        tc.endTime = Date.now();
      }
    }

    // Use wall-clock time from card creation to now
    const elapsed = Date.now() - this.startTime;

    try {
      const completeCard = buildCompleteCard(
        fullText,
        this.toolCalls.length > 0 ? this.toolCalls : undefined,
        elapsed,
        undefined,
        buttons.length > 0 ? buttons : undefined,
        this.sessionKey,
        this.chatId,
        this.cardId || undefined,
        this.messageId || undefined,
        usage,
        this.thinkingEntries.length > 0 ? this.thinkingEntries : undefined,
        this.aborted,
        selects.length > 0 ? selects : undefined,
        multiSelects.length > 0 ? multiSelects : undefined,
        resolvedImages.length > 0 ? resolvedImages : undefined,
        segments.length > 0 ? segments : undefined,
        checkers.length > 0 ? checkers : undefined,
      );

      // Cache card state for button/select/checker click updates.
      if ((buttons.length > 0 || selects.length > 0 || multiSelects.length > 0 || checkers.length > 0) && this.cardId) {
        if (this.buttonCardCache) {
          this.buttonCardCache.set(this.cardId, {
            cardJson: completeCard,
            sequence: this.sequence + 2, // account for the update + settings calls below
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            selects: selects.length > 0 ? selects : undefined,
            multiSelects: multiSelects.length > 0 ? multiSelects : undefined,
            checkers: checkers.length > 0 ? checkers : undefined,
            toast: parsed.toast,
          });
          this.logger.info(
            { cardId: this.cardId, buttonCount: buttons.length, selectCount: selects.length, multiSelectCount: multiSelects.length, checkerCount: checkers.length, cacheSize: this.buttonCardCache.size },
            'Cached interactive card for click updates',
          );
        } else {
          this.logger.warn({ cardId: this.cardId }, 'buttonCardCache not set on streamer, cannot cache');
        }
      }

      this.sequence++;
      const updateResp = await (this.client.cardkit as any).v1.card.update({
        path: { card_id: this.cardId },
        data: {
          card: {
            type: 'card_json',
            data: JSON.stringify(completeCard),
          },
          sequence: this.sequence,
        },
      });
      this.logger.info({ cardId: this.cardId, updateCode: updateResp?.code, updateMsg: updateResp?.msg }, 'Card update response');

      // Disable streaming mode
      this.sequence++;
      const settingsResp = await (this.client.cardkit as any).v1.card.settings({
        path: { card_id: this.cardId },
        data: {
          settings: JSON.stringify({ streaming_mode: false }),
          sequence: this.sequence,
        },
      });
      this.logger.info({ cardId: this.cardId, settingsCode: settingsResp?.code, settingsMsg: settingsResp?.msg }, 'Card settings response');

      this.logger.info(
        { cardId: this.cardId, toolCalls: this.toolCalls.length, elapsed },
        'Card streaming completed',
      );
    } catch (err) {
      this.logger.warn({ err, cardId: this.cardId }, 'Failed to complete card');
    }
  }

  /** Map taskId to the Agent's toolUseId for subagent step routing. */
  registerSubagent(taskId: string, toolUseId: string): void {
    this.taskIdToToolUseId.set(taskId, toolUseId);
    this.logger.info({ taskId, toolUseId, mapSize: this.taskIdToToolUseId.size }, 'Registered subagent mapping');
  }

  /**
   * Add a subagent step as a child of the corresponding Agent tool call.
   * Previous running child is auto-completed.
   */
  addSubagentStep(taskId: string, toolName: string, description?: string): void {
    const agentToolUseId = this.taskIdToToolUseId.get(taskId);
    const agent = agentToolUseId
      ? this.toolCalls.find(t => t.toolUseId === agentToolUseId)
      : [...this.toolCalls].reverse().find(t => t.name === 'Agent' && t.status === 'running');
    if (!agent) {
      this.logger.warn({ taskId, agentToolUseId, toolCallCount: this.toolCalls.length }, 'addSubagentStep: no matching Agent found');
      return;
    }

    if (!agent.children) agent.children = [];

    // Mark previous running children as complete
    for (const child of agent.children) {
      if (child.status === 'running') {
        child.status = 'complete';
        child.endTime = Date.now();
      }
    }

    agent.children.push({
      name: toolName,
      input: description ? (description.length > 200 ? description.slice(0, 200) + '...' : description) : undefined,
      status: 'running',
      startTime: Date.now(),
    });

    this.updateText(this.pendingText);
  }

  /** Mark all running children of a subagent as complete, and the Agent itself. */
  completeSubagentSteps(taskId: string): void {
    const agentToolUseId = this.taskIdToToolUseId.get(taskId);
    const agent = agentToolUseId
      ? this.toolCalls.find(t => t.toolUseId === agentToolUseId)
      : undefined;

    this.taskIdToToolUseId.delete(taskId);

    if (agent) {
      // Mark children as complete
      if (agent.children) {
        for (const child of agent.children) {
          if (child.status === 'running') {
            child.status = 'complete';
            child.endTime = Date.now();
          }
        }
      }
      // Now mark the Agent tool call itself as complete
      if (agent.status === 'running') {
        agent.status = 'complete';
        agent.endTime = Date.now();
      }
    }

    this.updateText(this.pendingText);
  }

  private waitingForAgents = false;

  /**
   * Mark text as final but keep card in streaming mode for agent updates.
   * Call this when the main turn is done but subagents are still running.
   */
  completeTextOnly(fullText: string): void {
    fullText = fullText.replace(/<{1,2}\s*THREAD\s*>{1,2}\s*/gi, '');
    this.pendingText = fullText;
    this.waitingForAgents = true;
    // Ensure IM message is sent
    this.ensureMessageSent(fullText).catch(() => {});
    // Flush current state to card
    this.updateText(fullText);
  }

  /** Whether the card is waiting for subagents to complete. */
  isWaitingForAgents(): boolean {
    return this.waitingForAgents;
  }

  /** Finalize the card after all subagents have completed. */
  async finalizeAfterAgents(): Promise<void> {
    this.waitingForAgents = false;
    await this.complete(this.pendingText || '');
  }

  async abort(error?: string): Promise<void> {
    if (this.fallback || !this.cardId) return;

    this.completed = true;
    this.stopHeartbeat();

    // Ensure IM message is sent before aborting
    await this.ensureMessageSent();

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }

    // Wait for any in-flight flush
    if (this.inflightFlush) {
      await this.inflightFlush.catch(() => {});
      this.inflightFlush = null;
    }

    try {
      const errorCard = buildCompleteCard(
        error || '❌ 处理中断',
        this.toolCalls.length > 0 ? this.toolCalls : undefined,
        Date.now() - this.startTime,
        '⏹ 已中止',
        undefined, undefined, undefined, undefined, undefined, undefined,
        this.thinkingEntries.length > 0 ? this.thinkingEntries : undefined,
      );

      this.sequence++;
      await (this.client.cardkit as any).v1.card.update({
        path: { card_id: this.cardId },
        data: {
          card: {
            type: 'card_json',
            data: JSON.stringify(errorCard),
          },
          sequence: this.sequence,
        },
      });

      this.sequence++;
      await (this.client.cardkit as any).v1.card.settings({
        path: { card_id: this.cardId },
        data: {
          settings: JSON.stringify({ streaming_mode: false }),
          sequence: this.sequence,
        },
      });
    } catch (err) {
      this.logger.warn({ err }, 'Failed to abort card');
    }
  }

  /**
   * Silently delete the card message (for REACT-only / NO_REPLY responses).
   */
  async deleteCard(): Promise<void> {
    this.completed = true;
    this.stopHeartbeat();
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.inflightFlush) {
      await this.inflightFlush.catch(() => {});
      this.inflightFlush = null;
    }
    // Delete the IM message if it was sent
    if (this.messageId) {
      try {
        await this.client.im.message.delete({ path: { message_id: this.messageId } });
        this.logger.info({ messageId: this.messageId }, 'Deleted card message (REACT/NO_REPLY)');
      } catch (err) {
        this.logger.debug({ err, messageId: this.messageId }, 'Failed to delete card message');
      }
    }
  }

  /** Start a 1s heartbeat to keep the footer's elapsed time ticking. */
  private startHeartbeatIfNeeded(): void {
    if (this.heartbeatTimer || this.completed) return;

    this.heartbeatTimer = setInterval(() => {
      if (this.completed || !this.cardId) {
        this.stopHeartbeat();
        return;
      }
      // Force a card refresh so the elapsed time updates
      this.flushUpdate().catch(err => {
        this.logger.warn({ err }, 'Heartbeat card update failed');
      });
    }, 1000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Flush pending text/tool updates to the card.
   */
  private async flushUpdate(): Promise<void> {
    if (!this.cardId) return;

    // Ensure IM message is sent (uses first text to detect <<THREAD>>)
    await this.ensureMessageSent(this.pendingText);

    this.lastUpdateTime = Date.now();
    this.sequence++;

    // Strip THREAD, REACT, BUTTON, TITLE tags from display text (tolerant to single/double
    // brackets, HTML-mixed, garbled closes). TITLE uses the same patterns as extractTitleFromText —
    // closing-shaped tags first so the opening strip doesn't eat the inner TITLE of a garbled close.
    const displayText = this.pendingText
      .replace(/<{1,2}\s*THREAD\s*>{1,2}\s*/gi, '')
      .replace(/<{1,2}\s*REACT\s*[:：]\s*\w+\s*>{1,2}\s*/gi, '')
      .replace(/<{1,2}\s*BUTTON\s*:[^>]+>{1,2}\s*/gi, '')
      .replace(/<{1,2}\s*MSELECT\s*[:：][^>]+>{1,2}\s*/gi, '')
      .replace(/<{1,2}\s*SELECT\s*[:：][^>]+>{1,2}\s*/gi, '')
      .replace(/<{1,2}\s*IMG\s*[:：][^>]+>{1,2}\s*/gi, '')
      .replace(/<[\/\s<]*\/[\/\s<]*TITLE[^>]*?>{0,2}\s*\n?/gi, '')
      .replace(/<{1,2}\s*TITLE\s*[:：]?[^<>\n]*?[<\/\s]*>{1,2}\s*\n?/gi, '');

    // Truncate to avoid Feishu card size limit (card gets silently dropped if too long)
    const truncatedText = displayText.length > CARD_TEXT_LIMIT
      ? displayText.slice(0, CARD_TEXT_LIMIT) + '\n\n...(内容过长，已截断显示)'
      : displayText;

    try {
      const streamingCard = buildStreamingCard(
        truncatedText,
        this.toolCalls,
        this.startTime,
        this.thinkingEntries,
        this.liveUsage,
      );

      await (this.client.cardkit as any).v1.card.update({
        path: { card_id: this.cardId },
        data: {
          card: {
            type: 'card_json',
            data: JSON.stringify(streamingCard),
          },
          sequence: this.sequence,
        },
      });
    } catch (err) {
      this.logger.warn({ err, cardId: this.cardId, seq: this.sequence }, 'Card update failed');
    }
  }
}
