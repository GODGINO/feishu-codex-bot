---
name: feishu-update-doc
description: |
  更新飞书云文档。支持 7 种更新模式：追加、覆盖、定位替换、全文替换、前/后插入、删除。

  **当以下情况时使用此 Skill**:
  (1) 需要修改现有飞书文档内容
  (2) 需要往文档追加新内容
  (3) 需要替换文档中的某段内容
  (4) 用户提到"更新文档"、"修改文档"、"往文档里加"
---

# 更新飞书云文档

## 前提条件

用户需已绑定 Feishu MCP URL。如未绑定，请引导用户参考 feishu-mcp-bind skill 完成绑定。

## 调用方式：HTTP 直接调用

通过 Bash curl 直接调用飞书 MCP 的 Streamable HTTP 接口。**不要使用 MCP 工具，直接 HTTP 调用。**

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

### 第三步：调用 update_doc

```bash
curl -s -X POST "<MCP_URL>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <session_id>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"update_doc","arguments":{"url":"<doc_url>","mode":"append","markdown":"追加内容..."}}}'
```

---

支持 7 种更新模式。优先使用局部更新（replace_range/append/insert_before/insert_after），慎用 overwrite（会清空文档重写，可能丢失图片、评论等）。

# 定位方式

定位模式（replace_range/replace_all/insert_before/insert_after/delete_range）支持两种定位方式，二选一：

## selection_with_ellipsis - 内容定位

支持两种格式：

1. **范围匹配**：`开头内容...结尾内容` — 匹配从开头到结尾的所有内容
2. **精确匹配**：`完整内容`（不含 `...`）— 匹配完整的文本内容

**转义**：内容本身包含 `...` 时，使用 `\.\.\.` 表示字面量。

## selection_by_title - 标题定位

格式：`## 章节标题`（可带或不带 # 前缀）

自动定位整个章节（从该标题到下一个同级或更高级标题之前）。

# 可选参数

## new_title

更新文档标题。仅支持纯文本，1-800 字符。可以与任何 mode 配合使用。

# 返回值

## 成功

```json
{
  "success": true,
  "doc_id": "文档ID",
  "mode": "使用的模式",
  "message": "文档更新成功（xxx模式）"
}
```

## 异步模式（大文档超时）

```json
{
  "task_id": "async_task_xxxx",
  "message": "文档更新已提交异步处理，请使用 task_id 查询状态"
}
```

使用返回的 `task_id` 再次调用 update-doc（仅传 task_id 参数）查询状态。

---

# 使用示例

## append - 追加到末尾

```json
{
  "doc_id": "文档ID或URL",
  "mode": "append",
  "markdown": "## 新章节\n\n追加的内容..."
}
```

## replace_range - 定位替换

```json
{
  "doc_id": "文档ID或URL",
  "mode": "replace_range",
  "selection_with_ellipsis": "## 旧章节标题...旧章节结尾。",
  "markdown": "## 新章节标题\n\n新的内容..."
}
```

使用标题定位替换整个章节：
```json
{
  "doc_id": "文档ID或URL",
  "mode": "replace_range",
  "selection_by_title": "## 功能说明",
  "markdown": "## 功能说明\n\n更新后的功能说明内容..."
}
```

## replace_all - 全文替换

```json
{
  "doc_id": "文档ID或URL",
  "mode": "replace_all",
  "selection_with_ellipsis": "张三",
  "markdown": "李四"
}
```

## insert_before / insert_after

```json
{
  "doc_id": "文档ID或URL",
  "mode": "insert_after",
  "selection_with_ellipsis": "```python...```",
  "markdown": "**输出示例**：\n```\nresult = 42\n```"
}
```

## delete_range - 删除内容

```json
{
  "doc_id": "文档ID或URL",
  "mode": "delete_range",
  "selection_by_title": "## 废弃章节"
}
```

## overwrite - 完全覆盖

⚠️ 会清空文档后重写，可能丢失图片、评论等。

```json
{
  "doc_id": "文档ID或URL",
  "mode": "overwrite",
  "markdown": "# 新文档\n\n全新的内容..."
}
```

---

# 最佳实践

- **小粒度精确替换**：定位范围越小越安全，尤其是表格、分栏等嵌套块
- **保护不可重建的内容**：图片、画板、电子表格等以 token 存储，替换时避开这些区域
- **分步更新优于整体覆盖**：多次小范围替换比一次 overwrite 更安全
- **insert 模式注意插入位置**：`insert_after` 插入在匹配范围结尾之后，`insert_before` 在开头之前

# 注意事项

- **Markdown 语法**：支持飞书扩展语法，详见 feishu-create-doc skill 文档
