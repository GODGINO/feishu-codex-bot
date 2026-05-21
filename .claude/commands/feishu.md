飞书 Claude Bot 管理命令。

根据用户参数执行对应操作，使用 `bash /Users/gezenghui/feishu-claude-bot/scripts/bot.sh` 脚本：

- `/feishu bot` 或 `/feishu bot start` → 启动 bot
- `/feishu bot stop` → 停止 bot
- `/feishu bot restart` → 重启 bot
- `/feishu bot status` → 查看状态
- `/feishu bot log` → 查看最近日志
- `/feishu config` → 打开 mcp-config.json 供编辑（MCP 配置、skills、定时任务）
- `/feishu prompt` → 打开 system-prompt/common.md 供编辑（共享提示词；模式专属覆盖见 env.local.md / env.server.md）

执行完后简短报告结果。如果用户只输入 `/feishu` 不带参数，显示可用命令列表。

项目目录: /Users/gezenghui/feishu-claude-bot
配置文件: /Users/gezenghui/feishu-claude-bot/mcp-config.json
系统提示词: /Users/gezenghui/feishu-claude-bot/system-prompt/common.md（共享）+ env.local.md / env.server.md（模式专属）
