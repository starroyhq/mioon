import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, renameSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {commitProjectAssetHash, registerProjectTransactionFence, registerProjectTransactionObserver} from '../packages/business/src/project-file/store.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import type {MediaReference} from '../packages/contracts/src/media-reference.ts';

const HASH = 'a'.repeat(64), OTHER_HASH = 'b'.repeat(64);
interface Asset extends Record<string, unknown> {
  id: string; projectId: string; name: string; sha256: string | null; sizeBytes: number;
  referenceRevision: number; reference: MediaReference;
}
function fixture(t: TestContext): ProjectStore {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-asset-hash-'));
  const store = openStore(root);
  store.put('projects', {id: store.projectId, name: 'Hash metadata'});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  return store;
}
function asset(store: ProjectStore, fullSha256: string | null = null): Asset {
  const row: Asset = {id: randomUUID(), projectId: store.projectId, name: 'Source', mimeType: 'video/mp4', sizeBytes: 123,
    sha256: fullSha256, referenceRevision: 7, reference: {pathForm: 'relative', path: '素材/视频.mp4', volume: null,
      sizeBytes: 123, mtimeMs: 1000, sampledSha256: 'c'.repeat(64), fullSha256},
    provenance: {kind: 'import'}, producer: {version: 2}, custom: {deep: ['retained', 1]}};
  store.put('assets', row);
  return row;
}
const raw = (store: ProjectStore, id: string): string => String(store.db.prepare('SELECT data FROM project.assets WHERE id=?').get(id)?.data);
const sequence = (store: ProjectStore): number => Number(store.db.prepare('SELECT contentSequence FROM project.project_file').get()?.contentSequence);
const target = (store: ProjectStore, id: string): number => Number(store.db.prepare("SELECT revision FROM project.agent_task_target_revisions_v2 WHERE projectId=? AND kind='asset' AND targetId=?").get(store.projectId, id)?.revision);
const changes = (store: ProjectStore): number => Number(store.db.prepare('SELECT total_changes() AS n').get()?.n);
function commit(store: ProjectStore, row: Asset, overrides: Partial<Parameters<typeof commitProjectAssetHash>[1]> = {}): Record<string, unknown> {
  return commitProjectAssetHash(store, {assetId: row.id, expectedRaw: raw(store, row.id),
    reference: {...row.reference, fullSha256: HASH}, sha256: HASH, ...overrides});
}

test('full hash completion retains all domain fields, calls transaction fences and never domain observers', t => {
  const store = fixture(t), row = asset(store), before = sequence(store), revision = target(store, row.id);
  const events: string[] = [];
  registerProjectTransactionFence(store.db, () => {assert.equal(store.db.isTransaction, true); events.push('fence');});
  registerProjectTransactionObserver(store.db, () => {events.push('domain-observer');});
  const result = commit(store, row, {beforeEffect: () => {events.push(`effect:${store.db.isTransaction}`);}});
  assert.deepEqual(result, {...row, sha256: HASH, reference: {...row.reference, fullSha256: HASH}});
  assert.deepEqual(JSON.parse(raw(store, row.id)), result);
  assert.equal(target(store, row.id), revision);
  assert.equal(sequence(store), before + 1);
  assert.deepEqual(events, ['effect:false', 'fence', 'effect:true', 'effect:true']);
  store.tx(() => 'ordinary domain write');
  assert.equal(events.filter(value => value === 'domain-observer').length, 1);
});

test('same known full hash is a no-op; observing a new mtime changes sequence without changing target revision', t => {
  const store = fixture(t), row = asset(store, HASH), before = sequence(store), revision = target(store, row.id), total = changes(store);
  commit(store, row);
  assert.equal(sequence(store), before);
  assert.equal(changes(store), total);
  commit(store, row, {reference: {...row.reference, mtimeMs: 1001}});
  assert.equal(sequence(store), before + 1);
  assert.equal(target(store, row.id), revision);
  assert.equal(JSON.parse(raw(store, row.id)).reference.mtimeMs, 1001);
});

test('literal JSON CAS retains existing property order and permits original whitespace', t => {
  const store = fixture(t), row = asset(store);
  const formatted = JSON.stringify(row, null, 2);
  store.db.prepare('UPDATE project.assets SET data=? WHERE id=?').run(formatted, row.id);
  const before = target(store, row.id);
  assert.throws(() => commit(store, row, {expectedRaw: JSON.stringify(row)}), {code: 'MEDIA_CHANGED'});
  assert.equal(raw(store, row.id), formatted);
  commit(store, row, {expectedRaw: formatted});
  assert.equal(target(store, row.id), before);
  const completed: Asset = {...row, sha256: HASH, reference: {...row.reference, fullSha256: HASH}};
  const completedRaw = JSON.stringify(completed, null, 2);
  store.db.prepare('UPDATE project.assets SET data=? WHERE id=?').run(completedRaw, row.id);
  const total = changes(store), seq = sequence(store);
  commit(store, completed, {expectedRaw: completedRaw});
  assert.equal(raw(store, row.id), completedRaw);
  assert.equal(changes(store), total);
  assert.equal(sequence(store), seq);
});

test('hash metadata rejects changed location, samples, size, invalid shape and known hash replacement without writes', async t => {
  for (const [name, alter] of Object.entries<((row: Asset) => Partial<Parameters<typeof commitProjectAssetHash>[1]>)>({
    path: row => ({reference: {...row.reference, path: 'other.mp4'}}),
    pathForm: row => ({reference: {...row.reference, pathForm: 'absolute', path: '/elsewhere/source.mp4'}}),
    volume: row => ({reference: {...row.reference, volume: 'another'}}),
    sampledSha256: row => ({reference: {...row.reference, sampledSha256: OTHER_HASH}}),
    size: row => ({reference: {...row.reference, sizeBytes: row.reference.sizeBytes + 1}}),
    invalidMtime: row => ({reference: {...row.reference, mtimeMs: -1}}),
    invalidFull: row => ({reference: {...row.reference, fullSha256: 'sample-is-not-a-full-hash'}}),
    mismatchedFull: row => ({reference: {...row.reference, fullSha256: OTHER_HASH}}),
    knownReplacement: row => ({sha256: OTHER_HASH, reference: {...row.reference, fullSha256: OTHER_HASH}}),
  })) await t.test(name, st => {
    const store = fixture(st), row = asset(store, HASH), previous = raw(store, row.id), seq = sequence(store), total = changes(store);
    assert.throws(() => commit(store, row, alter(row)), {code: 'MEDIA_CHANGED'});
    assert.equal(raw(store, row.id), previous);
    assert.equal(sequence(store), seq);
    assert.equal(changes(store), total);
  });
});

test('exact live owner and exact original asset JSON are required, including changes made by transaction fences', t => {
  const store = fixture(t), row = asset(store), previous = raw(store, row.id), total = changes(store);
  assert.throws(() => commit({...store}, row), {name: 'TypeError'});
  assert.equal(changes(store), total);
  store.put('assets', {...row, name: 'Renamed concurrently'});
  const afterRename = raw(store, row.id), afterChanges = changes(store);
  assert.throws(() => commit(store, row, {expectedRaw: previous}), {code: 'MEDIA_CHANGED'});
  assert.equal(raw(store, row.id), afterRename);
  assert.equal(changes(store), afterChanges);
  const release = registerProjectTransactionFence(store.db, () => {store.put('assets', {...row, name: 'Changed by fence'});});
  assert.throws(() => commit(store, row), {code: 'MEDIA_CHANGED'});
  assert.equal(raw(store, row.id), afterRename);
  release();
  store.close();
  assert.throws(() => commitProjectAssetHash(store, {assetId: row.id, expectedRaw: previous, reference: {...row.reference, fullSha256: HASH}, sha256: HASH}), {name: 'TypeError'});
});

test('abort/effect/transaction fences prevent writes; a late abort rolls back hash and sequence together', t => {
  const store = fixture(t), row = asset(store), previous = raw(store, row.id), seq = sequence(store), total = changes(store);
  let observers = 0;
  registerProjectTransactionObserver(store.db, () => {observers++;});
  const aborted = AbortSignal.abort(new Error('already aborted'));
  assert.throws(() => commit(store, row, {signal: aborted}), {message: 'already aborted'});
  assert.throws(() => commit(store, row, {beforeEffect: () => {throw new Error('effect stopped');}}), {message: 'effect stopped'});
  const release = registerProjectTransactionFence(store.db, () => {throw new Error('transaction stopped');});
  assert.throws(() => commit(store, row), {message: 'transaction stopped'});
  release();
  const early = new AbortController(); let earlyChecks = 0;
  assert.throws(() => commit(store, row, {signal: early.signal, beforeEffect: () => {if (++earlyChecks === 2) early.abort(new Error('before write'));}}), {message: 'before write'});
  assert.equal(changes(store), total);
  const late = new AbortController(); let lateChecks = 0;
  assert.throws(() => commit(store, row, {signal: late.signal, beforeEffect: () => {if (++lateChecks === 3) late.abort(new Error('before commit'));}}), {message: 'before commit'});
  assert.equal(raw(store, row.id), previous);
  assert.equal(sequence(store), seq);
  assert.equal(observers, 0);
  assert.equal(store.db.isTransaction, false);
});

test('a moved project file is refused before hash metadata can be written', t => {
  const store = fixture(t), row = asset(store), previous = raw(store, row.id), moved = `${store.projectFile}.moved`, total = changes(store);
  renameSync(store.projectFile, moved);
  try {
    assert.throws(() => commit(store, row), {code: 'PROJECT_FILE_MOVED'});
    assert.equal(raw(store, row.id), previous);
    assert.equal(changes(store), total);
  } finally {renameSync(moved, store.projectFile);}
});

test('valid portable and platform-specific reference paths all permit derived hash completion without target invalidation', async t => {
  const references: ReadonlyArray<Pick<MediaReference, 'pathForm' | 'path' | 'volume'>> = [
    {pathForm: 'relative', path: '../Source/视频.mp4', volume: null},
    {pathForm: 'relative', path: '../../Source/quote"name.mp4', volume: null},
    {pathForm: 'absolute', path: '/Source/视频.mp4', volume: null},
    {pathForm: 'absolute', path: 'C:\\Source\\视频.mp4', volume: 'Media'},
    {pathForm: 'absolute', path: 'D:/Source/视频.mp4', volume: null},
    {pathForm: 'absolute', path: '\\\\server\\share\\视频.mp4', volume: 'Share'},
  ];
  for (const location of references) await t.test(location.path, st => {
    const store = fixture(st), original = asset(store), row: Asset = {...original, reference: {...original.reference, ...location, mtimeMs: 1000.125}};
    store.put('assets', row);
    const revision = target(store, row.id), seq = sequence(store);
    commit(store, row);
    assert.equal(target(store, row.id), revision);
    assert.equal(sequence(store), seq + 1);
  });
});

test('the content trigger ignores only valid derived hash observations; every semantic or malformed update advances target', async t => {
  const cases: Record<string, (row: Asset) => Record<string, unknown>> = {
    name: row => ({...row, name: 'Renamed'}),
    provenance: row => ({...row, provenance: {kind: 'generated'}}),
    producer: row => ({...row, producer: {version: 3}}),
    path: row => ({...row, reference: {...row.reference, path: '素材/别处.mp4'}}),
    sample: row => ({...row, reference: {...row.reference, sampledSha256: OTHER_HASH}}),
    size: row => ({...row, sizeBytes: 124, reference: {...row.reference, sizeBytes: 124}}),
    referenceRevision: row => ({...row, referenceRevision: row.referenceRevision + 1}),
    replaceKnownHash: row => ({...row, sha256: OTHER_HASH, reference: {...row.reference, fullSha256: OTHER_HASH}}),
    removeKnownHash: row => ({...row, sha256: null, reference: {...row.reference, fullSha256: null}}),
    missingSha: row => {const next: Record<string, unknown> = {...row}; delete next.sha256; return next;},
    missingFull: row => {const ref: Record<string, unknown> = {...row.reference}; delete ref.fullSha256; return {...row, reference: ref};},
    badReference: row => ({...row, reference: null}),
    extraReferenceKey: row => ({...row, reference: {...row.reference, mtimeMs: 1001, untrusted: true}}),
    invalidPath: row => ({...row, reference: {...row.reference, path: 'one/../two.mp4', mtimeMs: 1001}}),
    negativeMtime: row => ({...row, reference: {...row.reference, mtimeMs: -1}}),
    stringMtime: row => ({...row, reference: {...row.reference, mtimeMs: '1000'}}),
    mismatchedHash: row => ({...row, reference: {...row.reference, fullSha256: OTHER_HASH}}),
    invalidRevision: row => ({...row, referenceRevision: null, reference: {...row.reference, mtimeMs: 1001}}),
    mismatchedSize: row => ({...row, sizeBytes: 124, reference: {...row.reference, mtimeMs: 1001}}),
    legacyLocator: row => ({...row, relativePath: 'media/old.mp4', reference: {...row.reference, mtimeMs: 1001}}),
    mismatchedIdentity: row => ({...row, id: randomUUID(), reference: {...row.reference, mtimeMs: 1001}}),
    badOldShape: row => ({...row, sha256: HASH, reference: {...row.reference, fullSha256: HASH, mtimeMs: 1001}}),
  };
  for (const [name, alter] of Object.entries(cases)) await t.test(name, st => {
    const store = fixture(st), row = asset(store, HASH);
    if (name === 'badOldShape') store.db.prepare('UPDATE project.assets SET data=? WHERE id=?').run(JSON.stringify({...row, sha256: null, reference: {...row.reference, fullSha256: null, sizeBytes: -1}}), row.id);
    const revision = target(store, row.id), seq = sequence(store);
    store.db.prepare('UPDATE project.assets SET data=? WHERE id=?').run(JSON.stringify(alter(row)), row.id);
    assert.equal(target(store, row.id), revision + 1, name);
    // Both the asset and its semantic target-revision row are content writes.
    assert.equal(sequence(store), seq + 2, name);
  });
});

test('unchanged malformed source shapes cannot disguise a hash-only update as derived metadata', async t => {
  const corruptions: Record<string, (row: Asset) => Record<string, unknown>> = {
    missingFull: row => {const reference: Record<string, unknown> = {...row.reference}; delete reference.fullSha256; return {...row, reference};},
    missingMtime: row => {const reference: Record<string, unknown> = {...row.reference}; delete reference.mtimeMs; return {...row, reference};},
    nulHashSuffix: row => ({...row, reference: {...row.reference, sampledSha256: `${row.reference.sampledSha256}\0suffix`}}),
    badPath: row => ({...row, reference: {...row.reference, path: 'one/../video.mp4'}}),
    extraReferenceKey: row => ({...row, reference: {...row.reference, untrusted: true}}),
    wrongDeclaredSize: row => ({...row, sizeBytes: row.sizeBytes + 1}),
    unsafeRevision: row => ({...row, referenceRevision: Number.MAX_SAFE_INTEGER + 1}),
    wrongJsonIdentity: row => ({...row, id: randomUUID()}),
  };
  for (const [name, corrupt] of Object.entries(corruptions)) await t.test(name, st => {
    const store = fixture(st), row = asset(store), broken = corrupt(row);
    store.db.prepare('UPDATE project.assets SET data=? WHERE id=?').run(JSON.stringify(broken), row.id);
    const revision = target(store, row.id), seq = sequence(store);
    const reference = broken.reference;
    assert.ok(reference !== null && typeof reference === 'object' && !Array.isArray(reference));
    store.db.prepare('UPDATE project.assets SET data=? WHERE id=?').run(JSON.stringify({...broken, sha256: HASH,
      reference: {...reference, fullSha256: HASH, mtimeMs: 1001}}), row.id);
    assert.equal(target(store, row.id), revision + 1, name);
    assert.equal(sequence(store), seq + 2, name);
  });
});
