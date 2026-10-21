export interface StreamConfig {
  mode: 'fb' | 'spi';
  fbDevice: string;
  spiBus: number;
  spiCs: number;
  spiSpeedHz: number;
  dcPin: number;
  rstPin: number;
  cameraBackend: 'auto' | 'picamera2' | 'opencv';
  cameraIndex: number;
  width: number;
  height: number;
  targetFps: number;
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  hud: boolean;
  displayModel: 'waveshare35a' | 'mhs35' | 'ili9486_raw' | 'st7796s';
  gitRepoUrl: string;
  rpiHost: string;
  rpiUser: string;
  enableSystemd: boolean;
}

export const DEFAULT_CONFIG: StreamConfig = {
  mode: 'fb',
  fbDevice: '/dev/fb1',
  spiBus: 0,
  spiCs: 0,
  spiSpeedHz: 32000000,
  dcPin: 24,
  rstPin: 25,
  cameraBackend: 'auto',
  cameraIndex: 0,
  width: 480,
  height: 320,
  targetFps: 30,
  rotation: 0,
  flipH: false,
  flipV: false,
  hud: true,
  displayModel: 'waveshare35a',
  gitRepoUrl: 'https://github.com/your-org/rpi-spi-camera-streamer.git',
  rpiHost: 'raspberrypi.local',
  rpiUser: 'pi',
  enableSystemd: true,
};

export function generatePythonScript(cfg: StreamConfig): string {
  return `#!/usr/bin/env python3
"""
RPi 3.5" SPI LCD Camera Streamer
--------------------------------
Streams live camera frames from Raspberry Pi CSI Camera (Picamera2) or USB V4L2
Webcam (OpenCV) directly to a 3.5-inch ${cfg.width}x${cfg.height} SPI LCD Display.

Configured Defaults:
  - Transport Mode : ${cfg.mode === 'fb' ? `Linux Framebuffer (${cfg.fbDevice})` : `Raw SPI (/dev/spidev${cfg.spiBus}.${cfg.spiCs} @ ${cfg.spiSpeedHz / 1_000_000} MHz)`}
  - Display Model  : ${cfg.displayModel.toUpperCase()} (16-bit RGB565)
  - Camera Backend : ${cfg.cameraBackend} (Index ${cfg.cameraIndex})
  - Resolution     : ${cfg.width}x${cfg.height} @ ${cfg.targetFps} FPS (Rotation: ${cfg.rotation} deg)

Run directly on Raspberry Pi:
  python3 rpi_camera_spi_stream.py --mode ${cfg.mode} ${
    cfg.mode === 'fb'
      ? `--fb-dev ${cfg.fbDevice}`
      : `--spi-bus ${cfg.spiBus} --spi-cs ${cfg.spiCs} --spi-speed ${cfg.spiSpeedHz} --dc-pin ${cfg.dcPin} --rst-pin ${cfg.rstPin}`
  } --width ${cfg.width} --height ${cfg.height} --fps ${cfg.targetFps}${cfg.rotation ? ` --rotation ${cfg.rotation}` : ''}${cfg.flipH ? ' --flip-h' : ''}${cfg.flipV ? ' --flip-v' : ''}${cfg.hud ? ' --hud' : ' --no-hud'}
"""

import argparse
import os
import signal
import sys
import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

# Optional Picamera2 import (standard on Raspberry Pi OS Bookworm / Bullseye)
try:
    from picamera2 import Picamera2
    HAS_PICAMERA2 = True
except ImportError:
    HAS_PICAMERA2 = False

# Optional spidev + RPi.GPIO for raw SPI mode
try:
    import spidev
    import RPi.GPIO as GPIO
    HAS_RAW_SPI = True
except ImportError:
    HAS_RAW_SPI = False


class FramebufferDisplay:
    """
    Writes BGR888 OpenCV frames directly into a 16-bit RGB565 Linux framebuffer
    device (e.g., ${cfg.fbDevice} created by dtoverlay=${cfg.displayModel},speed=${cfg.spiSpeedHz},rotate=90).
    Uses vectorized NumPy bit-shifting for zero-overhead conversion on ARM Cortex-A.
    """

    def __init__(self, fb_device: str = "${cfg.fbDevice}", width: int = ${cfg.width}, height: int = ${cfg.height}):
        self.fb_device = fb_device
        self.width = width
        self.height = height
        self.frame_bytes = width * height * 2  # 16-bit RGB565 = 2 bytes per pixel
        self.fb_fd = None

        if not os.path.exists(self.fb_device):
            raise FileNotFoundError(
                f"Framebuffer device {self.fb_device} not found. "
                f"Verify SPI DTOverlay in /boot/firmware/config.txt or try --fb-dev /dev/fb0."
            )

        self.fb_fd = open(self.fb_device, "wb")

    @staticmethod
    def bgr888_to_rgb565(frame_bgr: np.ndarray) -> bytes:
        """Convert (H, W, 3) uint8 BGR frame into packed 16-bit little-endian RGB565 bytes."""
        b = frame_bgr[:, :, 0].astype(np.uint16)
        g = frame_bgr[:, :, 1].astype(np.uint16)
        r = frame_bgr[:, :, 2].astype(np.uint16)

        rgb565 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
        return rgb565.tobytes()

    def write_frame(self, frame_bgr: np.ndarray) -> None:
        if frame_bgr.shape[1] != self.width or frame_bgr.shape[0] != self.height:
            frame_bgr = cv2.resize(
                frame_bgr, (self.width, self.height), interpolation=cv2.INTER_LINEAR
            )
        raw_bytes = self.bgr888_to_rgb565(frame_bgr)
        self.fb_fd.seek(0)
        self.fb_fd.write(raw_bytes)
        self.fb_fd.flush()

    def clear(self) -> None:
        if self.fb_fd:
            self.fb_fd.seek(0)
            self.fb_fd.write(b"\\x00" * self.frame_bytes)
            self.fb_fd.flush()

    def close(self) -> None:
        if self.fb_fd:
            try:
                self.clear()
            except Exception:
                pass
            self.fb_fd.close()
            self.fb_fd = None


class RawSpiILI9486Display:
    """
    Drives a 3.5-inch ${cfg.width}x${cfg.height} ILI9486 / ILI9488 SPI LCD directly over /dev/spidev${cfg.spiBus}.${cfg.spiCs}
    when no kernel framebuffer driver is loaded.
    GPIO pinout (BCM numbering):
      DC  = GPIO ${cfg.dcPin} (Pin 18)
      RST = GPIO ${cfg.rstPin} (Pin 22)
      CS  = CE${cfg.spiCs}     (Pin ${cfg.spiCs === 0 ? '24 / GPIO 8' : '26 / GPIO 7'})
    """

    CHUNK_SIZE = 4096

    def __init__(
        self,
        bus: int = ${cfg.spiBus},
        device: int = ${cfg.spiCs},
        speed_hz: int = ${cfg.spiSpeedHz},
        dc_pin: int = ${cfg.dcPin},
        rst_pin: int = ${cfg.rstPin},
        width: int = ${cfg.width},
        height: int = ${cfg.height},
    ):
        if not HAS_RAW_SPI:
            raise RuntimeError(
                "spidev and RPi.GPIO are required for --mode spi. "
                "Install with: sudo apt install python3-spidev python3-rpi-lgpio"
            )

        self.width = width
        self.height = height
        self.dc_pin = dc_pin
        self.rst_pin = rst_pin

        GPIO.setwarnings(False)
        GPIO.setmode(GPIO.BCM)
        GPIO.setup(self.dc_pin, GPIO.OUT)
        GPIO.setup(self.rst_pin, GPIO.OUT)

        self.spi = spidev.SpiDev()
        self.spi.open(bus, device)
        self.spi.max_speed_hz = speed_hz
        self.spi.mode = 0b00

        self._init_ili9486()

    def _command(self, cmd: int) -> None:
        GPIO.output(self.dc_pin, GPIO.LOW)
        self.spi.writebytes([cmd])

    def _data(self, data: bytes | list[int]) -> None:
        GPIO.output(self.dc_pin, GPIO.HIGH)
        if isinstance(data, list):
            self.spi.writebytes(data)
        else:
            mv = memoryview(data)
            for i in range(0, len(mv), self.CHUNK_SIZE):
                self.spi.writebytes2(mv[i : i + self.CHUNK_SIZE])

    def _reset(self) -> None:
        GPIO.output(self.rst_pin, GPIO.HIGH)
        time.sleep(0.05)
        GPIO.output(self.rst_pin, GPIO.LOW)
        time.sleep(0.05)
        GPIO.output(self.rst_pin, GPIO.HIGH)
        time.sleep(0.12)

    def _init_ili9486(self) -> None:
        self._reset()
        self._command(0x11)  # Sleep Out
        time.sleep(0.12)

        self._command(0x3A)  # Interface Pixel Format
        self._data([0x55])   # 16-bit RGB565

        self._command(0x36)  # Memory Access Control (Landscape 480x320 BGR)
        self._data([0x28])

        self._command(0x29)  # Display ON
        time.sleep(0.05)

    def _set_window(self, x0: int, y0: int, x1: int, y1: int) -> None:
        self._command(0x2A)
        self._data([x0 >> 8, x0 & 0xFF, x1 >> 8, x1 & 0xFF])
        self._command(0x2B)
        self._data([y0 >> 8, y0 & 0xFF, y1 >> 8, y1 & 0xFF])
        self._command(0x2C)

    def write_frame(self, frame_bgr: np.ndarray) -> None:
        if frame_bgr.shape[1] != self.width or frame_bgr.shape[0] != self.height:
            frame_bgr = cv2.resize(
                frame_bgr, (self.width, self.height), interpolation=cv2.INTER_LINEAR
            )
        b = frame_bgr[:, :, 0].astype(np.uint16)
        g = frame_bgr[:, :, 1].astype(np.uint16)
        r = frame_bgr[:, :, 2].astype(np.uint16)
        rgb565_be = (((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)).byteswap()

        self._set_window(0, 0, self.width - 1, self.height - 1)
        self._data(rgb565_be.tobytes())

    def close(self) -> None:
        self.spi.close()
        GPIO.cleanup([self.dc_pin, self.rst_pin])


class CameraSource:
    """
    Unified camera abstraction supporting Picamera2 (CSI ribbon camera) first,
    automatically falling back to OpenCV VideoCapture (V4L2 USB camera).
    """

    def __init__(self, width: int = ${cfg.width}, height: int = ${cfg.height}, fps: int = ${cfg.targetFps}, camera_index: int = ${cfg.cameraIndex}, backend: str = "${cfg.cameraBackend}"):
        self.width = width
        self.height = height
        self.fps = fps
        self.camera_index = camera_index
        self.backend = backend
        self.picam2 = None
        self.cap = None
        self.active_driver = "unknown"

        if backend in ("auto", "picamera2") and HAS_PICAMERA2:
            try:
                self.picam2 = Picamera2(camera_num=camera_index)
                config = self.picam2.create_video_configuration(
                    main={"size": (self.width, self.height), "format": "RGB888"},
                    controls={"FrameDurationLimits": (int(1_000_000 / fps), int(1_000_000 / fps))},
                )
                self.picam2.configure(config)
                self.picam2.start()
                self.active_driver = "Picamera2 (libcamera CSI)"
                return
            except Exception as exc:
                if backend == "picamera2":
                    raise RuntimeError(f"Failed to initialize Picamera2: {exc}") from exc
                self.picam2 = None

        self.cap = cv2.VideoCapture(camera_index, cv2.CAP_V4L2)
        if not self.cap.isOpened():
            self.cap = cv2.VideoCapture(camera_index)
        if not self.cap.isOpened():
            raise RuntimeError(
                f"Could not open camera index {camera_index} via Picamera2 or V4L2 OpenCV."
            )

        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        self.cap.set(cv2.CAP_PROP_FPS, self.fps)
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self.active_driver = f"OpenCV V4L2 (/dev/video{camera_index})"

    def read_bgr(self) -> np.ndarray | None:
        if self.picam2 is not None:
            arr = self.picam2.capture_array("main")
            if arr is None:
                return None
            if arr.shape[2] == 4:
                return cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
            return arr
        if self.cap is not None:
            ok, frame = self.cap.read()
            return frame if ok else None
        return None

    def close(self) -> None:
        if self.picam2 is not None:
            self.picam2.stop()
            self.picam2.close()
        if self.cap is not None:
            self.cap.release()


def read_cpu_temp() -> float:
    temp_path = Path("/sys/class/thermal/thermal_zone0/temp")
    try:
        if temp_path.exists():
            return int(temp_path.read_text().strip()) / 1000.0
    except Exception:
        pass
    return 0.0


def apply_transform(frame: np.ndarray, rotation: int, flip_h: bool, flip_v: bool) -> np.ndarray:
    if rotation == 90:
        frame = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
    elif rotation == 180:
        frame = cv2.rotate(frame, cv2.ROTATE_180)
    elif rotation == 270:
        frame = cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)

    if flip_h and flip_v:
        frame = cv2.flip(frame, -1)
    elif flip_h:
        frame = cv2.flip(frame, 1)
    elif flip_v:
        frame = cv2.flip(frame, 0)
    return frame


def draw_hud(frame: np.ndarray, fps: float, cpu_temp: float, mode_label: str) -> None:
    h, w = frame.shape[:2]
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (w, 26), (15, 23, 42), -1)
    cv2.addWeighted(overlay, 0.72, frame, 0.28, 0, frame)

    timestamp = datetime.now().strftime("%H:%M:%S")
    left_text = f"SPI 3.5\\" {w}x{h} RGB565 | {mode_label}"
    right_text = f"{fps:4.1f} FPS | {cpu_temp:4.1f}C | {timestamp}"

    cv2.putText(frame, left_text, (8, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (248, 250, 252), 1, cv2.LINE_AA)
    cv2.putText(frame, right_text, (w - 205, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (74, 222, 128), 1, cv2.LINE_AA)

    cx, cy = w // 2, h // 2
    cv2.line(frame, (cx - 12, cy), (cx - 4, cy), (255, 255, 255), 1)
    cv2.line(frame, (cx + 4, cy), (cx + 12, cy), (255, 255, 255), 1)
    cv2.line(frame, (cx, cy - 12), (cx, cy - 4), (255, 255, 255), 1)
    cv2.line(frame, (cx, cy + 4), (cx, cy + 12), (255, 255, 255), 1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stream Raspberry Pi Camera to 3.5-inch 480x320 SPI Display (Framebuffer or Raw SPI)"
    )
    parser.add_argument("--mode", choices=["fb", "spi"], default="${cfg.mode}", help="Display transport: 'fb' or 'spi'")
    parser.add_argument("--fb-dev", default="${cfg.fbDevice}", help="Linux framebuffer device path")
    parser.add_argument("--spi-bus", type=int, default=${cfg.spiBus}, help="SPI bus number")
    parser.add_argument("--spi-cs", type=int, default=${cfg.spiCs}, help="SPI chip select 0 or 1")
    parser.add_argument("--spi-speed", type=int, default=${cfg.spiSpeedHz}, help="SPI clock frequency in Hz")
    parser.add_argument("--dc-pin", type=int, default=${cfg.dcPin}, help="BCM GPIO pin for Data/Command")
    parser.add_argument("--rst-pin", type=int, default=${cfg.rstPin}, help="BCM GPIO pin for Reset")
    parser.add_argument("--camera-backend", choices=["auto", "picamera2", "opencv"], default="${cfg.cameraBackend}")
    parser.add_argument("--camera-index", type=int, default=${cfg.cameraIndex}, help="Camera index")
    parser.add_argument("--width", type=int, default=${cfg.width}, help="Display horizontal width")
    parser.add_argument("--height", type=int, default=${cfg.height}, help="Display vertical height")
    parser.add_argument("--fps", type=int, default=${cfg.targetFps}, help="Target capture frame rate")
    parser.add_argument("--rotation", type=int, choices=[0, 90, 180, 270], default=${cfg.rotation})
    parser.add_argument("--flip-h", action="store_true", default=${cfg.flipH ? 'True' : 'False'})
    parser.add_argument("--flip-v", action="store_true", default=${cfg.flipV ? 'True' : 'False'})
    parser.add_argument("--hud", action="store_true", default=${cfg.hud ? 'True' : 'False'})
    parser.add_argument("--no-hud", action="store_false", dest="hud")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    running = True

    def handle_sig(signum, _frame):
        nonlocal running
        print(f"\\n[INFO] Received signal {signum}, shutting down stream cleanly...")
        running = False

    signal.signal(signal.SIGINT, handle_sig)
    signal.signal(signal.SIGTERM, handle_sig)

    camera = CameraSource(
        width=args.width,
        height=args.height,
        fps=args.fps,
        camera_index=args.camera_index,
        backend=args.camera_backend,
    )
    print(f"[INIT] Active camera driver: {camera.active_driver}")

    if args.mode == "fb":
        display = FramebufferDisplay(fb_device=args.fb_dev, width=args.width, height=args.height)
        mode_label = args.fb_dev
    else:
        display = RawSpiILI9486Display(
            bus=args.spi_bus,
            device=args.spi_cs,
            speed_hz=args.spi_speed,
            dc_pin=args.dc_pin,
            rst_pin=args.rst_pin,
            width=args.width,
            height=args.height,
        )
        mode_label = f"SPI{args.spi_bus}.{args.spi_cs}"

    frame_count = 0
    fps_smoothed = float(args.fps)
    last_time = time.perf_counter()
    cpu_temp = read_cpu_temp()

    try:
        while running:
            frame = camera.read_bgr()
            if frame is None:
                time.sleep(0.005)
                continue

            frame = apply_transform(frame, args.rotation, args.flip_h, args.flip_v)

            now = time.perf_counter()
            dt = max(now - last_time, 1e-6)
            last_time = now
            fps_smoothed = (0.88 * fps_smoothed) + (0.12 * (1.0 / dt))

            frame_count += 1
            if frame_count % 30 == 0:
                cpu_temp = read_cpu_temp()

            if args.hud:
                draw_hud(frame, fps_smoothed, cpu_temp, mode_label)

            display.write_frame(frame)
    finally:
        camera.close()
        display.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
`;
}

export function generateInstallScript(cfg: StreamConfig): string {
  const cliFlags =
    cfg.mode === 'fb'
      ? `--mode fb --fb-dev ${cfg.fbDevice}`
      : `--mode spi --spi-bus ${cfg.spiBus} --spi-cs ${cfg.spiCs} --spi-speed ${cfg.spiSpeedHz} --dc-pin ${cfg.dcPin} --rst-pin ${cfg.rstPin}`;

  const overlayLine =
    cfg.displayModel === 'waveshare35a'
      ? `dtoverlay=waveshare35a:rotate=90,speed=${cfg.spiSpeedHz},fps=${cfg.targetFps}`
      : cfg.displayModel === 'mhs35'
      ? `dtoverlay=mhs35:rotate=90,speed=${cfg.spiSpeedHz},fps=${cfg.targetFps}`
      : `dtoverlay=piscreen,speed=${cfg.spiSpeedHz},rotate=90`;

  return `#!/usr/bin/env bash
# ==============================================================================
# Raspberry Pi 3.5" SPI LCD Camera Streamer - Direct Installer & Setup Script
# ==============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="rpi-spi-cam.service"

echo "==> [1/4] Installing Raspberry Pi system packages for Camera & SPI Display..."
sudo apt-get update -y
sudo apt-get install -y \\
  python3-picamera2 \\
  python3-opencv \\
  python3-numpy \\
  python3-spidev \\
  python3-rpi-lgpio \\
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
  fi
  # Recommended 3.5" SPI DTOverlay for ${cfg.displayModel}:
  # ${overlayLine}
fi

echo "==> [3/4] Setting executable permissions on rpi_camera_spi_stream.py..."
chmod +x "\${REPO_DIR}/rpi_camera_spi_stream.py"

${
  cfg.enableSystemd
    ? `echo "==> [4/4] Creating systemd service (\${SERVICE_NAME})..."
sudo tee "/etc/systemd/system/\${SERVICE_NAME}" >/dev/null <<EOF
[Unit]
Description=Raspberry Pi 3.5 inch SPI LCD Camera Streamer
After=multi-user.target

[Service]
Type=simple
User=\${SUDO_USER:-\$USER}
WorkingDirectory=\${REPO_DIR}
ExecStart=/usr/bin/python3 \${REPO_DIR}/rpi_camera_spi_stream.py ${cliFlags} --width ${cfg.width} --height ${cfg.height} --fps ${cfg.targetFps}${cfg.rotation ? ` --rotation ${cfg.rotation}` : ''}${cfg.flipH ? ' --flip-h' : ''}${cfg.flipV ? ' --flip-v' : ''}${cfg.hud ? ' --hud' : ' --no-hud'}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
echo "Systemd service installed. Enable on boot with: sudo systemctl enable --now \${SERVICE_NAME}"`
    : `echo "==> [4/4] Skipping systemd service creation (disabled in config)."`
}

echo ""
echo "======================================================================"
echo " Setup Complete! Run directly now on Raspberry Pi:"
echo "   python3 rpi_camera_spi_stream.py ${cliFlags} --width ${cfg.width} --height ${cfg.height} --fps ${cfg.targetFps}"
echo "======================================================================"
`;
}

export function generateReadmeMarkdown(cfg: StreamConfig): string {
  const repoFolder = cfg.gitRepoUrl.split('/').pop()?.replace(/\.git$/, '') || 'rpi-spi-camera-streamer';
  const cliCommand = `python3 rpi_camera_spi_stream.py --mode ${cfg.mode} ${
    cfg.mode === 'fb'
      ? `--fb-dev ${cfg.fbDevice}`
      : `--spi-bus ${cfg.spiBus} --spi-cs ${cfg.spiCs} --spi-speed ${cfg.spiSpeedHz} --dc-pin ${cfg.dcPin} --rst-pin ${cfg.rstPin}`
  } --camera-backend ${cfg.cameraBackend} --width ${cfg.width} --height ${cfg.height} --fps ${cfg.targetFps}${
    cfg.rotation ? ` --rotation ${cfg.rotation}` : ''
  }${cfg.flipH ? ' --flip-h' : ''}${cfg.flipV ? ' --flip-v' : ''}${cfg.hud ? ' --hud' : ' --no-hud'}`;

  return `# Raspberry Pi 3.5" SPI Display Camera Streamer

Direct Python camera streamer for **3.5-inch ${cfg.width}×${cfg.height} SPI LCD displays** (\`ILI9486\` / \`Waveshare 3.5"\` / \`MHS35\`) on Raspberry Pi.

- **Display Transport**: ${cfg.mode === 'fb' ? `Linux Framebuffer (\`${cfg.fbDevice}\`, 16-bit RGB565)` : `Raw SPI Bus (\`/dev/spidev${cfg.spiBus}.${cfg.spiCs}\` @ ${cfg.spiSpeedHz / 1_000_000} MHz)`}
- **Camera Pipeline**: \`${cfg.cameraBackend}\` (Picamera2 CSI libcamera with automatic V4L2 OpenCV fallback)
- **Target Stream**: \`${cfg.width}x${cfg.height}\` @ \`${cfg.targetFps} FPS\` (RGB565 = \`${((cfg.width * cfg.height * 2) / 1024).toFixed(0)} KB\` per frame)

---

## 1. Clone & Run Directly on Raspberry Pi

Open a terminal on your Raspberry Pi (or connect via \`ssh ${cfg.rpiUser}@${cfg.rpiHost}\`) and run:

\`\`\`bash
# 1. Clone the repository directly on your Raspberry Pi
git clone ${cfg.gitRepoUrl}
cd ${repoFolder}

# 2. Run the automated dependency & SPI setup script
chmod +x install_rpi.sh
./install_rpi.sh

# 3. Start streaming camera directly to the 3.5" SPI display
${cliCommand}
\`\`\`

### One-Line Direct Clone & Run Command (Copy & Paste in RPi Terminal)

\`\`\`bash
git clone ${cfg.gitRepoUrl} && cd ${repoFolder} && chmod +x install_rpi.sh && ./install_rpi.sh && ${cliCommand}
\`\`\`

---

## 2. Build & Push Code from Your Workstation to Git

Run these commands in your project folder to commit the updated Python streamer and README and push to your remote repository:

\`\`\`bash
git init
git add rpi_camera_spi_stream.py install_rpi.sh README.md
git commit -m "Build and push 3.5 inch RPi SPI camera streamer + direct run README"
git branch -M main
git remote remove origin 2>/dev/null || true
git remote add origin ${cfg.gitRepoUrl}
git push -u origin main
\`\`\`

---

## 3. 3.5" SPI Display GPIO Pinout (Raspberry Pi 40-Pin Header)

| Signal | Physical Pin | BCM GPIO | Function |
| :--- | :--- | :--- | :--- |
| **5V Power** | Pin 2, Pin 4 | — | 5V Display & Backlight Supply |
| **3.3V Logic** | Pin 1, Pin 17 | — | 3.3V Logic Reference |
| **Ground** | Pin 6, 9, 14, 20, 25 | — | Common Ground |
| **SPI0 MOSI** | Pin 19 | \`GPIO 10\` | SPI Master Out Slave In |
| **SPI0 MISO** | Pin 21 | \`GPIO 9\` | SPI Master In Slave Out (Touch) |
| **SPI0 SCLK** | Pin 23 | \`GPIO 11\` | SPI Clock (\`${cfg.spiSpeedHz / 1_000_000} MHz\`) |
| **LCD CS** | Pin ${cfg.spiCs === 0 ? '24' : '26'} | \`GPIO ${cfg.spiCs === 0 ? '8' : '7'}\` | \`SPI0_CE${cfg.spiCs}_N\` Display Chip Select |
| **LCD DC** | Pin 18 | \`GPIO ${cfg.dcPin}\` | Data / Command Select |
| **LCD RST** | Pin 22 | \`GPIO ${cfg.rstPin}\` | Hardware Reset |

---

## 4. Enable \`/dev/fb1\` in \`/boot/firmware/config.txt\`

If using \`--mode fb\`, verify the following lines exist in \`/boot/firmware/config.txt\` (or \`/boot/config.txt\`):

\`\`\`ini
dtparam=spi=on
dtoverlay=${cfg.displayModel === 'ili9486_raw' ? 'piscreen' : cfg.displayModel},speed=${cfg.spiSpeedHz},rotate=90
\`\`\`

Reboot with \`sudo reboot\` and verify \`ls -l ${cfg.fbDevice}\` before launching \`rpi_camera_spi_stream.py\`.
`;
}
