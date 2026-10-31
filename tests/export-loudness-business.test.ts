import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm, writeFile, readFile, readdir, unlink, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {isTimelineRenderRecord} from '@mioon/contracts';
import {EXPORT_LOUDNESS_PROFILE, EXPORT_LOUDNESS_LIMITS, isExportLoudnessResponse} from '@mioon/contracts/export-loudness';
import {installCurrentWorkspaceRestoreSchema, openStore, ownsStoreLock, getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createExportLoudnessServices} from '../packages/business/src/export-loudness.ts';
import {createExportLoudnessAccumulator} from '../packages/business/src/export-loudness-meter.ts';
import {createExportSamplePeakServices} from '../packages/business/src/export-sample-peak.ts';
import {createExportSamplePeakAccumulator} from '../packages/business/src/export-sample-peak-decoder.ts';
import {readOwnedTimelineAsset} from '../packages/business/src/timeline-sources.ts';
import {validateManagedSource, verifiedManagedHash} from '../packages/business/src/managed-media.ts';
import {boundedShutdown} from '../packages/business/src/operation-lifecycle.ts';
import {workspaceRestoreError, RESTORE_DENIED_OPERATIONS} from '../packages/business/src/workspace-restore-policy.ts';
import {floatSnapshotSha256} from '../packages/business/src/timeline-float-outcome.ts';
import {onMediaProcess, spawnMedia, terminateMediaProcesses, waitForMediaProcesses, hasUnconfirmedMediaProcesses} from '../packages/business/src/media-processes.ts';
import {runStreaming} from '../packages/business/src/media-runtime.ts';
import {schemaObjects} from './helpers/project-database.ts';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const byName = (a: {name: string}, b: {name: string}) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
// The other project is not in this store; write the damaged row as a corrupt file would hold it.
const withoutForeignKeys = (db: DatabaseSync, write: () => void) => {
  db.exec('PRAGMA foreign_keys=OFF');
  try {write();} finally {db.exec('PRAGMA foreign_keys=ON');}
};
// Another project lives in a store of its own: a store holds one project.
async function foreignProject(t: TestContext): Promise<{id: string}> {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-loudness-foreign-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const store = openStore(root), services = createServices(store, new Map());
  try {return await services.call('project.create', {name: 'Other project'}) as {id: string};}
  finally {await services.drain(); store.close();}
}
type Deferred<T = unknown> = {promise: Promise<T>; resolve: (value?: T) => void};
const deferred = <T = unknown>(): Deferred<T> => {let resolve!: (value?: T) => void; const promise = new Promise<T>(r => {resolve = r as unknown as (value?: T) => void;}); return {promise, resolve};};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function pcm(seconds = 1, amplitude = 0.1) {
  const bytes = Buffer.alloc(Math.round(seconds * 48000) * 8);
  for (let frame = 0; frame < bytes.length / 8; frame++) {
    const sample = amplitude * Math.sin(2 * Math.PI * 1000 * frame / 48000);
    bytes.writeFloatLE(sample, frame * 8); bytes.writeFloatLE(-sample, frame * 8 + 4);
  }
  return bytes;
}
function measurement(seconds = 1, amplitude = 0.1) {
  const accumulator = createExportLoudnessAccumulator(seconds); accumulator.write(pcm(seconds, amplitude)); return accumulator.finish();
}
async function files(root: string): Promise<Array<[string, string]>> {
  const result: Array<[string, string]> = [];
  for (const entry of await readdir(root, {recursive: true, withFileTypes: true})) {
    if (!entry.isFile() || /^workbench\.sqlite(?:-wal|-shm)?$/.test(entry.name) || entry.name === 'server.lock') continue;
    const full = path.join((entry as {parentPath: string}).parentPath, entry.name); result.push([path.relative(root, full), sha(await readFile(full))]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}
interface LoudnessServiceResult {status: string; reason: {code?: string}; checks: {bytesHashed: number}; measurement: {decodedDurationSeconds: number; integratedLufs: number; state: string; truePeakDbtp: number}; suggestion: {applyRequired: boolean; requiredGainDb: number; conflictsWithCeiling: boolean; applyAllowed: boolean; currentTimelineValidated: boolean}; artifact: {sha256: string; snapshotSha256: string; timelineRevision: number; exportRange?: unknown; deliveryName?: unknown}; [key: string]: unknown}
interface TimelineFixture {id: string; revision: number; tracks: Array<{id: string}>; clips: Array<{id: string}>}
interface RuntimeOverrides {[key: string]: unknown}
interface FixtureCheckpoint {rows: Record<string, unknown[]>; writes: number; files: Array<[string, string]>}
interface BusinessFixture {root: string; store: ReturnType<typeof openStore>; services: ReturnType<typeof createServices>; loudness: {handlers: Record<string, (...args: never[]) => Promise<LoudnessServiceResult>>; drain(): Promise<void>}; runtime: RuntimeOverrides & {decode: (file: string, duration: number, options: {beforeEffect(): void; signal?: AbortSignal}) => Promise<unknown>; hash: (...args: never[]) => Promise<unknown>}; extras: Array<{drain(): Promise<unknown>}>; project: {id: string}; foreign: {id: string}; timeline: TimelineFixture; record: {snapshot: unknown} & Record<string, unknown>; asset: Record<string, unknown> & {id: string; relativePath: string; sha256: string}; bytes: Buffer; input: {projectId: string; exportId: string; expectedArtifactSha256: string; measurementProfile: string}; intent: {expectedRevision: number} & Record<string, unknown>;
  call(arg?: Record<string, unknown>, options?: {signal?: AbortSignal}): Promise<LoudnessServiceResult>; unchanged(before: FixtureCheckpoint): Promise<void>; checkpoint(): Promise<FixtureCheckpoint>}
async function fixture(t: TestContext, {named = false, range = false, retainTimeline = false, runtime: overrides = {}}: {named?: boolean; range?: boolean; retainTimeline?: boolean; runtime?: RuntimeOverrides} = {}): Promise<BusinessFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-loudness-')), store = openStore(root), services = createServices(store, new Map());
  const project = await services.call('project.create', {name: 'Owned loudness fixture'}) as {id: string}, foreign = await foreignProject(t);
  let timeline = await services.call('timeline.get', {projectId: project.id}) as TimelineFixture;
  const sourceId = randomUUID();
  store.put('assets', {id: sourceId, projectId: project.id, name: 'Original source', mimeType: 'image/png', sha256: 'a'.repeat(64),
    relativePath: `media/${sourceId}.png`, width: 720, height: 1280, duration: 0, hasAudio: false, sizeBytes: 20, createdAt: new Date().toISOString()});
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks[0]!.id, assetId: sourceId, startFrame: 0, durationFrames: range ? 90 : 30}) as TimelineFixture;
  const intent = {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export',
    ...(named ? {deliveryName: '已导出响度文件'} : {}), ...(range ? {exportRange: {startFrame: 30, endFrame: 60}} : {})};
  const queued = await services.call('timeline.render', intent) as {id: string}, assetId = randomUUID();
  const relativePath = `media/export-${queued.id}-${randomUUID()}.mp4`, bytes = Buffer.alloc(96 * 1024, 7);
  await writeFile(path.join(root, relativePath), bytes, {mode: 0o600});
  const asset = {id: assetId, projectId: project.id, name: 'Historical output', mimeType: 'video/mp4', provenance: 'export', relativePath,
    url: `/media/${assetId}`, sha256: sha(bytes), sizeBytes: bytes.length, createdAt: new Date().toISOString()};
  store.put('assets', asset);
  const record = {id: queued.id, ...(store.get('exports', queued.id) as Record<string, unknown>), status: 'succeeded', assetId, url: asset.url, updatedAt: new Date().toISOString()}; store.put('exports', record);
  if (!retainTimeline) {
    store.db.prepare('DELETE FROM timelines WHERE id=?').run(timeline.id); store.db.prepare('DELETE FROM assets WHERE id=?').run(sourceId);
  }
  const runtime: RuntimeOverrides & {decode: (file: string, duration: number, options: {beforeEffect(): void; signal?: AbortSignal}) => Promise<unknown>; hash: (...args: never[]) => Promise<unknown>} = {assertOrdinaryWorkspace: () => {if (getWorkspaceRestoreContext(store)) throw workspaceRestoreError();}, ownsLock: () => ownsStoreLock(store),
    isTimelineRenderRecord, readOwnedAsset: (projectId: string, id: string) => readOwnedTimelineAsset(store.db, projectId, id),
    validateSource: validateManagedSource, hash: verifiedManagedHash as (...args: never[]) => Promise<unknown>, decode: async (_file: string, duration: number, options: {beforeEffect(): void; signal?: AbortSignal}) => {options.beforeEffect(); return measurement(duration);},
    terminate: async () => [], waitForClose: async () => [], boundedShutdown, ...overrides} as RuntimeOverrides & {decode: (file: string, duration: number, options: {beforeEffect(): void; signal?: AbortSignal}) => Promise<unknown>; hash: (...args: never[]) => Promise<unknown>};
  const loudness = createExportLoudnessServices(store, {runtime} as never), extras: Array<{drain(): Promise<unknown>}> = [];
  t.after(async () => {for (const extra of extras) await extra.drain().catch(() => {}); await loudness.drain().catch(() => {}); await services.drain().catch(() => {}); store.close(); await rm(root, {recursive: true, force: true});});
  const input = {projectId: project.id, exportId: record.id, expectedArtifactSha256: asset.sha256, measurementProfile: EXPORT_LOUDNESS_PROFILE};
  const rows = (): Record<string, unknown[]> => Object.fromEntries(schemaObjects(store.db).filter(({type}) => type === 'table').sort(byName).map(({name}) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  return {root, store, services, loudness: loudness as never, runtime, extras, project, foreign, timeline, record: record as unknown as {snapshot: unknown} & Record<string, unknown>, asset: asset as Record<string, unknown> & {id: string; relativePath: string; sha256: string}, bytes, input, intent,
    call: (arg: Record<string, unknown> = input, options?: {signal?: AbortSignal}) => loudness.handlers['timeline.export.loudness'](arg as never, options as never) as unknown as Promise<LoudnessServiceResult>,
    unchanged: async (before: FixtureCheckpoint) => {assert.deepEqual(rows(), before.rows); assert.equal((store.db.prepare('SELECT total_changes() AS n').get() as {n: number}).n, before.writes); assert.deepEqual(await files(root), before.files);},
    checkpoint: async (): Promise<FixtureCheckpoint> => ({rows: rows(), writes: (store.db.prepare('SELECT total_changes() AS n').get() as {n: number}).n, files: await files(root)})};
}
function replace(f: BusinessFixture, table: string, value: Record<string, unknown>) {f.store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), value.id as string);}
function samplePeak(f: BusinessFixture, runtime: Record<string, unknown> = {}): (context?: {signal?: AbortSignal}) => Promise<LoudnessServiceResult> {
  const peak = createExportSamplePeakServices({...f.store} as never, {runtime: {...f.runtime, decode: async (_file: string, duration: number) => {
    const accumulator = createExportSamplePeakAccumulator(duration); accumulator.write(pcm(duration)); return accumulator.finish();
  }, ...runtime} as never});
  f.extras.push(peak as never); return (context?: {signal?: AbortSignal}) => peak.handlers['timeline.export.samplePeak']({projectId: f.input.projectId, exportId: f.input.exportId}, context as never) as unknown as Promise<LoudnessServiceResult>;
}

test('loudness binds two actual hashes and frozen full/ranged delivery without database or file writes', async t => {
  for (const options of [{}, {named: true, range: true}]) await t.test(JSON.stringify(options), async t => {
    const f = await fixture(t, options), before = await f.checkpoint(), result = await f.call();
    assert.ok(isExportLoudnessResponse(result as unknown, f.input)); assert.equal(result.status, 'ready');
    assert.equal(result.checks.bytesHashed, 2 * f.bytes.length); assert.equal(result.artifact.sha256, sha(f.bytes));
    assert.equal(result.artifact.snapshotSha256, floatSnapshotSha256(f.record.snapshot));
    assert.equal(result.artifact.timelineRevision, f.intent.expectedRevision); assert.equal(result.measurement.decodedDurationSeconds, 1);
    assert.equal(Object.hasOwn(result.artifact, 'deliveryName'), Boolean(options.named)); assert.equal(Object.hasOwn(result.artifact, 'exportRange'), Boolean(options.range));
    assert.equal(result.suggestion, null); assert.ok(Object.isFrozen(result.measurement));
    assert.ok(!JSON.stringify(result).includes(f.root) && !JSON.stringify(result).includes(f.asset.relativePath));
    await f.unchanged(before);
  });
});

test('current timeline edits do not invalidate a historical measured export or authorize gain application', async t => {
  const f = await fixture(t, {retainTimeline: true});
  const updated = await f.services.call('timeline.clip.update', {projectId: f.project.id, expectedRevision: f.timeline.revision,
    requestId: randomUUID(), clipId: f.timeline.clips[0]!.id, patch: {durationFrames: 60}}) as {revision: number};
  assert.ok(updated.revision > f.intent.expectedRevision);
  const before = await f.checkpoint(), result = await f.call({...f.input, target: {integratedLufs: -5, truePeakCeilingDbtp: -20}});
  assert.equal(result.status, 'ready'); assert.equal(result.artifact.timelineRevision, f.intent.expectedRevision); assert.equal(result.measurement.decodedDurationSeconds, 1);
  assert.equal(result.suggestion.applyAllowed, false); assert.equal(result.suggestion.currentTimelineValidated, false);
  assert.equal(result.suggestion.requiredGainDb, -5 - result.measurement.integratedLufs); assert.equal(result.suggestion.conflictsWithCeiling, true);
  await f.unchanged(before);
});

test('strict input, hash pin and opaque ownership checks precede every managed file read', async t => {
  let reads = 0, decodes = 0;
  const f = await fixture(t, {runtime: {validateSource: (...args: never[]) => {reads++; return (validateManagedSource as (...rest: never[]) => unknown)(...args);}, decode: async () => {decodes++; return measurement();}}});
  for (const extra of [{path: '/secret'}, {assetId: f.asset.id}, {verified: true}, {timeoutMs: 1}, {target: undefined}, {target: {integratedLufs: -61, truePeakCeilingDbtp: -1}}])
    await assert.rejects(f.call({...f.input, ...extra}), {code: 'VALIDATION_ERROR'});
  await assert.rejects(f.call({...f.input, projectId: f.foreign.id}), {code: 'EXPORT_LOUDNESS_UNAVAILABLE'});
  await assert.rejects(f.call({...f.input, exportId: randomUUID()}), {code: 'EXPORT_LOUDNESS_UNAVAILABLE'});
  const stale = await f.call({...f.input, expectedArtifactSha256: 'f'.repeat(64)});
  assert.equal(stale.status, 'stale'); assert.equal(stale.checks.bytesHashed, 0); assert.equal(stale.measurement, null);
  assert.equal(reads, 0); assert.equal(decodes, 0);
  replace(f, 'assets', {...f.asset, provenance: 'user-import'});
  await assert.rejects(f.call(), {code: 'EXPORT_LOUDNESS_UNAVAILABLE'}); assert.equal(reads, 0);
});

test('same native database serializes loudness and samplePeak in both directions without a queue', async t => {
  for (const first of ['loudness', 'samplePeak']) await t.test(first, async t => {
    const entered = deferred(), gate = deferred(), f = await fixture(t);
    const original = f.runtime.decode;
    const peak = samplePeak(f, first === 'samplePeak' ? {decode: async (_file: string, duration: number, options: {beforeEffect(): void; signal?: AbortSignal}) => {
      entered.resolve(); await gate.promise; options.beforeEffect(); const reducer = createExportSamplePeakAccumulator(duration); reducer.write(pcm(duration)); return reducer.finish();
    }} : {});
    if (first === 'loudness') f.runtime.decode = async (...args: [file: string, duration: number, options: {beforeEffect(): void; signal?: AbortSignal}]) => {entered.resolve(); await gate.promise; return original(...args);};
    const wrapper = createExportLoudnessServices({...f.store} as never, {runtime: f.runtime} as never); f.extras.push(wrapper);
    const pending = first === 'loudness' ? f.call() : peak(); await entered.promise;
    const busy = first === 'loudness' ? await peak() : await wrapper.handlers['timeline.export.loudness'](f.input);
    assert.equal((busy as LoudnessServiceResult).reason.code, 'BUSY'); assert.equal((busy as LoudnessServiceResult).checks.bytesHashed, 0);
    gate.resolve(); assert.equal((await pending).status, 'ready');
  });
});

test('read-only database wrappers cannot claim the writer observation permit', async t => {
  // A second connection waits until the owning store has closed: one process holds a project once.
  // With the owner closed, the reader's own connection answers the workspace check.
  const f = await fixture(t); await f.services.drain(); f.store.close();
  const auxiliary = openStore(f.root, {lock: false}); t.after(() => auxiliary.close());
  const denied = createExportLoudnessServices(auxiliary as never, {runtime: {...f.runtime, assertOrdinaryWorkspace: () => {if (getWorkspaceRestoreContext(auxiliary)) throw workspaceRestoreError();}, ownsLock: () => ownsStoreLock(auxiliary)} as never}); f.extras.push(denied);
  await assert.rejects(denied.handlers['timeline.export.loudness'](f.input), {code: 'EXPORT_LOUDNESS_OWNER_REQUIRED'});
});

test('cancellation retains nonsettled hash and cross-operation admission until exact underlying work settles', async t => {
  const entered = deferred(), gate = deferred(); let decodes = 0, hashes = 0;
  const f = await fixture(t, {runtime: {hash: async (...args: never[]) => {hashes++; entered.resolve(); await gate.promise; return (verifiedManagedHash as (...rest: never[]) => unknown)(...args);}, decode: async () => {decodes++; return measurement();}}});
  const peak = samplePeak(f), controller = new AbortController(), pending = f.call(f.input, {signal: controller.signal}); await entered.promise;
  controller.abort(); const cancelled = await pending as LoudnessServiceResult; assert.equal(cancelled.reason.code, 'CANCELLED'); assert.equal(cancelled.measurement, null);
  assert.equal((await peak() as LoudnessServiceResult).reason.code, 'BUSY'); assert.equal((await f.call() as LoudnessServiceResult).reason.code, 'BUSY');
  assert.equal(hashes, 1); assert.equal(decodes, 0); gate.resolve(); await tick(); await tick();
  assert.equal((await peak() as LoudnessServiceResult).status, 'ready'); assert.equal(decodes, 0);
});

test('one operation deadline covers an outstanding hash and never publishes its late result', async t => {
  const entered = deferred(), gate = deferred(); let decodes = 0;
  const f = await fixture(t, {runtime: {hash: async (...args: never[]) => {entered.resolve(); await gate.promise; return (verifiedManagedHash as (...rest: never[]) => unknown)(...args);}, decode: async () => {decodes++; return measurement();}}});
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = f.call(); await entered.promise; t.mock.timers.tick(EXPORT_LOUDNESS_LIMITS.timeoutMs + 1);
  assert.equal((await pending as LoudnessServiceResult).reason.code, 'TIMEOUT'); assert.equal((await f.call() as LoudnessServiceResult).reason.code, 'BUSY');
  gate.resolve(); await tick(); await tick(); assert.equal(decodes, 0); t.mock.timers.reset();
});

test('metadata, same-size byte and path replacement discard measurement; owner revocation outranks decoder failure', async t => {
  for (const kind of ['metadata', 'bytes', 'symlink', 'foreign', 'lock']) await t.test(kind, async t => {
    let f: BusinessFixture; f = await fixture(t, {runtime: {decode: async () => {
      if (kind === 'metadata') replace(f, 'assets', {...f.asset, name: 'Changed'});
      if (kind === 'bytes') await writeFile(path.join(f.root, f.asset.relativePath), Buffer.alloc(f.bytes.length, 9));
      if (kind === 'symlink') {await unlink(path.join(f.root, f.asset.relativePath)); await symlink(path.join(f.root, 'secret.mp4'), path.join(f.root, f.asset.relativePath));}
      if (kind === 'foreign') withoutForeignKeys(f.store.db, () => f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.foreign.id, JSON.stringify({...f.asset, projectId: f.foreign.id}), f.asset.id));
      if (kind === 'lock') await unlink(path.join(f.root, 'server.lock'));
      throw Object.assign(Error('PRIVATE decoder diagnostic'), {code: 'MEDIA_PROCESS_FAILED'});
    }}});
    if (kind === 'foreign') await assert.rejects(f.call(), {code: 'EXPORT_LOUDNESS_UNAVAILABLE'});
    else if (kind === 'lock') await assert.rejects(f.call(), {code: 'EXPORT_LOUDNESS_OWNER_REQUIRED'});
    else {const result = await f.call(); assert.equal((result as LoudnessServiceResult).reason.code, 'ARTIFACT_CHANGED'); assert.equal(result.measurement, null); assert.ok(!JSON.stringify(result).includes('PRIVATE'));}
  });
});

test('invalid reducer relationships cannot pass as success or trigger the second hash', async t => {
  let hashes = 0;
  const f = await fixture(t, {runtime: {hash: (...args: never[]) => {hashes++; return (verifiedManagedHash as (...rest: never[]) => unknown)(...args);}, decode: async () => ({...measurement(), truePeakDbtp: 0})}});
  const result = await f.call(); assert.equal((result as LoudnessServiceResult).reason.code, 'INVALID_PCM'); assert.equal(hashes, 1); assert.equal(result.measurement, null);
});

test('recorded input size and cumulative hash budgets fail before decode without partial measurements', async t => {
  let reads = 0, decodes = 0;
  const f = await fixture(t, {runtime: {validateSource: (...args: never[]) => {reads++; return (validateManagedSource as (...rest: never[]) => unknown)(...args);},
    decode: async () => {decodes++; return measurement();}}});
  replace(f, 'assets', {...f.asset, sizeBytes: EXPORT_LOUDNESS_LIMITS.inputBytes + 1});
  const tooLarge = await f.call(); assert.equal((tooLarge as LoudnessServiceResult).reason.code, 'INPUT_TOO_LARGE'); assert.equal(reads, 0); assert.equal(decodes, 0);
  replace(f, 'assets', f.asset);
  f.runtime.hash = async (_root: unknown, asset: {sizeBytes: number}, options: {onBytes(bytes: number): void}) => {options.onBytes(asset.sizeBytes * 2 + 1); throw Error('Budget callback must throw');};
  const budget = await f.call(); assert.equal((budget as LoudnessServiceResult).reason.code, 'RESOURCE_LIMIT'); assert.equal(budget.measurement, null); assert.equal(decodes, 0);
});

test('no audio is distinct from silence and still needs the second successful byte hash', async t => {
  for (const tamper of [false, true]) await t.test(String(tamper), async t => {
    let f: BusinessFixture, hashes = 0;
    f = await fixture(t, {runtime: {hash: async (...args: never[]) => {hashes++; if (tamper && hashes === 2) await writeFile(path.join(f.root, f.asset.relativePath), Buffer.alloc(f.bytes.length, 9)); return (verifiedManagedHash as (...rest: never[]) => unknown)(...args);},
      decode: async () => {throw Object.assign(Error('No audio'), {code: 'LOUDNESS_NO_AUDIO'});}}});
    const result = await f.call(); assert.equal((result as LoudnessServiceResult).reason.code, tamper ? 'ARTIFACT_CHANGED' : 'NO_AUDIO');
    assert.equal(result.measurement, null); assert.equal(result.suggestion, null); assert.equal(hashes, 2);
    if (!tamper) assert.equal(result.checks.bytesHashed, f.bytes.length * 2);
  });
  const f = await fixture(t, {runtime: {decode: async () => measurement(1, 0)}}), result = await f.call({...f.input, target: {integratedLufs: -23, truePeakCeilingDbtp: -1}});
  assert.equal(result.status, 'ready'); assert.equal(result.measurement.state, 'digital_silence'); assert.equal(result.measurement.integratedLufs, null); assert.equal(result.suggestion, null);
});

test('restored denial occurs before payload getters or any file/media adapter', async t => {
  const f = await fixture(t); let getters = 0, effects = 0;
  assert.ok(RESTORE_DENIED_OPERATIONS.includes('timeline.export.loudness'));
  const restored = createExportLoudnessServices({...f.store} as never, {runtime: {...f.runtime, assertOrdinaryWorkspace() {throw workspaceRestoreError();},
    validateSource() {effects++;}, decode() {effects++;}} as never}); f.extras.push(restored);
  await assert.rejects(restored.handlers['timeline.export.loudness']({get projectId() {getters++; return f.project.id;}}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  assert.equal(getters, 0); assert.equal(effects, 0);
});

test('actual restored-v1 composition denies loudness before parsing valid or hostile payloads', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-restored-loudness-'));
  let store = openStore(root), services = createServices(store, new Map());
  const project = await services.call('project.create', {name: 'Restored loudness owner'}) as {id: string};
  await services.drain(); store.close();
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
  const metadata = {restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(),
    manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: new Date().toISOString()};
  try {installCurrentWorkspaceRestoreSchema(db, metadata); db.exec('PRAGMA wal_checkpoint(TRUNCATE)');} finally {db.close();}
  store = openStore(root);
  services = createServices(store, new Proxy(new Map(), {get() {throw Error('Must not inspect providers');}}));
  let media = 0, getters = 0; const off = onMediaProcess(() => {media++;});
  t.after(async () => {off(); await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  const beforeFiles = await files(root), beforeChanges = (store.db.prepare('SELECT total_changes() AS n').get() as {n: number}).n;
  const hostile = {get projectId() {getters++; throw Error('Payload access');}, get target() {getters++; throw Error('Payload access');}};
  const valid = {projectId: project.id, exportId: randomUUID(), expectedArtifactSha256: 'c'.repeat(64), measurementProfile: EXPORT_LOUDNESS_PROFILE};
  for (const value of [hostile, valid, null]) {
    await assert.rejects(async () => { await (services.call as unknown as (...args: unknown[]) => unknown)('timeline.export.loudness', value, {expectedWorkspaceOrigin: metadata.workspaceOrigin}); }, {code: 'RESTORE_OPERATION_UNAVAILABLE'});
    await assert.rejects((services.handlers['timeline.export.loudness'] as unknown as (...args: unknown[]) => Promise<unknown>)(value), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  }
  assert.equal(getters, 0); assert.equal(media, 0);
  assert.equal((store.db.prepare('SELECT total_changes() AS n').get() as {n: number}).n, beforeChanges); assert.deepEqual(await files(root), beforeFiles);
});

test('service drain propagates an audioPreview owner rejection after the added loudness owner', async t => {
  const f = await fixture(t), expected = Object.assign(Error('Audio preview cleanup failed'), {code: 'AUDIO_PREVIEW_SHUTDOWN_FAILED'});
  const original = f.services.audioPreview.drain;
  f.services.audioPreview.drain = async () => {throw expected;};
  try {await assert.rejects(f.services.drain(), error => error === expected);}
  finally {f.services.audioPreview.drain = original;}
});

test('actual exact-child registry pins cross-operation cleanup and sticky termination failure through late close', async t => {
  const spawned = deferred<FakeChild>(), waiting = deferred(), controller = new AbortController(); let attemptSignal, cleanupSignal, closeSignal;
  const f = await fixture(t, {runtime: {
    decode: async (_file: string, _duration: number, options: {signal?: AbortSignal; beforeEffect(): void}) => {attemptSignal = options.signal; return runStreaming('ffmpeg', [], {signal: options.signal,
      beforeEffect: options.beforeEffect, onStdout: () => {throw Error('Invalid PCM callback');}});},
    terminate: (signal: AbortSignal) => {cleanupSignal = signal; return terminateMediaProcesses({signal});},
    waitForClose: (signal: AbortSignal) => {closeSignal = signal; waiting.resolve(); return waitForMediaProcesses({signal});},
  }}), peak = samplePeak(f);
  interface FakeChild extends EventEmitter {pid: number; stdout: PassThrough; stderr: PassThrough; kills: NodeJS.Signals[]; refs: number; unrefs: number; kill(signal?: NodeJS.Signals | number): boolean; ref(): FakeChild; unref(): FakeChild}
  const originalSpawn = childProcess.spawn, children: FakeChild[] = [];
  childProcess.spawn = (() => {
    const child = new EventEmitter() as FakeChild; child.pid = 910000 + children.length; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = []; child.refs = 0; child.unrefs = 0;
    child.kill = (signal?: NodeJS.Signals | number) => {child.kills.push(signal as NodeJS.Signals); return true;}; child.ref = () => {child.refs++; return child;}; child.unref = () => {child.unrefs++; return child;};
    children.push(child); queueMicrotask(() => {child.emit('spawn'); if (children.length === 2 && child === children[1]) spawned.resolve(child);}); return child;
  }) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports(); t.mock.timers.enable({apis: ['setTimeout']});
  const restore = () => {for (const child of children) child.emit('close', 0); childProcess.spawn = originalSpawn; syncBuiltinESMExports(); t.mock.timers.reset();}; t.after(restore);
  const unrelatedSignal = new AbortController().signal;
  const unrelated = spawnMedia('ffmpeg', [], {stdio: ['ignore', 'pipe', 'pipe']}, {kind: 'ffmpeg', signal: unrelatedSignal}) as unknown as FakeChild;
  try {
    const pending = f.call(f.input, {signal: controller.signal}), advisory = await spawned.promise;
    advisory.stdout.write(Buffer.from([1])); assert.deepEqual(advisory.kills, ['SIGTERM']); assert.deepEqual(unrelated.kills, []);
    t.mock.timers.tick(3001); await waiting.promise;
    assert.deepEqual(advisory.kills, ['SIGTERM', 'SIGKILL']); assert.equal(hasUnconfirmedMediaProcesses({signal: attemptSignal}), true);
    assert.equal(cleanupSignal, attemptSignal); assert.equal(closeSignal, attemptSignal); assert.notEqual(attemptSignal, controller.signal);
    controller.abort(); await assert.rejects(pending, {code: 'MEDIA_TERMINATION_UNCONFIRMED'});
    await assert.rejects(peak(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'}); assert.equal(children.length, 2);
    const draining = f.loudness.drain(), rejection = assert.rejects(draining, {code: 'EXPORT_LOUDNESS_STOP_TIMEOUT'});
    t.mock.timers.tick(5001); await rejection; assert.equal(hasUnconfirmedMediaProcesses({signal: attemptSignal}), true);
    advisory.emit('exit', 1); advisory.emit('close', 1); await tick(); await tick();
    assert.equal(hasUnconfirmedMediaProcesses({signal: attemptSignal}), false);
    await assert.rejects(f.loudness.drain(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'});
    await assert.rejects(peak(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'});
    assert.deepEqual(unrelated.kills, []); assert.equal(children.length, 2);
  } finally {restore();}
});
