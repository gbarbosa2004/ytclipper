import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExportItems, exportBatch } from '../lib/clipper.mjs';

function job(data) {
  return { id: 'test-job', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', mode: data.mode || 'clips', items: createExportItems(data, 100), controller: new AbortController(), stage: 'preparing', progress: 0 };
}

test('batch validation checks every clip before work; entire-video mode ignores trim inputs', () => {
  const items = createExportItems({ clips: [{ start: '0:10', end: '0:13' }, { start: 20, end: 30 }] }, 100);
  assert.deepEqual(items.map(({ start, end }) => ({ start, end })), [{ start: 10, end: 13 }, { start: 20, end: 30 }]);
  assert.notEqual(items[0].id, items[1].id);
  assert.throws(() => createExportItems({ clips: [{ start: 0, end: 1 }, { start: 99, end: 101 }] }, 100), /Clip 2/);
  for (const clips of [[], 'bad', Array(51).fill({ start: 0, end: 1 })]) assert.throws(() => createExportItems({ clips }, 100), /between 1 and 50/);
  const full = createExportItems({ mode: 'full', start: 'invalid', end: -1, clips: [] }, 100);
  assert.deepEqual(full.map(({ start, end, full }) => ({ start, end, full })), [{ start: 0, end: 100, full: true }]);
});

test('batch exports in order, reuses source lookup, and preserves successes when one clip fails', async () => {
  const batch = job({ clips: [{ start: 0, end: 1 }, { start: 5, end: 6 }, { start: 10, end: 11 }] });
  const calls = [];
  let inspections = 0;
  const source = { public: { duration: 100 } };
  await exportBatch(batch, changes => Object.assign(batch, changes), {
    packageClips: async (job, ready) => {
      assert.deepEqual(ready.map(item => item.filename), ['0.mp4', '10.mp4']);
      return { type: 'zip', filename: 'partial.zip', count: ready.length };
    },
    inspect: async () => { inspections++; return source; },
    exportOne: async (item, update, options) => {
      assert.equal(options.source, source);
      calls.push(item.start);
      update({ stage: 'encoding', progress: 50, message: 'Working' });
      if (item.start === 5) throw new Error('Network error');
      update({ stage: 'done', progress: 100, filename: `${item.start}.mp4`, message: 'Saved' });
    },
  });
  assert.equal(inspections, 1);
  assert.deepEqual(calls, [0, 5, 10]);
  assert.deepEqual(batch.items.map(item => item.stage), ['done', 'error', 'done']);
  assert.equal(batch.items[0].filename, '0.mp4');
  assert.equal(batch.items[2].filename, '10.mp4');
  assert.equal(batch.stage, 'partial'); assert.equal(batch.saved, 2); assert.equal(batch.failed, 1);
  assert.equal(batch.artifact.count, 2);
});

test('cancelling a batch keeps saved clips and never starts the remaining clips', async () => {
  const batch = job({ clips: [{ start: 0, end: 1 }, { start: 5, end: 6 }, { start: 10, end: 11 }] });
  let started = 0;
  await exportBatch(batch, changes => Object.assign(batch, changes), {
    packageClips: async (job, ready) => ({ type: 'zip', filename: 'cancelled.zip', count: ready.length }),
    inspect: async () => ({}),
    exportOne: async (item, update) => {
      started++;
      update({ stage: 'done', progress: 100, filename: 'saved.mp4', message: 'Saved' });
      batch.controller.abort();
    },
  });
  assert.equal(started, 1);
  assert.equal(batch.stage, 'cancelled'); assert.equal(batch.saved, 1);
  assert.deepEqual(batch.items.map(item => item.stage), ['done', 'cancelled', 'cancelled']);
  assert.equal(batch.items[0].filename, 'saved.mp4');
  assert.equal(batch.artifact.count, 1);
});

test('failed source lookup fails the batch without starting any clip', async () => {
  const batch = job({ mode: 'full' });
  await exportBatch(batch, changes => Object.assign(batch, changes), {
    inspect: async () => { throw new Error('Video unavailable'); },
    exportOne: async () => assert.fail('No export should start'),
  });
  assert.equal(batch.stage, 'error'); assert.equal(batch.saved, 0); assert.equal(batch.failed, 1);
  assert.equal(batch.items[0].stage, 'error');
});

test('a ZIP packaging failure cannot be reported as a successful save', async () => {
  const batch = job({ clips: [{ start: 0, end: 1 }, { start: 2, end: 3 }] });
  await exportBatch(batch, changes => Object.assign(batch, changes), {
    inspect: async () => ({}),
    exportOne: async (item, update) => update({ stage: 'done', progress: 100, filename: `${item.start}.mp4` }),
    packageClips: async () => { throw new Error('No space left on device'); },
  });
  assert.equal(batch.stage, 'error'); assert.equal(batch.saved, 0); assert.equal(batch.failed, 2);
  assert.equal(batch.artifact, undefined);
  assert.match(batch.message, /ZIP could not be saved/);
});
