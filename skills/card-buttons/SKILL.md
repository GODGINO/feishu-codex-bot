---
name: card-buttons
description: >
  卡片交互（按钮）— 已合并到 interactive-card skill。该 skill 仅保留语法速查，
  完整规则（含下拉选择器 SELECT 范式 + 互斥约束）请查看 interactive-card。
---

# 已迁移到 interactive-card

按钮能力已与下拉选择器合并到 `interactive-card` skill。请使用该 skill 获取完整规则。

## 简版语法

两种范式**互斥**，同一回复只能用一种：

- **按钮**：`<<BUTTON:文案|action_id|样式?>>`（样式 primary/danger 可选，≤4 个）
- **选择器**：`<<SELECT:placeholder|name|key1=文案1|key2=文案2|...>>`（系统自动加提交按钮）

混用时系统会强制丢弃 SELECT。

详细决策表、场景示例、严禁清单见 `interactive-card` skill。
