#!/usr/bin/env bash
# ==============================================================================
# Raspberry Pi 3.5" SPI LCD Camera Streamer - Direct Installer & Setup Script
# ==============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="rpi-spi-cam.service"

echo "==> [1/4] Installing Raspberry Pi system packages for Camera & SPI Display..."
sudo apt-get update -y
sudo apt-get install -y \
  python3-picamera2 \
  python3-opencv \
  python3-numpy \
  python3-spidev \
  python3-rpi-lgpio \
  git

echo "==> [2/4] Verifying SPI interface in /boot/firmware/config.txt..."
BOOT_CONFIG="/boot/firmware/config.txt"
if [ ! -f "$BOOT_CONFIG" ]; then
  BOOT_CONFIG="/boot/config.txt"
fi

if [ -f "$BOOT_CONFIG" ]; then
  if ! grep -q "^dtparam=spi=on" "$BOOT_CONFIG"; then
    echo "dtparam=spi=on" | sudo tee -a "$BOOT_CONFIG" >/dev/null
    echo "    Enabled dtparam=spi=on in $BOOT_CONFIG"
  else
    echo "    dtparam=spi=on is already active in $BOOT_CONFIG"
  fi
fi

echo "==> [3/4] Setting executable permissions on rpi_camera_spi_stream.py..."
chmod +x "${REPO_DIR}/rpi_camera_spi_stream.py"

echo "==> [4/4] Creating optional systemd service (${SERVICE_NAME})..."
sudo tee "/etc/systemd/system/${SERVICE_NAME}" >/dev/null <<EOF
[Unit]
Description=Raspberry Pi 3.5 inch SPI LCD Camera Streamer
After=multi-user.target

[Service]
Type=simple
User=${SUDO_USER:-$USER}
WorkingDirectory=${REPO_DIR}
ExecStart=/usr/bin/python3 ${REPO_DIR}/rpi_camera_spi_stream.py --mode fb --fb-dev /dev/fb1 --width 480 --height 320 --fps 30 --hud
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
echo ""
echo "======================================================================"
echo " Installation Complete!"
echo " Run directly now:"
echo "   python3 rpi_camera_spi_stream.py --mode fb --fb-dev /dev/fb1"
echo ""
echo " Or enable auto-start on boot:"
echo "   sudo systemctl enable --now ${SERVICE_NAME}"
echo "======================================================================"
