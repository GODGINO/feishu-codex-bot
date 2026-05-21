# Sigma Claude Switcher

自动监控 Claude Code 用量，达到阈值时**全自动切换**到下一个 Max 账号。
**0 agent**：纯 Python 守护进程 + Chrome 扩展（绕开 Cloudflare Turnstile）。

---

## 工作原理

```
┌────────────────────────────────────────────────┐
│  daemon/switcher.py                            │
│                                                │
│  ├── HTTP server :17222（接受扩展轮询）        │
│  ├── 主循环（每 N 秒）：                       │
│  │     ① 下发 get_usage 给扩展                 │
│  │     ② 解析百分比                            │
│  │     ③ ≥ 阈值 → perform_switch(下一账号)     │
│  │                                             │
│  └── perform_switch():                         │
│      ├── 下发 clear_claude_cookies            │
│      ├── 下发 fill_email_and_continue          │
│      ├── IMAP 轮询 magic link（飞书企业邮箱）  │
│      ├── 下发 open_url(magic_link)             │
│      ├── pexpect 起 `claude auth login`        │
│      ├── 拦截 stdout 里的 OAuth URL            │
│      ├── 下发 open_url(oauth_url)              │
│      ├── 下发 click_authorize                  │
│      └── 等待 CLI "Login successful"           │
└────────┬───────────────────────────────────────┘
         ↑↓ HTTP 轮询 (3 秒)
┌────────────────────────────────────────────────┐
│  extension/  (Chrome MV3 扩展，装在用户日常 Chrome) │
│                                                │
│  background.js (service worker):              │
│    每 3 秒 GET /next-command                   │
│    用 chrome.tabs / chrome.scripting 执行：    │
│      • get_usage          读 settings/usage     │
│      • clear_claude_cookies 删 *.claude.ai    │
│      • fill_email_and_continue                 │
│      • open_url（可等待 URL match）            │
│      • click_authorize                         │
│      • check_login                             │
│    POST /result 回报                           │
│                                                │
│  popup.html / popup.js: 状态面板 + 手动测试    │
└────────────────────────────────────────────────┘
```

---

## 为什么用 Chrome 扩展而非 Playwright？

Claude.ai 在邮箱输入触发 **Cloudflare Turnstile**，Playwright/CDP 控制的浏览器（含 `navigator.webdriver=true` + "Chrome 受自动测试软件控制" 横幅）会被检测拦截。

Chrome 扩展运行在**用户真实 Chrome**里，没有任何自动化指纹，CF 完全无感。

---

## 目录结构

```
sigma-claude-switcher/
├── README.md                 ← 本文档
├── daemon/                   ← Python 守护进程
│   ├── switcher.py           主程序：主循环 + perform_switch + IMAP
│   ├── server.py             HTTP server (端口 17222)
│   ├── config.example.yaml   配置模板
│   ├── requirements.txt
│   ├── install.sh            一键安装到 ~/.sigma-switcher
│   └── com.sigma.switcher.plist.template   launchd 配置模板
└── extension/                ← Chrome 扩展 (MV3)
    ├── manifest.json
    ├── background.js         service worker：轮询 + 命令派发
    ├── popup.html / popup.js 状态面板
    └── icons/                16/48/128 png
```

---

## 安装

### 推荐：集成到 feishu-claude-bot（自动随 bot 启停）

```bash
# 1. 装 Python 守护进程到 ~/.sigma-switcher
cd sigma-switcher/daemon/
bash install.sh

# 2. 敏感配置写进项目根的 .env（和 FEISHU_APP_SECRET 放一起）
# 参考 .env.example 的 "Sigma Claude Switcher" 段落
vim /path/to/feishu-claude-bot/.env

# 3. 装 Chrome 扩展（步骤 2）

# 4. 启动 bot —— switcher 自动一起起
npm run bot
```

`scripts/bot.sh` 会检测 `~/.sigma-switcher/switcher.py` 是否装了 + 必要 env 变量是否齐全；都满足才拉起 switcher，否则静默跳过。

### 备用：独立 launchd 守护

```bash
cd sigma-switcher/daemon/
bash install.sh
# 配置 ~/.sigma-switcher/config.yaml（或依赖项目 .env）
launchctl load -w ~/Library/LaunchAgents/com.sigma.switcher.plist
```

启动后日志：`tail -f ~/.sigma-switcher/logs/switcher.log`

### 2. Chrome 扩展

1. 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序** → 选 `extension/` 目录
4. 点扩展图标，看到 "Python server: online" 即通

### 3. 验证

- popup 里点 **Ping Python now** → 应返回 `{ok: true, pong: ...}`
- popup 里点 **Probe Usage DOM** → 会打开 `claude.ai/settings/usage` 探 DOM
  - 如果当前账号已登录：会返回页面内含 `%` 的元素列表
  - 如果未登录：返回 `url` 含 `/login`，主循环会进入"等待"模式（不会刷屏）

---

## 配置说明

**两种来源，环境变量优先**：

| 字段 | 推荐来源 | 环境变量名 |
|---|---|---|
| 账号列表（含 email）| `.env` | `SWITCHER_ACCOUNTS`（JSON 数组） |
| IMAP 账号/密码/host | `.env` | `SWITCHER_IMAP_USER` / `_PASSWORD` / `_HOST` / `_PORT` |
| 飞书通知 webhook | `.env` | `SWITCHER_FEISHU_WEBHOOK` |
| 阈值 / 周期 / 冷却 | 随意 | `SWITCHER_THRESHOLD` / `_CHECK_INTERVAL` / `_COOLDOWN_HOURS` |
| HTTP 端口 | 随意 | `SWITCHER_HTTP_PORT`（扩展也得改）|

**敏感字段（IMAP 密码、账号邮箱、webhook）强烈建议放 `.env`**，不要进 `config.yaml`。yaml 只作为非敏感参数的默认值。

### 示例 `.env` 片段

```bash
SWITCHER_ACCOUNTS='[{"email":"a@company.com","label":"Max-A"},{"email":"b@company.com","label":"Max-B"}]'
SWITCHER_IMAP_HOST=imap.feishu.cn
SWITCHER_IMAP_USER=your-aggregator@example.com
SWITCHER_IMAP_PASSWORD=<APP_PASSWORD>
SWITCHER_FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx
# SWITCHER_THRESHOLD=90                # 默认 90
# SWITCHER_CHECK_INTERVAL=120          # 默认 120 秒
```

### 备用：`daemon/config.yaml`（非推荐）

如果坚持用 yaml：
```yaml
threshold: 90
check_interval_seconds: 120
cooldown_hours: 5
http_port: 17222
accounts:
  - email: account1@example.com
    label: Max-A
imap:
  host: imap.feishu.cn
  port: 993
  user: your-aggregator@example.com
  password: <APP_PASSWORD>
```

**注意**：`config.yaml` 已在 `.gitignore`，不会被 git 跟踪。但放密码在文件里仍有泄漏风险（误 cat 到终端、误 grep 到其他地方等）—— 还是推荐 `.env`。

### 添加账号

每个 Claude 账号的登录邮件需能投递到统一邮箱（`imap.user`）。两种方式：

1. **Claude 注册时直接用统一邮箱的 plus 别名**（如 `your-aggregator+max3@example.com`，飞书支持）
2. **新账号邮箱设转发**：From=anthropic 自动转发到统一邮箱

`fetch_magic_link` 会同时检查 `To`/`Cc`/`Bcc`，转发邮件也能识别。

---

## 切换流程详解

每次 `pct >= threshold` 触发 `perform_switch(next_email)`：

| 步骤 | 谁执行 | 做什么 |
|------|--------|--------|
| 1 | 扩展 | `clear_claude_cookies` 删 *.claude.ai / *.claude.com / *.anthropic.com 所有 cookie |
| 2 | 扩展 | 打开 `claude.ai/login` 填邮箱点 Continue |
| 3 | Python | IMAP 轮询，过滤 From=anthropic + To/Cc 含目标邮箱 + 时间戳 > 切换开始 |
| 4 | 扩展 | 访问 magic link → claude.ai 登录完成 |
| 5 | Python | `pexpect spawn 'claude auth login'`（带 `BROWSER=/usr/bin/true` 抑制系统浏览器）|
| 6 | Python | 拦截 stdout 里的 `https://claude.com/cai/oauth/authorize?...` |
| 7 | 扩展 | 打开该 OAuth URL（用同一 Chrome，已登录新账号）|
| 8 | 扩展 | 点击 `Authorize` 按钮 |
| 9 | Python | 等待 CLI 输出 "Login successful" |
| 10 | Python | 写 state.json，发飞书通知 |

---

## 轮换策略

- **顺序循环**：按 `accounts` yaml 顺序 A → B → C → A
- **冷却跳过**：上次切走的账号 5 小时内（`cooldown_hours`）跳过
- **全员冷却**：飞书告警 + 等待

```python
def pick_next(state):
    cur_idx = emails.index(state['current'])
    for step in range(1, n + 1):
        i = (cur_idx + step) % n
        if not in_cooldown(accounts[i]):
            return accounts[i]
    return None  # all in cooldown
```

---

## 常见问题

### Chrome 当前未登录 Claude 怎么办？
主循环 `parse_usage` 检测到 URL 含 `/login` 会返回 `NOT_LOGGED_IN`，发飞书告警一次，然后**进入 5 分钟等待模式不再重复刷新页面**。需手动登录任一账号一次（无论哪个），主循环就会恢复正常。

### `claude auth login` 会不会打开系统浏览器？
会，但我们设了 `BROWSER=/usr/bin/true`，CLI 的 `open <url>` 调用变空操作，不影响。回调通过我们 Playwright 已登录的 Chrome 完成。

### 端口 17222 冲突怎么办？
改 `config.yaml` 的 `http_port` 和扩展 `manifest.json` `host_permissions` 里的 17222 即可。Sigma 自身的隔离 Chrome 用 9350，不会撞。

### 切换被 Claude 风控怎么办？
- 增加 `cooldown_hours`
- 减少切换频率（提高 `threshold`）
- 看是否同一 IP 切太多账号

---

## 调试

| 任务 | 命令 |
|------|------|
| 看主循环日志 | `tail -f ~/.sigma-switcher/logs/switcher.log` |
| 看扩展日志 | Chrome → `chrome://extensions` → 找 Sigma → "Service Worker" 点开 |
| 手动 ping | `curl -X POST http://127.0.0.1:17222/enqueue -H 'Content-Type: application/json' -d '{"type":"ping","wait":5}'` |
| 手动测 usage | `curl -X POST http://127.0.0.1:17222/enqueue -H 'Content-Type: application/json' -d '{"type":"get_usage","wait":25}'` |
| 重启 daemon | `launchctl unload -w ~/Library/.../com.sigma.switcher.plist && launchctl load -w ...` |
| 手动停 | `pkill -f switcher.py` |

---

## 安全注意

- **IMAP 密码**用专用密码（App Password），别用主密码
- HTTP server 只监听 `127.0.0.1`，外网访问不到
- 扩展只声明了 claude.ai / claude.com / anthropic.com / 127.0.0.1:17222 的 host_permissions
- 凭证 `~/.claude/.credentials.json` 由 `claude auth login` 自己管理，我们不直接动

---

## 已知未完成 / TODO

1. **`get_usage` 的 selector 没最终定**：脚本目前是"找页面里所有含 `%` 的纯文本元素，取最大合理值"的兜底逻辑。Claude 改版后可能不准。建议在 `daemon/switcher.py` 里 `parse_usage` 加上具体的 `data-testid` 或 class selector。
2. **OAuth Authorize 按钮未实测**：`background.js` 里搜 `button` 文本 `Authorize`。Claude 如果改成图标按钮或非英文需调整。
3. **`get_usage` 触发的副作用**：在测试中发现 navigate 到 `settings/usage` 可能影响 session（重定向到 login 后 SPA state 异常）。建议加 `check_login` 前置判断，未登录直接早退而不是导航到 settings 页。
4. **登录态健康检查**：可加一个独立的 `health_check` 命令，每 N 分钟用 `chrome.cookies.get` 直接确认有效性，不依赖打开页面。
5. **launchd KeepAlive 行为**：当前配置出错会重启。pexpect 卡死可能死循环。建议加超时 + exit code 检查。
6. **多机部署**：当前假设单机单 Chrome。如要扩展到多机，需要把 IMAP 用户独立配置 + state file 锁。

---

## 文件清单

```
daemon/
  switcher.py                      8.6 KB   主守护进程
  server.py                        4.3 KB   HTTP server
  config.example.yaml              570 B    配置模板
  requirements.txt                 65 B
  install.sh                       1.2 KB   一键安装
  com.sigma.switcher.plist.template 1.2 KB   launchd 模板

extension/
  manifest.json                    810 B    MV3 manifest
  background.js                    7.5 KB   service worker
  popup.html                       1.1 KB   状态面板 HTML
  popup.js                         1.4 KB   状态面板逻辑
  icons/icon{16,48,128}.png        ~450 B   占位图标
```

---

## 联系

葛增辉 / Sigma 团队
