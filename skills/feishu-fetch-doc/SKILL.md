---
name: feishu-fetch-doc
description: |
  获取飞书云文档内容。返回文档的 Markdown 内容，支持处理文档中的图片、文件和画板。

  **当以下情况时使用此 Skill**:
  (1) 需要读取飞书云文档内容
  (2) 用户发送了飞书文档链接并要求查看
  (3) 用户提到"看看这个文档"、"读取文档"、"文档内容"
---

# 获取飞书云文档内容

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

### 第三步：调用 fetch_doc

```bash
curl -s -X POST "<MCP_URL>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <session_id>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fetch_doc","arguments":{"url":"<doc_url>"}}}'
```

---

获取飞书云文档的 Markdown 内容（Lark-flavored 格式）。

## 重要：图片、文件、画板的处理

**文档中的图片、文件、画板需要通过 `feishu_doc_media`（action: download）工具单独获取！**

### 识别格式

返回的 Markdown 中，媒体文件以 HTML 标签形式出现：

- **图片**：`<image token="Z1FjxxxtnAc" width="1833" height="2491" align="center"/>`
- **文件**：`<view type="1"><file token="Z1FjxxxtnAc" name="skills.zip"/></view>`
- **画板**：`<whiteboard token="Z1FjxxxtnAc"/>`

### 获取步骤

1. 从 HTML 标签中提取 `token` 属性值
2. 调用 `feishu_doc_media` 下载：
   ```json
   {
     "action": "download",
     "resource_token": "提取的token",
     "resource_type": "media",
     "output_path": "/path/to/save/file"
   }
   ```

## 参数

- **`doc_id`**（必填）：支持直接传文档 URL 或 token
  - 直接传 URL：`https://xxx.feishu.cn/docx/Z1FjxxxtnAc`
  - 直接传 token：`Z1FjxxxtnAc`
  - 知识库 URL/token 也支持：`https://xxx.feishu.cn/wiki/Z1FjxxxtnAc`

## Wiki URL 处理策略

知识库链接（`/wiki/TOKEN`）背后可能是云文档、电子表格、多维表格等不同类型的文档。当不确定类型时, **不能直接假设是云文档**，必须先查询实际类型。

### 处理流程

1. **先调用 `feishu_wiki_space_node`（action: get）解析 wiki token**
2. **从返回的 `node` 中获取 `obj_type` 和 `obj_token`**
3. **根据 `obj_type` 调用对应工具**：

| obj_type | 工具 | 传参 |
|----------|------|------|
| `docx` | `fetch_doc` | doc_id = obj_token |
| `sheet` | `feishu_sheet` | spreadsheet_token = obj_token |
| `bitable` | `feishu_bitable_*` 系列 | app_token = obj_token |
| 其他 | 告知用户暂不支持该类型 | — |

## 工具组合

| 需求 | 工具 |
|------|------|
| 获取文档文本 | `fetch_doc` |
| 下载图片/文件/画板 | `feishu_doc_media`（action: download） |
| 解析 wiki token 类型 | `feishu_wiki_space_node`（action: get） |
| 读写电子表格 | `feishu_sheet` |
| 操作多维表格 | `feishu_bitable_*` 系列 |
