#!/bin/bash
set -euo pipefail

# 用脚本自身所在目录推导项目根目录，避免 sudo 下 $HOME 变成 /root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "[1/3] Creating config directory and writing config.json..."
mkdir -p /etc/root-daemon
cp "$ROOT_DIR/setup/config.json" /etc/root-daemon/config.json
chmod 644 /etc/root-daemon/config.json
echo "  OK /etc/root-daemon/config.json"

echo "[2/3] Installing systemd service..."
cp "$ROOT_DIR/setup/root-daemon.service" /etc/systemd/system/root-daemon.service
chmod 644 /etc/systemd/system/root-daemon.service
echo "  OK /etc/systemd/system/root-daemon.service"

echo "[3/3] Enabling and starting service..."
systemctl daemon-reload
systemctl enable root-daemon
systemctl restart root-daemon
echo "  OK Service enabled and started"

echo ""
echo "--- Status ---"
sleep 2
systemctl status root-daemon --no-pager || true

echo ""
echo "--- Recent logs ---"
journalctl -u root-daemon -n 20 --no-pager || true
