# Raspberry Pi 3.5" SPI Display Camera Streamer + Hand Gesture & Palm Reader

High-throughput Python camera streamer and **21-point Hand Gesture & Palm Reader** designed for **3.5-inch 480×320 SPI LCD displays** (ILI9486, ILI9488, ST7796S, Waveshare 3.5" A/B/C, MHS35, GoodTFT) connected to a **Raspberry Pi** (Pi 3B+, Pi 4, Pi 5, Pi Zero 2 W).

- **GitHub Repository**: `https://github.com/dattatraybhairi/rpi-spi-camera-streamer.git`
- **`rpi_camera_spi_stream.py`** — Production Python streamer supporting **Linux Framebuffer (`/dev/fb1`)** and **Raw `spidev` + GPIO (`ILI9486`)** transfer, plus real-time **MediaPipe 21-landmark Hand & Palm Reader** (`1`, `2`, `3`, `4`, `5`, `CLOSED HAND`, `THUMB OK`, `OK SIGN`, `ROCK ON`, `CALL ME`) and **`espeak-ng` voice announcements (`--tts`)**.
- **`simulation.html`** — Standalone zero-dependency HTML5 Canvas simulator to test 480×320 RGB565 hand skeleton rendering, finger counting, and Web Speech TTS in any browser.
- **`.github/workflows/rpi-gesture-ci.yml`** — GitHub Actions CI pipeline that compiles and tests the Python RGB565 framebuffer & hand gesture classifier on every push.

---

## 1. Recognized Hand & Palm Gestures

| Gesture Code | Finger State `[Thumb, Index, Middle, Ring, Pinky]` | Display HUD Banner | Voice TTS Announcement (`--tts`) |
| :--- | :--- | :--- | :--- |
| **`CLOSED_HAND`** | `[0, 0, 0, 0, 0]` (0 fingers extended) | `CLOSED HAND (FIST - 0)` | *"Closed Hand"* |
| **`1`** | `[0, 1, 0, 0, 0]` (Index finger up) | `1 - ONE FINGER` | *"One"* |
| **`2`** | `[0, 1, 1, 0, 0]` (Index + Middle up) | `2 - TWO FINGERS` | *"Two"* |
| **`3`** | `[0, 1, 1, 1, 0]` (3 fingers up) | `3 - THREE FINGERS` | *"Three"* |
| **`4`** | `[0, 1, 1, 1, 1]` (4 fingers up, thumb curled) | `4 - FOUR FINGERS` | *"Four"* |
| **`5`** | `[1, 1, 1, 1, 1]` (Open Palm, all 5 fingers up) | `5 - OPEN PALM (ALL 5)` | *"Five"* |
| **`THUMB_UP`** | `[1, 0, 0, 0, 0]` (Thumb pointing up, 4 curled) | `THUMB OK / THUMBS UP` | *"Thumb OK"* |
| **`OK`** | Thumb + Index tips pinched in circle + 3 up | `OK SIGN (Thumb+Index)` | *"OK"* |
| **`ROCK`** | `[0, 1, 0, 0, 1]` (Index + Pinky up) | `ROCK ON` | *"Rock On"* |
| **`CALL_ME`** | `[1, 0, 0, 0, 1]` (Thumb + Pinky up) | `CALL ME` | *"Call Me"* |

---

## 2. Direct Clone & Run on Raspberry Pi

Open a terminal on your Raspberry Pi (or SSH via `ssh pi@raspberrypi.local`) and run:

```bash
# 1. Clone the repository directly onto your Raspberry Pi
git clone https://github.com/dattatraybhairi/rpi-spi-camera-streamer.git
cd rpi-spi-camera-streamer

# 2. Run the automated installer (installs picamera2, opencv, mediapipe, espeak-ng, spidev)
chmod +x install_rpi.sh
./install_rpi.sh

# 3. Run camera stream + Hand Gesture Palm Reader + Voice TTS on 3.5" SPI Display (/dev/fb1)
python3 rpi_camera_spi_stream.py --mode fb --fb-dev /dev/fb1 --width 480 --height 320 --fps 30 --gesture --tts --hud
```

### Single-Line Copy & Paste Command for Raspberry Pi Terminal

```bash
git clone https://github.com/dattatraybhairi/rpi-spi-camera-streamer.git && cd rpi-spi-camera-streamer && chmod +x install_rpi.sh && ./install_rpi.sh && python3 rpi_camera_spi_stream.py --mode fb --fb-dev /dev/fb1 --width 480 --height 320 --fps 30 --gesture --tts --hud
```

---

## 3. Run in Raw SPI Mode or Desktop Window Mode

### Raw SPI Mode (`/dev/spidev0.0` + GPIO 24/25)
```bash
python3 rpi_camera_spi_stream.py \
  --mode spi \
  --spi-bus 0 \
  --spi-cs 0 \
  --spi-speed 32000000 \
  --dc-pin 24 \
  --rst-pin 25 \
  --gesture \
  --tts \
  --hud
```

### Desktop X11/Wayland Window Preview Mode (`--mode window`)
```bash
python3 rpi_camera_spi_stream.py --mode window --camera-backend opencv --gesture --tts --hud
```

---

## 4. Push Updated Hand Gesture Code, `simulation.html` & GitHub Action to GitHub

```bash
git init
git add rpi_camera_spi_stream.py install_rpi.sh simulation.html .github/workflows/rpi-gesture-ci.yml README.md
git commit -m "Add MediaPipe hand gesture palm reader (1-5, Closed Hand, Thumb OK), simulation.html, and GitHub Action"
git branch -M main
git remote remove origin 2>/dev/null || true
git remote add origin https://github.com/dattatraybhairi/rpi-spi-camera-streamer.git
git push -u origin main
```
