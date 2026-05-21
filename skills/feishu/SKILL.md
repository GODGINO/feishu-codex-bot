---
name: feishu
description: >
  飞书文档操作。当用户要求创建文档、编辑文档、搜索文档、
  管理知识库、操作飞书 API 时使用。
---
# 飞书文档操作

## 查看可用工具
```bash
bash {PROJECT_ROOT}/scripts/feishu-cli.sh list-tools
```

## 调用工具
```bash
bash {PROJECT_ROOT}/scripts/feishu-cli.sh call <tool_name> '<json_params>'
```

## 常用操作示例

### 创建文档
```bash
bash {PROJECT_ROOT}/scripts/feishu-cli.sh call docx_create_document '{"title":"文档标题","folder_token":"xxx"}'
```

### 更新文档内容
```bash
bash {PROJECT_ROOT}/scripts/feishu-cli.sh call update_document_content '{"document_id":"xxx","markdown":"# 内容"}'
```

### 搜索文档
```bash
bash {PROJECT_ROOT}/scripts/feishu-cli.sh call search_docs '{"query":"搜索关键词"}'
```

## 环境变量
- `SESSION_DIR`：会话目录（已由系统自动设置），用于读取 `feishu-mcp-url` 配置文件
- `SESSION_KEY`：会话标识（已由系统自动设置），用于 MCP session 缓存
