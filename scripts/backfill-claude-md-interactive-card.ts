#!/usr/bin/env node
/**
 * Backfill the three card-related sections in all existing sessions/<key>/CLAUDE.md
 * to the latest v7 template:
 *   1. `## 交互卡片`       — BUTTON / SELECT / MSELECT / CHECK / TOAST
 *   2. `## 卡片嵌入图片`    — <<IMG:>>, ![](path), and bare-path auto-lift
 *   3. `## 卡片标题`        — <<TITLE:title|color>>
 *
 * Idempotent via the `<!-- sigma-template:interactive-card-v7 -->` marker (placed
 * inside the interactive-card section). v6/earlier markers are NOT respected here —
 * the file is upgraded regardless, since v7 adds entirely new sections.
 *
 * Run: `npx tsx scripts/backfill-claude-md-interactive-card.ts [--dry-run]`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SESSIONS_DIR = path.join(REPO_ROOT, 'sessions');
const MARKER = '<!-- sigma-template:interactive-card-v7 -->';

const SECTION_INTERACTIVE = `## 交互卡片

${MARKER}

回复末尾可加交互元素让用户操作。**两类互斥**：BUTTON（立即触发）⊻ form 字段（SELECT/MSELECT/CHECK，统一提交）。form 字段之间可自由混用。

**决策公式：你这一轮要让用户回答几件事？**
- **1 件** → BUTTON（哪怕选项多）
- **2+ 件** → form 字段（SELECT / MSELECT / CHECK，任选搭配）

**决策矩阵：**

| 情况 | 工具 |
|---|---|
| 1 件事，是/否 / 程度 / N 选 1 / 链接 | **BUTTON** |
| 2+ 件事，每件"在选项里挑 1 个" | **SELECT × N** |
| 2+ 件事,每件"在选项里挑多个" | **MSELECT × N** |
| 2+ 件事，每件"做/不做"（boolean 清单）| **CHECK × N** |
| 2+ 件事，混合 | **CHECK + SELECT + MSELECT** 同 form 一次提交 |

**互斥矩阵：**

| | BUTTON | SELECT | MSELECT | CHECK |
|---|---|---|---|---|
| BUTTON | — | ❌ 互斥 | ❌ 互斥 | ❌ 互斥 |
| SELECT | ❌ | — | ✅ 混用 | ✅ 混用 |
| MSELECT | ❌ | ✅ 混用 | — | ✅ 混用 |
| CHECK | ❌ | ✅ 混用 | ✅ 混用 | — |

### 模式 A：单维度决策（1 件事）→ BUTTON
\`<<BUTTON:文案|action_id|样式?>>\`，样式 primary/danger 可选，≤4 个。
点击后所有按钮立即禁用，被点按钮文字加 \`@用户名\`。

触发场景：
- **是/否 二元**：部署/取消、删除/保留、开干/不干
- **程度/等级**：紧急程度 高/中/低、优先级 P0/P1/P2
- **N 选 1 方案**：方案 A / 方案 B / 方案 C
- **立即执行的单步操作**：重启 / 推送 / 跳过

示例：\`修改完成。<<BUTTON:推送|push|primary>> <<BUTTON:取消|cancel>>\`

### 模式 B：多维度决策（2+ 字段）→ SELECT / MSELECT
⚠️ **触发门槛**：必须 ≥2 个字段才合理。单一字段用 BUTTON。

- 单选 \`<<SELECT:placeholder|name|key1=文案1|key2=文案2|...>>\`
- 多选 \`<<MSELECT:placeholder|name|key1=文案1|key2=文案2|...>>\`
- 系统自动追加"提交"按钮，统一回调

触发场景：
- **需求设计 / 技术选型**：框架（React/Vue/Svelte）+ ORM（Prisma/Drizzle）+ 是否 SSR
- **部署配置**：环境（dev/staging/prod）+ 区域 + 通知人
- **多维筛选**：市场（A股/港股）+ 板块（科技/能源）+ 仓位
- **建定时任务**：周期 + 时间 + 内容
- **订阅多项**（MSELECT）：一次勾完所有想关注的板块

示例：
- 多 SELECT：\`<<SELECT:周期|cycle|daily=每天|weekly=每周>> <<SELECT:时间|time|am=早 8:00|pm=晚 8:00>>\`
- 混合：\`<<SELECT:市场|market|a=A股|hk=港股>> <<MSELECT:板块|sectors|tech=科技|finance=金融>>\`

### 模式 C：多项 ☑/☐ 清单 → CHECK（≥2 项才用）
⚠️ **触发门槛**：必须 **≥2 个 CHECK** 才合理。单一布尔问题（"是否部署？"）应该用 BUTTON。

\`<<CHECK:name|✓?|文案|style?>>\` —— \`name\` 唯一字段名（同 form 内不重复），\`✓\` 可选（默认勾选状态，\`1\`/\`✓\`/\`true\`/\`y\` 等均可），\`文案\` 是任务文字，\`style?\` 可选样式：

| style | 勾选后效果 | 何时用 |
|---|---|---|
| 省略（默认）| 啥都不变 | 普通选择、偏好勾选、订阅项（80% 场景默认用这个）|
| \`strike\` | 仅删除线 | 标记"已删除/已取消" |
| \`dim\` | 仅变淡（透明度 0.6）| 标记"已读/已处理" |
| \`done\` | 删除线 + 变淡 | 经典"已完成 todo"语义（待办勾掉）|

- **多个 CHECK 自动归入同一 form**，等用户点"提交"按钮一起回调（不是独立点击触发）
- **可与 SELECT/MSELECT 混用**：清单 + 字段配置同 form 一次性收齐
- 提交后每个 CHECK 渲染为只读 \`☑ 文案\` 或 \`☐ 文案\`，提交按钮加 \`@用户名\`
- 回调：\`[<用户名> 选择了:\\n  ☑ A\\n  ☐ B\\n  ☑ C\\n  其他字段=值]\`

触发场景（含推荐 style）：
- **今日待办 / 任务清单** → \`done\`（待办勾掉，划线 + 变淡 = 经典完成态）
- **PR review checklist** → \`done\`
- **巡检项 / 发布前确认** → \`done\`
- **口味/偏好/订阅勾选** → 省略 style（保持阅读清晰）
- **多维筛选项** → 省略 style
- **已读消息标记** → \`dim\`
- **已取消/已删除项** → \`strike\`

示例（默认无样式 — 偏好勾选）：
\`\`\`
请勾选口味偏好：
<<CHECK:spicy|✓|要辣>>
<<CHECK:sweet||要甜>>
\`\`\`

示例（done 样式 — 待办清单）：
\`\`\`
今日待办：
<<CHECK:t1|✓|代码审查|done>>
<<CHECK:t2||单元测试|done>>
<<CHECK:t3||部署 staging|done>>
\`\`\`

### TOAST：提交后的浮层提示（可选）
\`<<TOAST:type|content>>\` 放在卡片任意位置（不渲染为可视元素，纯配置）。用户点提交后飞书会弹出对应类型的浮层通知。

- **type**：\`info\`（蓝）/ \`success\`（绿）/ \`warning\`（黄）/ \`error\`（红）
- **content**：浮层文字，≤20 字最佳
- **不写 TOAST 时**：form 提交自动兜底 \`success "✓ 已提交"\`；BUTTON 点击不弹 toast

何时显式写 TOAST：
- 部署/重启等危险操作 → \`warning "开始部署，30 秒内可撤销"\`
- 长耗时任务 → \`info "已收到，预计 5 分钟"\`
- 普通选择/订阅 → **不写**（用兜底就够）

### 严禁
- 同一回复混用 BUTTON 和 form 字段（系统会强制丢弃 form 字段）
- 单个 CHECK（单一 boolean 用 BUTTON）
- 单个 SELECT/MSELECT 字段（单维度用 BUTTON）
- 无意义按钮（"OK""确认""继续"等）
- SELECT/MSELECT 单字段选项 >7 个（改用文字让用户输入）
- CHECK \`name\` 重复（同 form 唯一）
`;

const SECTION_IMG = `## 卡片嵌入图片

三种方式都能在卡片中渲染图片，按位置 inline 嵌入正文：

### 方式 1：\`<<IMG:url|alt?>>\` 显式标签
- **url**：https 链接（自动下载并上传到飞书）或本地绝对路径
- **alt**（可选）：图片描述
- 示例：\`<<IMG:https://picsum.photos/600/400|示例随机图>>\`、\`<<IMG:/tmp/chart.png|当日 K 线>>\`

### 方式 2：Markdown 图片语法 \`![alt](path)\`
- 等价于 \`<<IMG:path|alt>>\`（仅当 path 是本地白名单路径时生效）
- URL 形式 \`![pic](https://example.com/x.png)\` 保留原 markdown 渲染，不被升级
- 示例：\`![截图](/Users/.../sessions/<key>/shared/screenshot_1.png)\`

### 方式 3：直接写裸路径（推荐，最自然）
回复正文里直接写本地绝对路径，sigma 自动识别并升级为 inline 图片：
- **触发条件**：路径必须落在 sessionDir / projectRoot / \`/tmp/\` 三个前缀下
- **支持扩展名**：png / jpg / jpeg / gif / webp / bmp（大小写不敏感）
- **代码块内不升级**（\`\`\` 围栏保护）
- **不升级**：URL（https）、pdf / svg / xlsx 等非光栅图、非白名单路径
- 示例：\`生成了图：/tmp/chart.png\` → 渲染时 \`/tmp/chart.png\` 被替换为 inline 图

### 共同行为
- 渲染位置：按出现的位置 inline 插入（不是聚到末尾）
- 上传失败：优雅退化为 \`_[图片: <url>]_\` 占位文本
- 同 URL 在同一回复中复用 → 去重缓存（只传一次）
- 图片不属于 form 字段，与 BUTTON / SELECT / MSELECT / CHECK / TOAST 都不冲突
`;

const SECTION_TITLE = `## 卡片标题

回复开头写 \`<<TITLE:标题|颜色?>>\` 可以为这条回复设置标题（飞书卡片顶部 header）。

- **标题**：≤10 字，概括主题
- **颜色**（可选）：决定 header 背景色，省略默认 \`blue\`

| 颜色 | 适用 |
|---|---|
| \`blue\`（默认）| 信息 / 成功 / 完成 |
| \`green\` | 上涨 / 增长 / 积极行情 |
| \`red\` | 失败 / 紧急 / 下跌 |
| \`orange\` | 警告 |
| \`yellow\` | 提醒 / 亮点 |
| \`wathet\` | 次级信息 / 数据播报 |
| \`turquoise\` | 进展中 |
| \`carmine\` | 严重警告 |
| \`violet\` / \`purple\` / \`indigo\` | 特殊场景 |
| \`grey\` | 中立 / 不活跃 |

**何时写 TITLE**：
- 回复含 markdown 格式（表格、列表、代码块、加粗、链接、分隔线）→ **必须**写 TITLE 才走流式卡片
- 纯文字短回复（打招呼、一两句话确认）→ **不写**

示例：
- \`<<TITLE:部署完成>>\`
- \`<<TITLE:沪指 -1.5%|orange>>\`
- \`<<TITLE:✅ 提交成功|green>>\`

标题里**可以**自带 emoji（✅ ❌ ⚠️ 💡 🔄 🚨 ✨ 📊 等），系统不会自动追加任何 emoji。
`;

interface Result {
  path: string;
  action: 'skip-marker' | 'skip-no-file' | 'replaced' | 'appended';
}

/**
 * Replace a single `## SectionName` block (up to but not including the next `## `
 * heading) with `newSection`. If the heading isn't present, append at the end.
 * Returns the updated string.
 */
function replaceOrAppendSection(content: string, sectionTitle: string, newSection: string): string {
  const startRe = new RegExp(`^## ${sectionTitle.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$`, 'm');
  const startMatch = startRe.exec(content);
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
    return before + newSection + sep + rest;
  }
  // Append
  const sep = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return content + sep + newSection;
}

function processOne(filePath: string, dryRun: boolean): Result {
  if (!fs.existsSync(filePath)) return { path: filePath, action: 'skip-no-file' };
  const original = fs.readFileSync(filePath, 'utf8');
  if (original.includes(MARKER)) return { path: filePath, action: 'skip-marker' };

  let next = original;
  next = replaceOrAppendSection(next, '交互卡片', SECTION_INTERACTIVE);
  next = replaceOrAppendSection(next, '卡片嵌入图片', SECTION_IMG);
  next = replaceOrAppendSection(next, '卡片标题', SECTION_TITLE);

  const hadInteractive = /^## 交互卡片\s*$/m.test(original);
  const action: Result['action'] = hadInteractive ? 'replaced' : 'appended';
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
  console.log(`\n=== Backfill ${dryRun ? '(DRY-RUN)' : ''} ===`);
  for (const [action, count] of Object.entries(summary)) {
    console.log(`  ${action.padEnd(20)} ${count}`);
  }
  console.log(`  total              ${results.length}`);
}

main();
