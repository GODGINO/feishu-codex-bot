---
name: feishu-im-read
description: |
  飞书 IM 消息读取工具使用指南，覆盖会话消息获取、话题回复读取、跨会话消息搜索、图片/文件资源下载。

  **当以下情况时使用此 Skill**:
  (1) 需要获取群聊或单聊的历史消息
  (2) 需要读取话题（thread）内的回复消息
  (3) 需要跨会话搜索消息
  (4) 消息中包含图片、文件，需要下载
  (5) 用户提到"聊天记录"、"消息"、"群里说了什么"、"话题回复"
---

# 飞书 IM 消息读取

## 前提条件

用户需已绑定 Feishu MCP URL。如未绑定，请引导用户参考 feishu-mcp-bind skill 完成绑定。

也可使用 Bot 级 IM 工具（`mcp__feishu-im__*`），无需用户绑定 MCP，但只能读取 bot 所在的会话。

## MCP 工具名

**用户级工具**（通过用户 Feishu MCP）：
- **私聊（DM）**：`mcp__feishu__im_user_*`
- **群聊**：`mcp__feishu_ou_<user_open_id>__im_user_*`

**Bot 级工具**（通过 feishu-im 共享 MCP）：
- `mcp__feishu-im__feishu_bot_get_messages`
- `mcp__feishu-im__feishu_bot_get_thread`
- `mcp__feishu-im__feishu_bot_search_messages`
- `mcp__feishu-im__feishu_bot_download_resource`

优先使用用户级工具（权限更广），Bot 级工具作为 fallback。

---

## 执行前必读

- 用户级工具以用户身份调用，只能读取用户有权限的会话
- `get_messages` 中 `open_id` 和 `chat_id` 必须二选一
- 消息中出现 `thread_id` 时，推荐主动获取话题回复
- 资源下载需要 `message_id` + `file_key` + `type`

---

## 快速索引

| 用户意图 | 工具 | 必填参数 | 常用可选 |
|---------|------|---------|---------|
| 获取历史消息 | im_user_get_messages | chat_id 或 open_id | relative_time, page_size |
| 获取话题回复 | im_user_get_thread_messages | thread_id（omt_xxx） | page_size, sort_rule |
| 跨会话搜索 | im_user_search_messages | 至少一个过滤条件 | query, sender_ids, chat_id |
| 下载图片 | im_user_fetch_resource | message_id, file_key, type="image" | - |
| 下载文件 | im_user_fetch_resource | message_id, file_key, type="file" | - |

---

## 核心约束

### 1. 时间范围

根据用户意图推断合适的 `relative_time`：`today`、`yesterday`、`this_week`、`last_3_days` 等。

### 2. 分页

- `page_size` 范围 1-50，默认 50
- `has_more=true` 时用 `page_token` 继续获取

### 3. 话题回复

获取历史消息时，返回中包含 `thread_id` 时推荐主动获取最新 10 条回复。

### 4. 搜索参数

| 参数 | 说明 |
|------|------|
| `query` | 搜索关键词 |
| `sender_ids` | 发送者 open_id 列表 |
| `chat_id` | 限定会话 |
| `message_type` | 消息类型：file / image / media |

### 5. 资源下载

| 资源类型 | 标记格式 | fetch_resource 参数 |
|---------|---------|-------------------|
| 图片 | `![image](img_xxx)` | file_key=`img_xxx`, type=`"image"` |
| 文件 | `<file key="file_xxx" .../>` | file_key=`file_xxx`, type=`"file"` |

### 6. 时间过滤

| 方式 | 参数 | 示例 |
|------|------|------|
| 相对时间 | `relative_time` | `today`, `this_week`, `last_3_days` |
| 精确时间 | `start_time` + `end_time` | ISO 8601 格式 |

两者互斥，不能同时使用。

---

## 使用场景示例

### 获取群聊消息并展开话题

```json
{ "chat_id": "oc_xxx" }
```

发现 `thread_id` 后：
```json
{ "thread_id": "omt_xxx", "page_size": 10, "sort_rule": "create_time_desc" }
```

### 跨会话搜索

```json
{ "query": "项目进度", "chat_id": "oc_xxx" }
```

### 下载图片

```json
{ "message_id": "om_xxx", "file_key": "img_v3_xxx", "type": "image" }
```

---

## 常见错误

| 错误现象 | 解决方案 |
|---------|---------|
| 消息结果太少 | 调整 `relative_time` |
| 消息不完整 | 检查 `has_more` 并翻页 |
| 话题内容不完整 | 展开 `thread_id` |
| "open_id 和 chat_id 不能同时提供" | 只传其中一个 |
