import type {MediaShot} from './helpers/strict-service-responses.ts';
import type {FixtureProject, FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
import type {ServiceResponse as FixtureServiceResult, TypedStore as FixtureStore, TypedServices as FixtureServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore, type WorkspaceStore } from '../packages/business/src/db.ts';
import { createServices, type OrdinaryServices } from '../packages/business/src/services.ts';

// These deterministic service tests isolate schema/revision/state correctness from
// FFmpeg. Real imported bytes and protocol/renderer tests live in the other v2 suites.
const repo = fileURLToPath(new URL('..', import.meta.url));
const evidence = path.join(repo, 'evidence/v2-tests');
const report = { startedAt: new Date().toISOString(), runtime: process.version, suite: 'timeline-contract', checks: [] };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const stamp = '2026-10-09T00:00:00.000Z';
async function fixture(t: test.TestContext, { legacy = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-timeline-contract-'));
  const oldProject = { id: randomUUID(), name: 'Original v1 project', description: '', revision: 9, createdAt: stamp, updatedAt: stamp };
  if (legacy) {
    const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
    db.exec('CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES(1); CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);');
    db.prepare('INSERT INTO projects VALUES(?,?)').run(oldProject.id, JSON.stringify(oldProject)); db.close();
  }
  let store = (openStore(root) as FixtureStore), services = (createServices(store, new Map()) as FixtureServices);
  const _strictFixtureBase = {
    root, get store() { return store; }, get services() { return services; },
    call: <O extends string>(operation: O, input?: unknown) => services.call(operation, input) as Promise<FixtureServiceResult<O>>,
    restart() { store.close(); store = (openStore(root) as FixtureStore); services = (createServices(store, new Map()) as FixtureServices); },
    asset(projectId?: string, mimeType: string|undefined = 'image/png', extra: {duration?: number|boolean;} = {}) {
      const id = randomUUID();
      return store.put('assets', { id, projectId, name: `fixture.${mimeType.split('/')[1]}`, mimeType, sha256: 'a'.repeat(64), sizeBytes: 128, width: 720, height: 1280, duration: mimeType.startsWith('image/') ? 0 : 2.001, relativePath: `media/${id}.fixture`, url: `/media/${id}`, createdAt: stamp, ...extra });
    },
    version(shot: MediaShot, asset: { id: unknown; projectId?: unknown; name?: string; mimeType?: string; sha256: unknown; sizeBytes?: number; width?: number; height?: number; duration?: number; relativePath?: string; url: unknown; createdAt?: string; }, number: number|undefined = 1) {
      const jobId = randomUUID(), versionId = randomUUID();
      store.put('jobs', { id: jobId, projectId: shot.projectId, shotId: shot.id, providerId: 'mock', requestId: randomUUID(), status: 'succeeded', revision: 1, versionId, createdAt: stamp });
      return store.put('versions', { id: versionId, projectId: shot.projectId, shotId: shot.id, jobId, number, providerId: 'mock', model: 'test-fixture', isMock: true, snapshot: { title: shot.title }, assetId: asset.id, sha256: asset.sha256, url: asset.url, createdAt: stamp });
    },
  };
 const f = _strictFixtureBase as typeof _strictFixtureBase & {project: FixtureProject};
  f.project = legacy ? oldProject : await f.call('project.create', { name: t.name });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return f;
}
function base(projectId: string, timeline: FixtureTimeline) { return { projectId, expectedRevision: timeline.revision, requestId: randomUUID() }; }
async function rejected(f: Awaited<ReturnType<typeof fixture>>, operation: string, input: { startFrame: number; durationFrames: number; sourceInFrame?: undefined; assetId: `${string}-${string}-${string}-${string}-${string}`; trackId: unknown; gain?: undefined; rect?: undefined; speed?: undefined; projectId: unknown; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ durationFrames: number; startFrame: number; sourceInFrame?: undefined; assetId: `${string}-${string}-${string}-${string}-${string}`; trackId: unknown; gain?: undefined; rect?: undefined; speed?: undefined; projectId: unknown; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ startFrame: number; durationFrames: number; sourceInFrame?: undefined; assetId: `${string}-${string}-${string}-${string}-${string}`; trackId: unknown; gain?: undefined; rect?: undefined; speed?: undefined; projectId: unknown; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ sourceInFrame: number; startFrame: number; durationFrames: number; assetId: `${string}-${string}-${string}-${string}-${string}`; trackId: unknown; gain?: undefined; rect?: undefined; speed?: undefined; projectId: unknown; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ assetId: `${string}-${string}-${string}-${string}-${string}`; sourceInFrame: number; durationFrames: number; startFrame: number; trackId: unknown; gain?: undefined; rect?: undefined; speed?: undefined; projectId: unknown; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ assetId: `${string}-${string}-${string}-${string}-${string}`; durationFrames: number; startFrame: number; sourceInFrame?: undefined; trackId: unknown; gain?: undefined; rect?: undefined; speed?: undefined; projectId: unknown; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ assetId: `${string}-${string}-${string}-${string}-${string}`; startFrame: number; durationFrames: number; sourceInFrame?: undefined; trackId: unknown; gain?: undefined; rect?: undefined; speed?: undefined; projectId: unknown; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ trackId: unknown; startFrame: number; durationFrames: number; sourceInFrame?: undefined; assetId: `${string}-${string}-${string}-${string}-${string}`; gain?: undefined; rect?: undefined; speed?: undefined; projectId: unknown; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ trackId: unknown; assetId: `${string}-${string}-${string}-${string}-${string}`; startFrame: number; durationFrames: number; sourceInFrame?: undefined; gain?: undefined; rect?: undefined; speed?: undefined; projectId: unknown; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ gain: number; startFrame: number; durationFrames: number; sourceInFrame?: undefined; assetId: `${string}-${string}-${string}-${string}-${string}`; trackId: unknown; rect?: undefined; speed?: undefined; projectId: unknown; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ rect: { x: number; y: number; width: number; height: number; rotation?: undefined; }; startFrame: number; durationFrames: number; sourceInFrame?: undefined; assetId: `${string}-${string}-${string}-${string}-${string}`; trackId: unknown; gain?: undefined; speed?: undefined; projectId: unknown; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ rect: { x: number; y: number; width: number; height: number; rotation: number; }; startFrame: number; durationFrames: number; sourceInFrame?: undefined; assetId: `${string}-${string}-${string}-${string}-${string}`; trackId: unknown; gain?: undefined; speed?: undefined; projectId: unknown; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ speed: number; startFrame: number; durationFrames: number; sourceInFrame?: undefined; assetId: `${string}-${string}-${string}-${string}-${string}`; trackId: unknown; gain?: undefined; rect?: undefined; projectId: unknown; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }, code: {}) {
  const before = await f.call('timeline.get', { projectId: input.projectId });
  await assert.rejects(f.call(operation, input), error => (!code || (error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code === code) && Boolean((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code), `${operation} should reject ${JSON.stringify(input)}`);
  assert.deepEqual(await f.call('timeline.get', { projectId: input.projectId }), before, `${operation} rejection must be atomic`);
}
function passed(name: string, details: Record<string, unknown> = {}) { report.checks.push((({ name, passed: true, ...details }) as unknown as Parameters<typeof report.checks.push>[0])); }
test.after(async () => { (report as typeof report & {finishedAt:(string)}).finishedAt = new Date().toISOString(); (report as typeof report & {expectedGroups:(10)}).expectedGroups = 10; (report as typeof report & {result:("passed" | "failed_or_incomplete")}).result = report.checks.length === 10 ? 'passed' : 'failed_or_incomplete'; await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, 'contract.json'), JSON.stringify(report, null, 2)); });

test('timeline migration is additive, stable, empty, and does not change v1 project revision', async t => {
  const f = await fixture(t, { legacy: true });
  const asset = f.asset(f.project.id, 'video/mp4');
  const shot = await f.call('shot.create', { projectId: f.project.id, title: 'Existing selected shot' });
  const version = f.version(shot, ((asset) as unknown as Parameters<typeof f.version>[1]));
  f.store.put('shots', { ...shot, selectedVersionId: version.id });
  const legacyTables = ['projects', 'shots', 'assets', 'nodes', 'edges', 'jobs', 'versions', 'exports'];
  const before = Object.fromEntries(legacyTables.map(name => [name, clone(f.store.list(name))]));
  const firstProject = await f.call('project.get', { projectId: f.project.id });
  const timeline = firstProject.timeline;
  assert.ok(timeline, 'project.get should additively expose a timeline');
  assert.equal(timeline.projectId, f.project.id); assert.equal(timeline.revision, 1);
  assert.equal(timeline.fps, 30); assert.equal(timeline.width, 1080); assert.equal(timeline.height, 1920);
  assert.equal(timeline.durationFrames, 0); assert.deepEqual((timeline.clips as unknown), []);
  assert.equal(timeline.tracks.length, 3); assert.equal(timeline.tracks.filter((track) => track.kind === 'video').length, 2); assert.equal(timeline.tracks.filter((track) => track.kind === 'audio').length, 1);
  assert.equal(new Set(timeline.tracks.map((track) => track.id)).size, 3);
  for (const track of timeline.tracks) { assert.equal(track.hidden, false); assert.equal(track.muted, false); assert.ok(Number.isInteger(track.orderIndex)); }
  assert.deepEqual(await f.call('timeline.get', { projectId: f.project.id }), timeline);
  assert.deepEqual(Object.fromEntries(legacyTables.map(name => [name, f.store.list(name)])), before, 'read migration must preserve all existing data byte values');
  f.restart();
  assert.deepEqual(await f.call('timeline.get', { projectId: f.project.id }), timeline, 'migration survives process/store reopen without duplicate tracks');
  assert.deepEqual((await f.call('project.get', { projectId: f.project.id })).timeline, timeline);
  passed(t.name, { timelineId: timeline.id, projectRevision: firstProject.project.revision });
});

test('every timeline mutation replays the exact original response after later edits and restart', async t => {
  const f = await fixture(t), projectId = f.project.id, asset = f.asset(projectId);
  let timeline = await f.call('timeline.get', { projectId });
  const requests: ({ operation: string; input: { kind?: string; name?: string; trackId?: unknown; patch?: { name: string; hidden: boolean; muted: boolean; } | { startFrame: number; durationFrames: number; rect: { x: number; y: number; width: number; height: number; }; gain: number; }; assetId?: `${string}-${string}-${string}-${string}-${string}`; startFrame?: number; durationFrames?: number; clipId?: unknown; projectId: unknown; expectedRevision: number; requestId: `${string}-${string}-${string}-${string}-${string}`; }; result: unknown; })[] = [];
  async function mutate(operation: string, fields: { kind?: string; name?: string; trackId?: unknown; patch?: { name: string; hidden: boolean; muted: boolean; }|{ startFrame: number; durationFrames: number; rect: { x: number; y: number; width: number; height: number; }; gain: number; }; assetId?: `${string}-${string}-${string}-${string}-${string}`; startFrame?: number; durationFrames?: number; clipId?: unknown; }) {
    const input = { ...base(projectId, timeline), ...fields }, result = await f.call(operation, input);
    assert.equal((result as FixtureTimeline).revision, timeline.revision + 1); timeline = (result as unknown as typeof timeline);
    requests.push({ operation, input, result: clone(result) }); return result;
  }
  await mutate('timeline.track.add', { kind: 'video', name: 'Third visual' });
  const track = timeline.tracks.at(-1);
  await mutate('timeline.track.update', { trackId: (track)!.id, patch: { name: 'Renamed visual', hidden: true, muted: true } });
  await mutate('timeline.clip.add', { trackId: (track)!.id, assetId: asset.id, startFrame: 10, durationFrames: 20 });
  const clipId = timeline.clips[0].id;
  assert.deepEqual(timeline.clips[0].rect, { x: 0, y: 0, width: 1080, height: 1920 }); assert.equal(timeline.clips[0].sourceInFrame, 0); assert.equal(timeline.clips[0].gain, 1);
  await mutate('timeline.clip.update', { clipId, patch: { startFrame: 12, durationFrames: 18, rect: { x: 10, y: 20, width: 200, height: 400 }, gain: 0.5 } });
  await mutate('timeline.clip.remove', { clipId });
  const latest = clone(timeline);
  for (const request of requests) assert.deepEqual(await f.call(request.operation, request.input), request.result, `${request.operation} replay uses the saved old response`);
  assert.deepEqual(await f.call('timeline.get', { projectId }), latest);
  f.restart();
  for (const request of requests) assert.deepEqual(await f.call(request.operation, request.input), request.result, `${request.operation} replay persists across restart`);
  assert.deepEqual(await f.call('timeline.get', { projectId }), latest);
  const original = requests[0];
  await rejected(f, original.operation, (({ ...original.input, name: 'Changed input with stale revision' }) as unknown as Parameters<NonNullable<typeof rejected>>[2]), 'IDEMPOTENCY_CONFLICT');
  await rejected(f, 'timeline.track.update', (({ ...original.input, kind: undefined, name: undefined, trackId: (track)!.id, patch: { muted: false } }) as unknown as Parameters<NonNullable<typeof rejected>>[2]), 'VALIDATION_ERROR');
  const crossOperation = { projectId, expectedRevision: original.input.expectedRevision, requestId: original.input.requestId, trackId: (track)!.id, patch: { muted: false } };
  await rejected(f, 'timeline.track.update', ((crossOperation) as unknown as Parameters<typeof rejected>[2]), 'IDEMPOTENCY_CONFLICT');
  const other = await f.call('project.create', { name: 'Request ID conflicts across projects' });
  const otherTimeline = await f.call('timeline.get', { projectId: other.id });
  await rejected(f, original.operation, (({ ...original.input, projectId: other.id, expectedRevision: otherTimeline.revision }) as unknown as Parameters<typeof rejected>[2]), 'IDEMPOTENCY_CONFLICT');
  assert.throws(() => f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run('{}', original.input.requestId), /immutable/);
  assert.deepEqual(await f.call(original.operation, original.input), original.result);
  passed(t.name, { operations: requests.map(request => request.operation), originalRevisions: requests.map(request => (request.result as FixtureTimeline).revision), finalRevision: latest.revision });
});

test('concurrent duplicate requests apply once; competing fresh requests serialize by revision', async t => {
  const f = await fixture(t), projectId = f.project.id;
  const timeline = await f.call('timeline.get', { projectId });
  const input = { ...base(projectId, timeline), kind: 'video', name: 'Exactly once' };
  const duplicates = await Promise.all(Array.from({ length: 20 }, () => f.call('timeline.track.add', input)));
  for (const result of duplicates) assert.deepEqual(result, duplicates[0]);
  assert.equal(duplicates[0].revision, 2); assert.equal(duplicates[0].tracks.length, 4);
  const pending = await Promise.allSettled(Array.from({ length: 12 }, (_, n) => f.call('timeline.track.update', { ...base(projectId, duplicates[0]), trackId: timeline.tracks[0].id, patch: { name: `Writer ${n}` } })));
  assert.equal(pending.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of pending.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'REVISION_CONFLICT');
  const current = await f.call('timeline.get', { projectId }); assert.equal(current.revision, 3);
  assert.deepEqual(await f.call('timeline.track.add', input), duplicates[0], 'dedupe occurs before stale revision check');
  passed(t.name, { duplicates: duplicates.length, competingRequests: pending.length, finalRevision: current.revision });
});

test('seed copies only selected versions in shot order once and freezes refs independently of selection', async t => {
  const f = await fixture(t), projectId = f.project.id;
  const assets = [f.asset(projectId, 'video/mp4', { duration: 1.1 }), f.asset(projectId, 'video/mp4', { duration: 2 }), f.asset(projectId, 'video/mp4', { duration: 0.5 })];
  const shotA = await f.call('shot.create', { projectId, title: 'Second' }), shotB = await f.call('shot.create', { projectId, title: 'First' });
  const a1 = f.version(shotA, ((assets[0]) as unknown as Parameters<typeof f.version>[1])), a2 = f.version(shotA, ((assets[2]) as unknown as Parameters<typeof f.version>[1]), 2), b1 = f.version(shotB, ((assets[1]) as unknown as Parameters<typeof f.version>[1]));
  f.store.put('shots', { ...shotA, selectedVersionId: a1.id, orderIndex: 1 }); f.store.put('shots', { ...shotB, selectedVersionId: b1.id, orderIndex: 0 });
  const empty = await f.call('timeline.get', { projectId }); assert.equal(empty.clips.length, 0);
  const seedInput = base(projectId, empty), seeded = await f.call('timeline.seed', seedInput);
  assert.equal(seeded.revision, 2); assert.deepEqual(seeded.clips.map((clip) => clip.assetId), [assets[1].id, assets[0].id]);
  assert.deepEqual(seeded.clips.map((clip) => [clip.startFrame, clip.durationFrames, clip.sourceInFrame]), [[0, 60, 0], [60, 33, 0]]);
  assert.equal(seeded.durationFrames, 93); assert.ok(seeded.clips.every((clip) => clip.trackId === seeded.tracks.filter((track) => track.kind === 'video').sort((a, b) => a.orderIndex - b.orderIndex)[0].id));
  await rejected(f, 'timeline.seed', ((base(projectId, seeded)) as unknown as Parameters<typeof rejected>[2]), 'TIMELINE_NOT_EMPTY');
  const selected = await f.call('version.select', { shotId: shotA.id, versionId: a2.id, expectedRevision: shotA.revision });
  assert.equal(selected.selectedVersionId, a2.id); assert.deepEqual(await f.call('timeline.get', { projectId }), seeded);
  const moved = await f.call('timeline.clip.update', { ...base(projectId, seeded), clipId: seeded.clips[1].id, patch: { startFrame: 90 } });
  assert.equal(moved.clips[1].assetId, assets[0].id); assert.deepEqual(await f.call('timeline.seed', seedInput), seeded);
  const sequential = await f.call('export.create', { projectId, requestId: randomUUID() });
  assert.deepEqual(sequential.orderedVersionIds, [b1.id, a2.id]); assert.ok(Array.isArray(sequential.snapshot), 'v1 sequence export retains legacy snapshot shape');
  assert.deepEqual(await f.call('timeline.get', { projectId }), moved);
  f.restart(); assert.deepEqual(await f.call('timeline.seed', seedInput), seeded);
  assert.deepEqual(await f.call('timeline.get', { projectId }), moved);
  passed(t.name, { seededAssetIds: seeded.clips.map((clip) => clip.assetId), laterSelectedVersion: a2.id, timelineStillReferences: assets[0].id });
});

test('seed missing selections rejects atomically and allows a corrected retry', async t => {
  const f = await fixture(t), projectId = f.project.id;
  const a = await f.call('shot.create', { projectId, title: 'Selected' }), b = await f.call('shot.create', { projectId, title: 'Not selected' });
  const av = f.version(a, ((f.asset(projectId, 'video/mp4')) as unknown as Parameters<typeof f.version>[1])), bv = f.version(b, ((f.asset(projectId, 'video/mp4')) as unknown as Parameters<typeof f.version>[1]));
  f.store.put('shots', { ...a, selectedVersionId: av.id });
  const empty = await f.call('timeline.get', { projectId }), input = base(projectId, empty);
  await rejected(f, 'timeline.seed', ((input) as unknown as Parameters<typeof rejected>[2]), 'MISSING_SELECTION');
  f.store.put('shots', { ...b, selectedVersionId: bv.id });
  const seeded = await (f.call as (operation:string,input:unknown,error?:string)=>Promise<FixtureTimeline>)('timeline.seed', input, 'MISSING_SELECTION'); assert.equal(seeded.clips.length, 2); assert.equal(seeded.revision, 2);
  passed(t.name);
});

test('clip validation rejects invalid frames, rectangles, media kinds, cross-project refs and unsupported edits atomically', async t => {
  const f = await fixture(t), projectId = f.project.id;
  const foreign = await f.call('project.create', { name: 'Foreign project' });
  const foreignTimeline = await f.call('timeline.get', { projectId: foreign.id });
  const image = f.asset(projectId), video = f.asset(projectId, 'video/mp4', { duration: 2.001 }), audio = f.asset(projectId, 'audio/wav'), foreignImage = f.asset(foreign.id);
  let timeline = await f.call('timeline.get', { projectId });
  const videoTrack = timeline.tracks.find((track) => track.kind === 'video'), audioTrack = timeline.tracks.find((track) => track.kind === 'audio');
  const defaults = { trackId: (videoTrack)!.id, assetId: image.id, startFrame: 0, durationFrames: 30 };
  const invalidAdds = [
    { startFrame: -1 }, { startFrame: 0.5 }, { durationFrames: 0 }, { durationFrames: 1.5 }, { durationFrames: 18001 }, { startFrame: 17999, durationFrames: 2 }, { sourceInFrame: 1 },
    { assetId: video.id, sourceInFrame: 1, durationFrames: 60 }, { assetId: video.id, durationFrames: 61 }, { assetId: audio.id }, { trackId: (audioTrack)!.id }, { trackId: (audioTrack)!.id, assetId: video.id },
    { assetId: foreignImage.id }, { trackId: foreignTimeline.tracks[0].id }, { assetId: randomUUID() }, { trackId: randomUUID() },
    { gain: -0.1 }, { gain: 2.1 }, { gain: Infinity }, { rect: { x: 1, y: 0, width: 100, height: 100 } }, { rect: { x: 0, y: 0, width: 101, height: 100 } },
    { rect: { x: 0, y: 0, width: 0, height: 100 } }, { rect: { x: timeline.width - 98, y: 0, width: 100, height: 100 } }, { rect: { x: 0, y: timeline.height - 98, width: 100, height: 100 } },
    { rect: { x: 0, y: 0, width: 100, height: 100, rotation: 90 } }, { speed: 2 },
  ];
  const invalidAddCodes = ['VALIDATION_ERROR', 'VALIDATION_ERROR', 'VALIDATION_ERROR', 'VALIDATION_ERROR', 'VALIDATION_ERROR', 'TIMELINE_LIMIT', 'SOURCE_BOUNDS', 'SOURCE_BOUNDS', 'SOURCE_BOUNDS', 'INVALID_CLIP_TYPE', 'INVALID_CLIP_TYPE', 'INVALID_CLIP_TYPE', 'CROSS_PROJECT_REFERENCE', 'TRACK_NOT_FOUND', 'NOT_FOUND', 'TRACK_NOT_FOUND', ...Array(10).fill('VALIDATION_ERROR')];
  assert.equal(invalidAddCodes.length, invalidAdds.length);
  for (const [index, patch] of invalidAdds.entries()) await rejected(f, 'timeline.clip.add', { ...base(projectId, timeline), ...defaults, ...patch }, invalidAddCodes[index]);
  for (const patch of ([{ hidden: true }, { hidden: false }] as const)) await rejected(f, 'timeline.track.update', (({ ...base(projectId, timeline), trackId: (audioTrack)!.id, patch }) as unknown as Parameters<typeof rejected>[2]), 'AUDIO_HIDDEN_UNSUPPORTED');
  timeline = await f.call('timeline.clip.add', { ...base(projectId, timeline), ...defaults, assetId: video.id, sourceInFrame: 1, durationFrames: 59 });
  const clipId = timeline.clips[0].id;
  const invalidUpdates = [[{ assetId: image.id }, 'VALIDATION_ERROR'], [{ trackId: (audioTrack)!.id }, 'INVALID_CLIP_TYPE'], [{ sourceInFrame: 2 }, 'SOURCE_BOUNDS'], [{ sourceInFrame: -1 }, 'VALIDATION_ERROR'], [{ durationFrames: 60 }, 'SOURCE_BOUNDS'], [{ startFrame: 1.1 }, 'VALIDATION_ERROR'], [{ trackId: foreignTimeline.tracks[0].id }, 'TRACK_NOT_FOUND'], [{ playbackRate: 2 }, 'VALIDATION_ERROR'], [{}, 'VALIDATION_ERROR']];
  for (const [patch, code] of invalidUpdates) await rejected(f, 'timeline.clip.update', (({ ...base(projectId, timeline), clipId, patch }) as unknown as Parameters<typeof rejected>[2]), code);
  await rejected(f, 'timeline.clip.remove', (({ ...base(projectId, timeline), clipId: randomUUID() }) as unknown as Parameters<NonNullable<typeof rejected>>[2]), 'CLIP_NOT_FOUND');
  await rejected(f, 'timeline.track.update', (({ ...base(projectId, timeline), trackId: (videoTrack)!.id, patch: { kind: 'audio' } }) as unknown as Parameters<NonNullable<typeof rejected>>[2]), 'VALIDATION_ERROR');
  passed(t.name, { invalidAdds: invalidAdds.length, invalidUpdates: 9, validBound: 'source 1 + duration 59 = floor(2.001*30)' });
});

test('source bound tolerance accepts exact fractional frame durations and rejects fractional tails', async t => {
  const f = await fixture(t), projectId = f.project.id; let timeline = await f.call('timeline.get', { projectId });
  const trackId = timeline.tracks[0].id;
  // 29.9999999997 models harmless binary/probe noise; 29.97 is real subframe media.
  for (const [duration, frames, accepted] of ([[0.99999999999, 30, true], [0.999, 30, false], [1.00001, 30, true], [1.00001, 31, false]] as const)) {
    const asset = f.asset(projectId, 'video/mp4', { duration });
    const input = { ...base(projectId, timeline), trackId, assetId: asset.id, startFrame: timeline.durationFrames, durationFrames: frames };
    if (accepted) timeline = await f.call('timeline.clip.add', input); else await rejected(f, 'timeline.clip.add', ((input) as unknown as Parameters<typeof rejected>[2]), 'SOURCE_BOUNDS');
  }
  assert.equal(timeline.clips.length, 2); assert.equal(timeline.durationFrames, 60); passed(t.name);
});

test('same-track overlap is refused; edge-touching, cross-track overlap, exact trims and moves work', async t => {
  const f = await fixture(t), projectId = f.project.id, asset = f.asset(projectId);
  let timeline = await f.call('timeline.get', { projectId }); const [first, second] = timeline.tracks.filter((track) => track.kind === 'video');
  const add = (fields: { startFrame?: number; trackId?: unknown; }) => f.call('timeline.clip.add', { ...base(projectId, timeline), trackId: first.id, assetId: asset.id, startFrame: 10, durationFrames: 10, ...fields });
  timeline = await add({}); const original = timeline.clips[0];
  for (const [startFrame, durationFrames] of ([[10, 10], [9, 2], [19, 2], [0, 30], [12, 2]] as const)) await rejected(f, 'timeline.clip.add', { ...base(projectId, timeline), trackId: first.id, assetId: asset.id, startFrame, durationFrames }, 'CLIP_OVERLAP');
  timeline = await add({ startFrame: 0 }); timeline = await add({ startFrame: 20 }); timeline = await add({ trackId: second.id });
  assert.equal(timeline.clips.length, 4); assert.equal(timeline.durationFrames, 30);
  await rejected(f, 'timeline.clip.update', (({ ...base(projectId, timeline), clipId: original.id, patch: { startFrame: 11 } }) as unknown as Parameters<NonNullable<typeof rejected>>[2]), 'CLIP_OVERLAP');
  const upper = timeline.clips.find((clip) => clip.trackId === second.id);
  await rejected(f, 'timeline.clip.update', (({ ...base(projectId, timeline), clipId: (upper)!.id, patch: { trackId: first.id } }) as unknown as Parameters<NonNullable<typeof rejected>>[2]), 'CLIP_OVERLAP');
  timeline = await f.call('timeline.clip.update', { ...base(projectId, timeline), clipId: (upper)!.id, patch: { trackId: first.id, startFrame: 30 } });
  assert.equal(timeline.durationFrames, 40); assert.equal((timeline.clips.find((clip) => clip.id === (upper)!.id))!.durationFrames, 10);
  timeline = await f.call('timeline.clip.remove', { ...base(projectId, timeline), clipId: (upper)!.id }); assert.equal(timeline.durationFrames, 30);
  passed(t.name, { overlapCases: 7, validClipCount: timeline.clips.length });
});

test('track and clip limits are enforced without invalidating full-length empty/gap edits', async t => {
  const f = await fixture(t), projectId = f.project.id, asset = f.asset(projectId);
  let timeline = await f.call('timeline.get', { projectId });
  while (timeline.tracks.length < 12) timeline = await f.call('timeline.track.add', { ...base(projectId, timeline), kind: timeline.tracks.length % 2 ? 'video' : 'audio' });
  await rejected(f, 'timeline.track.add', (({ ...base(projectId, timeline), kind: 'video' }) as unknown as Parameters<NonNullable<typeof rejected>>[2]), 'TIMELINE_LIMIT');
  const trackId = (timeline.tracks.find((track) => track.kind === 'video'))!.id;
  for (let index = 0; index < 100; index++) timeline = await f.call('timeline.clip.add', { ...base(projectId, timeline), trackId, assetId: asset.id, startFrame: index * 2, durationFrames: 1 });
  await rejected(f, 'timeline.clip.add', { ...base(projectId, timeline), trackId, assetId: asset.id, startFrame: 200, durationFrames: 1 }, 'TIMELINE_LIMIT');
  const last = timeline.clips.at(-1);
  timeline = await f.call('timeline.clip.update', { ...base(projectId, timeline), clipId: (last)!.id, patch: { startFrame: 17999, durationFrames: 1 } });
  assert.equal(timeline.durationFrames, 18000);
  await rejected(f, 'timeline.clip.update', (({ ...base(projectId, timeline), clipId: (last)!.id, patch: { durationFrames: 2 } }) as unknown as Parameters<NonNullable<typeof rejected>>[2]), 'TIMELINE_LIMIT');
  passed(t.name, { trackCount: timeline.tracks.length, clipCount: timeline.clips.length, maxDurationFrames: timeline.durationFrames });
});

test('timeline render snapshots revision/assets once and shares mutation idempotency namespace', async t => {
  const f = await fixture(t), projectId = f.project.id, asset = f.asset(projectId, 'video/mp4');
  let timeline = await f.call('timeline.get', { projectId });
  await rejected(f, 'timeline.render', (({ ...base(projectId, timeline), purpose: 'preview' }) as unknown as Parameters<NonNullable<typeof rejected>>[2]), 'EMPTY_TIMELINE');
  const addInput = { ...base(projectId, timeline), trackId: timeline.tracks[0].id, assetId: asset.id, startFrame: 10, durationFrames: 30 };
  timeline = await f.call('timeline.clip.add', addInput);
  const renderInput = { ...base(projectId, timeline), purpose: 'preview' }, render = await f.call('timeline.render', renderInput);
  assert.equal(render.mode, 'timeline'); assert.equal(render.purpose, 'preview'); assert.equal(render.timelineRevision, timeline.revision);
  assert.equal(render.status, 'queued'); assert.equal((render.assetId as unknown), null); assert.equal((render.url as unknown), null);
  assert.deepEqual(render.snapshot.timeline, timeline); assert.equal(render.snapshot.assets.length, 1); assert.equal(render.snapshot.assets[0].id, asset.id); assert.equal(render.snapshot.assets[0].sha256, asset.sha256);
  assert.equal((await f.call('timeline.get', { projectId })).revision, timeline.revision, 'render job creation must not edit the timeline');
  timeline = await f.call('timeline.clip.update', { ...base(projectId, timeline), clipId: timeline.clips[0].id, patch: { startFrame: 0 } });
  assert.deepEqual(await f.call('timeline.render', renderInput), render);
  await rejected(f, 'timeline.render', (({ ...renderInput, purpose: 'export' }) as unknown as Parameters<NonNullable<typeof rejected>>[2]), 'IDEMPOTENCY_CONFLICT');
  await rejected(f, 'timeline.render', (({ ...renderInput, requestId: addInput.requestId }) as unknown as Parameters<typeof rejected>[2]), 'IDEMPOTENCY_CONFLICT');
  await rejected(f, 'timeline.track.add', (({ projectId, expectedRevision: renderInput.expectedRevision, requestId: renderInput.requestId, kind: 'video' }) as unknown as Parameters<NonNullable<typeof rejected>>[2]), 'IDEMPOTENCY_CONFLICT');
  await rejected(f, 'timeline.render', (({ ...base(projectId, timeline), expectedRevision: 1, purpose: 'export' }) as unknown as Parameters<NonNullable<typeof rejected>>[2]), 'REVISION_CONFLICT');
  assert.deepEqual((await f.call('export.get', { exportId: render.id })).snapshot, render.snapshot);
  const stored = f.store.get('exports', render.id);
  for (const patch of ([{ snapshot: { ...stored!.snapshot, assets: [] } }, { timelineRevision: 99 }, { purpose: 'export' }, { mode: 'sequence' }] as const)) {
    assert.throws(() => f.store.put('exports', { ...stored, ...patch }), /immutable/);
    assert.deepEqual(f.store.get('exports', render.id), stored);
  }
  f.restart(); assert.deepEqual(await f.call('timeline.render', renderInput), render);
  passed(t.name, { exportId: render.id, frozenTimelineRevision: render.timelineRevision, currentTimelineRevision: timeline.revision });
});
