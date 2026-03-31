#!/bin/bash

set -e

DEBUG=true

pause() {
    if [ "$DEBUG" = true ]; then
        read -p "Press Enter to continue..."
    fi
}


if [ "$EUID" -ne 0 ]; then
  echo "Please run as root"
  exit 1
fi

echo "===== Preparing System ====="

# Ensure curl exists
if ! command -v curl >/dev/null 2>&1; then
    echo "Installing curl..."
    dnf install -y curl
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "Installing jq..."
    dnf install -y jq >/dev/null
fi

# Ensure dnf plugins (needed sometimes for NodeSource)
dnf install -y dnf-plugins-core >/dev/null 2>&1 || true


echo ""
echo "===== Checking Node.js Installation ====="
pause

# Check if node is installed
if command -v node >/dev/null 2>&1 && node -v >/dev/null 2>&1; then
    echo "Node.js is already installed."
    echo "Node version: $(node -v)"
    echo "npm version: $(npm -v)"
else
    echo "Node.js not found. Installing Node.js (LTS)..."
    pause

    # Install NodeSource repo (Alma/RHEL based)
    curl -fsSL https://rpm.nodesource.com/setup_lts.x | bash -

    # Install Node.js
    dnf install -y nodejs

    # Verify installation
    echo "Verifying installation..."
    echo "Node version: $(node -v)"
    echo "npm version: $(npm -v)"
fi

# Show installation path of node
echo "Node location:"
which node


echo ""
echo "===== Checking Certbot Certificates ====="
pause

# Check certbot
if ! command -v certbot >/dev/null 2>&1; then
    echo "Certbot not installed. Installing..."
    dnf install -y certbot
fi

echo ""
echo "Extracted Domains:"
certbot certificates 2>/dev/null | awk -F: '/Domains/ {print $2}' || echo "No domains found"


echo ""
echo "===== Configuration Setup ====="
pause


CONFIG_FILE="/var/www/node/secure-audio-stream/config.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: $CONFIG_FILE not found"
    exit 1
fi

# Get default domain from certbot
DEFAULT_DOMAIN=$(certbot certificates 2>/dev/null | awk -F: '/Domains/ {print $2}' | awk '{print $1}' | head -n1)
DEFAULT_DOMAIN=${DEFAULT_DOMAIN:-"example.com"}

# User inputs
read -p "Enter domain [${DEFAULT_DOMAIN}]: " DOMAIN
DOMAIN=${DOMAIN:-$DEFAULT_DOMAIN}

read -p "Enter port [5044]: " PORT
PORT=${PORT:-5044}

read -p "Enter log retention days [90]: " LOG_DAYS
LOG_DAYS=${LOG_DAYS:-90}

# Update config.json safely
tmpfile=$(mktemp)

jq \
  --arg domain "$DOMAIN" \
  --argjson port "$PORT" \
  --argjson log_days "$LOG_DAYS" \
  '
  .domain = $domain
  | .port = $port
  | .log_retention_days = $log_days
  ' "$CONFIG_FILE" > "$tmpfile" && mv "$tmpfile" "$CONFIG_FILE"

echo ""
echo "Updated config.json:"
cat "$CONFIG_FILE"



echo ""
echo "===== Creating log directory ====="
pause


LOG_DIR="/var/log/secure-audio-stream"
mkdir -p "$LOG_DIR"
echo "  ✓ $LOG_DIR created"


echo ""
echo "===== Installing Node dependencies ====="
pause


cd /var/www/node/secure-audio-stream
echo "Installing Node dependencies..."
npm install



if ss -tuln | grep -q ":$PORT "; then
  echo "WARNING: Port $PORT is already in use"
  exit 1
fi



echo ""
echo "===== Installing systemd service ====="
pause

NODE_PATH=$(command -v node || true)

if [ -z "$NODE_PATH" ]; then
  echo "ERROR: Node binary not found even after installation"
  exit 1
fi
  
echo "Detected Node path: $NODE_PATH"

rm -f /etc/systemd/system/secure-audio-stream.service

cat > /etc/systemd/system/secure-audio-stream.service <<EOF
[Unit]
Description=Secure Audio Stream Server (Express + WebSocket)
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User=root
WorkingDirectory=/var/www/node/secure-audio-stream
ExecStart=$NODE_PATH /var/www/node/secure-audio-stream/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/log/secure-audio-stream
ReadOnlyPaths=/var/spool/asterisk/monitorDONE /var/spool/asterisk/monitorDONE/MP3 /etc/letsencrypt

[Install]
WantedBy=multi-user.target
EOF


echo ""
echo "===== Enabling and Starting service ====="
pause


systemctl daemon-reload
echo "  ✓ Service installed (3 restart retries within 60s)"


echo ""
echo "Starting server ..."
systemctl enable secure-audio-stream
sleep 2

systemctl restart secure-audio-stream
sleep 2

if systemctl is-active --quiet secure-audio-stream; then
  echo "  ✓ Server is running!"
else
  echo "  ✗ Failed to start — check: journalctl -u secure-audio-stream -n 40"
fi



echo "===== Script Completed ====="
echo ""
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║  DONE                                             ║"
echo "  ╠═══════════════════════════════════════════════════╣"
echo "  ║                                                   ║"
echo "  ║  Logs:                                            ║"
echo "  ║    /var/log/secure-audio-stream/access-YYYY-MM-DD.log"
echo "  ║    tail -f /var/log/secure-audio-stream/access-\$(date +%F).log"
echo "  ║                                                   ║"
echo "  ║  Restart policy:                                  ║"
echo "  ║    3 retries within 60s, then stops               ║"
echo "  ║    systemctl reset-failed secure-audio-stream     ║"
echo "  ║    (to reset counter after fixing the issue)      ║"
echo "  ║                                                   ║"
echo "  ║  Commands:                                        ║"
echo "  ║    systemctl status secure-audio-stream           ║"
echo "  ║    systemctl restart secure-audio-stream          ║"
echo "  ║    journalctl -fu secure-audio-stream             ║"
echo "  ║                                                   ║"
echo "  ║  ⚠  Edit /var/www/node/secure-audio-stream/config.json       ║"
echo "  ║     to change USERS passwords!                    ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo ""

