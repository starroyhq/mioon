import {testEnv} from './helpers/test-env.ts';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createMioProjectMedia} from '../packages/business/src/agent/mio-project-media.ts';
import {createManagedAssetImportHandler} from '../packages/business/src/managed-asset-import.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/store.ts';
import {registerProjectMediaStore} from '../packages/business/src/project-media-storage.ts';
import {outputFileIdentity} from '../packages/business/src/project-output-owner.ts';
import {markProjectOutputRegistered, publishProjectOutput, restorePublishedProjectOutput, setProjectOutputPublicationTestHooks} from '../packages/business/src/project-output-publication.ts';
import type {ProjectOutputInput, PublishedProjectOutput} from '../packages/business/src/project-output-publication.ts';
import {PROJECT_OUTPUT_UNPUBLISHED_LIMITS as LIMITS, readProjectOutputUnpublishedSnapshot} from '../packages/business/src/project-output-unpublished.ts';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';
import type {ProjectOutputPublicationIndex, ProjectOutputPublicationReceipt} from '../packages/contracts/src/project-output-publication.ts';
import {png, pngChunk} from './helpers/timeline-image-fixtures.ts';

const bytes = png({rgba: false, extra: [pngChunk('tEXt', Buffer.from('comment\0' + 'x'.repeat(150000)))]});
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const paddingByBytes = (text: string, size: number): string => text + ' '.repeat(size - Buffer.byteLength(text));
const options = {beforeEffect() {}};
const invalid = {code: 'MEDIA_LIST_PATH_INVALID', status: 400, details: {}};
const changed = {code: 'MEDIA_CHANGED_DURING_READ', status: 409};
function fixture(t: TestContext, targetKind: ProjectOutputInput['targetKind'] = 'generated') {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-output-unpublished-'));
  const projectDir = path.join(root, 'project'); mkdirSync(projectDir, {mode: 0o755});
  const projectFile = path.join(projectDir, 'Film.mioon'), locate = () => ({localDir: path.join(root, 'local'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')});
  let store = createProjectStore({projectFile, locate});
  store.put('projects', {id: store.projectId, name: 'Output snapshot', createdAt: '2026-11-04T00:00:00.000Z'});
  const app = openAppLibrary({dataDir: path.join(root, 'application')}); let release = registerProjectMediaStore(store);
  t.after(() => {release(); store.close(); app.close(); rmSync(root, {recursive: true, force: true});});
  const stageDir = path.join(store.tempDir, 'verified-artifacts'); ensurePrivateDirectory(stageDir, {create: true});
  const stageFile = path.join(stageDir, randomUUID() + '.png'); writeFileSync(stageFile, bytes, {mode: 0o600});
  const input: ProjectOutputInput = {publicationId: randomUUID(), owner: {kind: targetKind === 'exports' ? 'export' : targetKind === 'assets' ? 'import' : 'image',
    id: randomUUID(), requestId: randomUUID(), inputHash: 'a'.repeat(64)}, assetId: randomUUID(), targetKind, stageFile, mimeType: 'image/png', sizeBytes: bytes.length, sha256: hash(bytes)};
  const directory = path.join(store.tempDir, 'publications'), receiptFile = path.join(directory, input.publicationId + '.json');
  const receipt = () => JSON.parse(readFileSync(receiptFile, 'utf8')) as ProjectOutputPublicationReceipt;
  const register = (output: PublishedProjectOutput) => {
    const {relativePath: _relativePath, ...fields} = output;
    return store.tx(() => store.put('assets', {id: input.assetId, projectId: store.projectId, name: 'Published image', mimeType: input.mimeType,
      ...fields, provenance: targetKind === 'exports' ? 'export' : 'generated'}));
  };
  const snapshot = async () => {
    const before = [store.db.prepare('SELECT total_changes() AS n').get()!.n, app.db.prepare('SELECT total_changes() AS n').get()!.n];
    const result = await readProjectOutputUnpublishedSnapshot(store, options);
    assert.deepEqual([store.db.prepare('SELECT total_changes() AS n').get()!.n, app.db.prepare('SELECT total_changes() AS n').get()!.n], before);
    return result;
  };
  return {root, projectDir, projectFile, input, app, directory, receiptFile, receipt, register, snapshot,
    get store() {return store;}, reopen() {release(); store.close(); store = openProjectStore({projectFile, locate}); release = registerProjectMediaStore(store);}};
}
function target(f: ReturnType<typeof fixture>): string {
  return path.join(f.projectDir, (f.receipt().proof as {relativePath: string}).relativePath);
}
async function fault(f: ReturnType<typeof fixture>, point: string, forceCopy = true) {
  const sentinel = Error(point), remove = setProjectOutputPublicationTestHooks(f.store, {forceCopy, fault(seen) {if (seen === point) throw sentinel;}});
  try {await assert.rejects(publishProjectOutput(f.store, f.input), error => error === sentinel);} finally {remove();}
}

test('missing publications is an empty read-only snapshot without creating private files', async t => {
  const f = fixture(t), before = readdirSync(f.store.tempDir), view = await f.snapshot();
  assert.match(view.version, /^[a-f0-9]{64}$/u); view.assertCurrent(); assert.equal(existsSync(f.directory), false);
  assert.deepEqual(readdirSync(f.store.tempDir), before); assert.equal(view.isExcluded(f.input.stageFile, lstatSync(f.input.stageFile, {bigint: true})), false);
});

for (const kind of ['generated', 'exports', 'assets'] as const) for (const point of ['after_intent', 'after_target_create', 'after_target_identity', 'after_copy_chunk', 'after_final']) {
  test(`${kind} copy ${point} is absent, rejected or excluded by durable inode proof`, async t => {
    const f = fixture(t, kind); await fault(f, point);
    const file = target(f), saved = readFileSync(f.receiptFile);
    if (point === 'after_target_create') await assert.rejects(f.snapshot(), invalid);
    else {
      const view = await f.snapshot();
      if (point === 'after_intent') assert.equal(existsSync(file), false);
      else assert.equal(view.isExcluded(file, lstatSync(file, {bigint: true})), true);
      f.reopen(); const reopened = await f.snapshot();
      if (existsSync(file)) assert.equal(reopened.isExcluded(file, lstatSync(file, {bigint: true})), true);
    }
    assert.deepEqual(readFileSync(f.receiptFile), saved, 'query never recovers or advances a receipt');
  });
}

test('link intent before targetIdentity ACK proves only its stage inode, including project aliases', async t => {
  const f = fixture(t, 'assets'); await fault(f, 'after_final', false);
  const file = target(f), saved = f.receipt(); saved.phase = 'intent'; saved.targetIdentity = null; delete saved.finalStats;
  writeFileSync(f.receiptFile, JSON.stringify(saved), {mode: 0o600});
  const alias = path.join(f.projectDir, 'alias.png'), symbolic = path.join(f.projectDir, 'inside.png'); linkSync(file, alias); symlinkSync(file, symbolic);
  chmodSync(f.input.stageFile, 0o000);
  const view = await f.snapshot(), info = lstatSync(file, {bigint: true});
  assert.equal(view.isExcluded(file, info), true); assert.equal(view.isExcluded(alias, lstatSync(alias, {bigint: true})), true);
  assert.equal(view.isExcluded(realpathSync(symbolic), lstatSync(realpathSync(symbolic), {bigint: true})), true);
  renameSync(file, file + '.moved'); assert.throws(() => view.assertCurrent(), changed);
});

test('prepared requires a complete final epoch and exact committed publication, including DB ACK-before-mark', async t => {
  const f = fixture(t), output = await publishProjectOutput(f.store, f.input), file = target(f);
  assert.equal((await f.snapshot()).isExcluded(file, lstatSync(file, {bigint: true})), true);
  f.register(output); const committed = await f.snapshot(); assert.equal(committed.isExcluded(file, lstatSync(file, {bigint: true})), false);
  f.store.put('assets', {...f.store.get('assets', f.input.assetId) as object, publication: {...output.publication, owner: {...output.publication.owner, requestId: 'different'}}});
  assert.throws(() => committed.assertCurrent(), changed);
  assert.equal((await f.snapshot()).isExcluded(file, lstatSync(file, {bigint: true})), true);
});

test('link prepared without finalStats cannot be mistaken for a committed complete output', async t => {
  const f = fixture(t, 'assets'), output = await publishProjectOutput(f.store, f.input); f.register(output);
  const saved = f.receipt(); delete saved.finalStats; writeFileSync(f.receiptFile, JSON.stringify(saved), {mode: 0o600});
  const file = target(f); assert.equal((await f.snapshot()).isExcluded(file, lstatSync(file, {bigint: true})), true);
});

test('registered history survives row edits/deletion, file edits and output-directory recreation', async t => {
  const f = fixture(t), output = await publishProjectOutput(f.store, f.input); f.register(output); await markProjectOutputRegistered(f.store, output.publication);
  const file = target(f), view = await f.snapshot();
  f.store.put('assets', {...f.store.get('assets', f.input.assetId) as object, name: 'Edited'});
  f.store.db.prepare('DELETE FROM assets WHERE id=?').run(f.input.assetId); writeFileSync(file, 'a current ordinary candidate'); view.assertCurrent();
  const old = path.dirname(file) + '-old'; renameSync(path.dirname(file), old); mkdirSync(path.dirname(file)); writeFileSync(file, bytes);
  const fresh = await f.snapshot(); assert.equal(fresh.isExcluded(file, lstatSync(file, {bigint: true})), false);
});

test('registered ACK before private-stage cleanup is already a terminal publication', async t => {
  const f = fixture(t), output = await publishProjectOutput(f.store, f.input); f.register(output);
  const sentinel = Error('registered'), remove = setProjectOutputPublicationTestHooks(f.store, {fault(point) {if (point === 'after_registered') throw sentinel;}});
  await assert.rejects(markProjectOutputRegistered(f.store, output.publication), error => error === sentinel); remove();
  const file = target(f); assert.equal(existsSync(f.input.stageFile), true);
  assert.equal((await f.snapshot()).isExcluded(file, lstatSync(file, {bigint: true})), false);
});

for (const control of ['\u007f', '\u0080']) test(`real producer and S1 upload with ${JSON.stringify(control)} stay valid private facts without exposing the name`, async t => {
  const f = fixture(t), output = await publishProjectOutput(f.store, {...f.input, displayName: 'a' + control + 'b'});
  const file = path.join(f.projectDir, output.relativePath);
  assert.ok(path.basename(file).includes(control));
  assert.equal((await f.snapshot()).isExcluded(file, lstatSync(file, {bigint: true})), true);
  f.register(output); await markProjectOutputRegistered(f.store, output.publication);
  assert.equal((await f.snapshot()).isExcluded(file, lstatSync(file, {bigint: true})), false);
  const assertVisibleOrdinary = async (owner: ReturnType<typeof fixture>, directory: string) => {
    const ports = createProjectServiceApplication(owner.app, undefined, {}), beforeEffect = () => ports.assertMutationAllowed();
    writeFileSync(path.join(owner.projectDir, directory, 'ordinary.png'), bytes);
    const media = createMioProjectMedia({store: owner.store, privateDirectories: [owner.app.dataDir, owner.store.cacheDir, owner.store.tempDir]});
    const before = [owner.store.db.prepare('SELECT total_changes() AS n').get()!.n, owner.app.db.prepare('SELECT total_changes() AS n').get()!.n];
    const page = await media.list(owner.store.projectId, {directory}, {beforeEffect});
    assert.deepEqual(page.entries.map(entry => entry.name), ['ordinary.png']);
    assert.deepEqual([owner.store.db.prepare('SELECT total_changes() AS n').get()!.n, owner.app.db.prepare('SELECT total_changes() AS n').get()!.n], before);
  };
  await assertVisibleOrdinary(f, '生成');
  const g = fixture(t, 'assets'), ports = createProjectServiceApplication(g.app, undefined, {});
  const importer = createManagedAssetImportHandler(g.store, {outsidePaths: g.app.outsidePaths, beforeEffect: () => ports.assertMutationAllowed(),
    now: () => '2026-11-04T00:00:00.000Z', required: (_table, id) => g.store.get('projects', id)});
  await importer({projectId: g.store.projectId, requestId: randomUUID(), name: 'a' + control + 'b', mimeType: 'image/png', dataBase64: bytes.toString('base64')});
  await assertVisibleOrdinary(g, '素材');
});

test('a first restore intent invalidates an earlier registered snapshot at its exact missing receipt path', async t => {
  const f = fixture(t, 'exports'), output = await publishProjectOutput(f.store, f.input), asset = f.register(output); await markProjectOutputRegistered(f.store, output.publication);
  const view = await f.snapshot(), file = target(f); unlinkSync(file);
  const stage = path.join(path.dirname(f.input.stageFile), 'new-restore.png'); writeFileSync(stage, bytes, {mode: 0o600});
  const sentinel = Error('intent'), remove = setProjectOutputPublicationTestHooks(f.store, {fault(point) {if (point === 'after_intent') throw sentinel;}});
  await assert.rejects(restorePublishedProjectOutput(f.store, {asset, stageFile: stage}), error => error === sentinel); remove();
  assert.throws(() => view.assertCurrent(), changed);
});

test('valid key-only reservation neither invents a target nor ignores later intent creation', async t => {
  const f = fixture(t); await fault(f, 'after_intent'); const saved = readFileSync(f.receiptFile); unlinkSync(f.receiptFile);
  const view = await f.snapshot(); assert.deepEqual(readdirSync(path.join(f.projectDir, '生成')), []);
  writeFileSync(f.receiptFile, saved, {mode: 0o600}); assert.throws(() => view.assertCurrent(), changed);
  const key = readdirSync(f.directory).find(name => name.startsWith('key-'))!; unlinkSync(path.join(f.directory, key));
  await assert.rejects(f.snapshot(), invalid);
});

test('an unproved abandoned path blocks listing, even when its bytes equal the complete new output', async t => {
  const f = fixture(t); let collision = '';
  const remove = setProjectOutputPublicationTestHooks(f.store, {fault(point, proof) {if (point === 'after_intent') {collision = path.join(f.projectDir, proof.relativePath); writeFileSync(collision, bytes);}}});
  const output = await publishProjectOutput(f.store, f.input); remove(); f.register(output); await markProjectOutputRegistered(f.store, output.publication);
  await assert.rejects(f.snapshot(), invalid); unlinkSync(collision); await f.snapshot();
});

for (const point of ['after_intent', 'after_target_create', 'after_target_identity', 'after_copy_chunk', 'after_final']) test(`restore ${point} distinguishes old DB registration from a new partial`, async t => {
  const f = fixture(t, 'exports'), output = await publishProjectOutput(f.store, f.input), asset = f.register(output); await markProjectOutputRegistered(f.store, output.publication);
  const file = target(f); unlinkSync(file); const stage = path.join(path.dirname(f.input.stageFile), 'restore.png'); writeFileSync(stage, bytes, {mode: 0o600});
  const sentinel = Error(point), remove = setProjectOutputPublicationTestHooks(f.store, {fault(seen) {if (seen === point) throw sentinel;}});
  await assert.rejects(restorePublishedProjectOutput(f.store, {asset, stageFile: stage}), error => error === sentinel); remove();
  if (point === 'after_target_create' || point === 'after_intent') await assert.rejects(f.snapshot(), invalid);
  else {
    const view = await f.snapshot();
    if (point === 'after_intent') assert.equal(existsSync(file), false);
    else assert.equal(view.isExcluded(file, lstatSync(file, {bigint: true})), point !== 'after_final');
    f.reopen(); const reopened = await f.snapshot();
    if (existsSync(file)) assert.equal(reopened.isExcluded(file, lstatSync(file, {bigint: true})), point !== 'after_final');
  }
});

test('completed restore receipts coexist, including retry abandoned paths equal to the frozen destination', async t => {
  const f = fixture(t, 'exports'), output = await publishProjectOutput(f.store, f.input), asset = f.register(output); await markProjectOutputRegistered(f.store, output.publication);
  const file = target(f), stage = path.join(path.dirname(f.input.stageFile), 'restore.png'); unlinkSync(file); writeFileSync(stage, bytes, {mode: 0o600});
  const sentinel = Error('partial'), remove = setProjectOutputPublicationTestHooks(f.store, {fault(point) {if (point === 'after_copy_chunk') throw sentinel;}});
  await assert.rejects(restorePublishedProjectOutput(f.store, {asset, stageFile: stage}), error => error === sentinel); remove(); unlinkSync(file);
  await restorePublishedProjectOutput(f.store, {asset, stageFile: stage});
  const view = await f.snapshot(); assert.equal(view.isExcluded(file, lstatSync(file, {bigint: true})), false);
  const restore = JSON.parse(readFileSync(path.join(f.directory, 'restore-' + f.input.publicationId + '.json'), 'utf8')) as {attempt: number; abandoned: string[]};
  assert.equal(restore.attempt, 2); assert.deepEqual(restore.abandoned, [output.relativePath]);
  renameSync(file, file + '.owned'); writeFileSync(file, bytes); await assert.rejects(f.snapshot(), invalid);
});

for (const problem of ['key-owner', 'receipt-owner', 'root', 'directory', 'stage-path', 'abandoned-path', 'stream-path', 'c0-path', 'unknown-version', 'unknown-entry'] as const) test(`strict ${problem} validation rejects without exposing paths`, async t => {
  const f = fixture(t); await fault(f, 'after_intent');
  const saved = f.receipt();
  if (problem === 'key-owner') {const key = path.join(f.directory, readdirSync(f.directory).find(name => name.startsWith('key-'))!); const value = JSON.parse(readFileSync(key, 'utf8')); value.owner.id = randomUUID(); writeFileSync(key, JSON.stringify(value));}
  else if (problem === 'unknown-entry') writeFileSync(path.join(f.directory, 'mystery.json'), '{}', {mode: 0o600});
  else {
    if (problem === 'receipt-owner') saved.proof.owner.id = randomUUID();
    if (problem === 'root') saved.rootIdentity.ino = String(BigInt(saved.rootIdentity.ino) + 1n);
    if (problem === 'directory') saved.directoryIdentity.ino = String(BigInt(saved.directoryIdentity.ino) + 1n);
    if (problem === 'stage-path') saved.stageRelativePath = '../outside.png';
    if (problem === 'abandoned-path') saved.abandoned = ['../outside.png'];
    if (problem === 'stream-path') saved.proof.relativePath = '生成/file:stream.png';
    if (problem === 'c0-path') saved.proof.relativePath = '生成/file\u001f.png';
    writeFileSync(f.receiptFile, JSON.stringify(problem === 'unknown-version' ? {...saved, version: 2} : saved), {mode: 0o600});
  }
  await assert.rejects(f.snapshot(), error => {assert.ok(error instanceof Error); assert.equal((error as {code?: string}).code, invalid.code); assert.equal(error.message.includes(f.root), false); return true;});
});

test('private receipt and index limits count UTF-8 bytes, accepting exactly the maximum', async t => {
  const f = fixture(t); await fault(f, 'after_intent'); const original = readFileSync(f.receiptFile, 'utf8');
  writeFileSync(f.receiptFile, paddingByBytes(original, LIMITS.receiptBytes)); await f.snapshot();
  writeFileSync(f.receiptFile, paddingByBytes(original, LIMITS.receiptBytes + 1)); await assert.rejects(f.snapshot(), invalid);
  writeFileSync(f.receiptFile, original);
  const key = path.join(f.directory, readdirSync(f.directory).find(name => name.startsWith('key-'))!), raw = readFileSync(key, 'utf8');
  writeFileSync(key, paddingByBytes(raw, LIMITS.indexBytes)); await f.snapshot();
  writeFileSync(key, paddingByBytes(raw, LIMITS.indexBytes + 1)); await assert.rejects(f.snapshot(), invalid);
});

function writeIndex(directory: string, index: ProjectOutputPublicationIndex, padded = false): string {
  const name = 'key-' + hash(JSON.stringify([index.owner.kind, index.owner.id, index.owner.requestId, index.owner.inputHash, index.assetId])) + '.json';
  const raw = JSON.stringify(index), file = path.join(directory, name);
  writeFileSync(file, padded ? paddingByBytes(raw, LIMITS.indexBytes) : raw, {mode: 0o600}); return file;
}
test('257 small valid keys exceed the logical-publication budget independently of the byte budget', async t => {
  const f = fixture(t); await fault(f, 'after_intent'); unlinkSync(f.receiptFile);
  const key = path.join(f.directory, readdirSync(f.directory)[0]!), seed = JSON.parse(readFileSync(key, 'utf8')) as ProjectOutputPublicationIndex; unlinkSync(key);
  for (let i = 0; i < LIMITS.publications; i++) {
    const value = {...seed, publicationId: randomUUID(), assetId: randomUUID(), owner: {...seed.owner, id: randomUUID()}};
    writeIndex(f.directory, value);
  }
  await f.snapshot();
  writeIndex(f.directory, seed); await assert.rejects(f.snapshot(), invalid);
});

test('the aggregate byte limit rejects one extra byte with unchanged publication count and valid individual sizes', async t => {
  const f = fixture(t); await fault(f, 'after_intent'); const receipt = readFileSync(f.receiptFile, 'utf8'); unlinkSync(f.receiptFile);
  const key = path.join(f.directory, readdirSync(f.directory)[0]!), seed = JSON.parse(readFileSync(key, 'utf8')) as ProjectOutputPublicationIndex; unlinkSync(key);
  const first = writeIndex(f.directory, seed, true);
  for (let i = 1; i < LIMITS.publications; i++) writeIndex(f.directory,
    {...seed, publicationId: randomUUID(), assetId: randomUUID(), owner: {...seed.owner, id: randomUUID()}}, true);
  await f.snapshot();
  const original = JSON.stringify(seed), firstSize = LIMITS.indexBytes - Buffer.byteLength(receipt);
  assert.ok(firstSize >= Buffer.byteLength(original)); writeFileSync(first, paddingByBytes(original, firstSize));
  writeFileSync(f.receiptFile, receipt, {mode: 0o600}); await f.snapshot();
  writeFileSync(f.receiptFile, receipt + ' '); await assert.rejects(f.snapshot(), invalid);
});

function childWrite(file: string): unknown {
  const source = `import {DatabaseSync} from 'node:sqlite';let db;try{db=new DatabaseSync(process.argv[1],{timeout:0});db.exec('BEGIN IMMEDIATE;ROLLBACK');console.log(JSON.stringify({ok:true}));}catch(error){console.log(JSON.stringify({ok:false,errcode:error.errcode}));}finally{db?.close();}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, file], {env: testEnv(), encoding: 'utf8', timeout: 60000}); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim()) as unknown;
}
for (const kind of ['project', 'history', 'cache', 'application'] as const) test(`held ${kind} aliases are refused before receipt open and retain their cross-process lock`, async t => {
  const f = fixture(t); ensurePrivateDirectory(f.directory, {create: true});
  const file = {project: f.projectFile, history: path.join(f.store.localDir, 'history.db'), cache: path.join(f.store.cacheDir, 'cache.db'), application: f.app.databaseFile}[kind];
  linkSync(file, f.receiptFile); assert.deepEqual(childWrite(file), {ok: false, errcode: 5});
  await assert.rejects(f.snapshot(), invalid); assert.deepEqual(childWrite(file), {ok: false, errcode: 5});
});

test('same-byte replacement never becomes an owned partial, while identity loss invalidates a returned view', async t => {
  const f = fixture(t); await fault(f, 'after_copy_chunk'); const file = target(f), view = await f.snapshot();
  renameSync(file, file + '.owned'); writeFileSync(file, readFileSync(file + '.owned'));
  assert.throws(() => view.assertCurrent(), changed); await assert.rejects(f.snapshot(), invalid);
});

test('a moved copy partial retains its durable exclusion identity across fresh snapshots and reopen', async t => {
  const f = fixture(t); await fault(f, 'after_copy_chunk');
  const original = target(f), alias = path.join(f.projectDir, 'moved-partial.png'), before = readFileSync(f.receiptFile);
  renameSync(original, alias);
  const first = await f.snapshot(); assert.equal(first.isExcluded(alias, lstatSync(alias, {bigint: true})), true);
  f.reopen(); const reopened = await f.snapshot(); assert.equal(reopened.isExcluded(alias, lstatSync(alias, {bigint: true})), true);
  assert.deepEqual(readFileSync(f.receiptFile), before);
  writeFileSync(original, bytes); assert.throws(() => reopened.assertCurrent(), changed);
  await assert.rejects(f.snapshot(), invalid, 'the original name cannot claim a newly created different inode');
});

test('copy intent without a saved identity remains ambiguous after its original target is moved away', async t => {
  const f = fixture(t); await fault(f, 'after_target_create');
  const original = target(f), alias = path.join(f.projectDir, 'unknown-copy.png'); renameSync(original, alias);
  assert.equal(f.receipt().mode, 'copy'); assert.equal(f.receipt().targetIdentity, null);
  await assert.rejects(f.snapshot(), invalid); assert.equal(existsSync(alias), true);
});

test('private-directory aliases, copied owners, cancellation and close cannot retain snapshot authority', async t => {
  const f = fixture(t); await assert.rejects(readProjectOutputUnpublishedSnapshot({...f.store}, options), invalid);
  const controller = new AbortController(), pending = readProjectOutputUnpublishedSnapshot(f.store, {...options, signal: controller.signal}); queueMicrotask(() => controller.abort());
  await assert.rejects(pending, {code: 'OPERATION_CANCELLED'});
  await fault(f, 'after_intent'); renameSync(f.directory, f.directory + '-original'); symlinkSync(f.directory + '-original', f.directory);
  await assert.rejects(f.snapshot(), invalid); unlinkSync(f.directory); renameSync(f.directory + '-original', f.directory);
  const view = await f.snapshot(); f.store.close(); assert.throws(() => view.assertCurrent(), changed);
});
