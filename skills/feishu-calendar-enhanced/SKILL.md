---
name: feishu-calendar-enhanced
description: |
  飞书日历与日程管理工具集（增强版）。包含日历管理、日程管理、参会人管理、忙闲查询。

  **当以下情况时使用此 Skill**:
  (1) 需要创建、查询、修改日程/会议
  (2) 需要查看忙闲时间
  (3) 需要管理参会人
  (4) 用户提到"日历"、"日程"、"会议"、"忙闲"、"calendar"
---

# 飞书日历管理

## 前提条件

用户需已绑定 Feishu MCP URL。如未绑定，请引导用户参考 feishu-mcp-bind skill 完成绑定。

## MCP 工具名

工具名取决于会话类型：
- **私聊（DM）**：`mcp__feishu__calendar_*`
- **群聊**：`mcp__feishu_ou_<user_open_id>__calendar_*`

主要工具：
- `feishu_calendar_event` — 日程 CRUD
- `feishu_calendar_freebusy` — 忙闲查询
- `feishu_calendar_event_attendee` — 参会人管理

---

## 🚨 执行前必读

- ✅ **时区固定**：Asia/Shanghai（UTC+8）
- ✅ **时间格式**：ISO 8601 / RFC 3339（带时区），例如 `2026-02-25T14:00:00+08:00`
- ✅ **create 最小必填**：summary, start_time, end_time
- ✅ **user_open_id 强烈建议**：从 SenderId 获取（ou_xxx），确保用户能看到日程
- ✅ **ID 格式约定**：用户 `ou_...`，群 `oc_...`，会议室 `omm_...`

---

## 📋 快速索引

| 用户意图 | 工具 | action | 必填参数 | 强烈建议 |
|---------|------|--------|---------|---------|
| 创建会议 | feishu_calendar_event | create | summary, start_time, end_time | user_open_id |
| 查某时段日程 | feishu_calendar_event | list | start_time, end_time | - |
| 改日程时间 | feishu_calendar_event | patch | event_id, start_time/end_time | - |
| 搜关键词找会 | feishu_calendar_event | search | query | - |
| 回复邀请 | feishu_calendar_event | reply | event_id, rsvp_status | - |
| 查忙闲 | feishu_calendar_freebusy | list | time_min, time_max, user_ids[] | - |
| 邀请参会人 | feishu_calendar_event_attendee | create | calendar_id, event_id, attendees[] | - |

---

## 🎯 核心约束

### 1. user_open_id 为什么必填？

将发起人添加为**参会人**，确保：
- ✅ 收到日程通知
- ✅ 可以回复 RSVP 状态
- ✅ 出现在参会人列表中

### 2. 参会人类型

- `type: "user"` + `id: "ou_xxx"` — 飞书用户
- `type: "chat"` + `id: "oc_xxx"` — 飞书群组
- `type: "resource"` + `id: "omm_xxx"` — 会议室
- `type: "third_party"` + `id: "email@example.com"` — 外部邮箱

### 3. 会议室预约是异步流程

添加会议室后进入异步预约：
1. API 返回 `rsvp_status: "needs_action"`
2. 后台异步处理
3. 最终：`accept` 或 `decline`

### 4. instances 仅对重复日程有效

先用 `get` 检查是否有 `recurrence` 字段。

---

## 📌 使用场景示例

### 创建会议

```json
{
  "action": "create",
  "summary": "项目复盘会议",
  "description": "讨论 Q1 项目进展",
  "start_time": "2026-02-25 14:00:00",
  "end_time": "2026-02-25 15:30:00",
  "user_open_id": "ou_aaa",
  "attendees": [
    {"type": "user", "id": "ou_bbb"},
    {"type": "resource", "id": "omm_xxx"}
  ]
}
```

### 查询日程

```json
{
  "action": "list",
  "start_time": "2026-02-25 00:00:00",
  "end_time": "2026-03-03 23:59:00"
}
```

### 查忙闲

```json
{
  "action": "list",
  "time_min": "2026-02-25 09:00:00",
  "time_max": "2026-02-25 18:00:00",
  "user_ids": ["ou_aaa", "ou_bbb", "ou_ccc"]
}
```

### 回复邀请

```json
{
  "action": "reply",
  "event_id": "xxx_0",
  "rsvp_status": "accept"
}
```

---

## 🔍 常见错误

| 错误现象 | 解决方案 |
|---------|---------|
| 发起人不在参会人列表 | 传 `user_open_id = SenderId` |
| 时间不对 | 改用 ISO 8601 格式 |
| 会议室显示"预约中" | 等待几秒后查询 `rsvp_status` |
| 修改日程权限错误 | 确保日程设置了 `can_modify_event` |

---

## 📚 附录

### 回复状态（rsvp_status）

| 状态 | 用户含义 | 会议室含义 |
|------|---------|-----------|
| `needs_action` | 未回复 | 预约中 |
| `accept` | 已接受 | 预约成功 |
| `tentative` | 待定 | - |
| `decline` | 拒绝 | 预约失败 |

### 使用限制

- 每个日程最多 3000 名参会人
- 单次添加用户参会人上限 1000 人
- 单次添加会议室上限 100 个
- 主日历不可删除
