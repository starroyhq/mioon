import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import cp from 'node:child_process';
import http from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
import {createOpacityCandidateWorkspaceBackup, restoreOpacityCandidateWorkspaceBackup} from '../packages/business/src/opacity-candidate-backup.ts';
import {reopenRestoredOpacityCandidateApplicationStore} from '../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateLocalDrafts, createRestoredOpacityCandidateLocalDrafts,
  captureOpacityCandidateDraftRequest, captureOpacityRestoredDraftRequest, OPACITY_CANDIDATE_DRAFT_REQUEST_LIMITS,
  OPACITY_RESTORED_DRAFT_REQUEST_LIMITS, OPACITY_RESTORED_LOCAL_DRAFT_FILENAME} from '../packages/business/src/opacity-candidate-local-drafts.ts';
import {clipDraftOpacityRestoredDiskSchema, clipDraftOpacityRestoredWriteSchema, clipDraftOpacityRestoredEnvelopeSchema,
  OPACITY_RESTORED_DRAFT_PROFILE} from '../packages/contracts/src/local-drafts-opacity-restored.ts';
import {clipDraftOpacityCandidateDiskV3Schema} from '../packages/contracts/src/local-drafts-opacity-candidate.ts';
import {LOCAL_DRAFT_LIMITS} from '../packages/contracts/src/local-drafts.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {opacityBackupFixture, hash} from './helpers/opacity-backup-fixture.ts';
import type { URL } from 'url';

// Actual task-owned cold42 -> archive -> independent43. All assets are opaque
// bytes; neither the codec, listener nor provider boundary is entered.
let forbiddenAttempts = 0;
const forbid = () => {forbiddenAttempts++; throw Error('No listener or subprocess is permitted in restored draft fault tests.');};
mock.method(http.Server.prototype, 'listen', forbid);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) mock.method(cp, name, forbid);
syncBuiltinESMExports();
const media: unknown[] = [], off = onMediaProcess(event => media.push(event));
after(() => {off(); mock.restoreAll(); syncBuiltinESMExports(); assert.equal(forbiddenAttempts, 0); assert.deepEqual(media, []);});
const bytes = (value: { ok?: boolean; data?: unknown; clipId?: unknown; revision?: number; draft?: null; projectId?: unknown; timelineId?: unknown; workspaceScope?: unknown; instanceId?: unknown; expectedRevision?: unknown; baseRevision?: unknown; source?: { assetId: unknown; assetSha256: string; }; raw?: unknown; schemaVersion?: number; expectedWorkspaceOrigin?: unknown; }) => Buffer.byteLength(JSON.stringify(value));
const code = (expected: string) => (error: { code: unknown; message: string|string[]; }) => (error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure)?.code === expected && !(error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).message.includes('PRIVATE_FAULT');
const unavailable = (error: { code: string; }) => ['LOCAL_DRAFT_STORAGE_UNAVAILABLE', 'LOCAL_DRAFT_SCOPE_MISMATCH'].includes((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure)?.code);
const count = (value: unknown) => 1 + (value && typeof value === 'object' ? Object.values(value).reduce((total, item) => total + count(item), 0) : 0);

async function fixture(t: unknown) {
  const f = await (opacityBackupFixture(t) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupFixture>);
  await (createOpacityCandidateWorkspaceBackup({source: f.source, destination: f.backup}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupResult>);
  const restored = await (restoreOpacityCandidateWorkspaceBackup({directory: f.backup, destination: f.destination}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityRestoreResult>);
  let store: import('./helpers/strict-timeline-core-types.ts').FixtureStore, drafts: import("./helpers/strict-opacity-fixture-types.ts").RestoredOpacityDrafts, fault: (point:unknown)=>void = () => {}, controller: AbortController;
  const key = {projectId: f.projectId, timelineId: f.timelineId, clipId: f.clipId};
  const wire = {schemaVersion: 1, expectedWorkspaceOrigin: restored.workspaceOrigin};
  const open = () => {
    store = (reopenRestoredOpacityCandidateApplicationStore(f.destination) as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureStore); f.stores.push(store);
    controller = new AbortController(); drafts = (createRestoredOpacityCandidateLocalDrafts as unknown as (...args:Parameters<typeof createRestoredOpacityCandidateLocalDrafts>)=>import('./helpers/strict-opacity-fixture-types.ts').RestoredOpacityDrafts)(store, {signal: controller.signal, fault: point => fault(point)});
  };
  open();
  const raw = {...f.draft.draft.raw, name: 'New-origin unfinished 界', opacityEnvelope: {profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: '0', opacity: '.'}, {frame: '30', opacity: '1'}]}};
  return {...f, restored, key, wire, raw, file: path.join(f.destination, OPACITY_RESTORED_LOCAL_DRAFT_FILENAME),
    get store() {return store;}, get drafts() {return drafts;}, get controller() {return controller;},
    readKey: {...key, ...wire}, listKey: {projectId: f.projectId, ...wire},
    setFault(value: { (at: unknown): void; (): void; (point: unknown): void; (point: unknown): void; (): void; (point: unknown): void; (): void; (): void; }) {fault = value;},
    reopen() {store!.close(); open();},
    input(response = drafts.get({...key, ...wire}), patch = {}) {
      return {...key, ...wire, workspaceScope: response.workspaceScope, instanceId: response.instanceId, expectedRevision: response.revision,
        baseRevision: f.timeline.revision, source: {assetId: f.assetId, assetSha256: hash(f.mediaBytes)}, raw, ...patch};
    },
    deletion(response: { workspaceScope: unknown; instanceId: unknown; revision: unknown; }) {return {...key, ...wire, workspaceScope: response.workspaceScope, instanceId: response.instanceId, expectedRevision: response.revision};},
    snapshot() {
      return JSON.stringify(['projects', 'assets', 'timelines', 'timeline_history', 'timeline_requests', 'edit_tasks', 'exports', 'workspace_restore_holds',
        'workspace_restore_evidence', 'workspace_restoration'].map(table => [table, store!.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    },
  };
}
function disk(f: Awaited<ReturnType<typeof fixture>>) {return JSON.parse((fs.readFileSync(f.file, 'utf8') as string));}
function writeDisk(f: Awaited<ReturnType<typeof fixture>>, value: unknown) {fs.writeFileSync(f.file, JSON.stringify(value) + '\n', {mode: 0o600});}
function sizedRow<T extends {draft:{updatedAt:string}|null}>(row: T, size: number) {
  const value = structuredClone(row), delta = size - bytes((value as unknown as Parameters<typeof bytes>[0])); assert.ok(delta >= 0);
  value.draft!.updatedAt = '2026-10-16T00:00:00.' + '0'.repeat(3 + delta) + 'Z';
  assert.equal(bytes((value as unknown as Parameters<typeof bytes>[0])), size); return value;
}

test('restored companion rejects corrupt UTF8/JSON, duplicate decoded keys, foreign metadata and unknown versions without resetting bytes', async t => {
  const f = await fixture(t), input = f.input(), saved = f.drafts.put(input), value = disk(f), baseline = f.snapshot();
  assert.equal(clipDraftOpacityRestoredEnvelopeSchema.safeParse(saved).success, true);
  const malformed = [Buffer.from([0xff]), '{', JSON.stringify({...value, version: 2}), JSON.stringify({...value, profileId: 'mioon-opacity-restored-draft-v999'}),
    JSON.stringify({...value, workspaceOrigin: randomUUID()}), JSON.stringify({...value, workspaceScope: 'b'.repeat(64)}), JSON.stringify({...value, extra: true}),
    JSON.stringify({...value, entries: [value.entries[0], value.entries[0]]}),
    JSON.stringify(value).replace('"version":1', '"version":999,"version":1'),
    JSON.stringify(value).replace('"name":', '"name":"shadow","\\u006eame":')];
  for (const contents of malformed) {
    fs.writeFileSync(f.file, contents, {mode: 0o600}); const before = fs.readFileSync(f.file);
    for (const call of [() => f.drafts.get(f.readKey), () => f.drafts.list(f.listKey), () => f.drafts.put(input), () => f.drafts.discard(f.deletion((((saved!)))))] as const)
      assert.throws(call, unavailable);
    assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.snapshot(), baseline);
  }
});

test('new43 file never reads or upgrades v1/v3; copied valid43 disk cannot acquire another restoration origin', async t => {
  const f = await fixture(t), legacy = path.join(f.destination, 'local-drafts-v1.json'), v3 = path.join(f.destination, 'local-drafts-v3.json');
  fs.writeFileSync(legacy, 'PRIVATE old v1 bytes\n', {mode: 0o600}); fs.writeFileSync(v3, f.draftBytes, {mode: 0o600});
  const saved = f.drafts.put(f.input()), original = fs.readFileSync(f.file);
  assert.equal(disk(f).version, 1); assert.equal(disk(f).profileId, OPACITY_RESTORED_DRAFT_PROFILE);
  assert.equal(clipDraftOpacityCandidateDiskV3Schema.safeParse(disk(f)).success, false);
  assert.deepEqual((createOpacityCandidateLocalDrafts as unknown as (...args:Parameters<typeof createOpacityCandidateLocalDrafts>)=>import('./helpers/strict-opacity-fixture-types.ts').OpacityDrafts)(f.store).get(f.key), {supported: false, reason: 'RESTORED_WORKSPACE_UNSUPPORTED'});
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'PRIVATE old v1 bytes\n'); assert.deepEqual(fs.readFileSync(v3), f.draftBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'local-drafts-v3.json')), f.draftBytes);
  const destination = path.join(f.base, 'second-restored43'), second = await (restoreOpacityCandidateWorkspaceBackup({directory: f.backup, destination}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityRestoreResult>);
  assert.notEqual(second.workspaceOrigin, f.restored.workspaceOrigin);
  const store = reopenRestoredOpacityCandidateApplicationStore(destination); f.stores.push(store);
  const drafts = (createRestoredOpacityCandidateLocalDrafts as unknown as (...args:Parameters<typeof createRestoredOpacityCandidateLocalDrafts>)=>import('./helpers/strict-opacity-fixture-types.ts').RestoredOpacityDrafts)(store), key = {...f.key, schemaVersion: 1, expectedWorkspaceOrigin: second.workspaceOrigin};
  fs.copyFileSync(f.file, path.join(destination, OPACITY_RESTORED_LOCAL_DRAFT_FILENAME));
  assert.throws(() => drafts.get(key), code('LOCAL_DRAFT_SCOPE_MISMATCH'));
  assert.deepEqual(fs.readFileSync(path.join(destination, OPACITY_RESTORED_LOCAL_DRAFT_FILENAME)), original);
  assert.deepEqual(fs.readFileSync(f.file), original); assert.equal(saved.revision, 1);
});

test('private restored companion rejects symlink, hardlink, public mode and directory targets without touching referents', async t => {
  for (const kind of ['symlink', 'hardlink', 'mode', 'directory'] as const) {
    const f = await fixture(t), input = f.input(); f.drafts.put(input);
    const original = fs.readFileSync(f.file), sentinel = path.join(f.base, `preserved-${kind}.json`);
    if (kind === 'symlink') {fs.renameSync(f.file, sentinel); fs.symlinkSync(sentinel, f.file);}
    if (kind === 'hardlink') fs.linkSync(f.file, sentinel);
    if (kind === 'mode') fs.chmodSync(f.file, 0o644);
    if (kind === 'directory') {fs.renameSync(f.file, sentinel); fs.mkdirSync(f.file, {mode: 0o700});}
    const before = f.snapshot(); assert.throws(() => f.drafts.get(f.readKey), code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));
    assert.throws(() => f.drafts.put(input), code('LOCAL_DRAFT_STORAGE_UNAVAILABLE')); assert.equal(f.snapshot(), before);
    assert.deepEqual(fs.readFileSync(['symlink', 'directory'].includes(kind) ? sentinel : f.file), original);
  }
});

test('8KiB row boundary and complete success envelope retain every byte, while 8193 is refused', async t => {
  const f = await fixture(t); f.drafts.put(f.input()); const value = disk(f), row = value.entries[0], baseline = f.snapshot();
  for (const size of [8191, 8192, 8193] as const) {
    const sized = sizedRow(row, size); writeDisk(f, {...value, entries: [sized]}); const before = fs.readFileSync(f.file);
    assert.equal(clipDraftOpacityRestoredDiskSchema.safeParse(disk(f)).success, true, 'typed field validity alone is not aggregate admission');
    if (size <= 8192) {
      const response = f.drafts.get(f.readKey); assert.deepEqual(response.draft, sized.draft);
      assert.ok(bytes({ok: true, data: response}) < LOCAL_DRAFT_LIMITS.httpBytes);
      assert.equal(f.drafts.list(f.listKey).items.length, 1);
    } else for (const call of [() => f.drafts.get(f.readKey), () => f.drafts.list(f.listKey), () => f.drafts.put(f.input())] as const) assert.throws(call, code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));
    assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.snapshot(), baseline);
  }
});

test('128 complete8KiB slots fit disk and preserve tombstones; a129th slot cannot evict retained evidence', async t => {
  const f = await fixture(t); f.drafts.put(f.input()); const value = disk(f), maximum = sizedRow(value.entries[0], 8192);
  const entries = Array.from({length: 128}, () => ({...structuredClone(maximum), clipId: randomUUID()}));
  writeDisk(f, {...value, entries}); const full = fs.readFileSync(f.file);
  assert.equal(full.length, bytes({...value, entries: []}) + 128 * 8192 + 127 + 1);
  assert.ok(full.length < LOCAL_DRAFT_LIMITS.envelopeBytes); assert.equal(f.drafts.list(f.listKey).items.length, 128);
  const tombstone = {...f.key, clipId: entries[127].clipId, revision: Number.MAX_SAFE_INTEGER, draft: null}; entries[127] = tombstone;
  writeDisk(f, {...value, entries}); const mixed = fs.readFileSync(f.file), before = f.snapshot();
  assert.equal(f.drafts.list(f.listKey).items.length, 127);
  // The original live clip has no slot among these retained, missing targets.
  // It is a valid new129th key without changing any business record.
  const response = f.drafts.get(f.readKey), input = f.input(response);
  assert.throws(() => f.drafts.put(input), code('LOCAL_DRAFT_CAPACITY')); assert.deepEqual(fs.readFileSync(f.file), mixed);
  assert.deepEqual(disk(f).entries[127], tombstone);
  assert.equal(f.snapshot(), before);
  t.diagnostic(JSON.stringify({maximum128RowsDiskBytes: full.length, mixed127RowsAndTombstoneBytes: mixed.length, tombstoneBytes: bytes(tombstone)}));
  writeDisk(f, {...value, entries: [...entries, {...tombstone, clipId: randomUUID()}]}); const overflow = fs.readFileSync(f.file);
  assert.throws(() => f.drafts.get(f.readKey), code('LOCAL_DRAFT_STORAGE_UNAVAILABLE')); assert.deepEqual(fs.readFileSync(f.file), overflow);
});

test('2MiB private disk admission counts original whitespace and never rewrites padded or oversized files', async t => {
  const f = await fixture(t), response = f.drafts.get(f.readKey), value = {version: 1, profileId: OPACITY_RESTORED_DRAFT_PROFILE,
    workspaceOrigin: f.restored.workspaceOrigin, workspaceScope: response.workspaceScope, entries: []}, text = JSON.stringify(value), before = f.snapshot();
  for (const size of [2097151, 2097152, 2097153] as const) {
    const contents = text + ' '.repeat(size - Buffer.byteLength(text) - 1) + '\n'; fs.writeFileSync(f.file, contents, {mode: 0o600});
    assert.equal(fs.statSync(f.file).size, size);
    if (size <= 2097152) {assert.equal(f.drafts.get(f.readKey).draft, null); assert.deepEqual(f.drafts.list(f.listKey).items, []);}
    else assert.throws(() => f.drafts.get(f.readKey), code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));
    assert.equal(fs.readFileSync(f.file, 'utf8'), contents); assert.equal(f.snapshot(), before);
  }
});

function maximumRequest(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID(), assetSha256 = hash(f.mediaBytes), profileId = 'jfif-ycbcr8-srgb-v1', number = '\u0001'.repeat(48);
  return f.input(undefined, {baseRevision: Number.MAX_SAFE_INTEGER, expectedRevision: Number.MAX_SAFE_INTEGER - 1,
    source: {assetId: f.assetId, assetSha256, versionId: id, shotId: id, jobId: id},
    raw: {name: '\u0001'.repeat(200), trackId: f.trackId, startFrame: number, durationFrames: number, sourceInFrame: number,
      rect: {x: number, y: number, width: number, height: number}, gain: number, fadeInFrames: number, fadeOutFrames: number, audioRole: 'human',
      volumeEnvelope: {profileId: 'mioon-clip-linear-attenuation-v1', points: Array.from({length: 16}, () => ({frame: '9'.repeat(8), multiplier: '9'.repeat(32)}))},
      opacityEnvelope: {profileId: 'mioon-clip-linear-opacity-v1', points: Array.from({length: 7}, () => ({frame: '9'.repeat(8), opacity: '9'.repeat(32)}))},
      colour: {profileId: 'mioon-jfif-image-clip-v1', source: {assetSha256, profileId, interpretation: 'srgb', declaredBy: 'user', declaredAt: '2026-10-16T00:00:00.' + '0'.repeat(19) + 'Z',
        evidence: {profileId, sha256: assetSha256, sourceByteLength: 33554432, width: 1920, height: 1080, bitDepth: 8, alphaMode: 'opaque', orientation: 1, colourTag: 'untagged', sampling: '420', decoderPolicy: 'ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1'}},
      look: {resourceId: id, resourceSha256: assetSha256, resourceProfile: 'mioon-cube3d-normalized-tetrahedral-v1', purpose: 'rec709-sdr-creative', declaredBy: 'user', enabled: false, strength: 1.2345678901234567e-100}}}});
}
test('full134-node43 request keeps old132-node admission unchanged; node135 and12KiB overflow never persist', async t => {
  const f = await fixture(t), input = maximumRequest(f), capture = captureOpacityRestoredDraftRequest(input);
  assert.equal(clipDraftOpacityRestoredWriteSchema.safeParse(input).success, true);
  assert.equal(count(input), 134); assert.equal(capture.nodes, 134); assert.equal(capture.bytes, bytes(input)); assert.ok(capture.bytes < 12288);
  assert.deepEqual(OPACITY_RESTORED_DRAFT_REQUEST_LIMITS, {nodes: 134, depth: 8}); assert.deepEqual(OPACITY_CANDIDATE_DRAFT_REQUEST_LIMITS, {nodes: 132, depth: 8});
  const {schemaVersion: _schemaVersion, expectedWorkspaceOrigin: _origin, ...original} = input;
  assert.equal(captureOpacityCandidateDraftRequest(original).nodes, 132);
  assert.throws(() => captureOpacityCandidateDraftRequest(input), code('LOCAL_DRAFT_VALIDATION'));
  assert.throws(() => captureOpacityRestoredDraftRequest({...input, extra: true}), code('LOCAL_DRAFT_VALIDATION'));
  const large = f.input(undefined, {raw: {...f.raw, name: '\u0001'.repeat(2048)}}); assert.ok(bytes(large) > 12288);
  const before = f.snapshot(); assert.throws(() => f.drafts.put(large), code('LOCAL_DRAFT_LIMIT')); assert.equal(fs.existsSync(f.file), false); assert.equal(f.snapshot(), before);
  t.diagnostic(JSON.stringify({requestNodes: capture.nodes, requestBytes: capture.bytes, requestDepth: capture.depth,
    rowBytes: LOCAL_DRAFT_LIMITS.rowBytes, httpBytes: LOCAL_DRAFT_LIMITS.httpBytes, diskBytes: LOCAL_DRAFT_LIMITS.envelopeBytes, slots: LOCAL_DRAFT_LIMITS.slots}));
});

test('PUT and discard preserve prepublication bytes and expose postpublication faults as uncertain with exact replay', async t => {
  for (const method of ['put', 'discard'] as const) for (const point of ['beforePersist', 'afterPersist', 'beforeDirectorySync', 'afterDirectorySync'] as const) {
    const f = await fixture(t), saved = f.drafts.put(f.input()), input = method === 'put' ? f.input(saved, {raw: {...f.raw, name: `Fault ${point}`}}) : f.deletion((((saved!))));
    const before = fs.readFileSync(f.file), baseline = f.snapshot();
    f.setFault((((at: string) => {if (at === point) throw Error('PRIVATE_FAULT synthetic publication stop');}) as unknown as Parameters<typeof f.setFault>[0]));
    assert.throws(() => f.drafts[method](input), code(point === 'beforePersist' ? 'LOCAL_DRAFT_STORAGE_UNAVAILABLE' : 'LOCAL_DRAFT_SAVE_UNCERTAIN'));
    if (point === 'beforePersist') assert.deepEqual(fs.readFileSync(f.file), before);
    else {assert.equal(disk(f).entries[0].revision, 2); assert.equal(disk(f).entries[0].draft === null, method === 'discard');}
    f.setFault(() => {}); const accepted = f.drafts[method](input), exact = fs.readFileSync(f.file);
    assert.equal(accepted.revision, 2); assert.equal(accepted.draft === null, method === 'discard');
    assert.deepEqual(f.drafts[method](input), accepted); assert.deepEqual(fs.readFileSync(f.file), exact); assert.equal(f.snapshot(), baseline);
  }
});

test('first unpublished PUT cannot create a file; uncertain ACK survives reopen and stale instance cannot overwrite it', async t => {
  const f = await fixture(t), input = f.input(), baseline = f.snapshot();
  f.setFault((((point: string) => {if (point === 'beforePersist') throw Error('PRIVATE_FAULT before first publish');}) as unknown as Parameters<typeof f.setFault>[0]));
  assert.throws(() => f.drafts.put(input), code('LOCAL_DRAFT_STORAGE_UNAVAILABLE')); assert.equal(fs.existsSync(f.file), false);
  f.setFault((((point: string) => {if (point === 'afterPersist') throw Error('PRIVATE_FAULT after first publish');}) as unknown as Parameters<typeof f.setFault>[0]));
  assert.throws(() => f.drafts.put(input), code('LOCAL_DRAFT_SAVE_UNCERTAIN')); const exact = fs.readFileSync(f.file);
  f.setFault(() => {}); f.reopen(); const recovered = f.drafts.get(f.readKey);
  assert.equal(recovered.revision, 1); assert.deepEqual(recovered.draft!.raw, input.raw); assert.notEqual(recovered.instanceId, input.instanceId);
  assert.equal(recovered.workspaceScope, input.workspaceScope); assert.deepEqual(fs.readFileSync(f.file), exact);
  assert.throws(() => f.drafts.put(input), code('LOCAL_DRAFT_STALE_INSTANCE'));
  assert.equal(f.drafts.put(f.input(recovered, {raw: {...f.raw, name: 'Explicit after reread'}})).revision, 2); assert.equal(f.snapshot(), baseline);
});

test('directory fsync failure is uncertain even when atomic helper already returned; exact replay also rechecks durability', async t => {
  const f = await fixture(t), saved = f.drafts.put(f.input()), input = f.input(saved, {raw: {...f.raw, name: 'Directory sync unknown'}});
  const original = fs.fsyncSync; let armed = false, failedDirectorySyncs = 0;
  f.setFault((((point: string) => {if (point === 'beforeDirectorySync') armed = true;}) as unknown as Parameters<typeof f.setFault>[0]));
  fs.fsyncSync = function(fd) {if (armed && fs.fstatSync(fd).isDirectory()) {failedDirectorySyncs++; throw Error('PRIVATE_FAULT directory fsync');} return original(fd);};
  syncBuiltinESMExports();
  try {assert.throws(() => f.drafts.put(input), code('LOCAL_DRAFT_SAVE_UNCERTAIN')); assert.equal(disk(f).entries[0].revision, 2);
    const exact = fs.readFileSync(f.file); assert.throws(() => f.drafts.put(input), code('LOCAL_DRAFT_SAVE_UNCERTAIN')); assert.deepEqual(fs.readFileSync(f.file), exact);}
  finally {fs.fsyncSync = original; syncBuiltinESMExports(); f.setFault(() => {});}
  assert.equal(failedDirectorySyncs, 2); assert.equal(f.drafts.put(input).revision, 2);
});

test('atomic writer refuses replaced destination and staged inode, preserving foreign replacement instead of cleanup', async t => {
  for (const replaced of ['destination', 'temporary'] as const) {
    const f = await fixture(t), saved = f.drafts.put(f.input()), input = f.input(saved, {raw: {...f.raw, name: `Rejected ${replaced}`}}), before = fs.readFileSync(f.file);
    const originalOpen = fs.openSync, originalSync = fs.fsyncSync, originalClose = fs.closeSync;
    let temporary!: string|number|URL|Buffer<ArrayBufferLike>, temporaryFd: number, altered = false;
    fs.openSync = function(file, flags, ...args) {const fd = originalOpen(file, flags, ...args);
      if (typeof file === 'string' && file.startsWith(path.join(f.destination, `.${OPACITY_RESTORED_LOCAL_DRAFT_FILENAME}.`)) && file.endsWith('.tmp')) {temporary = file; temporaryFd = fd;} return fd;};
    fs.fsyncSync = function(fd) {
      const result = originalSync(fd);
      if (fd === temporaryFd && replaced === 'destination' && !altered) {altered = true; fs.renameSync(f.file, path.join(f.base, 'retained-old-draft.json')); fs.writeFileSync(f.file, 'foreign replacement must survive', {mode: 0o600});}
      return result;
    };
    fs.closeSync = function(fd) {
      const result = originalClose(fd);
      if (fd === temporaryFd && replaced === 'temporary' && !altered) {altered = true; fs.renameSync((temporary as unknown as Parameters<typeof fs.renameSync>[0]), path.join(f.base, 'retained-original-stage.json')); fs.writeFileSync(temporary, 'foreign staged inode must survive', {mode: 0o600});}
      return result;
    };
    syncBuiltinESMExports();
    try {assert.throws(() => f.drafts.put(input), code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));}
    finally {fs.openSync = originalOpen; fs.fsyncSync = originalSync; fs.closeSync = originalClose; syncBuiltinESMExports();}
    assert.equal(altered, true);
    if (replaced === 'destination') {assert.equal(fs.readFileSync(f.file, 'utf8'), 'foreign replacement must survive'); assert.deepEqual(fs.readFileSync(path.join(f.base, 'retained-old-draft.json')), before);}
    else {assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(fs.readFileSync(temporary, 'utf8'), 'foreign staged inode must survive');}
  }
});
