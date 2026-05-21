---
name: feishu-task
description: |
  飞书任务管理工具,用于创建、查询、更新任务和清单。

  **当以下情况时使用此 Skill**:
  (1) 需要创建、查询、更新、删除任务
  (2) 需要创建、管理任务清单
  (3) 需要查看任务列表或清单内的任务
  (4) 用户提到"任务"、"待办"、"to-do"、"清单"、"task"
  (5) 需要设置任务负责人、关注人、截止时间
---

# 飞书任务管理

## 前提条件

用户需已绑定 Feishu MCP URL。如未绑定，请引导用户参考 feishu-mcp-bind skill 完成绑定。

## MCP 工具名

工具名取决于会话类型：
- **私聊（DM）**：`mcp__feishu__task_*`
- **群聊**：`mcp__feishu_ou_<user_open_id>__task_*`（使用当前发送者对应的 MCP）

主要工具：
- `feishu_task_task` — 任务 CRUD
- `feishu_task_tasklist` — 清单管理

---

## 🚨 执行前必读

- ✅ **时间格式**：ISO 8601 / RFC 3339（带时区），例如 `2026-02-28T17:00:00+08:00`
- ✅ **current_user_id 强烈建议**：从消息上下文的 SenderId 获取（ou_...），工具会自动添加为 follower
- ✅ **patch/get 必须**：task_guid
- ✅ **tasklist.tasks 必须**：tasklist_guid
- ✅ **完成任务**：completed_at = "2026-02-26 15:00:00"
- ✅ **反完成（恢复未完成）**：completed_at = "0"

---

## 📋 快速索引

| 用户意图 | 工具 | action | 必填参数 | 强烈建议 |
|---------|------|--------|---------|---------|
| 新建待办 | feishu_task_task | create | summary | current_user_id |
| 查未完成任务 | feishu_task_task | list | - | completed=false |
| 获取任务详情 | feishu_task_task | get | task_guid | - |
| 完成任务 | feishu_task_task | patch | task_guid, completed_at | - |
| 反完成任务 | feishu_task_task | patch | task_guid, completed_at="0" | - |
| 改截止时间 | feishu_task_task | patch | task_guid, due | - |
| 创建清单 | feishu_task_tasklist | create | name | - |
| 查看清单任务 | feishu_task_tasklist | tasks | tasklist_guid | - |

---

## 🎯 核心约束

### 1. 用户身份调用

工具使用 `user_access_token`（用户身份），意味着：
- ✅ 可以指定任意成员
- ⚠️ 只能查看和编辑自己是成员的任务
- ⚠️ 创建时没把自己加入成员，后续无法编辑

**推荐**：创建任务时始终传 `current_user_id`，工具会自动添加为 follower。

### 2. 任务成员角色

```json
{
  "members": [
    {"id": "ou_xxx", "role": "assignee"},
    {"id": "ou_yyy", "role": "follower"}
  ]
}
```

- **assignee（负责人）**：负责完成任务，可编辑
- **follower（关注人）**：接收通知

### 3. completed_at 用法

- **完成**：`"completed_at": "2026-02-26 15:30:00"`
- **反完成**：`"completed_at": "0"`

---

## 📌 使用场景示例

### 场景 1: 创建任务并分配

```json
{
  "action": "create",
  "summary": "准备周会材料",
  "description": "整理本周工作进展和下周计划",
  "current_user_id": "ou_发送者的open_id",
  "due": {
    "timestamp": "2026-02-28 17:00:00",
    "is_all_day": false
  },
  "members": [
    {"id": "ou_协作者的open_id", "role": "assignee"}
  ]
}
```

### 场景 2: 查询未完成任务

```json
{
  "action": "list",
  "completed": false,
  "page_size": 20
}
```

### 场景 3: 完成任务

```json
{
  "action": "patch",
  "task_guid": "任务的guid",
  "completed_at": "2026-02-26 15:30:00"
}
```

### 场景 4: 创建清单

```json
{
  "action": "create",
  "name": "产品迭代 v2.0",
  "members": [
    {"id": "ou_xxx", "role": "editor"}
  ]
}
```

### 场景 5: 重复任务

```json
{
  "action": "create",
  "summary": "每周例会",
  "due": {"timestamp": "2026-03-03 14:00:00", "is_all_day": false},
  "repeat_rule": "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO"
}
```

---

## 🔍 常见错误与排查

| 错误现象 | 根本原因 | 解决方案 |
|---------|---------|---------|
| 创建后无法编辑 | 未将自己加入 members | 传 current_user_id |
| patch 失败 | 未传 task_guid | patch/get 必须传 task_guid |
| 反完成失败 | completed_at 格式错误 | 使用 `"0"` 字符串 |
| 时间不对 | 使用了 Unix 时间戳 | 改用 ISO 8601 格式 |
