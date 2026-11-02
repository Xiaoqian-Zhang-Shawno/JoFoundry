#!/bin/bash
# 把科研圆桌看板装成开机自启（macOS LaunchAgent）。
#   ./scripts/install-launchagent.sh            # 装
#   ./scripts/install-launchagent.sh --port 9000
# 卸载：./scripts/uninstall-launchagent.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
PORT="8787"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$NODE" ]; then
  echo "找不到 node，请先确认 Node 在 PATH 里" >&2
  exit 1
fi

LABEL="com.dsh.research-foundry"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.dsh/research-foundry/logs"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/lib/server.mjs</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/server.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/server.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

# 先停掉可能在跑的实例，避免端口占用
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "已安装：$PLIST"
echo "看板：http://127.0.0.1:$PORT/"
echo "日志：$LOG_DIR/server.out.log"
echo "卸载：$ROOT/scripts/uninstall-launchagent.sh"
