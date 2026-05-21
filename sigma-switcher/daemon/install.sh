#!/usr/bin/env bash
# Sigma Claude Switcher — daemon install
set -euo pipefail

ROOT="${HOME}/.sigma-switcher"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "→ Creating ${ROOT}"
mkdir -p "${ROOT}/logs"

echo "→ Copying daemon files"
cp "${SCRIPT_DIR}/switcher.py" "${ROOT}/"
cp "${SCRIPT_DIR}/server.py"   "${ROOT}/"
[ -f "${ROOT}/config.yaml" ] || cp "${SCRIPT_DIR}/config.example.yaml" "${ROOT}/config.yaml"

echo "→ Creating venv + installing deps"
[ -d "${ROOT}/venv" ] || python3 -m venv "${ROOT}/venv"
"${ROOT}/venv/bin/pip" install --quiet --upgrade pip
"${ROOT}/venv/bin/pip" install --quiet -r "${SCRIPT_DIR}/requirements.txt"

# Clean up the legacy launchd plist — lifecycle is handled by feishu-claude-bot's
# scripts/bot.sh (nohup subprocess pattern), matching CF tunnel & pm2. Nothing to load.
LEGACY_PLIST="${HOME}/Library/LaunchAgents/com.sigma.switcher.plist"
if [ -f "${LEGACY_PLIST}" ]; then
  launchctl unload "${LEGACY_PLIST}" 2>/dev/null || true
  rm -f "${LEGACY_PLIST}"
  echo "→ Removed legacy plist ${LEGACY_PLIST}"
fi

echo ""
echo "✅ Installed."
echo "Next steps:"
echo "  1. Fill SWITCHER_* vars in feishu-claude-bot/.env (accounts / IMAP / webhook)"
echo "  2. Load Chrome extension from ../extension/ (chrome://extensions → Load unpacked)"
echo "  3. Start with the bot: (cd feishu-claude-bot && bash scripts/bot.sh restart)"
echo "     Or standalone: (source .env && exec ${ROOT}/venv/bin/python3 ${ROOT}/switcher.py)"
echo "  4. Logs:  tail -f ${ROOT}/logs/switcher.log"
