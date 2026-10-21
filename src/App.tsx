import React, { useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FileCode,
  GitBranch,
  HardDrive,
  RefreshCw,
  Terminal,
} from 'lucide-react';
import {
  DEFAULT_CONFIG,
  generateInstallScript,
  generatePythonScript,
  generateReadmeMarkdown,
  StreamConfig,
} from './data/rpiTemplates';
import { SpiDisplaySimulator } from './components/SpiDisplaySimulator';
import { GpioPinoutTable } from './components/GpioPinoutTable';

type CodeTab = 'python' | 'readme' | 'install';

export default function App() {
  const [config, setConfig] = useState<StreamConfig>(DEFAULT_CONFIG);
  const [activeTab, setActiveTab] = useState<CodeTab>('python');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<{
    status: 'idle' | 'saving' | 'saved' | 'error';
    message: string;
  }>({
    status: 'idle',
    message: 'Workspace files synced on disk',
  });

  const pythonScript = useMemo(() => generatePythonScript(config), [config]);
  const installScript = useMemo(() => generateInstallScript(config), [config]);
  const readmeMarkdown = useMemo(() => generateReadmeMarkdown(config), [config]);

  const repoFolder =
    config.gitRepoUrl.split('/').pop()?.replace(/\.git$/, '') || 'rpi-spi-camera-streamer';

  const directRunCommand = useMemo(() => {
    const modeArgs =
      config.mode === 'fb'
        ? `--mode fb --fb-dev ${config.fbDevice}`
        : `--mode spi --spi-bus ${config.spiBus} --spi-cs ${config.spiCs} --spi-speed ${config.spiSpeedHz} --dc-pin ${config.dcPin} --rst-pin ${config.rstPin}`;
    return `python3 rpi_camera_spi_stream.py ${modeArgs} --camera-backend ${config.cameraBackend} --width ${config.width} --height ${config.height} --fps ${config.targetFps}${
      config.rotation ? ` --rotation ${config.rotation}` : ''
    }${config.flipH ? ' --flip-h' : ''}${config.flipV ? ' --flip-v' : ''}${
      config.hud ? ' --hud' : ' --no-hud'
    }`;
  }, [config]);

  const oneLineCloneAndRun = useMemo(() => {
    return `git clone ${config.gitRepoUrl} && cd ${repoFolder} && chmod +x install_rpi.sh && ./install_rpi.sh && ${directRunCommand}`;
  }, [config.gitRepoUrl, repoFolder, directRunCommand]);

  const gitPushBlock = useMemo(() => {
    return `git init
git add rpi_camera_spi_stream.py install_rpi.sh README.md
git commit -m "Build and push 3.5 inch RPi SPI camera streamer and direct run README"
git branch -M main
git remote remove origin 2>/dev/null || true
git remote add origin ${config.gitRepoUrl}
git push -u origin main`;
  }, [config.gitRepoUrl]);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev));
      }, 1800);
    } catch {
      // Fallback copy if clipboard restricted
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    }
  };

  const handleDownload = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadAll = () => {
    handleDownload('rpi_camera_spi_stream.py', pythonScript);
    setTimeout(() => handleDownload('install_rpi.sh', installScript), 150);
    setTimeout(() => handleDownload('README.md', readmeMarkdown), 300);
  };

  const handleSyncToWorkspace = async () => {
    setSyncState({ status: 'saving', message: 'Writing files to project root...' });
    try {
      const res = await fetch('/api/sync-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to sync workspace files');
      }
      setSyncState({
        status: 'saved',
        message: 'Synced rpi_camera_spi_stream.py, install_rpi.sh & README.md to disk',
      });
    } catch (err) {
      setSyncState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Sync failed',
      });
    }
  };

  const currentFileContent =
    activeTab === 'python'
      ? pythonScript
      : activeTab === 'readme'
      ? readmeMarkdown
      : installScript;

  const currentFileName =
    activeTab === 'python'
      ? 'rpi_camera_spi_stream.py'
      : activeTab === 'readme'
      ? 'README.md'
      : 'install_rpi.sh';

  return (
    <div className="min-h-screen bg-[#0F172A] text-slate-100 flex flex-col">
      {/* Top Bar Contract: Zone 1 Brand — Zone 2 4 Nav Links — Zone 3 1 Primary Action */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm sticky top-0 z-30">
        <a
          href="#top"
          className="text-lg font-bold tracking-tight text-slate-100 font-display whitespace-nowrap shrink-0"
        >
          RPi SPI Streamer
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <a
            href="#simulator"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Display Simulator
          </a>
          <a
            href="#code-files"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Python &amp; README
          </a>
          <a
            href="#git-deploy"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Push &amp; Clone
          </a>
          <a
            href="#gpio-wiring"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            SPI Pinout
          </a>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleDownloadAll}
            className="px-4 py-2 text-xs font-medium text-white bg-sky-600 rounded-lg hover:bg-sky-500 transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            Download RPi Bundle
          </button>
        </div>
      </header>

      {/* Main Content Container */}
      <main id="top" className="max-w-[1380px] w-full mx-auto px-6 py-8 space-y-10 flex-1">
        {/* Hero Overview & Direct Run Command Bar */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
          <div className="lg:col-span-7 border border-slate-800 bg-slate-900/70 rounded-xl p-6 flex flex-col justify-between">
            <div>
              <p className="text-xs text-slate-400 mb-2">
                <span>Raspberry Pi OS Bookworm / Bullseye</span>
                <span className="mx-1.5" aria-hidden="true">·</span>
                <span>3.5&quot; 480×320 SPI LCD (ILI9486 / Waveshare / MHS35)</span>
                <span className="mx-1.5" aria-hidden="true">·</span>
                <span>16-Bit RGB565</span>
              </p>
              <h1
                className="text-2xl sm:text-3xl font-bold text-slate-50 font-display tracking-tight"
                style={{ textWrap: 'balance' }}
              >
                Python Camera Streamer for 3.5-Inch Raspberry Pi SPI Displays
              </h1>
              <p className="text-sm text-slate-300 mt-3 leading-relaxed max-w-[68ch]">
                Streams live frames from a Raspberry Pi CSI Ribbon Camera (<code className="text-sky-300">Picamera2</code>) or USB V4L2 Webcam (<code className="text-sky-300">OpenCV</code>) directly to a 3.5-inch SPI display using either kernel DMA Framebuffer (<code className="text-emerald-300">/dev/fb1</code>) with vectorized NumPy RGB565 packing or userspace <code className="text-emerald-300">spidev0.0</code> + GPIO hardware control.
              </p>
            </div>

            <div className="mt-6 pt-5 border-t border-slate-800">
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-xs font-medium text-slate-300">
                  Direct Clone &amp; Run on Raspberry Pi Terminal
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy('hero-clone', oneLineCloneAndRun)}
                  className="px-2.5 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  {copiedId === 'hero-clone' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      Copied Command
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy One-Liner
                    </>
                  )}
                </button>
              </div>
              <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs font-mono text-emerald-300 overflow-x-auto">
                {oneLineCloneAndRun}
              </pre>
            </div>
          </div>

          {/* Hardware Parameter Configurator */}
          <div className="lg:col-span-5 border border-slate-800 bg-slate-900/70 rounded-xl p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between gap-2 pb-3 mb-4 border-b border-slate-800">
                <div>
                  <h2 className="text-base font-semibold text-slate-100">
                    SPI Display &amp; Camera Configuration
                  </h2>
                  <p className="text-xs text-slate-400">
                    Adjust hardware flags to update the Python script, simulator, and README live
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleSyncToWorkspace}
                  className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-lg border border-slate-700 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <HardDrive className="w-3.5 h-3.5 text-sky-400" />
                  {syncState.status === 'saving' ? 'Syncing...' : 'Sync Disk Files'}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block text-slate-400 mb-1">SPI Transport Mode</label>
                  <div className="flex p-1 bg-slate-950 border border-slate-800 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setConfig((c) => ({ ...c, mode: 'fb' }))}
                      className={`flex-1 py-1.5 px-2 rounded-md font-medium transition-colors whitespace-nowrap shrink-0 ${
                        config.mode === 'fb'
                          ? 'bg-sky-600 text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Framebuffer (/dev/fb1)
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfig((c) => ({ ...c, mode: 'spi' }))}
                      className={`flex-1 py-1.5 px-2 rounded-md font-medium transition-colors whitespace-nowrap shrink-0 ${
                        config.mode === 'spi'
                          ? 'bg-sky-600 text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Raw spidev0.0
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">3.5&quot; Display Hat Model</label>
                  <select
                    value={config.displayModel}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        displayModel: e.target.value as StreamConfig['displayModel'],
                      }))
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                  >
                    <option value="waveshare35a">Waveshare 3.5&quot; Rev A/B/C</option>
                    <option value="mhs35">MHS-3.5&quot; SPI RPi Display</option>
                    <option value="ili9486_raw">Generic ILI9486 / XPT2046</option>
                    <option value="st7796s">3.5&quot; IPS ST7796S SPI</option>
                  </select>
                </div>

                {config.mode === 'fb' ? (
                  <div>
                    <label className="block text-slate-400 mb-1">Linux Framebuffer Node</label>
                    <select
                      value={config.fbDevice}
                      onChange={(e) => setConfig((c) => ({ ...c, fbDevice: e.target.value }))}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 font-mono text-slate-100 focus:outline-none focus:border-sky-500"
                    >
                      <option value="/dev/fb1">/dev/fb1 (SPI Secondary LCD)</option>
                      <option value="/dev/fb0">/dev/fb0 (Primary Framebuffer)</option>
                    </select>
                  </div>
                ) : (
                  <div>
                    <label className="block text-slate-400 mb-1">BCM GPIO Pins (DC / RST)</label>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="number"
                        value={config.dcPin}
                        onChange={(e) =>
                          setConfig((c) => ({ ...c, dcPin: Number(e.target.value) || 24 }))
                        }
                        className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 font-mono text-slate-100 tabular-nums"
                        title="DC BCM GPIO Pin"
                      />
                      <input
                        type="number"
                        value={config.rstPin}
                        onChange={(e) =>
                          setConfig((c) => ({ ...c, rstPin: Number(e.target.value) || 25 }))
                        }
                        className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 font-mono text-slate-100 tabular-nums"
                        title="RST BCM GPIO Pin"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-slate-400 mb-1">SPI Clock Speed (Hz)</label>
                  <select
                    value={config.spiSpeedHz}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, spiSpeedHz: Number(e.target.value) }))
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 font-mono text-slate-100 tabular-nums focus:outline-none focus:border-sky-500"
                  >
                    <option value={16000000}>16 MHz (16,000,000 Hz - Safe)</option>
                    <option value={24000000}>24 MHz (24,000,000 Hz - Balanced)</option>
                    <option value={32000000}>32 MHz (32,000,000 Hz - Standard)</option>
                    <option value={48000000}>48 MHz (48,000,000 Hz - High Speed)</option>
                    <option value={64000000}>64 MHz (64,000,000 Hz - Overclock)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Camera Backend</label>
                  <select
                    value={config.cameraBackend}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        cameraBackend: e.target.value as StreamConfig['cameraBackend'],
                      }))
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                  >
                    <option value="auto">Auto (Picamera2 → OpenCV V4L2)</option>
                    <option value="picamera2">Picamera2 (CSI Ribbon Camera)</option>
                    <option value="opencv">OpenCV V4L2 (/dev/video0 USB)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Target FPS &amp; Rotation</label>
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      value={config.targetFps}
                      onChange={(e) =>
                        setConfig((c) => ({ ...c, targetFps: Number(e.target.value) }))
                      }
                      className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-2 font-mono text-slate-100 tabular-nums"
                    >
                      <option value={15}>15 FPS</option>
                      <option value={24}>24 FPS</option>
                      <option value={30}>30 FPS</option>
                      <option value={45}>45 FPS</option>
                    </select>
                    <select
                      value={config.rotation}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          rotation: Number(e.target.value) as StreamConfig['rotation'],
                        }))
                      }
                      className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-2 font-mono text-slate-100 tabular-nums"
                    >
                      <option value={0}>0°</option>
                      <option value={90}>90°</option>
                      <option value={180}>180°</option>
                      <option value={270}>270°</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Checkboxes for HUD, Mirroring, Systemd */}
              <div className="flex flex-wrap items-center gap-4 mt-4 pt-3 border-t border-slate-800/80 text-xs text-slate-300">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.hud}
                    onChange={(e) => setConfig((c) => ({ ...c, hud: e.target.checked }))}
                    className="rounded border-slate-700 bg-slate-950 text-sky-500"
                  />
                  <span>Draw Telemetry HUD</span>
                </label>

                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.flipH}
                    onChange={(e) => setConfig((c) => ({ ...c, flipH: e.target.checked }))}
                    className="rounded border-slate-700 bg-slate-950 text-sky-500"
                  />
                  <span>Mirror Horizontal</span>
                </label>

                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.flipV}
                    onChange={(e) => setConfig((c) => ({ ...c, flipV: e.target.checked }))}
                    className="rounded border-slate-700 bg-slate-950 text-sky-500"
                  />
                  <span>Flip Vertical</span>
                </label>

                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.enableSystemd}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, enableSystemd: e.target.checked }))
                    }
                    className="rounded border-slate-700 bg-slate-950 text-sky-500"
                  />
                  <span>Systemd Auto-Boot</span>
                </label>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
              <span>{syncState.message}</span>
              <button
                type="button"
                onClick={() => setConfig(DEFAULT_CONFIG)}
                className="text-slate-400 hover:text-slate-200 underline whitespace-nowrap shrink-0"
              >
                Reset Defaults
              </button>
            </div>
          </div>
        </section>

        {/* Section 2: Interactive 3.5" SPI Display Hardware Simulator & Code Viewer */}
        <section id="simulator" className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-6">
            <SpiDisplaySimulator config={config} />
          </div>

          {/* Code & README Inspector */}
          <div
            id="code-files"
            className="lg:col-span-6 border border-slate-800 bg-slate-900/70 rounded-xl overflow-hidden flex flex-col"
          >
            <div className="px-5 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
              {/* Segmented File Selector */}
              <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
                <button
                  type="button"
                  onClick={() => setActiveTab('python')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    activeTab === 'python'
                      ? 'bg-sky-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  rpi_camera_spi_stream.py
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('readme')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    activeTab === 'readme'
                      ? 'bg-sky-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  README.md
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('install')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    activeTab === 'install'
                      ? 'bg-sky-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  install_rpi.sh
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleCopy('code-viewer', currentFileContent)}
                  className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  {copiedId === 'code-viewer' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy File
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => handleDownload(currentFileName, currentFileContent)}
                  className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  Save {currentFileName}
                </button>
              </div>
            </div>

            <div className="p-4 bg-slate-950 overflow-auto max-h-[540px]">
              <pre className="text-xs font-mono text-slate-200 leading-relaxed whitespace-pre">
                {currentFileContent}
              </pre>
            </div>
          </div>
        </section>

        {/* Section 3: Build, Push to Git & Direct Raspberry Pi Clone / Run Pipeline */}
        <section
          id="git-deploy"
          className="border border-slate-800 bg-slate-900/70 rounded-xl p-6 space-y-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-100 font-display">
                Build, Push to Git &amp; Direct Clone on Raspberry Pi
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Set your Git repository URL and Raspberry Pi SSH target to generate ready-to-run push and clone commands
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs">
              <div className="flex items-center gap-2">
                <label className="text-slate-400 whitespace-nowrap">Git Remote URL:</label>
                <input
                  type="text"
                  value={config.gitRepoUrl}
                  onChange={(e) => setConfig((c) => ({ ...c, gitRepoUrl: e.target.value }))}
                  className="w-72 sm:w-80 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 font-mono text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="text-slate-400 whitespace-nowrap">RPi Host:</label>
                <input
                  type="text"
                  value={config.rpiHost}
                  onChange={(e) => setConfig((c) => ({ ...c, rpiHost: e.target.value }))}
                  className="w-36 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 font-mono text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Step 1: Build & Push Code to Remote Repository */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-sky-400" />
                    <h3 className="text-sm font-semibold text-slate-100">
                      01. Build &amp; Push Code to Git Repository
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopy('git-push', gitPushBlock)}
                    className="px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    {copiedId === 'git-push' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copy Git Push
                      </>
                    )}
                  </button>
                </div>
                <p className="text-xs text-slate-400 mb-3">
                  Stages <code className="text-slate-200">rpi_camera_spi_stream.py</code>,{' '}
                  <code className="text-slate-200">install_rpi.sh</code>, and{' '}
                  <code className="text-slate-200">README.md</code> and pushes them to your remote Git repository.
                </p>
                <pre className="text-xs font-mono text-sky-300 overflow-x-auto leading-relaxed">
                  {gitPushBlock}
                </pre>
              </div>
            </div>

            {/* Step 2: Clone & Run Directly on Raspberry Pi */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-emerald-400" />
                    <h3 className="text-sm font-semibold text-slate-100">
                      02. Clone &amp; Run Directly on Raspberry Pi ({config.rpiUser}@{config.rpiHost})
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      handleCopy(
                        'rpi-clone-steps',
                        `git clone ${config.gitRepoUrl}\ncd ${repoFolder}\nchmod +x install_rpi.sh && ./install_rpi.sh\n${directRunCommand}`
                      )
                    }
                    className="px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    {copiedId === 'rpi-clone-steps' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copy RPi Commands
                      </>
                    )}
                  </button>
                </div>
                <p className="text-xs text-slate-400 mb-3">
                  Run directly inside your Raspberry Pi terminal to clone the repo, configure SPI, and stream camera frames to the 3.5&quot; display:
                </p>
                <pre className="text-xs font-mono text-emerald-300 overflow-x-auto leading-relaxed">
{`git clone ${config.gitRepoUrl}
cd ${repoFolder}
chmod +x install_rpi.sh && ./install_rpi.sh
${directRunCommand}`}
                </pre>
              </div>
            </div>
          </div>
        </section>

        {/* Section 4: 40-Pin GPIO Wiring Reference */}
        <section id="gpio-wiring">
          <GpioPinoutTable config={config} />
        </section>
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-800/80 py-5 px-6 text-xs text-slate-500">
        <div className="max-w-[1380px] mx-auto flex flex-wrap items-center justify-between gap-4">
          <span>
            Raspberry Pi 3.5&quot; SPI Display Camera Streamer · Supports Picamera2 CSI &amp; OpenCV V4L2 in 16-bit RGB565
          </span>
          <div className="flex items-center gap-4">
            <a href="/api/raw/rpi_camera_spi_stream.py" target="_blank" rel="noreferrer" className="hover:text-slate-300">
              Raw Python Script
            </a>
            <span aria-hidden="true">·</span>
            <a href="/api/raw/install_rpi.sh" target="_blank" rel="noreferrer" className="hover:text-slate-300">
              Raw Installer Script
            </a>
            <span aria-hidden="true">·</span>
            <a href="/api/raw/README.md" target="_blank" rel="noreferrer" className="hover:text-slate-300">
              Raw README.md
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
