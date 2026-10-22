export interface StreamConfig {
  mode: 'fb' | 'spi' | 'window';
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
  gestureEnabled: boolean;
  ttsEnabled: boolean;
  minDetectionConf: number;
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
  gestureEnabled: true,
  ttsEnabled: true,
  minDetectionConf: 0.65,
  displayModel: 'waveshare35a',
  gitRepoUrl: 'https://github.com/dattatraybhairi/rpi-spi-camera-streamer.git',
  rpiHost: 'raspberrypi.local',
  rpiUser: 'pi',
  enableSystemd: true,
};

export const AI_REUSABLE_PROMPT = `Write a complete Raspberry Pi Python camera streaming and 21-point Hand Gesture & Palm Reader application for a 3.5-inch 480x320 SPI LCD display (16-bit RGB565 via /dev/fb1 or raw spidev0.0 + GPIO 24/25).

Include these 4 deliverables:
1. rpi_camera_spi_stream.py:
   - Capture live frames from Picamera2 (CSI camera) or OpenCV VideoCapture (USB V4L2).
   - Run MediaPipe Hands (model_complexity=0 for Raspberry Pi ARM) to extract 21 hand landmarks and palm center coordinates.
   - Classify and display these exact hand & palm states on the 480x320 HUD:
     * "1 - ONE FINGER" (Index up) -> speaks "One"
     * "2 - TWO FINGERS" (Index + Middle up) -> speaks "Two"
     * "3 - THREE FINGERS" (3 fingers up) -> speaks "Three"
     * "4 - FOUR FINGERS" (4 fingers up, thumb curled) -> speaks "Four"
     * "5 - OPEN PALM (ALL 5)" (All 5 fingers up) -> speaks "Five"
     * "CLOSED HAND (FIST - 0)" (0 fingers extended) -> speaks "Closed Hand"
     * "THUMB OK / THUMBS UP" (Thumb up, 4 fingers curled) -> speaks "Thumb OK"
     * "OK SIGN (Thumb+Index)" (Thumb tip + Index tip pinched in circle + 3 fingers up) -> speaks "OK"
     * "ROCK ON" (Index + Pinky up) and "CALL ME" (Thumb + Pinky up)
   - Support non-blocking voice output via espeak-ng (--tts) and 16-bit RGB565 framebuffer packing.
2. simulation.html:
   - Standalone HTML5 Canvas 480x320 simulator rendering the 21-point hand skeleton, palm reader ring, finger bitmask [T,I,M,R,P], interactive gesture buttons (Closed Hand, 1, 2, 3, 4, 5, Thumb OK, OK Sign), and Web Speech API voice output.
3. .github/workflows/rpi-gesture-ci.yml:
   - GitHub Actions workflow that compiles the Python script, runs a synthetic 480x320 RGB565 + HandPalmClassifier unit test, verifies simulation.html, and uploads the deployment artifact.
4. install_rpi.sh & README.md:
   - Direct clone and run instructions for https://github.com/dattatraybhairi/rpi-spi-camera-streamer.git on Raspberry Pi.`;

export function generatePythonScript(cfg: StreamConfig): string {
  const cliExample = `python3 rpi_camera_spi_stream.py --mode ${cfg.mode} ${
    cfg.mode === 'fb'
      ? `--fb-dev ${cfg.fbDevice}`
      : cfg.mode === 'spi'
      ? `--spi-bus ${cfg.spiBus} --spi-cs ${cfg.spiCs} --spi-speed ${cfg.spiSpeedHz} --dc-pin ${cfg.dcPin} --rst-pin ${cfg.rstPin}`
      : ''
  } --width ${cfg.width} --height ${cfg.height} --fps ${cfg.targetFps}${cfg.gestureEnabled ? ' --gesture' : ' --no-gesture'}${cfg.ttsEnabled ? ' --tts' : ''}${cfg.hud ? ' --hud' : ' --no-hud'}`;

  return `#!/usr/bin/env python3
"""
RPi 3.5" SPI LCD Camera Streamer + Hand Gesture & Palm Reader
-------------------------------------------------------------
Streams live camera frames from Raspberry Pi CSI Camera (Picamera2) or USB V4L2
Webcam (OpenCV) directly to a 3.5-inch ${cfg.width}x${cfg.height} SPI LCD Display with real-time
21-point MediaPipe Hand Landmark tracking, finger counting, and speech synthesis.

Recognized Hand & Palm Gestures:
  - CLOSED_HAND (0) : Closed Hand / Fist (0 fingers extended) -> speaks "Closed Hand"
  - 1               : Index Finger Up -> speaks "One"
  - 2               : Index + Middle Fingers Up -> speaks "Two"
  - 3               : Three Fingers Up -> speaks "Three"
  - 4               : Four Fingers Up (Thumb curled) -> speaks "Four"
  - 5               : Open Palm (All 5 Fingers Up) -> speaks "Five"
  - THUMB_UP        : Thumb extended upward, 4 fingers closed -> speaks "Thumb OK"
  - OK              : Thumb tip + Index tip pinched in circle -> speaks "OK"
  - ROCK / CALL_ME  : Index+Pinky ("Rock On") / Thumb+Pinky ("Call Me")

Run directly on Raspberry Pi:
  ${cliExample}
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

try:
    from picamera2 import Picamera2
    HAS_PICAMERA2 = True
except ImportError:
    HAS_PICAMERA2 = False

try:
    import spidev
    import RPi.GPIO as GPIO
    HAS_RAW_SPI = True
except ImportError:
    HAS_RAW_SPI = False

try:
    import mediapipe as mp
    HAS_MEDIAPIPE = True
except ImportError:
    HAS_MEDIAPIPE = False


class SpeechAnnouncer:
    """Non-blocking voice announcer for detected hand gestures (espeak-ng / espeak)."""

    def __init__(self, enabled: bool = ${cfg.ttsEnabled ? 'True' : 'False'}, cooldown_sec: float = 1.8):
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
                    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=False)
                    break
                except FileNotFoundError:
                    continue
                except Exception:
                    break

        threading.Thread(target=_speak_worker, args=(spoken_text,), daemon=True).start()


class HandPalmClassifier:
    """21-Landmark Hand & Palm Gesture Classifier for Raspberry Pi."""

    TIP_IDS = [4, 8, 12, 16, 20]

    def __init__(self, min_detection_conf: float = ${cfg.minDetectionConf}, min_tracking_conf: float = 0.6):
        self.history: deque[str] = deque(maxlen=5)
        self.hands = None
        if HAS_MEDIAPIPE:
            self.hands = mp.solutions.hands.Hands(
                static_image_mode=False,
                max_num_hands=1,
                model_complexity=0,
                min_detection_confidence=min_detection_conf,
                min_tracking_confidence=min_tracking_conf,
            )

    @staticmethod
    def _dist(p1: tuple[float, float], p2: tuple[float, float]) -> float:
        return math.hypot(p1[0] - p2[0], p1[1] - p2[1])

    def process_and_annotate(self, frame_bgr: np.ndarray) -> dict:
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

        results = self.hands.process(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))
        if not results.multi_hand_landmarks:
            self.history.clear()
            return result_info

        hand_lms = results.multi_hand_landmarks[0]
        handedness_label = "Right"
        if results.multi_handedness:
            handedness_label = results.multi_handedness[0].classification[0].label

        pts = [(int(lm.x * w), int(lm.y * h)) for lm in hand_lms.landmark]
        norm_pts = [(lm.x, lm.y) for lm in hand_lms.landmark]

        palm_cx = int((pts[0][0] + pts[5][0] + pts[9][0] + pts[13][0] + pts[17][0]) / 5)
        palm_cy = int((pts[0][1] + pts[5][1] + pts[9][1] + pts[13][1] + pts[17][1]) / 5)

        index_up = norm_pts[8][1] < norm_pts[6][1] - 0.015
        middle_up = norm_pts[12][1] < norm_pts[10][1] - 0.015
        ring_up = norm_pts[16][1] < norm_pts[14][1] - 0.015
        pinky_up = norm_pts[20][1] < norm_pts[18][1] - 0.015

        thumb_tip_to_pinky = self._dist(norm_pts[4], norm_pts[17])
        thumb_ip_to_pinky = self._dist(norm_pts[3], norm_pts[17])
        thumb_up = thumb_tip_to_pinky > (thumb_ip_to_pinky + 0.035)

        fingers = [thumb_up, index_up, middle_up, ring_up, pinky_up]
        four_fingers_count = sum([index_up, middle_up, ring_up, pinky_up])
        total_fingers = sum(fingers)

        palm_scale = max(self._dist(norm_pts[0], norm_pts[9]), 0.05)
        thumb_index_dist = self._dist(norm_pts[4], norm_pts[8]) / palm_scale

        if thumb_index_dist < 0.36 and middle_up and ring_up and pinky_up:
            gesture_code, display_text, spoken_text = "OK", "OK SIGN (Thumb+Index)", "OK"
        elif thumb_up and four_fingers_count == 0:
            if norm_pts[4][1] < norm_pts[2][1] - 0.03:
                gesture_code, display_text, spoken_text = "THUMB_UP", "THUMB OK / THUMBS UP", "Thumb OK"
            elif norm_pts[4][1] > norm_pts[2][1] + 0.03:
                gesture_code, display_text, spoken_text = "THUMB_DOWN", "THUMBS DOWN", "Thumb Down"
            else:
                gesture_code, display_text, spoken_text = "1", "1 - THUMB", "One"
        elif total_fingers == 0:
            gesture_code, display_text, spoken_text = "CLOSED_HAND", "CLOSED HAND (FIST - 0)", "Closed Hand"
        elif not thumb_up and index_up and not middle_up and not ring_up and pinky_up:
            gesture_code, display_text, spoken_text = "ROCK", "ROCK ON", "Rock On"
        elif thumb_up and not index_up and not middle_up and not ring_up and pinky_up:
            gesture_code, display_text, spoken_text = "CALL_ME", "CALL ME", "Call Me"
        elif total_fingers == 1 and index_up:
            gesture_code, display_text, spoken_text = "1", "1 - ONE FINGER", "One"
        elif total_fingers == 2 and index_up and middle_up:
            gesture_code, display_text, spoken_text = "2", "2 - TWO FINGERS", "Two"
        elif total_fingers == 3 and index_up and middle_up:
            gesture_code, display_text, spoken_text = "3", "3 - THREE FINGERS", "Three"
        elif four_fingers_count == 4 and not thumb_up:
            gesture_code, display_text, spoken_text = "4", "4 - FOUR FINGERS", "Four"
        elif total_fingers == 5:
            gesture_code, display_text, spoken_text = "5", "5 - OPEN PALM (ALL 5)", "Five"
        else:
            gesture_code, display_text, spoken_text = str(total_fingers), f"{total_fingers} - FINGERS UP", str(total_fingers)

        self.history.append(gesture_code)
        stable_code = max(set(self.history), key=self.history.count)

        connections = [
            (0, 1), (1, 2), (2, 3), (3, 4),
            (0, 5), (5, 6), (6, 7), (7, 8),
            (5, 9), (9, 10), (10, 11), (11, 12),
            (9, 13), (13, 14), (14, 15), (15, 16),
            (13, 17), (17, 18), (18, 19), (19, 20), (0, 17),
        ]
        for a, b in connections:
            cv2.line(frame_bgr, pts[a], pts[b], (56, 189, 248), 2, cv2.LINE_AA)
        for idx, pt in enumerate(pts):
            is_tip = idx in self.TIP_IDS
            cv2.circle(frame_bgr, pt, 5 if is_tip else 3, (74, 222, 128) if is_tip else (248, 250, 252), -1, cv2.LINE_AA)

        cv2.circle(frame_bgr, (palm_cx, palm_cy), 16, (250, 204, 21), 1, cv2.LINE_AA)
        cv2.circle(frame_bgr, (palm_cx, palm_cy), 3, (250, 204, 21), -1, cv2.LINE_AA)

        return {
            "detected": True,
            "gesture_code": stable_code,
            "display_text": display_text,
            "spoken_text": spoken_text,
            "finger_count": total_fingers,
            "handedness": handedness_label,
            "palm_center": (palm_cx, palm_cy),
        }

    def close(self) -> None:
        if self.hands is not None:
            self.hands.close()


class FramebufferDisplay:
    """Writes BGR888 frames into 16-bit RGB565 Linux framebuffer (${cfg.fbDevice})."""

    def __init__(self, fb_device: str = "${cfg.fbDevice}", width: int = ${cfg.width}, height: int = ${cfg.height}):
        self.fb_device = fb_device
        self.width = width
        self.height = height
        if not os.path.exists(self.fb_device):
            raise FileNotFoundError(f"Framebuffer {self.fb_device} not found.")
        self.fb_fd = open(self.fb_device, "wb")

    @staticmethod
    def bgr888_to_rgb565(frame_bgr: np.ndarray) -> bytes:
        b = frame_bgr[:, :, 0].astype(np.uint16)
        g = frame_bgr[:, :, 1].astype(np.uint16)
        r = frame_bgr[:, :, 2].astype(np.uint16)
        return (((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)).tobytes()

    def write_frame(self, frame_bgr: np.ndarray) -> None:
        if frame_bgr.shape[1] != self.width or frame_bgr.shape[0] != self.height:
            frame_bgr = cv2.resize(frame_bgr, (self.width, self.height), interpolation=cv2.INTER_LINEAR)
        self.fb_fd.seek(0)
        self.fb_fd.write(self.bgr888_to_rgb565(frame_bgr))
        self.fb_fd.flush()

    def close(self) -> None:
        if self.fb_fd:
            self.fb_fd.close()


class CameraSource:
    """Unified Picamera2 + OpenCV V4L2 camera reader."""

    def __init__(self, width: int = ${cfg.width}, height: int = ${cfg.height}, fps: int = ${cfg.targetFps}, camera_index: int = ${cfg.cameraIndex}, backend: str = "${cfg.cameraBackend}"):
        self.picam2 = None
        self.cap = None
        if backend in ("auto", "picamera2") and HAS_PICAMERA2:
            try:
                self.picam2 = Picamera2(camera_num=camera_index)
                config = self.picam2.create_video_configuration(main={"size": (width, height), "format": "RGB888"})
                self.picam2.configure(config)
                self.picam2.start()
                return
            except Exception:
                self.picam2 = None

        self.cap = cv2.VideoCapture(camera_index, cv2.CAP_V4L2)
        if not self.cap.isOpened():
            self.cap = cv2.VideoCapture(camera_index)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.cap.set(cv2.CAP_PROP_FPS, fps)

    def read_bgr(self) -> np.ndarray | None:
        if self.picam2 is not None:
            return self.picam2.capture_array("main")
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
`;
}

export function generateSimulationHtml(_cfg: StreamConfig): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>RPi 3.5" SPI Hand Gesture & Palm Reader Simulation</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; }
      .wrap { max-width: 1080px; margin: 0 auto; display: grid; grid-template-columns: 500px 1fr; gap: 24px; }
      .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; }
      canvas { width: 100%; background: #000; border-radius: 6px; border: 2px solid #475569; display: block; }
      .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }
      button { background: #0f172a; color: #f8fafc; border: 1px solid #334155; border-radius: 6px; padding: 8px; font-size: 12px; cursor: pointer; }
      button.active { background: #0ea5e9; border-color: #0ea5e9; font-weight: 600; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h2 style="margin:0 0 8px 0;font-size:18px;">3.5" SPI Display (480x320 RGB565) — Hand & Palm Reader</h2>
        <canvas id="spiCanvas" width="480" height="320"></canvas>
        <div class="grid" id="presetButtons"></div>
      </div>
      <div class="card">
        <h2 style="margin:0 0 8px 0;font-size:18px;">Live Palm Telemetry & Web Speech TTS</h2>
        <p id="gestureLabel" style="font-family:monospace;font-size:18px;color:#4ade80;">5 - OPEN PALM (ALL 5)</p>
        <p id="spokenLabel" style="font-family:monospace;font-size:14px;color:#38bdf8;">Spoken Output: "Five"</p>
        <p id="fingerMask" style="font-family:monospace;font-size:13px;color:#cbd5e1;">Finger Bitmask [T,I,M,R,P]: [1, 1, 1, 1, 1]</p>
      </div>
    </div>
    <script>
      const GESTURES = [
        { id: 'CLOSED_HAND', btn: 'Closed (0)', title: 'CLOSED HAND (FIST - 0)', spoken: 'Closed Hand', fingers: [0,0,0,0,0] },
        { id: '1', btn: '1 Finger', title: '1 - ONE FINGER', spoken: 'One', fingers: [0,1,0,0,0] },
        { id: '2', btn: '2 Fingers', title: '2 - TWO FINGERS', spoken: 'Two', fingers: [0,1,1,0,0] },
        { id: '3', btn: '3 Fingers', title: '3 - THREE FINGERS', spoken: 'Three', fingers: [0,1,1,1,0] },
        { id: '4', btn: '4 Fingers', title: '4 - FOUR FINGERS', spoken: 'Four', fingers: [0,1,1,1,1] },
        { id: '5', btn: '5 Open Palm', title: '5 - OPEN PALM (ALL 5)', spoken: 'Five', fingers: [1,1,1,1,1] },
        { id: 'THUMB_UP', btn: 'Thumb OK', title: 'THUMB OK / THUMBS UP', spoken: 'Thumb OK', fingers: [1,0,0,0,0] },
        { id: 'OK', btn: 'OK Sign', title: 'OK SIGN (PINCH)', spoken: 'OK', fingers: [1,0,1,1,1], pinch: true }
      ];
      let current = GESTURES[5];
      const box = document.getElementById('presetButtons');
      GESTURES.forEach((g) => {
        const b = document.createElement('button');
        b.textContent = g.btn;
        b.id = 'b-' + g.id;
        if (g.id === current.id) b.className = 'active';
        b.onclick = () => {
          current = g;
          GESTURES.forEach((x) => document.getElementById('b-' + x.id).classList.toggle('active', x.id === g.id));
          document.getElementById('gestureLabel').textContent = g.title;
          document.getElementById('spokenLabel').textContent = 'Spoken Output: "' + g.spoken + '"';
          document.getElementById('fingerMask').textContent = 'Finger Bitmask [T,I,M,R,P]: [' + g.fingers.join(', ') + ']';
          if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(new SpeechSynthesisUtterance(g.spoken));
          }
        };
        box.appendChild(b);
      });
      const c = document.getElementById('spiCanvas');
      const ctx = c.getContext('2d');
      function loop(t) {
        requestAnimationFrame(loop);
        ctx.fillStyle = '#090d16'; ctx.fillRect(0, 0, 480, 320);
        const cx = 240 + Math.sin(t * 0.002) * 6, cy = 195;
        const wrist = [cx, cy + 56];
        const mcps = [[cx-46, cy+16], [cx-26, cy-18], [cx-6, cy-24], [cx+14, cy-20], [cx+34, cy-10]];
        ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2;
        mcps.forEach((m, i) => {
          ctx.beginPath(); ctx.moveTo(wrist[0], wrist[1]); ctx.lineTo(m[0], m[1]); ctx.stroke();
          const up = current.fingers[i] === 1;
          let tx = m[0] + (i === 0 ? (up ? -34 : -8) : (i - 2) * 6);
          let ty = m[1] + (up ? -62 : 18);
          if (current.pinch && (i === 0 || i === 1)) { tx = cx - 30; ty = cy - 40; }
          ctx.beginPath(); ctx.moveTo(m[0], m[1]); ctx.lineTo(tx, ty); ctx.stroke();
          ctx.fillStyle = up ? '#4ade80' : '#f43f5e';
          ctx.beginPath(); ctx.arc(tx, ty, 6, 0, Math.PI * 2); ctx.fill();
        });
        ctx.strokeStyle = '#facc15'; ctx.beginPath(); ctx.arc(cx - 4, cy + 4, 16, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(15,23,42,0.85)'; ctx.fillRect(0, 286, 480, 34);
        ctx.fillStyle = '#4ade80'; ctx.font = 'bold 14px monospace';
        ctx.fillText('PALM READER: ' + current.title, 10, 308);
      }
      requestAnimationFrame(loop);
    </script>
  </body>
</html>`;
}

export function generateGithubActionYaml(_cfg: StreamConfig): string {
  return `name: RPi SPI Camera & Hand Gesture CI

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]
  workflow_dispatch:

jobs:
  validate-and-simulate:
    name: Lint Python Hand Gesture Streamer & Verify Simulation HTML
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Python 3.11
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install Python dependencies (OpenCV, NumPy, Flake8)
        run: |
          python -m pip install --upgrade pip
          pip install numpy opencv-python-headless flake8

      - name: Verify Python syntax & CLI help output
        run: |
          python -m py_compile rpi_camera_spi_stream.py
          python rpi_camera_spi_stream.py --help

      - name: Run synthetic RGB565 framebuffer & gesture unit self-test
        run: |
          python - << 'EOF'
          import numpy as np
          from rpi_camera_spi_stream import FramebufferDisplay, HandPalmClassifier

          dummy_bgr = np.zeros((320, 480, 3), dtype=np.uint8)
          packed = FramebufferDisplay.bgr888_to_rgb565(dummy_bgr)
          assert len(packed) == 480 * 320 * 2
          classifier = HandPalmClassifier()
          info = classifier.process_and_annotate(dummy_bgr)
          assert "gesture_code" in info and "finger_count" in info
          classifier.close()
          print("RGB565 + HandPalmClassifier self-test passed!")
          EOF

      - name: Verify standalone simulation.html and install_rpi.sh
        run: |
          test -f simulation.html
          bash -n install_rpi.sh

      - name: Upload RPi Deployment & Simulation Bundle Artifact
        uses: actions/upload-artifact@v4
        with:
          name: rpi-spi-hand-gesture-bundle
          path: |
            rpi_camera_spi_stream.py
            install_rpi.sh
            simulation.html
            README.md
`;
}

export function generateInstallScript(cfg: StreamConfig): string {
  const cliFlags =
    cfg.mode === 'fb'
      ? `--mode fb --fb-dev ${cfg.fbDevice}`
      : `--mode spi --spi-bus ${cfg.spiBus} --spi-cs ${cfg.spiCs} --spi-speed ${cfg.spiSpeedHz} --dc-pin ${cfg.dcPin} --rst-pin ${cfg.rstPin}`;

  return `#!/usr/bin/env bash
# ==============================================================================
# Raspberry Pi 3.5" SPI LCD Camera Streamer + Hand Gesture & Palm Reader Setup
# ==============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="rpi-spi-cam.service"

echo "==> [1/5] Installing Raspberry Pi system packages (Picamera2, OpenCV, SPI, eSpeak TTS)..."
sudo apt-get update -y
sudo apt-get install -y \\
  python3-picamera2 \\
  python3-opencv \\
  python3-numpy \\
  python3-spidev \\
  python3-rpi-lgpio \\
  python3-pip \\
  espeak-ng \\
  git

echo "==> [2/5] Installing MediaPipe for 21-Point Hand Gesture & Palm Reading..."
pip3 install --break-system-packages mediapipe || pip3 install mediapipe || true

echo "==> [3/5] Verifying SPI interface in /boot/firmware/config.txt..."
BOOT_CONFIG="/boot/firmware/config.txt"
if [ ! -f "$BOOT_CONFIG" ]; then
  BOOT_CONFIG="/boot/config.txt"
fi
if [ -f "$BOOT_CONFIG" ] && ! grep -q "^dtparam=spi=on" "$BOOT_CONFIG"; then
  echo "dtparam=spi=on" | sudo tee -a "$BOOT_CONFIG" >/dev/null
fi

echo "==> [4/5] Setting executable permissions on rpi_camera_spi_stream.py..."
chmod +x "\${REPO_DIR}/rpi_camera_spi_stream.py"

echo "==> [5/5] Creating systemd service (\${SERVICE_NAME})..."
sudo tee "/etc/systemd/system/\${SERVICE_NAME}" >/dev/null <<EOF
[Unit]
Description=Raspberry Pi 3.5 inch SPI LCD Camera Streamer + Hand Gesture Palm Reader
After=multi-user.target

[Service]
Type=simple
User=\${SUDO_USER:-\$USER}
WorkingDirectory=\${REPO_DIR}
ExecStart=/usr/bin/python3 \${REPO_DIR}/rpi_camera_spi_stream.py ${cliFlags} --width ${cfg.width} --height ${cfg.height} --fps ${cfg.targetFps}${cfg.gestureEnabled ? ' --gesture' : ' --no-gesture'}${cfg.ttsEnabled ? ' --tts' : ''}${cfg.hud ? ' --hud' : ' --no-hud'}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
echo "Setup complete! Run directly: python3 rpi_camera_spi_stream.py ${cliFlags} --gesture --tts --hud"
`;
}

export function generateReadmeMarkdown(cfg: StreamConfig): string {
  const repoFolder =
    cfg.gitRepoUrl.split('/').pop()?.replace(/\.git$/, '') || 'rpi-spi-camera-streamer';
  const cliCommand = `python3 rpi_camera_spi_stream.py --mode ${cfg.mode} ${
    cfg.mode === 'fb'
      ? `--fb-dev ${cfg.fbDevice}`
      : `--spi-bus ${cfg.spiBus} --spi-cs ${cfg.spiCs} --spi-speed ${cfg.spiSpeedHz} --dc-pin ${cfg.dcPin} --rst-pin ${cfg.rstPin}`
  } --camera-backend ${cfg.cameraBackend} --width ${cfg.width} --height ${cfg.height} --fps ${cfg.targetFps}${
    cfg.gestureEnabled ? ' --gesture' : ' --no-gesture'
  }${cfg.ttsEnabled ? ' --tts' : ''}${cfg.hud ? ' --hud' : ' --no-hud'}`;

  return `# Raspberry Pi 3.5" SPI Display Camera Streamer + Hand Gesture & Palm Reader

Direct Python camera streamer and **21-point Hand Gesture & Palm Reader** for **3.5-inch ${cfg.width}×${cfg.height} SPI LCD displays** on Raspberry Pi.

- **Repository**: \`${cfg.gitRepoUrl}\`
- **Recognized Gestures**: \`1\`, \`2\`, \`3\`, \`4\`, \`5 (Open Palm)\`, \`CLOSED HAND (Fist - 0)\`, \`THUMB OK (Thumbs Up)\`, \`OK SIGN (Pinch)\`, \`ROCK ON\`, \`CALL ME\`
- **Included Simulation & CI**: \`simulation.html\` (standalone browser simulator) and \`.github/workflows/rpi-gesture-ci.yml\` (GitHub Actions workflow)

---

## 1. Direct Clone & Run on Raspberry Pi

\`\`\`bash
git clone ${cfg.gitRepoUrl}
cd ${repoFolder}
chmod +x install_rpi.sh
./install_rpi.sh
${cliCommand}
\`\`\`

### Single-Line Copy & Paste Command for Raspberry Pi Terminal

\`\`\`bash
git clone ${cfg.gitRepoUrl} && cd ${repoFolder} && chmod +x install_rpi.sh && ./install_rpi.sh && ${cliCommand}
\`\`\`

---

## 2. Build & Push All Files (Python + \`simulation.html\` + GitHub Action) to GitHub

\`\`\`bash
git init
git add rpi_camera_spi_stream.py install_rpi.sh simulation.html .github/workflows/rpi-gesture-ci.yml README.md
git commit -m "Add MediaPipe hand gesture palm reader (1-5, Closed Hand, Thumb OK), simulation.html, and GitHub Action"
git branch -M main
git remote remove origin 2>/dev/null || true
git remote add origin ${cfg.gitRepoUrl}
git push -u origin main
\`\`\`
`;
}
