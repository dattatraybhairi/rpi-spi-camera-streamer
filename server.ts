import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import {
  DEFAULT_CONFIG,
  generateGithubActionYaml,
  generateInstallScript,
  generatePythonScript,
  generateReadmeMarkdown,
  generateSimulationHtml,
  StreamConfig,
} from './src/data/rpiTemplates.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '2mb' }));

  // Sync generated Python script, simulation.html, GitHub workflow, install_rpi.sh, and README.md to disk
  app.post('/api/sync-files', async (req, res) => {
    try {
      const config: StreamConfig = { ...DEFAULT_CONFIG, ...(req.body?.config || {}) };
      const pythonCode = generatePythonScript(config);
      const installSh = generateInstallScript(config);
      const readmeMd = generateReadmeMarkdown(config);
      const simHtml = generateSimulationHtml(config);
      const workflowYaml = generateGithubActionYaml(config);

      const workflowDir = path.join(__dirname, '.github', 'workflows');
      await fs.mkdir(workflowDir, { recursive: true });

      await Promise.all([
        fs.writeFile(path.join(__dirname, 'rpi_camera_spi_stream.py'), pythonCode, 'utf-8'),
        fs.writeFile(path.join(__dirname, 'install_rpi.sh'), installSh, 'utf-8'),
        fs.writeFile(path.join(__dirname, 'README.md'), readmeMd, 'utf-8'),
        fs.writeFile(path.join(__dirname, 'simulation.html'), simHtml, 'utf-8'),
        fs.writeFile(path.join(workflowDir, 'rpi-gesture-ci.yml'), workflowYaml, 'utf-8'),
      ]);

      res.json({
        ok: true,
        updatedAt: new Date().toISOString(),
        files: [
          { name: 'rpi_camera_spi_stream.py', bytes: Buffer.byteLength(pythonCode, 'utf-8') },
          { name: 'simulation.html', bytes: Buffer.byteLength(simHtml, 'utf-8') },
          { name: '.github/workflows/rpi-gesture-ci.yml', bytes: Buffer.byteLength(workflowYaml, 'utf-8') },
          { name: 'install_rpi.sh', bytes: Buffer.byteLength(installSh, 'utf-8') },
          { name: 'README.md', bytes: Buffer.byteLength(readmeMd, 'utf-8') },
        ],
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to write project files',
      });
    }
  });

  // Serve raw files for direct curl/wget download onto Raspberry Pi
  app.get('/api/raw/:filename', async (req, res) => {
    const allowed: Record<string, string> = {
      'rpi_camera_spi_stream.py': path.join(__dirname, 'rpi_camera_spi_stream.py'),
      'install_rpi.sh': path.join(__dirname, 'install_rpi.sh'),
      'README.md': path.join(__dirname, 'README.md'),
      'simulation.html': path.join(__dirname, 'simulation.html'),
      'rpi-gesture-ci.yml': path.join(__dirname, '.github', 'workflows', 'rpi-gesture-ci.yml'),
    };
    const targetPath = allowed[req.params.filename];
    if (!targetPath) {
      res.status(404).send('File not found');
      return;
    }
    try {
      const content = await fs.readFile(targetPath, 'utf-8');
      res.setHeader(
        'Content-Type',
        req.params.filename.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8'
      );
      res.send(content);
    } catch {
      res.status(404).send('File not found');
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
