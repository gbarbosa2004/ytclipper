import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, verifyClip } from '../lib/clipper.mjs';

test('real HTTP exports: batch ZIP contains playable MP4s; single/full MP4s use Downloads; repeated ZIPs never overwrite', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ytclipper-downloads-test-'));
  const downloads = path.join(dir, 'Downloads');
  let server, exited, media;
  try {
    await mkdir(downloads);
    const source = path.join(dir, 'source.mp4');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-c:a', 'aac', '-movflags', '+faststart', '-shortest', source]);
    const bytes = (await stat(source)).size;
    media = http.createServer((req, res) => {
      let start = 0, end = bytes - 1;
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${bytes}` }); res.end(); return; }
      res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes}` } : {}) });
      createReadStream(source, { start, end }).pipe(res);
    });
    await new Promise(resolve => media.listen(0, '127.0.0.1', resolve));
    const metadata = { id: 'aqz-KE-bpKQ', title: 'ZIP integration sample', duration: 3, channel: 'Local fixture', width: 640, height: 360, vcodec: 'h264', acodec: 'aac', url: `http://127.0.0.1:${media.address().port}/video.mp4` };
    const downloader = path.join(dir, 'yt-dlp');
    await writeFile(downloader, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('test\\n'); else process.stdout.write(${JSON.stringify(JSON.stringify(metadata))});\n`, { mode: 0o700 });
    const port = 32000 + Math.floor(Math.random() * 10000);
    const origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['server.mjs'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, PORT: String(port), YTDLP_PATH: downloader, YTCLIPPER_DOWNLOADS: downloads }, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = once(server, 'exit');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Test app did not start')), 10_000);
      server.stdout.on('data', data => { if (data.toString().includes(origin)) { clearTimeout(timer); resolve(); } });
      server.once('exit', () => { clearTimeout(timer); reject(new Error('Test app exited before startup')); });
    });
    const post = async (route, data) => {
      const response = await fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const result = await response.json();
      assert.ok(response.ok, result.error);
      return result;
    };
    const wait = async id => {
      for (let attempt = 0; attempt < 400; attempt++) {
        const result = await fetch(`${origin}/api/exports/${id}`).then(r => r.json());
        if (['done', 'error', 'cancelled', 'partial'].includes(result.stage)) {
          assert.equal(result.stage, 'done', result.message);
          return result;
        }
        await new Promise(resolve => setTimeout(resolve, 75));
      }
      assert.fail('Export did not finish');
    };
    const video = await post('/api/video', { url: 'https://youtu.be/aqz-KE-bpKQ' });
    const request = { key: video.key, clips: [{ start: 0, end: 1 }, { start: 1, end: 2.5 }] };
    const batch = await wait((await post('/api/exports', request)).id);
    assert.equal(batch.artifact.type, 'zip'); assert.equal(batch.artifact.count, 2);
    assert.equal(path.dirname(batch.artifact.file), downloads);
    assert.deepEqual(await readdir(downloads), [batch.artifact.filename], 'Only the ZIP should be published, without loose MP4s or partials');
    assert.ok(batch.items.every(item => item.file === undefined), 'Temporary clip paths must not be exposed');
    await run('unzip', ['-t', batch.artifact.file]);
    const extract = path.join(dir, 'unzipped');
    await run('unzip', ['-q', batch.artifact.file, '-d', extract]);
    const entries = (await readdir(extract)).sort();
    assert.equal(entries.length, 2);
    assert.ok(entries[0].startsWith('01 - ') && entries[1].startsWith('02 - '));
    for (const [index, duration] of [1, 1.5].entries()) {
      const file = path.join(extract, entries[index]);
      const details = await verifyClip(file, duration);
      assert.equal(details.width, 640); assert.equal(details.height, 360);
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]);
      assert.equal(JSON.parse(stdout).streams.find(s => s.codec_type === 'audio').codec_name, 'aac');
    }
    const firstZIP = await readFile(batch.artifact.file);
    const repeated = await wait((await post('/api/exports', request)).id);
    assert.notEqual(repeated.artifact.filename, batch.artifact.filename);
    assert.ok(repeated.artifact.filename.endsWith(' (1).zip'));
    assert.deepEqual(await readFile(batch.artifact.file), firstZIP, 'The original ZIP must be untouched');
    const single = await wait((await post('/api/exports', { key: video.key, start: .25, end: 1.25 })).id);
    assert.equal(single.artifact, undefined);
    assert.equal(path.dirname(single.items[0].file), downloads);
    await verifyClip(single.items[0].file, 1);
    const full = await wait((await post('/api/exports', { key: video.key, mode: 'full', start: 'invalid' })).id);
    assert.ok(full.items[0].filename.endsWith('[full video].mp4'));
    assert.equal(path.dirname(full.items[0].file), downloads);
    await verifyClip(full.items[0].file, 3, { full: true });
    assert.equal((await readdir(downloads)).length, 4, 'Two ZIPs and two MP4s, with no staging files');
  } finally {
    if (server) { server.kill('SIGTERM'); await exited; }
    if (media) { media.closeAllConnections(); await new Promise(resolve => media.close(resolve)); }
    await rm(dir, { recursive: true, force: true });
  }
});
