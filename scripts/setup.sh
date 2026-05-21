#!/bin/bash
# feishu-claude-bot 一键安装脚本
set -e

echo "=== feishu-claude-bot setup ==="

# 1. 检查 Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js 未安装，请先安装 Node.js >= 18"
  echo "   https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ Node.js 版本过低 ($(node -v))，需要 >= 18"
  exit 1
fi
echo "✅ Node.js $(node -v)"

# 2. 检查 Claude Code CLI
if ! command -v claude &> /dev/null; then
  echo "❌ Claude Code CLI 未安装"
  echo "   安装方法: npm install -g @anthropic-ai/claude-code"
  echo "   文档: https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi
echo "✅ Claude Code CLI $(claude --version 2>/dev/null || echo 'installed')"

# 3. 安装 claude-mem 插件（记忆系统，必选依赖）
if claude plugins list 2>/dev/null | grep -q "claude-mem"; then
  echo "✅ claude-mem 插件已安装"
else
  echo "📦 安装 claude-mem 插件..."
  claude plugins install claude-mem@thedotmack
  echo "✅ claude-mem 插件安装完成"
fi

# 4. npm install
echo "📦 安装 npm 依赖..."
npm install

# 5. 复制 .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "📝 已创建 .env 文件，请编辑填写飞书应用凭据："
  echo "   FEISHU_APP_ID=cli_xxxxx"
  echo "   FEISHU_APP_SECRET=xxxxx"
  echo ""
  echo "   获取方式: https://open.feishu.cn/app → 创建企业自建应用"
else
  echo "✅ .env 文件已存在"
fi

# 6. 编译
echo "🔨 编译 TypeScript..."
npm run build

echo ""
echo "=== 安装完成 ==="
echo "1. 编辑 .env 填写飞书凭据"
echo "2. 启动: npm run bot"
echo "3. 停止: npm run bot:stop"
echo "4. 日志: npm run bot:log"
