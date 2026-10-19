import test from 'node:test';
import assert from 'node:assert/strict';
import {accessSync, constants, realpathSync} from 'node:fs';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {isExportPreflightResponse} from '@mioon/contracts';
import {
  createTimelineColourPlan, isTimelineColourSnapshot, timelineJpegMixedColourPlanSchema,
  TIMELINE_IMAGE_COMPOSITOR_INPUTS, TIMELINE_COLOUR_PREFLIGHT_MESSAGES,
} from '../packages/contracts/src/timeline-colour.ts';
import {timelineCompositionSegments} from '../packages/contracts/src/timeline-segments.ts';
import {freezeTimelineSnapshot, validateTimeline} from '../packages/business/src/timeline-inputs.ts';
import {planTimelineExportRange} from '../packages/business/src/timeline-export-range-plan.ts';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {probe} from '../packages/business/src/media.ts';
import {mediaExecutable} from '../packages/business/src/media-environment.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {createTimelinePreflightServices} from '../packages/business/src/timeline-preflight.ts';
import {openStore} from '../packages/business/src/db.ts';
import {snapshot as databaseSnapshot} from './workspace-schema26-fixtures.mjs';
import {png, sha, imageColour, stamp, timelineFixture} from './helpers/timeline-image-fixtures.ts';
import {pillowJfifFixture} from './helpers/timeline-jpeg-fixtures.ts';
import {jpegColour} from './helpers/timeline-jpeg-workflow-fixtures.ts';

const code = 'TIMELINE_IMAGE_COMPOSITOR_BUDGET';
const budgetError = {code, message: TIMELINE_COLOUR_PREFLIGHT_MESSAGES[code]};
interface TimelineClipView {id: string; startFrame: number; durationFrames: number; assetId: string; rect: {x: number; y: number; width: number; height: number}; colour: {source: unknown}; [key: string]: unknown}
interface TimelineTrackView {hidden: boolean; [key: string]: unknown}
interface TimelineView {clips: TimelineClipView[]; tracks: TimelineTrackView[]; durationFrames: number; [key: string]: unknown}
interface ConcurrencyAsset {id: string; projectId: string; name: string; mimeType: string; relativePath: string; sha256: string; sizeBytes: number; width: number; height: number; duration: null; hasVideo: boolean; hasAudio: boolean; provenance: string; createdAt: string}
interface FrozenPlan {colourPlan: {profileId?: string; clips: {clipId: string; kind?: string; sourceProfileId?: string}[]}; timeline: TimelineView; [key: string]: unknown}
interface ConcurrencyFixture {projectId: string; assets: ConcurrencyAsset[]; bytes: Buffer[]; evidence: Record<string, unknown>[]; timeline: TimelineView; hidden: number[]; freeze(extra?: unknown): FrozenPlan}
type Range = [number, number];
const intervals = (count: number): Range[] => Array.from({length: count}, (_, index) => [index * 3, 3]);

function fixture(ranges: Range[], {hidden = [], formats = ranges.map((_, index) => index % 2 ? 'jpeg' : 'png')}: {hidden?: number[]; formats?: string[]} = {}): ConcurrencyFixture {
  const projectId = randomUUID();
  const sampling = (index: number): string => ['444', '422', '420'][index % 3] ?? '420';
  const bytes = ranges.map((_, index) => formats[index] === 'jpeg' ? pillowJfifFixture(sampling(index)) :
    png({width: 8, height: 8, pixel: () => [32 + index * 7, 96, 160, 128]}));
  const assets = bytes.map((data, index) => {
    const id = randomUUID(), jpeg = formats[index] === 'jpeg';
    return {id, projectId, name: `${jpeg ? 'JFIF JPEG' : 'PNG'} ${index + 1}`,
      mimeType: jpeg ? 'image/jpeg' : 'image/png', relativePath: `media/${id}.${jpeg ? 'jpg' : 'png'}`,
      sha256: sha(data), sizeBytes: data.length, width: jpeg ? 17 : 8, height: jpeg ? 13 : 8,
      duration: null, hasVideo: true, hasAudio: false, provenance: 'user-import', createdAt: stamp};
  });
  const evidence = assets.map((asset, index) => ({profileId: formats[index] === 'jpeg' ? 'jfif-ycbcr8-srgb-v1' : 'png-rgb8-srgb-v1',
    sha256: asset.sha256, sourceByteLength: asset.sizeBytes, width: asset.width, height: asset.height,
    bitDepth: 8, alphaMode: formats[index] === 'jpeg' ? 'opaque' : 'straight', orientation: 1,
    colourTag: formats[index] === 'jpeg' ? 'untagged' : 'srgb',
    ...(formats[index] === 'jpeg' ? {sampling: sampling(index), decoderPolicy: 'ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1'} : {})}));
  const timeline = timelineFixture(assets, evidence.map((value, index) => formats[index] === 'jpeg' ? jpegColour(value) : imageColour(value)));
  timeline.clips.forEach((clip, index) => {
    [clip.startFrame, clip.durationFrames] = ranges[index];
    clip.rect = {x: (index % 6) * 96, y: Math.floor(index / 6) * 96, width: 96, height: 96};
  });
  timeline.tracks.forEach((track, index) => { track.hidden = hidden.includes(index); });
  timeline.durationFrames = Math.max(...ranges.map(([start, duration]) => start + duration));
  return {projectId, assets, bytes, evidence, timeline: timeline as unknown as TimelineView, hidden,
    freeze: (extra?: unknown) => freezeTimelineSnapshot(timeline as never, new Map(assets.map(asset => [asset.id, asset])) as never, undefined, extra as never) as unknown as FrozenPlan};
}

function simultaneous(snapshot: FrozenPlan, segment: {beginFrame: number; endFrame: number}): number {
  const images = new Set(snapshot.colourPlan.clips.filter((clip: {kind?: string}) => clip.kind === 'image').map((clip: {clipId: string}) => clip.clipId));
  return snapshot.timeline.clips.filter((clip: TimelineClipView) => images.has(clip.id) &&
    clip.startFrame <= segment.beginFrame && clip.startFrame + clip.durationFrames >= segment.endFrame).length;
}

async function directory(t: import('node:test').TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-jpeg-concurrency-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

async function materialize(root: string, f: ConcurrencyFixture): Promise<Map<string, Record<string, unknown>>> {
  await mkdir(path.join(root, 'media'), {recursive: true});
  const prepared = new Map<string, Record<string, unknown>>();
  for (const [index, asset] of f.assets.entries()) {
    const file = path.join(root, asset.relativePath);
    if (f.hidden.includes(index)) {
      // No hidden source file exists. This is deliberately stronger than only
      // checking the final compositor argv: staging cannot decode it either.
      prepared.set(asset.id, {...asset, path: file});
      continue;
    }
    await writeFile(file, f.bytes[index]);
    const media = await probe(file) as unknown as {probe: unknown};
    prepared.set(asset.id, {...asset, ...media, path: file,
      colourProbe: media.probe, colourImageEvidence: f.evidence[index]});
  }
  return prepared;
}

// Observe the actual production argv through the supported runtime setting.
// This shell only records NUL-delimited arguments, then execs the previously
// resolved trusted FFmpeg binary. No mock renderer, source edits or UI hooks.
async function recordFfmpeg(root: string, action: () => Promise<unknown>): Promise<string[][]> {
  const previous = process.env.MIOON_FFMPEG_PATH;
  const executable = mediaExecutable('ffmpeg');
  const candidates = path.isAbsolute(executable) ? [executable] :
    (process.env.PATH ?? '').split(path.delimiter).map(dir => path.resolve(dir, executable));
  const actual = candidates.find(file => {
    try { accessSync(file, constants.X_OK); return true; } catch { return false; }
  });
  assert.ok(actual, 'the production FFmpeg executable must be available');
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const marker = '__MIOON_FFMPEG_INVOCATION__';
  const log = path.join(root, 'ffmpeg-argv.bin'), wrapper = path.join(root, 'record-ffmpeg.sh');
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\0' ${quote(marker)} "$@" >> ${quote(log)}\nexec ${quote(realpathSync(actual))} "$@"\n`, {mode: 0o700});
  process.env.MIOON_FFMPEG_PATH = wrapper;
  try { await action(); }
  finally {
    if (previous === undefined) delete process.env.MIOON_FFMPEG_PATH;
    else process.env.MIOON_FFMPEG_PATH = previous;
  }
  const records: string[][] = [];
  for (const arg of (await readFile(log)).toString('utf8').split('\0').slice(0, -1)) {
    if (arg === marker) records.push([]);
    else { const last=records.at(-1); assert.ok(last); last.push(arg); }
  }
  return records;
}

test('the shared two-image budget admits PNG plus JPEG and rejects either format as the third input', () => {
  assert.equal(TIMELINE_IMAGE_COMPOSITOR_INPUTS, 2);
  const two = fixture([[0, 6], [0, 6]]), saved = two.freeze();
  assert.equal(saved.colourPlan.profileId, 'mioon-mixed-sdr-render-v3');
  assert.deepEqual(saved.colourPlan.clips.map(clip => clip.sourceProfileId), ['png-rgb8-srgb-v1', 'jfif-ycbcr8-srgb-v1']);
  assert.equal(isTimelineColourSnapshot(saved), true);
  for (const formats of [['png', 'jpeg', 'png'], ['png', 'jpeg', 'jpeg']] as string[][]) {
    const three = fixture([[0, 6], [0, 6], [0, 6]], {formats});
    assert.throws(() => createTimelineColourPlan(three.timeline, three.assets), budgetError);
  }
  assert.match(budgetError.message, /2/); assert.match(budgetError.message, /PNG 与 JPEG 合计/);
  assert.match(budgetError.message, /错开/); assert.match(budgetError.message, /隐藏/);
  assert.match(budgetError.message, /视频轨道上限不变/);
  // Reusing one JPEG source in two overlapping clips still requires two inputs.
  const reused = fixture([[0, 6], [0, 6], [0, 6]], {formats: ['png', 'jpeg', 'jpeg']});
  reused.timeline.clips[2].assetId = reused.assets[1].id;
  reused.timeline.clips[2]!.colour = jpegColour(reused.evidence[1] as never);
  assert.throws(() => createTimelineColourPlan(reused.timeline, reused.assets.slice(0, 2)), budgetError);
});

test('mixed-format interval accounting is end-exclusive and independent of source ordering', () => {
  const f = fixture([[0, 6], [0, 3], [3, 3]], {formats: ['png', 'jpeg', 'jpeg']});
  const saved = f.freeze();
  assert.deepEqual(timelineCompositionSegments(f.timeline), [
    {beginFrame: 0, endFrame: 3}, {beginFrame: 3, endFrame: 6},
  ]);
  assert.deepEqual(planTimelineExportRange(saved as never).segments.map((segment: {beginFrame: number; endFrame: number}) => simultaneous(saved, segment)), [2, 2]);
  f.timeline.clips.reverse(); assert.equal(f.freeze().colourPlan.clips.length, 3);
  const overlapClip=f.timeline.clips.find((clip: TimelineClipView) => clip.startFrame === 3);assert.ok(overlapClip);overlapClip.startFrame = 2;
  assert.throws(() => createTimelineColourPlan(f.timeline as never, f.assets as never), budgetError,
    'one genuinely overlapping frame is rejected, not rounded away');
});

for (const scenario of ['PNG plus JPEG with hidden PNG/JPEG', 'six nonoverlapping alternating sources']) {
  test(`production renderer opens only active combined image inputs: ${scenario}`,
    {timeout: 120000, skip: process.platform === 'win32' && 'POSIX argv recorder'}, async t => {
      const root = await directory(t), hiddenCase = scenario.startsWith('PNG plus');
      const f = hiddenCase ? fixture([[0, 6], [0, 6], [0, 6], [0, 6]], {hidden: [2, 3]}) : fixture(intervals(6));
      if (hiddenCase) {
        f.timeline.clips[2].colour.source = null;
        f.timeline.clips[3].colour.source = null;
      }
      const frozen = f.freeze(), expected = planTimelineExportRange(frozen as never).segments;
      assert.equal(frozen.colourPlan.profileId, 'mioon-mixed-sdr-render-v3');
      assert.equal(frozen.colourPlan.clips.length, hiddenCase ? 2 : 6);
      assert.equal(expected.length, hiddenCase ? 1 : 6);
      const prepared = await materialize(root, f), output = path.join(root, 'render.mp4');
      const calls = await recordFfmpeg(root, () => renderTimeline(frozen as never, prepared as never, output));
      const segments = calls.filter((args: string[]) => /^segment-\d{3}\.mov$/u.test(path.basename(String(args.at(-1)))));
      assert.equal(segments.length, expected.length, 'every production compositor segment is observed');
      const used = new Set();
      for (const [index, args] of segments.entries()) {
        const inputs = args.flatMap((arg: string, position: number) => arg === '-i' ? [String(args[position + 1])] : []);
        const expectedSegment=expected[index];assert.ok(expectedSegment);assert.equal(inputs.length, simultaneous(frozen, expectedSegment));
        assert.equal(inputs.length, hiddenCase ? 2 : 1);
        assert.ok(inputs.every((file: string) => path.extname(file) === '.png'), 'both formats become verified private RGBA layers');
        assert.ok(inputs.every((file: string) => !f.assets.some((asset: ConcurrencyAsset) => file === path.join(root, asset.relativePath))));
        inputs.forEach((file: string) => used.add(file));
      }
      assert.equal(used.size, hiddenCase ? 2 : 6, 'all sequential sources survive and hidden sources never become layers');
      const hiddenPaths = f.hidden.map((index: number) => path.join(root, String(f.assets[index]?.relativePath)));
      assert.equal(calls.some((args: string[]) => args.some((arg: string) => hiddenPaths.includes(arg))), false, 'even derivation never opens a hidden input');
      const jpegPaths = f.assets.filter((asset: ConcurrencyAsset, index: number) => asset.mimeType === 'image/jpeg' && !f.hidden.includes(index))
        .map((asset: ConcurrencyAsset) => path.join(root, asset.relativePath));
      for (const file of jpegPaths) assert.ok(calls.some((args: string[]) => args.includes(file) && args.includes('mjpeg')),
        'visible JPEG source uses the fixed software JPEG decoder during derivation');
      const probeResult = await probe(output) as unknown as {probe: {streams: {codec_type?: string; nb_frames?: string | number; width?: number; height?: number}[]}};
      const video = probeResult.probe.streams.find((stream: {codec_type?: string}) => stream.codec_type === 'video');
      assert.ok(video);assert.equal(Number(video.nb_frames), f.timeline.durationFrames);
      assert.equal(video.width, 720); assert.equal(video.height, 720);
      for (const [index, asset] of f.assets.entries()) if (!f.hidden.includes(index))
        assert.deepEqual(await readFile(path.join(root, asset.relativePath)), f.bytes[index]);
      assert.equal((await readdir(root)).some(name => name.startsWith('.timeline-')), false);
    });
}

test('preflight rejects a combined third image before probing or writes, even when the selected range is safe', async t => {
  const root = await directory(t), store = openStore(root);
  let probes = 0;
  const preflight = createTimelinePreflightServices(store as never, {probe: async () => { probes++; assert.fail('budget must fail before probe'); }} as never);
  t.after(async () => { await preflight.drain(); store.close(); });
  for (const formats of [['png', 'jpeg', 'png', 'jpeg'], ['png', 'jpeg', 'jpeg', 'png']] as string[][]) {
    const f = fixture(intervals(4), {formats});
    f.timeline.clips.slice(0, 3).forEach((clip: TimelineClipView) => { clip.startFrame = 0; });
    store.put('projects', {id: f.projectId, name: 'Combined image concurrency', createdAt: stamp, updatedAt: stamp} as never);
    f.assets.forEach((asset: ConcurrencyAsset) => store.put('assets', asset as never)); store.put('timelines', f.timeline as never);
    const before = databaseSnapshot(store.db), changes = (store.db.prepare('SELECT total_changes() AS n').get() as {n: number}).n;
    for (const extra of [{}, {exportRange: {startFrame: 9, endFrame: 12}}]) {
      const input = {projectId: f.projectId, expectedRevision: 1, ...extra};
      const report = await (preflight.handlers['timeline.export.preflight'] as unknown as (value: Record<string, unknown>) => Promise<{status?: string; issues?: unknown[]; checks?: {checkedAssets?: number; bytesHashed?: number}}>)(input);
      assert.equal(isExportPreflightResponse(report, input), true);
      assert.equal(report.status, 'blocked'); assert.deepEqual(report.issues, [{...budgetError, severity: 'error'}]);
      assert.equal(report.checks?.checkedAssets, 0); assert.equal(report.checks?.bytesHashed, 0);
    }
    assert.equal(probes, 0); assert.equal((store.db.prepare('SELECT total_changes() AS n').get() as {n: number}).n, changes);
    assert.deepEqual(databaseSnapshot(store.db), before);
  }
});

test('renderer independently rejects an over-budget mixed snapshot before decoding or staging', async t => {
  const root = await directory(t), f = fixture(intervals(4));
  const frozen = f.freeze({exportRange: {startFrame: 9, endFrame: 12}});
  frozen.timeline.clips.slice(0, 3).forEach((clip: TimelineClipView) => { clip.startFrame = 0; });
  assert.equal(timelineJpegMixedColourPlanSchema.safeParse(frozen.colourPlan).success, true,
    'the JPEG-capable frozen plan is structurally valid; concurrency is the rejected condition');
  const selected = planTimelineExportRange(frozen as never);
  assert.equal(selected.segments.length, 1); const firstSegment=selected.segments[0];assert.ok(firstSegment);assert.equal(simultaneous(frozen, firstSegment), 1);
  assert.equal(isTimelineColourSnapshot(frozen), false);
  const prepared = new Map(f.assets.map((asset: ConcurrencyAsset) => [asset.id, {...asset, path: path.join(root, asset.relativePath)}]));
  assert.doesNotThrow(() => validateTimeline(frozen.timeline as never, prepared as never));
  const events: unknown[] = [], off = onMediaProcess((event: unknown) => { events.push(event); });
  try { await assert.rejects(renderTimeline(frozen as never, prepared as never, path.join(root, 'invalid.mp4')), budgetError); }
  finally { off(); }
  assert.deepEqual(events, [], 'whole-plan admission precedes all local decoder and compositor processes');
  assert.deepEqual(await readdir(root), [], 'no staging or output was created');
});
