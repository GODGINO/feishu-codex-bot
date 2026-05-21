# Feishu Tools - 飞书任务/日历/多维表格

## 何时使用

当用户要求操作飞书任务、日历事件、多维表格时，使用 `feishu-tools` MCP 的工具。

注意：飞书云文档（创建/编辑文档）使用的是 `feishu` 或 `feishu_{openId}` MCP（Streamable HTTP），不是本 MCP。

## 认证流程

所有工具需要 `user_id` 参数（用户的 open_id，格式 `ou_xxx`），从消息前缀 `[发送者: Name | id: ou_xxx]` 中获取。

首次使用时需要 OAuth 授权：

1. 调用 `feishu_auth_status` 检查用户是否已授权
2. 如果未授权，调用 `feishu_auth_start` 获取授权链接
3. 将授权链接发送给用户，让用户点击完成授权
4. 用户确认授权后，调用 `feishu_auth_poll` 完成认证
5. 认证成功后即可调用其他工具

授权有效期约 7 天（refresh_token），期间无需重新授权。

## 可用工具

### 任务（Task v2）

| 工具 | 说明 |
|------|------|
| `feishu_task_create` | 创建任务（summary, description, due） |
| `feishu_task_list` | 列出任务（可按完成状态过滤） |
| `feishu_task_get` | 获取任务详情 |
| `feishu_task_update` | 更新任务（标题/描述/截止日期/完成状态） |
| `feishu_task_list_tasklists` | 列出任务清单 |

**时间格式**：due 参数使用 ISO 8601 格式（如 `2026-03-15T18:00:00+08:00`），工具内部会转换为毫秒时间戳。

**更新任务**：`feishu_task_update` 只需传要改的字段。标记完成用 `completed_at` 传当前时间，标记未完成传 `"0"`。

### 日历（Calendar v4）

| 工具 | 说明 |
|------|------|
| `feishu_calendar_list_events` | 列出指定时间范围内的事件（最多 40 天） |
| `feishu_calendar_create_event` | 创建日历事件 |
| `feishu_calendar_get_event` | 获取事件详情 |
| `feishu_calendar_update_event` | 更新事件 |
| `feishu_calendar_delete_event` | 删除事件 |
| `feishu_calendar_search_events` | 按关键词搜索事件 |

**自动使用主日历**：不需要指定 calendar_id，工具会自动获取用户的主日历。

**创建事件并邀请参与者**：使用 `attendee_ids` 参数传入参与者的 open_id 数组。

### 多维表格（Bitable v1）

| 工具 | 说明 |
|------|------|
| `feishu_bitable_list_records` | 查询/搜索记录 |
| `feishu_bitable_create_record` | 创建记录 |
| `feishu_bitable_update_record` | 更新记录 |
| `feishu_bitable_delete_record` | 删除记录 |
| `feishu_bitable_batch_create` | 批量创建记录（最多 500 条） |

**字段值格式**：
- 文本：`string`
- 数字：`number`
- 单选：`string`（选项名）
- 多选：`string[]`
- 日期：`number`（毫秒时间戳）
- 复选框：`boolean`
- 人员：`[{ "id": "ou_xxx" }]`

**查询过滤**：`feishu_bitable_list_records` 的 `filter` 参数使用飞书过滤表达式，如 `AND(CurrentValue.[状态]="进行中")`。

## 错误处理

- 如果工具返回"用户尚未授权"，引导用户完成 OAuth 授权流程
- 如果返回权限不足错误，提示用户联系管理员在飞书开放平台添加相应权限
- API 错误码 `99991672` 表示应用缺少权限（App Scope）
- API 错误码 `99991668`/`99991669` 表示 token 已失效，需重新授权
