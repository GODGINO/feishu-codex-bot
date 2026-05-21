# Sigma — 飞书 AI 工作流助手

把 Claude Code 的完整能力（代码、文件、浏览器、命令执行、键鼠屏控制）桥接到飞书，支持多人/多会话、微信互通、远程设备控制。

> **这份 README 的定位**：主要写给未来的 Claude Code agent / 新协作者看。目标是**读完这个文件就能操作这个项目**，不需要重新扫一遍代码库。所以把**架构、约束、踩坑**都显式写出来了，比一般 README 啰嗦。

---

## 当前运行状态

- **部署位置**：Mac mini，单实例，由 PM2 管理（app name: `feishu-bot`）
- **入口文件**：`dist/index.js`（来源 `src/index.ts`）
- **公网域名**：由 Cloudflare Tunnel → Mac mini `localhost:3333`，实际域名见部署配置（不写入仓库）
- **Bot 守护**：`scripts/bot.sh start|stop|restart|status|log`（PID 文件 `.bot.pid` + 启动时 pgrep 清理 orphan）

**重要**：bot 是长期运行进程，改源码不影响已运行的实例；必须 `npm run bot:restart` 才生效（会先 `npx tsc` 编译再 PM2 restart）。

---

## 给 Agent 的导航指南

### 常见任务对应的文件位置

| 任务 | 去哪改 |
|---|---|
| 修系统提示词 | `system-prompt/common.md`（共享）+ `env.local.md` / `env.server.md`（模式专属）。**不是** `system-prompt.txt`（已删除） |
| 加新的 bot 命令（`/xxx`）| `src/bridge/command-handler.ts` |
| 改卡片渲染 | `src/feishu/card-builder.ts`（构建器）+ `card-streamer.ts`（流式） |
| 改 Alert 调度（条件触发）| `src/scheduler/alert-runner.ts` |
| 改 Alert MCP 工具 | `src/alert/alert-mcp.ts` |
| 改 Admin Alert tab | `web/src/components/AlertTable.tsx` + `web/src/pages/SessionDetail.tsx` (tabs 数组)|
| 改自定义标签 `<<TITLE:...>>` 等的解析 | `src/feishu/card-builder.ts` `extractTitleFromText()` / `extractButtons()` / `extractReactions()` / `isNoReply()` |
| 改消息路由（DM/群/微信/admin）| `src/bridge/message-bridge.ts` |
| 改 Claude 进程管理 | `src/claude/process-pool.ts` |
| 改 MCP 配置 | 项目根 `mcp-config.json`（模板）+ `src/claude/mcp-manager.ts`（渲染） |
| 加/改 skill | `skills/<name>/SKILL.md`（shared，进 `mcp-config.json` 的 `sharedSkills` 数组） |
| 改 Admin Dashboard 后端 | `src/admin/server.ts` + `src/admin/routes.ts` |
| 改 Admin Dashboard 前端 | `web/`（React + Vite）|
| 改微信桥 | `src/wechat/wechat-bridge.ts` |
| 改 Chrome 管理 | **`src/local-only/chrome/` + `src/claude/mcp-manager.ts` 里的 Chrome 方法**（仅本地版用） |
| 改远程终端协议 | `src/relay/relay-server.ts` + `src/relay/protocol.ts` |
| 改 Electron 插件 | `sigma-terminal/src/main/` |

### 想快速理解"一条消息到 bot 后发生什么"

跟着这条调用链读：
```
src/feishu/event-handler.ts::createEventHandler   ← 飞书 WebSocket 事件入口
  → src/bridge/message-bridge.ts::handleMessage   ← 路由中枢
      → src/bridge/command-handler.ts::handle     ← 命令拦截 (/help /model 等)
      → src/claude/process-pool.ts::send          ← 转给 Claude 进程
          → stream-parser.ts → streamer → card-builder → message-sender
              → src/feishu/message-sender.ts::sendCard  ← 回到飞书
```

### 想理解 "Alert 触发后怎么走"

```
src/scheduler/alert-runner.ts::pollAlert      ← 每 N 秒轮询
  → execShell(check_command)                  ← sh 脚本检查
  → exit 0 + JSON 数组非空 → 触发
      ├─ execution_mode = 'message_only'      → MessageSender.sendReply
      ├─ execution_mode = 'shell'             → execShell(trigger_command)
      └─ execution_mode = 'claude'            → MessageBridge.executeCronJob (复用 cron 执行体)
  → 成功 → state.watermark.processed_ids.push(item.NEW_ID) + persist
  → 失败 → state.stats.failures++ → 累计 5 次自动 pause
```

具体协议：check_command sh 脚本输入 `WATERMARK_JSON` 环境变量，输出 `[{NEW_ID, NEW_PUBDATE, ...}]` JSON 数组（按 pubdate 升序）。

---

## 核心能力

- **多会话管理** — 群/私聊独立 sessionKey，每 session 一个常驻 Claude 进程（`--resume` 持久化）
- **三渠道互通** — 飞书 + 微信 + Admin Dashboard 共享同一个 Claude 上下文
- **远程设备控制** — Sigma Terminal (macOS/Windows Electron app) + 浏览器扩展通过 relay 执行命令、操作文件、控制屏幕、操作手机
- **卡片交互** — 流式回复、工具调用面板、按钮（callback + URL）、emoji reactions
- **邮件收发** — IMAP IDLE 推送 + SMTP 发件
- **定时任务** — cron 表达式，热加载（每 15 秒扫 `cron-jobs.json` 变化）
- **Alert 系统** — 条件触发任务（cron 的兄弟功能）。watcher（持续监听新事件）/ one_shot（一次性）双形态；执行模式三档：claude / shell / message_only；watermark + processed_ids 双重去重，失败 5 次自动 pause
- **Skill 系统** — 20+ 内置技能，可 session 级启用
- **Admin Dashboard** — React SPA，会话管理、Send as Sigma、知识库编辑

---

## 架构

```
飞书用户 ─── 飞书 WebSocket ───┐
微信用户 ─── iLink 长轮询 ─────┼── Bot 服务器 :3333 ─── Cloudflare Tunnel ─── <your-domain>.com
Admin    ─── REST + WS ────────┘        │
                                         ├── Feishu SDK Client
                                         ├── MessageBridge (三渠道路由)
                                         ├── Claude Code 进程池 (per-session, stream-json)
                                         ├── MCP 配置管理 (stdio + HTTP-Streamable)
                                         ├── Relay Server (WSS → 远程设备，HMAC 签名)
                                         ├── Admin Server (Express + admin-chat WS)
                                         ├── Cron Runner
                                         ├── Alert Runner (条件触发)
                                         ├── Email IDLE Monitor
                                         └── WeChat Bridge (iLink 长轮询)

                                              ↕ WSS + HMAC
                                              
                                 ┌──────────────────────────┐
                                 │ Sigma Terminal (Electron)│  ← 用户 Mac
                                 │  • shell/file 工具        │
                                 │  • computer-use (键鼠屏)   │
                                 │  • phone-use (ADB)       │
                                 └──────────────────────────┘
                                 ┌──────────────────────────┐
                                 │ Chrome Extension (MV3)   │  ← 用户 Chrome
                                 │  • DOM 操作 / a11y 树     │
                                 └──────────────────────────┘
```

### 每 session 的本地 Chrome（仅本地版）
Mac mini 版本里，每个 sessionKey 分配独立 Chrome 实例：
- 端口：从 9300 开始递增，持久化到 `port-allocations.json`（本项目根目录）
- Profile：`sessions/{sessionKey}/.chrome-data/` 独立用户数据目录（登录态隔离）
- 启动：懒加载，用户/Claude 首次用浏览器时跑 `sessions/{sessionKey}/start-chrome.sh`
- 关闭：`ChromeIdleChecker` 每 5 分钟扫，session 空闲 >30 分钟 + Chrome 还活着就 kill

云端版本**砍掉**这一套，浏览器操作全走 sigma-terminal + 用户真实 Chrome（详见"云迁移状态"章节）。

---

## 关键约束与设计决策

### 1. 本地/云端双版本的目录切分

2026-04-21 做的 Phase 0 重构：
```
src/
├── core（隐式）= src/ 下除 local-only/ server-only/ 外的所有文件
├── local-only/chrome/idle-checker.ts  ← Mac mini 专属
├── server-only/                        ← 云端专属（目前空）
├── index.ts                            ← 本地版入口（当前在用）
└── index.server.ts                     ← 云端版入口（不运行，只用于 typecheck）
```

**边界强制**：
- `tsconfig.json` 编本地版（includes all，excludes 未配但 core 不会 import `server-only`）
- `tsconfig.server.json` 编云版（excludes `src/local-only/**` + `src/index.ts`）—— 如果 server 代码意外依赖 local-only，这里会编译失败
- `npm run typecheck` = 同时跑两份 typecheck

**添加跨模式代码**：放在 `src/` 根下（隐式 core）；**仅 Mac 本地用**的放 `src/local-only/`；**仅云端用**的放 `src/server-only/`。

### 2. 系统提示词拼接

2026-04-21 做的 Phase 0 改动：
- **删了** `system-prompt.txt`
- **新建** `system-prompt/common.md`（两版共享）+ `env.local.md` + `env.server.md`（模式专属）
- 运行时按 `SIGMA_PROMPT_MODE` 环境变量（默认 `local`）合成 `common + env.{mode}`
- 当 env.{mode}.md 为空时，合成结果 = common.md，**和之前的 system-prompt.txt 字节级一致**
- Loader 在 `src/config.ts::loadSystemPrompt()`，保留旧 `system-prompt.txt` fallback

### 3. MCP 配置两分：stdio vs URL-type

**血的教训**：
- `mcp-servers.json`（通过 `--mcp-config` 传给 Claude CLI）**只支持 stdio MCP**（command + args）。塞 URL-type MCP 会让 Claude 进程**启动时 fatal exit**
- URL-type MCP（Streamable HTTP，如飞书 MCP）**必须**放在 `.claude/settings.json` 里（非 fatal）
- **不要**用 `--strict-mcp-config`，它会屏蔽 settings.json 里的 MCP

详细见 `src/claude/mcp-manager.ts::buildInitialMcpServers` / `buildSettings`。

### 4. Session 隔离模型

- sessionKey 格式：**DM 用 `dm_{open_id}`，群用 `group_{chat_id}`**（`src/claude/session-manager.ts::getSessionKey`）
- 每 session：独立 Claude 进程、独立 `sessions/{sessionKey}/` 目录、独立 Chrome 实例（本地版）、独立 cron 任务
- **群聊内**：**同一个 session**（所有成员共享上下文），但每条消息前缀 `[发送者: 名字 | id: ou_xxx]`，且按 sender 注入其 `MEMBER.md`
- 全局共享：Feishu App 凭证、Claude API Key、`members/` 用户档案目录（软链接）

### 5. 自定义标签系统（Claude 输出给用户的"指令"）

Claude 可以在回复里输出这些标签，bot 解析后做相应处理：

| 标签 | 格式 | 作用 |
|---|---|---|
| `<<TITLE:xxx>>` | 第一行 | 作为卡片 header 显示 |
| `<<BUTTON:label\|action>>` | 任意位置 | 卡片里加按钮（callback action 或 URL） |
| `<<REACT:emoji>>` | 任意位置 | 给用户消息加 emoji reaction |
| `<<THREAD>>` | 任意位置 | 发到飞书 thread 里而不是主频道 |
| `NO_REPLY` | 整条消息 | 不回复用户（Claude 的"保持安静"信号） |

**所有解析器都是宽容的**（Postel 定律）：
- 容忍 1-2 个尖括号（`<`、`<<`）
- 容忍全角冒号 `：`
- 容忍 HTML 式闭合 `<TITLE>xxx</TITLE>`
- 容忍闭合乱码 `</<TITLE>`、`</>>`
- 容忍大小写

具体实现在 `src/feishu/card-builder.ts:157-213`，里面的注释详细列出所有容忍的变体。遇到新的 Claude 输出变体需要加容忍时，改这里 + `src/feishu/card-streamer.ts:638-644` + `src/wechat/wechat-bridge.ts:605-611`（三处要同步）。

### 6. 消息队列 & 并发控制

- 每 session 一个 FIFO 队列（`src/bridge/message-queue.ts`）
- 同 session 串行处理，避免两条消息的工具调用交错
- 默认容量 **5 条**（`MAX_QUEUE_PER_SESSION` 可调）
- 全局最大并发 `MAX_CONCURRENT=3`（跨 session）

### 7. Claude 进程池的 respawn 逻辑

- 进程常驻，session-level 复用
- 会崩溃 → 保存的 sessionId 在 `.savedSessionIds` → 重启用 `--resume` 恢复对话上下文
- **触发 respawn 的事件**：
  - `mcp-servers.json` 内容变了（如 start-chrome.sh 加了 chrome-devtools MCP 条目 → 触发 `mcpConfigChanged` signal）
  - `/model`、`/effort` 命令切换模型或推理深度
  - Crash exit
  - Token 超限 / 上下文满

### 8. Cloudflare Tunnel 是本地版专属

- `scripts/bot.sh::start_tunnel` 启动 `cloudflared tunnel run --token $CF_TUNNEL_TOKEN`
- 把公网域名反向代理到 Mac mini `localhost:3333`
- 云端版本部署后会**直接 DNS A 记录**指向云服务器 IP，Tunnel 退役

---

## 远程设备控制

### 架构（已经在运行的）

```
Claude → remote-terminal-mcp.ts (stdio MCP)
  → HTTP POST /api/relay/command
    → relay-server.ts (WebSocket 桥, HMAC 命令签名)
      → Sigma Terminal.app / 浏览器扩展 (验签后执行)
```

### 35 个远程工具

| 类别 | 工具数 | 文件 |
|------|---|---|
| Code Use (shell/file/search) | 9 | `sigma-terminal/src/main/executor.ts` |
| Computer Use (screen/mouse/keyboard/app/window) | 13 | `sigma-terminal/src/main/computer-use/` |
| Phone Use (ADB 控制 Android) | 13 | `sigma-terminal/src/main/phone-use/` |

### 鉴权（当前，待升级）

- URL 包含 sessionKey：`wss://<your-domain>/relay?session={sessionKey}`
- HMAC 密钥 = sessionKey 本身（**已知安全隐患**，云迁移时会换成 per-connection 随机密钥）
- 任何知道 sessionKey 的人都能连 relay（无身份认证）

---

## 安全

### 四层纵深防御

```
┌──────────────────┬──────────────────────────────────────┐
│ TLS (WSS)        │ 中间人无法篡改                         │
├──────────────────┼──────────────────────────────────────┤
│ Cloudflare       │ 证书验证，无法伪造域名                 │
├──────────────────┼──────────────────────────────────────┤
│ SessionKey URL   │ 必须存在对应 session 目录才接受连接     │
├──────────────────┼──────────────────────────────────────┤
│ HMAC 命令签名     │ 每条命令签名，客户端验签后才执行        │
└──────────────────┴──────────────────────────────────────┘
```

### 服务端防护

- Admin 双密码登录 + Rate Limit (5 次/5 分钟 per IP)
- Timing-safe token 比较
- 所有列表 API 需 auth（`/api/sessions`、`/api/relay/status` 等）
- 下载端点文件名白名单
- `file_write` 限制 home 目录，危险命令拦截（`rm -rf`、`curl | sh` 等）
- `shell_exec` 环境变量白名单（仅传 PATH、HOME、SHELL、LANG）
- 提示词注入防护：sender name 转义
- `sigma-terminal` 端也有独立的 `security.ts` 拦截（双重保险）

---

## 开发工作流

### 修代码 → 生效

```bash
# 改完代码，保存
npm run typecheck       # 两版 tsconfig 都过
npm run bot:restart     # 重启 bot (含 tsc + PM2 restart + tunnel restart)
npm run bot:log         # 看日志
```

**不要**：
- ❌ 直接改 `dist/`（会被 `tsc` 覆盖）
- ❌ 跳过 `tsc` 直接 `pm2 restart`（会用老编译产物）
- ❌ 把本地 Mac 专属 import 加到 `src/core`（会让 `tsconfig.server.json` 失败，CI 挂）

### 常用脚本

| 脚本 | 作用 |
|---|---|
| `npm run dev` | tsx 本地版（前台，改了自动重载） |
| `npm run dev:server` | tsx 云端版（前台调试用） |
| `npm run build` | 编本地版 + web 前端 |
| `npm run build:server` | 只编云端版（产物去 `dist-server/`） |
| `npm run typecheck` | 两版 tsconfig 都过 |
| `npm run bot` | PM2 启动本地版（生产模式） |
| `npm run bot:restart` | tsc + PM2 restart + tunnel restart |
| `npm run bot:log` | PM2 日志 |

### 回归验证清单

改完核心代码（比如 message-bridge、card-builder、process-pool）后：
1. `npm run typecheck`
2. `npm run bot:restart`
3. 在飞书 DM 给 bot 发消息，确认正常回复
4. 在群里 @bot，确认正常回复 + 按钮/TITLE 等渲染
5. `/help` 命令能正常返回
6. 看 `.bot.log` 尾部没有异常 stack trace

---

## 已知陷阱

1. **Claude 子进程嵌套检测**：spawn Claude 前必须清掉所有 `CLAUDE_*` 和 `ANTHROPIC_INNER` 环境变量，否则 Claude 以为自己是嵌套调用会报错（`src/claude/process-pool.ts::buildEnv`）
2. **`--strict-mcp-config` 会屏蔽 settings.json** —— 不要用
3. **全局 `~/.claude/settings.json`** 如果有 `chrome-devtools` MCP 配在端口 9350，可能和 session 分配的端口冲突，导致 chrome-devtools MCP 连错 Chrome 实例
4. **Chrome 实例数**：当前 84 个 session 都分配了端口，但懒启动 —— 如果同时很多 session 触发浏览器操作，Mac 内存会炸（每个 Chrome ~500MB）
5. **Claude 输出的奇葩变体**：Claude 偶尔会输出 `<<TITLE:xxx</>>`（末尾乱码）、`<<TITLE：xxx>>`（全角冒号）、`<TITLE>xxx</TITLE>`（HTML 式）等。`card-builder.ts` 里的 3 级优先级正则已处理，新变体需要同步改 3 处（card-builder / card-streamer / wechat-bridge）
6. **PM2 进程 name**：`feishu-bot`。如果改 bot.sh 里的 app name 或入口路径，记得 `pm2 delete feishu-bot` 清旧的
7. **系统提示词修改不生效**：改了 `system-prompt/common.md` 之后 bot **必须重启**。config 在启动时一次性加载，运行时不 reload
8. **Feishu 卡片静默丢弃**：卡片正文超过约 28000 字符会被飞书默默扔掉（不报错，用户看到空卡片）。`card-streamer.ts` 和 `card-builder.ts` 都有截断保护（`CARD_TEXT_LIMIT`）
9. **Markdown 代码围栏**：某些 Markdown 在飞书 v2 卡片里需要前置换行才渲染正确（`fixMarkdownForFeishu`），否则 ``` 号贴着正文会乱
10. **群成员 400 错误**：启动时同步群成员会对已被踢出的群返回 400，日志里会看到一堆 axios error dump。已经被 `.catch(() => {})` 吞掉，无需处理
11. **前端改动 vs 后端改动的重启边界**（实测后修正）：
    - **改 React 前端（`web/`）→ `npm run build:web` 即可，不需要 bot:restart**。admin server 是静态文件 serve，浏览器刷新就看到新页面（因为 vite 直接写到 `web/dist/`）。
    - **改 Express routes（`src/admin/routes.ts`）或任何 backend ts 代码 → 必须 `npm run build` + `bot:restart`**，否则新接口路由不会注册。
    - **常见踩坑**：改了 React Tab + 加了对应后端 route → build 后只看见 Tab UI 但点击会 401/404，因为后端没重载。务必两端都 build + 重启。
    - `scripts/bot.sh` 里的 `npx tsc` 只编译 backend ts；前端编译走 `npm run build:web`。`npm run build` 包含两者。
12. **PM2 vs 简单 daemon**：README 历史描述是 PM2，但当前 Mac mini 上 `pm2` 命令可能已不在 PATH 里。如果 `pm2 list` 报 command not found，说明改成了 `bot.sh` 直接管理 .bot.pid（验证方法：`ps aux | grep node` 看 master 进程是不是被 PM2 包着）
13. **Alert watcher 失败 5 次自动 pause**：`src/scheduler/alert-runner.ts` 的 `CONSECUTIVE_FAILURE_THRESHOLD=5`。如果 check_command 持续失败（如 API 风控），到 5 次后会自动 disable + 飞书告警。修复后用 `mcp__alert__toggle_alert` 重新启用，或在 admin UI 点 Enable
14. **B 站 watcher WBI 签名 412**：`skills/agent-reach/scripts/check_bili_uploader.sh` 现在依赖 bilix 的 `_add_sign`，但 B 站 2026-04+ 加了新风控（buvid3 / b_nut），bilix 可能过时。短期 workaround：用 RSSHub 公共服务 / 注入用户登录 cookie；长期：升级 bilix 或自实现 WBI

---

## 云迁移状态（2026-04-21）

目标：把 bot 搬到云 VPS，Mac mini 保留作为 dev/staging。

### 已完成
- **Phase 0** ✅ 目录结构重构 + 系统提示词拼接（本次）
  - `src/chrome/` → `src/local-only/chrome/`
  - 新增 `src/server-only/`（空占位）+ `src/index.server.ts`
  - 新增 `tsconfig.server.json`
  - 新增 `system-prompt/common.md + env.local.md + env.server.md`
  - 新增 scripts: `dev:server`、`build:server`、`typecheck`
  - 对现有 Mac mini 版行为零影响

### 规划中（按顺序，不一定都做）
- **Phase 1** 砍服务端 Chrome 依赖（McpManager 里 Chrome 方法 adapter 化）
- **Phase 2** sigma-terminal 集成 chrome-devtools-mcp stdio 隧穿（云版浏览器能力）
- **Phase 3** 飞书 OAuth 登录 + 企业名单 + PluginRouter（群聊多人 plugin 路由）
- **Phase 4** Admin Dashboard 扩展（企业名单管理、在线 plugin 视图）
- **Phase 5** Docker + VPS 部署 + DNS 切换

### 已明确不做
- 浏览器在云端跑（砍掉，统一走 plugin）
- 多租户 SaaS（初期单租户，orgId 维度预留）
- Plugin 自动列出用户会话（**手工填 sessionKey** 是产品决定）

---

## 快速开始

### 1. 创建飞书应用
[飞书开放平台](https://open.feishu.cn/app) 创建企业自建应用：
- 添加"机器人"能力
- 订阅事件：`im.message.receive_v1`
- 开通权限：`im:message`、`im:message:send_as_bot`、`im:chat`
- 记下 App ID 和 App Secret

### 2. 安装配置
```bash
git clone https://github.com/GODGINO/feishu-claude-bot.git
cd feishu-claude-bot
bash scripts/setup.sh
vim .env   # 填 FEISHU_APP_ID / FEISHU_APP_SECRET / ADMIN_PASSWORD
```

### 3. 启动
```bash
npm run bot              # PM2 启动
npm run bot:status       # 查状态
```

---

## 配置

### 主要环境变量（`.env`）

| 变量 | 必填 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | 是 | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 是 | 飞书应用 App Secret |
| `ADMIN_PASSWORD` | 是 | Admin 双密码，逗号分隔（`pass1,pass2`）|
| `ANTHROPIC_API_KEY` | 是 | Claude API key（或走 Claude CLI 本身的登录）|
| `CF_TUNNEL_URL` | 否 | Cloudflare Tunnel 目标域名 |
| `CF_TUNNEL_TOKEN` | 否 | Cloudflare Tunnel Token |
| `CLAUDE_MODEL` | 否 | 默认 `sonnet`（别名：`opus`、`sonnet`、`haiku`，`opus`/`sonnet` 默认 1M 上下文）|
| `SIGMA_PROMPT_MODE` | 否 | `local`（默认）或 `server`，决定拼接哪个 env.*.md |
| `CLAUDE_PATH` | 否 | Claude CLI 路径（默认自动 which） |
| `MAX_CONCURRENT` | 否 | 最大并发 Claude 进程数，默认 `3` |
| `MAX_QUEUE_PER_SESSION` | 否 | 每 session 消息队列容量，默认 `5` |
| `PROCESS_TIMEOUT` | 否 | Claude 进程工具调用超时 (ms)，默认 `120000` |
| `EMAIL_ENCRYPTION_KEY` | 否 | 邮箱凭据加密密钥 |
| `ADMIN_PORT` | 否 | Admin Dashboard 端口，默认 `3333` |

---

## 项目结构

```
sigma/
├── src/
│   ├── index.ts                    # 本地版入口（当前运行）
│   ├── index.server.ts             # 云版入口（typecheck 用，暂不运行）
│   ├── config.ts                   # 环境变量 + 系统提示词加载
│   ├── feishu/                     # 飞书 SDK
│   │   ├── event-handler.ts        # WebSocket 事件入口
│   │   ├── message-sender.ts       # 消息/卡片发送
│   │   ├── card-builder.ts         # 卡片构建 + 自定义标签解析器
│   │   ├── card-streamer.ts        # 流式卡片 + heartbeat
│   │   ├── typing.ts               # Typing indicator
│   │   ├── im-mcp.ts               # 飞书 IM MCP 服务（暴露给 Claude）
│   │   └── feishu-tools-mcp.ts     # 飞书业务工具 MCP
│   ├── bridge/
│   │   ├── message-bridge.ts       # 核心路由 + 三渠道回显
│   │   ├── message-queue.ts        # 每 session FIFO
│   │   ├── command-handler.ts      # /help /model /effort /auto /register 等
│   │   └── group-context.ts        # 群聊上下文缓冲
│   ├── claude/
│   │   ├── process-pool.ts         # 持久进程池 (stream-json, --resume)
│   │   ├── stream-parser.ts        # 流式 JSON 解析 (含 subagent 事件)
│   │   ├── mcp-manager.ts          # MCP 配置渲染 + Chrome 管理
│   │   ├── session-manager.ts      # 会话目录 + sessionKey 生成
│   │   └── runner.ts               # 单次运行封装
│   ├── admin/
│   │   ├── server.ts               # Express + WebSocket
│   │   ├── admin-chat.ts           # Admin Chat WebSocket
│   │   └── routes.ts               # REST API
│   ├── relay/
│   │   ├── relay-server.ts         # WebSocket 桥 + HMAC 签名
│   │   ├── remote-terminal-mcp.ts  # 终端 MCP (shell/file/computer-use)
│   │   ├── remote-browser-mcp.ts   # 浏览器扩展 MCP
│   │   └── protocol.ts             # 协议类型定义
│   ├── wechat/
│   │   └── wechat-bridge.ts        # iLink Bot 长轮询
│   ├── email/                      # IMAP IDLE + SMTP
│   ├── scheduler/
│   │   ├── cron-runner.ts          # Cron 调度器（时间触发）
│   │   └── alert-runner.ts         # Alert 调度器（条件触发，sister to cron）
│   ├── alert/
│   │   └── alert-mcp.ts            # Alert MCP（list/create/delete/toggle/reset/inspect）
│   ├── members/
│   │   └── member-manager.ts       # MEMBER.md 持久档案
│   ├── utils/                      # logger, encryption 等
│   ├── local-only/                 # ★ 仅 Mac mini 版使用
│   │   └── chrome/
│   │       └── idle-checker.ts     # Chrome 空闲 30 min 自动关
│   └── server-only/                # ★ 仅云版使用（暂空）
│       └── .gitkeep
│
├── system-prompt/                  # ★ 系统提示词（2026-04 拆分后）
│   ├── common.md                   # 两版共享
│   ├── env.local.md                # 本地模式专属（目前空）
│   └── env.server.md               # 云模式专属（目前空）
│
├── sigma-terminal/                 # Electron 桌面客户端
│   ├── src/main/                   # 主进程
│   │   ├── index.ts                # Menubar tray app
│   │   ├── relay-client.ts         # WSS + HMAC 验签
│   │   ├── executor.ts             # 35 tool 分发
│   │   ├── security.ts             # 危险命令拦截
│   │   ├── computer-use/           # nut.js 键鼠屏
│   │   ├── phone-use/              # ADB
│   │   └── onboarding.ts           # macOS 权限请求
│   └── src/renderer/               # Tray popup UI（原生 HTML/JS）
│
├── browser-extension/              # Chrome MV3 扩展
│   ├── manifest.json
│   ├── service-worker.js           # WSS + HMAC 验签
│   └── content.js                  # DOM 操作 + a11y tree
│
├── web/                            # Admin Dashboard (React + Vite)
│   └── src/
│       ├── pages/                  # 页面（SessionDetail、Overview...）
│       ├── components/             # 组件
│       └── lib/api.ts              # API 客户端
│
├── skills/                         # 20+ 内置 skill
│   ├── browser/
│   ├── terminal/
│   ├── card-buttons/
│   ├── email/
│   └── ...
│
├── sessions/                       # per-session 目录（运行时生成）
│   └── {sessionKey}/
│       ├── .claude/settings.json   # URL-type MCP 配置
│       ├── mcp-servers.json        # stdio MCP 配置
│       ├── .chrome-data/           # Chrome 独立 profile（仅本地版）
│       ├── cron-jobs.json          # 该 session 的定时任务
│       ├── alerts.json             # 该 session 的 Alert 列表（条件触发）
│       ├── email-accounts.json     # 邮箱账户
│       └── ... (用户 skill/文件产物)
│
├── members/                        # 全局用户档案
│   └── {open_id}/
│       ├── MEMBER.md               # 跨 session 画像
│       └── profile.json            # 个人 MCP token 等
│
├── mcp-config.json                 # MCP 服务模板（渲染成 per-session 配置）
├── port-allocations.json           # sessionKey → Chrome port（仅本地版）
├── tsconfig.json                   # 本地版 TypeScript 配置
├── tsconfig.server.json            # 云版 TypeScript 配置
├── scripts/
│   ├── bot.sh                      # 本地版启停脚本 (PM2 + CF Tunnel)
│   └── setup.sh                    # 首次初始化
└── .bot.log                        # 运行日志（PM2 主日志）
```

---

## License

[MIT](LICENSE)
