import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

const developmentGate = 'tests/project-template-server.test.ts';
const legacyParity = 'tests/timeline-audio-preview-compatibility.test.ts';
const uiModel = 'apps/web/src/speed-ui/speed-model.ts';
const uiPresentation = 'apps/web/src/speed-ui/speed-presentation.ts';
const lifecycle = 'tests/timeline-processing-lifecycle.test.ts';
const cacheSuite = 'tests/timeline-processing-cache.test.ts';
const versionModule = 'packages/business/src/project-file/schema/databases.ts';
const unavailable = (ctx, file, card) => {
  if (!existsSync(path.join(ctx.repo, file))) ctx.blocked(`当前工作树尚无 ${card} 的 ${file}`);
};

async function requireFormat6(ctx) {
  if ((await ctx.load(versionModule)).FORMAT6_PROJECT_SCHEMA_VERSION === undefined) {
    ctx.blocked('当前工作树尚未包含 SP-D 的格式 6 项目版本');
  }
}

function wave() {
  const sampleRate = 48000, dataSize = 2 * sampleRate * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(2 * sampleRate, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(dataSize, 40);
  for (let sample = 0; sample < dataSize / 2; sample++) {
    bytes.writeInt16LE((sample * 31) % 16384 - 8192, 44 + sample * 2);
  }
  return bytes;
}

async function awaitProcessingTask(service, projectId) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const task = service.list({projectId}).items[0];
    if (task) return task;
    await delay(20);
  }
  assert.fail('The committed reverse edit did not enqueue a processing task');
}

// Only reached in a dedicated spawned Node process. Its own media-process
// events supply the PID. It does not enumerate or signal system processes.
export async function runOwnedProcessingWorkerFault(repo, scratch) {
  const load = source => import(pathToFileURL(path.join(repo, source)).href);
  const [
    {createProjectStore, openProjectStore}, {FORMAT6_PROJECT_SCHEMA_VERSION},
    {referenceForPublishedMedia, registerProjectMediaStore}, {createProcessingScheduler},
    {createProcessingCache}, {createTimelineProcessingService},
    {createFormat5SequenceEditService}, {onMediaProcess},
  ] = await Promise.all([
    load('packages/business/src/project-file/store.ts'), load(versionModule),
    load('packages/business/src/project-media-storage.ts'), load('packages/business/src/timeline-processing/scheduler.ts'),
    load('packages/business/src/timeline-processing/cache.ts'), load('packages/business/src/timeline-processing/service.ts'),
    load('packages/business/src/format5-sequence-edit-service.ts'), load('packages/business/src/media-processes.ts'),
  ]);
  const projectId = randomUUID(), timelineId = randomUUID(), rootId = randomUUID();
  const assetId = randomUUID(), clipId = randomUUID(), mainTrackId = randomUUID(), audioTrackId = randomUUID();
  const projectDir = path.join(scratch, 'project');
  const media = path.join(projectDir, 'media'), file = path.join(media, 'synthetic.wav');
  mkdirSync(media, {recursive: true, mode: 0o700});
  writeFileSync(file, wave(), {flag: 'wx', mode: 0o600});

  const applicationCache = path.join(scratch, 'application-cache');
  const cacheRoot = path.join(applicationCache, 'timeline-processing');
  const cacheNames = () => existsSync(cacheRoot) ? readdirSync(cacheRoot) : [];
  const options = {projectFile: path.join(projectDir, 'scratch.mioon'), allowFormat6: true, locate: () => ({
    localDir: path.join(scratch, 'history'), cacheDir: path.join(scratch, 'cache'), tempDir: path.join(scratch, 'temp'),
  })};
  let store = createProjectStore({...options, projectId, targetFormat: FORMAT6_PROJECT_SCHEMA_VERSION});
  let detach = registerProjectMediaStore(store), service;
  const close = async () => {
    await service?.close();
    detach();
    store.close();
  };
  const start = () => {
    service = createTimelineProcessingService(store, {
      enabled: true, scheduler: createProcessingScheduler(), cache: createProcessingCache(applicationCache), beforeEffect() {},
    });
    service.activate();
  };

  let fault, faultEnabled = true;
  const children = new Set();
  const unsubscribe = onMediaProcess(event => {
    if (!event.pid) return;
    if (event.type === 'exited') {children.delete(event.pid); return;}
    children.add(event.pid);
    if (faultEnabled && !fault && event.kind === 'ffmpeg' && cacheNames().some(name => name.startsWith('stage-'))) {
      const task = service?.list({projectId}).items.find(value => value.kind === 'reverse');
      if (task?.status !== 'running' || !(task.progress > 0)) return;
      // The worker has produced staged PCM and begun a later render child.
      fault = {progress: task.progress};
      try {process.kill(event.pid, 'SIGKILL');}
      catch (error) {fault.error = error;}
    }
  });
  try {
    const source = await referenceForPublishedMedia(store, file);
    const time = '2026-01-01T00:00:00.000Z';
    const tracks = [
      {id: mainTrackId, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
      {id: audioTrackId, name: 'A1', kind: 'audio', orderIndex: 1, hidden: false, muted: false},
    ];
    const clip = {id: clipId, trackId: audioTrackId, name: 'Synthetic tone', startFrame: 0, durationFrames: 60,
      sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId, sourceState: 'ready', anchor: null};
    store.tx(() => {
      store.put('projects', {id: projectId, name: 'SP-Q processing fault', createdAt: time, updatedAt: time, revision: 1});
      store.put('nodes', {id: rootId, projectId, type: 'sequence_root', name: 'Sequence', position: {x: 0, y: 0}, createdAt: time});
      store.put('assets', {id: assetId, projectId, name: 'synthetic.wav', mimeType: 'audio/wav', duration: 2,
        hasAudio: true, hasVideo: false, createdAt: time, ...source});
      store.put('timelines', {id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30,
        durationFrames: 60, createdAt: time, updatedAt: time, mainTrack: {trackId: mainTrackId, sequenceNodeId: rootId},
        tracks, clips: [clip]});
      store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
        .run(timelineId, projectId, rootId, 1, JSON.stringify({version: 1, board: [], track: []}));
    });
    start();
    const edit = createFormat5SequenceEditService(store);
    const preview = edit.preview({projectId, requestId: randomUUID(), speedIntent: {side: 'timeline',
      operation: {kind: 'clip-speed', clipId, setting: {speed: {kind: 'constant', rate: {numerator: 1, denominator: 1}},
        direction: 'reverse', pitchShift: false, interpolation: 'off'}}}});
    assert.ok(preview.envelope, JSON.stringify(preview));
    const receipt = edit.commit({projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
    assert.equal(receipt.status, 'applied');

    const {taskId} = await awaitProcessingTask(service, projectId);
    const task = {projectId, taskId, timeoutMs: 30_000};
    const failure = await service.wait(task);
    assert.equal(failure.timedOut, false);
    assert.ok(fault, 'A staged, owned FFmpeg child must be killed');
    if (fault.error) throw fault.error;
    assert.deepEqual(failure.item, {taskId, clipId, kind: 'reverse', status: 'failed', reason: 'PROCESSING_FAILED'});
    assert.deepEqual([...children], []);
    assert.equal(cacheNames().some(name => name.startsWith('stage-') || /^[0-9a-f]{64}$/u.test(name)), false);

    faultEnabled = false;
    await close();
    store = openProjectStore(options);
    detach = registerProjectMediaStore(store);
    start();
    assert.deepEqual(service.inspect(task).item, failure.item, 'reopen retains the original task and failure');
    assert.deepEqual(service.retry({...task, requestId: randomUUID()}), {taskId});
    const retried = await service.wait(task);
    assert.equal(retried.timedOut, false);
    assert.equal(retried.item.status, 'ready');
    assert.equal(retried.item.taskId, taskId);
    const names = cacheNames();
    assert.equal(names.some(name => name.startsWith('stage-')), false);
    const entries = names.filter(name => /^[0-9a-f]{64}$/u.test(name));
    assert.equal(entries.length, 1);
    const cache = path.join(cacheRoot, entries[0]);
    const published = JSON.parse(readFileSync(path.join(cache, 'receipt.json'), 'utf8'));
    assert.equal(published.result.sampleCount, 96000);
    for (const payload of published.result.files) {
      assert.equal(path.basename(payload.fileName), payload.fileName);
      const bytes = readFileSync(path.join(cache, payload.fileName));
      assert.equal(bytes.length, payload.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), payload.sha256);
    }
    assert.deepEqual([...children], []);
    return {fault: 'SIGKILL', progressAtFault: fault.progress, failedReason: failure.item.reason, retainedTaskIdentity: true,
      partialEntries: 0, retryStatus: retried.item.status, verifiedSamples: published.result.sampleCount};
  } finally {
    unsubscribe();
    await close();
  }
}

const workerEntry = `
const [module, repo, scratch] = process.argv.slice(1);
const {runOwnedProcessingWorkerFault} = await import(module);
console.log(JSON.stringify(await runOwnedProcessingWorkerFault(repo, scratch)));
`;

export const scenarios = [
  {
    id: 'format6-create-upgrade',
    async run(ctx) {
      await requireFormat6(ctx);
      await ctx.runTest(developmentGate, {name: '^only the development channel plus explicit environment opt-in admits format 6$'});
      return {checks: ['web gate', 'format 5 default', 'fresh format 6', 'confirm upgrade', 'disabled open refusal'], suite: developmentGate};
    },
  },
  {
    id: 'format6-off-legacy',
    async run(ctx) {
      const env = {MIOON_FORMAT6_DEV: '0'};
      await ctx.runTest(legacyParity, {env});
      const checks = ['legacy audio/filter bytes', 'legacy export segment arguments'];
      const suites = [legacyParity];
      if (existsSync(path.join(ctx.repo, lifecycle))) {
        await ctx.runTest(lifecycle, {name: '^format 6 with the developer flag disabled creates no row or cache root$', env});
        suites.push(lifecycle);
        checks.push('no disabled processing task or cache');
      }
      if (existsSync(path.join(ctx.repo, uiModel))) {
        const [{timelineSpeedEnabled}, {buildTimelineClipSpeedViews, buildSpeedProcessingOverviewItems}] =
          await Promise.all([ctx.load(uiModel), ctx.load(uiPresentation)]);
        const item = {taskId: randomUUID(), clipId: randomUUID(), kind: 'reverse', status: 'running', progress: 30};
        const timeline = {clips: [{id: item.clipId, startFrame: 0, durationFrames: 30}]};
        const t = key => key;
        const overview = {items: [item], clipNameFor: () => 'Synthetic clip', t, onCancel() {}, onRetry() {}};
        for (const disabled of [timeline, {...timeline, capabilities: {speed: false}}]) {
          assert.equal(timelineSpeedEnabled(disabled), false);
          assert.equal(buildTimelineClipSpeedViews(disabled, [item], t), null);
          assert.deepEqual(buildSpeedProcessingOverviewItems({...overview, enabled: false}), []);
        }
        const enabled = {...timeline, capabilities: {speed: true}};
        assert.equal(timelineSpeedEnabled(enabled), true);
        assert.equal(buildTimelineClipSpeedViews(enabled, [item], t).get(item.clipId).processingActive, true);
        assert.equal(buildSpeedProcessingOverviewItems({...overview, enabled: true}).length, 1);
        suites.push(uiModel, uiPresentation);
        checks.push('no disabled speed badges or task view');
      }
      return {checks, suites};
    },
  },
  {
    id: 'processing-worker-killed',
    async run(ctx) {
      unavailable(ctx, lifecycle, 'SP-P');
      const child = await ctx.runNode(['--input-type=module', '--eval', workerEntry, import.meta.url, ctx.repo, ctx.scratch],
        {timeoutMs: 120_000});
      return JSON.parse(child.stdout.trim());
    },
  },
  {
    id: 'processing-disk-and-source-faults',
    async run(ctx) {
      unavailable(ctx, lifecycle, 'SP-P');
      await ctx.runTest(lifecycle, {name: '^(outside media without a grant and full disk are reported as distinct failures|source bytes changed while a task waits for admission and the original ID reopens without retry)$'});
      await ctx.runTest(cacheSuite, {name: '^insufficient disk space fails before eviction or creation of a staging directory$'});
      return {checks: ['SOURCE_UNAVAILABLE', 'DISK_FULL', 'no eviction or staging on insufficient space', 'original task on reopen'],
        suites: [lifecycle, cacheSuite]};
    },
  },
];
