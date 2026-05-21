import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';
import { McpManager } from './mcp-manager.js';

export interface Session {
  sessionKey: string;
  sessionId?: string;
  sessionDir: string;
  lastUsed: number;
}

const SESSION_EXPIRE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;    // 1 hour
const PERSIST_FILE = 'sessions.json';

export class SessionManager {
  private sessions = new Map<string, Session>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private persistPath: string;
  private mcpManager: McpManager;

  constructor(
    private sessionsDir: string,
    private logger: Logger,
  ) {
    this.persistPath = path.join(path.dirname(sessionsDir), PERSIST_FILE);
    fs.mkdirSync(sessionsDir, { recursive: true });
    this.mcpManager = new McpManager(sessionsDir, logger);
    this.loadFromDisk();
    this.startCleanup();
  }

  /**
   * Derive session key from chat type and ID
   */
  static getSessionKey(chatType: 'p2p' | 'group', userId: string, chatId: string): string {
    if (chatType === 'p2p') {
      return `dm_${userId}`;
    }
    return `group_${chatId}`;
  }

  /**
   * Get or create a session
   */
  getOrCreate(sessionKey: string): Session {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      const sessionDir = path.join(this.sessionsDir, sessionKey);
      fs.mkdirSync(sessionDir, { recursive: true });
      session = {
        sessionKey,
        sessionDir,
        lastUsed: Date.now(),
      };
      this.sessions.set(sessionKey, session);

      // Initialize CLAUDE.md with session settings template if it doesn't exist
      this.initClaudeMd(sessionDir);

      // Create symlinks to shared and members directories
      this.ensureSharedLink(sessionDir);
      this.ensureMembersLink(sessionDir);

      this.logger.info({ sessionKey }, 'Created new session');
    }

    // Ensure links exist (also for existing sessions)
    this.ensureSharedLink(session.sessionDir);
    this.ensureMembersLink(session.sessionDir);

    session.lastUsed = Date.now();

    // Generate per-session MCP config (.claude/settings.json)
    this.mcpManager.setup(sessionKey, session.sessionDir);

    return session;
  }

  /**
   * Get the MCP manager (for scheduler to access skills)
   */
  getMcpManager(): McpManager {
    return this.mcpManager;
  }

  /**
   * Reset session (/new command) — clear sessionId but keep directory and memories
   */
  reset(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.sessionId = undefined;
      this.saveToDisk();
      this.logger.info({ sessionKey }, 'Session reset (memories and files preserved)');
    }
  }

  /**
   * Get a session by key
   */
  get(sessionKey: string): Session | undefined {
    return this.sessions.get(sessionKey);
  }

  /**
   * Get all session keys (for scanning email accounts, etc.)
   */
  getSessionKeys(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get the sessions directory path
   */
  getSessionsDir(): string {
    return this.sessionsDir;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.saveToDisk();
  }

  /**
   * Ensure a symlink ./shared → {projectRoot}/shared exists in the session directory.
   * Allows cross-session knowledge transfer without escaping session boundaries.
   */
  private ensureSharedLink(sessionDir: string): void {
    const linkPath = path.join(sessionDir, 'shared');
    const target = path.join(path.dirname(this.sessionsDir), 'shared');
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) return; // Already exists
      // Not a symlink (maybe a regular dir) — skip to avoid data loss
      return;
    } catch {
      // Does not exist — create it
    }
    try {
      fs.symlinkSync(target, linkPath, 'dir');
    } catch {
      // Ignore — race condition or permission issue
    }
  }

  /** Ensure members/ symlink exists in session directory. */
  private ensureMembersLink(sessionDir: string): void {
    const linkPath = path.join(sessionDir, 'members');
    const target = path.join(path.dirname(this.sessionsDir), 'members');
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) return;
      return; // Not a symlink — don't overwrite
    } catch { /* doesn't exist */ }
    try {
      fs.symlinkSync(target, linkPath, 'dir');
    } catch { /* ignore */ }
  }

  /**
   * Initialize CLAUDE.md as the primary memory layer for this session.
   * Auto-loaded by Claude Code at zero cost — no tool calls needed.
   */
  private initClaudeMd(sessionDir: string): void {
    const claudeMdPath = path.join(sessionDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) return; // Don't overwrite existing

    const template = `# Session 设定

本文件自动加载，是最高优先级的记忆层。重要信息请直接写入此文件（用 Edit 工具更新对应章节）。

## 用户信息

（用户身份、公司、角色）

## 用户偏好

（语言风格、工作习惯、常用工具、沟通偏好）

## 重要事实

（客户信息、项目背景、关键日期、账号信息等不变的事实）

## 经验与方法论

（踩过的坑、有效的工作流程、需要避免的错误、提炼出的最佳实践）

## Git Commit 规范

提交代码时必须使用以下格式：

\`\`\`
<type>(<需求名称>): <简短描述>

<详细描述>

feishuId:<飞书id>
\`\`\`

**type 字段**：feat(新功能) | fix(修bug) | docs(文档) | style(格式) | refactor(重构) | test(测试)

- **需求名称**：飞书中的需求或 bug 标题
- **简短描述**：不超过 50 字符
- **详细描述**：若有则添加，无则删除，单行不超过 50 字符
- **feishuId**：对应飞书需求 ID

## 交互卡片

<!-- sigma-template:interactive-card-v7 -->

回复末尾可加交互元素让用户操作。**两类互斥**：BUTTON（立即触发）⊻ form 字段（SELECT/MSELECT/CHECK，统一提交）。form 字段之间可自由混用。

**决策公式：你这一轮要让用户回答几件事？**
- **1 件** → BUTTON（哪怕选项多）
- **2+ 件** → form 字段（SELECT / MSELECT / CHECK，任选搭配）

**决策矩阵：**

| 情况 | 工具 |
|---|---|
| 1 件事，是/否 / 程度 / N 选 1 / 链接 | **BUTTON** |
| 2+ 件事，每件"在选项里挑 1 个" | **SELECT × N** |
| 2+ 件事，每件"在选项里挑多个" | **MSELECT × N** |
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

\`<<CHECK:name|✓?|文案|style?>>\` —— \`name\` 唯一字段名（同 form 内不重复），\`✓\` 可选（默认勾选状态，\`1\`/\`✓\`/\`true\`/\`y\` 等均可），\`文案\` 是任务文字，\`style?\` 可选样式（决定勾选后视觉效果）：

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
- **PR review checklist** → \`done\`（与待办同理）
- **巡检项 / 发布前确认** → \`done\`
- **口味/偏好/订阅勾选** → 省略 style（保持阅读清晰）
- **多维筛选项** → 省略 style
- **已读消息标记** → \`dim\`
- **已取消/已删除项** → \`strike\`
- **混合清单+配置**：清单 + 优先级（SELECT）+ 关联板块（MSELECT）一次提交

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

示例（CHECK + SELECT + MSELECT 混合）：
\`\`\`
完成检查 + 设置优先级：
<<CHECK:done_local||跑通本地|done>>
<<CHECK:reviewed|✓|PR 评审完毕|done>>
<<SELECT:优先级|prio|h=高|m=中|l=低>>
<<MSELECT:关注板块|sec|tech=科技|finance=金融>>
\`\`\`

### 反面教材
❌ 错（拆成 5 轮 BUTTON 点 5 次）：每个待办给一个 BUTTON 让用户连续点。
✅ 对：5 个 CHECK + 1 个共享"提交"按钮。

❌ 错（单一 CHECK 当是/否问）：\`<<CHECK:deploy||部署到 prod>>\`。
✅ 对：\`<<BUTTON:部署|deploy|primary>> <<BUTTON:取消|cancel>>\`

❌ 错（混 BUTTON 和 CHECK）：BUTTON 立即触发 + CHECK 等提交 → 用户困惑该点哪个先。
✅ 对：纯 CHECK form / 纯 BUTTON，二选一。

❌ 错（清单塞进 MSELECT 下拉）：要点开下拉才能勾选每项。
✅ 对：CHECK 行内直接展示。

❌ 错（拆 3 轮 SELECT）：先问周期 → 再问时间 → 再问内容。
✅ 对：3 个 SELECT 字段同屏一次提交。

❌ 错（单维度强用 SELECT）：问"是否部署？"用下拉。
✅ 对：用 BUTTON 部署/取消。

### 严禁
- 同一回复混用 BUTTON 和 form 字段（SELECT/MSELECT/CHECK，系统会强制丢弃 form 字段）
- 单个 CHECK（单一 boolean 用 BUTTON）
- 单个 SELECT/MSELECT 字段（单维度用 BUTTON）
- 无意义按钮（"OK""确认""继续"等）
- SELECT/MSELECT 单字段选项 >7 个（改用文字让用户输入）
- CHECK \`name\` 重复（同 form 唯一）

### TOAST：提交后的浮层提示（可选）
\`<<TOAST:type|content>>\` 放在卡片任意位置（不渲染为可视元素，纯配置）。用户点提交后飞书会弹出对应类型的浮层通知。

- **type**：\`info\`（蓝）/ \`success\`（绿）/ \`warning\`（黄）/ \`error\`（红）
- **content**：浮层文字，≤20 字最佳
- **不写 TOAST 时**：form 提交自动兜底 \`success "✓ 已提交"\`；BUTTON 点击不弹 toast（已有按钮变色反馈）

何时显式写 TOAST：
- 部署/重启等危险操作 → \`warning "开始部署，30 秒内可撤销"\`
- 长耗时任务 → \`info "已收到，预计 5 分钟"\`
- 提交即时失败 → \`error "字段缺失，请重选"\`（通常用不到，因为 form 提交都是成功的）
- 普通选择/订阅 → **不写**（用兜底就够）

示例：
\`\`\`
确认部署到生产环境？
<<CHECK:backup|✓|已备份|done>>
<<CHECK:rollback|✓|回滚脚本就绪|done>>
<<SELECT:节奏|pace|fast=立即|gray=灰度 1%|safe=灰度 10%>>
<<TOAST:warning|开始部署，30 秒内 /stop 可撤销>>
\`\`\`

## 卡片嵌入图片

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
- **代码块内不升级**（\`\`\` 围栏保护，避免误吞 \`cp /x/y.png ...\` 之类的 shell 片段）
- **不升级**：URL（https）、pdf / svg / xlsx 等非光栅图、非白名单路径
- 示例：\`生成了图：/tmp/chart.png\` → 渲染时 \`/tmp/chart.png\` 被替换为 inline 图

### 共同行为
- 渲染位置：按出现的位置 inline 插入（不是聚到末尾）
- 上传失败：优雅退化为 \`_[图片: <url>]_\` 占位文本
- 同 URL 在同一回复中复用 → 去重缓存（只传一次）
- 图片不属于 form 字段，与 BUTTON / SELECT / MSELECT / CHECK / TOAST 都不冲突，**可在任意范式下使用**

## 卡片标题

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
- \`<<TITLE:✅ 提交成功|green>>\`（emoji 可以自加，系统不会再追加）

标题里**可以**自带 emoji（✅ ❌ ⚠️ 💡 🔄 🚨 ✨ 📊 等），系统不会自动追加任何 emoji。

## 并行 agent

<!-- sigma-template:parallel-agent-v3 -->

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
    try {
      fs.writeFileSync(claudeMdPath, template);
    } catch {
      // Ignore — might be a race condition
    }
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [key, session] of this.sessions) {
        if (now - session.lastUsed > SESSION_EXPIRE_MS) {
          // Only clear sessionId, keep directory for memories
          session.sessionId = undefined;
          cleaned++;
        }
      }
      if (cleaned > 0) {
        this.saveToDisk();
        this.logger.debug({ cleaned }, 'Cleaned expired sessions');
      }
    }, CLEANUP_INTERVAL_MS);
  }

  private saveToDisk(): void {
    try {
      const data = Array.from(this.sessions.values())
        .filter((s) => s.sessionId) // Only persist sessions with active sessionId
        .map((s) => ({
          sessionKey: s.sessionKey,
          sessionId: s.sessionId,
          lastUsed: s.lastUsed,
        }));
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger.error({ err }, 'Failed to save sessions');
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;

      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as Array<{
        sessionKey: string;
        sessionId?: string;
        lastUsed: number;
      }>;

      const now = Date.now();
      for (const entry of data) {
        // Skip expired sessions
        if (now - entry.lastUsed > SESSION_EXPIRE_MS) continue;

        const sessionDir = path.join(this.sessionsDir, entry.sessionKey);
        fs.mkdirSync(sessionDir, { recursive: true });
        this.sessions.set(entry.sessionKey, {
          sessionKey: entry.sessionKey,
          sessionId: entry.sessionId,
          sessionDir,
          lastUsed: entry.lastUsed,
        });

        // Ensure MCP config is up to date
        this.mcpManager.setup(entry.sessionKey, sessionDir);
      }

      this.logger.info({ count: this.sessions.size }, 'Restored sessions from disk');
    } catch (err) {
      this.logger.error({ err }, 'Failed to load sessions');
    }
  }
}
