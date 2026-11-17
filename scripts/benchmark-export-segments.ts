import assert from 'node:assert/strict';
import {execFile, execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, mkdtempSync, readFileSync, realpathSync} from 'node:fs';
import {rm, stat} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {availableParallelism, cpus, loadavg, tmpdir, totalmem} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs, promisify} from 'node:util';
import {CLIP_TRANSITION_PROFILE} from '../packages/contracts/src/timeline-clip-transition.ts';
import {createPrivateTemporaryDirectory, ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';
import {TIMELINE_EXPORT_FLOAT_PROFILE_ID} from '../packages/contracts/src/timeline-export-float.ts';
import {TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID} from '../packages/contracts/src/timeline-subtitle-profile.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {freezeTimelineSnapshot} from '../packages/business/src/timeline-inputs.ts';

const width = 1080, height = 1920, fps = 30;
const date = '2026-01-01T00:00:00.000Z';
const id = (n: number) => '10000000-0000-4000-8000-' + n.toString().padStart(12, '0');
const baselineModules = ['timeline-media.ts', 'media-processes.ts', 'media-runtime.ts'] as const;
const sampleIntervalMs = 200;
const execute = promisify(execFile);
const round = (value: number) => Number(value.toFixed(2));
const fixtures = [
  {seconds: 15, clips: 5, segments: 5, secondsPerClip: 3, transitions: 0, subtitles: 0, colour: false},
  {seconds: 120, clips: 20, segments: 40, secondsPerClip: 6, transitions: 10, subtitles: 20, colour: true},
] as const;

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes as Buffer);
  return hash.digest('hex');
}

function source(root: string, index: number) {
  return path.join(root, `source-${index}.mp4`);
}

async function makeSources(root: string) {
  const {run} = await import('../packages/business/src/media.ts');
  // Two distinct moving, unambiguous Rec.709 sources with quiet dialogue-like
  // audio levels. Generate and probe them outside the measured render interval.
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

async function renderOne(root: string, output: string, fixture: typeof fixtures[number], baseline?: string, concurrency?: number) {
  // Preserve relative imports, the fixture contracts and real subtitle assets.
  // The render loop and the two process helpers changed by this PR come from
  // the old source at their original module URLs, before the worker loads them.
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
      ...(fixture.colour ? {colour: {profileId: 'mioon-rec709-sdr-clip-v1',
        source: {assetSha256: asset.sha256, streamIndex: asset.videoStreamIndex, profileId: 'rec709-yuv-sdr-v1',
          range: 'limited', declaredBy: 'user', declaredAt: date}, look: null}} : {}),
    };
  });
  const timeline = {
    id: id(1), projectId: id(2), revision: 1, width, height, fps, durationFrames, createdAt: date, updatedAt: date,
    tracks: [{id: trackId, kind: 'video', orderIndex: 0, hidden: false, muted: false}], clips,
    ...(fixture.subtitles ? {subtitles: {profileId: TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID, basisPresetId: 'portrait_1080',
      cues: clips.map((clip, i) => ({id: id(200 + i), startFrame: clip.startFrame + 8, durationFrames: 75,
        text: `第 ${i + 1} 幕\nSynthetic timeline`}))}} : {}),
  };
  const sources = new Map(assets.map(asset => [asset.id, asset]));
  const snapshot = freezeTimelineSnapshot(timeline, sources, {
    profileId: TIMELINE_EXPORT_FLOAT_PROFILE_ID, resolution: 'native', rateControl: {mode: 'crf', quality: 'standard'},
  });
  const {renderTimeline} = await import('../packages/business/src/timeline-media.ts');
  let segments = 0;
  const start = performance.now();
  await renderTimeline(snapshot, sources, output, {
    beforeEffect() {},
    beforeStart() {segments++;},
    ...(concurrency ? {segmentConcurrency: concurrency} : {}),
  });
  const seconds = (performance.now() - start) / 1000;
  assert.equal(segments, fixture.segments);
  console.log(JSON.stringify({seconds, segments}));
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

async function measure(root: string, fixture: typeof fixtures[number], baseline?: string, concurrency?: number) {
  const output = path.join(root, 'result.mp4');
  const startLoad1m = loadavg()[0]!;
  let peakLoad1m = startLoad1m, peakTreeKiB = 0, peakFfmpegProcesses = 0;
  const child = spawn('/usr/bin/time', ['-p', process.execPath, fileURLToPath(import.meta.url), '--worker',
    root, output, String(fixture.seconds), baseline ?? '', concurrency?.toString() ?? ''],
  {stdio: ['ignore', 'pipe', 'pipe'], env: {...mediaEnvironment(), LC_ALL: 'C',
    MIOON_FFMPEG_PATH: process.env.MIOON_FFMPEG_PATH, MIOON_FFPROBE_PATH: process.env.MIOON_FFPROBE_PATH}});
  const timer = setInterval(() => {
    // Sample the render worker and its tool processes in the same snapshot.
    if (child.pid) {
      const {rssKiB, ffmpeg} = sampleTree(child.pid);
      peakTreeKiB = Math.max(peakTreeKiB, rssKiB);
      peakFfmpegProcesses = Math.max(peakFfmpegProcesses, ffmpeg);
    }
    peakLoad1m = Math.max(peakLoad1m, loadavg()[0]!);
  }, sampleIntervalMs);
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {stdout += chunk;});
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {stderr += chunk;});
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject).once('close', resolve);
    });
    clearInterval(timer);
    assert.equal(code, 0, stderr.replaceAll(fileURLToPath(new URL('..', import.meta.url)), '<workspace>/')
      .replaceAll(root, '<scratch>'));
    const {seconds, segments} = JSON.parse(stdout) as {seconds: number; segments: number};
    const cpu = (key: string) => Number(new RegExp(`^${key} ([0-9.]+)$`, 'mu').exec(stderr)?.[1]);
    const user = cpu('user'), system = cpu('sys'), endLoad1m = loadavg()[0]!;
    assert.ok(Number.isFinite(user) && Number.isFinite(system) && peakTreeKiB > 0, 'CPU or process-tree RSS sample missing');
    return {seconds: round(seconds), segments, cpuUserSeconds: user, cpuSystemSeconds: system, peakFfmpegProcesses,
      avgCpuCores: round((user + system) / seconds), peakTreeRssMiB: round(peakTreeKiB / 1024),
      load1m: {start: round(startLoad1m), peak: round(Math.max(peakLoad1m, endLoad1m)), end: round(endLoad1m)},
      bytes: (await stat(output)).size, sha256: await sha256(output)};
  } finally {
    clearInterval(timer);
    await rm(output, {force: true});
  }
}

async function benchmark() {
  assert.equal(process.platform, 'darwin', 'This sampler is for macOS.');
  const {values} = parseArgs({options: {
    baseline: {type: 'string'}, runs: {type: 'string', default: '1'}, mode: {type: 'string', default: 'both'},
    concurrency: {type: 'string'}, 'download-release-tools': {type: 'boolean'},
  }});
  const {baseline, mode} = values, runs = Number(values.runs), concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency);
  assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 5);
  assert.ok(concurrency === undefined || Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4);
  assert.ok(mode === 'candidate' || (mode === 'baseline' || mode === 'both') && baseline,
    'Pass --baseline=<directory containing the old renderer and media process sources> or --mode=candidate.');
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-export-benchmark-'));
  try {
    if (values['download-release-tools']) {
      const {createMediaToolsInstaller, MEDIA_TOOLS_RELEASE, mediaToolsBuild} = await import('../apps/desktop/src/media-tools.ts');
      const {validateTools} = await import('../apps/desktop/src/config.ts');
      const build = mediaToolsBuild(MEDIA_TOOLS_RELEASE, process.platform, process.arch);
      assert.ok(build, 'No pinned media tools for this runner.');
      // Fetch the two pinned archives concurrently. The desktop installer still
      // checks compressed and uncompressed sizes and hashes before using them.
      const signal = AbortSignal.timeout(150_000);
      const downloads = await Promise.allSettled(Object.values(build).map(async ({file, bytes}) => {
        const url = new URL(file, MEDIA_TOOLS_RELEASE.baseUrl).href, archive = path.join(root, file);
        try {
          await execute('/usr/bin/curl', ['--disable', '--fail', '--silent', '--show-error', '--location',
            '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '10', '--max-time', '150',
            '--retry', '2', '--retry-max-time', '150', '--max-filesize', String(bytes), '--output', archive, '--', url],
          {env: mediaEnvironment(), signal});
        } catch (error) {
          const code = (error as {code?: unknown}).code;
          throw new Error(`Pinned ${file} download failed (curl ${typeof code === 'number' ? code : 'interrupted'})`);
        }
        return [url, archive] as const;
      }));
      const archives = new Map(downloads.map(result => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      }));
      const installer = createMediaToolsInstaller({
        root: path.join(root, 'media-tools'),
        fetch: async url => {
          const archive = archives.get(url);
          assert.ok(archive, 'The desktop installer requested an unpinned archive.');
          return new Response(new Uint8Array(readFileSync(archive)));
        },
        prepareRoot: directory => {ensurePrivateDirectory(directory, {create: true});},
        createStaging: directory => createPrivateTemporaryDirectory(directory, 'download-'),
        validate: (tools, signal) => validateTools(tools, {signal}),
        timeoutMs: 30_000,
      });
      const installed = await installer.install();
      if (!installed.ok) throw new Error(`Pinned media tools unavailable: ${installed.code}`);
      process.env.MIOON_FFMPEG_PATH = installed.paths.ffmpeg;
      process.env.MIOON_FFPROBE_PATH = installed.paths.ffprobe;
    }
    const {run} = await import('../packages/business/src/media.ts');
    const tool = (await run('ffmpeg', ['-version'], {timeout: 5_000})).split('\n')[0];
    await makeSources(root);
    const results = [];
    for (const fixture of fixtures) {
      const measurements: {variant: string; trial: number; metrics: Awaited<ReturnType<typeof measure>>}[] = [];
      for (let trial = 1; trial <= runs; trial++) {
        for (const variant of mode === 'both' ? ['baseline', 'candidate'] : [mode]) {
          const metrics = await measure(root, fixture, variant === 'baseline' ? baseline : undefined, variant === 'candidate' ? concurrency : undefined);
          const result = {variant, trial, metrics};
          console.error(JSON.stringify({fixture: fixture.seconds, ...result}));
          if (measurements[0]) assert.equal(metrics.sha256, measurements[0].metrics.sha256, 'The same fixture must render byte-for-byte.');
          measurements.push(result);
        }
      }
      results.push({fixture, measurements});
    }
    console.log(JSON.stringify({tool, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
      logicalCores: cpus().length, availableParallelism: availableParallelism(), memoryGiB: round(totalmem() / 2 ** 30),
      sampleIntervalMs, candidateConcurrencyOverride: concurrency ?? null, width, height, fps, results}, null, 2));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

if (process.argv[2] === '--worker') {
  const [, , , root, output, seconds, baseline, concurrency] = process.argv;
  const fixture = fixtures.find(item => item.seconds === Number(seconds));
  assert.ok(root && output && fixture);
  await renderOne(root, output, fixture, baseline || undefined, concurrency ? Number(concurrency) : undefined);
} else {
  await benchmark();
}
