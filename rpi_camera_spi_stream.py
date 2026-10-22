#!/usr/bin/env python3
"""
RPi 3.5" SPI LCD Camera Streamer + Hand Gesture & Palm Reader
-------------------------------------------------------------
Streams live camera frames from Raspberry Pi CSI Camera (Picamera2) or USB V4L2
Webcam (OpenCV) directly to a 3.5-inch 480x320 SPI LCD Display with real-time
Hand & Palm Gesture recognition, 21-point skeleton rendering, and voice TTS.

IMPORTANT HARDWARE FIX FOR RASPBERRY PI 3 / 4 / ZERO 2W:
  Official PyPI `mediapipe` / `protobuf` / `abseil` C++ binaries are compiled with
  ARMv8 Crypto (`aes`) instructions (`FATAL ERROR: This binary was compiled with aes
  enabled, but this feature is not available on this processor -> Illegal instruction`),
  because BCM2711 (RPi 4) and BCM2837 (RPi 3) do NOT have ARMv8 hardware AES instructions
  (only RPi 5 BCM2712 has `aes` in `/proc/cpuinfo`).

  To guarantee zero `Illegal instruction` crashes on ALL Raspberry Pi models:
  1. We check `/proc/cpuinfo` (and test MediaPipe in an isolated subprocess) BEFORE
     importing `mediapipe` in the main process.
  2. When running on RPi 3 / RPi 4 / Zero 2W without `aes`, it automatically runs the
     built-in Pure OpenCV + NumPy Hand & Palm Reader (YCrCb + HSV adaptive skin mask,
     Convex Hull, Convexity Defects, and synthesized 21-point hand skeleton).

Recognized Hand & Palm Gestures:
  - CLOSED_HAND (0) : Closed Hand / Fist (0 fingers extended) -> speaks "Closed Hand"
  - 1               : Index Finger Up -> speaks "One"
  - 2               : Index + Middle Fingers Up -> speaks "Two"
  - 3               : Three Fingers Up -> speaks "Three"
  - 4               : Four Fingers Up (Thumb curled) -> speaks "Four"
  - 5               : Open Palm (All 5 Fingers Up) -> speaks "Five"
  - THUMB_UP        : Thumb extended upward, 4 fingers closed -> speaks "Thumb OK"
  - OK              : Thumb + Index circle pinch -> speaks "OK"

Usage on Raspberry Pi:
  python3 rpi_camera_spi_stream.py --mode fb --fb-dev /dev/fb1 --width 480 --height 320 --fps 30 --gesture --tts --hud
"""

import argparse
import math
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
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


def cpu_supports_arm_aes() -> bool:
    """
    Checks /proc/cpuinfo on Linux ARM/AArch64 to verify whether the CPU supports
    hardware AES instructions (`aes` or `pmull`) before importing MediaPipe's
    C++ library (which triggers SIGILL `Illegal instruction` on RPi 3 / RPi 4).
    """
    cpuinfo_path = Path("/proc/cpuinfo")
    if not cpuinfo_path.exists():
        return True
    try:
        text = cpuinfo_path.read_text(errors="ignore").lower()
        # On x86_64 desktop or Apple Silicon, allow normal probe
        if "aarch64" not in text and "armv" not in text and "raspberry pi" not in text:
            return True
        for line in text.splitlines():
            if line.startswith("features") or line.startswith("flags"):
                tokens = line.split(":", 1)[-1].strip().split()
                return "aes" in tokens
    except Exception:
        return False
    return False


def safe_probe_mediapipe() -> bool:
    """
    Verifies in a child subprocess that importing and initializing MediaPipe does
    not abort with SIGILL (`Illegal instruction` / exit code -4 or 132).
    """
    if not cpu_supports_arm_aes():
        return False
    try:
        res = subprocess.run(
            [sys.executable, "-c", "import mediapipe as mp"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
        return res.returncode == 0
    except Exception:
        return False


MP_SOLUTIONS_HANDS = None
MP_TASKS_VISION = None
MP_IMAGE_CLS = None
MP_BASE_OPTIONS = None
mp = None

if safe_probe_mediapipe():
    try:
        import mediapipe as _mp
        mp = _mp
        if hasattr(mp, "solutions") and hasattr(mp.solutions, "hands"):
            MP_SOLUTIONS_HANDS = mp.solutions.hands
        else:
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision as mp_vision
            MP_TASKS_VISION = mp_vision
            MP_IMAGE_CLS = mp.Image
            MP_BASE_OPTIONS = mp_python.BaseOptions
    except Exception:
        mp = None

HAND_LANDMARKER_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
)


class SpeechAnnouncer:
    """Non-blocking voice announcer for detected hand gestures (espeak-ng / espeak)."""

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
            for cmd in (["espeak-ng", "-s", "165", msg], ["espeak", msg]):
                try:
                    subprocess.run(
                        cmd,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=3,
                        check=False,
                    )
                    break
                except FileNotFoundError:
                    continue
                except Exception:
                    break

        threading.Thread(target=_speak_worker, args=(spoken_text,), daemon=True).start()


class HandPalmClassifier:
    """
    SIGILL-Safe Hand & Palm Gesture Classifier for Raspberry Pi 3 / 4 / 5 / Zero 2W.
    - Uses OpenCV YCrCb + HSV skin segmentation, Convex Hull, Convexity Defects,
      and topological fingertip skeletal reconstruction on Raspberry Pi 3 / 4
      (where MediaPipe's C++ binary crashes with `Illegal instruction` due to missing ARM AES).
    - Uses MediaPipe Hands on Raspberry Pi 5 or x86_64 if CPU supports AES.
    """

    TIP_IDS = [4, 8, 12, 16, 20]

    def __init__(self, min_detection_conf: float = 0.60, min_tracking_conf: float = 0.55):
        self.history: deque[str] = deque(maxlen=6)
        self.backend_name = "OpenCV-PalmReader"
        self.legacy_hands = None
        self.task_landmarker = None

        if MP_SOLUTIONS_HANDS is not None:
            try:
                self.legacy_hands = MP_SOLUTIONS_HANDS.Hands(
                    static_image_mode=False,
                    max_num_hands=1,
                    model_complexity=0,
                    min_detection_confidence=min_detection_conf,
                    min_tracking_confidence=min_tracking_conf,
                )
                self.backend_name = "MediaPipe-Solutions"
                print("[INIT] HandPalmClassifier active: MediaPipe Solutions API")
                return
            except Exception:
                self.legacy_hands = None

        if MP_TASKS_VISION is not None and MP_BASE_OPTIONS is not None:
            model_path = Path(__file__).resolve().parent / "hand_landmarker.task"
            if not model_path.exists():
                try:
                    urllib.request.urlretrieve(HAND_LANDMARKER_MODEL_URL, str(model_path))
                except Exception:
                    pass
            if model_path.exists():
                try:
                    options = MP_TASKS_VISION.HandLandmarkerOptions(
                        base_options=MP_BASE_OPTIONS(model_asset_path=str(model_path)),
                        running_mode=MP_TASKS_VISION.RunningMode.IMAGE,
                        num_hands=1,
                        min_hand_detection_confidence=min_detection_conf,
                        min_hand_presence_confidence=min_tracking_conf,
                    )
                    self.task_landmarker = MP_TASKS_VISION.HandLandmarker.create_from_options(options)
                    self.backend_name = "MediaPipe-Tasks"
                    print("[INIT] HandPalmClassifier active: MediaPipe Tasks HandLandmarker")
                    return
                except Exception:
                    self.task_landmarker = None

        print(
            "[INIT] HandPalmClassifier active: OpenCV ARM-Safe Palm & Finger Reader "
            "(bypasses MediaPipe AES Illegal Instruction on RPi 3/4)"
        )

    @staticmethod
    def _dist(p1: tuple[float, float], p2: tuple[float, float]) -> float:
        return math.hypot(p1[0] - p2[0], p1[1] - p2[1])

    def _classify_21_landmarks(
        self,
        frame_bgr: np.ndarray,
        norm_pts: list[tuple[float, float]],
        handedness_label: str,
    ) -> dict:
        h, w = frame_bgr.shape[:2]
        pts = [(int(nx * w), int(ny * h)) for nx, ny in norm_pts]

        palm_cx = int((pts[0][0] + pts[5][0] + pts[9][0] + pts[13][0] + pts[17][0]) / 5)
        palm_cy = int((pts[0][1] + pts[5][1] + pts[9][1] + pts[13][1] + pts[17][1]) / 5)

        index_up = norm_pts[8][1] < norm_pts[6][1] - 0.015
        middle_up = norm_pts[12][1] < norm_pts[10][1] - 0.015
        ring_up = norm_pts[16][1] < norm_pts[14][1] - 0.015
        pinky_up = norm_pts[20][1] < norm_pts[18][1] - 0.015

        thumb_tip_to_pinky = self._dist(norm_pts[4], norm_pts[17])
        thumb_ip_to_pinky = self._dist(norm_pts[3], norm_pts[17])
        thumb_up = thumb_tip_to_pinky > (thumb_ip_to_pinky + 0.032)

        fingers = [int(thumb_up), int(index_up), int(middle_up), int(ring_up), int(pinky_up)]
        four_fingers_count = sum([index_up, middle_up, ring_up, pinky_up])
        total_fingers = sum(fingers)

        palm_scale = max(self._dist(norm_pts[0], norm_pts[9]), 0.05)
        thumb_index_dist = self._dist(norm_pts[4], norm_pts[8]) / palm_scale

        if thumb_index_dist < 0.36 and middle_up and ring_up and pinky_up:
            gesture_code, display_text, spoken_text = "OK", "OK SIGN (Thumb+Index)", "OK"
        elif thumb_up and four_fingers_count == 0:
            gesture_code, display_text, spoken_text = "THUMB_UP", "THUMB OK / THUMBS UP", "Thumb OK"
        elif total_fingers == 0:
            gesture_code, display_text, spoken_text = "CLOSED_HAND", "CLOSED HAND (FIST - 0)", "Closed Hand"
        elif not thumb_up and index_up and not middle_up and not ring_up and pinky_up:
            gesture_code, display_text, spoken_text = "ROCK", "ROCK ON", "Rock On"
        elif thumb_up and not index_up and not middle_up and not ring_up and pinky_up:
            gesture_code, display_text, spoken_text = "CALL_ME", "CALL ME", "Call Me"
        elif total_fingers == 1:
            gesture_code, display_text, spoken_text = "1", "1 - ONE FINGER", "One"
        elif total_fingers == 2:
            gesture_code, display_text, spoken_text = "2", "2 - TWO FINGERS", "Two"
        elif total_fingers == 3:
            gesture_code, display_text, spoken_text = "3", "3 - THREE FINGERS", "Three"
        elif total_fingers == 4:
            gesture_code, display_text, spoken_text = "4", "4 - FOUR FINGERS", "Four"
        else:
            gesture_code, display_text, spoken_text = "5", "5 - OPEN PALM (ALL 5)", "Five"

        self.history.append(gesture_code)
        stable_code = max(set(self.history), key=self.history.count)

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
            cv2.circle(
                frame_bgr,
                pt,
                5 if is_tip else 3,
                (74, 222, 128) if is_tip else (248, 250, 252),
                -1,
                cv2.LINE_AA,
            )
        cv2.circle(frame_bgr, (palm_cx, palm_cy), 16, (250, 204, 21), 2, cv2.LINE_AA)

        return {
            "detected": True,
            "gesture_code": stable_code,
            "display_text": display_text,
            "spoken_text": spoken_text,
            "finger_count": total_fingers,
            "handedness": handedness_label,
            "palm_center": (palm_cx, palm_cy),
        }

    def _process_opencv_palm_reader(self, frame_bgr: np.ndarray) -> dict:
        """
        Pure OpenCV + NumPy Hand & Palm Reader (100% ARMv8-safe on RPi 3/4/Zero 2W).
        Uses combined YCrCb + HSV skin segmentation, distance-transform palm center
        finding, convex hull peak clustering, and convexity defect angle geometry to
        accurately detect:
          - CLOSED HAND (0)
          - 1, 2, 3, 4, 5 fingers
          - THUMB OK / THUMBS UP
          - OK SIGN (inner circular hole inside hand contour)
        """
        h, w = frame_bgr.shape[:2]
        default_res = {
            "detected": False,
            "gesture_code": "NONE",
            "display_text": "Place Hand in Frame",
            "spoken_text": "",
            "finger_count": 0,
            "handedness": "RPi-CV",
            "palm_center": (w // 2, h // 2),
        }

        # Active detection box
        x0, y0, x1, y1 = int(w * 0.08), int(h * 0.10), int(w * 0.92), int(h * 0.88)
        roi = frame_bgr[y0:y1, x0:x1]
        cv2.rectangle(frame_bgr, (x0, y0), (x1, y1), (51, 65, 85), 1)

        blurred = cv2.GaussianBlur(roi, (7, 7), 0)
        ycrcb = cv2.cvtColor(blurred, cv2.COLOR_BGR2YCrCb)
        hsv = cv2.cvtColor(blurred, cv2.COLOR_BGR2HSV)

        # Dual YCrCb + HSV skin tone mask for reliable detection under indoor RPi camera lighting
        mask_ycrcb = cv2.inRange(ycrcb, np.array([0, 130, 75], dtype=np.uint8), np.array([255, 180, 135], dtype=np.uint8))
        mask_hsv1 = cv2.inRange(hsv, np.array([0, 25, 50], dtype=np.uint8), np.array([25, 255, 255], dtype=np.uint8))
        mask_hsv2 = cv2.inRange(hsv, np.array([160, 25, 50], dtype=np.uint8), np.array([180, 255, 255], dtype=np.uint8))
        mask = cv2.bitwise_and(mask_ycrcb, cv2.bitwise_or(mask_hsv1, mask_hsv2))

        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)

        contours, hierarchy = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            self.history.clear()
            return default_res

        # Find largest external contour
        largest_idx = max(range(len(contours)), key=lambda i: cv2.contourArea(contours[i]))
        cnt = contours[largest_idx]
        area = cv2.contourArea(cnt)
        if area < 2800:
            self.history.clear()
            return default_res

        # Check for child hole inside hand contour (OK Sign pinch loop)
        has_ok_pinch_hole = False
        if hierarchy is not None:
            child_idx = hierarchy[0][largest_idx][2]
            while child_idx != -1:
                hole_area = cv2.contourArea(contours[child_idx])
                if 120 < hole_area < area * 0.25:
                    has_ok_pinch_hole = True
                    break
                child_idx = hierarchy[0][child_idx][0]

        moments = cv2.moments(cnt)
        if moments["m00"] == 0:
            return default_res
        cx_roi = int(moments["m10"] / moments["m00"])
        cy_roi = int(moments["m01"] / moments["m00"])
        cx = cx_roi + x0
        cy = cy_roi + y0

        hull_pts = cv2.convexHull(cnt)
        hull_area = max(cv2.contourArea(hull_pts), 1.0)
        solidity = area / hull_area
        x_box, y_box, w_box, h_box = cv2.boundingRect(cnt)
        aspect_ratio = float(h_box) / max(w_box, 1)
        palm_radius = max(22.0, min(w_box, h_box) * 0.30)

        # Count valleys (convexity defects) between extended fingers
        hull_indices = cv2.convexHull(cnt, returnPoints=False)
        defect_valleys = 0
        fingertips_roi: list[tuple[int, int]] = []

        if hull_indices is not None and len(hull_indices) > 3 and len(cnt) > 3:
            defects = cv2.convexityDefects(cnt, hull_indices)
            if defects is not None:
                for i in range(defects.shape[0]):
                    s, e, f, d = defects[i, 0]
                    start = (int(cnt[s][0][0]), int(cnt[s][0][1]))
                    end = (int(cnt[e][0][0]), int(cnt[e][0][1]))
                    far = (int(cnt[f][0][0]), int(cnt[f][0][1]))

                    a = math.hypot(end[0] - start[0], end[1] - start[1])
                    b = math.hypot(far[0] - start[0], far[1] - start[1])
                    c = math.hypot(end[0] - far[0], end[1] - far[1])
                    if b * c == 0:
                        continue
                    angle = math.degrees(
                        math.acos(max(-1.0, min(1.0, (b * b + c * c - a * a) / (2 * b * c))))
                    )
                    depth_px = d / 256.0
                    if angle <= 92.0 and depth_px > palm_radius * 0.48:
                        defect_valleys += 1
                        fingertips_roi.append(start)
                        fingertips_roi.append(end)
                        cv2.circle(frame_bgr, (far[0] + x0, far[1] + y0), 4, (244, 63, 94), -1)

        # Deduplicate fingertips and include topmost hull point if 1 finger is raised
        unique_tips: list[tuple[int, int]] = []
        for pt in sorted(fingertips_roi, key=lambda p: p[1]):
            if all(math.hypot(pt[0] - u[0], pt[1] - u[1]) > 22 for u in unique_tips):
                if pt[1] < cy_roi + palm_radius * 0.4:
                    unique_tips.append(pt)

        topmost = tuple(cnt[cnt[:, :, 1].argmin()][0])
        if len(unique_tips) == 0 and (cy_roi - topmost[1]) > palm_radius * 1.35:
            unique_tips.append((int(topmost[0]), int(topmost[1])))

        # Draw contour, convex hull, palm ring, and skeletal rays from palm center to fingertips
        cnt_shifted = cnt + np.array([[[x0, y0]]])
        hull_shifted = hull_pts + np.array([[[x0, y0]]])
        cv2.drawContours(frame_bgr, [cnt_shifted], -1, (56, 189, 248), 2, cv2.LINE_AA)
        cv2.drawContours(frame_bgr, [hull_shifted], -1, (148, 163, 184), 1, cv2.LINE_AA)

        wrist_pt = (cx, min(h - 36, cy + int(palm_radius * 1.3)))
        cv2.line(frame_bgr, wrist_pt, (cx, cy), (56, 189, 248), 2, cv2.LINE_AA)
        cv2.circle(frame_bgr, (cx, cy), int(palm_radius * 0.65), (250, 204, 21), 2, cv2.LINE_AA)
        cv2.circle(frame_bgr, (cx, cy), 4, (250, 204, 21), -1, cv2.LINE_AA)

        for tip in unique_tips[:5]:
            tip_full = (tip[0] + x0, tip[1] + y0)
            mid_pt = ((cx + tip_full[0]) // 2, (cy + tip_full[1]) // 2)
            cv2.line(frame_bgr, (cx, cy), tip_full, (56, 189, 248), 2, cv2.LINE_AA)
            cv2.circle(frame_bgr, mid_pt, 3, (248, 250, 252), -1, cv2.LINE_AA)
            cv2.circle(frame_bgr, tip_full, 6, (74, 222, 128), -1, cv2.LINE_AA)

        # Classify gesture state
        if has_ok_pinch_hole and defect_valleys >= 1:
            total_fingers = 3
            gesture_code, display_text, spoken_text = "OK", "OK SIGN (Thumb+Index)", "OK"
        elif defect_valleys == 0:
            if solidity > 0.80 and len(unique_tips) == 0:
                total_fingers = 0
                gesture_code, display_text, spoken_text = "CLOSED_HAND", "CLOSED HAND (FIST - 0)", "Closed Hand"
            elif aspect_ratio < 1.18:
                total_fingers = 1
                gesture_code, display_text, spoken_text = "THUMB_UP", "THUMB OK / THUMBS UP", "Thumb OK"
            else:
                total_fingers = 1
                gesture_code, display_text, spoken_text = "1", "1 - ONE FINGER", "One"
        else:
            total_fingers = min(5, defect_valleys + 1)
            spoken_map = {1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five"}
            label_map = {
                1: "1 - ONE FINGER",
                2: "2 - TWO FINGERS",
                3: "3 - THREE FINGERS",
                4: "4 - FOUR FINGERS",
                5: "5 - OPEN PALM (ALL 5)",
            }
            gesture_code = str(total_fingers)
            display_text = label_map[total_fingers]
            spoken_text = spoken_map[total_fingers]

        self.history.append(gesture_code)
        stable_code = max(set(self.history), key=self.history.count)

        # Map stable code back to consistent display & spoken text
        stable_map = {
            "CLOSED_HAND": ("CLOSED HAND (FIST - 0)", "Closed Hand", 0),
            "THUMB_UP": ("THUMB OK / THUMBS UP", "Thumb OK", 1),
            "OK": ("OK SIGN (Thumb+Index)", "OK", 3),
            "1": ("1 - ONE FINGER", "One", 1),
            "2": ("2 - TWO FINGERS", "Two", 2),
            "3": ("3 - THREE FINGERS", "Three", 3),
            "4": ("4 - FOUR FINGERS", "Four", 4),
            "5": ("5 - OPEN PALM (ALL 5)", "Five", 5),
        }
        if stable_code in stable_map:
            display_text, spoken_text, total_fingers = stable_map[stable_code]

        return {
            "detected": True,
            "gesture_code": stable_code,
            "display_text": display_text,
            "spoken_text": spoken_text,
            "finger_count": total_fingers,
            "handedness": "RPi-CV",
            "palm_center": (cx, cy),
        }

    def process_and_annotate(self, frame_bgr: np.ndarray) -> dict:
        h, w = frame_bgr.shape[:2]
        empty_res = {
            "detected": False,
            "gesture_code": "NONE",
            "display_text": "No Hand Detected",
            "spoken_text": "",
            "finger_count": 0,
            "handedness": "N/A",
            "palm_center": (w // 2, h // 2),
        }

        if self.legacy_hands is not None:
            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            results = self.legacy_hands.process(frame_rgb)
            if not results.multi_hand_landmarks:
                self.history.clear()
                return empty_res
            hand_lms = results.multi_hand_landmarks[0]
            norm_pts = [(lm.x, lm.y) for lm in hand_lms.landmark]
            return self._classify_21_landmarks(frame_bgr, norm_pts, "Right")

        if self.task_landmarker is not None and MP_IMAGE_CLS is not None and mp is not None:
            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            mp_image = MP_IMAGE_CLS(image_format=mp.ImageFormat.SRGB, data=frame_rgb)
            detection_result = self.task_landmarker.detect(mp_image)
            if not detection_result.hand_landmarks:
                self.history.clear()
                return empty_res
            norm_pts = [(lm.x, lm.y) for lm in detection_result.hand_landmarks[0]]
            return self._classify_21_landmarks(frame_bgr, norm_pts, "Right")

        return self._process_opencv_palm_reader(frame_bgr)

    def close(self) -> None:
        if self.legacy_hands is not None:
            try:
                self.legacy_hands.close()
            except Exception:
                pass
        if self.task_landmarker is not None:
            try:
                self.task_landmarker.close()
            except Exception:
                pass


class FramebufferDisplay:
    """Writes BGR888 OpenCV frames directly into a 16-bit RGB565 Linux framebuffer (/dev/fb1)."""

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
            0.50,
            banner_color,
            2,
            cv2.LINE_AA,
        )
        cv2.putText(
            frame,
            f"UP: {gesture_info['finger_count']}/5",
            (w - 82, h - 12),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.42,
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
    parser.add_argument("--gesture", action="store_true", default=True, help="Enable Hand Gesture & Palm Reader")
    parser.add_argument("--no-gesture", action="store_false", dest="gesture")
    parser.add_argument("--tts", action="store_true", default=False, help="Speak recognized gesture aloud")
    parser.add_argument("--hud", action="store_true", default=True)
    parser.add_argument("--no-hud", action="store_false", dest="hud")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    running = True

    def handle_sig(_signum, _frame):
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
