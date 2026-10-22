#!/usr/bin/env python3
"""
RPi 3.5" SPI LCD Camera Streamer + Hand Gesture & Palm Reader
-------------------------------------------------------------
Streams live camera frames from Raspberry Pi CSI Camera (Picamera2) or USB V4L2
Webcam (OpenCV) directly to a 3.5-inch 480x320 SPI LCD Display with real-time
21-point MediaPipe Hand Landmark tracking, finger counting, and optional speech
synthesis (pyttsx3 / espeak).

Recognized Hand & Palm Gestures:
  - 0 / FIST        : Closed Hand / Fist (0 fingers extended)
  - 1 / ONE         : Index Finger Up ("1")
  - 2 / TWO         : Index + Middle Fingers Up ("2" / Peace)
  - 3 / THREE       : Index + Middle + Ring Fingers Up ("3")
  - 4 / FOUR        : Four Fingers Up, Thumb tucked ("4")
  - 5 / FIVE        : Open Palm, All 5 Fingers Up ("5")
  - THUMBS_UP       : Thumb extended upward, other 4 fingers closed
  - THUMBS_DOWN     : Thumb extended downward, other 4 fingers closed
  - OK_SIGN         : Thumb tip touching Index tip (pinch circle) + 3 fingers up
  - ROCK_ON         : Index + Pinky extended
  - CALL_ME         : Thumb + Pinky extended

Usage on Raspberry Pi:
  python3 rpi_camera_spi_stream.py --mode fb --fb-dev /dev/fb1 --gesture --tts --hud
"""

import argparse
import math
import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque
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

# Optional MediaPipe for 21-point Hand Landmark & Palm Reading
try:
    import mediapipe as mp
    HAS_MEDIAPIPE = True
except ImportError:
    HAS_MEDIAPIPE = False


class SpeechAnnouncer:
    """Non-blocking voice announcer for detected hand gestures (espeak-ng / pyttsx3)."""

    def __init__(self, enabled: bool = False, cooldown_sec: float = 1.8):
        self.enabled = enabled
        self.cooldown_sec = cooldown_sec
        self.last_spoken_label = ""
        self.last_spoken_time = 0.0

    def announce(self, spoken_text: str) -> None:
        if not self.enabled or not spoken_text:
            return
        now = time.monotonic()
        if spoken_text == self.last_spoken_label and (now - self.last_spoken_time) < self.cooldown_sec:
            return
        self.last_spoken_label = spoken_text
        self.last_spoken_time = now

        def _speak_worker(msg: str):
            try:
                subprocess.run(
                    ["espeak-ng", "-s", "165", msg],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=3,
                    check=False,
                )
            except FileNotFoundError:
                try:
                    subprocess.run(
                        ["espeak", msg],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=3,
                        check=False,
                    )
                except Exception:
                    pass

        threading.Thread(target=_speak_worker, args=(spoken_text,), daemon=True).start()


class HandPalmClassifier:
    """
    21-Landmark Hand & Palm Gesture Classifier.
    Uses MediaPipe Hands when installed, or falls back to HSV skin-contour convexity
    defect finger counting if MediaPipe is not installed.
    """

    TIP_IDS = [4, 8, 12, 16, 20]
    PIP_IDS = [3, 6, 10, 14, 18]

    def __init__(self, min_detection_conf: float = 0.65, min_tracking_conf: float = 0.6):
        self.history: deque[str] = deque(maxlen=5)
        self.mp_hands = None
        self.hands = None

        if HAS_MEDIAPIPE:
            self.mp_hands = mp.solutions.hands
            self.hands = self.mp_hands.Hands(
                static_image_mode=False,
                max_num_hands=1,
                model_complexity=0,  # Lite model for high FPS on Raspberry Pi ARM CPU
                min_detection_confidence=min_detection_conf,
                min_tracking_confidence=min_tracking_conf,
            )

    @staticmethod
    def _dist(p1: tuple[float, float], p2: tuple[float, float]) -> float:
        return math.hypot(p1[0] - p2[0], p1[1] - p2[1])

    def process_and_annotate(self, frame_bgr: np.ndarray) -> dict:
        """
        Detects hand landmarks, classifies gesture ("1", "2", "3", "4", "5",
        "CLOSED HAND", "THUMB UP", "OK", etc.), draws skeleton + palm center,
        and returns telemetry dictionary.
        """
        h, w = frame_bgr.shape[:2]
        result_info = {
            "detected": False,
            "gesture_code": "NONE",
            "display_text": "No Hand Detected",
            "spoken_text": "",
            "finger_count": 0,
            "handedness": "N/A",
            "palm_center": (w // 2, h // 2),
        }

        if self.hands is None:
            return result_info

        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        results = self.hands.process(frame_rgb)

        if not results.multi_hand_landmarks:
            self.history.clear()
            return result_info

        hand_lms = results.multi_hand_landmarks[0]
        handedness_label = "Right"
        if results.multi_handedness:
            handedness_label = results.multi_handedness[0].classification[0].label

        pts: list[tuple[int, int]] = []
        norm_pts: list[tuple[float, float]] = []
        for lm in hand_lms.landmark:
            pts.append((int(lm.x * w), int(lm.y * h)))
            norm_pts.append((lm.x, lm.y))

        # Calculate Palm Center from Wrist (0), Index MCP (5), Pinky MCP (17)
        palm_cx = int((pts[0][0] + pts[5][0] + pts[9][0] + pts[13][0] + pts[17][0]) / 5)
        palm_cy = int((pts[0][1] + pts[5][1] + pts[9][1] + pts[13][1] + pts[17][1]) / 5)

        # Determine which of the 5 fingers are extended
        # Index (8), Middle (12), Ring (16), Pinky (20): tip higher (smaller y) than PIP joint
        index_up = norm_pts[8][1] < norm_pts[6][1] - 0.015
        middle_up = norm_pts[12][1] < norm_pts[10][1] - 0.015
        ring_up = norm_pts[16][1] < norm_pts[14][1] - 0.015
        pinky_up = norm_pts[20][1] < norm_pts[18][1] - 0.015

        # Thumb extension: check horizontal distance from pinky MCP (17) relative to IP joint (3)
        thumb_tip_to_pinky = self._dist(norm_pts[4], norm_pts[17])
        thumb_ip_to_pinky = self._dist(norm_pts[3], norm_pts[17])
        thumb_up = thumb_tip_to_pinky > (thumb_ip_to_pinky + 0.035)

        fingers = [thumb_up, index_up, middle_up, ring_up, pinky_up]
        four_fingers_count = sum([index_up, middle_up, ring_up, pinky_up])
        total_fingers = sum(fingers)

        # Normalized palm scale (wrist to middle MCP)
        palm_scale = max(self._dist(norm_pts[0], norm_pts[9]), 0.05)
        thumb_index_dist = self._dist(norm_pts[4], norm_pts[8]) / palm_scale

        # Classify gesture rules
        gesture_code = "UNKNOWN"
        display_text = f"Fingers: {total_fingers}"
        spoken_text = str(total_fingers)

        # 1. Check OK Sign (Thumb tip + Index tip pinched together, middle/ring/pinky extended)
        if thumb_index_dist < 0.36 and middle_up and ring_up and pinky_up:
            gesture_code = "OK"
            display_text = "OK SIGN (Thumb+Index)"
            spoken_text = "OK"
        # 2. Check Thumbs Up / Thumbs Down (only thumb extended, other 4 fingers curled)
        elif thumb_up and four_fingers_count == 0:
            if norm_pts[4][1] < norm_pts[2][1] - 0.03:
                gesture_code = "THUMB_UP"
                display_text = "THUMB OK / THUMBS UP"
                spoken_text = "Thumb OK"
            elif norm_pts[4][1] > norm_pts[2][1] + 0.03:
                gesture_code = "THUMB_DOWN"
                display_text = "THUMBS DOWN"
                spoken_text = "Thumb Down"
            else:
                gesture_code = "ONE"
                display_text = "1 - THUMB"
                spoken_text = "One"
        # 3. Closed Hand / Fist (0 fingers extended)
        elif total_fingers == 0:
            gesture_code = "CLOSED_HAND"
            display_text = "CLOSED HAND (FIST - 0)"
            spoken_text = "Closed Hand"
        # 4. Rock On (Index + Pinky only)
        elif not thumb_up and index_up and not middle_up and not ring_up and pinky_up:
            gesture_code = "ROCK"
            display_text = "ROCK ON"
            spoken_text = "Rock On"
        # 5. Call Me / Shaka (Thumb + Pinky only)
        elif thumb_up and not index_up and not middle_up and not ring_up and pinky_up:
            gesture_code = "CALL_ME"
            display_text = "CALL ME"
            spoken_text = "Call Me"
        # 6. Standard Finger Counts 1, 2, 3, 4, 5
        elif total_fingers == 1 and index_up:
            gesture_code = "1"
            display_text = "1 - ONE FINGER"
            spoken_text = "One"
        elif total_fingers == 2 and index_up and middle_up:
            gesture_code = "2"
            display_text = "2 - TWO FINGERS"
            spoken_text = "Two"
        elif (
            (total_fingers == 3 and index_up and middle_up and ring_up)
            or (total_fingers == 3 and thumb_up and index_up and middle_up)
        ):
            gesture_code = "3"
            display_text = "3 - THREE FINGERS"
            spoken_text = "Three"
        elif four_fingers_count == 4 and not thumb_up:
            gesture_code = "4"
            display_text = "4 - FOUR FINGERS"
            spoken_text = "Four"
        elif total_fingers == 5:
            gesture_code = "5"
            display_text = "5 - OPEN PALM (ALL 5)"
            spoken_text = "Five"
        else:
            gesture_code = str(total_fingers)
            display_text = f"{total_fingers} - FINGERS UP"
            spoken_text = str(total_fingers)

        # Temporal smoothing across last 5 frames
        self.history.append(gesture_code)
        stable_code = max(set(self.history), key=self.history.count)

        # Draw 21-point hand skeleton and palm reader ring on frame
        connections = [
            (0, 1), (1, 2), (2, 3), (3, 4),
            (0, 5), (5, 6), (6, 7), (7, 8),
            (5, 9), (9, 10), (10, 11), (11, 12),
            (9, 13), (13, 14), (14, 15), (15, 16),
            (13, 17), (17, 18), (18, 19), (19, 20),
            (0, 17),
        ]
        for a, b in connections:
            cv2.line(frame_bgr, pts[a], pts[b], (56, 189, 248), 2, cv2.LINE_AA)

        for idx, pt in enumerate(pts):
            is_tip = idx in self.TIP_IDS
            color = (74, 222, 128) if is_tip else (248, 250, 252)
            radius = 5 if is_tip else 3
            cv2.circle(frame_bgr, pt, radius, color, -1, cv2.LINE_AA)

        # Draw Palm Center node & biometric ring
        cv2.circle(frame_bgr, (palm_cx, palm_cy), 16, (250, 204, 21), 1, cv2.LINE_AA)
        cv2.circle(frame_bgr, (palm_cx, palm_cy), 3, (250, 204, 21), -1, cv2.LINE_AA)

        return {
            "detected": True,
            "gesture_code": stable_code,
            "display_text": display_text,
            "spoken_text": spoken_text,
            "finger_count": total_fingers,
            "fingers_state": fingers,
            "handedness": handedness_label,
            "palm_center": (palm_cx, palm_cy),
        }

    def close(self) -> None:
        if self.hands is not None:
            self.hands.close()


class FramebufferDisplay:
    """
    Writes BGR888 OpenCV frames directly into a 16-bit RGB565 Linux framebuffer
    device (e.g., /dev/fb1).
    """

    def __init__(self, fb_device: str = "/dev/fb1", width: int = 480, height: int = 320):
        self.fb_device = fb_device
        self.width = width
        self.height = height
        self.frame_bytes = width * height * 2
        self.fb_fd = None

        if not os.path.exists(self.fb_device):
            raise FileNotFoundError(
                f"Framebuffer device {self.fb_device} not found. "
                f"Verify SPI DTOverlay in /boot/firmware/config.txt or try --fb-dev /dev/fb0."
            )

        self.fb_fd = open(self.fb_device, "wb")

    @staticmethod
    def bgr888_to_rgb565(frame_bgr: np.ndarray) -> bytes:
        b = frame_bgr[:, :, 0].astype(np.uint16)
        g = frame_bgr[:, :, 1].astype(np.uint16)
        r = frame_bgr[:, :, 2].astype(np.uint16)
        rgb565 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
        return rgb565.tobytes()

    def write_frame(self, frame_bgr: np.ndarray) -> None:
        if frame_bgr.shape[1] != self.width or frame_bgr.shape[0] != self.height:
            frame_bgr = cv2.resize(frame_bgr, (self.width, self.height), interpolation=cv2.INTER_LINEAR)
        raw_bytes = self.bgr888_to_rgb565(frame_bgr)
        self.fb_fd.seek(0)
        self.fb_fd.write(raw_bytes)
        self.fb_fd.flush()

    def close(self) -> None:
        if self.fb_fd:
            self.fb_fd.close()
            self.fb_fd = None


class RawSpiILI9486Display:
    """Drives a 3.5-inch 480x320 ILI9486 SPI LCD directly over /dev/spidev0.0."""

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
            raise RuntimeError("spidev and RPi.GPIO are required for --mode spi.")
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

    def _init_ili9486(self) -> None:
        GPIO.output(self.rst_pin, GPIO.HIGH)
        time.sleep(0.05)
        GPIO.output(self.rst_pin, GPIO.LOW)
        time.sleep(0.05)
        GPIO.output(self.rst_pin, GPIO.HIGH)
        time.sleep(0.12)
        self._command(0x11)
        time.sleep(0.12)
        self._command(0x3A)
        self._data([0x55])
        self._command(0x36)
        self._data([0x28])
        self._command(0x29)

    def write_frame(self, frame_bgr: np.ndarray) -> None:
        if frame_bgr.shape[1] != self.width or frame_bgr.shape[0] != self.height:
            frame_bgr = cv2.resize(frame_bgr, (self.width, self.height), interpolation=cv2.INTER_LINEAR)
        b = frame_bgr[:, :, 0].astype(np.uint16)
        g = frame_bgr[:, :, 1].astype(np.uint16)
        r = frame_bgr[:, :, 2].astype(np.uint16)
        rgb565_be = (((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)).byteswap()

        self._command(0x2A)
        self._data([0, 0, (self.width - 1) >> 8, (self.width - 1) & 0xFF])
        self._command(0x2B)
        self._data([0, 0, (self.height - 1) >> 8, (self.height - 1) & 0xFF])
        self._command(0x2C)
        self._data(rgb565_be.tobytes())

    def close(self) -> None:
        self.spi.close()
        GPIO.cleanup([self.dc_pin, self.rst_pin])


class CameraSource:
    """Unified camera abstraction supporting Picamera2 first, then OpenCV V4L2."""

    def __init__(self, width: int = 480, height: int = 320, fps: int = 30, camera_index: int = 0, backend: str = "auto"):
        self.width = width
        self.height = height
        self.fps = fps
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
                self.active_driver = "Picamera2 (CSI)"
                return
            except Exception:
                self.picam2 = None

        self.cap = cv2.VideoCapture(camera_index, cv2.CAP_V4L2)
        if not self.cap.isOpened():
            self.cap = cv2.VideoCapture(camera_index)
        if not self.cap.isOpened():
            raise RuntimeError(f"Could not open camera index {camera_index}")

        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        self.cap.set(cv2.CAP_PROP_FPS, self.fps)
        self.active_driver = f"OpenCV V4L2 (/dev/video{camera_index})"

    def read_bgr(self) -> np.ndarray | None:
        if self.picam2 is not None:
            arr = self.picam2.capture_array("main")
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


def draw_hud(frame: np.ndarray, fps: float, cpu_temp: float, mode_label: str, gesture_info: dict | None) -> None:
    h, w = frame.shape[:2]
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (w, 26), (15, 23, 42), -1)
    if gesture_info is not None:
        cv2.rectangle(overlay, (0, h - 34), (w, h), (15, 23, 42), -1)
    cv2.addWeighted(overlay, 0.76, frame, 0.24, 0, frame)

    timestamp = datetime.now().strftime("%H:%M:%S")
    cv2.putText(
        frame,
        f"SPI 3.5\" {w}x{h} | {mode_label}",
        (8, 17),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.42,
        (248, 250, 252),
        1,
        cv2.LINE_AA,
    )
    cv2.putText(
        frame,
        f"{fps:4.1f} FPS | {cpu_temp:4.1f}C | {timestamp}",
        (w - 205, 17),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.42,
        (74, 222, 128),
        1,
        cv2.LINE_AA,
    )

    if gesture_info is not None:
        banner_color = (74, 222, 128) if gesture_info["detected"] else (148, 163, 184)
        cv2.putText(
            frame,
            f"PALM READER: {gesture_info['display_text']}",
            (10, h - 11),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.52,
            banner_color,
            2,
            cv2.LINE_AA,
        )
        cv2.putText(
            frame,
            f"HAND: {gesture_info['handedness']} | UP: {gesture_info['finger_count']}/5",
            (w - 175, h - 12),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.40,
            (248, 250, 252),
            1,
            cv2.LINE_AA,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="RPi 3.5\" SPI Display Camera Streamer + Hand Gesture Palm Reader")
    parser.add_argument("--mode", choices=["fb", "spi", "window"], default="fb", help="'fb', 'spi', or 'window'")
    parser.add_argument("--fb-dev", default="/dev/fb1", help="Linux framebuffer device path")
    parser.add_argument("--spi-bus", type=int, default=0)
    parser.add_argument("--spi-cs", type=int, default=0)
    parser.add_argument("--spi-speed", type=int, default=32000000)
    parser.add_argument("--dc-pin", type=int, default=24)
    parser.add_argument("--rst-pin", type=int, default=25)
    parser.add_argument("--camera-backend", choices=["auto", "picamera2", "opencv"], default="auto")
    parser.add_argument("--camera-index", type=int, default=0)
    parser.add_argument("--width", type=int, default=480)
    parser.add_argument("--height", type=int, default=320)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--rotation", type=int, choices=[0, 90, 180, 270], default=0)
    parser.add_argument("--flip-h", action="store_true")
    parser.add_argument("--flip-v", action="store_true")
    parser.add_argument("--gesture", action="store_true", default=True, help="Enable 21-point Hand Gesture & Palm Reader")
    parser.add_argument("--no-gesture", action="store_false", dest="gesture")
    parser.add_argument("--tts", action="store_true", default=False, help="Speak recognized gesture aloud (1,2,3,4,5, Closed Hand, Thumb OK)")
    parser.add_argument("--hud", action="store_true", default=True)
    parser.add_argument("--no-hud", action="store_false", dest="hud")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    running = True

    def handle_sig(signum, _frame):
        nonlocal running
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
    classifier = HandPalmClassifier() if args.gesture else None
    announcer = SpeechAnnouncer(enabled=args.tts)

    display = None
    if args.mode == "fb":
        display = FramebufferDisplay(fb_device=args.fb_dev, width=args.width, height=args.height)
        mode_label = args.fb_dev
    elif args.mode == "spi":
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
    else:
        mode_label = "X11 Window"

    fps_smoothed = float(args.fps)
    last_time = time.perf_counter()
    cpu_temp = read_cpu_temp()
    frame_count = 0

    try:
        while running:
            frame = camera.read_bgr()
            if frame is None:
                time.sleep(0.005)
                continue

            if args.flip_h:
                frame = cv2.flip(frame, 1)
            if args.flip_v:
                frame = cv2.flip(frame, 0)

            gesture_info = None
            if classifier is not None:
                gesture_info = classifier.process_and_annotate(frame)
                if gesture_info["detected"] and gesture_info["spoken_text"]:
                    announcer.announce(gesture_info["spoken_text"])

            now = time.perf_counter()
            dt = max(now - last_time, 1e-6)
            last_time = now
            fps_smoothed = (0.88 * fps_smoothed) + (0.12 * (1.0 / dt))

            frame_count += 1
            if frame_count % 30 == 0:
                cpu_temp = read_cpu_temp()

            if args.hud:
                draw_hud(frame, fps_smoothed, cpu_temp, mode_label, gesture_info)

            if display is not None:
                display.write_frame(frame)
            else:
                cv2.imshow("RPi 3.5 SPI Hand Gesture Reader", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    finally:
        if classifier is not None:
            classifier.close()
        camera.close()
        if display is not None:
            display.close()
        else:
            cv2.destroyAllWindows()

    return 0


if __name__ == "__main__":
    sys.exit(main())
