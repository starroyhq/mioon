/** Explicit, serial-only media/browser fixture. No test runs on import.
 * Usage: node tests/fixtures/timeline-audio-preview/numeric-harness.ts /tmp/mioon-audio-numeric
 * Serves only generated synthetic fixtures at a fresh loopback port. Open printed
 * URL in real Chromium, click Run numeric checks, read #report, then stop server.
 * This does not claim a physical output device or subjective listening. */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { AUDIO_PREVIEW_PROFILE, audioPreviewPlanSchema, audioPreviewPlanDigestMaterial, buildAudioPreviewPlan } from '../../../packages/contracts/src/timeline-audio-preview.ts';
import { timelineCompositionSegments } from '../../../packages/contracts/src/timeline-segments.ts';
const exec = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url));
const hash = (value: Buffer|Uint8Array|string): string => createHash('sha256').update(value).digest('hex');
const id = (n: number): string => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ffmpeg = async (args: readonly string[]) => exec(process.env.MIOON_FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', ...args], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value as Record<string, unknown>).sort().map((k: string) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(value);
interface PlanClip {clipId: string; trackId: string; startFrame: number; durationFrames: number; sourceInFrame: number; gain: number; fadeInFrames: number; fadeOutFrames: number; muted?: boolean; [key: string]: unknown}
interface PlanSource {sourceKey: string; pcmBytes: number; decodeSegments: {frameCount: number}[]; sampleFrames: number; [key: string]: unknown}
function makePlan(name: string, range: readonly number[], clips: readonly Record<string, unknown>[], sourceHash: string, sourceBytes: number) {
  const sourceMap = new Map<string, PlanSource>(), sources: PlanSource[] = [], voices: PlanClip[] = [];
  const originals: PlanClip[] = clips.map((clip: Record<string, unknown>, index: number) => ({ clipId: id(index + 10), trackId: id(index + 30), startFrame: 0, durationFrames: 30,
    sourceInFrame: 0, gain: 1, fadeInFrames: 0, fadeOutFrames: 0, ...clip } as PlanClip));
  const audibleEnd = Math.max(0, ...originals.map(voice => voice.startFrame + voice.durationFrames)), timelineEnd = Math.max(range[1], audibleEnd);
  // Canonical cases ending at 90 contain a muted tail through frame 90. It
  // participates in global composition without adding a playable voice.
  const globalClips: (PlanClip|{startFrame: number; durationFrames: number; muted: boolean})[] = [...originals, ...(timelineEnd > audibleEnd ? [{ startFrame: audibleEnd, durationFrames: timelineEnd - audibleEnd, muted: true }] : [])];
  const composition = timelineCompositionSegments({ durationFrames: timelineEnd, clips: globalClips } as never);
  for (const voice of originals) {
    voice.intersectionStartFrame = Math.max(range[0], voice.startFrame); voice.intersectionEndFrame = Math.min(range[1], voice.startFrame + voice.durationFrames);
    if ((voice.intersectionEndFrame as number) <= (voice.intersectionStartFrame as number)) continue;
    const sourceInFrame = voice.sourceInFrame + (voice.intersectionStartFrame as number) - voice.startFrame, durationFrames = (voice.intersectionEndFrame as number) - (voice.intersectionStartFrame as number);
    const decodeSegments = composition.filter(segment => segment.beginFrame >= voice.startFrame && segment.endFrame <= voice.startFrame + voice.durationFrames)
      .flatMap(segment => {
        const from = Math.max(range[0], segment.beginFrame), to = Math.min(range[1], segment.endFrame);
        return from < to ? [{ sourceInFrame: voice.sourceInFrame + segment.beginFrame - voice.startFrame, frameCount: segment.endFrame - segment.beginFrame,
          trimStartFrame: from - segment.beginFrame, outputFrames: to - from }] : [];
      });
    const identity = { assetId: id(4), sourceHash, sourceInFrame, durationFrames, profileId: AUDIO_PREVIEW_PROFILE, decodeSegments };
    const sourceKey = hash(canonical(identity)); voice.sourceKey = sourceKey;
    if (!sourceMap.has(sourceKey)) {
      const sampleFrames = durationFrames * 1600;
      const source: PlanSource = { sourceKey, ...identity, clipId: voice.clipId, sampleFrames, pcmBytes: sampleFrames * 8, sourceBytes } as unknown as PlanSource;
      sourceMap.set(sourceKey, source); sources.push(source);
    }
    voices.push(voice);
  }
  const retainedPcmBytes = sources.reduce((n, s) => n + s.pcmBytes, 0), largestSourcePcmBytes = Math.max(0, ...sources.map(s => s.pcmBytes));
  const plan = audioPreviewPlanSchema.parse({ schemaVersion: 1, status: 'planned', profileId: AUDIO_PREVIEW_PROFILE, projectId: id(1), timelineId: id(2), timelineRevision: 1, planHash: '0'.repeat(64),
    range: { startFrame: range[0], endFrame: range[1], startSample: range[0] * 1600, endSample: range[1] * 1600, sampleFrames: (range[1] - range[0]) * 1600 }, sources, voices,
    memory: { retainedPcmBytes, largestSourcePcmBytes, transportReserveBytes: 2 * 1024 * 1024, admittedBytes: 2 * retainedPcmBytes + 2 * largestSourcePcmBytes + 2 * 1024 * 1024, hashReadBytes: sources.length * sourceBytes * 2 },
    work: { decodedSourceFrames: sources.reduce((total: number, source) => total + source.decodeSegments.reduce((n: number, segment) => n + segment.frameCount + 1, 0), 0),
      decodeSegments: sources.reduce((total: number, source) => total + source.decodeSegments.length, 0) } } as never);
  (plan as {planHash: string}).planHash = hash(audioPreviewPlanDigestMaterial(plan)); return plan as typeof plan & {planHash: string};
}
export async function prepareAudioPreviewNumericHarness(directory: string): Promise<Record<string, unknown>> {
  await mkdir(directory, { recursive: true });
  const original = path.join(directory, 'canonical.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'aevalsrc=0.35+0.1*sin(2*PI*440*t)|-0.27+0.06*cos(2*PI*733*t):s=48000:d=3', '-c:a', 'pcm_f32le', original]);
  const originalBytes = await readFile(original), sourceHash = hash(originalBytes), common = [
    { startFrame: 3, durationFrames: 60, sourceInFrame: 5, gain: .75, fadeInFrames: 12, fadeOutFrames: 15 },
    { startFrame: 18, durationFrames: 30, sourceInFrame: 20, gain: 1.3, fadeInFrames: 3, fadeOutFrames: 6 },
  ];
  interface NumericDescription {name: string; range: number[]; clips: Record<string, unknown>[]; cursor: number; expectOverOne?: boolean}
  const descriptions: NumericDescription[] = [
    { name: 'canonical-onset-end-overlap-fades', range: [0, 90], clips: common, cursor: 0 },
    { name: 'sample-precise-seek-inside-original-fade', range: [0, 90], clips: common, cursor: 8 * 1600 + 317 },
    { name: 'window-cut-through-original-fades', range: [10, 55], clips: [common[0]], cursor: 10 * 1600 },
    { name: 'float-headroom-exact-source-deduplication', range: [0, 30], clips: [{ gain: 2 }, { gain: 2 }], cursor: 0, expectOverOne: true },
    { name: 'silent-window-clock', range: [0, 15], clips: [], cursor: 0 },
  ];
  const manifest: {schemaVersion: number; input: {sampleRate: number; channels: number; format: string; sha256: string}; note: string; cases: unknown[]} = { schemaVersion: 1, input: { sampleRate: 48000, channels: 2, format: 'f32le', sha256: sourceHash },
    note: 'Actual FFmpeg independent float filter oracle, real Chromium production Web Audio graph. Above-one float summation is not parity with legacy s16 export; float-v2 rejects above-one. No listening claim.', cases: [] };
  const written = new Set();
  for (const description of descriptions) {
    const plan = makePlan(description.name, description.range, description.clips, sourceHash, originalBytes.length);
    for (const source of plan.sources) {
      const leaf = `${source.sourceKey}.f32`;
      if (!written.has(leaf)) {
        await ffmpeg(['-i', original, '-map', '0:a:0', '-af', `atrim=start_sample=${source.sourceInFrame * 1600}:end_sample=${(source.sourceInFrame + source.durationFrames) * 1600},asetpts=PTS-STARTPTS`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'f32le', path.join(directory, leaf)]);
        const bytes = await readFile(path.join(directory, leaf)); if (bytes.length !== source.pcmBytes) throw Error('Canonical source count mismatch'); written.add(leaf);
      }
    }
    const oracle = `${description.name}.f32`, end = plan.range.endSample, filters = [], inputArgs = [];
    for (const [index, voice] of plan.voices.entries()) {
      inputArgs.push('-i', original);
      const chain = [`atrim=start_sample=${voice.sourceInFrame * 1600}:end_sample=${(voice.sourceInFrame + voice.durationFrames) * 1600}`, 'asetpts=PTS-STARTPTS', `volume=${voice.gain}:precision=float`];
      if (voice.fadeInFrames) chain.push(`afade=t=in:ss=0:ns=${voice.fadeInFrames * 1600}`);
      if (voice.fadeOutFrames) chain.push(`afade=t=out:ss=${(voice.durationFrames - voice.fadeOutFrames) * 1600}:ns=${voice.fadeOutFrames * 1600}`);
      chain.push(`adelay=${voice.startFrame * 1600}S:all=1`); filters.push(`[${index}:a:0]${chain.join(',')}[voice${index}]`);
    }
    if (plan.voices.length) {
      filters.push(`${plan.voices.map((_, i) => `[voice${i}]`).join('')}amix=inputs=${plan.voices.length}:duration=longest:dropout_transition=0:normalize=0,apad=whole_len=${end},atrim=start_sample=${description.cursor}:end_sample=${end},asetpts=PTS-STARTPTS[out]`);
      await ffmpeg([...inputArgs, '-filter_complex', filters.join(';'), '-map', '[out]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'f32le', path.join(directory, oracle)]);
    } else await ffmpeg(['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-af', `atrim=end_sample=${end - description.cursor}`, '-c:a', 'pcm_f32le', '-f', 'f32le', path.join(directory, oracle)]);
    const oracleBytes = await readFile(path.join(directory, oracle)); if (oracleBytes.length !== (end - description.cursor) * 8) throw Error('Independent oracle sample count mismatch');
    (manifest.cases as unknown[]).push({ name: description.name, plan, cursorSample: description.cursor, oracle, oracleSha256: hash(oracleBytes), expectOverOne: Boolean(description.expectOverOne), absoluteTolerance: 0.000002 });
  }
  await writeFile(path.join(directory, 'fixtures.json'), JSON.stringify(manifest));
  await build({ entryPoints: [path.join(here, 'numeric-browser.ts')], outfile: path.join(directory, 'numeric-browser.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome120' });
  await writeFile(path.join(directory, 'capture-worklet.js'), await readFile(path.join(here, 'capture-worklet.js')));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Sound audition numeric proof</title><body><h1>Sound audition numeric proof</h1><p>Synthetic files, float pre-destination capture. No subjective listening claim.</p><button id="run">Run numeric checks</button><pre id="report">Not run</pre><script type="module" src="numeric-browser.js"></script></body></html>');
  return manifest;
}
/** A fixed real-HTTP capacity fixture. Five source identities share one
 * immutable 20-second stereo payload on this test server; no caller-controlled
 * path, source URL, decoder option, or source-sized allocation per request. */
function capacityHttpFixture() {
  const input = { projectId: id(1), timelineId: id(2), expectedRevision: 1, startFrame: 0 };
  const snapshot = {
    timeline: { id: input.timelineId, projectId: input.projectId, revision: 1, fps: 30, durationFrames: 600,
      tracks: Array.from({ length: 5 }, (_, index) => ({ id: id(10 + index), kind: 'audio', orderIndex: index, hidden: false, muted: false })),
      clips: Array.from({ length: 5 }, (_, index) => ({ id: id(30 + index), trackId: id(10 + index), assetId: id(3), startFrame: 0,
        durationFrames: 600, sourceInFrame: index * 600, gain: .2, fadeInFrames: 0, fadeOutFrames: 0 })),
    },
    assets: [{ id: id(3), projectId: input.projectId, sha256: 'c'.repeat(64), sizeBytes: 120 * 48000 * 8 + 44, mimeType: 'audio/wav', duration: 120, hasAudio: true }],
  };
  const plan = buildAudioPreviewPlan(input as never, snapshot as never, hash), pcm = Buffer.alloc(7_680_000);
  if (plan.sources.length !== 5 || plan.memory.admittedBytes !== 94_257_152) throw Error('Fixed capacity fixture admission changed');
  for (let offset = 0; offset < pcm.byteLength; offset += 8) { pcm.writeFloatLE(.125, offset); pcm.writeFloatLE(-.25, offset + 4); }
  return { plan, pcm };
}
export async function serveAudioPreviewNumericHarness(directory: string) {
  const capacity = capacityHttpFixture();
  const server = createServer(async (request, response) => {
    const capacityMatch = /^\/capacity-pcm\/([0-4])$/.exec(request.url || '');
    if (capacityMatch) {
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      const source = capacity.plan.sources[Number(capacityMatch[1])];
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(source.pcmBytes), 'Cache-Control': 'no-store',
        'X-Mioon-Audio-Profile': capacity.plan.profileId, 'X-Mioon-Audio-Plan-Hash': capacity.plan.planHash,
        'X-Mioon-Audio-Source-Hash': source.sourceHash, 'X-Mioon-Audio-Clip-Id': source.clipId, 'X-Mioon-Audio-Sample-Frames': String(source.sampleFrames),
        'X-Mioon-Test-Fixture': 'fixed-capacity-http-v1', 'X-Mioon-Test-Source-Allocation-Bytes': String(capacity.pcm.byteLength),
      });
      // One large write permits ordinary native Fetch coalescing. The browser
      // consumer must bound its own BYOB view, not assume network chunk sizes.
      response.end(capacity.pcm); return;
    }
    const leaf = request.url === '/' ? 'index.html' : request.url?.slice(1);
    if (!leaf || !/^[a-zA-Z0-9_.-]+$/.test(leaf)) { response.writeHead(404).end(); return; }
    try { const content = await readFile(path.join(directory, leaf)); response.writeHead(200, { 'Content-Type': leaf.endsWith('.js') ? 'text/javascript' : leaf.endsWith('.json') ? 'application/json' : leaf.endsWith('.html') ? 'text/html' : 'application/octet-stream', 'Cache-Control': 'no-store' }).end(content); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address(), port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/` };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Supply a disposable synthetic fixture directory');
  const directory = path.resolve(process.argv[2]); await prepareAudioPreviewNumericHarness(directory);
  const { server, url } = await serveAudioPreviewNumericHarness(directory); console.log(JSON.stringify({ url, directory, status: 'prepared-not-tested' }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
