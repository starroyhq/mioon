import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { startServer } from '../apps/server/src/index.ts';
import { run } from '../packages/business/src/media-runtime.ts';
import { TIMELINE_EXPORT_DEFAULT_SETTINGS, isTimelineRenderRecord } from '@mioon/contracts';
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function tone() {
  const rate = 48000, frames = rate * 4, bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(0.1 * 32767 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return bytes;
}
test('real checked sample and full export preserve timeline and exact receipt while preview route serves decodable MP4', { timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-export-preview-real-'));
  interface Project {id: string} interface AssetRef {id: string}
  interface Timeline {revision: number; tracks: {id: string; kind: string}[]; clips: unknown[]}
  interface Capability {status: string} interface Preflight {status: string; snapshotHash: string}
  interface Receipt {id: string} interface ExportRecord {status: string; assetId: string; id: string; error?: unknown}
  let backend: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { await backend?.close(); await rm(root, { recursive: true, force: true }); });
  const png = path.join(root, 'synthetic.png');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'color=c=0x1b7194:s=64x64', '-frames:v', '1', '-threads', '1', png], { timeout: 20000, maxStdoutBytes: 0, maxStderrBytes: 65536 });
  backend = await startServer({ dataDir: path.join(root, 'store'), port: 0, chatGateway: async function* () { assert.fail('No provider calls permitted'); } });
  const server = backend;
  async function rpc<T>(operation: string, input: Record<string, unknown>): Promise<T> {
    const response = await fetch(server.url + '/api/rpc', { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation, input }), signal: AbortSignal.timeout(30000) });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.ok(body.ok); return body.data;
  }
  const project = await rpc<Project>('project.create', { name: 'Synthetic sample export acceptance' });
  const image = await rpc<AssetRef>('asset.import', { projectId: project.id, name: 'Generated color.png', mimeType: 'image/png', dataBase64: (await readFile(png)).toString('base64') });
  const audio = await rpc<AssetRef>('asset.import', { projectId: project.id, name: 'Generated 440 Hz.wav', mimeType: 'audio/wav', dataBase64: tone().toString('base64') });
  let timeline = await rpc<Timeline>('timeline.get', { projectId: project.id });
  for (const [asset, kind] of [[image, 'video'], [audio, 'audio']] as const) timeline = await rpc<Timeline>('timeline.clip.add', { projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), trackId: timeline.tracks.find(track => track.kind === kind)!.id, assetId: asset.id, startFrame: 0, durationFrames: 120 });
  const original = structuredClone(timeline), exportSettings = { ...TIMELINE_EXPORT_DEFAULT_SETTINGS, resolution: 'short_360' }, proofs = [];
  for (const [name, exportRange, frames] of [['sample', { startFrame: 30, endFrame: 90 }, 60], ['whole', undefined, 120]]) {
    const base = { projectId: project.id, expectedRevision: timeline.revision, exportSettings, ...(exportRange ? { exportRange } : {}) };
    const capability = await rpc<Capability>('timeline.export.capabilities', { projectId: project.id, expectedRevision: timeline.revision, exportSettings }); assert.equal(capability.status, 'available');
    const checked = await rpc<Preflight>('timeline.export.preflight', base); assert.equal(checked.status, 'ready', JSON.stringify(checked));
    const input = { ...base, requestId: randomUUID(), purpose: 'export', preflightSnapshotHash: checked.snapshotHash };
    const receipt = await rpc<Receipt>('timeline.render', input); assert.ok(isTimelineRenderRecord(receipt, input));
    let record: ExportRecord | undefined;
    for (const deadline = Date.now() + 60000; Date.now() < deadline;) {
      record = await rpc<ExportRecord>('export.get', { exportId: receipt.id }); if (['succeeded', 'failed'].includes(record.status)) break; await pause(50);
    }
    assert.equal(record?.status, 'succeeded', JSON.stringify(record?.error)); assert.ok(isTimelineRenderRecord(record, { ...input, exportId: receipt.id }));
    assert.deepEqual(await rpc('timeline.render', input), receipt, 'exact recovery is immutable and does not start another export');
    assert.deepEqual(await rpc('timeline.get', { projectId: project.id }), original, 'trial never edits saved timeline or final whole-range choice');
    const route = `/media/${record!.assetId}?preview=1&exportId=${record!.id}`;
    const response = await fetch(server.url + route, { headers: { authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(30000) }); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()), file = path.join(root, `${name}.mp4`); await writeFile(file, bytes);
    const partial = await fetch(server.url + route, { headers: { authorization: `Bearer ${server.token}`, range: 'bytes=0-31' }, signal: AbortSignal.timeout(30000) });
    assert.equal(partial.status, 206); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(0, 32));
    interface ProbeStream {codec_type?: string; codec_name?: string; width?: number; height?: number; nb_read_frames?: string | number; avg_frame_rate?: string; sample_rate?: string; channels?: number}
    const info = JSON.parse(await run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 20000, maxStdoutBytes: 131072, maxStderrBytes: 65536 })) as {streams: ProbeStream[]};
    const video = info.streams.find(stream => stream.codec_type === 'video')!, sound = info.streams.find(stream => stream.codec_type === 'audio')!;
    assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 360); assert.equal(video.height, 640); assert.equal(Number(video.nb_read_frames), frames); assert.equal(video.avg_frame_rate, '30/1');
    assert.equal(sound.codec_name, 'aac'); assert.equal(sound.sample_rate, '48000'); assert.equal(sound.channels, 2);
    await run('ffmpeg', ['-v', 'error', '-threads', '1', '-i', file, '-f', 'null', '-'], { timeout: 20000, maxStdoutBytes: 0, maxStderrBytes: 65536 });
    proofs.push({ name, input, exportId: record!.id, assetId: record!.assetId, sha256: sha(bytes), bytes: bytes.length, frames, width: video.width, height: video.height, rangeStatus: partial.status, receiptReplayedExactly: true, fullDecode: true });
  }
  assert.notEqual(proofs[0].exportId, proofs[1].exportId); assert.notEqual(proofs[0].assetId, proofs[1].assetId);
  if (process.env.MIOON_EXPORT_PREVIEW_EVIDENCE) {
    await mkdir(process.env.MIOON_EXPORT_PREVIEW_EVIDENCE, { recursive: true });
    await writeFile(path.join(process.env.MIOON_EXPORT_PREVIEW_EVIDENCE, 'real-media.json'), JSON.stringify({ scope: 'Synthetic PNG and tone only; real HTTP/worker/FFmpeg; not GUI or perceptual playback acceptance', proofs }, null, 2));
  }
});
