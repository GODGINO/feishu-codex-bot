---
name: feishu-bitable
description: |
  飞书多维表格（Bitable）的创建、查询、编辑和管理工具。包含 27 种字段类型支持、高级筛选、批量操作和视图管理。

  **当以下情况时使用此 Skill**：
  (1) 需要创建或管理飞书多维表格 App
  (2) 需要在多维表格中新增、查询、修改、删除记录（行数据）
  (3) 需要管理字段（列）、视图、数据表
  (4) 用户提到"多维表格"、"bitable"、"数据表"、"记录"、"字段"
  (5) 需要批量导入数据或批量更新多维表格
---

# 飞书多维表格 (Bitable)

## 前提条件

用户需已绑定 Feishu MCP URL。如未绑定，请引导用户参考 feishu-mcp-bind skill 完成绑定。

## 调用方式：HTTP 直接调用

通过 Bash curl 直接调用飞书 MCP 的 Streamable HTTP 接口。**不要使用 MCP 工具，直接 HTTP 调用。**

主要工具名：
- `bitable_app` — App 级操作（创建多维表格）
- `bitable_app_table` — 数据表操作（创建/删除数据表）
- `bitable_app_table_field` — 字段操作（增删改查字段）
- `bitable_app_table_record` — 记录操作（CRUD 记录）
- `bitable_app_table_view` — 视图操作

### 第一步：获取 MCP URL

从会话目录读取：
- **群聊**：读取 `members/{ou_xxx}/profile.json`，找当前发送者对应的 `feishuMcpUrl`
- **私聊**：读取 `feishu-mcp-url` 文件

### 第二步：初始化会话

```bash
curl -s -D- -X POST "<MCP_URL>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"sigma","version":"1.0"}}}'
```

从响应 header 中获取 `mcp-session-id`。

### 第三步：调用工具

```bash
curl -s -X POST "<MCP_URL>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <session_id>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool_name>","arguments":{...}}}'
```

---

## 🚨 执行前必读

- ✅ **创建数据表**：支持两种模式 — ① 明确需求时，在 `create` 时通过 `table.fields` 一次性定义字段；② 探索式场景时，使用默认表 + 逐步修改字段
- ⚠️ **默认表的空行坑**：`app.create` 自带的默认表中会有空记录！插入数据前建议先 `list` + `batch_delete` 删除空行
- ✅ **写记录前**：先调用 `field.list` 获取字段 type/ui_type
- ✅ **人员字段**：默认 open_id（ou_...），值必须是 `[{id:"ou_xxx"}]`（数组对象）
- ✅ **日期字段**：毫秒时间戳（例如 `1674206443000`），不是秒
- ✅ **单选字段**：字符串（例如 `"选项1"`），不是数组
- ✅ **多选字段**：字符串数组（例如 `["选项1", "选项2"]`）
- ✅ **附件字段**：必须先上传到当前多维表格，使用返回的 file_token
- ✅ **批量上限**：单次 ≤ 500 条，超过需分批
- ✅ **并发限制**：同一数据表不支持并发写，需串行调用 + 延迟 0.5-1 秒

---

## 📋 快速索引：意图 → 工具 → 必填参数

| 用户意图 | 工具 | action | 必填参数 | 常用可选 |
|---------|------|--------|---------|---------|
| 查表有哪些字段 | feishu_bitable_app_table_field | list | app_token, table_id | - |
| 查记录 | feishu_bitable_app_table_record | list | app_token, table_id | filter, sort, field_names |
| 新增一行 | feishu_bitable_app_table_record | create | app_token, table_id, fields | - |
| 批量导入 | feishu_bitable_app_table_record | batch_create | app_token, table_id, records (≤500) | - |
| 更新一行 | feishu_bitable_app_table_record | update | app_token, table_id, record_id, fields | - |
| 批量更新 | feishu_bitable_app_table_record | batch_update | app_token, table_id, records (≤500) | - |
| 创建多维表格 | feishu_bitable_app | create | name | folder_token |
| 创建数据表 | feishu_bitable_app_table | create | app_token, name | fields |
| 创建字段 | feishu_bitable_app_table_field | create | app_token, table_id, field_name, type | property |
| 创建视图 | feishu_bitable_app_table_view | create | app_token, table_id, view_name, view_type | - |

---

## 🎯 核心约束

### 📚 详细参考文档

**遇到字段配置、记录值格式问题时，查阅以下文档**：

- **[字段 Property 配置详解](references/field-properties.md)** — 每种字段类型的 `property` 参数结构
- **[记录值数据结构详解](references/record-values.md)** — 每种字段类型在记录中的 `fields` 值格式
- **[使用场景完整示例](references/examples.md)** — 8 个完整场景示例

**何时查阅**:
- 创建/更新字段时收到 `125408X` 错误码 → 查 field-properties.md
- 写入记录时收到 `125406X` 错误码 → 查 record-values.md
- 需要完整操作流程 → 查 examples.md

### 字段类型与值格式

| type | ui_type | 字段类型 | 正确格式 | ❌ 常见错误 |
|------|---------|----------|---------|-----------|
| 11 | User | 人员 | `[{id: "ou_xxx"}]` | 传字符串或 `[{name: "张三"}]` |
| 5 | DateTime | 日期 | `1674206443000`（毫秒） | 传秒时间戳或字符串 |
| 3 | SingleSelect | 单选 | `"选项名"` | 传数组 `["选项名"]` |
| 4 | MultiSelect | 多选 | `["选项1", "选项2"]` | 传字符串 |
| 15 | Url | 超链接 | `{link: "...", text: "..."}` | 只传字符串 URL |
| 17 | Attachment | 附件 | `[{file_token: "..."}]` | 传外部 URL |

---

## 📌 核心使用场景

### 场景 1: 查字段类型（必做第一步）

```json
{
  "action": "list",
  "app_token": "S404b...",
  "table_id": "tbl..."
}
```

### 场景 2: 批量导入数据

```json
{
  "action": "batch_create",
  "app_token": "S404b...",
  "table_id": "tbl...",
  "records": [
    {
      "fields": {
        "客户名称": "字节跳动",
        "负责人": [{"id": "ou_xxx"}],
        "签约日期": 1674206443000,
        "状态": "进行中"
      }
    }
  ]
}
```

### 场景 3: 筛选查询

```json
{
  "action": "list",
  "app_token": "S404b...",
  "table_id": "tbl...",
  "filter": {
    "conjunction": "and",
    "conditions": [
      {"field_name": "状态", "operator": "is", "value": ["进行中"]},
      {"field_name": "截止日期", "operator": "isLess", "value": ["ExactDate", "1740441600000"]}
    ]
  },
  "sort": [{"field_name": "截止日期", "desc": false}]
}
```

⚠️ **isEmpty/isNotEmpty 必须传 `value: []`**

---

## 🔍 常见错误与排查

| 错误码 | 错误现象 | 解决方案 |
|--------|---------|---------|
| 1254064 | 日期字段格式错误 | **必须用毫秒时间戳** |
| 1254068 | 超链接字段格式错误 | **必须用对象** `{text: "...", link: "..."}` |
| 1254066 | 人员字段格式错误 | 必须传 `[{id: "ou_xxx"}]` |
| 1254015 | 字段值格式不匹配 | 先 list 字段，按类型构造 |
| 1254104 | 批量超过 500 条 | 分批调用 |
| 1254291 | 并发写冲突 | 串行调用 + 延迟 0.5-1 秒 |
| 1254045 | 字段名不存在 | 检查字段名（含空格、大小写） |

---

## 📚 附录

### 资源层级

```
App (多维表格应用)
 ├── Table (数据表) ×100
 │    ├── Record (记录/行) ×20,000
 │    ├── Field (字段/列) ×300
 │    └── View (视图) ×200
 └── Dashboard (仪表盘)
```

### 筛选 operator

| operator | 含义 | value 要求 |
|----------|------|-----------|
| `is` | 等于 | 单个值 |
| `isNot` | 不等于 | 单个值 |
| `contains` | 包含 | 可多个值 |
| `doesNotContain` | 不包含 | 可多个值 |
| `isEmpty` | 为空 | 必须为 `[]` |
| `isNotEmpty` | 不为空 | 必须为 `[]` |
| `isGreater` / `isLess` | 大于/小于 | 单个值 |

**日期特殊值**: `["Today"]`, `["Tomorrow"]`, `["ExactDate", "时间戳"]`
