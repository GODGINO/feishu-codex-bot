---
name: sigma-alert
description: 通过自然语言创建条件触发的 Alert（Sigma Cron 的兄弟功能）。当用户说"盯/监控/通知/有新...就告诉我/有变化就提醒"等，且**不是按时间触发**而是按**事件触发**时使用。例如"盯一下熊哥的新视频"、"jingyao@ubt.io 来邮件提醒我"、"BTC 跌破 90000 通知"、"这个 PR 有新评论告诉我"、"Downloads 文件夹有新文件提醒"。注意：定时任务（每天/每周/某时刻）走 cron，不走 alert。
---

# Sigma Alert — 自然语言创建条件触发任务

> 当用户说"盯 X / 监控 X / X 有新内容就通知我"时，加载本 skill。

---

## 决策树（先匹配类型）

| 用户说 | 走哪条 watcher 模板 |
|--------|---------------------|
| "盯 B 站 UP 主 / 视频更新" | `check_bili_uploader.sh <UID>` ⚠️ 当前 412 待修，可暂用但会自动 pause |
| "邮件提醒 / 来邮件通知" | **不要新建 watcher**——Sigma 已有 IMAP IDLE 邮件推送，用 email skill 配规则 |
| "URL 内容变化 / 页面更新" | `check_url_diff.sh <URL> [<FILTER>]` |
| "API 健康 / 端点状态" | `check_http_status.sh <URL> [<EXPECT_STATUS>]` |
| "GitHub PR 有新评论 / issue 有更新" | `check_gh_pr_comments.sh <REPO> <PR_NUM>` |
| "数字货币价格突破 / BTC 跌破" | `check_price_crypto.sh <COIN_ID> <THRESHOLD> <above\|below>` |
| "文件夹有新文件 / 下载完成提醒" | `check_dir_new.sh <DIR> [<PATTERN>]` |
| **都不匹配** | 跳到下面"思路 3：交互式生成自定义 watcher" |

> 模板路径：`.claude/skills/sigma-alert/scripts/watchers/`
> 所有模板遵循统一协议：输入环境变量 `WATERMARK_JSON`，输出 JSON 数组 `[{NEW_ID, NEW_PUBDATE, ...}]`。

---

## 创建流程（必须严格走完）

### Step 1: 识别参数

从用户消息提取关键参数。例：
- "盯熊哥" → UID = 3493270623619373（需查或问用户）
- "BTC 跌破 90000" → COIN=bitcoin, THRESHOLD=90000, DIRECTION=below
- "看看这个 PR 的评论 https://github.com/owner/repo/pull/42" → REPO=owner/repo, PR=42

参数缺失 → **不要瞎猜**，直接反问用户。

### Step 2: dry-run（**必须**，不可跳过）

构造 check_command，**先在对话里手动跑一次**：

```bash
WATERMARK_JSON='{"last_pubdate": 0, "processed_ids": []}' bash .claude/skills/sigma-alert/scripts/watchers/check_xxx.sh <参数>
```

把当前候选事件展示给用户：

```
我会用这条命令监控：bash check_url_diff.sh https://example.com/news

试跑一次，当前候选事件：
• 内容 hash: a3f8c2b1（"今日要闻：..."）
• pubdate: 1777290000

确认创建后，从最新一帧开始监控（已有的不会再触发）。
```

**dry-run 失败时**（如脚本报 ERR / exit !=0）：
- 把 stderr 给用户看
- 解释失败原因
- 给出修复建议（如"WBI 412 → 这个 watcher 类型当前坏，要不要换 RSSHub 方案"）
- **不要直接创建 alert**

### Step 3: 等用户确认（用按钮）

```markdown
<<BUTTON:确认创建 Alert|confirm_create_alert|primary>>
<<BUTTON:取消|cancel>>
```

> 不要用文字"回复'创建'"——用户可能输入歧义。一定用按钮。

### Step 4: 调 mcp__alert__create_alert

**关于自动 dry-run（重要）：** `mcp__alert__create_alert` 默认会**用 alert-runner 同款 env**（继承 bot daemon 的 PATH，即 PM2 god daemon 的 PATH）跑一次 check_command 验证脚本能用 + 自动建立 watermark baseline。

- ✅ 通过：alert 上线，返回里会写 "Dry-run 通过：N 条样例事件 + 样例标题 + watermark baseline 已建立"
- ❌ 失败：alert **不会创建**，返回 stderr/stdout 预览。常见原因：脚本依赖（yt-dlp/python 等）不在 alert-runner 的 PATH、cookie 失效。**不要急着加 `skip_dryrun=true` 跳过**——先修脚本（在脚本顶部加 `export PATH=$HOME/homebrew/bin:...:$PATH` 兜底）

如果脚本初次启动很慢（比如 selenium warm-up 几十秒）或者你**确实知道**首次跑会失败但后续会好，再传 `skip_dryrun=true`。否则一律让 dry-run 把关。

用户点确认后调：

```python
mcp__alert__create_alert(
    name="盯熊哥新视频",                 # 简短中文，方便用户认
    type="watcher",                       # 持续监听
    # 调度二选一：interval_seconds（全天每 N 秒）或 schedule（cron 表达式，可限时段/星期）
    schedule="*/10 9-23 * * *",           # 每天 9-23 点每 10 分钟（夜间不浪费 RPS）
    schedule_tz="Asia/Shanghai",          # 默认就是这个，可省
    # 或者：interval_seconds=300,         # 简单全天模式（不能限时段）
    check_command="bash .claude/skills/sigma-alert/scripts/watchers/check_bili_uploader.sh 3493270623619373",
    prompt="🎬 熊哥新视频出炉！\n标题：{{NEW_TITLE}}\n链接：{{NEW_URL}}\n发布时间：{{NEW_PUBDATE}}\n\n执行 bili-transcribe.sh 拿转写，给我 3 句话核心观点。",
    execution_mode="claude",              # claude / shell / message_only 三选一（见下方决策表）
    max_runtime_days=30,                  # 默认 30 天自动停（防遗忘）
)
```

### 调度模式选哪个？（决策树）

> **核心原则**：能用 `schedule` 就别用 `interval_seconds`。原因：cron 表达式在死时段不产生 fire，省 b 站/外部 API RPS 暴露面，也不浪费 yt-dlp 调用。

| 用户语义 | 用什么 | 例子 |
|---|---|---|
| "盯 XX，每 10 分钟" | 没说时间窗口的话先**反问**："白天就够了吗？还是夜间也要？" | — |
| "工作日 8-22 点每 30 分钟" | `schedule` | `"*/30 8-22 * * 1-5"` |
| "每天 9-23 点每 10 分钟" | `schedule` | `"*/10 9-23 * * *"` |
| "工作日早上 9 点" | `schedule` | `"0 9 * * 1-5"` |
| "每两小时" | `schedule` 或 `interval_seconds=7200` | `"0 */2 * * *"` |
| "BTC 跌破 X 通知"（24h 都要监控） | `interval_seconds` | `60` 或 `300` |
| "每天 6:00 体检报告" | 这是定时任务，**走 cron MCP 不走 alert** | — |

cron 表达式速查（5 字段：分 时 日 月 周）：
- `*/N` 每 N 个单位
- `A-B` 范围
- `A,B,C` 列表
- `*` 任意
- 周：0=周日, 1=周一, ..., 6=周六

**A 股市场场景的常用 schedule**：

| 场景 | schedule |
|---|---|
| 跟盘期间盯 UP 主 | `*/10 9-15 * * 1-5`（工作日 9-15:50 每 10 分钟）|
| 全天盯，工作日加密 | 不支持，建两个 alert 或用 `*/10 9-23 * * *` 折中 |
| A 股开盘前后摘要 | `*/15 9-15 * * 1-5` |
| 盘后 + 晚间复盘 | `*/15 15-22 * * 1-5` |

### Step 5: 告知用户已创建

```markdown
✅ Alert "盯熊哥新视频" 已创建（ID: xxx）

- **类型**：watcher（持续监听）
- **频率**：每 5 分钟检查一次
- **触发后**：执行 bili-transcribe.sh + Claude 总结
- **管理**：admin UI 的 Alerts tab 可以看状态/停用/删除
```

---

## execution_mode 选择

| 模式 | 何时用 | 成本 |
|------|--------|------|
| `message_only` | 简单提醒（"X 出新视频了"），不需要 LLM 处理 | 0 token |
| `shell` | 触发后跑另一个脚本（如自动下载、调 webhook） | ~0 |
| `claude` | 需要 LLM 分析/总结/对话式输出 | 几 K token / 次 |

**默认选 `claude`**——对话式 bot 场景下大多数 watcher 都需要总结/格式化。

---

## prompt 模板写法

- 用 `{{NEW_FIELD}}` 占位符引用 check_command 输出的字段
- 必有字段：`{{NEW_ID}}`、`{{NEW_PUBDATE}}`
- 其他字段看每个 watcher 的输出（在 sh 脚本顶部注释里）

例：
```
🔔 {{NEW_KIND}} 新评论
作者：{{NEW_AUTHOR}}
正文：{{NEW_BODY}}
链接：{{NEW_URL}}

帮我判断这条评论是否需要回复，重要程度 1-5 分。
```

---

## 思路 3：自定义 watcher（罕见场景）

如果用户的需求**不在模板列表里**，比如：
- "查我们公司内网某接口返回的 JSON 字段值"
- "监控数据库 orders 表 status='shipped' 的记录数"
- "盯一下我们自家 Slack 频道有没有新消息"

走交互式生成：

1. **询问用户**：怎么"查到"这个数据？给我具体的命令或 API
2. **跑通**：用户给的命令在对话里手动跑一次确认有数据
3. **确认输出格式**：把响应给用户看，确认怎么判断"新事件"
4. **写一次性的 sh**：现写一个 inline check_command（不必沉淀模板，可以是裸 bash）
5. **dry-run + 确认按钮 + create**

例 inline check_command:
```bash
DATA=$(curl -fsS https://internal/api/orders | jq '[.[] | select(.status=="shipped")]'); \
COUNT=$(echo "$DATA" | jq 'length'); \
LAST=$(echo "${WATERMARK_JSON:-{}}" | jq -r '.last_pubdate // 0'); \
NOW=$(date +%s); \
[ "$COUNT" -gt "$LAST" ] && echo "[{\"NEW_ID\":\"$NOW\",\"NEW_PUBDATE\":$NOW,\"NEW_COUNT\":$COUNT}]" || echo '[]'
```

---

## 不要做的事

- ❌ **不要跳过 dry-run** — 用户必须先看到候选事件才能放心确认
- ❌ **不要给 cron 类需求创建 alert**（如"每天 9 点做晨报" → 走 mcp__cron__create_cron_job）
- ❌ **不要为邮件创建 alert** — Sigma 已有专门的 IMAP IDLE 推送（email skill）
- ❌ **不要在 prompt 里嵌入硬编码值** — 用 `{{NEW_*}}` 占位符
- ❌ **不要忘记 max_runtime_days** — 长期运行 watcher 默认 30 天，防遗忘

---

## 失败 5 次自动 pause

AlertRunner 有内置保护：连续 5 次 check_command 失败（exit !=0 或 trigger 失败）会自动 disable 该 alert + 飞书发告警。用户可在 admin UI 的 Alerts tab 点 "Enable" 重新启用。
