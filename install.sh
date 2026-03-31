#!/bin/bash

set -e

DEBUG=false

pause() {
    if [ "$DEBUG" = true ]; then
        read -p "Press Enter to continue..."
    fi
}

echo "===== Checking Node.js Installation ====="

if command -v node >/dev/null 2>&1; then
    echo "Node.js already installed"
    node -v
    npm -v
else
    echo "Node.js not found. Installing Node.js (LTS)..."
    pause

    # Install NodeSource repo (Alma/RHEL based)
    curl -fsSL https://rpm.nodesource.com/setup_lts.x | bash -

    # Install Node.js
    dnf install -y nodejs

    echo "Node installed:"
    node -v
    npm -v
fi

echo "Node location:"
which node

pause

echo ""
echo "===== Checking Certbot Certificates ====="

# Install certbot if missing (AlmaLinux uses dnf)
if ! command -v certbot >/dev/null 2>&1; then
    echo "Certbot not installed. Installing..."
    dnf install -y certbot
fi

echo "Listing certificates:"
certbot certificates || true

pause

echo ""
echo "===== Cloning Project ====="

TARGET_DIR="/var/www/node/secure-audio-stream"

# Create directory
mkdir -p /var/www/node

# Since running as root, ensure proper ownership (important)
chown -R root:root /var/www/node

if [ -d "$TARGET_DIR/.git" ]; then
    echo "Project exists. Pulling latest changes..."
    cd "$TARGET_DIR"
    git pull
else
    echo "Cloning repository..."
    git clone https://github.com/dev-sach-in/secure-audio-stream.git "$TARGET_DIR"
    cd "$TARGET_DIR"
fi

pause

echo "===== Script Completed Successfully ====="
