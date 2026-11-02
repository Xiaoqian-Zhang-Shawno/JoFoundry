#!/bin/bash
# 卸载开机自启。
set -euo pipefail
LABEL="com.dsh.research-foundry"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "已卸载 $LABEL"
