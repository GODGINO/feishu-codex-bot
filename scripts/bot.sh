#!/bin/bash
# Feishu Claude Bot 管理脚本 (PM2)
# 用法: bash scripts/bot.sh [start|stop|status|restart|log]

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Load .env if present (export vars for subprocesses)
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

CF_PID_FILE="$PROJECT_DIR/.cf-tunnel.pid"
CF_URL_FILE="$PROJECT_DIR/.cf-tunnel.url"
CF_LOG_FILE="$PROJECT_DIR/.cf-tunnel.log"
CLOUDFLARED="$(which cloudflared 2>/dev/null || echo "$HOME/.local/bin/cloudflared")"
CF_TUNNEL_TOKEN="${CF_TUNNEL_TOKEN:-}"
CF_TUNNEL_URL="${CF_TUNNEL_URL:-}"
APP_NAME="feishu-bot"

# Sigma Claude Switcher (auto account rotation) — installed copy lives at ~/.sigma-switcher
# via sigma-switcher/daemon/install.sh. bot.sh just launches it as a subprocess here,
# paralleling the Cloudflare Tunnel pattern. Skipped silently if not installed/configured.
SWITCHER_DIR="$HOME/.sigma-switcher"
SWITCHER_PYTHON="$SWITCHER_DIR/venv/bin/python3"
SWITCHER_SCRIPT="$SWITCHER_DIR/switcher.py"
SWITCHER_CONFIG="$SWITCHER_DIR/config.yaml"
SWITCHER_PID_FILE="$PROJECT_DIR/.switcher.pid"
export PATH="$(dirname "$(which node)"):$HOME/homebrew/bin:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

pm2_cmd() {
  npx pm2 "$@" 2>/dev/null
}

is_running() {
  local status=$(pm2_cmd show "$APP_NAME" 2>/dev/null | grep "status" | head -1 | awk '{print $4}')
  [ "$status" = "online" ]
}

start() {
  if is_running; then
    echo "Bot 已在运行"
    return 0
  fi
  cd "$PROJECT_DIR"
  npx tsc 2>&1 && echo "TypeScript 编译完成" || echo "TypeScript 编译失败"
  pm2_cmd start dist/index.js --name "$APP_NAME" --cwd "$PROJECT_DIR" --log "$PROJECT_DIR/.bot.log" --time
  sleep 2
  if is_running; then
    echo "Bot 已启动"
    start_tunnel
    start_switcher
  else
    echo "Bot 启动失败，查看日志: pm2 logs $APP_NAME"
    return 1
  fi
}

stop() {
  stop_switcher
  stop_tunnel
  if ! is_running; then
    echo "Bot 未在运行"
    return 0
  fi
  pm2_cmd stop "$APP_NAME"
  echo "Bot 已停止"
}

restart() {
  cd "$PROJECT_DIR"
  npx tsc 2>&1 && echo "TypeScript 编译完成" || echo "TypeScript 编译失败"
  if is_running; then
    pm2_cmd restart "$APP_NAME" --update-env
    echo "Bot 已重启"
    start_tunnel
    start_switcher
  else
    start
  fi
}

status() {
  if is_running; then
    echo "Bot 运行中"
    pm2_cmd show "$APP_NAME" | grep -E "pid|uptime|restart|status" | head -5
  else
    echo "Bot 未运行"
  fi
  if [ -f "$CF_PID_FILE" ] && kill -0 "$(cat "$CF_PID_FILE")" 2>/dev/null; then
    echo "CF 隧道运行中: $(cat "$CF_URL_FILE" 2>/dev/null || echo '未知')"
  else
    echo "CF 隧道未运行"
  fi
  if [ -f "$SWITCHER_PID_FILE" ] && kill -0 "$(cat "$SWITCHER_PID_FILE")" 2>/dev/null; then
    echo "Switcher 运行中 (PID $(cat "$SWITCHER_PID_FILE"))"
  else
    echo "Switcher 未运行"
  fi
}

log() {
  pm2_cmd logs "$APP_NAME" --lines 50 --nostream
}

start_tunnel() {
  if ! command -v cloudflared &>/dev/null && [ ! -x "$CLOUDFLARED" ]; then
    echo "cloudflared 未安装，跳过隧道"
    return 0
  fi
  stop_tunnel
  > "$CF_LOG_FILE"
  echo "$CF_TUNNEL_URL" > "$CF_URL_FILE"
  # --no-autoupdate: 关掉 cloudflared 自动升级（升级会自杀重启，nohup 不会拉起来 → tunnel 死掉）
  nohup "$CLOUDFLARED" --no-autoupdate tunnel run --token "$CF_TUNNEL_TOKEN" >> "$CF_LOG_FILE" 2>&1 &
  echo $! > "$CF_PID_FILE"
  sleep 2
  if kill -0 "$(cat "$CF_PID_FILE")" 2>/dev/null; then
    echo "CF 隧道已启动: $CF_TUNNEL_URL"
  else
    echo "CF 隧道启动失败，查看日志: $CF_LOG_FILE"
  fi
}

stop_tunnel() {
  if [ -f "$CF_PID_FILE" ]; then
    local pid=$(cat "$CF_PID_FILE")
    kill "$pid" 2>/dev/null
    rm -f "$CF_PID_FILE"
  fi
  pkill -f "cloudflared tunnel run" 2>/dev/null
}

start_switcher() {
  # Silently skip if not installed — run `bash sigma-switcher/daemon/install.sh` once to set up.
  if [ ! -x "$SWITCHER_PYTHON" ] || [ ! -f "$SWITCHER_SCRIPT" ]; then
    echo "Switcher 未安装，跳过（运行 bash sigma-switcher/daemon/install.sh 安装）"
    return 0
  fi
  if [ ! -f "$SWITCHER_CONFIG" ]; then
    echo "Switcher 未配置，跳过（编辑 $SWITCHER_CONFIG）"
    return 0
  fi
  stop_switcher
  mkdir -p "$SWITCHER_DIR/logs"
  nohup "$SWITCHER_PYTHON" "$SWITCHER_SCRIPT" >> "$SWITCHER_DIR/logs/switcher.log" 2>&1 &
  echo $! > "$SWITCHER_PID_FILE"
  sleep 1
  if kill -0 "$(cat "$SWITCHER_PID_FILE")" 2>/dev/null; then
    echo "Switcher 已启动 (PID $(cat "$SWITCHER_PID_FILE"))"
  else
    echo "Switcher 启动失败，查看日志: $SWITCHER_DIR/logs/switcher.log"
  fi
}

stop_switcher() {
  if [ -f "$SWITCHER_PID_FILE" ]; then
    local pid=$(cat "$SWITCHER_PID_FILE")
    kill "$pid" 2>/dev/null
    rm -f "$SWITCHER_PID_FILE"
  fi
  pkill -f "\.sigma-switcher/switcher.py" 2>/dev/null
}

case "${1:-status}" in
  start)   start ;;
  stop)    stop ;;
  restart) restart ;;
  status)  status ;;
  log)     log ;;
  *)       echo "用法: bot.sh [start|stop|restart|status|log]" ;;
esac
