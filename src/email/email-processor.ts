import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ClaudeRunner } from '../claude/runner.js';
import type { EmailAccount } from './account-store.js';
import type { Logger } from '../utils/logger.js';

const RULES_FILE = 'email-rules.txt';

export interface RawEmail {
  uid: number;
  from: string;
  subject: string;
  date: Date;
  text: string;         // Plain text body
  headers: Record<string, string>;
}

export interface ProcessedEmail {
  isSpam: boolean;
  from: string;
  subject: string;
  summary: string;
  translatedSubject?: string;
  date: Date;
  uid: number;
  accountId: string;
  accountLabel: string;
}

/**
 * Load user-defined email rules from session directory.
 */
export function loadRules(sessionDir: string): string {
  const filePath = path.join(sessionDir, RULES_FILE);
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim();
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * Load the user's CLAUDE.md so the email classifier can pick up user
 * preferences (investment limits, language, methodology, etc) when
 * generating personalized summaries — without giving it write access
 * to the user's session transcript.
 *
 * Cap at 8KB to keep prompt size bounded; users with longer CLAUDE.md
 * should keep load-bearing context near the top.
 */
function loadUserClaudeMd(sessionDir: string): string {
  const filePath = path.join(sessionDir, 'CLAUDE.md');
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return raw.length > 8000 ? raw.slice(0, 8000) + '\n\n[…truncated]' : raw;
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * Save user-defined email rules to session directory.
 */
export function saveRules(sessionDir: string, rules: string): void {
  const filePath = path.join(sessionDir, RULES_FILE);
  fs.writeFileSync(filePath, rules, 'utf-8');
}

/**
 * Processes new emails: all emails go through Claude with user-defined rules.
 */
export class EmailProcessor {
  private processorDir: string;

  constructor(
    private runner: ClaudeRunner,
    private sessionsDir: string,
    private logger: Logger,
  ) {
    this.processorDir = path.join(path.dirname(sessionsDir), '_email_processor');
    fs.mkdirSync(this.processorDir, { recursive: true });
  }

  async process(emails: RawEmail[], account: EmailAccount, sessionDir: string): Promise<ProcessedEmail[]> {
    if (emails.length === 0) return [];

    // Hard rules (whitelist/spam) and soft preferences (CLAUDE.md) — both
    // injected into prompt; classifier runs in isolated _email_processor
    // session so the user's transcript is not polluted.
    const userRules = loadRules(sessionDir);
    const userClaudeMd = loadUserClaudeMd(sessionDir);

    try {
      return await this.classifyWithClaude(emails, account, userRules, userClaudeMd);
    } catch (err) {
      this.logger.error({ err, accountId: account.id }, 'Claude email processing failed');
      // Fallback: SAFE-BY-DEFAULT — when classifier fails we cannot honor the
      // user's whitelist rules, so the right behavior is to *withhold* push
      // (mark as spam). The previous implementation pushed everything which
      // bypassed the whitelist on every parse error.
      // The IDLE monitor uses the `isSpam` flag to gate the push; setting
      // isSpam=true here means "don't bother the user, but the email is still
      // in the inbox if they go look".
      return emails.map(email => ({
        isSpam: true,
        from: email.from,
        subject: email.subject,
        summary: `[分类失败] ${email.text.slice(0, 150).replace(/\s+/g, ' ')}${email.text.length > 150 ? '...' : ''}`,
        date: email.date,
        uid: email.uid,
        accountId: account.id,
        accountLabel: account.label,
      }));
    }
  }

  private async classifyWithClaude(emails: RawEmail[], account: EmailAccount, userRules: string, userClaudeMd: string): Promise<ProcessedEmail[]> {
    const emailDescriptions = emails.map((e, i) => {
      const bodySnippet = (e.text || '').slice(0, 1000);
      return `--- 邮件 ${i + 1} (INDEX=${i}) ---
发件人: ${e.from}
主题: ${e.subject}
日期: ${e.date.toISOString()}
正文片段:
${bodySnippet}`;
    }).join('\n\n');

    const rulesSection = userRules
      ? `\n## 硬规则（必须严格遵守，不可被下方用户档案推翻）\n${userRules}\n\n请严格按照以上规则判断每封邮件是否应该推送（NOTIFY）。如果规则是白名单模式（只推送某些发件人），则不在白名单中的邮件一律 NOTIFY=false。\n`
      : `\n## 默认规则\n过滤纯广告/营销/垃圾邮件（NOTIFY=false），其他正常邮件都推送（NOTIFY=true）。\n`;

    const userBackgroundSection = userClaudeMd
      ? `\n## 用户档案（来自 CLAUDE.md，仅用于个性化摘要视角，不可推翻硬规则）\n${userClaudeMd}\n`
      : '';

    // Output format: line-based instead of JSON to dodge quote-escape bugs.
    // Real-world failure (2026-04-30): LLM returned summary containing
    // unescaped quotes — JSON.parse threw, fallback pushed everything,
    // bypassing the whitelist. The line format below is unambiguous and
    // requires zero escaping.
    const prompt = `你是邮件分析助手。分析以下 ${emails.length} 封邮件，对每封邮件：
1. 根据硬规则判断是否需要推送给用户（NOTIFY=true/false）
2. 用1-2句中文生成摘要（SUMMARY）— 结合用户档案，挑用户最关心的视角
3. 如果主题不是中文，翻译成中文（TRANSLATED_SUBJECT，中文主题则省略此字段）
${rulesSection}${userBackgroundSection}
注意：硬规则决定 NOTIFY 字段；用户档案只影响 SUMMARY 的措辞和切入点，不能让被规则过滤的邮件变为 NOTIFY=true。

## 输出格式（严格遵守）

每封邮件一个 record，record 之间用单独一行 \`---\` 分隔。每个字段一行 \`KEY=value\` 形式。**SUMMARY 内允许任意字符（包括引号、冒号），换行替换为空格，不需要任何转义**。

示例（两封邮件）：
\`\`\`
INDEX=0
NOTIFY=false
SUMMARY=Google 广告通知，要求设置通话录音偏好（不在白名单，无需推送）
TRANSLATED_SUBJECT=
---
INDEX=1
NOTIFY=true
SUMMARY=jingyao 询问下周三能否开会评审 Q2 计划
TRANSLATED_SUBJECT=
\`\`\`

只输出 record 内容（不要 markdown 代码块、不要解释、不要前后缀）。

${emailDescriptions}`;

    const result = await this.runner.run({
      sessionKey: '_email_processor',
      message: prompt,
      sessionDir: this.processorDir,
    });

    const responseText = result.fullText?.trim() || '';
    this.logger.debug({ responseLength: responseText.length }, 'Claude email analysis response');

    const parsed = parseClassifierResponse(responseText);
    if (!parsed || parsed.length === 0) {
      this.logger.warn({ response: responseText.slice(0, 800) }, 'Failed to parse Claude classifier response');
      throw new Error('Invalid Claude response format');
    }

    const results: ProcessedEmail[] = [];
    for (const item of parsed) {
      const email = emails[item.index];
      if (!email) continue;

      results.push({
        isSpam: !item.notify,
        from: email.from,
        subject: email.subject,
        summary: item.summary,
        translatedSubject: item.translatedSubject,
        date: email.date,
        uid: email.uid,
        accountId: account.id,
        accountLabel: account.label,
      });
    }

    return results;
  }
}

interface ClassifierItem {
  index: number;
  notify: boolean;
  summary: string;
  translatedSubject?: string;
}

/**
 * Parse classifier output. Tries the line-based format first (preferred),
 * falls back to JSON-array format with a quote-repair pass for backward
 * compatibility / when LLM ignores the format spec.
 */
function parseClassifierResponse(text: string): ClassifierItem[] | null {
  const lineResults = tryParseLineFormat(text);
  if (lineResults && lineResults.length > 0) return lineResults;

  // Legacy JSON array fallback, with a tiny quote-repair pass.
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;

  const candidates = [jsonMatch[0], repairJsonQuotes(jsonMatch[0])];
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (Array.isArray(parsed) && parsed.every((p: any) => typeof p?.index === 'number' && typeof p?.notify === 'boolean')) {
        return parsed.map((p: any) => ({
          index: p.index,
          notify: p.notify,
          summary: String(p.summary || ''),
          translatedSubject: p.translatedSubject ? String(p.translatedSubject) : undefined,
        }));
      }
    } catch { /* try next candidate */ }
  }
  return null;
}

function tryParseLineFormat(text: string): ClassifierItem[] | null {
  // Strip optional code-fence wrapping the LLM may have added.
  const clean = text.replace(/^```[a-z]*\n/i, '').replace(/\n```\s*$/i, '');
  const records = clean.split(/^---\s*$/m).map(r => r.trim()).filter(Boolean);
  if (records.length === 0) return null;
  const out: ClassifierItem[] = [];
  for (const rec of records) {
    const fields: Record<string, string> = {};
    for (const line of rec.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) fields[m[1]] = m[2].trim();
    }
    if (typeof fields.INDEX === 'undefined' || typeof fields.NOTIFY === 'undefined') continue;
    const idx = parseInt(fields.INDEX, 10);
    if (Number.isNaN(idx)) continue;
    out.push({
      index: idx,
      notify: fields.NOTIFY.toLowerCase() === 'true',
      summary: fields.SUMMARY || '(无摘要)',
      translatedSubject: fields.TRANSLATED_SUBJECT || undefined,
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Best-effort repair of JSON strings where the LLM left bare double-quotes
 * inside string values (e.g. `"summary":"...设为"是"，需..."`). Only fires
 * when the line-based parser returns nothing — the line format is the real
 * fix; this is a tiny safety net.
 */
function repairJsonQuotes(s: string): string {
  return s.replace(
    /"([a-zA-Z_]+)"\s*:\s*"((?:[^"\\]|\\.)*?[^\\])"(?=\s*[,}])/g,
    (_m, key, val) => `"${key}":"${val.replace(/"/g, '\\"')}"`,
  );
}

/**
 * Format processed emails into a Feishu push notification.
 */
export function formatPushNotification(emails: ProcessedEmail[]): string {
  if (emails.length === 1) {
    const e = emails[0];
    const subject = e.translatedSubject
      ? `${e.translatedSubject}（${e.subject}）`
      : e.subject;
    const time = e.date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const lines = [
      `<<TITLE:📬 ${e.accountLabel} 新邮件>>`,
      '',
      `**来自**: ${e.from}`,
      `**主题**: ${subject}`,
      `**时间**: ${time}`,
      '',
      `> ${e.summary}`,
      '',
      `💡 回复我可以对这封邮件进行操作（如"回复他说收到了"、"查看全文"）`,
    ];
    return lines.join('\n');
  }

  // Multiple emails
  const lines = [
    `<<TITLE:📬 ${emails.length} 封新邮件>>`,
    '',
  ];

  for (const e of emails) {
    const subject = e.translatedSubject
      ? `${e.translatedSubject}（${e.subject}）`
      : e.subject;
    const time = e.date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
    lines.push(`**${time}** — ${e.from}`);
    lines.push(`📌 ${subject}`);
    lines.push(`> ${e.summary}`);
    lines.push('');
  }

  lines.push(`💡 回复我可以对这些邮件进行操作`);
  return lines.join('\n');
}
