// Reproducible acceptance benchmark for the application-wide encoder pool.
// Runs the same 2-minute synthetic export (colour, transitions, subtitles) in a
// worker process, either once or twice at the same time, and samples the process
// tree for peak RSS and live FFmpeg processes. `--baseline` points at the
// business sources from before the pool (extracted from a main checkout); the
// worker loads them instead of the current modules so both variants render the
// same fixture with the same installed media tools.
//
// Example (pinned app tools, baseline sources extracted from a main checkout):
//   MIOON_FFMPEG_PATH=<tools>/ffmpeg MIOON_FFPROBE_PATH=<tools>/ffprobe \
//     node scripts/benchmark-export-global-pool.ts --baseline <baseline-src-dir>
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, mkdtempSync, readFileSync, realpathSync} from 'node:fs';
import {rm, stat} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {availableParallelism, cpus, loadavg, tmpdir, totalmem} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {CLIP_TRANSITION_PROFILE} from '../packages/contracts/src/timeline-clip-transition.ts';
import {TIMELINE_EXPORT_FLOAT_PROFILE_ID} from '../packages/contracts/src/timeline-export-float.ts';
import {TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID} from '../packages/contracts/src/timeline-subtitle-profile.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {freezeTimelineSnapshot} from '../packages/business/src/timeline-inputs.ts';

const width = 1080, height = 1920, fps = 30;
const date = '2026-01-01T00:00:00.000Z';
const id = (n: number) => '10000000-0000-4000-8000-' + n.toString().padStart(12, '0');
// Only the changed modules are substituted for the baseline variant; the media
// process/runtime helpers are byte-identical between both revisions.
const baselineModules = ['timeline-media.ts', 'media.ts'] as const;
const sampleIntervalMs = 200;
const round = (value: number) => Number(value.toFixed(2));
const fixture = {seconds: 120, clips: 20, segments: 40, secondsPerClip: 6, transitions: 10, subtitles: 20, colour: true} as const;

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes as Buffer);
  return hash.digest('hex');
}

const source = (root: string, index: number) => path.join(root, `source-${index}.mp4`);

async function makeSources(root: string) {
  const {run} = await import('../packages/business/src/media.ts');
  // Two distinct moving, unambiguous Rec.709 sources with quiet dialogue-like
  // audio levels. Generated outside the measured render interval.
  for (const index of [0, 1]) {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-filter_threads', '1',
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}:duration=9`,
      '-f', 'lavfi', '-i', `sine=frequency=${index ? 293 : 440}:sample_rate=48000:duration=9`,
      ...(index ? ['-vf', 'hflip,hue=h=100'] : []),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-threads', '2', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
      '-c:a', 'aac', '-shortest', source(root, index)], {timeout: 90_000});
  }
}

async function buildRender(root: string) {
  const {probe} = await import('../packages/business/src/media.ts');
  const assets = await Promise.all([0, 1].map(async index => {
    const file = source(root, index), media = await probe(file);
    return {...media, id: id(10 + index), path: file, mimeType: 'video/mp4',
      relativePath: `media/source-${index}.mp4`, sha256: await sha256(file), colourProbe: media.probe};
  }));
  const trackId = id(3);
  const durationFrames = fixture.seconds * fps, duration = fixture.secondsPerClip * fps;
  const clips = Array.from({length: fixture.clips}, (_, i) => {
    const asset = assets[i % assets.length]!;
    return {
      id: id(100 + i), trackId, assetId: asset.id, startFrame: i * duration, durationFrames: duration,
      sourceInFrame: 15 + (i % 4) * 10, rect: {x: 0, y: 0, width, height}, gain: .75,
      ...(fixture.transitions && i % 2 === 1 ? {transitionIn: {profileId: CLIP_TRANSITION_PROFILE,
        kind: i % 4 === 1 ? 'dissolve' : 'wipeLeft', durationFrames: 18}} : {}),
      colour: {profileId: 'mioon-rec709-sdr-clip-v1',
        source: {assetSha256: asset.sha256, streamIndex: asset.videoStreamIndex, profileId: 'rec709-yuv-sdr-v1',
          range: 'limited', declaredBy: 'user', declaredAt: date}, look: null},
    };
  });
  const timeline = {
    id: id(1), projectId: id(2), revision: 1, width, height, fps, durationFrames, createdAt: date, updatedAt: date,
    tracks: [{id: trackId, kind: 'video', orderIndex: 0, hidden: false, muted: false}], clips,
    subtitles: {profileId: TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID, basisPresetId: 'portrait_1080',
      cues: clips.map((clip, i) => ({id: id(200 + i), startFrame: clip.startFrame + 8, durationFrames: 75,
        text: `第 ${i + 1} 幕\nSynthetic timeline`}))},
  };
  const sources = new Map(assets.map(asset => [asset.id, asset]));
  const snapshot = freezeTimelineSnapshot(timeline, sources, {
    profileId: TIMELINE_EXPORT_FLOAT_PROFILE_ID, resolution: 'native', rateControl: {mode: 'crf', quality: 'standard'},
  });
  return {snapshot, sources};
}

interface RenderObservation {seconds: number; segments: number; bytes: number; sha256: string}
async function renderOnce(root: string, snapshot: unknown, sources: unknown, output: string,
  {segmentConcurrency, signal}: {segmentConcurrency?: number; signal?: AbortSignal} = {}): Promise<RenderObservation> {
  const {renderTimeline} = await import('../packages/business/src/timeline-media.ts');
  let segments = 0;
  const start = performance.now();
  await renderTimeline(snapshot as never, sources as never, output, {
    beforeEffect() {},
    beforeStart() { segments += 1; },
    ...(segmentConcurrency ? {segmentConcurrency} : {}),
    ...(signal ? {signal} : {}),
  });
  assert.equal(segments, fixture.segments, 'every planned segment must encode exactly once');
  return {seconds: round((performance.now() - start) / 1000), segments, bytes: (await stat(output)).size, sha256: await sha256(output)};
}

async function worker(root: string, mode: 'single' | 'dual', baseline: string, outputs: string[], concurrency?: number) {
  if (baseline) {
    const old = new Map(baselineModules.map(name => [
      new URL(`../packages/business/src/${name}`, import.meta.url).href,
      readFileSync(path.join(baseline, name)),
    ]));
    registerHooks({
      load: (url, context, next) => {
        const source = old.get(url);
        return source ? {source, format: 'module-typescript', shortCircuit: true} : next(url, context);
      },
    });
  }
  const {snapshot, sources} = await buildRender(root);
  const start = performance.now();
  // Render-time export capability checks are deliberately one-at-a-time per
  // process (EXPORT_CAPABILITY_BUSY). Two real exports started from separate
  // windows are seconds apart; stagger the second worker the same way so the
  // measured overlap is the encoding phase, not the fixed capability probe.
  const renders = mode === 'single'
    ? [await renderOnce(root, snapshot, sources, outputs[0]!, {segmentConcurrency: concurrency})]
    : await (async () => {
        const first = renderOnce(root, snapshot, sources, outputs[0]!, {segmentConcurrency: concurrency});
        await new Promise(resolve => setTimeout(resolve, 1500));
        const second = renderOnce(root, snapshot, sources, outputs[1]!, {segmentConcurrency: concurrency});
        return Promise.all([first, second]);
      })();
  const wallSeconds = round((performance.now() - start) / 1000);
  const segmentSeconds = renders.map(render => render.seconds);
  console.log(JSON.stringify({mode, wallSeconds, renders, segmentSeconds}));
}

function sampleTree(rootPid: number) {
  const snapshot = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], {encoding: 'utf8'});
  const rows = snapshot.trim().split('\n').flatMap(line => {
    const row = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line.trim());
    return row ? [{pid: Number(row[1]), parent: Number(row[2]), rssKiB: Number(row[3]), ffmpeg: path.basename(row[4]!) === 'ffmpeg'}] : [];
  });
  const ids = new Set([rootPid]);
  while (true) {
    const count = ids.size;
    for (const {pid, parent} of rows) if (ids.has(parent)) ids.add(pid);
    if (ids.size === count) break;
  }
  const tree = rows.filter(row => ids.has(row.pid));
  return {rssKiB: tree.reduce((kb, row) => kb + row.rssKiB, 0), ffmpeg: tree.filter(row => row.ffmpeg).length};
}

interface Measurement {
  mode: 'single' | 'dual'; wallSeconds: number; peakTreeRssMiB: number; peakFfmpegProcesses: number;
  peakLoad1m: number; renders: RenderObservation[];
}
async function measure(root: string, mode: 'single' | 'dual', baseline: string, concurrency?: number): Promise<Measurement> {
  const outputs = mode === 'single' ? [path.join(root, 'result-single.mp4')] : [path.join(root, 'result-dual-a.mp4'), path.join(root, 'result-dual-b.mp4')];
  const spawnArgs = baseWorkerArguments(root, mode, baseline, outputs, concurrency);
  const child = spawn(process.execPath, spawnArgs, {stdio: ['ignore', 'pipe', 'pipe'], env: {...mediaEnvironment(), LC_ALL: 'C',
    MIOON_FFMPEG_PATH: process.env.MIOON_FFMPEG_PATH, MIOON_FFPROBE_PATH: process.env.MIOON_FFPROBE_PATH}});
  const startLoad1m = loadavg()[0]!, peakLoad1m = {value: startLoad1m};
  let peakTreeKiB = 0, peakFfmpegProcesses = 0;
  const timer = setInterval(() => {
    if (!child.pid) return;
    const {rssKiB, ffmpeg} = sampleTree(child.pid);
    peakTreeKiB = Math.max(peakTreeKiB, rssKiB);
    peakFfmpegProcesses = Math.max(peakFfmpegProcesses, ffmpeg);
    peakLoad1m.value = Math.max(peakLoad1m.value, loadavg()[0]!);
  }, sampleIntervalMs);
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {stdout += chunk;});
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {stderr += chunk;});
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject).once('close', resolve);
    });
    assert.equal(code, 0, stderr.replaceAll(fileURLToPath(new URL('..', import.meta.url)), '<workspace>/').replaceAll(root, '<scratch>'));
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!) as {mode: 'single' | 'dual'; wallSeconds: number; renders: RenderObservation[]};
    assert.equal(result.mode, mode);
    return {mode, wallSeconds: result.wallSeconds, peakTreeRssMiB: round(peakTreeKiB / 1024),
      peakFfmpegProcesses, peakLoad1m: round(peakLoad1m.value), renders: result.renders};
  } finally {
    clearInterval(timer);
    await Promise.all(outputs.map(output => rm(output, {force: true})));
  }
}

function baseWorkerArguments(root: string, mode: string, baseline: string, outputs: string[], concurrency?: number) {
  return [fileURLToPath(import.meta.url), '--worker', root, mode, baseline, ...outputs, concurrency?.toString() ?? ''];
}

async function benchmark() {
  assert.equal(process.platform, 'darwin', 'This sampler is for macOS.');
  const {values} = parseArgs({options: {
    baseline: {type: 'string'}, runs: {type: 'string', default: '1'}, 'segment-concurrency': {type: 'string'},
    modes: {type: 'string', default: 'both'},
  }});
  const {baseline} = values, runs = Number(values.runs);
  const concurrency = values['segment-concurrency'] === undefined ? undefined : Number(values['segment-concurrency']);
  assert.ok(baseline, 'Pass --baseline=<directory with the previous timeline-media.ts and media.ts>.');
  assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 5);
  assert.ok(concurrency === undefined || Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4);
  const modes: readonly ('single' | 'dual')[] | null = values.modes === 'both' ? ['single', 'dual']
    : values.modes === 'single' ? ['single'] : values.modes === 'dual' ? ['dual'] : null;
  assert.ok(modes, '--modes must be single, dual or both.');
  assert.ok(process.env.MIOON_FFMPEG_PATH && process.env.MIOON_FFPROBE_PATH, 'Point MIOON_FFMPEG_PATH/MIOON_FFPROBE_PATH at the installed media tools.');
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-export-global-pool-'));
  try {
    const {run} = await import('../packages/business/src/media.ts');
    const tool = (await run('ffmpeg', ['-version'], {timeout: 5_000})).split('\n')[0];
    await makeSources(root);
    const results: Array<{variant: string; mode: string; trial: number; metrics: Measurement}> = [];
    for (let trial = 1; trial <= runs; trial++) {
      for (const mode of modes) {
        for (const variant of ['baseline', 'candidate'] as const) {
          const metrics = await measure(root, mode, variant === 'baseline' ? baseline : '', concurrency);
          const entry = {variant, mode, trial, metrics};
          results.push(entry);
          console.error(JSON.stringify({...entry, metrics: {...metrics, renders: metrics.renders.map(render => ({...render, sha256: render.sha256.slice(0, 16)}))}}));
        }
      }
    }
    const hashes = new Map<string, string>();
    for (const entry of results) for (const render of entry.metrics.renders) {
      const key = render.sha256;
      hashes.set(`${entry.variant}-${entry.mode}`, key);
    }
    const unique = [...new Set([...hashes.values()])];
    assert.equal(unique.length, 1, 'every variant and mode must render the same bytes');
    console.log(JSON.stringify({tool, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
      logicalCores: cpus().length, availableParallelism: availableParallelism(), memoryGiB: round(totalmem() / 2 ** 30),
      sampleIntervalMs, segmentConcurrencyOverride: concurrency ?? null, fixture, outputSha256: unique[0], results}, null, 2));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

if (process.argv[2] === '--worker') {
  const [, , , root, mode, baseline, first, second, concurrency] = process.argv;
  assert.ok(root && (mode === 'single' || mode === 'dual'));
  await worker(root!, mode as 'single' | 'dual', baseline ?? '', mode === 'single' ? [first!] : [first!, second!], concurrency ? Number(concurrency) : undefined);
} else {
  await benchmark();
}
