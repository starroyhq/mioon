import {testEnv} from './helpers/test-env.ts';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {admitMedia, computeFullSha256, mediaMtimeMs, referenceForFile} from '../packages/business/src/media-reference/index.ts';
import type {MediaReference} from '../packages/contracts/src/media-reference.ts';
import {assetMediaStateSchema} from '../packages/contracts/src/asset-media.ts';
import {createProjectAssetReferenceServices, mediaFingerprintToken, PROJECT_ASSET_REFERENCE_LIMITS} from '../packages/business/src/project-asset-references.ts';

const MIB = 1024 * 1024;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const png = (length = 128): Buffer => {
  const bytes = randomBytes(length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  return bytes;
};
const mp4 = (length = 128): Buffer => {
  const bytes = randomBytes(length);
  Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]).copy(bytes);
  return bytes;
};
const wav = (length = 128): Buffer => {
  const bytes = randomBytes(length);
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(length - 8, 4); bytes.write('WAVEfmt ', 8, 'ascii');
  return bytes;
};

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-asset-reference-'));
  const projectDir = path.join(root, 'project'), outside = path.join(root, 'outside');
  mkdirSync(projectDir, {mode: 0o755}); mkdirSync(outside, {mode: 0o755});
  const store = openStore(projectDir), app = openAppLibrary({dataDir: path.join(root, 'app')});
  store.put('projects', {id: store.projectId, name: 'Reference foundation'});
  const service = createProjectAssetReferenceServices(store, {outsidePaths: app.outsidePaths});
  t.after(() => {store.close(); app.close(); rmSync(root, {recursive: true, force: true});});
  const access = {projectDir, projectFile: store.projectFile, mayReadOutside: () => true};
  function file(name: string, bytes: Buffer, directory = projectDir) {
    mkdirSync(directory, {recursive: true, mode: 0o755});
    const nameOnDisk = path.join(directory, name);
    writeFileSync(nameOnDisk, bytes);
    return nameOnDisk;
  }
  function confirm(directory: string) {
    app.outsidePaths.confirm({projectId: store.projectId, directory: realpathSync(directory), confirmedAt: '2026-11-03T00:00:00.000Z'});
  }
  async function asset(file: string, whole = false) {
    const media = await referenceForFile(access, file);
    const reference = whole ? (await computeFullSha256(access, media.reference)).reference : media.reference;
    const value = {id: randomUUID(), projectId: store.projectId, name: path.basename(file), mimeType: media.type.mimeType,
      sizeBytes: reference.sizeBytes, sha256: reference.fullSha256, referenceRevision: 1, reference, provenance: 'user-import'};
    store.put('assets', value);
    return value;
  }
  return {root, store, app, service, projectDir, outside, access, file, asset, confirm};
}

test('the bridge accepts only the exact live project owner and has no managed-path fallback', async t => {
  const f = fixture(t), source = f.file('clip.mp4', mp4());
  const asset = await f.asset(source);
  assert.throws(() => createProjectAssetReferenceServices({...f.store}, {outsidePaths: f.app.outsidePaths}), TypeError);
  const old = {id: randomUUID(), projectId: f.store.projectId, name: 'managed', mimeType: 'video/mp4', relativePath: 'media/clip.mp4', sha256: 'a'.repeat(64)};
  f.store.db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(old.id, old.projectId, JSON.stringify(old));
  await assert.rejects(f.service.resolve(old.id), {code: 'MEDIA_REFERENCE_INVALID', details: {assetId: old.id, reason: 'asset'}});
  f.store.close();
  await assert.rejects(f.service.inspect(asset.id), TypeError);
});

test('ancestor directory aliases use the live project real directory for permission fences', async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-asset-alias-'));
  const actual = path.join(root, 'actual-project'), alias = path.join(root, 'project-link');
  mkdirSync(actual, {mode: 0o755}); symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const store = createProjectStore({projectFile: path.join(alias, 'Film.mioon'), locate: () => ({
    localDir: path.join(root, 'private', 'local'), cacheDir: path.join(root, 'private', 'cache'), tempDir: path.join(root, 'private', 'temp'),
  })});
  const app = openAppLibrary({dataDir: path.join(root, 'app')});
  t.after(() => {store.close(); app.close(); rmSync(root, {recursive: true, force: true});});
  assert.equal(lstatSync(store.projectFile).isSymbolicLink(), false);
  assert.notEqual(store.projectDir, realpathSync(store.projectDir));
  store.put('projects', {id: store.projectId, name: 'Project through directory link'});
  const bytes = mp4(2 * MIB), source = path.join(actual, 'clip.mp4'); writeFileSync(source, bytes);
  const reference = (await referenceForFile({projectDir: store.projectDir, projectFile: store.projectFile, mayReadOutside: () => false}, source)).reference;
  const asset = {id: randomUUID(), projectId: store.projectId, mimeType: 'video/mp4', sizeBytes: reference.sizeBytes,
    reference, referenceRevision: 1, sha256: reference.fullSha256};
  store.put('assets', asset);
  const service = createProjectAssetReferenceServices(store, {outsidePaths: app.outsidePaths});
  assert.equal((await service.inspect(asset.id)).outside, false);
  assert.equal((await service.resolve(asset.id)).file, source);
  assert.equal((await service.prepareFullHash(asset.id)).sha256, hash(bytes));
  assert.deepEqual((await service.read(asset.id, {maxBytes: bytes.length})).bytes, bytes);
  assert.equal((await service.referenceForImport(source)).file, source);
  assert.deepEqual(app.outsidePaths.list(store.projectId), []);
  let removed = false;
  try {
    await assert.rejects(service.read(asset.id, {maxBytes: bytes.length, onBytes: () => {
      if (!removed) {rmSync(alias); removed = true;}
    }}), {code: 'MEDIA_MISSING', details: {assetId: asset.id, reason: 'project-directory'}});
  } finally {if (removed) symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');}
});

test('image and audio import references get full hashes; video stays sampled without a metadata write', async t => {
  const f = fixture(t), image = png(2 * MIB), audio = wav(2 * MIB), video = mp4(2 * MIB);
  for (const [name, bytes, expectedFull] of [['image.png', image, true], ['sound.wav', audio, true], ['clip.mp4', video, false]] as const) {
    const source = f.file(name, bytes);
    const before = lstatSync(source, {bigint: true}), rows = f.store.db.prepare('SELECT count(*) AS n FROM assets').get()!.n;
    const prepared = await f.service.referenceForImport(source);
    assert.equal(prepared.reference.fullSha256, expectedFull ? hash(bytes) : null, name);
    assert.notEqual(prepared.reference.sampledSha256, hash(bytes));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM assets').get()!.n, rows);
    assert.deepEqual(readFileSync(source), bytes); assert.equal(lstatSync(source, {bigint: true}).mtimeNs, before.mtimeNs);
  }
  await assert.rejects(f.service.referenceForImport(f.file('too-large.png', image), {maxBytes: 1024}), {code: 'MEDIA_REFERENCE_INVALID', details: {reason: 'size-limit'}});
});

test('states describe online, missing and changed references without leaking local paths', async t => {
  const f = fixture(t), bytes = mp4(), source = f.file('clip.mp4', bytes), asset = await f.asset(source);
  const online = await f.service.inspect(asset.id);
  assert.equal(assetMediaStateSchema.safeParse(online).success, true);
  assert.equal(online.status, 'online'); assert.equal(online.readable, true); assert.equal(online.reason, 'same-stats');
  assert.equal(JSON.stringify(online).includes(f.root), false);
  rmSync(source);
  assert.equal((await f.service.inspect(asset.id)).status, 'missing');
  await assert.rejects(f.service.resolve(asset.id), {code: 'MEDIA_MISSING', details: {assetId: asset.id, reason: 'not-found'}});
  writeFileSync(source, Buffer.concat([bytes, Buffer.from('changed')]));
  const changed = await f.service.inspect(asset.id);
  assert.equal(changed.status, 'changed'); assert.equal(changed.reason, 'size');
  await assert.rejects(f.service.resolve(asset.id), {code: 'MEDIA_CHANGED', details: {assetId: asset.id, reason: 'size'}});
});

test('external grants are project-scoped exact directories, dynamically revoked and never written by reads', async t => {
  const f = fixture(t), direct = await f.asset(f.file('direct.mp4', mp4(), f.outside));
  const childDir = path.join(f.outside, 'child'), child = await f.asset(f.file('child.mp4', mp4(), childDir));
  const initial = await f.service.inspect(direct.id);
  assert.equal(initial.status, 'online'); assert.equal(initial.outside, true); assert.equal(initial.readable, false);
  await assert.rejects(f.service.resolve(direct.id), {code: 'MEDIA_OUTSIDE_NOT_CONFIRMED', details: {assetId: direct.id, reason: null}});
  assert.deepEqual(f.app.outsidePaths.list(f.store.projectId), []);
  f.app.outsidePaths.confirm({projectId: randomUUID(), directory: realpathSync(f.outside), confirmedAt: '2026-11-03T00:00:00.000Z'});
  assert.equal((await f.service.inspect(direct.id)).readable, false);
  f.confirm(f.outside);
  assert.equal((await f.service.inspect(direct.id)).readable, true);
  assert.equal((await f.service.inspect(child.id)).readable, false);
  const locations = await f.service.locations();
  assert.deepEqual(locations.map(entry => [entry.directory, entry.assetCount]), [[f.outside, 1], [childDir, 1]]);
  f.app.outsidePaths.revoke(f.store.projectId, realpathSync(f.outside));
  assert.equal((await f.service.inspect(direct.id)).readable, false);
  await assert.rejects(f.service.read(direct.id, {maxBytes: 1024}), {code: 'MEDIA_OUTSIDE_NOT_CONFIRMED', details: {assetId: direct.id, reason: null}});
});

test('unconfirmed changed-time files remain unverified rather than being accepted or repaired', async t => {
  const f = fixture(t), source = f.file('outside.mp4', mp4(), f.outside), asset = await f.asset(source, true);
  const now = new Date(Date.now() + 10_000); utimesSync(source, now, now);
  const state = await f.service.inspect(asset.id);
  assert.equal(state.status, 'changed'); assert.equal(state.reason, 'unverified'); assert.equal(state.readable, false);
  assert.deepEqual(f.store.get('assets', asset.id), asset);
  f.confirm(f.outside);
  const checked = await f.service.inspect(asset.id);
  assert.equal(checked.status, 'online'); assert.equal(checked.reason, 'same-content');
  assert.notEqual(checked.fingerprintToken, mediaFingerprintToken(asset.reference));
  assert.deepEqual(f.store.get('assets', asset.id), asset);
});

test('full-hash preparation is read-only and bounded bytes reject a changed recorded hash', async t => {
  const f = fixture(t), bytes = mp4(2 * MIB), source = f.file('clip.mp4', bytes), asset = await f.asset(source);
  const prepared = await f.service.prepareFullHash(asset.id, {expectedReferenceRevision: 1});
  assert.equal(prepared.sha256, hash(bytes)); assert.equal(prepared.reference.fullSha256, hash(bytes));
  assert.deepEqual(f.store.get('assets', asset.id), asset);
  const read = await f.service.read(asset.id, {maxBytes: bytes.length, expectedSha256: hash(bytes)});
  assert.deepEqual(read.bytes, bytes); assert.equal(read.sha256, hash(bytes));
  assert.equal(read.assetId, asset.id); assert.equal(read.referenceRevision, 1);
  await assert.rejects(f.service.read(asset.id, {maxBytes: bytes.length - 1}), {code: 'MEDIA_REFERENCE_INVALID', details: {assetId: asset.id, reason: 'size-limit'}});
  await assert.rejects(f.service.read(asset.id, {maxBytes: bytes.length, expectedSha256: 'f'.repeat(64)}), {code: 'MEDIA_CHANGED', details: {assetId: asset.id, reason: 'content'}});
  await assert.rejects(f.service.prepareFullHash(asset.id, {expectedReferenceRevision: 2}), {code: 'MEDIA_CHANGED_DURING_READ', details: {assetId: asset.id, reason: null}});
});

test('full hashing catches changes outside sampled ranges even with restored size and mtime', async t => {
  const f = fixture(t), bytes = mp4(3 * MIB), source = f.file('clip.mp4', bytes), asset = await f.asset(source, true);
  const original = lstatSync(source, {bigint: true});
  bytes[100_000] = bytes[100_000]! ^ 255;
  writeFileSync(source, bytes); utimesSync(source, Number(original.atimeNs) / 1e9, Number(original.mtimeNs) / 1e9);
  // fs.utimes rounds differently across platforms; seed the observed mtime so
  // this test specifically keeps L1's fast same-stats/sample path unchanged.
  const reference = {...asset.reference, mtimeMs: mediaMtimeMs(lstatSync(source, {bigint: true}))};
  f.store.put('assets', {...asset, reference});
  assert.equal((await f.service.inspect(asset.id)).status, 'online');
  await assert.rejects(f.service.prepareFullHash(asset.id), {code: 'MEDIA_CHANGED', details: {assetId: asset.id, reason: 'content'}});
});

test('permission and reference changes during a read stop before returning bytes or a hash', async t => {
  const f = fixture(t), source = f.file('clip.mp4', mp4(3 * MIB), f.outside), asset = await f.asset(source);
  f.confirm(f.outside);
  let seen = 0;
  await assert.rejects(f.service.prepareFullHash(asset.id, {onBytes: bytes => {
    seen += bytes; f.app.outsidePaths.revoke(f.store.projectId, realpathSync(f.outside));
  }}), {code: 'MEDIA_OUTSIDE_NOT_CONFIRMED', details: {assetId: asset.id, reason: null}});
  assert.ok(seen > 0 && seen < 3 * MIB);
  f.confirm(f.outside); seen = 0;
  await assert.rejects(f.service.read(asset.id, {maxBytes: 3 * MIB, onBytes: bytes => {
    seen += bytes; f.store.put('assets', {...asset, referenceRevision: 2});
  }}), {code: 'MEDIA_CHANGED_DURING_READ', details: {assetId: asset.id, reason: null}});
  assert.ok(seen > 0 && seen < 3 * MIB);
});

test('foreign, malformed, oversized and inconsistent asset rows do not become file capabilities', async t => {
  const f = fixture(t), source = f.file('clip.mp4', mp4()), asset = await f.asset(source);
  await assert.rejects(f.service.resolve(randomUUID()), {code: 'NOT_FOUND'});
  await assert.rejects(f.service.resolve('../clip.mp4'), {code: 'NOT_FOUND'});
  for (const value of [{...asset, projectId: randomUUID()}, {...asset, referenceRevision: 0}, {...asset, sizeBytes: 999}, {...asset, mimeType: 'image/png'},
    {...asset, sha256: 'a'.repeat(64)}, {...asset, reference: {...asset.reference, path: '/arbitrary/path'}},
    {...asset, extra: 'x'.repeat(PROJECT_ASSET_REFERENCE_LIMITS.assetBytes)}]) {
    f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(value), asset.id);
    await assert.rejects(f.service.resolve(asset.id), {code: 'MEDIA_REFERENCE_INVALID', details: {assetId: asset.id, reason: 'asset'}});
  }
  f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run('{', asset.id);
  await assert.rejects(f.service.inspect(asset.id), {code: 'MEDIA_REFERENCE_INVALID', details: {assetId: asset.id, reason: 'asset'}});
});

test('caller fences and cancellation are preserved, including store closure after an await', async t => {
  const f = fixture(t), source = f.file('clip.mp4', mp4(2 * MIB)), asset = await f.asset(source), failure = new Error('host effect rejected');
  await assert.rejects(f.service.resolve(asset.id, {beforeEffect: () => {throw failure;}}), error => error === failure);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.prepareFullHash(asset.id, {signal: controller.signal}), {name: 'AbortError'});
  let seen = 0;
  await assert.rejects(f.service.prepareFullHash(asset.id, {onBytes: bytes => {seen += bytes; f.store.close();}}), TypeError);
  assert.ok(seen > 0 && seen < 2 * MIB);
});

test('location lists reject concurrent graph additions instead of returning a stale confirmation scope', async t => {
  const f = fixture(t), source = f.file('outside.mp4', mp4(), f.outside), asset = await f.asset(source);
  let calls = 0;
  await assert.rejects(f.service.locations({beforeEffect: () => {
    calls++;
    if (calls === 2) f.store.put('assets', {...asset, id: randomUUID()});
  }}), {code: 'REVISION_CONFLICT'});
});

test('held project/history/cache/application aliases are rejected without dropping SQLite locks', async t => {
  const f = fixture(t);
  const child = fileURLToPath(new URL('./helpers/project-file-child.ts', import.meta.url));
  const locked = (file: string) => {
    const result = spawnSync(process.execPath, [child], {env: {...testEnv(), MODE: 'raw-read', FILE: file}, encoding: 'utf8', timeout: 60_000});
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim()) as unknown;
  };
  // Windows refuses to create a hard link to its open SQLite file. POSIX
  // permits one, and closing an accidental fs read of it would lose the lock.
  if (process.platform === 'win32') return;
  for (const [name, file] of [['project', f.store.projectFile], ['history', path.join(f.store.localDir, 'history.db')],
    ['cache', path.join(f.store.cacheDir, 'cache.db')], ['app', f.app.databaseFile]] as const) {
    assert.equal(existsSync(file), true);
    const alias = path.join(f.projectDir, `${name}.mp4`); linkSync(file, alias);
    const stat = lstatSync(alias, {bigint: true}), id = randomUUID();
    const reference: MediaReference = {pathForm: 'relative', path: `${name}.mp4`, volume: null, sizeBytes: Number(stat.size),
      mtimeMs: mediaMtimeMs(stat), sampledSha256: 'a'.repeat(64), fullSha256: null};
    f.store.put('assets', {id, projectId: f.store.projectId, mimeType: 'video/mp4', referenceRevision: 1, sizeBytes: reference.sizeBytes, sha256: null, reference});
    assert.deepEqual(locked(file), {ok: false, message: 'database is locked', errcode: 5});
    const state = await f.service.inspect(id); assert.equal(state.reason, 'not-media'); assert.equal(state.readable, false);
    await assert.rejects(f.service.resolve(id), {code: 'MEDIA_CHANGED', details: {assetId: id, reason: 'not-media'}});
    assert.deepEqual(locked(file), {ok: false, message: 'database is locked', errcode: 5});
  }
});

test('the cache token ignores path and lazy full hashes but changes with an observed fingerprint', async t => {
  const f = fixture(t), source = f.file('clip.mp4', mp4(2 * MIB)), asset = await f.asset(source);
  const token = mediaFingerprintToken(asset.reference);
  assert.equal(token, mediaFingerprintToken({...asset.reference, fullSha256: 'a'.repeat(64)}));
  assert.notEqual(token, mediaFingerprintToken({...asset.reference, mtimeMs: asset.reference.mtimeMs + 1}));
  const media = await admitMedia(f.access, asset.reference); assert.equal(media.file, source);
});
