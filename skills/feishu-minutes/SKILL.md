---
name: feishu-minutes
description: >
  飞书妙记（会议纪要）读取。当用户发送妙记链接、询问会议内容、
  要求总结会议记录时使用。关键词：妙记/minutes/会议记录/会议纪要/转写/发言记录。
---

# 飞书妙记

读取飞书妙记的元信息和转写文本（含说话人标注）。

## 识别妙记链接

妙记 URL 格式：`https://xxx.feishu.cn/minutes/<minute_token>`

从 URL 中提取最后一段路径作为 `minute_token`，例如：
- `https://your-org.feishu.cn/minutes/obcnXXXXXXXXXXXXXXXXXXX` → token: `obcnXXXXXXXXXXXXXXXXXXX`

## 使用流程

### 1. 获取妙记基本信息

```bash
bash {PROJECT_ROOT}/scripts/feishu-cli.sh call feishu_minutes_get_info '{"user_id":"<user_open_id>","minute_token":"<token>"}'
```

返回：标题、时长、参与者、创建时间、链接。

### 2. 获取转写文本（含说话人）

```bash
bash {PROJECT_ROOT}/scripts/feishu-cli.sh call feishu_minutes_get_transcript '{"user_id":"<user_open_id>","minute_token":"<token>","need_speaker":true,"need_timestamp":false}'
```

返回：带说话人标注的完整转写文本。

### 3. 回复用户

用卡片格式回复：
- 标题 + 时长
- 参与者
- 转写文本摘要或全文（根据长度决定）
- 附上"查看完整妙记"链接

## 注意事项

- 需要用户先通过 `feishu_auth_start` 授权（妙记 API 使用用户 token）
- 如果返回 "minute not ready" 错误，说明转写仍在处理中，稍后重试
- 如果返回权限错误，说明用户对该妙记没有访问权限
- `user_id` 使用当前对话用户的 open_id（`ou_xxx` 格式）
