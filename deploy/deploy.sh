#!/usr/bin/env bash
# root-daemon 部署脚本
# 用法：sudo bash deploy.sh [your-email]
# 示例：sudo bash deploy.sh admin@example.com
set -e

EMAIL="${1:-}"
DOMAIN="approval.willson0v0.com"
APP_DIR="/home/willson0v0/approval-web"
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}"
NGINX_LINK="/etc/nginx/sites-enabled/${DOMAIN}"
SERVICE_USER="willson0v0"

if [[ $EUID -ne 0 ]]; then
  echo "请用 sudo 运行此脚本：sudo bash deploy.sh your@email.com"
  exit 1
fi

if [[ -z "$EMAIL" ]]; then
  echo "用法：sudo bash deploy.sh your@email.com"
  exit 1
fi

echo "=== [1/6] 安装 nginx + certbot ==="
apt-get update -qq
apt-get install -y nginx certbot python3-certbot-nginx

echo "=== [2/6] 部署 nginx 配置（HTTP only，先获取证书）==="
# 先写一个仅 HTTP 的临时配置，用于 certbot ACME challenge
cat > "${NGINX_CONF}" <<'NGINX_HTTP'
server {
    listen 80;
    listen [::]:80;
    server_name approval.willson0v0.com;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 200 "ok";
        add_header Content-Type text/plain;
    }
}
NGINX_HTTP

# 启用站点
if [[ ! -L "${NGINX_LINK}" ]]; then
  ln -s "${NGINX_CONF}" "${NGINX_LINK}"
fi

# 移除 default 站点（避免冲突）
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx
systemctl restart nginx

echo "=== [3/6] 申请 Let's Encrypt 证书 ==="
certbot certonly --nginx \
  -d "${DOMAIN}" \
  --email "${EMAIL}" \
  --agree-tos \
  --non-interactive

echo "=== [4/6] 部署完整 nginx 配置（含 HTTPS）==="
cp "$(dirname "$0")/nginx/${DOMAIN}.conf" "${NGINX_CONF}"
nginx -t
systemctl reload nginx

echo "=== [5/6] 创建 approval-web systemd 服务 ==="
cat > /etc/systemd/system/approval-web.service <<SERVICE
[Unit]
Description=root-daemon Approval Web Service
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=ROOT_DAEMON_DB_PATH=/var/lib/root-daemon/root-daemon.db
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/root-daemon

[Install]
WantedBy=multi-user.target
SERVICE

echo "=== [6/6] 创建 root-daemon systemd 服务 ==="
cat > /etc/systemd/system/root-daemon.service <<SERVICE
[Unit]
Description=root-daemon Privilege Task Audit Daemon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/willson0v0/root-daemon
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SERVICE

# 创建数据目录
mkdir -p /var/lib/root-daemon
chown "${SERVICE_USER}:${SERVICE_USER}" /var/lib/root-daemon
mkdir -p /var/log/root-daemon
chown root:root /var/log/root-daemon

systemctl daemon-reload

echo ""
echo "=== 部署完成！==="
echo ""
echo "后续步骤（手动执行）："
echo ""
echo "1. 构建 root-daemon："
echo "   cd ~/root-daemon && npm run build"
echo ""
echo "2. 初始化数据库（首次运行）："
echo "   cd ~/root-daemon && node dist/main.js --init-db"
echo ""
echo "3. 构建 approval-web："
echo "   cd ~/approval-web && npm run build"
echo ""
echo "4. 设置 approval-web 管理员密码："
echo "   cd ~/approval-web && node dist/scripts/gen-password.js"
echo "   # 把生成的 hash 设置到环境变量或 config.json"
echo ""
echo "5. 启动服务："
echo "   sudo systemctl enable root-daemon approval-web"
echo "   sudo systemctl start root-daemon approval-web"
echo ""
echo "6. 验证："
echo "   curl -k https://${DOMAIN}/health"
echo "   systemctl status root-daemon approval-web"
echo ""
echo "7. 确认 certbot 自动续签："
echo "   systemctl status certbot.timer"
