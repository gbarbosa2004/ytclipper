import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, link, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundledDownloader = path.join(root, '.tools', 'yt-dlp');
export const downloadsDirectory = path.resolve(process.env.YTCLIPPER_DOWNLOADS || path.join(homedir(), 'Downloads'));
const format = 'bv*[height<=1080][width<=1920]+ba/b[height<=1080][width<=1920]';
const nodeRuntime = `node:${process.execPath}`;

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string' || !/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(value.trim())) {
    throw new AppError('Use seconds, mm:ss, or hh:mm:ss for the timestamps.');
  }
  const parts = value.trim().split(':').map(Number);
  if (parts.slice(1).some(n => n >= 60)) throw new AppError('Minutes and seconds after a colon must be below 60.');
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  if (!Number.isFinite(seconds)) throw new AppError('Enter a valid timestamp.');
  return seconds;
}

export function validateRange(start, end, duration) {
  start = parseTime(start);
  end = parseTime(end);
  if (end <= start) throw new AppError('The end time must be after the start time.');
  if (!Number.isFinite(duration) || duration <= 0) throw new AppError('This video has no fixed duration. Choose a finished video.');
  if (start >= duration || end > duration + 0.05) throw new AppError('Keep both timestamps within the video.');
  return { start, end: Math.min(end, duration) };
}

export function createExportItems(data, duration) {
  if (data.mode && !['clips', 'full'].includes(data.mode)) throw new AppError('Choose clips or the entire video.');
  if (data.mode === 'full') return [{ id: randomUUID(), ...validateRange(0, duration, duration), full: true, stage: 'queued', progress: 0 }];
  const ranges = data.clips === undefined ? [{ start: data.start, end: data.end }] : data.clips;
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > 50) throw new AppError('Add between 1 and 50 clips to your batch.');
  return ranges.map((range, index) => {
    try {
      if (!range || typeof range !== 'object') throw new AppError('Enter a start and end time.');
      return { id: randomUUID(), ...validateRange(range.start, range.end, duration), full: false, stage: 'queued', progress: 0 };
    } catch (error) { throw new AppError(`Clip ${index + 1}: ${error.message}`); }
  });
}

export function normalizeYouTubeURL(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new AppError('Paste a valid YouTube video link.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new AppError('Paste a regular YouTube video link.');
  }
  const host = url.hostname.toLowerCase();
  let id;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1];
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new AppError('Paste a link to one YouTube video, rather than a channel or playlist.');
  return `https://www.youtube.com/watch?v=${id}`;
}

export function run(command, args, { signal, timeout = 120_000, onStdout, onStderr, maxOutput = 12_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AppError('Export cancelled.', 499));
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true });
    let stdout = '', stderr = '', timedOut = false, tooLarge = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    timer.unref();
    let killTimer;
    const forceStop = () => { killTimer = setTimeout(() => child.kill('SIGKILL'), 3000); killTimer.unref(); };
    signal?.addEventListener('abort', forceStop, { once: true });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > maxOutput) { tooLarge = true; child.kill('SIGTERM'); }
      onStdout?.(chunk.toString());
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); onStderr?.(chunk.toString()); });
    child.on('error', error => {
      // Wait for close on abort so callers never remove a file still being written.
      if (error.name === 'AbortError') return;
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', forceStop);
      reject(error.code === 'ENOENT' ? new AppError(command === 'zip' ? 'ZIP support is missing. Install the zip utility, then restart the app.' : `${command} is missing. Install yt-dlp and FFmpeg, then restart the app.`, 503) : error);
    });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', forceStop);
      if (signal?.aborted) return reject(new AppError('Export cancelled.', 499));
      if (timedOut) return reject(new AppError('The video service took too long to respond. Please try again.', 504));
      if (tooLarge) return reject(new AppError('This video returned too much data. Try another video.', 502));
      if (code !== 0) { const error = new Error(stderr || `${command} exited with code ${code}.`); error.details = stderr; return reject(error); }
      resolve({ stdout, stderr });
    });
  });
}

async function downloader() {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  try { await access(bundledDownloader, constants.X_OK); return bundledDownloader; } catch { return 'yt-dlp'; }
}

export async function checkTools() {
  const tools = [[await downloader(), '--version'], ['ffmpeg', '-version'], ['ffprobe', '-version'], ['zip', '-v']];
  const results = await Promise.allSettled(tools.map(([tool, flag]) => run(tool, [flag], { timeout: 10_000 })));
  return results.every(result => result.status === 'fulfilled');
}

export function friendlyError(error) {
  if (error instanceof AppError) return error.message;
  const message = String(error.details || error.message || '');
  if (/sign in|bot|cookies|confirm your age|age.restricted/i.test(message)) return 'YouTube requires sign-in for this video. Try a public video without an age restriction.';
  if (/private video|video unavailable|not available|removed|members.only/i.test(message)) return 'This video is private, unavailable, or restricted. Try another public video.';
  if (/403|forbidden|signature|nsig|challenge/i.test(message)) return 'YouTube refused the download. Update yt-dlp (see README), then try again.';
  if (/ENOSPC|No space left/i.test(message)) return 'There is not enough disk space to save this clip.';
  if (/EACCES|EPERM|Permission denied|Operation not permitted/i.test(message)) return 'The app needs permission to save to your Downloads folder. Allow Downloads access in macOS Settings and try again.';
  if (/requested format.*not available/i.test(message)) return 'No downloadable video format was found. Try another video.';
  if (/timed out|network|resolve|connection|HTTP error|Error opening input/i.test(message)) return 'The video download was interrupted. Check your connection and try again.';
  return 'The video could not be processed. Please try again or choose another video.';
}

export async function inspectVideo(value, { signal } = {}) {
  const url = normalizeYouTubeURL(value);
  const { stdout } = await run(await downloader(), [
    '--ignore-config', '--no-playlist', '--no-warnings', '--no-progress', '--skip-download',
    '--dump-single-json', '--js-runtimes', nodeRuntime, '--socket-timeout', '20', '--retries', '2', '-f', format, '--', url,
  ], { signal, timeout: 100_000 });
  const info = JSON.parse(stdout);
  if (info.is_live || info.live_status === 'is_upcoming' || info.live_status === 'post_live' || !info.duration) {
    throw new AppError('Choose a finished video. Live streams and upcoming videos cannot be clipped yet.');
  }
  const formats = info.requested_formats || [info];
  const video = formats.find(f => f.vcodec && f.vcodec !== 'none');
  if (!video) throw new AppError('No downloadable video was found.', 422);
  return { url, info, formats, public: {
    id: info.id, url, title: info.title, channel: info.channel || info.uploader || 'YouTube',
    duration: info.duration, width: video.width || info.width, height: video.height || info.height,
    thumbnail: `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
  } };
}

function inputArgs(format, start) {
  if (!/^https?:\/\//.test(format.url || '')) throw new AppError('This video format cannot be downloaded.', 422);
  const headers = Object.entries(format.http_headers || {}).filter(([key, value]) => /^[\w-]+$/.test(key) && !/[\r\n]/.test(String(value)))
    .map(([key, value]) => `${key}: ${value}\r\n`).join('');
  return ['-rw_timeout', '30000000', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    ...(headers ? ['-headers', headers] : []), '-ss', String(start), '-i', format.url];
}

export function encodingArgs(input, start, end, output, { remote = true, full = false } = {}) {
  const formats = Array.isArray(input) ? input : [{ url: input, vcodec: 'local', acodec: 'local' }];
  const videoIndex = formats.findIndex(f => f.vcodec && f.vcodec !== 'none');
  const audioIndex = formats.findIndex(f => f.acodec && f.acodec !== 'none');
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y'];
  for (const f of formats) args.push(...(remote ? inputArgs(f, start) : ['-ss', String(start), '-i', f.url]));
  args.push('-map', `${videoIndex}:v:0`);
  if (audioIndex >= 0) args.push('-map', `${audioIndex}:a:0?`);
  if (!full) args.push('-t', String(end - start));
  args.push('-map_metadata', '-1',
    '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-threads', '4', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output);
  return args;
}

export function fileStamp(seconds) {
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}h${Math.floor(seconds % 3600 / 60).toString().padStart(2, '0')}m${(seconds % 60).toFixed(3).replace(/\.?0+$/, '').padStart(2, '0')}s`;
}

export function safeTitle(title) {
  return String(title).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').replace(/^\.+|[. ]+$/g, '').slice(0, 95).trim() || 'YouTube clip';
}

export async function verifyClip(file, expectedDuration, { signal, full = false } = {}) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { signal });
  const probe = JSON.parse(stdout);
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  const duration = Number(probe.format?.duration);
  if (!video || video.codec_name !== 'h264' || !Number.isFinite(duration) || duration <= 0 || Math.abs(duration - expectedDuration) > (full ? 2 : 0.5)) {
    throw new AppError('The downloaded clip was incomplete. Please try exporting it again.', 502);
  }
  const size = (await stat(file)).size;
  return { width: video.width, height: video.height, duration, size };
}

export async function saveOutput(tempFile, filename, { directory = downloadsDirectory, id = randomUUID() } = {}) {
  await mkdir(directory, { recursive: true });
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  // Copy to a hidden sibling first; the final MP4 or ZIP appears atomically.
  const staging = path.join(directory, `.ytclipper-${id}.partial`);
  try {
    await copyFile(tempFile, staging, constants.COPYFILE_EXCL);
    for (let n = 0; n < 1000; n++) {
      const destination = path.join(directory, `${stem}${n ? ` (${n})` : ''}${extension}`);
      try {
        // A hard link makes the completed file visible atomically and never overwrites.
        await link(staging, destination);
        return destination;
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw new AppError('Too many exports share this name. Rename an earlier export and try again.');
  } finally { await rm(staging, { force: true }); }
}

export async function exportClip(job, update, { source: preparedSource, outputDirectory = downloadsDirectory, prefix = '', staged = false } = {}) {
  const signal = job.controller.signal;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'ytclipper-'));
  try {
    update({ stage: 'preparing', progress: 0, message: 'Getting your video…' });
    const source = preparedSource || await inspectVideo(job.url, { signal });
    const { start, end } = job.full ? validateRange(0, source.public.duration, source.public.duration) : validateRange(job.start, job.end, source.public.duration);
    const tempFile = path.join(tempDir, 'clip.mp4');
    update({ stage: 'encoding', progress: 0, message: job.full ? 'Downloading the entire video…' : 'Downloading and trimming your clip…' });
    let pending = '';
    await run('ffmpeg', encodingArgs(source.formats, start, end, tempFile, { full: job.full }), {
      signal, timeout: Math.max(15 * 60_000, (end - start) * 12_000),
      onStdout(chunk) {
        pending += chunk;
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) {
          if (line.startsWith('out_time_us=')) {
            const seconds = Number(line.slice(12)) / 1_000_000;
            update({ progress: Math.min(97, Math.max(0, Math.round(seconds / (end - start) * 97))) });
          }
        }
      },
    });
    update({ stage: 'saving', progress: 98, message: staged ? 'Preparing your clip for the ZIP…' : 'Saving to your Downloads…' });
    const details = await verifyClip(tempFile, end - start, { signal, full: job.full });
    if (signal.aborted) throw new AppError('Export cancelled.', 499);
    // The short final copy is a commit: cancellation is disabled while saving.
    const filename = `${prefix}${safeTitle(source.public.title)} [${job.full ? 'full video' : `${fileStamp(start)}-${fileStamp(end)}`}].mp4`;
    const file = await saveOutput(tempFile, filename, { directory: outputDirectory, id: job.id });
    update({ stage: 'done', progress: 100, message: staged ? 'Ready for ZIP.' : 'Saved to your Downloads.', file, filename: path.basename(file), ...details });
  } finally { await rm(tempDir, { recursive: true, force: true }); }
}

export async function packageBatch(job, items, { outputDirectory = downloadsDirectory } = {}) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'ytclipper-zip-'));
  try {
    const archive = path.join(tempDir, 'clips.zip');
    // MP4 is already compressed. Store files directly, preserving their numbered names.
    await run('zip', ['-q', '-0', '-j', archive, ...items.map(item => item.file)], { timeout: 30 * 60_000 });
    const count = items.length === job.items.length ? `${items.length} clips` : `${items.length} of ${job.items.length} clips`;
    const filename = `${safeTitle(job.title)} [${count}].zip`;
    const file = await saveOutput(archive, filename, { directory: outputDirectory, id: job.id });
    return { type: 'zip', file, filename: path.basename(file), size: (await stat(file)).size, count: items.length };
  } finally { await rm(tempDir, { recursive: true, force: true }); }
}

export async function exportBatch(job, update, { inspect = inspectVideo, exportOne = exportClip, packageClips = packageBatch, outputDirectory = downloadsDirectory } = {}) {
  const signal = job.controller.signal;
  const total = job.items.length;
  const batched = total > 1;
  const progress = () => Math.floor(job.items.reduce((sum, item) => sum + (item.progress || 0), 0) / total * (batched ? .95 : 1));
  let batchDirectory;
  let finalState;
  try {
    try {
      if (batched) batchDirectory = await mkdtemp(path.join(tmpdir(), 'ytclipper-batch-'));
      update({ stage: 'preparing', progress: 0, message: 'Getting your video…' });
      const source = await inspect(job.url, { signal });
      for (const [index, item] of job.items.entries()) {
        if (signal.aborted) break;
        update({ current: index + 1 });
        try {
          await exportOne({ ...item, url: job.url, controller: job.controller }, changes => {
            Object.assign(item, changes);
            update({ stage: changes.stage === 'done' ? 'encoding' : (changes.stage || job.stage), progress: progress(),
              message: `${batched ? `Clip ${index + 1} of ${total}: ` : ''}${item.message}` });
          }, { source, outputDirectory: batchDirectory || outputDirectory, staged: batched, prefix: batched ? `${String(index + 1).padStart(2, '0')} - ` : '' });
        } catch (error) {
          Object.assign(item, { stage: signal.aborted ? 'cancelled' : 'error', message: friendlyError(error) });
          if (signal.aborted) break;
        }
      }
    } catch (error) {
      for (const item of job.items) if (item.stage === 'queued') Object.assign(item, { stage: signal.aborted ? 'cancelled' : 'error', message: friendlyError(error) });
    }
    for (const item of job.items) if (item.stage === 'queued') Object.assign(item, { stage: 'cancelled', message: 'Cancelled before export.' });
    const ready = job.items.filter(item => item.stage === 'done');
    let archiveError;
    if (batched && ready.length) {
      update({ stage: 'packaging', progress: 97, message: 'Creating your ZIP and saving to Downloads…' });
      try {
        // Finish packaging completed clips even after cancellation. This final
        // local commit is not cancellable, like the final file copy.
        update({ artifact: await packageClips(job, ready, { outputDirectory }) });
      } catch (error) {
        archiveError = friendlyError(error);
        for (const item of ready) Object.assign(item, { stage: 'error', message: `Could not save ZIP: ${archiveError}` });
      }
    }
    const saved = job.items.filter(item => item.stage === 'done').length;
    const failed = job.items.filter(item => item.stage === 'error').length;
    const cancelled = job.items.some(item => item.stage === 'cancelled');
    const stage = archiveError ? 'error' : cancelled ? 'cancelled' : failed ? (saved ? 'partial' : 'error') : 'done';
    let message;
    if (archiveError) message = `The ZIP could not be saved. ${archiveError}`;
    else if (stage === 'cancelled') message = `Export cancelled.${saved ? ` ZIP with ${saved} of ${total} clips saved to Downloads.` : ''}`;
    else if (stage === 'partial') message = `ZIP saved to Downloads with ${saved} of ${total} clips. ${failed} could not be exported.`;
    else if (stage === 'error') message = job.items.find(item => item.stage === 'error')?.message || 'The export failed.';
    else message = job.mode === 'full' ? 'Entire video saved to your Downloads.' : total === 1 ? 'Saved to your Downloads.' : `ZIP with all ${total} clips saved to Downloads.`;
    finalState = { stage, progress: stage === 'done' ? 100 : progress(), saved, failed, message };
  } finally {
    if (batchDirectory) await rm(batchDirectory, { recursive: true, force: true });
    if (batched) for (const item of job.items) delete item.file;
  }
  update(finalState);
}
