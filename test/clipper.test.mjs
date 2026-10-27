import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodingArgs, fileStamp, normalizeYouTubeURL, parseTime, run, safeTitle, validateRange, verifyClip } from '../lib/clipper.mjs';

test('YouTube URLs normalize to a single video and reject lookalikes and arbitrary URLs', () => {
  const canonical = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  for (const url of [canonical, 'https://youtu.be/aqz-KE-bpKQ?t=30', 'https://m.youtube.com/watch?v=aqz-KE-bpKQ&list=test', 'https://youtube.com/shorts/aqz-KE-bpKQ', 'https://www.youtube.com/embed/aqz-KE-bpKQ']) assert.equal(normalizeYouTubeURL(url), canonical);
  for (const url of ['https://youtube.com.evil.org/watch?v=aqz-KE-bpKQ', 'file:///etc/passwd', 'https://127.0.0.1/watch?v=aqz-KE-bpKQ', 'https://youtube.com/playlist?list=x', 'https://youtube.com/watch?v=--exec', 'https://a:b@youtube.com/watch?v=aqz-KE-bpKQ', 'https://youtube.com:1234/watch?v=aqz-KE-bpKQ']) assert.throws(() => normalizeYouTubeURL(url));
});

test('timestamps support hours and milliseconds and reject invalid ranges', () => {
  assert.equal(parseTime('1:02:03.125'), 3723.125);
  assert.equal(parseTime(' 83.5 '), 83.5);
  assert.equal(parseTime('01:23'), 83);
  for (const value of ['1:60', '1:99:00', '-1', '', '1:2:3:4', 'NaN', Infinity, null]) assert.throws(() => parseTime(value));
  assert.deepEqual(validateRange('1:00', '1:02.5', 100), { start: 60, end: 62.5 });
  for (const [start, end] of [[10, 10], [30, 20], [0, 1000], [-1, 5], [100, 101]]) assert.throws(() => validateRange(start, end, 100));
});

test('output names cannot introduce paths or control characters', () => {
  assert.equal(safeTitle('../../Bad / title: \\ what?\n'), 'Bad title what');
  assert.equal(safeTitle('...'), 'YouTube clip');
  assert.equal(fileStamp(83.5), '00h01m23.5s');
  assert.equal(fileStamp(0), '00h00m00s');
});

test('real encoding: exact selection, separate audio stream, 1080p H.264/AAC, and no upscaling', { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ytclipper-test-'));
  try {
    const source = path.join(dir, 'source.mp4');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-threads', '2', '-c:a', 'aac', '-shortest', source]);
    const output = path.join(dir, 'clip.mp4');
    // YouTube commonly serves video and audio separately; exercise that mapping.
    await run('ffmpeg', encodingArgs([{ url: source, vcodec: 'h264', acodec: 'none' }, { url: source, vcodec: 'none', acodec: 'aac' }], 1.25, 2.75, output, { remote: false }));
    const info = await verifyClip(output, 1.5);
    assert.equal(info.width, 1920); assert.equal(info.height, 1080);
    assert.ok(Math.abs(info.duration - 1.5) < 0.1);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output]);
    const streams = JSON.parse(stdout).streams;
    assert.equal(streams.find(s => s.codec_type === 'audio')?.codec_name, 'aac');
    assert.equal(streams.find(s => s.codec_type === 'video')?.pix_fmt, 'yuv420p');
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', source, '-i', output, '-filter_complex', '[0:v]trim=start=1.25:end=2.75,setpts=PTS-STARTPTS[ref];[1:v]setpts=PTS-STARTPTS[clip];[ref][clip]ssim', '-an', '-f', 'null', '-']);
    const ssim = Number(stderr.match(/All:([0-9.]+)/)?.[1]);
    assert.ok(ssim > .97, `Selected source frames should match output (SSIM ${ssim})`);
    const wholeOutput = path.join(dir, 'entire-video.mp4');
    // Whole-video exports must reach EOF even if YouTube reports a rounded duration.
    await run('ffmpeg', encodingArgs(source, 0, 3.7, wholeOutput, { remote: false, full: true }));
    const whole = await verifyClip(wholeOutput, 3.7, { full: true });
    assert.ok(Math.abs(whole.duration - 4) < .1, 'The entire video should keep its final frames');
    const lowSource = path.join(dir, 'small.mp4');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=640x360:duration=2', '-c:v', 'libx264', '-threads', '2', lowSource]);
    const lowOutput = path.join(dir, 'small-clip.mp4');
    await run('ffmpeg', encodingArgs(lowSource, .25, 1.25, lowOutput, { remote: false }));
    const small = await verifyClip(lowOutput, 1);
    assert.equal(small.width, 640); assert.equal(small.height, 360);
    await assert.rejects(verifyClip(output, 20), /incomplete/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
