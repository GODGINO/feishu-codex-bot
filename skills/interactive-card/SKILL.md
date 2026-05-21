---
name: interactive-card
description: >
  卡片交互能力（按钮 / 下拉选择器 / 复选框 / 卡标题 / 浮层 toast / 内嵌图片）。在流式卡片回复中
  追加可点击按钮、表单字段、待办清单、彩色标题、提交后浮层、inline 图片等元素，用于操作确认、链接
  入口、单选/多选、多字段配置、多项 ☑/☐ 清单、回复主题标题、提交成功提示、内嵌截图/图表等场景。
  当回复需要用户做选择/确认/填表/勾选多项、需要给回复加标题、需要在提交后弹浮层、或需要在卡片里嵌图
  时自动使用。关键词：按钮、下拉、选择器、复选框、checkbox、待办、清单、checklist、标题、title、
  吐司、toast、浮层、提示、图片、image、IMG、截图、嵌图、screenshot。
---

# 卡片交互（Interactive Card v7）

回复末尾可以追加交互元素让用户在卡片内直接操作。提供三种工具，分两类：

| 类别 | 工具 | 触发标签 | 适用场景 |
|------|------|---------|---------|
| **立即触发**（点完即生效）| **BUTTON** | `<<BUTTON:...>>` × N | 单维度决策、立即触发的单步操作 |
| **统一提交**（点"提交"才回调）| **SELECT / MSELECT / CHECK**（可混用） | `<<SELECT:...>>` / `<<MSELECT:...>>` / `<<CHECK:...>>` | ≥2 个独立问题、多字段表单、多项 ☑/☐ 清单 |

**核心规则**：BUTTON 和 form 字段（SELECT / MSELECT / CHECK）**互斥**——一个回复要么走立即触发、要么走统一提交。SELECT / MSELECT / CHECK 之间可自由混合，组成同一 form，共用一个"提交"按钮。

---

## 模式 A：BUTTON

### 语法

```
<<BUTTON:显示文案|操作标识|样式?>>
```

- **显示文案**：按钮上显示的文字（2-6 字）
- **操作标识**：
  - 普通字符串 → 点击后下一 turn 收到 `[<用户名> 点击了按钮: 显示文案]`
  - `http(s)://...` → 直接在浏览器打开链接，不通知你，文案自动加 🔗 前缀
  - `/foo` 斜杠开头 → 路由到 slash 命令处理器（等同用户输入）
- **样式**（可选）：`primary`（蓝）、`danger`（红），默认灰色

点击行为：点击瞬间**所有按钮都禁用**，被点的按钮文字自动加 `@<用户名>` + 变 primary 高亮。

### 适用场景（核心：1 件事 / 单维度决策）

#### 1. 是/否 二元、操作确认

```
代码修改完成，所有测试通过。
<<BUTTON:推送代码|push|primary>>
<<BUTTON:撤销修改|revert|danger>>
```

#### 2. 程度 / 等级 / 优先级

```
这个 bug 你看：
<<BUTTON:P0 立即|p0|danger>>
<<BUTTON:P1 本周|p1|primary>>
<<BUTTON:P2 排期|p2>>
```

#### 3. N 选 1 方案（互斥执行路径）

```
有两种实现：
- 方案 A：REST API，简单但慢
- 方案 B：WebSocket，复杂但实时
<<BUTTON:选 A|plan_a|primary>>
<<BUTTON:选 B|plan_b|primary>>
```

#### 4. 链接入口

```
页面已部署完成！
<<BUTTON:查看页面|https://example.com/preview|primary>>
<<BUTTON:打开文档|https://docs.example.com|primary>>
```

### BUTTON 严禁清单

每个按钮必须是一个**可直接执行的具体指令**。

禁止：
- `OK` / `好的` / `收到` / `确认` —— 纯确认无动作
- `可以用` / `没问题` / `满意` —— 态度表达，不是指令
- `还要改` / `不满意` —— 模糊，不知道改什么
- `继续` / `下一步` —— 没指定继续做什么
- `了解` / `明白了` —— 无后续操作

允许：
- `推送代码` / `部署到生产` —— 具体动作
- `提高分辨率到 600 DPI` —— 明确参数
- `生成移动端版本` —— 新明确任务
- `发送给 @Amanda` —— 指定接收人

---

## 模式 B：SELECT / MSELECT（多字段表单）

⚠️ **触发门槛：必须 ≥2 个字段才合理**。单一选项决策应该用 BUTTON。

### 语法

```
<<SELECT:placeholder|name|key1=文案1|key2=文案2|...>>      （单选下拉）
<<MSELECT:placeholder|name|key1=文案1|key2=文案2|...>>     （多选下拉）
```

- **placeholder**：下拉占位文字（如"选择周期"），同时也是提交后显示的字段名
- **name**：内部字段名，用于回调（如 `cycle`、`time`、`sectors`）
- **key=文案**：每个选项的内部键 + 用户看到的文案。可写 `daily=每天`、也可写 `daily`

行为流程：
1. 用户看到 N 个独立下拉（SELECT + MSELECT）+ 一个"提交"按钮
2. 全部选完点提交 → 提交按钮高亮 + 文案变 `✓ 已提交 @<用户名>` 且 disabled
3. 所有字段收敛为只读 markdown 行：`**<placeholder>**：✓ 选中 · 备选 · 备选`（多选用 `✓` 标记勾选项 + `·` 分隔，**所有备选都展示用于溯源**）
4. 下一 turn 收到 `[<用户名> 选择了: name1=label1 / name2=labelA,labelB]`（多选值用逗号分隔）

### 适用场景（核心：≥2 个独立维度配置）

#### 1. 创建 cron 任务

```
建定时任务，请配置三个维度：
<<SELECT:周期|cycle|daily=每天|weekly=每周|monthly=每月>>
<<SELECT:时间|time|morning=早 8:00|noon=中午 12:00|evening=晚 8:00>>
<<SELECT:任务类型|kind|brief=简报|digest=摘要|alert=监控>>
```

#### 2. 需求设计 / 技术选型

```
新模块的技术选型：
<<SELECT:框架|framework|react=React|vue=Vue|svelte=Svelte>>
<<SELECT:ORM|orm|prisma=Prisma|drizzle=Drizzle|typeorm=TypeORM>>
<<SELECT:是否 SSR|ssr|y=是|n=否>>
```

#### 3. 部署配置

```
准备发布，请配置：
<<SELECT:环境|env|dev=开发|staging=预发|prod=生产>>
<<SELECT:区域|region|cn=中国|us=美国|eu=欧洲>>
<<MSELECT:通知人|notifiers|alice=Alice|bob=Bob|carol=Carol>>
```

#### 4. 订阅多个板块（MSELECT 多选）

```
请勾选要订阅的板块：
<<MSELECT:订阅板块|sectors|tech=科技|finance=金融|energy=能源|consumer=消费|healthcare=医药>>
<<SELECT:推送频率|freq|daily=每天|weekly=每周>>
```

### SELECT / MSELECT 严禁

禁止：
- 单一维度强用 SELECT —— 1 个字段的 select 应该用 BUTTON
- 选项超过 7 个 —— 改用文字输入
- 把 cron 表达式、文件路径塞进下拉 —— 让用户输入
- MSELECT 用在"只能选一个"的场景 —— 选 SELECT

---

## 模式 C：CHECK（多项 ☑/☐ 清单）

⚠️ **触发门槛：必须 ≥2 个 CHECK 才合理**。单一布尔问题（"是否部署？"）应该用 BUTTON。

CHECK 是"多项独立任务 / 清单 / 巡检项"的勾选式呈现，**和 SELECT / MSELECT 同属一个 form**，等用户点"提交"按钮统一回调。

### 语法

```
<<CHECK:name|✓?|文案|style?>>
```

- **name**：唯一字段名（同 form 内所有字段不重复）
- **✓?**：可选，初始勾选状态。`✓`、`✔`、`☑`、`1`、`true`、`yes`、`y`、`checked`、`on` 任一表示初始勾选；省略 / 其他值 → 初始未勾
- **文案**：用户看到的任务描述
- **style?**：可选，决定勾选后的视觉效果

| style | 勾选后效果 | 何时用 |
|---|---|---|
| 省略（默认）| 啥都不变 | 普通选择、偏好勾选、订阅项 — 大多数场景 |
| `strike` | 仅删除线 | 标记"已删除 / 已取消" |
| `dim` | 仅变淡（透明度 0.6）| 标记"已读 / 已处理"但保留可读性 |
| `done` | 删除线 + 变淡 | 经典"已完成 todo"语义 — 待办勾掉划线 |

简化语法（2-arg form，默认未勾、无样式）：

```
<<CHECK:name|文案>>
```

行为流程：
1. 用户看到 N 个独立的 ☑/☐ 复选框（同 form 内可与 SELECT / MSELECT 共存）+ 一个"提交"按钮
2. 用户勾选 / 取消勾选（操作只在本地生效，**不立即回调**）
3. 点"提交" → 提交按钮变 `✓ 已提交 @<用户名>` + disabled，所有 CHECK 收敛为只读 `☑ 文案` 或 `☐ 文案`
4. 下一 turn 收到：
   ```
   [<用户名> 选择了:
     ☑ 任务1文案
     ☐ 任务2文案
     ☑ 任务3文案
     其他字段=值]
   ```

### 适用场景（核心：≥2 项独立 boolean，按场景选 style）

#### 1. 今日待办 / 任务清单 → 用 `done` 样式（划线 + 淡化）

```
请勾选今日要做的事：

<<CHECK:t1|✓|完成代码审查|done>>
<<CHECK:t2||写测试用例|done>>
<<CHECK:t3|✓|部署 staging|done>>
<<CHECK:t4||更新文档|done>>
<<CHECK:t5||触发 CI|done>>
```

#### 2. PR review checklist → `done`

```
PR review 项：

<<CHECK:c1||单元测试已加|done>>
<<CHECK:c2||文档同步更新|done>>
<<CHECK:c3||向后兼容验证|done>>
<<CHECK:c4||性能未退化|done>>
```

#### 3. 巡检 / 验收 → `done`

```
本次发布前请确认：

<<CHECK:s1|✓|数据库备份完成|done>>
<<CHECK:s2|✓|回滚脚本就绪|done>>
<<CHECK:s3||灰度名单已通知|done>>
<<CHECK:s4||监控告警阈值就位|done>>
```

#### 4. 偏好 / 选项勾选 → 省略 style（保持文字清晰）

```
请勾选口味偏好：

<<CHECK:spicy|✓|要辣>>
<<CHECK:sweet||要甜>>
<<CHECK:sour||要酸>>
<<CHECK:salty|✓|要咸>>
```

#### 5. 已读 / 已处理标记 → `dim`

```
本周通知（已读的会变淡）：

<<CHECK:n1|✓|发布会预告|dim>>
<<CHECK:n2||PR review 提醒|dim>>
<<CHECK:n3||CI 失败 alert|dim>>
```

#### 6. 清单 + 字段混用（核心优势）

```
今日早会快速勾选 + 设置优先级：

<<CHECK:done_local||跑通本地|done>>
<<CHECK:reviewed|✓|PR 评审完毕|done>>
<<CHECK:deployed||部署到 staging|done>>

<<SELECT:今日优先级|prio|h=高|m=中|l=低>>
<<MSELECT:关注板块|sec|tech=科技|finance=金融>>
```

回调：
```
[葛增辉 选择了:
  ☐ 跑通本地
  ☑ PR 评审完毕
  ☐ 部署到 staging
  prio=高 / sec=科技,金融]
```

### TOAST：提交后弹浮层通知（可选）

`<<TOAST:type|content>>` 放在卡片任意位置，纯配置不渲染。用户点"提交"按钮后飞书会弹出一个浮层。

- **type**：`info`（蓝）/ `success`（绿）/ `warning`（黄）/ `error`（红）
- **content**：浮层文字（≤20 字最佳）
- **不写 TOAST 时**：form 提交自动兜底 `success "✓ 已提交"`；BUTTON 点击不弹 toast

**用法**：

```
<<TOAST:warning|开始部署，30 秒内可撤销>>
<<TOAST:info|已收到，预计 5 分钟>>
<<TOAST:error|字段缺失，请重选>>
<<TOAST:success|✓ 已记录到日历>>
```

**何时写 TOAST**：
- 部署/重启/删除等危险操作 → `warning`
- 长耗时后台任务 → `info`（让用户知道不是卡了）
- 普通选择/订阅 → **不写**（兜底已足够）

### CHECK 严禁

禁止：
- **只有 1 个 CHECK** —— 单一布尔问题是"是/否"，应该用 BUTTON
- **CHECK 和 BUTTON 同一回复**（系统会强制丢 CHECK，互斥规则）
- CHECK `name` 重复（同 form 内字段名唯一）
- 把清单塞进 MSELECT 下拉（要点开才能勾，不够直接）—— 清单用 CHECK 平铺
- CHECK 文案过长（> 30 字）—— 拆开

---

## 决策表：BUTTON / SELECT-MSELECT / CHECK 选哪个？

**判断公式：你这一轮要问用户几件事？什么形态？**

| 情况 | 用什么 |
|------|--------|
| **1 件事**，yes / no | BUTTON × 2 |
| **1 件事**，3-5 个方案 N 选 1 | BUTTON × N |
| **1 件事**，程度/等级 | BUTTON × N |
| **1 件事**，URL 入口 | BUTTON（URL 形式） |
| **2+ 件事**，每件是"在选项里挑 1 个" | SELECT × N |
| **2+ 件事**，每件是"在选项里挑多个" | MSELECT × N |
| **2+ 件事**，混合单选+多选 | SELECT + MSELECT |
| **2+ 件事**，每件是"做 / 不做"（boolean） | CHECK × N |
| **2+ 件事**，清单 + 字段配置混合 | CHECK + SELECT / MSELECT |
| 1 件事 boolean | BUTTON（"是/否"），**不要单 CHECK** |
| 1 件事但选项 7+ 个 | 让用户文字输入 |
| 没有有意义的后续 | 都不要 |

**判别原则**：
- "用户点完立即触发一个动作" → BUTTON
- "用户先选好几个字段再统一提交" → SELECT / MSELECT
- "用户勾掉一份清单再统一提交" → CHECK
- "清单 + 字段一起收齐" → CHECK + SELECT / MSELECT 混用同一 form

---

## 互斥规则（再次强调）

| | BUTTON | SELECT | MSELECT | CHECK |
|---|---|---|---|---|
| BUTTON | — | ❌ 互斥 | ❌ 互斥 | ❌ 互斥 |
| SELECT | ❌ | — | ✅ 混用 | ✅ 混用 |
| MSELECT | ❌ | ✅ 混用 | — | ✅ 混用 |
| CHECK | ❌ | ✅ 混用 | ✅ 混用 | — |

```
<<BUTTON:foo|a>> + <<SELECT:bar|b|x=X>>             ❌ 系统会丢弃 SELECT
<<BUTTON:foo|a>> + <<MSELECT:bar|b|x=X>>            ❌ 系统会丢弃 MSELECT
<<BUTTON:foo|a>> + <<CHECK:c|文案>>                 ❌ 系统会丢弃 CHECK
<<BUTTON:foo|a>> + <<BUTTON:bar|b>>                 ✅ 多按钮可以
<<SELECT:foo|a|x=X>> + <<SELECT:bar|b|y=Y>>         ✅ 多下拉可以
<<MSELECT:foo|a|x=X>> + <<MSELECT:bar|b|y=Y>>       ✅ 多个多选可以
<<SELECT:foo|a|x=X>> + <<MSELECT:bar|b|y=Y>>        ✅ 混合 SELECT + MSELECT
<<CHECK:a|文案A>> + <<CHECK:b|文案B>>               ✅ 多个 CHECK 同 form
<<CHECK:a|文案>> + <<SELECT:p|prio|h=高|m=中>>       ✅ CHECK + SELECT 混用
<<CHECK:a|文案>> + <<MSELECT:s|sec|t=科技|f=金融>>   ✅ CHECK + MSELECT 混用
```

如果业务上确实需要 BUTTON + form 字段混合（罕见），就拆成两个回复：先发表单收集字段，根据用户选择再发按钮确认。

---

## 反面教材

❌ **错（拆 5 轮 BUTTON）**：每个待办给一个 BUTTON 让用户连续点 5 次。
✅ **对**：5 个 CHECK + 1 个共享"提交"按钮。

❌ **错（单一 CHECK）**：`<<CHECK:deploy||部署到 prod>>` —— 单个布尔等同"是/否"。
✅ **对**：`<<BUTTON:部署|deploy|primary>> <<BUTTON:取消|cancel>>`

❌ **错（清单塞进 MSELECT）**：用户要点开下拉才能勾选每项。
✅ **对**：CHECK 行内直接展示，鼠标点旁边方框即可。

❌ **错（拆 3 轮 SELECT）**：先问周期 → 再问时间 → 再问内容。用户烦死。
✅ **对**：3 个 SELECT 字段同屏一次提交。

❌ **错（单维度强用 SELECT）**：问"是否部署？"用下拉。
✅ **对**：用 BUTTON 部署/取消。

❌ **错（混 BUTTON 和 CHECK）**：BUTTON 立即触发 + CHECK 等提交 → 用户不知道点哪个先。
✅ **对**：纯 CHECK 走 form 提交 / 纯 BUTTON 立即点击，二选一。

---

## 卡片标题（TITLE）

回复**最前面**写 `<<TITLE:标题|颜色?>>` 给消息加一个彩色 header。这不是交互元素而是回复格式，但和卡片渲染强绑定——**不写 TITLE 的纯文字短回复不会走流式卡片**。

### 语法

```
<<TITLE:标题文字|颜色?>>
```

- **标题文字**：≤10 字，概括主题
- **颜色**（可选）：决定 header 背景色

### 支持颜色

| 颜色 | 视觉 | 典型场景 |
|---|---|---|
| `blue`（默认） | 蓝 | 信息 / 成功 / 完成 |
| `green` | 绿 | 上涨 / 增长 / 积极行情 |
| `red` | 红 | 失败 / 紧急 / 下跌 |
| `orange` | 橙 | 警告 |
| `yellow` | 黄 | 提醒 / 亮点 |
| `wathet` | 浅蓝 | 次级信息 / 数据播报 |
| `turquoise` | 青 | 进展中 |
| `carmine` | 深红 | 严重警告 |
| `violet` / `purple` / `indigo` | 紫系 | 特殊场景 |
| `grey` | 灰 | 中立 / 不活跃 |

### 何时写 TITLE

- 回复含 **markdown** 格式（表格、列表、代码块、加粗、链接、分隔线）→ **必须**写 TITLE，否则不会走流式卡片
- 纯文字短回复（打招呼、一两句话）→ **不写**

### 示例

```
<<TITLE:部署完成>>
<<TITLE:沪指 -1.5%|orange>>
<<TITLE:✅ 提交成功|green>>
<<TITLE:🚨 紧急告警|carmine>>
```

标题里**可以**自带 emoji（✅ ❌ ⚠️ 💡 🔄 🚨 ✨ 📊 等），系统不会自动追加任何 emoji。

---

## 卡片内嵌图片（IMG）

三种方式让图片 inline 嵌入正文，按出现位置渲染：

### 方式 1：`<<IMG:url|alt?>>` 显式标签

```
<<IMG:https://picsum.photos/600/400|示例图>>
<<IMG:/tmp/chart.png|当日 K 线>>
<<IMG:/Users/gezenghui/feishu-claude-bot/sessions/<key>/shared/screenshot.png>>
```

- **url**：https 链接（自动下载并上传飞书）或本地绝对路径
- **alt**（可选）：图片描述

### 方式 2：Markdown 图片语法 `![alt](path)`

```
![截图](/Users/.../sessions/<key>/shared/screenshot_1.png)
![](/tmp/chart.png)
```

- 等价于 `<<IMG:path|alt>>`（仅当 path 在本地白名单时生效）
- URL 形式 `![pic](https://example.com/x.png)` **保留**为 markdown 链接，不被强行升级

### 方式 3：直接写裸路径（最自然、最推荐）

回复正文里直接写本地绝对路径，sigma 自动识别 + 升级为 inline 图片，**无需任何标签包装**：

```
处理完成。
原图：/Users/.../sessions/<key>/shared/before.png
压缩后：/Users/.../sessions/<key>/shared/after.png
```

→ 渲染时两个路径自动替换为内嵌图片，位置不变。

**升级条件（满足全部）**：
- 路径在白名单前缀下：`{sessionDir}/...` / `{projectRoot}/...` / `/tmp/...`
- 扩展名：`.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.bmp`（大小写不敏感）
- **不在 \`\`\` 代码围栏内**（避免误吞 shell 命令里的路径）

**不升级**：
- 远程 URL（`https://...png`）— 用 `<<IMG:>>` 显式包
- `.pdf` / `.svg` / `.xlsx` 等非光栅文件 — 走文件发送（飞书附件）
- 非白名单前缀路径（`/etc/...` 等）

### 共同行为

- **inline 位置**：按出现位置切片，不聚到尾部
- **上传失败**：优雅退化为 `_[图片: <url>]_` 占位
- **同 URL 重复**：缓存去重（只上传一次）
- **图片不属于 form 字段**：与 BUTTON / SELECT / MSELECT / CHECK / TOAST 完全独立，**任意范式都可用**

### 反面教材

❌ **错**：在代码块里贴路径希望被渲染（被 ``` 包住的路径不升级）
✅ **对**：路径放在正文段落里

❌ **错**：用 `<<IMG:>>` 包远程 SVG / PDF（飞书 image API 不支持矢量/PDF）
✅ **对**：SVG/PDF 走文件发送，让用户下载查看
