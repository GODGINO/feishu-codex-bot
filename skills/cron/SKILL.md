---
name: cron
description: >
  定时任务管理。当用户要求定期执行某事、设置提醒、
  创建/查看/删除定时任务时使用。
---
# 定时任务管理

## 创建任务
```bash
node {PROJECT_ROOT}/scripts/cron-cli.cjs create --name "任务名" --schedule "9:00" --prompt "执行什么"
```

参数：
- `--name`（必填）：任务名称
- `--schedule`（必填）：执行计划（**所有时间均为北京时间 Asia/Shanghai，不要做时区转换**）。支持格式：
  - Cron 表达式：`0 9 * * *`（每天早上9点）、`*/30 * * * *`
  - 简写：`30m`、`2h`、`1d`
  - 时间点：`9:00`、`14:30`（北京时间）
  - English：`every 2h`、`every 30m`
- `--prompt`（必填）：任务内容，自然语言描述要执行什么

## 查看任务
```bash
node {PROJECT_ROOT}/scripts/cron-cli.cjs list
```

## 删除任务
```bash
node {PROJECT_ROOT}/scripts/cron-cli.cjs delete --id <task_id>
```

## 启用/禁用任务
```bash
node {PROJECT_ROOT}/scripts/cron-cli.cjs toggle --id <task_id> --enabled true
```

## 环境变量
运行前需要设置 `SESSION_DIR` 环境变量（已由系统自动设置）。
