---
name: email
description: 管理用户的邮箱账号。当用户提到邮件、邮箱、email、收件箱、发邮件等话题时使用此技能。支持多账号、收发邮件、搜索、文件夹管理。
---

# Email 邮箱管理

使用 `email` 命令操作邮箱（这是 `email-cli.sh` 的别名脚本）。

## 快速开始

```bash
# 添加邮箱账号（自动测试连接）
bash email-cli.sh add-account --email=user@example.com --password=授权码 --provider=feishu --label="工作邮箱"

# 测试连接（不保存）
bash email-cli.sh test-account --email=user@example.com --password=授权码 --provider=feishu

# 查看已配置的邮箱账号
bash email-cli.sh accounts

# 查看收件箱最新20封
bash email-cli.sh list --account=<账号id>

# 读取某封邮件
bash email-cli.sh read --account=<账号id> --uid=<邮件UID>
```

## 完整命令

| 命令 | 说明 | 必须参数 | 可选参数 |
|------|------|----------|----------|
| `add-account` | 添加邮箱并测试 | `--email` `--password` + (`--provider` 或 `--imap-host`/`--smtp-host`) | `--label` `--id` |
| `test-account` | 仅测试连接 | `--email` `--password` `--provider` | - |
| `remove-account` | 删除邮箱 | `--id` | - |
| `accounts` | 列出所有邮箱账号 | - | - |
| `folders` | 列出文件夹 | `--account` | - |
| `list` | 列出邮件 | `--account` | `--folder` `--limit` `--page` |
| `read` | 读取邮件全文 | `--account` `--uid` | `--folder` |
| `search` | 搜索邮件 | `--account` | `--from` `--to` `--subject` `--since` `--before` `--unseen` `--limit` |
| `send` | 发送邮件 | `--account` `--to` `--subject` `--body` | `--cc` `--bcc` |
| `reply` | 回复邮件 | `--account` `--uid` `--body` | `--folder` |
| `forward` | 转发邮件 | `--account` `--uid` `--to` | `--folder` `--comment` |
| `move` | 移动邮件 | `--account` `--uid` `--from` `--to-folder` | - |
| `delete` | 删除邮件 | `--account` `--uid` | `--folder` |
| `mark-read` | 标记已读 | `--account` `--uid` | `--folder` |
| `mark-unread` | 标记未读 | `--account` `--uid` | `--folder` |

## 使用注意

- 如果用户只有一个邮箱账号，不需要每次都问用哪个账号
- `--folder` 默认为 INBOX，大部分操作不需要指定
- 搜索时 `--since` 和 `--before` 格式为 `YYYY-MM-DD`
- 发送邮件前确认收件人和内容，避免误发
- 回复时自动处理 Re: 前缀和 References 头
- 读取邮件时如果正文很长，可以只展示摘要，用户要求时再展示全文
