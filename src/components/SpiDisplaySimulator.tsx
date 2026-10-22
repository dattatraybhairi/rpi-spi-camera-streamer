import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, Video, VideoOff, Volume2, VolumeX } from 'lucide-react';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { StreamConfig } from '../data/rpiTemplates';

interface SpiDisplaySimulatorProps {
  config: StreamConfig;
}

export interface HandGesturePreset {
  id: string;
  buttonLabel: string;
  hudBanner: string;
  spokenText: string;
  fingers: [number, number, number, number, number]; // [Thumb, Index, Middle, Ring, Pinky]
  pinch?: boolean;
}

export const HAND_GESTURE_PRESETS: HandGesturePreset[] = [
  {
    id: 'CLOSED_HAND',
    buttonLabel: 'Closed Hand (0)',
    hudBanner: 'CLOSED HAND (FIST - 0)',
    spokenText: 'Closed Hand',
    fingers: [0, 0, 0, 0, 0],
  },
  {
    id: '1',
    buttonLabel: '1 Finger',
    hudBanner: '1 - ONE FINGER',
    spokenText: 'One',
    fingers: [0, 1, 0, 0, 0],
  },
  {
    id: '2',
    buttonLabel: '2 Fingers',
    hudBanner: '2 - TWO FINGERS',
    spokenText: 'Two',
    fingers: [0, 1, 1, 0, 0],
  },
  {
    id: '3',
    buttonLabel: '3 Fingers',
    hudBanner: '3 - THREE FINGERS',
    spokenText: 'Three',
    fingers: [0, 1, 1, 1, 0],
  },
  {
    id: '4',
    buttonLabel: '4 Fingers',
    hudBanner: '4 - FOUR FINGERS',
    spokenText: 'Four',
    fingers: [0, 1, 1, 1, 1],
  },
  {
    id: '5',
    buttonLabel: '5 Open Palm',
    hudBanner: '5 - OPEN PALM (ALL 5)',
    spokenText: 'Five',
    fingers: [1, 1, 1, 1, 1],
  },
  {
    id: 'THUMB_UP',
    buttonLabel: 'Thumb OK',
    hudBanner: 'THUMB OK / THUMBS UP',
    spokenText: 'Thumb OK',
    fingers: [1, 0, 0, 0, 0],
  },
  {
    id: 'OK',
    buttonLabel: 'OK Sign',
    hudBanner: 'OK SIGN (Thumb+Index)',
    spokenText: 'OK',
    fingers: [1, 0, 1, 1, 1],
    pinch: true,
  },
  {
    id: 'ROCK',
    buttonLabel: 'Rock On',
    hudBanner: 'ROCK ON (Index+Pinky)',
    spokenText: 'Rock On',
    fingers: [0, 1, 0, 0, 1],
  },
  {
    id: 'CALL_ME',
    buttonLabel: 'Call Me',
    hudBanner: 'CALL ME (Thumb+Pinky)',
    spokenText: 'Call Me',
    fingers: [1, 0, 0, 0, 1],
  },
];

function classifyRealLandmarks(landmarks: { x: number; y: number; z?: number }[]): HandGesturePreset {
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  const indexUp = landmarks[8].y < landmarks[6].y - 0.015;
  const middleUp = landmarks[12].y < landmarks[10].y - 0.015;
  const ringUp = landmarks[16].y < landmarks[14].y - 0.015;
  const pinkyUp = landmarks[20].y < landmarks[18].y - 0.015;

  const thumbTipToPinky = dist(landmarks[4], landmarks[17]);
  const thumbIpToPinky = dist(landmarks[3], landmarks[17]);
  const thumbUp = thumbTipToPinky > thumbIpToPinky + 0.032;

  const fingers: [number, number, number, number, number] = [
    thumbUp ? 1 : 0,
    indexUp ? 1 : 0,
    middleUp ? 1 : 0,
    ringUp ? 1 : 0,
    pinkyUp ? 1 : 0,
  ];
  const fourFingersCount = (indexUp ? 1 : 0) + (middleUp ? 1 : 0) + (ringUp ? 1 : 0) + (pinkyUp ? 1 : 0);
  const totalFingers = fingers.reduce((a, b) => a + b, 0);

  const palmScale = Math.max(dist(landmarks[0], landmarks[9]), 0.05);
  const thumbIndexDist = dist(landmarks[4], landmarks[8]) / palmScale;

  if (thumbIndexDist < 0.36 && middleUp && ringUp && pinkyUp) {
    return { ...HAND_GESTURE_PRESETS[7], fingers };
  }
  if (thumbUp && fourFingersCount === 0) {
    if (landmarks[4].y < landmarks[2].y - 0.02) {
      return { ...HAND_GESTURE_PRESETS[6], fingers };
    }
    return { ...HAND_GESTURE_PRESETS[1], fingers };
  }
  if (totalFingers === 0) {
    return { ...HAND_GESTURE_PRESETS[0], fingers };
  }
  if (!thumbUp && indexUp && !middleUp && !ringUp && pinkyUp) {
    return { ...HAND_GESTURE_PRESETS[8], fingers };
  }
  if (thumbUp && !indexUp && !middleUp && !ringUp && pinkyUp) {
    return { ...HAND_GESTURE_PRESETS[9], fingers };
  }
  if (totalFingers === 1) return { ...HAND_GESTURE_PRESETS[1], fingers };
  if (totalFingers === 2) return { ...HAND_GESTURE_PRESETS[2], fingers };
  if (totalFingers === 3) return { ...HAND_GESTURE_PRESETS[3], fingers };
  if (totalFingers === 4) return { ...HAND_GESTURE_PRESETS[4], fingers };
  return { ...HAND_GESTURE_PRESETS[5], fingers };
}

export const SpiDisplaySimulator: React.FC<SpiDisplaySimulatorProps> = ({ config }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const lastSpokenRef = useRef<{ phrase: string; time: number }>({ phrase: '', time: 0 });

  const [useWebcam, setUseWebcam] = useState(false);
  const [webcamError, setWebcamError] = useState<string | null>(null);
  const [visionStatus, setVisionStatus] = useState<'idle' | 'loading' | 'ready' | 'fallback'>('idle');
  const [measuredFps, setMeasuredFps] = useState<number>(config.targetFps);
  const [rgb565Quantize, setRgb565Quantize] = useState<boolean>(true);
  const [touchPoint, setTouchPoint] = useState<{ x: number; y: number } | null>(null);
  const [activeGesture, setActiveGesture] = useState<HandGesturePreset>(HAND_GESTURE_PRESETS[5]);
  const [liveHandDetected, setLiveHandDetected] = useState<boolean>(false);
  const [autoCycleGestures, setAutoCycleGestures] = useState<boolean>(false);
  const [browserVoiceTts, setBrowserVoiceTts] = useState<boolean>(config.ttsEnabled);

  const frameBits = config.width * config.height * 16;
  const maxSpiBusFps = Math.min(60, Math.round((config.spiSpeedHz * 0.82) / frameBits));
  const effectiveTargetFps = Math.min(config.targetFps, maxSpiBusFps);
  const frameSizeKb = ((config.width * config.height * 2) / 1024).toFixed(0);
  const throughputMbps = ((effectiveTargetFps * frameBits) / 1_000_000).toFixed(2);

  const speakGesture = (phrase: string, respectCooldown = false) => {
    if (!browserVoiceTts || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }
    const now = performance.now();
    if (
      respectCooldown &&
      lastSpokenRef.current.phrase === phrase &&
      now - lastSpokenRef.current.time < 1900
    ) {
      return;
    }
    lastSpokenRef.current = { phrase, time: now };
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(phrase);
      utterance.rate = 1.05;
      window.speechSynthesis.speak(utterance);
    } catch {
      // Ignore browser speech errors
    }
  };

  const handleSelectGesture = (preset: HandGesturePreset) => {
    setActiveGesture(preset);
    speakGesture(preset.spokenText, false);
  };

  // Load MediaPipe HandLandmarker when live webcam is enabled
  useEffect(() => {
    let cancelled = false;
    if (useWebcam && !landmarkerRef.current && visionStatus === 'idle') {
      setVisionStatus('loading');
      (async () => {
        try {
          const vision = await FilesetResolver.forVisionTasks(
            'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
          );
          const handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath:
                'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
              delegate: 'GPU',
            },
            runningMode: 'VIDEO',
            numHands: 1,
            minHandDetectionConfidence: config.minDetectionConf,
            minHandPresenceConfidence: 0.55,
            minTrackingConfidence: 0.55,
          });
          if (!cancelled) {
            landmarkerRef.current = handLandmarker;
            setVisionStatus('ready');
          }
        } catch {
          if (!cancelled) {
            setVisionStatus('fallback');
          }
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [useWebcam, visionStatus, config.minDetectionConf]);

  useEffect(() => {
    if (!autoCycleGestures || useWebcam) return;
    const interval = setInterval(() => {
      setActiveGesture((prev) => {
        const idx = HAND_GESTURE_PRESETS.findIndex((p) => p.id === prev.id);
        const next = HAND_GESTURE_PRESETS[(idx + 1) % HAND_GESTURE_PRESETS.length];
        speakGesture(next.spokenText, false);
        return next;
      });
    }, 2200);
    return () => clearInterval(interval);
  }, [autoCycleGestures, useWebcam, browserVoiceTts]);

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
              : 'Camera permission denied or unavailable. Running synthetic CSI + Palm Reader feed.'
          );
          setUseWebcam(false);
        });
    } else {
      setLiveHandDetected(false);
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
      ctx.translate(w / 2, h / 2);
      if (config.rotation !== 0) {
        ctx.rotate((config.rotation * Math.PI) / 180);
      }
      ctx.scale(config.flipH ? -1 : 1, config.flipV ? -1 : 1);
      ctx.translate(-w / 2, -h / 2);

      let realHandLandmarks: { x: number; y: number }[] | null = null;

      if (useWebcam && videoRef.current && videoRef.current.readyState >= 2) {
        ctx.drawImage(videoRef.current, 0, 0, w, h);

        // Run real-time MediaPipe HandLandmarker inference on live camera video frame
        if (config.gestureEnabled && landmarkerRef.current) {
          try {
            const res = landmarkerRef.current.detectForVideo(videoRef.current, now);
            if (res.landmarks && res.landmarks.length > 0) {
              realHandLandmarks = res.landmarks[0];
              const classified = classifyRealLandmarks(realHandLandmarks);
              setLiveHandDetected(true);
              setActiveGesture(classified);
              speakGesture(classified.spokenText, true);
            } else {
              setLiveHandDetected(false);
            }
          } catch {
            // Continue rendering camera frame
          }
        }
      } else {
        const t = now * 0.0012;
        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#0f172a');
        grad.addColorStop(0.5, '#1e293b');
        grad.addColorStop(1, '#090d16');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
        ctx.lineWidth = 1;
        const step = 32;
        const offsetX = (t * 20) % step;
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
      }

      // Draw either real detected 21-point hand landmarks OR simulated preset hand landmarks
      if (config.gestureEnabled) {
        if (realHandLandmarks) {
          const pts = realHandLandmarks.map((lm) => [lm.x * w, lm.y * h] as [number, number]);
          const connections = [
            [0, 1], [1, 2], [2, 3], [3, 4],
            [0, 5], [5, 6], [6, 7], [7, 8],
            [5, 9], [9, 10], [10, 11], [11, 12],
            [9, 13], [13, 14], [14, 15], [15, 16],
            [13, 17], [17, 18], [18, 19], [19, 20],
            [0, 17],
          ];
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2;
          connections.forEach(([a, b]) => {
            ctx.beginPath();
            ctx.moveTo(pts[a][0], pts[a][1]);
            ctx.lineTo(pts[b][0], pts[b][1]);
            ctx.stroke();
          });

          const tipIds = new Set([4, 8, 12, 16, 20]);
          pts.forEach((pt, idx) => {
            ctx.fillStyle = tipIds.has(idx) ? '#4ade80' : '#f8fafc';
            ctx.beginPath();
            ctx.arc(pt[0], pt[1], tipIds.has(idx) ? 5.5 : 3.2, 0, Math.PI * 2);
            ctx.fill();
          });

          const palmX = (pts[0][0] + pts[5][0] + pts[9][0] + pts[13][0] + pts[17][0]) / 5;
          const palmY = (pts[0][1] + pts[5][1] + pts[9][1] + pts[13][1] + pts[17][1]) / 5;
          ctx.strokeStyle = '#facc15';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.arc(palmX, palmY, 18, 0, Math.PI * 2);
          ctx.stroke();
        } else if (!useWebcam) {
          const cx = w * 0.5 + Math.sin(now * 0.0022) * 8;
          const cy = h * 0.58 + Math.cos(now * 0.0018) * 5;
          const wrist: [number, number] = [cx, cy + 56];

          const mcps: [number, number][] = [
            [cx - 48, cy + 16],
            [cx - 28, cy - 18],
            [cx - 6, cy - 24],
            [cx + 16, cy - 20],
            [cx + 36, cy - 10],
          ];

          ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
          ctx.lineWidth = 1.5;
          for (let i = 0; i < mcps.length - 1; i++) {
            ctx.beginPath();
            ctx.moveTo(mcps[i][0], mcps[i][1]);
            ctx.lineTo(mcps[i + 1][0], mcps[i + 1][1]);
            ctx.stroke();
          }

          mcps.forEach((mcp, idx) => {
            const isExtended = activeGesture.fingers[idx] === 1;
            let tipX = mcp[0] + (idx === 0 ? (isExtended ? -38 : -8) : (idx - 2) * 7);
            let tipY = mcp[1] + (isExtended ? -66 : 20);

            if (activeGesture.id === 'THUMB_UP' && idx === 0) {
              tipX = mcp[0] - 12;
              tipY = mcp[1] - 68;
            }

            if (activeGesture.pinch && (idx === 0 || idx === 1)) {
              tipX = cx - 32;
              tipY = cy - 42;
            }

            const midX = (mcp[0] + tipX) / 2;
            const midY = (mcp[1] + tipY) / 2;

            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(wrist[0], wrist[1]);
            ctx.lineTo(mcp[0], mcp[1]);
            ctx.lineTo(midX, midY);
            ctx.lineTo(tipX, tipY);
            ctx.stroke();

            ctx.fillStyle = '#f8fafc';
            ctx.beginPath();
            ctx.arc(mcp[0], mcp[1], 3.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(midX, midY, 3, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = isExtended ? '#4ade80' : '#f43f5e';
            ctx.beginPath();
            ctx.arc(tipX, tipY, 5.5, 0, Math.PI * 2);
            ctx.fill();
          });

          ctx.fillStyle = '#f8fafc';
          ctx.beginPath();
          ctx.arc(wrist[0], wrist[1], 4.5, 0, Math.PI * 2);
          ctx.fill();

          const palmX = cx - 4;
          const palmY = cy + 6;
          ctx.strokeStyle = '#facc15';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(palmX, palmY, 18, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      ctx.restore();

      if (rgb565Quantize) {
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;
        for (let i = 0; i < data.length; i += 4) {
          data[i] = data[i] & 0xf8;
          data[i + 1] = data[i + 1] & 0xfc;
          data[i + 2] = data[i + 2] & 0xf8;
        }
        ctx.putImageData(imgData, 0, 0);
      }

      if (config.hud) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
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

        if (config.gestureEnabled) {
          ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
          ctx.fillRect(0, h - 34, w, 34);

          const bannerText =
            useWebcam && !liveHandDetected
              ? 'SHOW HAND TO CAMERA...'
              : activeGesture.hudBanner;

          ctx.font = 'bold 12px "JetBrains Mono", monospace';
          ctx.fillStyle = useWebcam && !liveHandDetected ? '#fbbf24' : '#4ade80';
          ctx.fillText(`PALM READER: ${bannerText}`, 10, h - 12);

          const upCount = activeGesture.fingers.reduce((a, b) => a + b, 0);
          ctx.font = '11px "JetBrains Mono", monospace';
          ctx.fillStyle = '#38bdf8';
          ctx.textAlign = 'right';
          ctx.fillText(`SPEAK: "${activeGesture.spokenText}" | UP: ${upCount}/5`, w - 10, h - 12);
          ctx.textAlign = 'left';
        }
      }

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
    config.gestureEnabled,
    config.mode,
    config.fbDevice,
    config.spiBus,
    config.spiCs,
    effectiveTargetFps,
    rgb565Quantize,
    useWebcam,
    liveHandDetected,
    touchPoint,
    activeGesture,
    browserVoiceTts,
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
            3.5&quot; SPI Display &amp; Live Hand Gesture Simulator ({config.width}×{config.height} RGB565)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            <span>
              {useWebcam
                ? visionStatus === 'ready'
                  ? 'Live Webcam MediaPipe HandLandmarker Active'
                  : 'Loading Live Hand Tracker...'
                : '21-Point MediaPipe Skeleton'}
            </span>
            <span className="mx-1.5" aria-hidden="true">·</span>
            <span>Spoken Output: &quot;{activeGesture.spokenText}&quot;</span>
            <span className="mx-1.5" aria-hidden="true">·</span>
            <span>Bitmask: [{activeGesture.fingers.join(', ')}]</span>
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setBrowserVoiceTts((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
              browserVoiceTts
                ? 'bg-emerald-950/60 text-emerald-300 border-emerald-700/70'
                : 'bg-slate-950 text-slate-400 border-slate-800'
            }`}
          >
            {browserVoiceTts ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
            Voice TTS: {browserVoiceTts ? 'On' : 'Muted'}
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
      <div className="flex flex-col items-center justify-center py-2">
        <div className="relative bg-slate-950 border-2 border-slate-700 rounded-xl p-4 shadow-inner max-w-full">
          <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mb-2 px-1">
            <span>RPi 3.5&quot; TFT LCD HAT (ILI9486 + HandLandmarker)</span>
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

          <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mt-2 px-1">
            <span>
              Gesture: {activeGesture.hudBanner}
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
              <button
                type="button"
                onClick={() => setRgb565Quantize((p) => !p)}
                className="text-sky-400 hover:underline whitespace-nowrap shrink-0"
              >
                RGB565 Quantize: {rgb565Quantize ? 'ON' : 'OFF'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Interactive Hand & Palm Gesture Preset Selector */}
      <div className="mt-4 pt-4 border-t border-slate-800">
        <div className="flex items-center justify-between gap-2 mb-2.5">
          <span className="text-xs font-medium text-slate-300">
            Test Hand &amp; Palm Gesture States (Or Show Hand to Live Camera)
          </span>
          <button
            type="button"
            onClick={() => setAutoCycleGestures((prev) => !prev)}
            className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
              autoCycleGestures
                ? 'bg-sky-600 text-white border-sky-500'
                : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
            }`}
          >
            Auto-Cycle Gestures: {autoCycleGestures ? 'Running' : 'Off'}
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {HAND_GESTURE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => handleSelectGesture(preset)}
              className={`px-2.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 text-center ${
                activeGesture.id === preset.id
                  ? 'bg-sky-600 text-white border-sky-500'
                  : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700'
              }`}
            >
              {preset.buttonLabel}
            </button>
          ))}
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
          <span className="text-slate-400 block">Palm Reader Output</span>
          <span className="font-mono text-sm font-semibold text-emerald-400 tabular-nums">
            &quot;{activeGesture.spokenText}&quot;
          </span>
          <span className="text-[11px] text-slate-500 block tabular-nums">
            Fingers Up: {activeGesture.fingers.reduce((a, b) => a + b, 0)} / 5
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
          <span className="text-slate-400 block">Recognition Engine</span>
          <span className="font-mono text-sm font-semibold text-slate-100">
            {useWebcam ? 'Live HandLandmarker' : 'MP Tasks + OpenCV'}
          </span>
          <span className="text-[11px] text-slate-500 block">
            Zero-crash 3-tier fallback
          </span>
        </div>
      </div>
    </div>
  );
};
