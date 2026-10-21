import React, { useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, Video, VideoOff } from 'lucide-react';
import { StreamConfig } from '../data/rpiTemplates';

interface SpiDisplaySimulatorProps {
  config: StreamConfig;
}

export const SpiDisplaySimulator: React.FC<SpiDisplaySimulatorProps> = ({ config }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [useWebcam, setUseWebcam] = useState(false);
  const [webcamError, setWebcamError] = useState<string | null>(null);
  const [measuredFps, setMeasuredFps] = useState<number>(config.targetFps);
  const [rgb565Quantize, setRgb565Quantize] = useState<boolean>(true);
  const [touchPoint, setTouchPoint] = useState<{ x: number; y: number } | null>(null);

  // Calculate theoretical SPI bus ceiling FPS:
  // Frame size = width * height * 16 bits. Effective SPI DMA efficiency ~82%
  const frameBits = config.width * config.height * 16;
  const maxSpiBusFps = Math.min(60, Math.round((config.spiSpeedHz * 0.82) / frameBits));
  const effectiveTargetFps = Math.min(config.targetFps, maxSpiBusFps);
  const frameSizeKb = ((config.width * config.height * 2) / 1024).toFixed(0);
  const throughputMbps = ((effectiveTargetFps * frameBits) / 1_000_000).toFixed(2);

  useEffect(() => {
    let stream: MediaStream | null = null;

    if (useWebcam) {
      setWebcamError(null);
      navigator.mediaDevices
        .getUserMedia({
          video: { width: { ideal: config.width }, height: { ideal: config.height } },
          audio: false,
        })
        .then((mediaStream) => {
          stream = mediaStream;
          if (videoRef.current) {
            videoRef.current.srcObject = mediaStream;
            videoRef.current.play().catch(() => {});
          }
        })
        .catch((err) => {
          setWebcamError(
            err instanceof Error
              ? err.message
              : 'Camera permission denied or unavailable. Running synthetic CSI test feed.'
          );
          setUseWebcam(false);
        });
    } else {
      if (videoRef.current && videoRef.current.srcObject) {
        const currentStream = videoRef.current.srcObject as MediaStream;
        currentStream.getTracks().forEach((t) => t.stop());
        videoRef.current.srcObject = null;
      }
    }

    return () => {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [useWebcam, config.width, config.height]);

  useEffect(() => {
    let animationFrameId: number;
    let lastRenderTime = performance.now();
    let smoothedFps = effectiveTargetFps;
    let tick = 0;

    const renderLoop = (now: number) => {
      animationFrameId = requestAnimationFrame(renderLoop);
      const minInterval = 1000 / Math.max(1, effectiveTargetFps);
      const elapsed = now - lastRenderTime;
      if (elapsed < minInterval) return;

      lastRenderTime = now;
      tick += 1;
      const instant = 1000 / Math.max(elapsed, 1);
      smoothedFps = smoothedFps * 0.88 + instant * 0.12;
      if (tick % 8 === 0) {
        setMeasuredFps(Number(smoothedFps.toFixed(1)));
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      const w = config.width;
      const h = config.height;

      ctx.save();
      // Apply software rotation / mirror inside canvas coordinate space
      ctx.translate(w / 2, h / 2);
      if (config.rotation !== 0) {
        ctx.rotate((config.rotation * Math.PI) / 180);
      }
      ctx.scale(config.flipH ? -1 : 1, config.flipV ? -1 : 1);
      ctx.translate(-w / 2, -h / 2);

      if (useWebcam && videoRef.current && videoRef.current.readyState >= 2) {
        ctx.drawImage(videoRef.current, 0, 0, w, h);
      } else {
        // Synthetic Raspberry Pi Camera Module v3 optical test target
        const t = now * 0.0012;
        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#0f172a');
        grad.addColorStop(0.5, '#1e293b');
        grad.addColorStop(1, '#090d16');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // Moving calibration grid
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
        ctx.lineWidth = 1;
        const step = 32;
        const offsetX = (t * 24) % step;
        for (let x = offsetX; x < w; x += step) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
        for (let y = 0; y < h; y += step) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }

        // SMPTE-style RGB565 color calibration bars at bottom
        const barColors = ['#ef4444', '#f59e0b', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#f8fafc'];
        const barWidth = w / barColors.length;
        barColors.forEach((col, idx) => {
          ctx.fillStyle = col;
          ctx.fillRect(idx * barWidth, h - 34, barWidth + 1, 34);
        });

        // Animated tracked target box simulating object inspection on RPi CSI feed
        const targetX = w * 0.5 + Math.cos(t * 1.3) * (w * 0.24);
        const targetY = h * 0.45 + Math.sin(t * 1.9) * (h * 0.18);

        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(targetX - 36, targetY - 28, 72, 56);

        ctx.fillStyle = '#38bdf8';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.fillText(
          `CSI_OBJ (${Math.round(targetX)},${Math.round(targetY)})`,
          targetX - 36,
          targetY - 33
        );
      }
      ctx.restore();

      // Simulate true 16-bit RGB565 bit-truncation ((R & 0xF8), (G & 0xFC), (B & 0xF8))
      if (rgb565Quantize) {
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;
        for (let i = 0; i < data.length; i += 4) {
          data[i] = data[i] & 0xf8;     // 5-bit Red
          data[i + 1] = data[i + 1] & 0xfc; // 6-bit Green
          data[i + 2] = data[i + 2] & 0xf8; // 5-bit Blue
        }
        ctx.putImageData(imgData, 0, 0);
      }

      // Draw HUD overlay matching rpi_camera_spi_stream.py draw_hud()
      if (config.hud) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
        ctx.fillRect(0, 0, w, 26);

        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.fillStyle = '#f8fafc';
        const modeLabel =
          config.mode === 'fb' ? config.fbDevice : `SPI${config.spiBus}.${config.spiCs}`;
        ctx.fillText(`SPI 3.5" ${w}x${h} RGB565 | ${modeLabel}`, 8, 17);

        const timeStr = new Date().toTimeString().slice(0, 8);
        ctx.fillStyle = '#4ade80';
        ctx.textAlign = 'right';
        ctx.fillText(`${smoothedFps.toFixed(1)} FPS | 47.2C | ${timeStr}`, w - 8, 17);
        ctx.textAlign = 'left';

        // Center optical reticle
        const cx = Math.floor(w / 2);
        const cy = Math.floor(h / 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - 12, cy);
        ctx.lineTo(cx - 4, cy);
        ctx.moveTo(cx + 4, cy);
        ctx.lineTo(cx + 12, cy);
        ctx.moveTo(cx, cy - 12);
        ctx.lineTo(cx, cy - 4);
        ctx.moveTo(cx, cy + 4);
        ctx.lineTo(cx, cy + 12);
        ctx.stroke();
      }

      // Render resistive XPT2046 touch coordinate probe if user clicked screen
      if (touchPoint) {
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(touchPoint.x, touchPoint.y, 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#fbbf24';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.fillText(
          `XPT2046 (${touchPoint.x},${touchPoint.y})`,
          Math.min(w - 115, touchPoint.x + 12),
          Math.max(38, touchPoint.y - 6)
        );
      }
    };

    animationFrameId = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(animationFrameId);
  }, [
    config.width,
    config.height,
    config.rotation,
    config.flipH,
    config.flipV,
    config.hud,
    config.mode,
    config.fbDevice,
    config.spiBus,
    config.spiCs,
    effectiveTargetFps,
    rgb565Quantize,
    useWebcam,
    touchPoint,
  ]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = config.width / rect.width;
    const scaleY = config.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    setTouchPoint({ x, y });
  };

  return (
    <div className="border border-slate-800 bg-slate-900/70 rounded-xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 mb-4 border-b border-slate-800">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            3.5&quot; SPI Hardware Display Preview ({config.width}×{config.height} RGB565)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            <span>{config.displayModel.toUpperCase()}</span>
            <span className="mx-1.5" aria-hidden="true">·</span>
            <span>{config.mode === 'fb' ? `Framebuffer ${config.fbDevice}` : `Raw SPI0 CE${config.spiCs}`}</span>
            <span className="mx-1.5" aria-hidden="true">·</span>
            <span>Click LCD surface to test XPT2046 touch coordinates</span>
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setRgb565Quantize((prev) => !prev)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
              rgb565Quantize
                ? 'bg-slate-800 text-slate-100 border-slate-700'
                : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
            }`}
          >
            16-Bit RGB565: {rgb565Quantize ? 'Active' : 'Bypass'}
          </button>

          <button
            type="button"
            onClick={() => setUseWebcam((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
              useWebcam
                ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                : 'bg-sky-600 text-white hover:bg-sky-500'
            }`}
          >
            {useWebcam ? <VideoOff className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
            {useWebcam ? 'Stop Live Camera' : 'Test with Local Camera'}
          </button>
        </div>
      </div>

      {webcamError && (
        <div className="mb-4 px-3.5 py-2.5 rounded-lg border border-amber-800/60 bg-amber-950/40 text-xs text-amber-200 flex items-center justify-between">
          <span>{webcamError}</span>
          <button
            type="button"
            onClick={() => setWebcamError(null)}
            className="text-amber-300 underline ml-3 whitespace-nowrap shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      <video ref={videoRef} className="hidden" playsInline muted />

      {/* Physical 3.5-inch Raspberry Pi SPI Hat PCB Casing */}
      <div className="flex flex-col items-center justify-center py-3">
        <div className="relative bg-slate-950 border-2 border-slate-700 rounded-xl p-4 shadow-inner max-w-full">
          {/* Top silk-screen markings */}
          <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mb-2 px-1">
            <span>RPi 3.5&quot; TFT LCD HAT (ILI9486 / XPT2046)</span>
            <span className="tabular-nums">
              SPI SCLK: {(config.spiSpeedHz / 1_000_000).toFixed(0)}MHz · {frameSizeKb}KB/frame
            </span>
          </div>

          <canvas
            ref={canvasRef}
            width={config.width}
            height={config.height}
            onClick={handleCanvasClick}
            className="w-full max-w-[480px] aspect-[3/2] rounded border border-slate-800 cursor-crosshair bg-black block"
          />

          {/* Bottom silk-screen markings */}
          <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mt-2 px-1">
            <span>
              GPIO DC:{config.dcPin} · RST:{config.rstPin} · CS:CE{config.spiCs}
            </span>
            {touchPoint ? (
              <button
                type="button"
                onClick={() => setTouchPoint(null)}
                className="text-amber-400 hover:underline inline-flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <RefreshCw className="w-3 h-3" />
                Clear Touch ({touchPoint.x}, {touchPoint.y})
              </button>
            ) : (
              <span>Source: {useWebcam ? 'Live Local Camera' : 'Synthetic CSI Pattern'}</span>
            )}
          </div>
        </div>
      </div>

      {/* Hardware Telemetry Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-slate-800 text-xs">
        <div>
          <span className="text-slate-400 block">Effective Frame Rate</span>
          <span className="font-mono text-sm font-semibold text-slate-100 tabular-nums">
            {measuredFps.toFixed(1)} FPS
          </span>
          <span className="text-[11px] text-slate-500 block tabular-nums">
            SPI Ceiling: {maxSpiBusFps} FPS @ {config.spiSpeedHz / 1_000_000} MHz
          </span>
        </div>

        <div>
          <span className="text-slate-400 block">SPI Bus Bandwidth</span>
          <span className="font-mono text-sm font-semibold text-slate-100 tabular-nums">
            {throughputMbps} Mbps
          </span>
          <span className="text-[11px] text-slate-500 block tabular-nums">
            {frameSizeKb} KB / frame (RGB565)
          </span>
        </div>

        <div>
          <span className="text-slate-400 block">Display Target</span>
          <span className="font-mono text-sm font-semibold text-slate-100 tabular-nums">
            {config.mode === 'fb' ? config.fbDevice : `/dev/spidev${config.spiBus}.${config.spiCs}`}
          </span>
          <span className="text-[11px] text-slate-500 block">
            {config.mode === 'fb' ? 'Kernel DMA Framebuffer' : 'Userspace spidev + GPIO'}
          </span>
        </div>

        <div>
          <span className="text-slate-400 block">Camera Driver</span>
          <span className="font-mono text-sm font-semibold text-slate-100">
            {config.cameraBackend === 'auto' ? 'Picamera2 / V4L2' : config.cameraBackend}
          </span>
          <span className="text-[11px] text-slate-500 block tabular-nums">
            Device Index: {config.cameraIndex} · Rot: {config.rotation}°
          </span>
        </div>
      </div>
    </div>
  );
};
