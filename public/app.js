const $ = id => document.getElementById(id);
let video = null;
let job = null;
let busy = false;
let loading = false;
let pollTimer;
let clips = [];
let exportMode = 'clips';
const terminalStages = ['done', 'partial', 'error', 'cancelled'];

function time(seconds, padded = false) {
  const rounded = Math.round(seconds * 1000) / 1000;
  const h = Math.floor(rounded / 3600);
  const m = Math.floor(rounded % 3600 / 60);
  const s = (rounded % 60).toFixed(3).replace(/\.?0+$/, '');
  const sec = s.split('.')[0].padStart(2, '0') + (s.includes('.') ? `.${s.split('.')[1]}` : '');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${padded ? String(m).padStart(2, '0') : m}:${sec}`;
}

function parse(value) {
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(value.trim())) return NaN;
  const parts = value.trim().split(':').map(Number);
  if (parts.slice(1).some(n => n >= 60)) return NaN;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function showError(id, message) { $(id).textContent = message; $(id).hidden = !message; }

async function api(url, data) {
  let response;
  try { response = await fetch(url, data === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
  catch { throw new Error('Cannot reach the app. Open “Start Clipper.command” and try again.'); }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
  return body;
}

function validRange(show = false) {
  const start = parse($('start-time').value), end = parse($('end-time').value);
  let error = '';
  if (!Number.isFinite(start) || !Number.isFinite(end)) error = 'Use seconds, mm:ss, or hh:mm:ss.';
  else if (end <= start) error = 'End time must be after start time.';
  else if (video && (start >= video.duration || end > video.duration + .05)) error = 'Keep the selection within the video.';
  if (show) showError('time-error', error);
  $('time-help').classList.toggle('invalid', !!error);
  $('clip-duration').textContent = error ? '' : `${Number((end - start).toFixed(2))} s`;
  const unavailable = !video || busy || loading;
  const duplicate = clips.some(clip => clip.start === start && clip.end === end);
  $('export-button').disabled = unavailable || (!clips.length && !!error);
  const zipped = clips.length > 1;
  $('export-button').querySelector('span').textContent = busy ? (exportMode === 'full' ? 'Downloading…' : 'Exporting…') : zipped ? `Export ZIP (${clips.length} clips)` : 'Export MP4';
  $('format-setting').textContent = zipped && !(busy && exportMode === 'full') ? 'ZIP (MP4 clips)' : 'MP4';
  $('whole-video-button').disabled = unavailable;
  $('add-clip-button').disabled = unavailable || !!error || duplicate || clips.length >= 50;
  $('add-clip-label').textContent = duplicate ? 'Already in batch' : clips.length >= 50 ? 'Batch is full (50 clips)' : 'Add to batch';
  $('clear-batch').disabled = busy || loading;
  for (const button of $('batch-list').querySelectorAll('button')) button.disabled = busy || loading;
  return error ? null : { start, end };
}

function renderBatch() {
  $('batch-section').hidden = clips.length === 0;
  $('batch-count').textContent = `Batch (${clips.length})`;
  $('batch-list').replaceChildren();
  clips.forEach((clip, index) => {
    const row = document.createElement('li');
    const number = document.createElement('span'); number.className = 'clip-number'; number.textContent = String(index + 1);
    const range = document.createElement('span'); range.className = 'clip-range'; range.textContent = `${time(clip.start)} – ${time(clip.end)}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-clip'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove clip ${index + 1}`);
    remove.addEventListener('click', () => { clips.splice(index, 1); renderBatch(); });
    row.append(number, range, remove); $('batch-list').append(row);
  });
  if (video) sessionStorage.setItem('clipper-batch', JSON.stringify({ url: video.url, clips }));
  validRange();
}

$('add-clip-button').addEventListener('click', () => {
  if (busy || loading || !video || clips.length >= 50) return;
  const range = validRange(true);
  if (!range || clips.some(clip => clip.start === range.start && clip.end === range.end)) return;
  clips.push(range); renderBatch();
});

$('clear-batch').addEventListener('click', () => { if (!busy && !loading) { clips = []; renderBatch(); } });

function syncTimeline(show = false) {
  const range = validRange(show);
  if (!range || !video) return;
  $('start-range').value = range.start;
  $('end-range').value = range.end;
  $('timeline').style.setProperty('--start', `${range.start / video.duration * 100}%`);
  $('timeline').style.setProperty('--end', `${range.end / video.duration * 100}%`);
  $('selection-label').textContent = `${time(range.start)} – ${time(range.end)}`;
  // A changed selection is previewed the next time Play is pressed.
  $('player-slot').replaceChildren();
  $('play-button').hidden = false;
}

function setBusy(value) {
  busy = value;
  $('clip-controls').disabled = busy || loading || !video;
  $('start-range').disabled = $('end-range').disabled = busy || loading || !video;
  $('load-button').disabled = busy || loading;
  $('video-url').disabled = busy;
  validRange();
}

function setLoading(value) {
  loading = value;
  $('load-button').disabled = value || busy;
  $('load-button').querySelector('span').textContent = value ? 'Loading…' : 'Load video';
  $('load-button').classList.toggle('loading', value);
  $('clip-controls').disabled = value || busy || !video;
  $('start-range').disabled = $('end-range').disabled = value || busy || !video;
  validRange();
}

function displayVideo(data) {
  if (video?.url !== data.url) {
    clips = [];
    try {
      const saved = JSON.parse(sessionStorage.getItem('clipper-batch'));
      if (saved?.url === data.url && Array.isArray(saved.clips)) clips = saved.clips.filter(clip => Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.start >= 0 && clip.end > clip.start && clip.end <= data.duration).slice(0, 50);
    } catch { sessionStorage.removeItem('clipper-batch'); }
  }
  video = data;
  $('empty-preview').hidden = true;
  $('thumbnail').src = data.thumbnail;
  $('thumbnail').hidden = false;
  $('video-info').hidden = false;
  $('timeline-area').hidden = false;
  $('video-title').textContent = data.title;
  $('video-title').title = data.title;
  $('video-meta').textContent = data.channel;
  $('source-duration').textContent = time(data.duration);
  $('source-duration').hidden = false;
  const height = data.height || 1080;
  $('quality-setting').textContent = `${height}p`;
  $('start-time').value = '00:00';
  $('end-time').value = time(Math.min(30, data.duration), true);
  for (const id of ['start-range', 'end-range']) $(id).max = data.duration;
  $('timeline-end').textContent = time(data.duration);
  $('timeline').classList.add('ready');
  $('clip-controls').disabled = false;
  $('start-range').disabled = $('end-range').disabled = false;
  $('export-status').hidden = true;
  showError('time-error', '');
  renderBatch();
  syncTimeline();
}

$('link-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || loading) return;
  showError('load-error', '');
  setLoading(true);
  try {
    const data = await api('/api/video', { url: $('video-url').value.trim() });
    displayVideo(data);
    sessionStorage.setItem('clipper-video', JSON.stringify(data));
    $('video-url').value = data.url;
  } catch (error) { showError('load-error', error.message); }
  finally { setLoading(false); }
});

for (const id of ['start-time', 'end-time']) {
  $(id).addEventListener('input', () => syncTimeline(true));
  $(id).addEventListener('blur', () => {
    const seconds = parse($(id).value);
    if (Number.isFinite(seconds)) $(id).value = time(seconds, true);
  });
}

for (const id of ['start-range', 'end-range']) $(id).addEventListener('input', () => {
  if (!video) return;
  let start = Number($('start-range').value), end = Number($('end-range').value);
  const minLength = Math.min(.1, video.duration);
  if (id === 'start-range') start = Math.max(0, Math.min(start, end - minLength));
  else end = Math.min(video.duration, Math.max(end, start + minLength));
  $('start-time').value = time(start, true);
  $('end-time').value = time(end, true);
  syncTimeline(true);
});

$('play-button').addEventListener('click', () => {
  const range = validRange(true);
  if (!video || !range) return;
  const player = document.createElement('iframe');
  const query = new URLSearchParams({ autoplay: '1', start: String(Math.floor(range.start)), end: String(Math.ceil(range.end)), rel: '0' });
  player.src = `https://www.youtube-nocookie.com/embed/${video.id}?${query}`;
  player.title = `Preview: ${video.title}`;
  player.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  player.allowFullscreen = true;
  player.referrerPolicy = 'strict-origin-when-cross-origin';
  $('player-slot').replaceChildren(player);
  $('play-button').hidden = true;
});

function updateJob(data) {
  job = data;
  exportMode = data.mode || 'clips';
  const terminal = terminalStages.includes(data.stage);
  const items = data.items || [data];
  const batched = items.length > 1;
  const archive = data.artifact;
  const saved = items.filter(item => item.stage === 'done');
  setBusy(!terminal);
  $('export-status').hidden = false;
  $('status-message').textContent = data.message;
  $('progress-percent').textContent = ['encoding', 'saving', 'packaging'].includes(data.stage) ? `${data.progress}%` : '';
  $('progress-track').hidden = terminal;
  $('progress-track').classList.toggle('indeterminate', data.stage === 'preparing' || (data.stage === 'encoding' && data.progress === 0));
  $('progress-track').setAttribute('aria-valuenow', data.progress || 0);
  $('progress-fill').style.width = `${data.progress || 0}%`;
  $('cancel-button').hidden = terminal || ['saving', 'packaging'].includes(data.stage);
  $('cancel-button').disabled = false;
  $('cancel-button').textContent = 'Cancel export';
  $('finder-button').hidden = batched ? !archive : !saved.length;
  $('finder-button').textContent = archive ? 'Show ZIP in Finder' : 'Show in Finder';
  $('file-details').hidden = !archive && (batched || !saved.length);
  if (archive || (!batched && saved.length)) {
    const file = archive || saved[0];
    const size = file.size < 1_000_000 ? `${Math.round(file.size / 1000)} KB` : `${(file.size / 1_000_000).toFixed(1)} MB`;
    $('file-details').textContent = archive ? `${file.filename} · ${file.count} MP4 ${file.count === 1 ? 'clip' : 'clips'} · ${size}` : `${file.filename} · ${file.width} × ${file.height} · ${size}`;
  }
  $('export-results').hidden = items.length <= 1;
  $('export-results').replaceChildren();
  const labels = { queued: 'Queued', preparing: 'Preparing…', encoding: 'Exporting…', saving: 'Preparing ZIP…', done: archive ? 'Included in ZIP' : 'Ready for ZIP', error: 'Failed', cancelled: 'Cancelled' };
  if (items.length > 1) items.forEach((item, index) => {
    const row = document.createElement('li'); row.className = `result-row ${item.stage}`;
    const info = document.createElement('div');
    const range = document.createElement('strong'); range.textContent = `${index + 1}. ${time(item.start)} – ${time(item.end)}`;
    const status = document.createElement('span'); status.textContent = item.stage === 'error' ? item.message : labels[item.stage] || item.stage;
    info.append(range, status); row.append(info);
    $('export-results').append(row);
  });
  sessionStorage.setItem('clipper-job', data.id);
  return terminal;
}

function pollJob(id) {
  clearTimeout(pollTimer);
  let errors = 0;
  const tick = async () => {
    try {
      const data = await api(`/api/exports/${id}`);
      errors = 0;
      if (updateJob(data)) return;
    } catch (error) {
      errors++;
      $('export-status').hidden = false;
      $('status-message').textContent = error.message;
      if (errors >= 5) {
        setBusy(false);
        $('cancel-button').hidden = true;
        $('progress-track').hidden = true;
        return;
      }
    }
    pollTimer = setTimeout(tick, errors ? 2500 : 800);
  };
  tick();
}

async function startExport(mode) {
  if (busy || !video || loading) return;
  const ranges = mode === 'full' ? null : clips.length ? clips.map(clip => ({ ...clip })) : [validRange(true)];
  if (ranges?.some(range => !range)) return;
  showError('time-error', '');
  exportMode = mode;
  $('export-status').hidden = true;
  setBusy(true);
  try {
    const data = await api('/api/exports', { key: video.key, mode, ...(ranges ? { clips: ranges } : {}) });
    updateJob(data);
    pollJob(data.id);
  } catch (error) {
    setBusy(false);
    showError('time-error', error.message);
  }
}

$('export-form').addEventListener('submit', event => { event.preventDefault(); startExport('clips'); });
$('whole-video-button').addEventListener('click', () => startExport('full'));

$('cancel-button').addEventListener('click', async () => {
  if (!job) return;
  $('cancel-button').disabled = true;
  $('cancel-button').textContent = 'Cancelling…';
  try { await api(`/api/exports/${job.id}/cancel`, {}); }
  catch (error) { $('status-message').textContent = error.message; $('cancel-button').disabled = false; }
});

async function revealFile(id, item) {
  try { await api(`/api/exports/${id}/reveal`, item ? { item } : {}); }
  catch (error) { $('status-message').textContent = error.message; }
}

$('finder-button').addEventListener('click', () => { if (job) revealFile(job.id); });

async function init() {
  try {
    const status = await api('/api/status');
    if (!status.ready) { showError('load-error', 'Install yt-dlp, FFmpeg, and zip, then restart the app. Setup instructions are in README.md.'); $('load-button').disabled = true; return; }
    try {
      const saved = JSON.parse(sessionStorage.getItem('clipper-video'));
      if (saved) { displayVideo(saved); $('video-url').value = saved.url; }
    } catch { sessionStorage.removeItem('clipper-video'); }
    const previous = status.activeJob || sessionStorage.getItem('clipper-job');
    if (previous) {
      try {
        const previousJob = await api(`/api/exports/${previous}`);
        const selection = previousJob.items?.[0] || previousJob;
        if (video?.url === previousJob.url && Number.isFinite(selection.start) && Number.isFinite(selection.end)) {
          $('start-time').value = time(selection.start, true);
          $('end-time').value = time(selection.end, true);
          syncTimeline();
        }
        if (!updateJob(previousJob)) pollJob(previous);
      }
      catch { sessionStorage.removeItem('clipper-job'); }
    }
  } catch (error) { showError('load-error', error.message); }
}
init();
