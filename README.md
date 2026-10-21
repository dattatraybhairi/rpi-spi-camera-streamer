# Raspberry Pi 3.5" SPI Display Camera Streamer (`rpi_camera_spi_stream.py`)

High-throughput Python camera streamer designed for **3.5-inch 480×320 SPI LCD displays** (ILI9486, ILI9488, ST7796S, Waveshare 3.5" A/B/C, MHS35, GoodTFT) connected to a **Raspberry Pi** (Pi 3B+, Pi 4, Pi 5, Pi Zero 2 W).

Includes:
- **`rpi_camera_spi_stream.py`** — Production Python streamer supporting both **Linux Framebuffer (`/dev/fb1`)** with vectorized NumPy `BGR888 -> RGB565` bit-packing and **Raw `spidev` + GPIO (`ILI9486`)** transfer.
- **`install_rpi.sh`** — One-step dependency installer, SPI overlay check, and `systemd` auto-boot service installer.
- **Interactive Web Workbench & SPI Display Simulator** — Test RGB565 quantization, SPI bus clock limits (16 MHz – 64 MHz), GPIO pinouts, and generate customized git push / RPi clone commands.

---

## 1. Quick Clone & Run Directly on Raspberry Pi

SSH into your Raspberry Pi (or open Terminal on the Pi) and run the following commands to clone, install dependencies, and start streaming immediately:

```bash
# 1. Clone the repository directly onto your Raspberry Pi
git clone https://github.com/YOUR_USERNAME/rpi-spi-camera-streamer.git
cd rpi-spi-camera-streamer

# 2. Run the automated installer (installs python3-picamera2, python3-opencv, spidev, and configures SPI)
chmod +x install_rpi.sh
./install_rpi.sh

# 3. Run the camera stream directly on the 3.5" SPI display (Framebuffer mode - /dev/fb1)
python3 rpi_camera_spi_stream.py --mode fb --fb-dev /dev/fb1 --width 480 --height 320 --fps 30 --hud
```

### Run in Raw SPI Mode (Without Kernel `/dev/fb1` Driver)

If your 3.5" SPI LCD does not expose `/dev/fb1` and is wired directly to `SPI0 CE0` (`/dev/spidev0.0`), run in `--mode spi`:

```bash
python3 rpi_camera_spi_stream.py \
  --mode spi \
  --spi-bus 0 \
  --spi-cs 0 \
  --spi-speed 32000000 \
  --dc-pin 24 \
  --rst-pin 25 \
  --width 480 \
  --height 320 \
  --fps 30
```

---

## 2. 3.5" SPI Display Hardware Wiring (40-Pin GPIO Header)

Standard Waveshare / MHS35 / ILI9486 3.5-inch SPI LCD hats plug directly onto the first 26 pins of the Raspberry Pi 40-pin header:

| Function | RPi Physical Pin | BCM GPIO | SPI / Signal Name | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **5V Power** | Pin 2 & Pin 4 | — | `5V` | Main LCD backlight & logic power |
| **3.3V Logic** | Pin 1 & Pin 17 | — | `3V3` | IO reference voltage |
| **Ground** | Pin 6, 9, 14, 20, 25 | — | `GND` | Common ground |
| **SPI MOSI** | Pin 19 | `GPIO 10` | `SPI0_MOSI` | Master Out Slave In pixel stream |
| **SPI MISO** | Pin 21 | `GPIO 9` | `SPI0_MISO` | Touch controller readback |
| **SPI SCLK** | Pin 23 | `GPIO 11` | `SPI0_SCLK` | High-speed SPI clock (16–64 MHz) |
| **LCD CS** | Pin 24 | `GPIO 8` | `SPI0_CE0_N` | Display Chip Select |
| **Touch CS** | Pin 26 | `GPIO 7` | `SPI0_CE1_N` | XPT2046 Touch Chip Select |
| **LCD DC** | Pin 18 | `GPIO 24` | `LCD_DC` | Data (`HIGH`) / Command (`LOW`) |
| **LCD RST** | Pin 22 | `GPIO 25` | `LCD_RST` | Hardware Reset (active `LOW`) |

---

## 3. Enabling `/dev/fb1` via Device Tree Overlay (`config.txt`)

To achieve maximum frame rates using kernel DMA over `/dev/fb1`, add the appropriate overlay to `/boot/firmware/config.txt` (or `/boot/config.txt` on older OS releases):

```ini
dtparam=spi=on
dtoverlay=piscreen,speed=32000000,rotate=90
```

For MHS35 / Waveshare 3.5" Rev B/C displays:
```ini
dtparam=spi=on
dtoverlay=waveshare35a:rotate=90,speed=32000000,fps=30
```

Reboot the Raspberry Pi (`sudo reboot`) and confirm `/dev/fb1` exists with `ls -l /dev/fb*`.

---

## 4. Command-Line Arguments Reference

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--mode` | `fb` | `fb` for `/dev/fb1` Linux framebuffer or `spi` for raw `spidev` ILI9486 driver |
| `--fb-dev` | `/dev/fb1` | Framebuffer device node (`/dev/fb1` or `/dev/fb0`) |
| `--spi-speed` | `32000000` | SPI clock speed in Hz (`32000000` = 32 MHz) |
| `--camera-backend` | `auto` | `auto` (tries Picamera2 then OpenCV V4L2), `picamera2`, or `opencv` |
| `--camera-index` | `0` | Camera index (`0` for CSI0 or `/dev/video0`) |
| `--width` | `480` | Horizontal resolution in pixels |
| `--height` | `320` | Vertical resolution in pixels |
| `--fps` | `30` | Target capture frame rate |
| `--rotation` | `0` | Software rotation (`0`, `90`, `180`, `270`) |
| `--flip-h` | `False` | Mirror frame horizontally |
| `--flip-v` | `False` | Flip frame vertically |
| `--hud` / `--no-hud` | `--hud` | Toggle on-screen telemetry bar and center crosshair |

---

## 5. Build, Commit & Push Changes to Git

After customizing parameters or modifying the streamer script, push to your remote Git repository so your Raspberry Pi can `git pull`:

```bash
git init
git add rpi_camera_spi_stream.py install_rpi.sh README.md
git commit -m "Add 3.5 inch RPi SPI display camera streamer and direct setup script"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/rpi-spi-camera-streamer.git
git push -u origin main
```
