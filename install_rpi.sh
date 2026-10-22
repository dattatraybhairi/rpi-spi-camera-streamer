#!/usr/bin/env bash
# ==============================================================================
# Raspberry Pi 3.5" SPI LCD Camera Streamer + Hand Gesture & Palm Reader Setup
# ==============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="rpi-spi-cam.service"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"

echo "==> [1/5] Installing Raspberry Pi system packages (Picamera2, OpenCV, SPI, eSpeak TTS)..."
sudo apt-get update -y
sudo apt-get install -y \
  python3-picamera2 \
  python3-opencv \
  python3-numpy \
  python3-spidev \
  python3-rpi-lgpio \
  python3-pip \
  espeak-ng \
  curl \
  git

echo "==> [2/5] Checking Raspberry Pi CPU for ARMv8 Hardware AES support..."
if grep -qiw "aes" /proc/cpuinfo 2>/dev/null; then
  echo "    CPU supports hardware AES (Raspberry Pi 5). Installing MediaPipe..."
  pip3 install --break-system-packages mediapipe || pip3 install mediapipe || true
  if [ ! -f "${REPO_DIR}/hand_landmarker.task" ]; then
    curl -L -sS "${MODEL_URL}" -o "${REPO_DIR}/hand_landmarker.task" || true
  fi
else
  echo "    Raspberry Pi 3 / 4 / Zero 2W detected (no hardware AES in /proc/cpuinfo)."
  echo "    Removing incompatible PyPI mediapipe/protobuf wheels that cause 'Illegal instruction'..."
  pip3 uninstall -y --break-system-packages mediapipe protobuf 2>/dev/null || true
  sudo apt-get install -y python3-protobuf || true
  echo "    Configured ARM-Safe OpenCV YCrCb+HSV Hand & Palm Gesture Reader!"
fi

echo "==> [3/5] Verifying SPI interface in /boot/firmware/config.txt..."
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

echo "==> [4/5] Setting executable permissions on rpi_camera_spi_stream.py..."
chmod +x "${REPO_DIR}/rpi_camera_spi_stream.py"

echo "==> [5/5] Creating systemd service (${SERVICE_NAME})..."
sudo tee "/etc/systemd/system/${SERVICE_NAME}" >/dev/null <<EOF
[Unit]
Description=Raspberry Pi 3.5 inch SPI LCD Camera Streamer + Hand Palm Gesture Reader
After=multi-user.target

[Service]
Type=simple
User=${SUDO_USER:-$USER}
WorkingDirectory=${REPO_DIR}
ExecStart=/usr/bin/python3 ${REPO_DIR}/rpi_camera_spi_stream.py --mode fb --fb-dev /dev/fb1 --width 480 --height 320 --fps 30 --gesture --tts --hud
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
echo ""
echo "======================================================================"
echo " Installation Complete!"
echo " Run directly now with Hand Gesture & Voice TTS:"
echo "   python3 rpi_camera_spi_stream.py --mode fb --fb-dev /dev/fb1 --gesture --tts --hud"
echo "======================================================================"
