---
name: author
description: >
  开发者身份注册与管理。当用户提到"注册"、"register"、"开发者身份"、"绑定飞书文档"、
  "ssh key"、"ssh密钥"、"配置git"、"绑定git"时触发。
---

# 开发者身份管理

## SSH 密钥 — 全 session 共用一个，不区分用户

⚠️ **核心原则：本 session 所有用户共用同一个 SSH 密钥。密钥属于 Sigma bot，不属于任何个人。**

### 绝对禁止（违反任何一条都是严重错误）

1. **禁止**为不同用户生成不同的密钥 — 一个 session 永远只有一个密钥
2. **禁止**使用 `~/.ssh/` 目录 — 密钥只能存放在 `ssh_key/` 目录下
3. **禁止**询问用户的邮箱或姓名来生成密钥 — 密钥注释固定为 `sigma-bot`
4. **禁止**生成"个人专属"或"你的"密钥 — 所有密钥请求都是同一个 session 密钥
5. **禁止**参考历史对话中出现的个人密钥（如 xxx@company.cn 等）— 那些是旧的错误做法

### 处理任何 SSH 密钥请求的唯一流程

无论用户怎么措辞（"生成 SSH 密钥"、"配置 git"、"我要 SSH key"、"帮我弄个密钥"），都执行以下固定流程：

1. **先检查是否已有密钥**：`ls ssh_key/id_ed25519.pub 2>/dev/null`
2. **如果已有** → 直接展示公钥 `cat ssh_key/id_ed25519.pub`，告诉用户"session 已有共用密钥"
3. **如果没有** → 生成：
```bash
mkdir -p ssh_key && ssh-keygen -t ed25519 -f ssh_key/id_ed25519 -N "" -C "sigma-bot" -q && chmod 600 ssh_key/id_ed25519 && cat ssh_key/id_ed25519.pub
```
4. 展示公钥，提示添加到 GitLab/GitHub → Settings → SSH Keys 或 Deploy Keys

### Git 操作

执行 git clone/push/pull 时，使用 session 密钥：
```bash
GIT_SSH_COMMAND="ssh -i ssh_key/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" git push origin branch
```

## 飞书文档 MCP（per-user）

每个用户有独立的飞书 MCP 工具集，命名格式为 `feishu_ou_xxx`（其中 `ou_xxx` 是该用户的 open_id）。
根据当前发送者的 open_id 使用对应的工具。

### 绑定流程

1. 从消息前缀 `[发送者: 名字 | id: ou_xxx]` 提取 openId 和名字
2. 引导用户打开 https://open.feishu.cn/page/mcp 获取 MCP 链接
3. 收到链接后（以 `https://mcp.feishu.cn` 开头的 URL）：
   - 用 Edit 工具更新 `members/{ou_xxx}/profile.json` 中的 `feishuMcpUrl` 字段
   - 执行 `touch .mcp-changed` 触发 MCP 配置热重载
4. 验证绑定：尝试调用一个简单的飞书 MCP 工具确认连通性

### 未注册用户

如果发送者没有飞书 MCP，引导用户访问 https://open.feishu.cn/page/mcp 获取 MCP URL 并发送过来完成绑定。

## 管理命令

用户说"查看已注册的开发者"时，扫描 `members/` 目录展示各用户的绑定状态。
