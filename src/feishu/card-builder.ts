/**
 * CardKit 2.0 card builder for streaming replies.
 * Builds Feishu interactive cards for thinking, streaming, and complete states.
 */

export const STREAMING_ELEMENT_ID = 'streaming_text';
export const TOOL_CALLS_ELEMENT_ID = 'tool_calls';

export interface ToolCallInfo {
  name: string;
  input?: string;
  status: 'running' | 'complete' | 'failed';
  startTime: number;
  endTime?: number;
  toolUseId?: string;
  children?: ToolCallInfo[];
}

/** Extended-thinking entry (no status — thinking is a plain text observation). */
export interface ThinkingEntry {
  text: string;
  at: number;
}

/**
 * Get tool-specific emoji based on tool name.
 */
function toolEmoji(name: string): string {
  if (name === 'Agent' || name.startsWith('Agent #')) return '🤖';
  if (name === 'Bash') return '💻';
  if (name === 'Read') return '📖';
  if (name === 'Edit') return '✏️';
  if (name === 'Write') return '📝';
  if (name === 'Grep') return '🔍';
  if (name === 'Glob') return '📁';
  if (name === 'WebSearch' || name === 'WebFetch') return '🌐';
  if (name === 'Skill') return '🧠';
  if (name === 'ToolSearch') return '🔧';
  if (name.startsWith('mcp__chrome-devtools__') || name.startsWith('mcp__remote-browser__')) return '🖥️';
  if (name.startsWith('mcp__feishu')) return '💬';
  if (name.startsWith('mcp__cron')) return '⏰';
  return '🔧';
}

/**
 * Build a "thinking" card — shown while Claude starts processing.
 */
export function buildThinkingCard(): object {
  return {
    schema: '2.0',
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '💭 思考中...' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: [
        {
          tag: 'markdown',
          content: '正在处理你的消息...',
          element_id: STREAMING_ELEMENT_ID,
        },
      ],
    },
  };
}

/**
 * Build a streaming card — updated periodically with new text and tool calls.
 * Thinking entries (if any) are interleaved into the panel body as markdown lines.
 */
export function buildStreamingCard(
  text: string,
  toolCalls?: ToolCallInfo[],
  startTime?: number,
  thinkingEntries?: ThinkingEntry[],
  usage?: UsageInfo,
): object {
  const elements: object[] = [];

  // Detect TITLE tag in streamed text via the shared tolerant parser.
  const { title: extracted, body, color: headerColor } = extractTitleFromText(text || '', 30);
  let displayText = body;
  let headerTitle = extracted;

  const toolCount = toolCalls?.length || 0;
  const thinkingCount = thinkingEntries?.length || 0;

  // Tool + thinking panel — collapsible, default collapsed
  if (toolCount > 0 || thinkingCount > 0) {
    let panelTitle = toolCount > 0 ? `🔄 ${toolCount} 次工具调用` : `🔄 ${thinkingCount} 次思考`;
    if (toolCount > 0 && thinkingCount > 0) panelTitle += ` · ${thinkingCount} 次思考`;
    if (startTime) panelTitle += ` · ${formatDuration(Date.now() - startTime)}`;
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'plain_text',
          content: panelTitle,
        },
      },
      border: { color: 'grey' },
      vertical_spacing: '8px',
      padding: '4px 8px 4px 8px',
      elements: buildToolPanelElements(toolCalls || [], thinkingEntries || [], false),
    });
  }

  // Main text content
  if (displayText) {
    elements.push({
      tag: 'markdown',
      content: displayText,
      element_id: STREAMING_ELEMENT_ID,
    });
  } else {
    elements.push({
      tag: 'markdown',
      content: '正在处理...',
      element_id: STREAMING_ELEMENT_ID,
    });
  }

  // Live footer — 🕙 elapsed · N 工具调用 · tokens · ctx% · cache hit%
  // Each part is only emitted once it has a meaningful non-zero value, so the
  // footer grows naturally as data arrives instead of flashing "0 tokens".
  const footerParts: string[] = [];
  if (startTime) {
    footerParts.push(`🕙 ${formatDuration(Date.now() - startTime)}`);
  } else {
    footerParts.push('🕙');
  }
  if (toolCount > 0) {
    footerParts.push(`${toolCount} tools`);
  }
  if (usage) {
    const totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    if (totalTokens > 0) {
      footerParts.push(`${formatTokenCount(totalTokens)} tokens (in: ${formatTokenCount(usage.inputTokens || 0)} / out: ${formatTokenCount(usage.outputTokens || 0)})`);
    }
    const peakPrompt = (usage.peakCallInputTokens || 0) + (usage.peakCallCacheReadTokens || 0) + (usage.peakCallCacheCreationTokens || 0);
    const aggregatePrompt = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheCreationTokens || 0);
    const promptForCtx = peakPrompt > 0 ? peakPrompt : aggregatePrompt;
    if (promptForCtx > 0) {
      const window = contextWindowOf(usage.model);
      const ctxPct = Math.min(100, Math.round((promptForCtx / window) * 100));
      footerParts.push(`ctx ${ctxPct}%${ctxHint(ctxPct)}`);
    }
    const cacheReadForHit = peakPrompt > 0 ? (usage.peakCallCacheReadTokens || 0) : (usage.cacheReadTokens || 0);
    if (cacheReadForHit > 0 && promptForCtx > 0) {
      const hitPct = Math.round((cacheReadForHit / promptForCtx) * 100);
      footerParts.push(`cache hit ${hitPct}%`);
    }
  }
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: footerParts.join(' · '),
    text_size: 'notation',
  });

  const card: any = {
    schema: '2.0',
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements,
    },
  };
  // Only render header when bot has emitted a TITLE tag
  if (headerTitle) {
    card.header = {
      template: headerColor,
      title: { tag: 'plain_text', content: `✍️ ${headerTitle}` },
    };
  }
  return card;
}

/**
 * Build a complete card — final state with full text and optional reasoning panel.
 * @param title - Custom card header title. If not provided, uses "✅ Sigma".
 */
export interface ButtonInfo {
  label: string;
  actionId: string;
  type?: string; // default, primary, danger
  disabled?: boolean;
  url?: string; // if set, button opens URL instead of triggering callback
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  // Single-call peak — use these (not the turn-aggregate) for ctx% so agent loops
  // don't inflate the indicator past 100%.
  peakCallInputTokens?: number;
  peakCallCacheReadTokens?: number;
  peakCallCacheCreationTokens?: number;
  costUsd?: number;
  model?: string; // resolved model, e.g. "sonnet[1m]" / "opus[1m]" / "haiku"
}

/**
 * Context window size (in tokens) for the given resolved model string.
 * Anything with a `[1m]` suffix gets 1M; otherwise default 200K.
 */
function contextWindowOf(model?: string): number {
  if (model && /\[1m\]/i.test(model)) return 1_000_000;
  return 200_000;
}

/**
 * Turn the context-fill percentage into an actionable hint for the user.
 * Thresholds picked so a hint only appears once the session is genuinely heavy.
 */
function ctxHint(pct: number): string {
  if (pct >= 95) return ' · 🚨 请立即 /compact 或 /new';
  if (pct >= 80) return ' · ⚠️ 建议 /compact';
  if (pct >= 60) return ' · 💡 建议 /compact';
  return '';
}

/**
 * Check if a response is the NO_REPLY sentinel (Claude's signal to skip replying).
 * Tolerant to case, whitespace, separator (_ / space / -), trailing punctuation, surrounding quotes.
 * Only matches when the ENTIRE text is a NO_REPLY variant — partial matches don't count.
 */
export function isNoReply(text: string | null | undefined): boolean {
  if (!text) return false;
  return /^\s*["'`]?\s*NO[\s_-]?REPLY\s*["'`]?\s*[.。!！]*\s*$/i.test(text);
}

/**
 * Custom tag regex patterns — always inline new literals at call sites (global flag carries state).
 * Canonical forms (documented in system-prompt/common.md, accepted by all parsers):
 *   TITLE:   <{1,2}\s*TITLE\s*[:：]\s*([^<>\n]+?)[<\/\s]*>{1,2}       canonical extract
 *            <{1,2}\s*TITLE\s*[:：]?[^<>\n]*?[<\/\s]*>{1,2}\s*\n?     strip (tolerant)
 *            <\/\s*TITLE\s*>{0,2}\s*\n?                               strip orphan closing
 *   BUTTON:  <{1,2}\s*BUTTON\s*:\s*([^|>]+?)\s*\|...>{1,2}            canonical extract
 *            <{1,2}\s*BUTTON\s*:[^>]+>{1,2}\s*                        strip (tolerant)
 *   REACT:   <{1,2}\s*REACT\s*[:：]\s*(\w+)\s*>{1,2}\s*               extract + strip
 *   THREAD:  <{1,2}\s*THREAD\s*>{1,2}\s*                              strip
 * All tolerant to 1-2 angle brackets, case-insensitive (add /i flag), optional spaces, fullwidth colon.
 * TITLE also tolerates trailing `[<\/\s]*` garbage before `>>` (e.g. `<<TITLE:xxx</>>` — Claude sometimes
 * inserts `</` right before the closing double-bracket).
 */

/**
 * Extract <<REACT:emoji>> tags and return the list of emojis and the cleaned text.
 */
export function extractReactions(text: string): { cleanText: string; emojis: string[] } {
  const emojis: string[] = [];
  const cleanText = text.replace(/<{1,2}\s*REACT\s*[:：]\s*(\w+)\s*>{1,2}\s*/gi, (_, emoji) => { emojis.push(emoji); return ''; });
  return { cleanText, emojis };
}

/**
 * Extract a TITLE tag from text. Tolerant to many malformed variants Claude emits:
 *   <<TITLE:xxx>>, <TITLE:xxx>, <<TITLE：xxx>> (fullwidth colon),
 *   <TITLE:xxx</TITLE>, <<TITLE:xxx></TITLE>> (HTML-mixed, missing middle >),
 *   <TITLE>xxx</TITLE> (pure HTML),
 *   <<TITLE>xxx</<TITLE>> (garbled close with stray </< prefix).
 * Returns { title, body } — title is empty string when no TITLE tag found.
 *
 * Closing-tag pattern accepts any combination of `/`, `<`, whitespace as garbage between `<` and `TITLE`,
 * which tolerates common Claude mistakes like `</<TITLE>`, `< / TITLE>`, `</TITLE`.
 */
/**
 * Valid Feishu card header `template` values. Anything else falls back to 'blue'.
 */
const VALID_HEADER_COLORS = new Set([
  'blue', 'wathet', 'turquoise', 'green', 'yellow', 'orange',
  'red', 'carmine', 'violet', 'purple', 'indigo', 'grey',
]);

function normalizeColor(c: string | undefined | null): string {
  if (!c) return 'blue';
  const lower = c.trim().toLowerCase();
  return VALID_HEADER_COLORS.has(lower) ? lower : 'blue';
}

export function extractTitleFromText(text: string, maxLen = 40): { title: string; body: string; color: string } {
  // Priority 0: extended <<TITLE:xxx|color>> — color suffix to drive header.template.
  // Title body must not contain < > | or newline. `[<\/\s]*` before the closing `>>`
  // tolerates trailing garbage like `<<TITLE:xxx|green</>>`.
  let match = text.match(/<{1,2}\s*TITLE\s*[:：]\s*([^<>\n|]+?)\s*\|\s*([a-zA-Z]+)\s*[<\/\s]*>{1,2}\s*\n?/i);
  let color = 'blue';
  if (match) {
    color = normalizeColor(match[2]);
  } else {
    // Priority 1: canonical <<TITLE:xxx>> — title body must not contain < > or newline.
    match = text.match(/<{1,2}\s*TITLE\s*[:：]\s*([^<>\n]+?)[<\/\s]*>{1,2}\s*\n?/i);
  }
  // Priority 2: HTML-mixed <TITLE:xxx</TITLE> — colon form with (possibly garbled) close.
  if (!match) {
    match = text.match(/<{1,2}\s*TITLE\s*[:：]\s*([^<\n]+?)\s*<[\/\s<]*\/[\/\s<]*TITLE[^>]*?>{0,2}\s*\n?/i);
  }
  // Priority 3: pure HTML <TITLE>xxx</TITLE> — no-colon form with (possibly garbled) close
  if (!match) {
    match = text.match(/<{1,2}\s*TITLE\s*>\s*([^<\n]+?)\s*<[\/\s<]*\/[\/\s<]*TITLE[^>]*?>{0,2}\s*\n?/i);
  }
  if (!match) return { title: '', body: text, color: 'blue' };
  let body = text.slice(0, match.index).concat(text.slice((match.index || 0) + match[0].length));
  // Strip any stray TITLE fragments left behind (duplicates, orphan closes — including garbled `</<TITLE>`).
  // The opening-tag strip pattern also catches `<<TITLE:xxx|color>>` variants since `[^<>\n]` permits `|`.
  body = body
    .replace(/<[\/\s<]*\/[\/\s<]*TITLE[^>]*?>{0,2}\s*\n?/gi, '')
    .replace(/<{1,2}\s*TITLE\s*[:：]?[^<>\n]*?[<\/\s]*>{1,2}\s*\n?/gi, '')
    .replace(/^\n+/, '');
  return { title: match[1].trim().slice(0, maxLen), body, color };
}

/**
 * Extract <<BUTTON:label|actionId|type?>> tags from text.
 */
export function extractButtons(text: string): { cleanText: string; buttons: ButtonInfo[] } {
  const buttons: ButtonInfo[] = [];
  // Half/full-width tolerance: `:` or `：`, `|` or `｜`. Mirrors SELECT/MSELECT/CHECK/TOAST/IMG.
  // **label** allows `>` inside text (e.g. "白酒跌幅>2%通知") — relies on the lazy
  // quantifier `+?` to stop at the first `|` separator. **actionId** still rejects
  // `>` because it must end before the closing `>>` and shouldn't contain inequality.
  const cleanText = text.replace(/<{1,2}\s*BUTTON\s*[:：]\s*([^|｜]+?)\s*[|｜]\s*([^|｜>]+?)\s*(?:[|｜]\s*([^>]+?)\s*)?>{1,2}[\s]*/gi, (_, label, actionId, type) => {
    const trimmedAction = actionId.trim();
    const isLink = /^https?:\/\//.test(trimmedAction);
    buttons.push({
      label: isLink ? `🔗 ${label.trim()}` : label.trim(),
      actionId: trimmedAction,
      type: type?.trim(),
      url: isLink ? trimmedAction : undefined,
    });
    return '';
  }).trim();
  return { cleanText, buttons };
}

/** Single SELECT field — parsed from `<<SELECT:placeholder|name|key1=label1|key2=label2|...>>`. */
export interface SelectInfo {
  placeholder: string;
  name: string;
  options: Array<{ key: string; label: string }>;
}

/**
 * Extract <<SELECT:placeholder|name|key1=label1|key2=label2|...>> tags from text.
 * Each tag becomes one dropdown field in the rendered form.
 *
 * Tolerance (mirrors BUTTON's robustness):
 *   - Single-edge brackets: `<SELECT...>` accepted (LLM occasionally drops one)
 *   - Half/full-width separators: `:` or `：`, `|` or `｜`, `=` or `＝`
 *   - Whitespace between any tokens
 *   - Case-insensitive `SELECT`/`select`/`Select`
 *   - Duplicate `name` fields are de-duplicated (keeps first, drops rest)
 */
export function extractSelects(text: string): { cleanText: string; selects: SelectInfo[] } {
  const selects: SelectInfo[] = [];
  const seenNames = new Set<string>();
  // Half- and full-width separator tolerance — full-width `：｜＝` are common when
  // user IME mode is Chinese punctuation. Splitting on the character class
  // [|｜] handles either separator without preprocessing.
  const cleanText = text.replace(/<{1,2}\s*SELECT\s*[:：]\s*([^>]+?)\s*>{1,2}\s*/gi, (_, body) => {
    const parts = String(body)
      .split(/[|｜]/)
      .map((p: string) => p.trim())
      .filter((p: string) => p.length > 0);
    if (parts.length < 3) return ''; // need at least placeholder|name|option1
    const placeholder = parts[0];
    const name = parts[1];
    // Skip duplicate names (same field declared twice → form submit collision)
    if (seenNames.has(name)) return '';
    const options: Array<{ key: string; label: string }> = [];
    for (const opt of parts.slice(2)) {
      // Accept `=` or `＝` (full-width)
      const eq = opt.search(/[=＝]/);
      if (eq > 0) {
        options.push({ key: opt.slice(0, eq).trim(), label: opt.slice(eq + 1).trim() });
      } else {
        // No `=` → reuse the literal as both key and label
        options.push({ key: opt, label: opt });
      }
    }
    if (options.length === 0) return '';
    seenNames.add(name);
    selects.push({ placeholder, name, options });
    return '';
  }).trim();
  return { cleanText, selects };
}

/** Single MSELECT (multi-select) field — same shape as SelectInfo, rendered as `multi_select_static`. */
export interface MultiSelectInfo extends SelectInfo {}

/**
 * Single CHECK field — parsed from `<<CHECK:name|✓?|text|style?>>`. Rendered as a
 * Feishu `checker` element inside the shared form container, so its boolean
 * value is collected with all other fields when the user clicks Submit.
 *
 * `defaultChecked` toggles the initial check state (parsed from `✓`/`1`/`true`).
 * `style` toggles `checked_style` on the rendered element:
 *   - undefined → no visual change when checked (default; best for most pick-options scenarios)
 *   - 'strike'  → strikethrough only ("cancelled / removed")
 *   - 'dim'     → opacity fade only ("read / acknowledged")
 *   - 'done'    → strikethrough + fade ("completed todo / checked-off task")
 */
export interface CheckerInfo {
  name: string;
  text: string;
  defaultChecked: boolean;
  style?: 'strike' | 'dim' | 'done';
}

/**
 * Toast pop-up to show after the user clicks form submit / a button.
 * Returned in the card-callback HTTP response as `{ toast: { type, content } }`.
 * Feishu allowed types: info | success | warning | error.
 *
 * Parsed from `<<TOAST:type|content>>` tags. Not rendered as a visual element
 * (the toast is a floating overlay, not card content) — just stashed on the
 * cached card so the callback handler can return it.
 */
export interface ToastInfo {
  type: 'info' | 'success' | 'warning' | 'error';
  content: string;
}

/** Parsed <<IMG:url|alt?>> tag — `url` is either https or a local absolute path. */
export interface ImageInfo {
  url: string;
  alt?: string;
}

/** Ordered fragment of the reply body — alternating text, image, and form-field markers. */
export type ContentSegment =
  | { kind: 'text'; content: string }
  | { kind: 'image'; index: number }
  | { kind: 'select'; index: number }
  | { kind: 'mselect'; index: number }
  | { kind: 'check'; index: number };

/**
 * Parse <<IMG:url|alt?>> tags in body text. Returns three views of the same content:
 *   - `images`: raw IMG references in order (caller uploads them and gets image_keys)
 *   - `segments`: text/image fragments preserving the *position* of each image so the
 *     renderer can interleave markdown blocks with img elements (inline rendering)
 *   - `cleanText`: text with IMG tags removed (used by callers that only want plain text)
 *
 * Tolerance mirrors BUTTON/SELECT: half/full-width separators, single brackets, case-insensitive.
 */
export function parseImages(text: string): { images: ImageInfo[]; segments: ContentSegment[]; cleanText: string } {
  const images: ImageInfo[] = [];
  const segments: ContentSegment[] = [];
  let cleanText = '';
  let lastEnd = 0;
  const re = /<{1,2}\s*IMG\s*[:：]\s*([^>]+?)\s*>{1,2}\s*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(lastEnd, m.index);
    if (before.length > 0) {
      segments.push({ kind: 'text', content: before });
      cleanText += before;
    }
    const parts = String(m[1]).split(/[|｜]/).map((p: string) => p.trim()).filter((p: string) => p.length > 0);
    if (parts.length > 0) {
      const url = parts[0];
      const alt = parts[1];
      const index = images.length;
      images.push({ url, alt });
      segments.push({ kind: 'image', index });
    }
    lastEnd = m.index + m[0].length;
  }
  const tail = text.slice(lastEnd);
  if (tail.length > 0) {
    segments.push({ kind: 'text', content: tail });
    cleanText += tail;
  }
  cleanText = cleanText.trim();
  return { images, segments, cleanText };
}

/**
 * Backward-compatible wrapper — same shape as before. New callers should use
 * `parseImages` to get position-aware segments.
 */
export function extractImages(text: string): { cleanText: string; images: ImageInfo[] } {
  const r = parseImages(text);
  return { cleanText: r.cleanText, images: r.images };
}

/**
 * Unified position-aware parser for IMG, SELECT, and MSELECT tags. Walks the text
 * once and emits an ordered `segments` list plus the raw lists per tag type:
 *   - `images` for `<<IMG:url|alt?>>`
 *   - `selects` for `<<SELECT:placeholder|name|key=label|...>>`
 *   - `multiSelects` for `<<MSELECT:...>>`
 *
 * Names are deduplicated across SELECT and MSELECT (they share the same form_value
 * keyspace, so a clash would silently overwrite). First wins, later dupes are dropped.
 */
export function parseInteractive(
  text: string,
  opts?: { sessionDir?: string; projectRoot?: string },
): {
  segments: ContentSegment[];
  images: ImageInfo[];
  selects: SelectInfo[];
  multiSelects: MultiSelectInfo[];
  checkers: CheckerInfo[];
  toast: ToastInfo | undefined;
  cleanText: string;
  consumedBarePaths: string[];
} {
  const segments: ContentSegment[] = [];
  const images: ImageInfo[] = [];
  const selects: SelectInfo[] = [];
  const multiSelects: MultiSelectInfo[] = [];
  const checkers: CheckerInfo[] = [];
  let toast: ToastInfo | undefined;
  let cleanText = '';
  let lastEnd = 0;
  // MSELECT first in alternation — guards against any edge case where the engine
  // could short-circuit on SELECT inside MSELECT. CHECK / TOAST are independent
  // (no substring confusion). Tag spelling disambiguates the rest.
  const re = /<{1,2}\s*(IMG|MSELECT|SELECT|CHECK|TOAST)\s*[:：]\s*([^>]+?)\s*>{1,2}\s*/gi;
  const seenFieldNames = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(lastEnd, m.index);
    if (before.length > 0) {
      segments.push({ kind: 'text', content: before });
      cleanText += before;
    }
    const tag = m[1].toUpperCase();
    const parts = String(m[2]).split(/[|｜]/).map((p: string) => p.trim()).filter((p: string) => p.length > 0);

    if (tag === 'IMG') {
      if (parts.length > 0) {
        const idx = images.length;
        images.push({ url: parts[0], alt: parts[1] });
        segments.push({ kind: 'image', index: idx });
      }
    } else if (tag === 'TOAST') {
      // Format: <<TOAST:type|content>>. type defaults to 'success' if absent.
      // Not rendered into segments — purely a side-channel for the callback response.
      if (parts.length >= 1) {
        const allowedTypes = ['info', 'success', 'warning', 'error'];
        let type: ToastInfo['type'] = 'success';
        let content: string;
        if (parts.length >= 2 && allowedTypes.includes(parts[0].toLowerCase())) {
          type = parts[0].toLowerCase() as ToastInfo['type'];
          content = parts.slice(1).join(' | ');
        } else {
          content = parts.join(' | ');
        }
        if (content) toast = { type, content };
      }
    } else if (tag === 'CHECK') {
      // Format:
      //   <<CHECK:name|text>>                       — 2 parts, default unchecked, no style
      //   <<CHECK:name|✓|text>>                     — 3 parts (✓ as checked flag)
      //   <<CHECK:name|✓?|text|style>>              — 4 parts, style ∈ strike|dim|done
      // The last part is treated as `style` only if it matches a known style keyword,
      // otherwise it's appended back into the text (so `<<CHECK:n||a|b>>` keeps `a | b` as text).
      if (parts.length >= 2) {
        const STYLE_RE = /^(strike|dim|done)$/i;
        const name = parts[0];
        let defaultChecked = false;
        let textBody: string;
        let style: CheckerInfo['style'];
        // Empty `✓?` slot (`<<CHECK:n||text|done>>`) gets dropped by the `.filter(p=>p.length>0)`
        // upstream, so 4 raw segments collapse to 3 in `parts[]`. Detect style by the keyword
        // match on the last token instead of by length — works for both 3-part and 4-part shapes.
        const last = parts[parts.length - 1];
        const lastIsStyle = parts.length >= 3 && STYLE_RE.test(last);
        if (lastIsStyle) style = last.toLowerCase() as CheckerInfo['style'];
        const textParts = lastIsStyle ? parts.slice(0, -1) : parts;
        if (textParts.length >= 3) {
          const flag = textParts[1];
          defaultChecked = /^(✓|✔|☑|1|true|y|yes|checked|on)$/i.test(flag);
          textBody = textParts.slice(2).join(' | ');
        } else {
          textBody = textParts[1];
        }
        if (!seenFieldNames.has(name) && textBody) {
          seenFieldNames.add(name);
          const idx = checkers.length;
          checkers.push({ name, text: textBody, defaultChecked, style });
          segments.push({ kind: 'check', index: idx });
        }
      }
    } else {
      // SELECT or MSELECT — same parsing logic
      if (parts.length >= 3) {
        const placeholder = parts[0];
        const name = parts[1];
        if (!seenFieldNames.has(name)) {
          const options: Array<{ key: string; label: string }> = [];
          for (const opt of parts.slice(2)) {
            const eq = opt.search(/[=＝]/);
            if (eq > 0) {
              options.push({ key: opt.slice(0, eq).trim(), label: opt.slice(eq + 1).trim() });
            } else {
              options.push({ key: opt, label: opt });
            }
          }
          if (options.length > 0) {
            seenFieldNames.add(name);
            if (tag === 'MSELECT') {
              const idx = multiSelects.length;
              multiSelects.push({ placeholder, name, options });
              segments.push({ kind: 'mselect', index: idx });
            } else {
              const idx = selects.length;
              selects.push({ placeholder, name, options });
              segments.push({ kind: 'select', index: idx });
            }
          }
        }
      }
    }
    lastEnd = m.index + m[0].length;
  }
  const tail = text.slice(lastEnd);
  if (tail.length > 0) {
    segments.push({ kind: 'text', content: tail });
    cleanText += tail;
  }
  // Second pass: if a sessionDir/projectRoot whitelist was supplied, scan remaining
  // text segments for bare absolute image paths (no <<IMG:>> wrapper) and lift them
  // into inline image segments at their original position. Lets the model write
  // natural-language paths like "/Users/.../shared/screenshot_1.png" without
  // remembering the <<IMG:>> macro — server-side parsing makes it inline anyway.
  const consumedBarePaths: string[] = [];
  if (opts && (opts.sessionDir || opts.projectRoot)) {
    const lifted = liftBareImagePaths(segments, images, opts);
    segments.length = 0; segments.push(...lifted.segments);
    images.length = 0; images.push(...lifted.images);
    consumedBarePaths.push(...lifted.consumedBarePaths);
  }
  cleanText = cleanText.trim();
  return { segments, images, selects, multiSelects, checkers, toast, cleanText, consumedBarePaths };
}

/**
 * Whitelist regex builder for "looks like a local image path we own".
 * Matches absolute paths under sessionDir / projectRoot / /tmp/ with image extensions.
 * Char class allows CJK ideographs (一-鿿) so Chinese filenames work; rejects
 * shell metachars, quotes, brackets, and CJK punctuation that would never
 * appear inside a real filename so we don't over-eat the surrounding text.
 */
function buildBareImagePathRegex(opts: { sessionDir?: string; projectRoot?: string }): RegExp | null {
  const prefixes: string[] = [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.sessionDir) prefixes.push(esc(opts.sessionDir));
  if (opts.projectRoot) prefixes.push(esc(opts.projectRoot));
  prefixes.push('/tmp');
  if (prefixes.length === 0) return null;
  const pathChar = '[\\w./\\-一-鿿]';
  const ext = '(?:png|jpg|jpeg|gif|webp|bmp)';
  // Boundary: rejection list is intentionally narrow — only word chars, hyphens,
  // and CJK ideographs. We DO allow `.` and `/` after the extension so that
  // "...a.png." (sentence-ending period) and "...a.png/sub" don't sabotage the
  // match. `a.pngx` is still rejected because `x` is a word char.
  const body = `(?:${prefixes.join('|')})/${pathChar}+\\.${ext}(?![\\w\\-一-鿿])`;
  return new RegExp(body, 'gi');
}

/**
 * Detect bare absolute image paths in `text` matching the sessionDir/projectRoot/tmp
 * whitelist. Pure helper — used by message-bridge to compute "paths the card will
 * embed inline, so sendMentionedFiles must NOT also send them as standalone files".
 * Skips paths inside ``` fenced code blocks.
 */
export function detectBareImagePaths(
  text: string,
  opts: { sessionDir?: string; projectRoot?: string },
): string[] {
  const re = buildBareImagePathRegex(opts);
  if (!re) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const chunk of splitOutFencedCode(text)) {
    if (chunk.kind !== 'text') continue;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(chunk.content)) !== null) {
      const p = m[0];
      if (!seen.has(p)) { seen.add(p); found.push(p); }
    }
  }
  return found;
}

/**
 * Split text into alternating { kind: 'text' | 'code' } chunks based on triple-backtick
 * fenced blocks. Anything inside a code fence is opaque to bare-path lifting so
 * we don't accidentally rewrite `cp /Users/.../a.png /dst` shell snippets into images.
 * Inline single-backtick code is left alone (negligible false-positive risk vs.
 * complexity of state machine).
 */
function splitOutFencedCode(text: string): Array<{ kind: 'text' | 'code'; content: string }> {
  const out: Array<{ kind: 'text' | 'code'; content: string }> = [];
  const re = /```[\s\S]*?```/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastEnd) out.push({ kind: 'text', content: text.slice(lastEnd, m.index) });
    out.push({ kind: 'code', content: m[0] });
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < text.length) out.push({ kind: 'text', content: text.slice(lastEnd) });
  return out;
}

/**
 * Take existing `segments` + `images` from parseInteractive and rewrite each
 * `text` segment, expanding bare image paths in-place into image segments.
 * Returns the new arrays plus the list of paths that were consumed (so callers
 * can deduplicate against sendMentionedFiles).
 */
function liftBareImagePaths(
  segments: ContentSegment[],
  images: ImageInfo[],
  opts: { sessionDir?: string; projectRoot?: string },
): { segments: ContentSegment[]; images: ImageInfo[]; consumedBarePaths: string[] } {
  const re = buildBareImagePathRegex(opts);
  if (!re) return { segments, images, consumedBarePaths: [] };
  const newSegments: ContentSegment[] = [];
  const newImages: ImageInfo[] = [...images];
  const consumedBarePaths: string[] = [];
  const consumedSeen = new Set<string>();
  // Pre-pass: strip Markdown image syntax `![alt](path)` down to just `path` before
  // the bare-path regex runs — but ONLY for local paths in our whitelist (sessionDir
  // / projectRoot / /tmp/). Otherwise external URL markdown like
  // `![pic](https://example.com/x.png)` would also get flattened to a naked URL,
  // which is worse than leaving the syntax intact (rendered as markdown link).
  const mdImageRe = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  const pathOnlyRe = buildBareImagePathRegex(opts);
  const isLocalImagePath = (p: string): boolean => {
    if (!pathOnlyRe) return false;
    pathOnlyRe.lastIndex = 0;
    const m = pathOnlyRe.exec(p);
    return m !== null && m[0] === p;
  };
  const altMap = new Map<string, string>(); // path → alt (best-effort, first wins)
  const stripMdImageSyntax = (s: string): string =>
    s.replace(mdImageRe, (full, alt: string, p: string) => {
      if (!isLocalImagePath(p)) return full; // leave external/non-image MD intact
      if (alt && !altMap.has(p)) altMap.set(p, alt);
      return p;
    });
  for (const seg of segments) {
    if (seg.kind !== 'text') { newSegments.push(seg); continue; }
    // Walk fenced code-safe sub-chunks; lift only in text portions.
    const subChunks = splitOutFencedCode(seg.content);
    for (const sub of subChunks) {
      if (sub.kind === 'code') {
        newSegments.push({ kind: 'text', content: sub.content });
        continue;
      }
      const stripped = stripMdImageSyntax(sub.content);
      let lastEnd = 0;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stripped)) !== null) {
        const before = stripped.slice(lastEnd, m.index);
        if (before.length > 0) newSegments.push({ kind: 'text', content: before });
        const url = m[0];
        const idx = newImages.length;
        const alt = altMap.get(url);
        newImages.push(alt ? { url, alt } : { url });
        newSegments.push({ kind: 'image', index: idx });
        if (!consumedSeen.has(url)) { consumedSeen.add(url); consumedBarePaths.push(url); }
        lastEnd = m.index + m[0].length;
      }
      const tail = stripped.slice(lastEnd);
      if (tail.length > 0) newSegments.push({ kind: 'text', content: tail });
    }
  }
  return { segments: newSegments, images: newImages, consumedBarePaths };
}

/**
 * Build Feishu card `img` elements from resolved image_keys. Each entry is an
 * `{ image_key, alt? }` tuple — caller has already uploaded the source and got
 * the key back. Entries with no key are rendered as `[图片: <url>]` markdown text
 * so the user knows the upload failed but the message still goes through.
 */
export function buildImageElements(
  resolved: Array<{ imageKey: string | null; url: string; alt?: string }>,
): object[] {
  const out: object[] = [];
  for (const r of resolved) {
    if (r.imageKey) {
      out.push({
        tag: 'img',
        img_key: r.imageKey,
        alt: { tag: 'plain_text', content: r.alt || '' },
        scale_type: 'crop_center',
        preview: true,
      });
    } else {
      out.push({
        tag: 'markdown',
        content: `_[图片: ${r.url}]_`,
      });
    }
  }
  return out;
}

/**
 * Extract <<MSELECT:placeholder|name|key1=label1|key2=label2|...>> tags from text.
 * Same syntax as SELECT but rendered as a `multi_select_static` (user can pick multiple options).
 * Same tolerance rules as extractSelects.
 */
export function extractMultiSelects(text: string): { cleanText: string; multiSelects: MultiSelectInfo[] } {
  const multiSelects: MultiSelectInfo[] = [];
  const seenNames = new Set<string>();
  const cleanText = text.replace(/<{1,2}\s*MSELECT\s*[:：]\s*([^>]+?)\s*>{1,2}\s*/gi, (_, body) => {
    const parts = String(body)
      .split(/[|｜]/)
      .map((p: string) => p.trim())
      .filter((p: string) => p.length > 0);
    if (parts.length < 3) return '';
    const placeholder = parts[0];
    const name = parts[1];
    if (seenNames.has(name)) return '';
    const options: Array<{ key: string; label: string }> = [];
    for (const opt of parts.slice(2)) {
      const eq = opt.search(/[=＝]/);
      if (eq > 0) {
        options.push({ key: opt.slice(0, eq).trim(), label: opt.slice(eq + 1).trim() });
      } else {
        options.push({ key: opt, label: opt });
      }
    }
    if (options.length === 0) return '';
    seenNames.add(name);
    multiSelects.push({ placeholder, name, options });
    return '';
  }).trim();
  return { cleanText, multiSelects };
}

/** Submit action id for SELECT-based interactive forms. */
export const FORM_SUBMIT_ACTION = '__submit_form__';

/** Form name used inside the card (referenced by Feishu form_value payload). */
export const INTERACTIVE_FORM_NAME = 'interactive_form';

/**
 * Build a single Feishu `form` element containing N single-select dropdowns
 * and M multi-select dropdowns, plus a submit button at the end.
 * Single-selects render before multi-selects to keep the simpler decisions first.
 * The submit button uses `form_action_type: submit` so Feishu collects all
 * field values into `event.action.form_value` (string for single, string[] for multi).
 */
export function buildSelectFormElement(
  selects: SelectInfo[],
  ctx: ButtonContext = {},
  submitLabel = '提交',
  multiSelects: MultiSelectInfo[] = [],
  checkers: CheckerInfo[] = [],
): object | null {
  if (!selects.length && !multiSelects.length && !checkers.length) return null;
  if (!ctx.sessionKey) return null; // callback buttons need a session to route to

  const formElements: object[] = [];

  for (const sel of selects) {
    formElements.push({
      tag: 'select_static',
      name: sel.name,
      placeholder: { tag: 'plain_text', content: sel.placeholder },
      options: sel.options.map((opt) => ({
        value: opt.key,
        text: { tag: 'plain_text', content: opt.label },
      })),
    });
  }

  for (const msel of multiSelects) {
    formElements.push({
      tag: 'multi_select_static',
      name: msel.name,
      placeholder: { tag: 'plain_text', content: msel.placeholder },
      options: msel.options.map((opt) => ({
        value: opt.key,
        text: { tag: 'plain_text', content: opt.label },
      })),
    });
  }

  for (const chk of checkers) {
    // checker has no `behaviors` → state stays local until form submit,
    // at which point form_value[name] will be `true`/`false`.
    const el: any = {
      tag: 'checker',
      name: chk.name,
      checked: chk.defaultChecked,
      text: { tag: 'lark_md', content: chk.text },
    };
    if (chk.style === 'strike') el.checked_style = { show_strikethrough: true };
    else if (chk.style === 'dim') el.checked_style = { opacity: 0.6 };
    else if (chk.style === 'done') el.checked_style = { show_strikethrough: true, opacity: 0.6 };
    formElements.push(el);
  }

  formElements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: submitLabel },
    type: 'primary',
    width: 'default',
    form_action_type: 'submit',
    behaviors: [{
      type: 'callback',
      value: {
        action: FORM_SUBMIT_ACTION,
        label: submitLabel,
        sessionKey: ctx.sessionKey || '',
        chatId: ctx.chatId || '',
        cardId: ctx.cardId || '',
        messageId: ctx.messageId || '',
      },
    }],
  });

  return {
    tag: 'form',
    name: INTERACTIVE_FORM_NAME,
    elements: formElements,
  };
}

export interface ButtonContext {
  sessionKey?: string;
  chatId?: string;
  cardId?: string;
  messageId?: string;
}

/**
 * Build Feishu card elements for a list of buttons (2 per row, 50% width each).
 * Link buttons (url set) always render. Callback buttons render only when sessionKey is provided.
 */
export function buildButtonElements(buttons: ButtonInfo[], ctx: ButtonContext = {}): object[] {
  const renderable = buttons.filter(btn => btn.url || ctx.sessionKey);
  if (renderable.length === 0) return [];
  const buildColumn = (btn: ButtonInfo) => {
    const behaviors = btn.url
      ? [{ type: 'open_url', default_url: btn.url }]
      : [{
          type: 'callback',
          value: {
            action: btn.actionId,
            label: btn.label,
            sessionKey: ctx.sessionKey || '',
            chatId: ctx.chatId || '',
            cardId: ctx.cardId || '',
            messageId: ctx.messageId || '',
          },
        }];
    return {
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [{
        tag: 'button',
        type: btn.type || 'default',
        width: 'fill',
        text: { tag: 'plain_text', content: btn.label },
        disabled: btn.disabled || false,
        behaviors,
      }],
    };
  };
  const out: object[] = [];
  for (let i = 0; i < renderable.length; i += 2) {
    const row = renderable.slice(i, i + 2);
    const columns = row.map(buildColumn);
    if (columns.length === 1) {
      columns.push({ tag: 'column', width: 'weighted', weight: 1, elements: [] } as any);
    }
    out.push({
      tag: 'column_set',
      columns,
      flex_mode: 'none',
      horizontal_spacing: '8px',
      margin: i > 0 ? '8px 0 0 0' : undefined,
    });
  }
  return out;
}

export function buildCompleteCard(
  text: string,
  toolCalls?: ToolCallInfo[],
  elapsed?: number,
  title?: string,
  buttons?: ButtonInfo[],
  sessionKey?: string,
  chatId?: string,
  cardId?: string,
  messageId?: string,
  usage?: UsageInfo,
  thinkingEntries?: ThinkingEntry[],
  aborted?: boolean,
  selects?: SelectInfo[],
  multiSelects?: MultiSelectInfo[],
  images?: Array<{ imageKey: string | null; url: string; alt?: string }>,
  segments?: ContentSegment[],
  checkers?: CheckerInfo[],
): object {
  // Extract TITLE tag via shared tolerant parser (handles <<TITLE:xxx>>, <<TITLE:xxx|color>>, HTML-mixed, etc.)
  const { title: extracted, body, color: headerColor } = extractTitleFromText(text || '(空回复)', 30);
  let displayText = body;
  let headerTitle = title || extracted || '';

  const elements: object[] = [];

  const toolCount = toolCalls?.length || 0;
  const thinkingCount = thinkingEntries?.length || 0;

  // Tool + thinking panel — collapsible panel at the top, default collapsed
  if (toolCount > 0 || thinkingCount > 0) {
    const statusEmoji = aborted ? '⏹' : '✅';
    let toolPanelTitle = aborted
      ? (toolCount > 0 ? `${statusEmoji} 已暂停 · ${toolCount} 次工具调用` : `${statusEmoji} 已暂停 · ${thinkingCount} 次思考`)
      : (toolCount > 0 ? `${statusEmoji} ${toolCount} 次工具调用` : `${statusEmoji} ${thinkingCount} 次思考`);
    if (toolCount > 0 && thinkingCount > 0) toolPanelTitle += ` · ${thinkingCount} 次思考`;
    if (elapsed) toolPanelTitle += ` · ${formatDuration(elapsed)}`;
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'plain_text',
          content: toolPanelTitle,
        },
      },
      border: { color: 'grey' },
      vertical_spacing: '8px',
      padding: '4px 8px 4px 8px',
      elements: buildToolPanelElements(toolCalls || [], thinkingEntries || [], false),
    });
  }

  // Build helpers for the body — each kind of segment maps to a card element.
  const buildTextElement = (content: string, withStreamId: boolean): object => ({
    tag: 'markdown',
    content,
    ...(withStreamId ? { element_id: STREAMING_ELEMENT_ID } : {}),
  });
  const buildImageElement = (r: { imageKey: string | null; url: string; alt?: string }): object =>
    r.imageKey
      ? { tag: 'img', img_key: r.imageKey, alt: { tag: 'plain_text', content: r.alt || '' }, scale_type: 'crop_center', preview: true }
      : { tag: 'markdown', content: `_[图片: ${r.url}]_` };
  // Single-select has no native clear button on Feishu — we prepend a synthetic
  // `none=不选` option as the first item so the user can "uncheck" a previous choice.
  // Callbacks treat `value === 'none'` as unselected (see buildFormSubmitPrompt /
  // updateCardSelectState / empty-form guard in message-bridge.ts).
  const NONE_KEY = 'none';
  const NONE_LABEL = '不选';
  const buildSelectElement = (sel: SelectInfo): object => {
    const opts: Array<{ key: string; label: string }> = [];
    // Avoid duplicate if LLM already declared a `none` option.
    if (!sel.options.some((o) => o.key === NONE_KEY)) {
      opts.push({ key: NONE_KEY, label: NONE_LABEL });
    }
    opts.push(...sel.options);
    return {
      tag: 'select_static',
      name: sel.name,
      placeholder: { tag: 'plain_text', content: sel.placeholder },
      // Experimental hidden fields — Feishu silently ignores unknown keys, so these are no-op
      // on unsupported clients but may enable clearing on supported ones.
      clearable: true,
      width: 'fill',
      options: opts.map((opt) => ({ value: opt.key, text: { tag: 'plain_text', content: opt.label } })),
    };
  };
  const buildMSelectElement = (msel: MultiSelectInfo): object => ({
    tag: 'multi_select_static',
    name: msel.name,
    placeholder: { tag: 'plain_text', content: msel.placeholder },
    // Experimental hidden fields to try to expand tag display instead of `+N` collapse.
    clearable: true,
    width: 'fill',
    display_lines: 0,
    options: msel.options.map((opt) => ({ value: opt.key, text: { tag: 'plain_text', content: opt.label } })),
  });
  const buildCheckerElement = (chk: CheckerInfo): object => {
    const el: any = {
      tag: 'checker',
      name: chk.name,
      checked: chk.defaultChecked,
      text: { tag: 'lark_md', content: chk.text },
    };
    // Only set `checked_style` when the model explicitly opts in. Default (no style)
    // = no visual change when checked, which fits picker / preference / subscription
    // scenarios. The model picks `strike` / `dim` / `done` when "completed" semantics apply.
    if (chk.style === 'strike') {
      el.checked_style = { show_strikethrough: true };
    } else if (chk.style === 'dim') {
      el.checked_style = { opacity: 0.6 };
    } else if (chk.style === 'done') {
      el.checked_style = { show_strikethrough: true, opacity: 0.6 };
    }
    return el;
  };

  const hasFormFields = (selects && selects.length > 0)
    || (multiSelects && multiSelects.length > 0)
    || (checkers && checkers.length > 0);

  // BIG-FORM-CONTAINER MODE: when there are SELECT/MSELECT fields, wrap the entire body
  // (text + img + select + mselect) into a single `form` element. Submit button is the last
  // child. Selectors render in-place at their tag position. KNOWN: Feishu PC desktop client
  // reports error 200530 on submit (and may not allow opening dropdowns) — this is a
  // long-standing PC client bug with form/select_static not related to nested children.
  // Mobile works fine; we accept this until Feishu PC fixes the issue.
  if (hasFormFields && segments && segments.length > 0 && sessionKey) {
    const formChildren: object[] = [];
    let firstText = true;
    for (const seg of segments) {
      if (seg.kind === 'text') {
        let content = firstText ? extractTitleFromText(seg.content, 30).body : seg.content;
        firstText = false;
        if (!content || content.trim().length === 0) continue;
        formChildren.push(buildTextElement(content, false));
      } else if (seg.kind === 'image') {
        const r = images?.[seg.index];
        if (r) formChildren.push(buildImageElement(r));
      } else if (seg.kind === 'select') {
        const sel = selects?.[seg.index];
        if (sel) formChildren.push(buildSelectElement(sel));
      } else if (seg.kind === 'mselect') {
        const msel = multiSelects?.[seg.index];
        if (msel) formChildren.push(buildMSelectElement(msel));
      } else if (seg.kind === 'check') {
        const chk = checkers?.[seg.index];
        if (chk) formChildren.push(buildCheckerElement(chk));
      }
    }
    formChildren.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '提交' },
      type: 'primary',
      width: 'default',
      form_action_type: 'submit',
      behaviors: [{
        type: 'callback',
        value: {
          action: FORM_SUBMIT_ACTION,
          label: '提交',
          sessionKey: sessionKey || '',
          chatId: chatId || '',
          cardId: cardId || '',
          messageId: messageId || '',
        },
      }],
    });
    elements.push({
      tag: 'form',
      name: INTERACTIVE_FORM_NAME,
      elements: formChildren,
    });
  } else if (segments && segments.length > 0) {
    let first = true;
    for (const seg of segments) {
      if (seg.kind === 'text') {
        let content = first ? extractTitleFromText(seg.content, 30).body : seg.content;
        first = false;
        if (!content || content.trim().length === 0) continue;
        elements.push(buildTextElement(
          content,
          elements.length === 0 || !elements.some((e: any) => e.element_id === STREAMING_ELEMENT_ID),
        ));
      } else if (seg.kind === 'image') {
        const r = images?.[seg.index];
        if (r) elements.push(buildImageElement(r));
      }
      // select/mselect without sessionKey can't render (no callback target) — skip silently
    }
    // Defensive: if every segment was empty (rare), ensure at least one markdown element exists
    if (!elements.some((e: any) => e.tag === 'markdown' || e.tag === 'img')) {
      elements.push({ tag: 'markdown', content: displayText, element_id: STREAMING_ELEMENT_ID });
    }
  } else {
    elements.push({
      tag: 'markdown',
      content: displayText,
      element_id: STREAMING_ELEMENT_ID,
    });
    if (images && images.length > 0) {
      elements.push(...buildImageElements(images));
    }
  }

  // Buttons (if any) — 2 per row. BUTTON is mutually exclusive with form fields,
  // so this only fires when hasFormFields is false (mutex already enforced upstream).
  if (buttons && buttons.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push(...buildButtonElements(buttons, { sessionKey, chatId, cardId, messageId }));
  }

  // Footer — status + metrics
  elements.push({ tag: 'hr' });
  const footerParts: string[] = [];
  footerParts.push(elapsed ? `${aborted ? '⏹' : '✅'} ${formatDuration(elapsed)}` : (aborted ? '⏹' : '✅'));
  if (toolCalls && toolCalls.length > 0) {
    footerParts.push(`${toolCalls.length} tools`);
  }
  if (usage) {
    const totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    if (totalTokens > 0) {
      footerParts.push(`${formatTokenCount(totalTokens)} tokens (in: ${formatTokenCount(usage.inputTokens || 0)} / out: ${formatTokenCount(usage.outputTokens || 0)})`);
    }
    // Use peak single-call prompt for ctx% — falls back to turn-aggregate only if
    // peak isn't available (e.g. older log entries). Peak never exceeds the window.
    const peakPrompt = (usage.peakCallInputTokens || 0) + (usage.peakCallCacheReadTokens || 0) + (usage.peakCallCacheCreationTokens || 0);
    const aggregatePrompt = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheCreationTokens || 0);
    const promptForCtx = peakPrompt > 0 ? peakPrompt : aggregatePrompt;
    if (promptForCtx > 0) {
      const window = contextWindowOf(usage.model);
      const ctxPct = Math.min(100, Math.round((promptForCtx / window) * 100));
      footerParts.push(`ctx ${ctxPct}%${ctxHint(ctxPct)}`);
    }
    // Cache hit% uses the same call's numbers as ctx% for consistency.
    const cacheReadForHit = peakPrompt > 0 ? (usage.peakCallCacheReadTokens || 0) : (usage.cacheReadTokens || 0);
    if (cacheReadForHit > 0 && promptForCtx > 0) {
      const hitPct = Math.round((cacheReadForHit / promptForCtx) * 100);
      footerParts.push(`cache hit ${hitPct}%`);
    }
  }
  elements.push({
    tag: 'markdown',
    content: footerParts.join(' · '),
    text_size: 'notation',
  });

  const card: any = {
    schema: '2.0',
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements,
    },
  };
  if (headerTitle) {
    card.header = {
      template: headerColor,
      title: { tag: 'plain_text', content: headerTitle },
    };
  }
  return card;
}

/**
 * Extract a short title from response text for the card header.
 * Takes the first meaningful line, strips markdown, and truncates.
 * (Currently unused — kept for backward compatibility.)
 */
function extractAutoTitle(text: string): string {
  // Strip markdown formatting and find first meaningful line
  const lines = text.split('\n');
  for (const line of lines) {
    // Strip markdown: headers, bold, links, code, @mentions, bullets
    let clean = line
      .replace(/^#{1,6}\s+/, '')       // headers
      .replace(/\*\*(.+?)\*\*/g, '$1') // bold
      .replace(/\*(.+?)\*/g, '$1')     // italic
      .replace(/`(.+?)`/g, '$1')       // inline code
      .replace(/\[(.+?)\]\(.+?\)/g, '$1') // links
      .replace(/^[-*•]\s+/, '')        // bullets
      .replace(/^\d+\.\s+/, '')        // numbered lists
      .trim();
    if (clean.length >= 2) {
      // Truncate to 20 chars at word boundary
      if (clean.length > 20) {
        const cut = clean.slice(0, 20);
        const lastSpace = cut.lastIndexOf(' ');
        clean = lastSpace > 10 ? cut.slice(0, lastSpace) : cut;
      }
      return clean;
    }
  }
  return 'Sigma';
}

/**
 * Format elapsed milliseconds as M:SS (e.g. 2:05) or Xs for under 60s.
 * Capped at 30m to avoid runaway display values from orphaned cards.
 */
function formatDuration(ms: number): string {
  if (ms > 30 * 60 * 1000) return '> 30m';
  const totalSecs = Math.round(ms / 1000);
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format token count as human-readable string (e.g. 1.2k, 45.3k).
 */
function formatTokenCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

/**
 * Format tool calls for display in a streaming card.
 * Only shows the last 10 entries to keep the card compact.
 */
function formatToolCalls(toolCalls: ToolCallInfo[]): string {
  const MAX_VISIBLE = 5;

  // Prioritize running items — never fold them
  let visible: ToolCallInfo[];
  if (toolCalls.length <= MAX_VISIBLE) {
    visible = toolCalls;
  } else {
    const running = toolCalls.filter(t => t.status === 'running');
    const done = toolCalls.filter(t => t.status !== 'running');
    const doneSlots = Math.max(0, MAX_VISIBLE - running.length);
    visible = [...(doneSlots > 0 ? done.slice(-doneSlots) : []), ...running];
  }
  const hidden = toolCalls.length - visible.length;

  const lines: string[] = [];
  if (hidden > 0) {
    lines.push(`... ${hidden} 条已折叠`);
  }
  for (const tc of visible) {
    lines.push(`- ${formatSingleTool(tc)}`);
    // Render subagent children tree with markdown nested list
    if (tc.children && tc.children.length > 0) {
      const completed = tc.children.filter(c => c.status !== 'running');
      const running = tc.children.filter(c => c.status === 'running');
      // 1. Collapsed completed count
      if (completed.length > 1) {
        const elapsed = Date.now() - completed[0].startTime;
        const totalSecs = Math.round(elapsed / 1000);
        const timeStr = totalSecs < 60 ? `${totalSecs}s` : `${Math.floor(totalSecs / 60)}:${(totalSecs % 60).toString().padStart(2, '0')}`;
        lines.push(`   - ... ${completed.length - 1} 条已折叠 · 总用时 ${timeStr}`);
      }
      // 2. Last completed step
      if (completed.length > 0) {
        lines.push(`   - ${formatSingleTool(completed[completed.length - 1])}`);
      }
      // 3. Currently running step
      if (running.length > 0) {
        lines.push(`   - ${formatSingleTool(running[running.length - 1])}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Compute the parts of a tool call display: status icon, name, time string, input summary.
 * Used by both markdown and plain-text formatters.
 */
function toolCallParts(tc: ToolCallInfo): { statusIcon: string; emoji: string; name: string; statusText: string; inputSummary: string } {
  const statusIcon = tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
  const emoji = toolEmoji(tc.name);
  const isAgent = tc.name === 'Agent' || tc.name.startsWith('Agent #');

  // For Agent with children: compute duration from children's time span
  let durationSecs: number | undefined;
  if (tc.endTime) {
    if (isAgent && tc.children && tc.children.length > 0) {
      const firstStart = tc.children[0].startTime;
      const lastEnd = tc.children[tc.children.length - 1].endTime || Date.now();
      durationSecs = (lastEnd - firstStart) / 1000;
    } else {
      durationSecs = (tc.endTime - tc.startTime) / 1000;
    }
  } else if (tc.status === 'running' && isAgent && tc.children && tc.children.length > 0) {
    // Running Agent: show elapsed since first child started
    durationSecs = (Date.now() - tc.children[0].startTime) / 1000;
  } else if (tc.status === 'running') {
    // Generic running tool: elapsed since startTime
    durationSecs = (Date.now() - tc.startTime) / 1000;
  }

  let timeStr = '';
  if (durationSecs != null) {
    timeStr = durationSecs < 60 ? `${durationSecs.toFixed(1)}s` : `${Math.floor(durationSecs / 60)}:${Math.round(durationSecs % 60).toString().padStart(2, '0')}`;
  }
  // Show elapsed time for running tools (instead of generic "执行中...")
  const statusText = tc.status === 'running' && !timeStr ? '执行中...' : timeStr;

  let inputSummary = '';
  if (tc.input) {
    const truncated = tc.input.length > 80 ? tc.input.slice(0, 80) + '...' : tc.input;
    inputSummary = ` ${truncated}`;
  }

  return { statusIcon, emoji, name: tc.name, statusText, inputSummary };
}

function formatSingleTool(tc: ToolCallInfo): string {
  const { statusIcon, emoji, name, statusText, inputSummary } = toolCallParts(tc);
  return `${statusIcon} ${emoji} **${name}** ${statusText ? `(${statusText})` : ''}${inputSummary}`;
}

/**
 * Format a single thinking entry as a markdown line for the "X 次工具调用已完成" panel.
 * No status prefix — thinking is a plain observation, not a tool call.
 * Truncates long thinking text to keep the panel compact.
 */
function formatThinkingLine(text: string, maxLen = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const truncated = oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
  return `💭 ${truncated}`;
}

/**
 * Plain-text version (no markdown formatting) for use in collapsible_panel headers,
 * which use plain_text and won't render markdown.
 */
function formatSingleToolPlain(tc: ToolCallInfo): string {
  const { statusIcon, emoji, name, statusText, inputSummary } = toolCallParts(tc);
  return `${statusIcon} ${emoji} ${name} ${statusText ? `(${statusText})` : ''}${inputSummary}`;
}

/**
 * Format tool calls summary for the completed card's collapsed panel.
 */
function formatToolCallsSummary(toolCalls: ToolCallInfo[]): string {
  const lines: string[] = [];
  for (const tc of toolCalls) {
    // Skip agents with children — they get their own nested panel
    if ((tc.name === 'Agent' || tc.name.startsWith('Agent #')) && tc.children && tc.children.length > 0) continue;
    lines.push(`- ${formatSingleTool(tc)}`);
  }
  return lines.join('\n');
}

/**
 * Build card elements for tool calls panel content.
 * Agent tools with children get nested collapsible_panel; others are markdown lines.
 * @param expanded Whether agent sub-panels should be expanded (true for streaming, false for complete).
 */
function buildToolPanelElements(toolCalls: ToolCallInfo[], thinkingEntries: ThinkingEntry[], expanded: boolean): object[] {
  const elements: object[] = [];

  // Separate agents-with-children from flat tools
  const flatTools: ToolCallInfo[] = [];
  const agents: ToolCallInfo[] = [];
  for (const tc of toolCalls) {
    if ((tc.name === 'Agent' || tc.name.startsWith('Agent #')) && tc.children && tc.children.length > 0) {
      agents.push(tc);
    } else {
      flatTools.push(tc);
    }
  }

  const completed = flatTools.filter(tc => tc.status !== 'running');
  const running = flatTools.filter(tc => tc.status === 'running');

  // Nested "已完成" panel: completed tools + thinking entries, interleaved by timestamp.
  // All rows are markdown lines (thinking has no status — just 💭 + text).
  if (completed.length > 0 || thinkingEntries.length > 0) {
    type TimelineItem =
      | { kind: 'tool'; at: number; tool: ToolCallInfo }
      | { kind: 'thinking'; at: number; text: string };
    const timeline: TimelineItem[] = [
      ...completed.map(tc => ({ kind: 'tool' as const, at: tc.startTime, tool: tc })),
      ...thinkingEntries.map(t => ({ kind: 'thinking' as const, at: t.at, text: t.text })),
    ];
    timeline.sort((a, b) => a.at - b.at);

    const lines = timeline.map(item =>
      item.kind === 'tool' ? formatSingleTool(item.tool) : formatThinkingLine(item.text),
    );

    const headerText = completed.length > 0
      ? `✅ ${completed.length} 次工具调用已完成`
      : `💭 ${thinkingEntries.length} 次思考`;

    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'plain_text', content: headerText },
      },
      border: { color: 'grey' },
      vertical_spacing: '4px',
      padding: '4px 8px 4px 8px',
      elements: [{ tag: 'markdown', content: lines.join('\n') }],
    });
  }

  // Running tools → show as markdown (outside the "已完成" panel)
  if (running.length > 0) {
    const runningLines = running.map(tc => formatSingleTool(tc));
    elements.push({ tag: 'markdown', content: runningLines.join('\n') });
  }

  // Each agent with children gets its own nested collapsible_panel
  for (const agent of agents) {
    const childLines = (agent.children || []).map(c => formatSingleTool(c));
    elements.push({
      tag: 'collapsible_panel',
      expanded,
      header: {
        title: {
          tag: 'plain_text',
          content: formatSingleToolPlain(agent),
        },
      },
      border: { color: 'grey' },
      vertical_spacing: '4px',
      padding: '4px 8px 4px 8px',
      elements: [
        { tag: 'markdown', content: childLines.join('\n') },
      ],
    });
  }

  return elements;
}
