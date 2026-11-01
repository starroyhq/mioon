import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID, createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createClient} from '@mioon/client';
import {EXPORT_LOUDNESS_PROFILE, isExportLoudnessResponse} from '@mioon/contracts/export-loudness';
import {startServer} from '../apps/server/src/index.ts';
import type {InspectProject} from '../apps/server/src/index.ts';
import {mediaEnvironment, mediaExecutable} from '../packages/business/src/media-environment.ts';
import {run, runStreaming, checkMediaEffect} from '../packages/business/src/media-runtime.ts';
import {withProbePermit} from '../packages/business/src/media-probe.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {createExportLoudnessDecoder} from '../packages/business/src/export-loudness-decoder.ts';
import {floatSnapshotSha256} from '../packages/business/src/timeline-float-outcome.ts';
import {schemaObjects} from './helpers/project-database.ts';

// These bounded real-media fixtures run only in the parent-owned serial lane.
// FFmpeg ebur128 is an independent implementation comparison, not certification.
type ExecResult = {stdout: string | Buffer; stderr: string | Buffer};
const execute = promisify(execFile) as unknown as (file: string, args: readonly string[], options: {cwd?: string; env?: Record<string, string>; encoding?: 'utf8' | 'buffer'; timeout?: number; maxBuffer?: number}) => Promise<ExecResult>;
const token = 'synthetic-export-loudness-media-token';
const repo = fileURLToPath(new URL('..', import.meta.url));
const clientEnvironment = (url: string): Record<string, string> => ({...mediaEnvironment(), MIOON_BASE_URL: url, MIOON_TOKEN: token, MIOON_ENABLE_LIVE_PROVIDER: '0'});
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const options = () => ({beforeEffect() {}, remainingMs: () => 120000});
const decode = createExportLoudnessDecoder({run, runStreaming, checkMediaEffect, withProbePermit});
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {return await Promise.race([promise, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(Error(label + ' timed out')), 20000);})]);}
  finally {clearTimeout(timer);}
}
async function cli(url: string, input: Record<string, unknown>) {
  const {stdout} = await execute(process.execPath, [path.join(repo, 'apps/cli/src/index.ts'), 'timeline', 'export', 'loudness', '--input', JSON.stringify(input)],
    {cwd: repo, env: clientEnvironment(url), encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024});
  const text = String(stdout);
  assert.equal(text.trim().split('\n').length, 1); assert.ok(!text.includes(token));
  const body = JSON.parse(text) as {ok: boolean; data: unknown}; assert.equal(body.ok, true, text); return body.data;
}
async function official(t: TestContext, url: string): Promise<(input: Record<string, unknown>) => Promise<unknown>> {
  const client = new Client({name: 'export-loudness-real-service', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')], cwd: repo,
    env: clientEnvironment(url), stderr: 'ignore'});
  t.after(() => bounded(client.close(), 'MCP close')); await bounded(client.connect(transport), 'MCP connect');
  return async input => {
    const result = await client.callTool({name: 'timeline_export_loudness', arguments: input}, undefined, {timeout: 20000});
    const blocks = (result.content as Array<{type: string; text: string}>).filter(block => block.type === 'text'); assert.equal(blocks.length, 1);
    const body = JSON.parse(blocks[0].text) as {ok: boolean; data: unknown}; assert.deepEqual(result.structuredContent, body); assert.equal(Boolean(result.isError), false); assert.equal(body.ok, true);
    assert.ok(!JSON.stringify(body).includes(token)); return body.data;
  };
}
function png() {
  const chunk = (name: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const byte of body) {crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);}
    const head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(16 * 49, 90); for (let row = 0; row < 16; row++) rows[row * 49] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function wav(seconds: number, sample: (frame: number, channel: number, rate: number) => number, rate = 48000, channels = 2) {
  const frames = Math.round(seconds * rate), bytes = Buffer.alloc(44 + frames * channels * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 4, 28); bytes.writeUInt16LE(channels * 4, 32); bytes.writeUInt16LE(32, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++)
    bytes.writeFloatLE(sample(frame, channel, rate), 44 + (frame * channels + channel) * 4);
  return bytes;
}
async function manifest(root: string, relative = ''): Promise<Array<{directory?: string; file?: string; sha256?: string}>> {
  const result: Array<{directory?: string; file?: string; sha256?: string}> = [];
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push({directory: name}, ...await manifest(root, name));
    else if (!/^workbench\.sqlite(?:-wal|-shm|-journal)?$/.test(name) && name !== 'server.lock') result.push({file: name, sha256: hash(await readFile(path.join(root, name)))});
  }
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function independentReference(file: string): Promise<{sampleFrames: number; samplePeak: number; integratedLufs: number; truePeakDbtp: number}> {
  const exec = (args: readonly string[], encoding: 'utf8' | 'buffer', maxBuffer: number): Promise<ExecResult> => execute(mediaExecutable('ffmpeg'), args, {env: mediaEnvironment(), encoding, maxBuffer, timeout: 30000});
  // Binary PCM is never UTF-8 decoded. The separate bounded collector checks
  // natural-EOF frame count and exact sample maximum independently of reducers.
  const {stdout: bytesOut} = await exec(['-v', 'error', '-nostdin', '-threads', '1', '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], 'buffer', 4 * 1024 * 1024);
  const bytes = bytesOut as Buffer;
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0); assert.equal(bytes.length % 8, 0);
  let samplePeak = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const sample = bytes.readFloatLE(offset); assert.ok(Number.isFinite(sample)); samplePeak = Math.max(samplePeak, Math.abs(sample));
  }
  const {stderr: stderrOut} = await exec(['-hide_banner', '-nostats', '-loglevel', 'info', '-nostdin', '-threads', '1', '-i', file,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], 'utf8', 1024 * 1024);
  const stderr = String(stderrOut);
  const integrated = [...stderr.matchAll(/\bI:\s*(-?\d+(?:\.\d+)?) LUFS/gu)].at(-1);
  const peak = [...stderr.matchAll(/Peak:\s*(-?(?:\d+(?:\.\d+)?|inf)) dBFS/gu)].at(-1);
  assert.ok(integrated && peak, 'Expected bounded ebur128 summary');
  return {sampleFrames: bytes.length / 8, samplePeak, integratedLufs: Number(integrated[1]), truePeakDbtp: Number(peak[1])};
}
const encode = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-threads', '1', '-filter_threads', '1', ...args],
  {timeout: 30000, maxStdoutBytes: 0, maxStderrBytes: 65536});

interface LoudnessMeasurement {sampleRate: number; channels: number; state: string; sampleFrames: number; samplePeakLinear: number; integratedLufs: number; truePeakDbtp: number; samplePeakDbfs: number; gatingBlockCount: number; absoluteGatedBlockCount: number; relativeGatedBlockCount: number}
interface LoudnessReport {status: string; reason?: {message?: string}; measurement: LoudnessMeasurement; suggestion: {applyAllowed: boolean; currentTimelineValidated: boolean} | null;
  artifact: {hidden: never} & {snapshotSha256: string; sha256: string; timelineRevision: number; deliveryName: string; exportRange?: {startFrame: number; endFrame: number}}; checks: {bytesHashed: number; audioFullyDecoded: boolean}}
interface TimelineRow {id: string; revision: number; tracks: Array<{id: string; kind: string}>}
interface ExportRecordRow {id: string; assetId: string; status: string; timelineRevision: number; error?: unknown}
interface ExportFixture {root: string; url: string; client: ReturnType<typeof createClient>; project: {id: string}; use<T>(fn: (db: DatabaseSync) => T): T; rows(): Record<string, unknown[]>; records: ExportRecordRow[]}
// data_version counts other connections' commits only; total_changes() adds this connection's own writes.
const changeMarks = (db: DatabaseSync) => [db.prepare('PRAGMA data_version').get()!.data_version, db.prepare('SELECT total_changes() AS n').get()!.n];
async function exported(t: TestContext, {name, silent = false}: {name: string; silent?: boolean}): Promise<ExportFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-loudness-real-service-')); let backend: Awaited<ReturnType<typeof startServer>> | undefined, inspect: InspectProject | undefined;
  t.after(async () => {await backend?.close(); await rm(root, {recursive: true, force: true});});
  backend = await startServer({dataDir: root, port: 0, token, inspectProject: received => {inspect = received;}});
  const client = createClient({env: clientEnvironment(backend.url)});
  const project = await client.rpc('project.create', {name}) as {id: string}; let timeline = await client.rpc('timeline.get', {projectId: project.id}) as TimelineRow;
  const pixels = await client.rpc('asset.import', {projectId: project.id, name: 'Synthetic pixels.png', mimeType: 'image/png', dataBase64: png().toString('base64')}) as {id: string};
  timeline = await client.rpc('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks.find(track => track.kind === 'video')!.id, assetId: pixels.id, startFrame: 0, durationFrames: 90});
  if (!silent) {
    const sound = wav(3, (frame, channel, rate) => {
      const time = frame / rate, amplitude = time < 1 ? 0.2 : time < 2 ? 0.00001 : 0.1;
      return (channel ? -1 : 1) * amplitude * Math.sin(2 * Math.PI * 997 * time);
    }, 44100);
    const source = await client.rpc('asset.import', {projectId: project.id, name: 'Synthetic 44.1k gated stereo.wav', mimeType: 'audio/wav', dataBase64: sound.toString('base64')}) as {id: string};
    timeline = await client.rpc('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
      trackId: timeline.tracks.find(track => track.kind === 'audio')!.id, assetId: source.id, startFrame: 0, durationFrames: 90});
  }
  async function render(exportRange?: {startFrame: number; endFrame: number}): Promise<ExportRecordRow> {
    const queued = await client.rpc('timeline.render', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export',
      deliveryName: exportRange ? '选区响度文件' : '完整响度文件', ...(exportRange ? {exportRange} : {})}) as {id: string};
    let record: ExportRecordRow | undefined; const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      record = await client.rpc('export.get', {exportId: queued.id}) as ExportRecordRow;
      if (['succeeded', 'failed'].includes(record.status)) break;
      await pause(25);
    }
    assert.equal(record?.status, 'succeeded', JSON.stringify(record?.error)); return record!;
  }
  const full = await render(), ranged = silent ? null : await render({startFrame: 30, endFrame: 90});
  // A later editable revision is deliberately outside this file observation.
  timeline = await client.rpc('timeline.track.update', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks.find(track => track.kind === 'audio')!.id, patch: {muted: true}}) as TimelineRow;
  // While the server runs, the database is read on its own connection.
  const use = <T>(fn: (db: DatabaseSync) => T): T => inspect!(project.id, fn);
  const rows = (): Record<string, unknown[]> => use(db => Object.fromEntries(schemaObjects(db).filter(({type}) => type === 'table').map(({name}) =>
    [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()])));
  return {root, url: backend!.url, client, project, use, rows, records: [full, ranged].filter((value): value is ExportRecordRow => Boolean(value))};
}

test('real worker full/ranged AAC from 44.1k sources matches independent complete PCM and ebur128 without any observation writes', {timeout: 120000}, async t => {
  const f = await exported(t, {name: '44.1k delivery loudness'});
  for (const record of f.records) {
    const saved = JSON.parse(f.use(db => db.prepare('SELECT data FROM exports WHERE id=?').get(record.id) as {data: string}).data) as {snapshot: {deliveryName: string; exportRange?: {startFrame: number; endFrame: number}}};
    const asset = JSON.parse(f.use(db => db.prepare('SELECT data FROM assets WHERE id=?').get(record.assetId) as {data: string}).data) as {relativePath: string};
    const file = path.join(f.root, asset.relativePath), sourceBytes = await readFile(file), reference = await independentReference(file);
    const input = {projectId: f.project.id, exportId: record.id, expectedArtifactSha256: hash(sourceBytes), measurementProfile: EXPORT_LOUDNESS_PROFILE,
      target: {integratedLufs: -23, truePeakCeilingDbtp: -1}};
    const before = {rows: f.rows(), version: f.use(changeMarks), files: await manifest(f.root)};
    const events: Array<{type: string; kind: string}> = [], off = onMediaProcess(event => events.push(event as {type: string; kind: string})); let report: LoudnessReport;
    try {report = await f.client.rpc('timeline.export.loudness', input) as unknown as LoudnessReport;} finally {off();}
    assert.ok(isExportLoudnessResponse(report as unknown, input)); assert.equal(report.status, 'ready', JSON.stringify(report.reason));
    assert.equal(report.measurement.sampleRate, 48000); assert.equal(report.measurement.channels, 2); assert.equal(report.measurement.state, 'valid');
    assert.equal(report.measurement.sampleFrames, reference.sampleFrames); assert.equal(report.measurement.samplePeakLinear, reference.samplePeak);
    assert.ok(Math.abs(report.measurement.integratedLufs - reference.integratedLufs) <= 0.11, JSON.stringify({actual: report.measurement.integratedLufs, reference: reference.integratedLufs}));
    // FFmpeg's independent SWR peak and its one-decimal summary differ from
    // this fixed Annex-2 FIR; this is a bounded cross-check, not a safety proof.
    assert.ok(Math.abs(report.measurement.truePeakDbtp - reference.truePeakDbtp) <= 0.6, JSON.stringify({actual: report.measurement.truePeakDbtp, reference: reference.truePeakDbtp}));
    assert.ok(report.measurement.absoluteGatedBlockCount < report.measurement.gatingBlockCount);
    assert.equal(report.artifact.snapshotSha256, floatSnapshotSha256(saved.snapshot)); assert.equal(report.artifact.sha256, hash(sourceBytes));
    assert.equal(report.artifact.timelineRevision, record.timelineRevision); assert.equal(report.artifact.deliveryName, saved.snapshot.deliveryName);
    assert.equal(Object.hasOwn(report.artifact, 'exportRange'), Object.hasOwn(saved.snapshot, 'exportRange'));
    if (report.artifact.exportRange) assert.deepEqual(report.artifact.exportRange, {startFrame: 30, endFrame: 90});
    assert.deepEqual(report.checks, {bytesHashed: 2 * sourceBytes.length, audioFullyDecoded: true});
    assert.equal(report.suggestion!.applyAllowed, false); assert.equal(report.suggestion!.currentTimelineValidated, false);
    assert.deepEqual(events.filter(e => e.type === 'started').map(e => e.kind), ['ffprobe', 'ffmpeg']);
    if (record === f.records[0]) {
      const mcp = await official(t, f.url), comparable = (value: LoudnessReport): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'checkedAt'));
      for (const [channel, actual] of [['CLI', await cli(f.url, input)], ['MCP', await mcp(input)]] as const) {
        assert.ok(isExportLoudnessResponse(actual as unknown, input), channel); assert.deepEqual(comparable(actual as LoudnessReport), comparable(report), channel);
      }
    }
    assert.deepEqual(f.rows(), before.rows); assert.deepEqual(f.use(changeMarks), before.version);
    assert.deepEqual(await manifest(f.root), before.files); assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 8192);
    t.diagnostic(JSON.stringify({range: report.artifact.exportRange ?? null, frames: report.measurement.sampleFrames,
      integratedLufs: report.measurement.integratedLufs, referenceLufs: reference.integratedLufs, truePeakDbtp: report.measurement.truePeakDbtp, referenceTruePeakDbtp: reference.truePeakDbtp}));
  }
});

test('actual worker silent export remains digital silence with no finite LUFS or gain recommendation', {timeout: 60000}, async t => {
  const f = await exported(t, {name: 'Silent delivery loudness', silent: true}), record = f.records[0];
  const asset = JSON.parse(f.use(db => db.prepare('SELECT data FROM assets WHERE id=?').get(record.assetId) as {data: string}).data) as {sha256: string};
  const before = {rows: f.rows(), version: f.use(changeMarks), files: await manifest(f.root)};
  const report = await f.client.rpc('timeline.export.loudness', {projectId: f.project.id, exportId: record.id,
    expectedArtifactSha256: asset.sha256, measurementProfile: EXPORT_LOUDNESS_PROFILE, target: {integratedLufs: -23, truePeakCeilingDbtp: -1}}) as unknown as LoudnessReport;
  assert.equal(report.status, 'ready'); assert.equal(report.measurement.state, 'digital_silence');
  assert.equal(report.measurement.integratedLufs, null); assert.equal(report.measurement.truePeakDbtp, null); assert.equal(report.suggestion, null);
  assert.deepEqual(f.rows(), before.rows); assert.deepEqual(f.use(changeMarks), before.version); assert.deepEqual(await manifest(f.root), before.files);
});

test('real strict decoder rejects no-audio, nonnative and ambiguous files without inventing silence', {timeout: 60000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-loudness-format-')); t.after(() => rm(root, {recursive: true, force: true}));
  const noAudio = path.join(root, 'no-audio.mp4'), rate44100 = path.join(root, '44100.mp4'), multiple = path.join(root, 'multiple.mp4');
  await encode(['-f', 'lavfi', '-i', 'color=s=16x16:r=30:d=0.5', '-c:v', 'libx264', '-threads', '1', noAudio]);
  await encode(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=0.5', '-c:a', 'aac', '-threads', '1', rate44100]);
  await encode(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=0.5', '-map', '0:a:0', '-map', '0:a:0', '-c:a', 'aac', '-threads', '1', multiple]);
  const before = await manifest(root);
  for (const [file, code] of [[noAudio, 'LOUDNESS_NO_AUDIO'], [rate44100, 'LOUDNESS_UNSUPPORTED_FORMAT'], [multiple, 'LOUDNESS_UNSUPPORTED_FORMAT']] as const) {
    const events: Array<{type: string; kind: string}> = [], off = onMediaProcess(event => events.push(event as {type: string; kind: string}));
    try {await assert.rejects(decode(file, 0.5, options()), {code});} finally {off();}
    assert.deepEqual(events.filter(e => e.type === 'started').map(e => e.kind), ['ffprobe']);
  }
  assert.deepEqual(await manifest(root), before);
});

test('real encoded intersample programme preserves native sample peaks and cross-checks estimated true peak', {timeout: 60000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-loudness-truepeak-')); t.after(() => rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'intersample.wav'), file = path.join(root, 'intersample.mp4');
  await writeFile(source, wav(1, (frame, channel) => (channel ? -1 : 1) * 0.9 * Math.sin(Math.PI / 2 * frame + Math.PI / 4)));
  await encode(['-i', source, '-c:a', 'aac', '-b:a', '256k', '-threads', '1', file]);
  const reference = await independentReference(file), before = await manifest(root), result = await decode(file, 1, options()) as Awaited<ReturnType<typeof decode>> & {truePeakDbtp: number; samplePeakDbfs: number};
  assert.equal(result.sampleFrames, reference.sampleFrames); assert.equal(result.samplePeakLinear, reference.samplePeak);
  assert.ok(result.truePeakDbtp > result.samplePeakDbfs + 0.5, 'The complete encoded fixture must exercise intersample reconstruction');
  assert.ok(Math.abs(result.truePeakDbtp - reference.truePeakDbtp) <= 0.6);
  assert.deepEqual(await manifest(root), before);
  t.diagnostic(JSON.stringify({samplePeakDbfs: result.samplePeakDbfs, truePeakDbtp: result.truePeakDbtp, referenceTruePeakDbtp: reference.truePeakDbtp}));
});
