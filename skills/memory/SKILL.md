---
name: memory
description: >
  跨会话持久记忆。当用户要求记住某事、回忆之前的对话、
  查找历史信息时使用。也在需要存储重要发现或决策时主动使用。
---
# 记忆管理

## 记住（保存记忆）
```bash
bash {PROJECT_ROOT}/scripts/memory-cli.sh remember "要记住的内容" --title "简短标题" --type note
```

参数：
- `text`（必填）：要记住的内容
- `--title`（可选）：简短标题
- `--type`（可选）：类型，可选 note / discovery / decision / preference，默认 note

## 回忆（搜索记忆）
```bash
bash {PROJECT_ROOT}/scripts/memory-cli.sh recall --query "搜索关键词" --limit 20
```

参数：
- `--query`（可选）：搜索关键词，不传则返回最近的记忆列表
- `--limit`（可选）：最大返回条数，默认 20，最大 50

## 环境变量
运行前需要设置 `SESSION_KEY` 环境变量（已由系统自动设置）。
