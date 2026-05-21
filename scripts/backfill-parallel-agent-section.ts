#!/usr/bin/env node
/**
 * Backfill `## 并行 agent` section in all sessions/<key>/CLAUDE.md.
 *
 * Idempotent via the `<!-- sigma-template:parallel-agent-v1 -->` marker:
 *   - marker present → skip
 *   - `## 并行 agent` heading present (older content) → replace section
 *   - heading absent → append at file end
 *
 * Run: `npx tsx scripts/backfill-parallel-agent-section.ts [--dry-run]`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SESSIONS_DIR = path.join(REPO_ROOT, 'sessions');
const MARKER = '<!-- sigma-template:parallel-agent-v3 -->';

const SECTION = `## 并行 agent

${MARKER}

每个 session 最多 **3 个并发 Claude 进程**（含主 agent 和 fork agent）。fork 共享主对话的完整历史（同一个 sessionId 的 transcript），但跑在独立进程里，**主 agent 不阻塞**——你可以一边等长任务，一边发新消息让 fork 处理。

### 触发方式

#### 1. 手动单次 fork：\`// <prompt>\`
消息开头加 \`// \`（双斜杠 + 空格 + prompt）→ 立刻 fork 一个分身处理这个 prompt。

\`\`\`
// 帮我查一下 OPEC 最新动态
// 把上面那段代码翻译成 Python
\`\`\`

主对话照常进行，fork 完成时独立回复你。

#### 2. 自动 fork 模式：\`/并行 on\` / \`/并行 off\`
开启后，**主 agent 忙碌时**收到的新消息会**自动**作为 fork 处理（不需要 \`// \` 前缀）。空闲时正常走主 agent。

\`\`\`
/并行           ← 显示状态卡片 + 开关按钮（含当前 fork 数）
/并行 on        ← 开启自动 fork
/并行 off       ← 关闭
\`\`\`

**默认 off**（保守起见——避免你不知情时多花 token）。

### 容量耗尽时

如果 3 个 slot 都满了：
- \`// <prompt>\` 显式触发 → 降级为普通排队（不丢消息）
- 自动 fork 触发 → 同上，排队

### 何时主动建议开 \`/并行 on\`

当 sigma 检测到自己正在跑长任务（B 站转写、大文件 build、复杂搜索）且用户可能想插话时，**主动用 BUTTON 提示**：
\`\`\`
<<BUTTON:开启自动并行|/并行 on|primary>>
\`\`\`

### Fork 的能力

- ✅ 看到主的完整对话历史（同 sessionId）
- ✅ 完整工具集（Bash / WebSearch / 飞书 MCP / chrome / 等）
- ✅ 完整的回复装饰（typing / 引用 / 流式卡片）
- ✅ 写入的 transcript 主下次轮也能看到（共享 jsonl）
- ❌ 不能改 session 级状态（cron / alert / chrome 端口等）—— 这些只能主管
`;

interface Result {
  path: string;
  action: 'skip-marker' | 'skip-no-file' | 'replaced' | 'appended';
}

function processOne(filePath: string, dryRun: boolean): Result {
  if (!fs.existsSync(filePath)) return { path: filePath, action: 'skip-no-file' };
  const content = fs.readFileSync(filePath, 'utf8');
  if (content.includes(MARKER)) return { path: filePath, action: 'skip-marker' };

  const startRe = /^## 并行 agent\s*$/m;
  const startMatch = startRe.exec(content);

  let next: string;
  let action: Result['action'];
  if (startMatch) {
    const startIdx = startMatch.index;
    const after = content.slice(startIdx + startMatch[0].length);
    const nextRe = /^## /m;
    const nextMatch = nextRe.exec(after);
    const endIdx = nextMatch
      ? startIdx + startMatch[0].length + nextMatch.index
      : content.length;
    const before = content.slice(0, startIdx);
    const rest = content.slice(endIdx);
    const sep = rest.length > 0 && !rest.startsWith('\n') ? '\n' : '';
    next = before + SECTION + sep + rest;
    action = 'replaced';
  } else {
    const sep = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    next = content + sep + SECTION;
    action = 'appended';
  }

  if (!dryRun) fs.writeFileSync(filePath, next);
  return { path: filePath, action };
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  if (!fs.existsSync(SESSIONS_DIR)) {
    console.error(`sessions dir not found: ${SESSIONS_DIR}`);
    process.exit(1);
  }
  const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  const results: Result[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const cmdPath = path.join(SESSIONS_DIR, e.name, 'CLAUDE.md');
    results.push(processOne(cmdPath, dryRun));
  }
  const summary = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.action] = (acc[r.action] || 0) + 1;
    return acc;
  }, {});
  console.log(`\n=== Backfill (parallel-agent v1) ${dryRun ? '(DRY-RUN)' : ''} ===`);
  for (const [action, count] of Object.entries(summary)) {
    console.log(`  ${action.padEnd(20)} ${count}`);
  }
  console.log(`  total              ${results.length}`);
}

main();
