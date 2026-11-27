import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {closeSync, openSync} from 'node:fs';
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const fps = 30;
const clock = {fpsNumerator: fps, fpsDenominator: 1};
const sourceFrames = 24;
const marker = ordinal => 24 + ordinal * 8;
const rate = (numerator, denominator = 1) => ({kind: 'constant', rate: {numerator, denominator}});
const edge = frame => ({kind: 'rational', numerator: String(frame), denominator: '1'});
const toolArgs = ['-nostdin', '-hide_banner', '-v', 'error'];
const testRoot = 'tests';

function unwrap(result) {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

async function requireFeature(ctx, file, card) {
  try { await access(path.join(ctx.repo, file)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    ctx.blocked(`${card} prerequisite absent: ${file}`);
  }
}

function motion(maps, speed, direction = 'forward') {
  const basis = {profile: 'timeline-speed-v1', speed, sourceFps: clock, outputFps: clock,
    sourceRange: {start: edge(0), end: edge(sourceFrames)}};
  const plan = maps.initialTimeMap(unwrap(maps.compileTimeMap(basis)), direction);
  const {loTime, hiTime} = unwrap(maps.timeMapPlanInfo(plan));
  const timing = {profile: basis.profile, basis, view: {direction, loTime, hiTime}, outputWindow: plan.outputWindow,
    pitchShift: false, interpolation: 'off'};
  return {timing, plan};
}

async function syntheticMarkers(root, run) {
  const file = path.join(root, 'markers.mov');
  await run('ffmpeg', [...toolArgs, '-n', '-filter_threads', '1', '-f', 'lavfi', '-i',
    `nullsrc=size=64x64:rate=${fps},format=gray,geq=lum='24+N*8'`, '-frames:v', String(sourceFrames),
    '-c:v', 'png', '-threads:v', '1', file]);
  return {file, sha256: createHash('sha256').update(await readFile(file)).digest('hex')};
}

async function inspectClock(file, frameCount, run) {
  const metadata = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams',
    '-show_frames', '-show_entries', 'stream=time_base:frame=best_effort_timestamp', '-of', 'json', file]));
  assert.equal(metadata.streams.length, 1);
  const timeBase = metadata.streams[0].time_base;
  assert.match(timeBase, /^[1-9]\d*\/[1-9]\d*$/u);
  const [numerator, denominator] = timeBase.split('/').map(BigInt);
  assert.equal(metadata.frames.length, frameCount, 'exact frame count');
  const pts = metadata.frames.map(frame => frame.best_effort_timestamp);
  const ticks = pts.map(value => {
    assert.ok(Number.isSafeInteger(value), 'presented frame has integer PTS');
    return BigInt(value);
  });
  for (const [index, timestamp] of ticks.entries()) {
    // Matroska staging may quantize to milliseconds. Assert the nearest
    // representable tick for the common 30 fps presentation clock.
    const unit = BigInt(fps) * numerator;
    const expected = (2n * BigInt(index) * denominator + unit) / (2n * unit);
    assert.equal(timestamp, expected, `PTS at ordinal ${index}`);
  }
  return timeBase;
}

async function inspectFrames(file, frameCount, {run, runStreaming}) {
  const timeBase = await inspectClock(file, frameCount, run);
  const chunks = [];
  const bytesPerFrame = 4;
  await runStreaming('ffmpeg', [...toolArgs, '-threads', '1', '-i', file, '-map', '0:v:0', '-an', '-filter_threads', '1',
    '-vf', 'crop=2:2', '-fps_mode', 'passthrough', '-c:v', 'rawvideo', '-threads:v', '1', '-pix_fmt', 'gray',
    '-f', 'rawvideo', 'pipe:1'], {maxStdoutBytes: frameCount * bytesPerFrame, onStdout: chunk => chunks.push(chunk)});
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.length, frameCount * bytesPerFrame);
  const ordinals = Array.from({length: frameCount}, (_, index) => {
    const level = bytes[index * bytesPerFrame];
    const ordinal = Math.round((level - marker(0)) / 8);
    assert.ok(ordinal >= 0 && ordinal < sourceFrames && Math.abs(level - marker(ordinal)) <= 3, `unreadable frame marker at ${index}`);
    return ordinal;
  });
  return {ordinals, timeBase};
}

async function comparePicturePipelines(ctx) {
  const previewModule = 'packages/business/src/timeline-processing/preview.ts';
  await requireFeature(ctx, previewModule, 'SP-V preview proxy renderer');
  await requireFeature(ctx, 'packages/business/src/timeline-speed-export-video.ts', 'SP-E export picture staging');
  const [maps, clipTiming, media, preview, {prepareSpeedExportVideo}] = await Promise.all([
    ctx.load('packages/contracts/src/timeline-time-map.ts'), ctx.load('packages/contracts/src/timeline-clip-timing.ts'),
    ctx.load('packages/business/src/media-runtime.ts'), ctx.load(previewModule),
    ctx.load('packages/business/src/timeline-speed-export-video.ts'),
  ]);
  const {file, sha256} = await syntheticMarkers(ctx.scratch, media.run);
  const reverse = {file: path.join(ctx.scratch, 'reverse-input.mkv'), firstSourceOrdinal: 0, frameCount: sourceFrames, storage: 'matroska'};
  await media.run('ffmpeg', [...toolArgs, '-n', '-i', file, '-an', '-filter_threads', '1', '-vf', 'reverse,settb=1/30,setpts=N',
    '-c:v', 'ffv1', '-threads:v', '1', '-pix_fmt', '+gray', '-fps_mode', 'passthrough', reverse.file]);
  const freeze = maps.initialTimeMap(unwrap(maps.compileFreezeTimeMap({sourceFrame: 7, durationFrames: 9, sourceFps: clock, outputFps: clock})));
  const curve = unwrap(maps.instantiateSpeedPreset('slowMiddle', 0, sourceFrames));
  const modes = [
    ['constant', motion(maps, rate(3, 2))], ['curve', motion(maps, curve)], ['reverse', motion(maps, curve, 'reverse')],
    ['freeze', {plan: freeze, timing: {profile: 'timeline-freeze-v1', sourceFrame: 7, sourceVersionId: null, sourceSha256: sha256}}],
  ];
  const verified = [];
  const signal = AbortSignal.timeout(120_000);
  const beforeEffect = () => signal.throwIfAborted();
  for (const [name, {timing, plan}] of modes) {
    const clip = {id: randomUUID(), timing, startFrame: 0, durationFrames: plan.durationFrames, sourceInFrame: 0};
    const expected = Array.from({length: plan.durationFrames}, (_, ordinal) =>
      unwrap(clipTiming.timelineClipSourceAtFrame(clip, {fps}, ordinal)).sourceFrame);
    const source = {path: file, videoStreamIndex: 0};
    const exportStage = await prepareSpeedExportVideo({source, timing, plan, ...(name === 'reverse' ? {reverse} : {}),
      signal, beforeEffect, file: path.join(ctx.scratch, `${name}.mkv`), scriptFile: path.join(ctx.scratch, `${name}.filter`),
      reserve: target => closeSync(openSync(target, 'wx', 0o600)),
      writeOwnedFile: (target, body) => writeFile(target, body, {flag: 'wx', mode: 0o600})});
    const exported = await inspectFrames(exportStage.file, plan.durationFrames, media);
    assert.deepEqual(exported.ordinals, expected, `${name} export versus shared preview sampling`);
    // Native playback and freeze read source frames directly. Both comparisons
    // above use the actual sampler called by preview. Decode the real H.264
    // proxy for modes that require it; this still uses a private renderer stage.
    if (name === 'curve' || name === 'reverse') {
      const stagingDirectory = path.join(ctx.scratch, `preview-${name}`);
      await mkdir(stagingDirectory, {mode: 0o700});
      const input = {source, sourceSha256: sha256, interpolation: 'off', plan};
      const prepared = await preview.preparePreviewProxy(input, {signal, beforeEffect});
      const result = await preview.renderPreviewProxy(input, prepared, {signal, beforeEffect, stagingDirectory});
      assert.equal(result.frameCount, plan.durationFrames);
      const seen = await inspectFrames(path.join(stagingDirectory, 'preview.mp4'), plan.durationFrames, media);
      assert.deepEqual(seen.ordinals, exported.ordinals, `${name} proxy and export select the same source frames`);
    }
    verified.push({mode: name, frames: plan.durationFrames, output: exportStage.path,
      preview: name === 'curve' || name === 'reverse' ? 'rendered H.264 proxy' : 'shared source-frame sampling',
      ...(name === 'reverse' ? {reverseInput: 'synthetic verified stage, no host lease'} : {})});
  }
  return {verified, clockFps: fps, comparison: 'decoded frame ordinals and exact presentation clock'};
}

async function comparePreviewPcm(ctx) {
  const file = `${testRoot}/timeline-speed-preview-audio.test.ts`;
  await requireFeature(ctx, file, 'SP-V preview PCM');
  const run = await ctx.runTest(file);
  return {fixture: file, passed: run.passed, comparison: '48 kHz stereo PCM before lossy AAC, byte exact after seeking',
    lanes: ['source', 'continuous'], coverage: ['0.1x shift', '2x preserve', '10x shift with silent tail', 'curve', 'reverse', 'freeze'],
    reverse: 'synthetic verified PCM lease, including preserved-pitch pre-roll when available'};
}

async function verifyInterpolationExports(ctx) {
  const file = `${testRoot}/timeline-speed-export-interpolation-video.test.ts`;
  await requireFeature(ctx, file, 'SP-I frame interpolation');
  const composition = `${testRoot}/format5-timeline-export.test.ts`;
  const fixtures = [
    await ctx.runTest(composition, {name: 'format 6.*(preflight freezes|rejects missing)'}),
    await ctx.runTest(file),
    await ctx.runTest(`${testRoot}/timeline-processing-optical.test.ts`),
  ];
  return {fixtures, modes: ['off', 'blend', 'optical'],
    coverage: ['real project admission and export worker', 'blend weights and fast-frame passthrough', 'optical frame count and seams']};
}

async function withHostedMedia(ctx, exercise) {
  const contract = 'packages/contracts/src/timeline-preview-media.ts';
  await requireFeature(ctx, contract, 'SP-V project preview operation');
  const [{startServer}, {projectRpcPath, projectMediaPath}, media, clipTiming, maps] = await Promise.all([
    ctx.load('tests/helpers/test-server.ts'), ctx.load('packages/contracts/src/project-file.ts'),
    ctx.load('packages/business/src/media-runtime.ts'), ctx.load('packages/contracts/src/timeline-clip-timing.ts'),
    ctx.load('packages/contracts/src/timeline-time-map.ts'),
  ]);
  const root = path.join(ctx.scratch, 'app');
  const token = `sp-q-${randomUUID()}`;
  const source = path.join(ctx.scratch, 'source.mp4');
  await media.run('ffmpeg', [...toolArgs, '-n', '-filter_threads', '1', '-f', 'lavfi', '-i',
    `nullsrc=size=64x64:rate=${fps},format=gray,geq=lum='24+N*8'`, '-frames:v', String(sourceFrames),
    '-threads:v', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', source]);
  const server = await startServer({dataDir: root, port: 0, token, localDraftChannel: 'development', projectFormatForTest: undefined});
  const headers = {'content-type': 'application/json', authorization: `Bearer ${token}`};
  try {
    const post = async (route, operation, input) => {
      const response = await fetch(server.url + route, {method: 'POST', headers, body: JSON.stringify({operation, input}),
        signal: AbortSignal.timeout(15_000)});
      assert.ok(response.headers.get('content-type')?.includes('application/json'), `${operation} returned JSON`);
      return response.json();
    };
    function data(reply, operation) {
      assert.equal(reply.ok, true, `${operation}: ${reply.error?.code ?? ''}`);
      return reply.data;
    }
    const projectId = data(await post('/api/rpc', 'project.create', {name: 'Synthetic speed parity'}), 'project.create').id;
    assert.match(projectId, /^[0-9a-f-]{36}$/u);
    const wire = (operation, input = {}) => post(projectRpcPath(projectId), operation, {projectId, ...input});
    const rpc = async (operation, input) => data(await wire(operation, input), operation);
    const edit = async (operation, action) => {
      const preview = await rpc(operation, action);
      const receipt = await rpc('sequence.action.commit', {envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
      assert.equal(receipt.status, 'applied');
    };
    const imported = await rpc('asset.import', {name: 'source.mp4', mimeType: 'video/mp4', dataBase64: (await readFile(source)).toString('base64')});
    await edit('sequence.board.edit', {kind: 'board-root-create', name: 'Film', position: {x: 0, y: 0}});
    await edit('sequence.timeline.edit', {kind: 'insert-asset', assetId: imported.id, trackId: null, startFrame: 0});
    const current = async () => (await rpc('project.get')).timeline;
    const timeline = await current();
    assert.equal(timeline.capabilities.speed, true, 'format 6 development host exposes speed controls');
    const clipId = timeline.clips.find(clip => clip.assetId === imported.id)?.id;
    assert.ok(clipId);
    const preview = () => wire('timeline.preview.media', {clipId});
    assert.deepEqual(data(await preview(), 'timeline.preview.media'), {mode: 'native', rate: {numerator: 1, denominator: 1}});
    const clipSpeed = (speed, direction, interpolation = 'off') => edit('sequence.timeline.edit', {kind: 'clip-speed', clipId,
      setting: {speed, direction, pitchShift: false, interpolation}});
    const downloadMedia = async (url, label) => {
      const response = await fetch(url, {headers, signal: AbortSignal.timeout(15_000)});
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^video\/mp4\b/u);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length > 0 && bytes.length <= 5 * 1024 * 1024);
      const file = path.join(ctx.scratch, label + '.mp4');
      await writeFile(file, bytes, {flag: 'wx', mode: 0o600});
      return file;
    };
    const exportMedia = async (saved, label) => {
      const input = {expectedRevision: saved.revision};
      const report = await rpc('timeline.export.preflight', input);
      assert.equal(report.status, 'ready', 'native project export preflight: ' + report.issues?.map(issue => issue.code).join(', '));
      const queued = await rpc('timeline.render', {...input, requestId: randomUUID(), purpose: 'export',
        preflightSnapshotHash: report.snapshotHash});
      const expiresAt = Date.now() + 40_000;
      do {
        const record = await rpc('export.get', {exportId: queued.id});
        if (record.status === 'succeeded') {
          assert.ok(record.assetId);
          return downloadMedia(new URL(projectMediaPath(projectId, record.assetId), server.url), label);
        }
        assert.ok(['queued', 'running'].includes(record.status), record.error?.code ?? record.status);
        await delay(75);
      } while (Date.now() < expiresAt);
      assert.fail('Final export did not publish before deadline');
    };
    const expectedOrdinals = (clip, saved) => Array.from({length: clip.durationFrames}, (_, offset) =>
      unwrap(clipTiming.timelineClipSourceAtFrame(clip, saved, clip.startFrame + offset)).sourceFrame);
    return await exercise({maps, media, server, projectId, clipId, preview, clipSpeed, current, data, downloadMedia, exportMedia,
      expectedOrdinals, original: () => downloadMedia(new URL(projectMediaPath(projectId, imported.id), server.url), 'native-source')});
  } finally { await server.close(); }
}

function verifyNativeProjectExport(ctx) {
  return withHostedMedia(ctx, async ({clipId, media, preview, clipSpeed, current, data, original, exportMedia, expectedOrdinals}) => {
    const originalFile = await original();
    const source = await inspectFrames(originalFile, sourceFrames, media);
    assert.deepEqual(source.ordinals, Array.from({length: sourceFrames}, (_, ordinal) => ordinal));
    await clipSpeed(rate(3, 2), 'forward');
    assert.deepEqual(data(await preview(), 'timeline.preview.media'), {mode: 'native', rate: {numerator: 3, denominator: 2}});
    const timeline = await current();
    const clip = timeline.clips.find(item => item.id === clipId);
    assert.ok(clip);
    const file = await exportMedia(timeline, 'native-export');
    const output = await inspectFrames(file, clip.durationFrames, media);
    assert.deepEqual(output.ordinals, expectedOrdinals(clip, timeline).map(ordinal => source.ordinals[ordinal]));
    return {frames: clip.durationFrames, mode: 'native', transport: 'authenticated HTTP source and published export'};
  });
}

function verifyProjectPreview(ctx) {
  return withHostedMedia(ctx, async ({maps, media, server, projectId, clipId, preview, clipSpeed, current, data,
    downloadMedia, expectedOrdinals}) => {
    const curve = unwrap(maps.instantiateSpeedPreset('slowMiddle', 0, sourceFrames));
    const gentleCurve = {kind: 'curve', presetId: 'custom', interpolation: 'log-pchip-v1', points: [
      {sourceFrame: 0, rate: rate(1, 2).rate}, {sourceFrame: sourceFrames, rate: rate(11, 20).rate},
    ]};
    const missing = [];
    const result = [];
    for (const [mode, speed, direction, interpolation] of [
      ['curve', curve, 'forward', 'off'], ['reverse', rate(3, 2), 'reverse', 'off'],
      ['blend', gentleCurve, 'forward', 'blend'], ['optical', gentleCurve, 'forward', 'optical'],
    ]) {
      await clipSpeed(speed, direction, interpolation);
      const expiresAt = Date.now() + 20_000;
      let ready;
      do {
        const reply = await preview();
        const code = reply.error?.code;
        if (!reply.ok && (code === 'SPEED_PROCESSING_UNAVAILABLE' || (mode === 'blend' && code === 'UNSUPPORTED_FORMAT'))) {
          missing.push(`${mode}: ${code}`);
          break;
        }
        const observed = data(reply, 'timeline.preview.media');
        assert.equal(observed.mode, 'proxy', `${mode} must name its preview proxy`);
        if (observed.status === 'ready') { ready = observed; break; }
        assert.ok(['queued', 'running'].includes(observed.status), `${mode} task: ${observed.reason ?? observed.status}`);
        await delay(75);
      } while (Date.now() < expiresAt);
      if (missing.some(item => item.startsWith(`${mode}:`))) continue;
      assert.ok(ready, `${mode} preview proxy did not become ready before deadline`);
      const proxy = new URL(ready.url, server.url);
      assert.equal(proxy.origin, new URL(server.url).origin);
      assert.ok(proxy.pathname.startsWith(`/api/projects/${projectId}/`));
      assert.equal((await fetch(proxy, {method: 'HEAD', signal: AbortSignal.timeout(15_000)})).status, 401);
      const file = await downloadMedia(proxy, `${mode}-owned-preview`);
      const saved = await current();
      const clip = saved.clips.find(item => item.id === clipId);
      assert.ok(clip);
      assert.equal(ready.durationFrames, clip.durationFrames);
      // Interpolated preview may have synthetic samples between source markers.
      // The off modes must reproduce the exact physical source ordinals.
      if (interpolation === 'off') {
        const seen = await inspectFrames(file, clip.durationFrames, media);
        assert.deepEqual(seen.ordinals, expectedOrdinals(clip, saved));
      } else {
        await inspectClock(file, clip.durationFrames, media.run);
      }
      result.push({mode, frames: clip.durationFrames});
    }
    if (missing.length) ctx.blocked(`SP-V/SP-P project preview proxy unavailable (${missing.join(', ')}); native read and ${result.length} ready proxies verified`);
    return {native: 'HTTP RPC', proxyFetch: 'authenticated project media', verified: result};
  });
}

export const scenarios = [
  {id: 'preview-export-frame-ordinals', run: comparePicturePipelines},
  {id: 'preview-export-audio-pcm', run: comparePreviewPcm},
  {id: 'export-interpolation-modes', run: verifyInterpolationExports},
  {id: 'project-preview-proxy-media', run: verifyProjectPreview},
  {id: 'project-native-preview-export', run: verifyNativeProjectExport},
];
