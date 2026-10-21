#!/usr/bin/env python3
"""
RPi 3.5" SPI LCD Camera Streamer
--------------------------------
Streams live camera frames from Raspberry Pi CSI Camera (Picamera2) or USB V4L2
Webcam (OpenCV) directly to a 3.5-inch 480x320 SPI LCD Display.

Supports two display output modes:
  1. Direct Linux Framebuffer (/dev/fb1 or /dev/fb0) in 16-bit RGB565 (Waveshare / MHS35 / GoodTFT DTOverlay)
  2. Direct Raw SPI Bus (spidev + GPIO DC/RST for ILI9486 / ILI9488 / ST7796S controllers)

Usage:
  python3 rpi_camera_spi_stream.py --mode fb --fb-dev /dev/fb1 --width 480 --height 320 --fps 30
  python3 rpi_camera_spi_stream.py --mode spi --spi-speed 32000000 --rotation 90 --hud
"""

import argparse
import os
import signal
import struct
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

# Optional spidev + RPi.GPIO / gpiozero for raw SPI mode
try:
    import spidev
    import RPi.GPIO as GPIO
    HAS_RAW_SPI = True
except ImportError:
    HAS_RAW_SPI = False


class FramebufferDisplay:
    """
    Writes BGR888 OpenCV frames directly into a 16-bit RGB565 Linux framebuffer
    device (e.g., /dev/fb1 created by dtoverlay=piscreen,speed=32000000,rotate=90).
    Uses vectorized NumPy bit-shifting for zero-overhead conversion on ARM Cortex-A.
    """

    def __init__(self, fb_device: str = "/dev/fb1", width: int = 480, height: int = 320):
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
            self.fb_fd.write(b"\x00" * self.frame_bytes)
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
    Drives a 3.5-inch 480x320 ILI9486 / ILI9488 SPI LCD directly over /dev/spidev0.0
    when no kernel framebuffer driver is loaded.
    Default Waveshare / XPT2046 3.5" GPIO pinout (BCM numbering):
      DC  = GPIO 24 (Pin 18)
      RST = GPIO 25 (Pin 22)
      CS  = CE0     (Pin 24 / GPIO 8)
    """

    CHUNK_SIZE = 4096

    def __init__(
        self,
        bus: int = 0,
        device: int = 0,
        speed_hz: int = 32000000,
        dc_pin: int = 24,
        rst_pin: int = 25,
        width: int = 480,
        height: int = 320,
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
        # Big-endian RGB565 for direct SPI GRAM write
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

    def __init__(self, width: int = 480, height: int = 320, fps: int = 30, camera_index: int = 0, backend: str = "auto"):
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

        # Fallback or explicit OpenCV V4L2 capture
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
            # Picamera2 RGB888 returns BGR ordering in OpenCV array convention on RPi
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


def draw_hud(frame: np.ndarray, fps: float, cpu_temp: float, driver_name: str, mode_label: str) -> None:
    h, w = frame.shape[:2]
    # Top translucent telemetry bar
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (w, 26), (15, 23, 42), -1)
    cv2.addWeighted(overlay, 0.72, frame, 0.28, 0, frame)

    timestamp = datetime.now().strftime("%H:%M:%S")
    left_text = f"SPI 3.5\" {w}x{h} RGB565 | {mode_label}"
    right_text = f"{fps:4.1f} FPS | {cpu_temp:4.1f}C | {timestamp}"

    cv2.putText(frame, left_text, (8, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (248, 250, 252), 1, cv2.LINE_AA)
    cv2.putText(frame, right_text, (w - 205, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (74, 222, 128), 1, cv2.LINE_AA)

    # Center optical crosshair reticle
    cx, cy = w // 2, h // 2
    cv2.line(frame, (cx - 12, cy), (cx - 4, cy), (255, 255, 255), 1)
    cv2.line(frame, (cx + 4, cy), (cx + 12, cy), (255, 255, 255), 1)
    cv2.line(frame, (cx, cy - 12), (cx, cy - 4), (255, 255, 255), 1)
    cv2.line(frame, (cx, cy + 4), (cx, cy + 12), (255, 255, 255), 1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stream Raspberry Pi Camera to 3.5-inch 480x320 SPI Display (Framebuffer or Raw SPI)"
    )
    parser.add_argument("--mode", choices=["fb", "spi"], default="fb", help="Display transport: 'fb' (/dev/fb1) or 'spi' (spidev0.0)")
    parser.add_argument("--fb-dev", default="/dev/fb1", help="Linux framebuffer device path (default: /dev/fb1)")
    parser.add_argument("--spi-bus", type=int, default=0, help="SPI bus number (default: 0)")
    parser.add_argument("--spi-cs", type=int, default=0, help="SPI chip select 0 or 1 (default: 0)")
    parser.add_argument("--spi-speed", type=int, default=32000000, help="SPI clock frequency in Hz (default: 32000000)")
    parser.add_argument("--dc-pin", type=int, default=24, help="BCM GPIO pin for Data/Command in raw SPI mode (default: 24)")
    parser.add_argument("--rst-pin", type=int, default=25, help="BCM GPIO pin for Reset in raw SPI mode (default: 25)")
    parser.add_argument("--camera-backend", choices=["auto", "picamera2", "opencv"], default="auto", help="Camera capture backend")
    parser.add_argument("--camera-index", type=int, default=0, help="Camera index (default: 0)")
    parser.add_argument("--width", type=int, default=480, help="Display horizontal width in pixels (default: 480)")
    parser.add_argument("--height", type=int, default=320, help="Display vertical height in pixels (default: 320)")
    parser.add_argument("--fps", type=int, default=30, help="Target capture frame rate (default: 30)")
    parser.add_argument("--rotation", type=int, choices=[0, 90, 180, 270], default=0, help="Software rotation in degrees")
    parser.add_argument("--flip-h", action="store_true", help="Mirror image horizontally")
    parser.add_argument("--flip-v", action="store_true", help="Flip image vertically")
    parser.add_argument("--hud", action="store_true", default=True, help="Render on-screen FPS, CPU temp, and reticle overlay")
    parser.add_argument("--no-hud", action="store_false", dest="hud", help="Disable on-screen HUD overlay")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    running = True

    def handle_sig(signum, _frame):
        nonlocal running
        print(f"\n[INFO] Received signal {signum}, shutting down stream cleanly...")
        running = False

    signal.signal(signal.SIGINT, handle_sig)
    signal.signal(signal.SIGTERM, handle_sig)

    print(f"[INIT] Opening camera source (backend={args.camera_backend}, target={args.width}x{args.height} @ {args.fps}fps)...")
    camera = CameraSource(
        width=args.width,
        height=args.height,
        fps=args.fps,
        camera_index=args.camera_index,
        backend=args.camera_backend,
    )
    print(f"[INIT] Active camera driver: {camera.active_driver}")

    if args.mode == "fb":
        print(f"[INIT] Binding to 3.5\" SPI Framebuffer {args.fb_dev} ({args.width}x{args.height} RGB565)...")
        display = FramebufferDisplay(fb_device=args.fb_dev, width=args.width, height=args.height)
        mode_label = args.fb_dev
    else:
        print(
            f"[INIT] Binding to Raw SPI /dev/spidev{args.spi_bus}.{args.spi_cs} "
            f"@ {args.spi_speed // 1_000_000}MHz (DC=GPIO{args.dc_pin}, RST=GPIO{args.rst_pin})..."
        )
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

    print("[STREAM] Live streaming started. Press Ctrl+C to stop.")
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
            instant_fps = 1.0 / dt
            fps_smoothed = (0.88 * fps_smoothed) + (0.12 * instant_fps)

            frame_count += 1
            if frame_count % 30 == 0:
                cpu_temp = read_cpu_temp()

            if args.hud:
                draw_hud(frame, fps_smoothed, cpu_temp, camera.active_driver, mode_label)

            display.write_frame(frame)
    finally:
        camera.close()
        display.close()
        print("[CLEANUP] Camera and 3.5\" SPI Display released cleanly.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
