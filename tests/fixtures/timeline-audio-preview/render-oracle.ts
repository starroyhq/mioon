/** Explicit test-only, serial media proof. No execution on import.
 * Usage: node tests/fixtures/timeline-audio-preview/render-oracle.ts <numeric-fixtures-directory> <fresh-output-directory>
 * Reuses the numeric harness's unchanged canonical WAV and independent oracles.
 * Actual renderTimeline float-v2 MOVs are copied only after observed child close.
 * PCM claims concern these pre-AAC intermediates; final AAC is probed/decoded,
 * never described as sample-identical. The separate AAC reseek case reports its
 * measured errors without enlarging the canonical comparison tolerance. The
 * original contiguous-decode red report remains preserved in render-oracle-v1. */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile, stat, readdir} from 'node:fs/promises';
import {constants, copyFileSync, readdirSync, lstatSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import type {Stats} from 'node:fs';
import {resolveTimelineExportDelivery} from '../../../packages/contracts/src/index.ts';
import {timelineCompositionSegments} from '../../../packages/contracts/src/timeline-segments.ts';
import {renderTimeline} from '../../../packages/business/src/timeline-media.ts';
import {run, runStreaming, checkMediaEffect} from '../../../packages/business/src/media-runtime.ts';
import {withProbePermit} from '../../../packages/business/src/media-probe.ts';
import {onMediaProcess} from '../../../packages/business/src/media-processes.ts';
import {createTimelineAudioPreviewDecoder} from '../../../packages/business/src/timeline-audio-preview-decoder.ts';
import {planTimelineExportRange} from '../../../packages/business/src/timeline-export-range-plan.ts';

interface Voice {clipId: string; trackId: string; startFrame: number; durationFrames: number; sourceInFrame: number; gain: number; fadeInFrames: number; fadeOutFrames: number}
interface RenderAsset {id: string; projectId: string; mimeType: string; path: string; sha256: string; sizeBytes: number; width: number; height: number; duration?: number; hasVideo: boolean; hasAudio: boolean; audioStreamIndex?: number; videoStreamIndex?: number}
interface ChannelStat {channel: number; maximumAbsoluteError: number; squaredError: number; samplesBeyondCanonicalTolerance: number; firstNonzeroActual: number|null; lastNonzeroActual: number|null; firstNonzeroExpected: number|null; lastNonzeroExpected: number|null; rootMeanSquareError?: number}
const hash = (bytes: Buffer|Uint8Array|string): string => createHash('sha256').update(bytes).digest('hex');
const SAMPLE_BYTES = 8, SAMPLES_PER_FRAME = 1600, MAX_FRAMES = 90, PCM_CAP = MAX_FRAMES * SAMPLES_PER_FRAME * SAMPLE_BYTES;
const CANONICAL_TOLERANCE = 0.000002;
const settings = {profileId: 'mp4_h264_float_checked_v2', resolution: 'short_360', rateControl: {mode: 'crf', quality: 'standard'}};
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function boundedRead(file: string, limit: number): Promise<Buffer> {
  const info = await stat(file); assert.ok(info.isFile() && info.size > 0 && info.size <= limit, 'Fixture file size must be bounded');
  const bytes = await readFile(file); assert.equal(bytes.length, info.size); return bytes;
}
function timelineFromVoices(voices: readonly Voice[], asset: RenderAsset, durationFrames: number, extraMutedEdges: readonly (readonly [number, number])[] = []): Record<string, unknown> {
  const video = {id: randomUUID(), kind: 'video', orderIndex: 0, hidden: false, muted: false};
  const tracks: Record<string, unknown>[] = [video], clips: Record<string, unknown>[] = [], rect = {x: 0, y: 0, width: 720, height: 720};
  for (const voice of voices) {
    tracks.push({id: voice.trackId, kind: asset.hasVideo ? 'video' : 'audio', orderIndex: tracks.length, hidden: asset.hasVideo, muted: false});
    clips.push({id: voice.clipId, trackId: voice.trackId, assetId: asset.id, name: 'Synthetic original voice',
      startFrame: voice.startFrame, durationFrames: voice.durationFrames, sourceInFrame: voice.sourceInFrame,
      gain: voice.gain, fadeInFrames: voice.fadeInFrames, fadeOutFrames: voice.fadeOutFrames, rect});
  }
  // A muted full-length source preserves a real saved duration, including the
  // canonical oracle's trailing silence. Separate muted tracks add valid edges.
  for (const [startFrame, frames] of [[0, durationFrames], ...extraMutedEdges]) {
    const trackId = randomUUID(); tracks.push({id: trackId, kind: asset.hasVideo ? 'video' : 'audio', orderIndex: tracks.length, hidden: asset.hasVideo, muted: true});
    clips.push({id: randomUUID(), trackId, assetId: asset.id, name: 'Synthetic muted duration/edge', startFrame,
      durationFrames: frames, sourceInFrame: 0, gain: 1, rect});
  }
  return {id: randomUUID(), projectId: asset.projectId, revision: 1, fps: 30, width: 720, height: 720,
    durationFrames, tracks, clips, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'};
}
// The preserved numeric/red evidence predates segmented source descriptors.
// Read only its bounded synthetic layout, then let the real renderer validate
// the constructed saved timeline. Never rewrite or relabel the old manifests.
interface NumericPlan {schemaVersion: number; profileId: string; voices: Voice[]; sources: {assetId: string; sourceHash: string; sourceBytes: number; [key: string]: unknown}[]; range: {startFrame: number; endFrame: number}; projectId: string; [key: string]: unknown}
function numericFixturePlan(plan: unknown): NumericPlan {
  const value = plan as NumericPlan;
  assert.equal(value.schemaVersion, 1); assert.equal(value.profileId, 'saved-timeline-audio-f32le-48k-stereo-v1');
  assert.ok(Array.isArray(value.voices) && value.voices.length <= 100 && Array.isArray(value.sources) && value.sources.length <= 100);
  assert.ok(Number.isInteger(value.range.startFrame) && Number.isInteger(value.range.endFrame) && value.range.startFrame >= 0 && value.range.endFrame <= MAX_FRAMES);
  return value;
}
function sourceRequest(timeline: Record<string, unknown>, voice: Voice, startFrame = voice.startFrame, endFrame = voice.startFrame + voice.durationFrames) {
  assert.ok(startFrame >= voice.startFrame && endFrame <= voice.startFrame + voice.durationFrames && endFrame > startFrame);
  const segments: {sourceInFrame: number; frameCount: number; trimStartFrame: number; outputFrames: number}[] = [];
  for (const segment of timelineCompositionSegments(timeline as never)) {
    if (segment.beginFrame < voice.startFrame || segment.endFrame > voice.startFrame + voice.durationFrames) continue;
    const begin = Math.max(startFrame, segment.beginFrame), end = Math.min(endFrame, segment.endFrame);
    if (begin >= end) continue;
    segments.push({sourceInFrame: voice.sourceInFrame + segment.beginFrame - voice.startFrame, frameCount: segment.endFrame - segment.beginFrame,
      trimStartFrame: begin - segment.beginFrame, outputFrames: end - begin});
  }
  return {sourceInFrame: voice.sourceInFrame + startFrame - voice.startFrame, frameCount: endFrame - startFrame, segments};
}
function saved(timeline: Record<string, unknown>, range?: {startFrame: number; endFrame: number}) {
  return {timeline, delivery: resolveTimelineExportDelivery(timeline, settings), ...(range ? {exportRange: range} : {})};
}
function measure(actual: Buffer, expected: Buffer, from = 0, to = actual.length / SAMPLE_BYTES) {
  assert.equal(actual.length, expected.length); assert.equal(actual.length % SAMPLE_BYTES, 0);
  assert.ok(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to > from && to <= actual.length / SAMPLE_BYTES);
  const channels: ChannelStat[] = [0, 1].map((channel: number) => ({channel, maximumAbsoluteError: 0, squaredError: 0, samplesBeyondCanonicalTolerance: 0,
    firstNonzeroActual: null, lastNonzeroActual: null, firstNonzeroExpected: null, lastNonzeroExpected: null}));
  for (let frame = from; frame < to; frame++) for (const channel of channels) {
    const offset = frame * SAMPLE_BYTES + channel.channel * 4, a = actual.readFloatLE(offset), b = expected.readFloatLE(offset);
    assert.ok(Number.isFinite(a) && Number.isFinite(b), 'Every PCM sample must be finite');
    const error = Math.abs(a - b); channel.maximumAbsoluteError = Math.max(channel.maximumAbsoluteError, error); channel.squaredError += error * error;
    if (error > CANONICAL_TOLERANCE) channel.samplesBeyondCanonicalTolerance++;
    if (a !== 0) {channel.firstNonzeroActual ??= frame; channel.lastNonzeroActual = frame;}
    if (b !== 0) {channel.firstNonzeroExpected ??= frame; channel.lastNonzeroExpected = frame;}
  }
  return {fromSample: from, endSample: to, sampleFrames: to - from, channels: channels.map(({squaredError, ...channel}) => ({...channel, rootMeanSquareError: Math.sqrt(squaredError / (to - from))}))};
}
function canonicalResult(name: string, actual: Buffer, expected: Buffer) {
  const comparison = measure(actual, expected);
  return {name, status: comparison.channels.every(channel => channel.maximumAbsoluteError <= CANONICAL_TOLERANCE) ? 'passed' : 'failed',
    absoluteTolerance: CANONICAL_TOLERANCE, actualPcmSha256: hash(actual), oraclePcmSha256: hash(expected), ...comparison};
}
async function decodeInto(file: string, target: Buffer, offset: number, expectedBytes: number): Promise<void> {
  let count = 0;
  const output = await runStreaming('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-threads', '1', '-i', file,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'pcm_f32le', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1'],
  {timeout: 30000, maxStdoutBytes: expectedBytes, maxStderrBytes: 64 * 1024, onStdout(chunk: Buffer) {
    assert.ok(chunk.length <= expectedBytes - count && offset + count + chunk.length <= target.length);
    chunk.copy(target, offset + count); count += chunk.length;
  }});
  assert.equal(output.stdoutBytes, count); assert.equal(count, expectedBytes, 'Closed segment must decode to its exact declared sample count');
}
/** No process or runtime injection: the observation API reports exited only
 * on direct-child close. This fixture executes one renderer at a time, and its
 * fresh private root contains only that attempt's owned render staging. */
interface RenderResult {audioCheck: {sampleFrames: number; overRangeSampleCount: number; peakLinear: number}; probe: {streams: {codec_type: string; codec_name: string; sample_rate: unknown; channels: number}[]}; width: number; height: number; duration: number}
interface CapturedSegment {file: string; containerBytes: number; containerSha256: string; observedAfterChildClose: number; [key: string]: unknown}
async function renderAndCapture(outputRoot: string, label: string, snapshot: Record<string, unknown>, assets: Map<string, RenderAsset>) {
  const directory = await mkdtemp(path.join(outputRoot, `${label}-`)), destination = path.join(directory, 'export.mp4');
  const expected = planTimelineExportRange(snapshot as never), captured = new Map<string, CapturedSegment>(); let captureFailure: unknown, copiedBytes = 0, closes = 0;
  const off = onMediaProcess((event: {type: string; kind?: string}) => {
    if (event.type !== 'exited' || event.kind !== 'ffmpeg') return;
    closes++;
    try {
      const workNames = readdirSync(directory).filter((name: string) => name.startsWith('.timeline-render-'));
      assert.ok(workNames.length <= 1);
      for (const name of workNames) {
        const work = path.join(directory, name), info = lstatSync(work); assert.ok(info.isDirectory() && !info.isSymbolicLink());
        for (const leaf of readdirSync(work).filter((name: string) => /^segment-\d{3}\.mov$/u.test(name)).sort()) {
          if (captured.has(leaf)) continue;
          const file = path.join(work, leaf), before = lstatSync(file);
          if (before.size === 0) continue;
          assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= 16 * 1024 * 1024);
          assert.ok(copiedBytes + before.size <= 32 * 1024 * 1024);
          const copy = path.join(directory, `closed-${leaf}`); copyFileSync(file, copy, constants.COPYFILE_EXCL);
          assert.ok(same(before, lstatSync(file)), 'Observed closed synthetic segment identity must remain unchanged during copy');
          const copied = readFileSync(copy); assert.equal(copied.length, before.size); copiedBytes += copied.length;
          captured.set(leaf, {file: copy, containerBytes: copied.length, containerSha256: hash(copied), observedAfterChildClose: closes});
        }
      }
    } catch (error) {captureFailure ??= error;}
  });
  const serialized = JSON.stringify(snapshot); let result: RenderResult;
  try {result = await renderTimeline(snapshot as never, assets as never, destination) as unknown as RenderResult;} finally {off();}
  if (captureFailure) throw captureFailure;
  assert.equal(JSON.stringify(snapshot), serialized); assert.equal(captured.size, expected.segments.length);
  assert.ok(!(await readdir(directory)).some((name: string) => name.startsWith('.timeline-render-')), 'Renderer cleaned its own staging');
  assert.equal(result.audioCheck.sampleFrames, expected.outputFrames * SAMPLES_PER_FRAME); assert.equal(result.audioCheck.overRangeSampleCount, 0);
  const byteLength = expected.outputFrames * SAMPLES_PER_FRAME * SAMPLE_BYTES; assert.ok(byteLength <= PCM_CAP);
  const pcm = Buffer.allocUnsafe(byteLength), segments: Record<string, unknown>[] = []; let offset = 0;
  for (const [index, segment] of [...captured].sort(([a], [b]) => a.localeCompare(b)).map((entry, index) => [index, entry[1]] as [number, CapturedSegment])) {
    const planned = expected.segments[index], bytes = planned.outputFrames * SAMPLES_PER_FRAME * SAMPLE_BYTES;
    await decodeInto(segment.file, pcm, offset, bytes);
    segments.push({...segment, file: path.relative(outputRoot, segment.file), ...planned, sampleFrames: bytes / SAMPLE_BYTES,
      pcmSha256: hash(pcm.subarray(offset, offset + bytes))}); offset += bytes;
  }
  assert.equal(offset, pcm.length);
  const aac = result.probe.streams.find((stream: {codec_type: string}) => stream.codec_type === 'audio');
  assert.ok(aac);
  assert.equal(aac.codec_name, 'aac'); assert.equal(Number(aac.sample_rate), 48000); assert.equal(aac.channels, 2);
  // AAC packet padding can extend raw decode. Observe the actual full output
  // within a fixed small reserve, rather than trimming it into an equality claim.
  let aacDecodedBytes = 0; const aacDigest = createHash('sha256'); let aacPeak = 0, pending = Buffer.alloc(0);
  await runStreaming('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-threads', '1', '-i', destination,
    '-map', '0:a:0', '-vn', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], {timeout: 30000,
    maxStdoutBytes: byteLength + 4096 * SAMPLE_BYTES, maxStderrBytes: 64 * 1024, onStdout(chunk: Buffer) {
      aacDecodedBytes += chunk.length; aacDigest.update(chunk);
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk, complete = data.length - data.length % 4;
      for (let at = 0; at < complete; at += 4) {const sample = data.readFloatLE(at); assert.ok(Number.isFinite(sample)); aacPeak = Math.max(aacPeak, Math.abs(sample));}
      pending = Buffer.from(data.subarray(complete));
    }});
  assert.equal(pending.length, 0); assert.equal(aacDecodedBytes % SAMPLE_BYTES, 0);
  assert.ok(aacDecodedBytes >= byteLength && aacDecodedBytes <= byteLength + 4096 * SAMPLE_BYTES);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-threads', '1', '-i', destination,
    '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], {timeout: 30000, maxStdoutBytes: 0, maxStderrBytes: 64 * 1024});
  const exported = await boundedRead(destination, 16 * 1024 * 1024);
  return {pcm, report: {snapshotSha256: hash(serialized), snapshotUnchanged: true, exactPreEncodeSampleFrames: pcm.length / SAMPLE_BYTES,
    preEncodePcmSha256: hash(pcm), segments, copiedContainerBytes: copiedBytes, floatCheckPeak: result.audioCheck.peakLinear,
    finalExport: {file: path.relative(outputRoot, destination), sha256: hash(exported), bytes: exported.length,
      width: result.width, height: result.height, durationSeconds: result.duration, videoAndAudioDecodeSucceeded: true,
      audioCodec: aac.codec_name, sampleRate: Number(aac.sample_rate), channels: aac.channels,
      decodedAacSampleFrames: aacDecodedBytes / SAMPLE_BYTES, decodedAacPcmSha256: aacDigest.digest('hex'), decodedAacPeak: aacPeak,
      note: 'Final AAC verified by actual probe/full decode; pre-encode PCM comparisons do not claim encoded sample identity.'}}};
}

interface NumericManifest {schemaVersion: number; input: {sampleRate: number; channels: number; sha256: string}; cases: {name: string; plan: unknown; absoluteTolerance: number; oracle: string; oracleSha256: string; cursorSample: number}[]}
interface RenderOracleReport extends Record<string, unknown> {
  schemaVersion: number; status: string; startedAt: string; canonicalTolerance: number; scope: string; cases: Record<string, unknown>[];
  finishedAt?: string; error?: {name?: string; code?: string|null; message?: string};
}
export async function runRenderOracle(inputDirectory: string, outputDirectory: string): Promise<RenderOracleReport> {
  const inputRoot = path.resolve(inputDirectory), outputRoot = path.resolve(outputDirectory);
  assert.notEqual(inputRoot, outputRoot); await mkdir(outputRoot, {mode: 0o700});
  const report: RenderOracleReport = {schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), canonicalTolerance: CANONICAL_TOLERANCE,
    scope: 'Actual renderTimeline float-v2 pre-AAC segments against independently generated FFmpeg oracles; separate measured 44.1k AAC reseek qualification. No listening claim.', cases: []};
  try {
    const manifest = JSON.parse((await boundedRead(path.join(inputRoot, 'fixtures.json'), 256 * 1024)).toString('utf8')) as NumericManifest;
    assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.input.sampleRate, 48000); assert.equal(manifest.input.channels, 2);
    const original = path.join(inputRoot, 'canonical.wav'), originalBytes = await boundedRead(original, 2 * 1024 * 1024);
    assert.equal(hash(originalBytes), manifest.input.sha256); const originalHash = hash(originalBytes);
    const originalCase = manifest.cases.find((item: {name: string}) => item.name === 'canonical-onset-end-overlap-fades');
    assert.ok(originalCase);
    const originalPlan = numericFixturePlan(originalCase.plan);
    const baseAsset = {id: originalPlan.sources[0].assetId, projectId: originalPlan.projectId, mimeType: 'audio/wav', path: original, sha256: originalHash,
      sizeBytes: originalBytes.length, width: 0, height: 0, duration: 3, hasVideo: false, hasAudio: true, audioStreamIndex: 0};
    for (const name of ['canonical-onset-end-overlap-fades', 'window-cut-through-original-fades']) {
      const fixture = manifest.cases.find((item: {name: string}) => item.name === name); assert.ok(fixture); const plan = numericFixturePlan(fixture.plan);
      assert.equal(fixture.absoluteTolerance, CANONICAL_TOLERANCE);
      for (const source of plan.sources) {assert.equal(source.sourceHash, originalHash); assert.equal(source.sourceBytes, originalBytes.length);}
      const timeline = timelineFromVoices(plan.voices, baseAsset, 90), range = name.startsWith('window-') ? {startFrame: plan.range.startFrame, endFrame: plan.range.endFrame} : undefined;
      const rendered = await renderAndCapture(outputRoot, name, saved(timeline, range), new Map<string, RenderAsset>([[baseAsset.id, baseAsset]]));
      assert.match(fixture.oracle, /^[a-z0-9-]+\.f32$/u); const oracle = await boundedRead(path.join(inputRoot, fixture.oracle), PCM_CAP);
      assert.equal(hash(oracle), fixture.oracleSha256);
      const comparison: Record<string, unknown> = canonicalResult(name, rendered.pcm, oracle); report.cases.push({...comparison, render: rendered.report});
      if (name === 'canonical-onset-end-overlap-fades') {
        const seek = manifest.cases.find((item: {name: string}) => item.name === 'sample-precise-seek-inside-original-fade'); assert.ok(seek);
        assert.match(seek.oracle, /^[a-z0-9-]+\.f32$/u); const seekOracle = await boundedRead(path.join(inputRoot, seek.oracle), PCM_CAP); assert.equal(hash(seekOracle), seek.oracleSha256);
        report.cases.push(canonicalResult('actual-renderer-sample-precise-seek-oracle', rendered.pcm.subarray(seek.cursorSample * SAMPLE_BYTES), seekOracle) as unknown as Record<string, unknown>);
      }
    }
    // A separate bounded AAC source preserves the same synthetic signal and
    // exposes decoder resampler initialization at saved global segment edges.
    const aacFile = path.join(outputRoot, 'synthetic-44100-aac.m4a');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-threads', '1', '-i', original,
      '-map', '0:a:0', '-ar', '44100', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', aacFile], {timeout: 30000, maxStdoutBytes: 0, maxStderrBytes: 64 * 1024});
    const aacBytes = await boundedRead(aacFile, 1024 * 1024), aacHash = hash(aacBytes);
    const aacAsset = {...baseAsset, id: randomUUID(), mimeType: 'audio/mp4', path: aacFile, sha256: aacHash, sizeBytes: aacBytes.length};
    const voice: Voice = {clipId: randomUUID(), trackId: randomUUID(), startFrame: 0, durationFrames: 60, sourceInFrame: 7, gain: 1, fadeInFrames: 0, fadeOutFrames: 0};
    const timeline = timelineFromVoices([voice], aacAsset, 60, [[17, 12]]);
    const rendered = await renderAndCapture(outputRoot, 'aac-reseek', saved(timeline), new Map<string, RenderAsset>([[aacAsset.id, aacAsset]]));
    const decoder = createTimelineAudioPreviewDecoder({run, runStreaming, withProbePermit, checkMediaEffect}), started = performance.now();
    const request = sourceRequest(timeline, voice);
    const prepared = await decoder(aacFile, request, {beforeEffect() {}, remainingMs: () => Math.max(0, 120000 - (performance.now() - started))});
    assert.equal(prepared.source.sampleRate, 44100); assert.equal(prepared.source.codecName, 'aac'); assert.equal(prepared.pcm.length, rendered.pcm.length);
    const full = measure(prepared.pcm, rendered.pcm), boundaries = [17, 29].map(frame => frame * SAMPLES_PER_FRAME), radius = 2048;
    const seamWindows = boundaries.map(sample => ({boundarySample: sample, ...measure(prepared.pcm, rendered.pcm, sample - radius, sample + radius)}));
    const interiorWindows = [[radius, boundaries[0] - radius], [boundaries[0] + radius, boundaries[1] - radius], [boundaries[1] + radius, prepared.sampleFrames - radius]]
      .map(([from, to]) => measure(prepared.pcm, rendered.pcm, from, to));
    report['aacReseek'] = {status: prepared.pcm.equals(rendered.pcm) ? 'passed' : 'failed', request, sourceSha256: aacHash, sourceBytes: aacBytes.length, sourceSampleRate: prepared.source.sampleRate,
      sourceInFrame: 7, durationFrames: 60, previewPcmSha256: hash(prepared.pcm), rendererPcmSha256: hash(rendered.pcm),
      exactIdentity: prepared.pcm.equals(rendered.pcm), canonicalTolerancePassed: full.channels.every(channel => channel.maximumAbsoluteError <= CANONICAL_TOLERANCE),
      full, seamWindowRadiusSamples: radius, seamWindows, interiorWindows, render: rendered.report,
      qualification: 'Preview reproduces the actual export original global segments and trims after original resampling. Prior contiguous AAC mismatch remains in render-oracle-v1. Equality here concerns pre-encode PCM, never final encoded AAC.'};
    // An admitted window begins inside the original first segment and ends
    // inside the last. Actual selected export preserves those original seeks.
    const selectedRequest = sourceRequest(timeline, voice, 12, 42);
    const selected = await renderAndCapture(outputRoot, 'aac-selected-window', saved(timeline, {startFrame: 12, endFrame: 42}), new Map<string, RenderAsset>([[aacAsset.id, aacAsset]]));
    const selectedStarted = performance.now();
    const selectedPrepared = await decoder(aacFile, selectedRequest, {beforeEffect() {}, remainingMs: () => Math.max(0, 120000 - (performance.now() - selectedStarted))});
    report['aacSelectedWindow'] = {request: selectedRequest, ...canonicalResult('AAC-original-segments-selected-window', selectedPrepared.pcm, selected.pcm),
      exactIdentity: selectedPrepared.pcm.equals(selected.pcm), exactWholeWindowIdentity: selectedPrepared.pcm.equals(rendered.pcm.subarray(12 * 1600 * 8, 42 * 1600 * 8)), render: selected.report};
    const seekSample = 8 * 1600 + 317;
    report['aacSeekSuffix'] = {...canonicalResult('AAC-sample-precise-seek-suffix', prepared.pcm.subarray(seekSample * 8), rendered.pcm.subarray(seekSample * 8)),
      exactIdentity: prepared.pcm.subarray(seekSample * 8).equals(rendered.pcm.subarray(seekSample * 8)), seekSample};
    // Short embedded audio is still a genuine selected stream. Muted global
    // edges force later original seeks beyond audio EOF; the fixed silence-first
    // source mixer must match the real renderer, including an all-silent window.
    const shortFile = path.join(outputRoot, 'short-embedded-aac.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-threads', '1', '-filter_threads', '1',
      '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=30:d=2', '-t', '0.2', '-i', original,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-c:a', 'aac', '-b:a', '128k', shortFile],
    {timeout: 30000, maxStdoutBytes: 0, maxStderrBytes: 64 * 1024});
    const shortBytes = await boundedRead(shortFile, 1024 * 1024), shortHash = hash(shortBytes);
    const shortAsset = {...baseAsset, id: randomUUID(), mimeType: 'video/mp4', path: shortFile, sha256: shortHash, sizeBytes: shortBytes.length,
      duration: 2, hasVideo: true, width: 16, height: 16, videoStreamIndex: 0, audioStreamIndex: 1};
    const shortVoice: Voice = {...voice, clipId: randomUUID(), trackId: randomUUID(), sourceInFrame: 0};
    const shortTimeline = timelineFromVoices([shortVoice], shortAsset, 60, [[17, 12]]), shortAssets = new Map<string, RenderAsset>([[shortAsset.id, shortAsset]]);
    const shortRendered = await renderAndCapture(outputRoot, 'short-embedded-whole', saved(shortTimeline), shortAssets);
    const shortStarted = performance.now(), shortRequest = sourceRequest(shortTimeline, shortVoice);
    const shortPrepared = await decoder(shortFile, shortRequest, {beforeEffect() {}, remainingMs: () => Math.max(0, 120000 - (performance.now() - shortStarted))});
    assert.equal(shortPrepared.source.streamIndex, 1); assert.ok(Number(shortPrepared.source.audioDurationSeconds) < Number(shortPrepared.source.durationSeconds));
    report['shortEmbeddedAudio'] = {request: shortRequest, ...canonicalResult('short-embedded-global-segments', shortPrepared.pcm, shortRendered.pcm),
      exactIdentity: shortPrepared.pcm.equals(shortRendered.pcm), sourceSha256: shortHash, sourceProbe: shortPrepared.source, render: shortRendered.report};
    const silentRendered = await renderAndCapture(outputRoot, 'short-embedded-silent-window', saved(shortTimeline, {startFrame: 32, endFrame: 48}), shortAssets);
    const silentStarted = performance.now(), silentRequest = sourceRequest(shortTimeline, shortVoice, 32, 48);
    const silentPrepared = await decoder(shortFile, silentRequest, {beforeEffect() {}, remainingMs: () => Math.max(0, 120000 - (performance.now() - silentStarted))});
    report['shortEmbeddedSilentWindow'] = {request: silentRequest, ...canonicalResult('short-embedded-after-EOF-selected-window', silentPrepared.pcm, silentRendered.pcm),
      exactIdentity: silentPrepared.pcm.equals(silentRendered.pcm), allSilent: silentPrepared.pcm.every(byte => byte === 0), render: silentRendered.report};
    assert.equal(hash(await boundedRead(shortFile, 1024 * 1024)), shortHash);
    assert.equal(hash(await boundedRead(aacFile, 1024 * 1024)), aacHash);
    assert.equal(hash(await boundedRead(original, 2 * 1024 * 1024)), originalHash);
    report['sourceSha256'] = originalHash; report['sourcesUnchanged'] = true;
    const flag = (key: string): boolean => Boolean(report[key] && (report[key] as {exactIdentity?: unknown}).exactIdentity);
    report.status = report.cases.every((item: Record<string, unknown>) => item.status === 'passed') && flag('aacReseek') && flag('aacSelectedWindow') &&
      Boolean((report['aacSelectedWindow'] as {exactWholeWindowIdentity?: unknown}).exactWholeWindowIdentity) && flag('aacSeekSuffix') && flag('shortEmbeddedAudio') &&
      flag('shortEmbeddedSilentWindow') && Boolean((report['shortEmbeddedSilentWindow'] as {allSilent?: unknown}).allSilent) ? 'passed' : 'failed';
  } catch (error) {report.status = 'failed'; const failure = error as {name?: string; code?: string|null; message?: string}; report.error = {name: failure.name, code: failure.code ?? null, message: failure.message};}
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw Error('Supply existing numeric fixture directory and a fresh disposable output directory');
  const report = await runRenderOracle(process.argv[2], process.argv[3]); console.log(JSON.stringify(report, null, 2));
  if (report.status === 'failed') process.exitCode = 1;
}
