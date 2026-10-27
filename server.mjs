import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, checkTools, createExportItems, exportBatch, friendlyError, inspectVideo, normalizeYouTubeURL, run } from './lib/clipper.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4317);
const sources = new Map();
const jobs = new Map();
let activeJob = null;
let inspecting = false;
const toolsReady = await checkTools();
const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Expected a JSON request.', 415);
  let value = '';
  for await (const chunk of req) { value += chunk; if (value.length > 4096) throw new AppError('Request is too large.', 413); }
  try { return JSON.parse(value); } catch { throw new AppError('Invalid request.', 400); }
}

function publicJob(job) {
  const { controller, ...data } = job;
  if (job.items.length > 1) data.items = job.items.map(({ file, ...item }) => item);
  return data;
}

function prune() {
  while (sources.size > 30) sources.delete(sources.keys().next().value);
  const terminal = [...jobs.values()].filter(job => ['done', 'partial', 'error', 'cancelled'].includes(job.stage));
  while (terminal.length > 20) jobs.delete(terminal.shift().id);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://i.ytimg.com data:; frame-src https://www.youtube-nocookie.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return json(res, 403, { error: 'Local access only.' });
  if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return json(res, 403, { error: 'Local access only.' });
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { ready: toolsReady, destination: '~/Downloads', activeJob });
    if (req.method === 'POST' && url.pathname === '/api/video') {
      if (!toolsReady) throw new AppError('Install yt-dlp, FFmpeg, and zip, then restart the app. See README for setup.', 503);
      if (inspecting) throw new AppError('Another video is loading. Please wait a moment.', 409);
      const data = await body(req);
      const videoURL = normalizeYouTubeURL(data.url);
      inspecting = true;
      const controller = new AbortController();
      const onClose = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', onClose);
      try {
        const video = await inspectVideo(videoURL, { signal: controller.signal });
        const key = randomUUID();
        sources.set(key, { ...video.public, key }); prune();
        return json(res, 200, { ...video.public, key });
      } finally { inspecting = false; res.off('close', onClose); }
    }
    if (req.method === 'POST' && url.pathname === '/api/exports') {
      const data = await body(req);
      const source = sources.get(data.key);
      if (!source) throw new AppError('Load your video again before exporting.');
      const items = createExportItems(data, source.duration);
      if (activeJob) throw new AppError('An export is already running. Wait for it to finish or cancel it.', 409);
      const job = { id: randomUUID(), url: source.url, title: source.title, mode: data.mode || 'clips', items, current: 0,
        stage: 'preparing', progress: 0, message: 'Getting your video…', controller: new AbortController() };
      jobs.set(job.id, job); activeJob = job.id; prune();
      exportBatch(job, update => Object.assign(job, update)).catch(error => {
        Object.assign(job, { stage: job.controller.signal.aborted ? 'cancelled' : 'error', message: friendlyError(error) });
        if (!job.controller.signal.aborted) console.error('[Export]', String(error.message).slice(-1500).replace(/https?:\/\/\S+/g, '[video URL]'));
      }).finally(() => { if (activeJob === job.id) activeJob = null; });
      return json(res, 202, publicJob(job));
    }
    const match = url.pathname.match(/^\/api\/exports\/([\w-]+)(?:\/(cancel|reveal))?$/);
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) throw new AppError('This export is no longer available. Look for saved files in your Downloads.', 404);
      if (req.method === 'GET' && !match[2]) return json(res, 200, publicJob(job));
      if (req.method === 'POST') {
        const revealData = await body(req);
        if (match[2] === 'cancel') {
          if (['saving', 'packaging'].includes(job.stage)) throw new AppError('The export is being packaged or saved. It will be ready in a moment.', 409);
          if (!['done', 'partial', 'error', 'cancelled'].includes(job.stage)) job.controller.abort();
          return json(res, 200, { ok: true });
        }
        if (match[2] === 'reveal') {
          const saved = job.items.filter(item => item.stage === 'done');
          const item = job.items.length > 1 ? job.artifact : (revealData.item ? saved.find(item => item.id === revealData.item) : saved[0]);
          if (!item) throw new AppError('This file has not been saved yet.', 404);
          try { await stat(item.file); } catch { throw new AppError('This export has been moved or deleted from your Downloads.', 404); }
          if (process.platform === 'darwin') await run('open', ['-R', item.file], { timeout: 10_000 });
          else if (process.platform === 'win32') await run('explorer', [`/select,${item.file}`], { timeout: 10_000 });
          else await run('xdg-open', [path.dirname(item.file)], { timeout: 10_000 });
          return json(res, 200, { ok: true });
        }
      }
    }
    if (req.method === 'GET') {
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      const asset = files[url.pathname];
      if (asset) {
        const content = await readFile(path.join(root, 'public', asset[0]));
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(content); return;
      }
    }
    json(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (res.destroyed) return;
    if (!(error instanceof AppError)) console.error('[Request]', String(error.message).slice(-1500).replace(/https?:\/\/\S+/g, '[video URL]'));
    json(res, error.status || 500, { error: friendlyError(error) });
  }
});

server.requestTimeout = 120_000;
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Open http://127.0.0.1:${port} or set PORT to another port.` : error.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`\n  YouTube Clipper → http://127.0.0.1:${port}\n  MP4s and batch ZIPs save directly to your Downloads.\n`);
  if (!toolsReady) console.warn('  Missing tools. Install yt-dlp, FFmpeg, and zip (see README).');
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  for (const job of jobs.values()) if (job.stage !== 'saving') job.controller.abort();
  server.close();
  setTimeout(() => process.exit(0), 4000).unref();
});
