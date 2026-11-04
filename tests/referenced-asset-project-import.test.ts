import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/store.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {OrdinaryServices} from '../packages/business/src/services.ts';
import {registerStoreTransactionObserver} from '../packages/business/src/store-runtime.ts';
import {readMioTargetRevision} from '../packages/business/src/agent/mio-target-revisions.ts';
import {createReferencedAssetProjectImport, projectAssetImportAssetDigest, projectAssetImportCreationProofSchema, projectAssetImportPreparationSchema,
  projectAssetImportReceiptProofSchema} from '../packages/business/src/referenced-asset-project-import.ts';
import type {AssetPathImportInput, ProjectAssetImportCreationProof} from '../packages/business/src/referenced-asset-project-import.ts';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
function object(value: unknown): Record<string, unknown> {assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;}
function fixture(t: TestContext, withServices = true) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-project-import-')), projectDir = path.join(root, 'project'); mkdirSync(projectDir);
  const projectFile = path.join(projectDir, 'Film.mioon'), locate = () => ({localDir: path.join(root, 'local'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')});
  let store = createProjectStore({projectFile, locate});
  store.put('projects', {id: store.projectId, name: 'Project path import', createdAt: '2026-11-04T00:00:00.000Z', revision: 1});
  const app = openAppLibrary({dataDir: path.join(root, 'application')}), owner = new AbortController();
  const ports = createProjectServiceApplication(app, owner.signal, {}), beforeEffect = () => ports.assertMutationAllowed();
  const source = path.join(projectDir, 'source.png'); writeFileSync(source, png());
  const input: AssetPathImportInput = {projectId: store.projectId, requestId: randomUUID(), sourcePath: source};
  const makeServices = (): OrdinaryServices | undefined => withServices ? createServices(store, new Map(), {application: ports, signal: owner.signal, env: {},
    imageOptions: {autoRun: false}, frameOptions: {autoRun: false}, sceneOptions: {autoRun: false}}) : undefined;
  let services = makeServices(), calls = 0;
  const makePort = () => createReferencedAssetProjectImport(store, {importPath: async (value, context) => {
    calls++; assert.ok(services, 'prepare/lookup never call an uncomposed importer');
    return services.call('asset.import', value, {signal: context.signal});
  }});
  let port = makePort();
  const context = {signal: owner.signal, beforeEffect};
  const receiptFile = path.join(store.tempDir, 'asset-imports', hash(input.requestId) + '.json');
  const counts = () => [store.db.prepare('SELECT total_changes() AS n').get()!.n, app.db.prepare('SELECT total_changes() AS n').get()!.n];
  t.after(async () => {await services?.drain(); owner.abort(); store.close(); app.close(); rmSync(root, {recursive: true, force: true});});
  return {root, projectDir, projectFile, source, input, app, owner, context, beforeEffect, receiptFile, counts,
    get store() {return store;}, get port() {return port;}, get calls() {return calls;},
    publicImport: (value: AssetPathImportInput) => {assert.ok(services); return services.call('asset.import', value);},
    async reopen() {await services?.drain(); store.close(); store = openProjectStore({projectFile, locate}); services = makeServices(); port = makePort();},
    receipt: () => object(JSON.parse(readFileSync(receiptFile, 'utf8'))),
  };
}

test('prepare and absent-key lookup are read-only, leave no receipt directory and never call the writer', async t => {
  const f = fixture(t, false), before = f.counts(), info = lstatSync(f.source, {bigint: true});
  const prepared = await f.port.prepare(f.input, f.context);
  assert.equal(prepared.metadata.width, 64); assert.equal(prepared.metadata.height, 64); assert.equal(prepared.mimeType, 'image/png');
  assert.equal(prepared.sourceIdentity.ino, String(info.ino)); assert.match(prepared.reference.fullSha256!, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(prepared), true); assert.equal(Object.isFrozen(prepared.input), true);
  assert.deepEqual(projectAssetImportPreparationSchema.parse(JSON.parse(JSON.stringify(prepared))), prepared);
  unlinkSync(f.source); const lookup = await f.port.lookup(f.input, f.context); assert.equal(lookup.outcome, 'not_applied'); lookup.assertCurrent();
  assert.equal(f.calls, 0); assert.equal(existsSync(path.dirname(f.receiptFile)), false); assert.deepEqual(f.counts(), before);
});

test('created proof is stable, path-free and recorded inside the same asset transaction; replay is only reused', async t => {
  const f = fixture(t), prepared = await f.port.prepare(f.input, f.context); let count = 0, creation: ProjectAssetImportCreationProof | undefined;
  const recordCreatedInside = (proof: ProjectAssetImportCreationProof) => {
    count++; assert.equal(f.store.db.isTransaction, true); creation = proof;
    const current = f.store.get('assets', proof.assetId); assert.equal(projectAssetImportAssetDigest(current), proof.assetDigest);
    assert.equal(readMioTargetRevision(f.store.db, f.store.projectId, 'asset', proof.assetId), proof.assetRevision);
    f.store.put('projects', {...object(f.store.get('projects', f.store.projectId)), atomicImportAsset: proof.assetId});
  };
  const first = await f.port.execute(prepared, {...f.context, recordCreatedInside}); assert.equal(first.disposition, 'created'); assert.ok(creation);
  projectAssetImportCreationProofSchema.parse(creation); projectAssetImportReceiptProofSchema.parse(first.receipt);
  assert.equal(object(f.store.get('projects', f.store.projectId)).atomicImportAsset, first.asset.id);
  assert.equal(JSON.stringify(first.asset).includes(f.root), false); assert.equal(Object.hasOwn(first.asset, 'reference'), false);
  const receiptBefore = readFileSync(f.receiptFile), before = f.counts();
  const replay = await f.port.execute(prepared, {...f.context, recordCreatedInside});
  assert.equal(replay.disposition, 'reused'); assert.equal(replay.creation, undefined); assert.equal(replay.asset.id, first.asset.id); assert.equal(count, 1);
  assert.deepEqual(f.counts(), before); assert.deepEqual(readFileSync(f.receiptFile), receiptBefore);
  const lookup = await f.port.lookup(f.input, f.context); assert.equal(lookup.outcome, 'applied');
  if (lookup.outcome !== 'applied') return;
  assert.deepEqual(lookup.receipt, first.receipt); assert.equal(lookup.changed, false);
  f.store.tx(() => lookup.assertCurrent());
});

test('same bytes under another request create a distinct registration instead of guessed deduplication', async t => {
  const f = fixture(t); const first = await f.port.execute(await f.port.prepare(f.input, f.context), {...f.context, recordCreatedInside() {}});
  const next = {...f.input, requestId: randomUUID()}, second = await f.port.execute(await f.port.prepare(next, f.context), {...f.context, recordCreatedInside() {}});
  assert.equal(first.disposition, 'created'); assert.equal(second.disposition, 'created'); assert.notEqual(second.asset.id, first.asset.id);
});

test('an applied original key is reused after its source is gone without dispatch or new creation rights', async t => {
  const f = fixture(t), prepared = await f.port.prepare(f.input, f.context);
  const first = await f.port.execute(prepared, {...f.context, recordCreatedInside() {}}), calls = f.calls;
  unlinkSync(f.source); const before = f.counts(), saved = readFileSync(f.receiptFile);
  const replay = await f.port.execute(prepared, {...f.context, recordCreatedInside() {assert.fail('replay cannot create undo rights');}});
  assert.equal(replay.disposition, 'reused'); assert.equal(replay.asset.id, first.asset.id); assert.equal(replay.creation, undefined);
  assert.equal(f.calls, calls); assert.deepEqual(f.counts(), before); assert.deepEqual(readFileSync(f.receiptFile), saved);
});

test('creation recorder failure rolls the asset, revision and its own journal-side mutation back together', async t => {
  const f = fixture(t), prepared = await f.port.prepare(f.input, f.context), sentinel = Error('reject atomic journal');
  await assert.rejects(f.port.execute(prepared, {...f.context, recordCreatedInside(proof) {
    f.store.put('projects', {...object(f.store.get('projects', f.store.projectId)), rolledBackAsset: proof.assetId}); throw sentinel;
  }}), error => error === sentinel);
  assert.equal(f.store.list('assets').length, 0); assert.equal(object(f.store.get('projects', f.store.projectId)).rolledBackAsset, undefined);
  const receipt = f.receipt(); assert.equal(receipt.phase, 'prepared'); assert.equal(readMioTargetRevision(f.store.db, f.store.projectId, 'asset', String(receipt.assetId)), undefined);
  const lookup = await f.port.lookup(f.input, f.context); assert.equal(lookup.outcome, 'not_applied');
  const recovered = await f.port.execute(prepared, {...f.context, recordCreatedInside() {}}); assert.equal(recovered.disposition, 'created'); assert.equal(recovered.asset.id, receipt.assetId);
});

test('a later transaction observer failure cannot leave a false creation proof or asset commit', async t => {
  const f = fixture(t), prepared = await f.port.prepare(f.input, f.context), sentinel = Error('reject observer'); let callback = 0;
  const remove = registerStoreTransactionObserver(f.store.db, () => {throw sentinel;});
  await assert.rejects(f.port.execute(prepared, {...f.context, recordCreatedInside() {callback++;}})); remove();
  assert.equal(callback, 1); assert.equal(f.store.list('assets').length, 0);
  assert.equal((await f.port.lookup(f.input, f.context)).outcome, 'not_applied');
});

test('an async creation recorder is rejected before its body or the ordinary writer can start', async t => {
  const f = fixture(t), prepared = await f.port.prepare(f.input, f.context); let invoked = 0;
  await assert.rejects(f.port.execute(prepared, {...f.context, async recordCreatedInside() {invoked++;}}), {code: 'AGENT_TASK_INVALID_TARGET'});
  assert.equal(invoked, 0); assert.equal(f.calls, 0); assert.equal(existsSync(f.receiptFile), false); assert.equal(f.store.list('assets').length, 0);
});

test('DB commit before registered ACK is discovered by the original receipt without source I/O', async t => {
  const f = fixture(t), prepared = await f.port.prepare(f.input, f.context); let completed = 0, armed = false;
  const sentinel = Error('host revoked after commit'), remove = registerStoreTransactionObserver(f.store.db, () => {armed = true;});
  await assert.rejects(f.port.execute(prepared, {...f.context, beforeEffect() {f.beforeEffect(); if (armed) throw sentinel;}, recordCreatedInside() {completed++;}}), error => error === sentinel); remove();
  assert.equal(completed, 1); assert.equal(f.receipt().phase, 'prepared'); assert.equal(f.store.list('assets').length, 1);
  unlinkSync(f.source); const before = f.counts(), saved = readFileSync(f.receiptFile);
  const lookup = await f.port.lookup(f.input, f.context); assert.equal(lookup.outcome, 'applied'); assert.deepEqual(f.counts(), before); assert.deepEqual(readFileSync(f.receiptFile), saved);
});

for (const phase of ['registered', 'prepared']) test(`${phase} original key never recreates a removed registration, including after reopen`, async t => {
  const f = fixture(t), prepared = await f.port.prepare(f.input, f.context), created = await f.port.execute(prepared, {...f.context, recordCreatedInside() {}});
  if (phase === 'prepared') writeFileSync(f.receiptFile, JSON.stringify({...f.receipt(), phase}), {mode: 0o600});
  f.store.tx(() => f.store.db.prepare('DELETE FROM assets WHERE id=?').run(created.asset.id));
  const saved = readFileSync(f.receiptFile), source = readFileSync(f.source);
  const lookup = await f.port.lookup(f.input, f.context); assert.equal(lookup.outcome, 'retired'); lookup.assertCurrent();
  await assert.rejects(f.publicImport(f.input), {code: 'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.port.execute(prepared, {...f.context, recordCreatedInside() {assert.fail('retired key cannot create');}}), {code: 'IDEMPOTENCY_CONFLICT'});
  await f.reopen(); assert.equal((await f.port.lookup(f.input, f.context)).outcome, 'retired');
  await assert.rejects(f.publicImport(f.input), {code: 'IDEMPOTENCY_CONFLICT'});
  assert.equal(f.store.list('assets').length, 0); assert.deepEqual(readFileSync(f.receiptFile), saved); assert.deepEqual(readFileSync(f.source), source);
});

test('saved preparation survives close/reopen but rejects modified proof and foreign capabilities', async t => {
  const f = fixture(t), prepared = JSON.parse(JSON.stringify(await f.port.prepare(f.input, f.context)));
  await f.reopen(); const result = await f.port.execute(prepared, {...f.context, recordCreatedInside() {}}); assert.equal(result.disposition, 'created');
  assert.equal(projectAssetImportPreparationSchema.safeParse({...prepared, extra: true}).success, false);
  assert.equal(projectAssetImportPreparationSchema.safeParse({...prepared, inputDigest: 'a'.repeat(64)}).success, false);
  assert.equal(projectAssetImportCreationProofSchema.safeParse({...result.creation, assetRevision: 0}).success, false);
  assert.throws(() => createReferencedAssetProjectImport({...f.store}, {importPath: async () => null}));
});

for (const mutation of ['replace', 'same-inode'] as const) test(`${mutation} source changes after approval reject before ordinary import dispatch`, async t => {
  const f = fixture(t), prepared = await f.port.prepare(f.input, f.context), original = lstatSync(f.source);
  if (mutation === 'replace') {renameSync(f.source, f.source + '.approved'); writeFileSync(f.source, readFileSync(f.source + '.approved'));}
  else {const next = readFileSync(f.source); next[next.length - 20] ^= 1; writeFileSync(f.source, next); utimesSync(f.source, original.atime, original.mtime);}
  await assert.rejects(f.port.execute(prepared, {...f.context, recordCreatedInside() {assert.fail('changed source cannot create');}}), {code: 'MEDIA_CHANGED_DURING_READ'});
  assert.equal(f.calls, 0); assert.equal(existsSync(f.receiptFile), false); assert.equal(f.store.list('assets').length, 0);
});

test('asynchronous source/host revocation and approval cancellation do not register late effects', async t => {
  const f = fixture(t), prepared = await f.port.prepare(f.input, f.context); let armed = false, changed = false;
  const pending = f.port.execute(prepared, {...f.context, beforeEffect() {f.beforeEffect(); if (armed && !changed) {changed = true; writeFileSync(f.source, 'changed during source preparation');}}, recordCreatedInside() {assert.fail('revoked source cannot create');}});
  queueMicrotask(() => {armed = true;}); await assert.rejects(pending, {code: 'MEDIA_CHANGED_DURING_READ'}); assert.equal(f.store.list('assets').length, 0);
  const g = fixture(t, false), controller = new AbortController(); controller.abort();
  await assert.rejects(g.port.prepare(g.input, {beforeEffect: g.beforeEffect, signal: controller.signal}), {code: 'OPERATION_CANCELLED'});
  const sentinel = Error('approval owner revoked'); let revoked = false;
  const work = g.port.prepare(g.input, {beforeEffect() {g.beforeEffect(); if (revoked) throw sentinel;}});
  queueMicrotask(() => {revoked = true;}); await assert.rejects(work, error => error === sentinel); assert.equal(g.calls, 0);
});

test('a confirmed external path cannot enter the project-only preparation port or gain new confirmation', async t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); mkdirSync(outside); const file = path.join(outside, 'outside.png'); writeFileSync(file, png());
  f.app.outsidePaths.confirm({projectId: f.store.projectId, directory: outside, confirmedAt: '2026-11-04T00:00:00.000Z'});
  const before = f.app.outsidePaths.list(f.store.projectId);
  await assert.rejects(f.port.prepare({...f.input, sourcePath: file}, f.context));
  assert.deepEqual(f.app.outsidePaths.list(f.store.projectId), before); assert.equal(f.store.list('assets').length, 0); assert.equal(f.calls, 0);
});

test('lookup pins receipt and DB evidence for synchronous compensation and never turns changed metadata into creation rights', async t => {
  const f = fixture(t), created = await f.port.execute(await f.port.prepare(f.input, f.context), {...f.context, recordCreatedInside() {}});
  const lookup = await f.port.lookup(f.input, f.context); assert.equal(lookup.outcome, 'applied'); f.store.tx(() => lookup.assertCurrent());
  f.store.put('assets', {...object(f.store.get('assets', created.asset.id)), name: 'User edit'}); assert.throws(() => lookup.assertCurrent(), {code: 'MEDIA_CHANGED_DURING_READ'});
  const edited = await f.port.lookup(f.input, f.context); assert.equal(edited.outcome, 'applied'); if (edited.outcome === 'applied') assert.equal(edited.changed, true);
  const before = readFileSync(f.receiptFile); writeFileSync(f.receiptFile, before + '\n'); assert.throws(() => edited.assertCurrent(), {code: 'MEDIA_CHANGED_DURING_READ'});
});

for (const mutation of ['digest', 'owner', 'phase', 'asset', 'extra'] as const) test(`invalid ${mutation} receipt yields unknown without replaying or writing`, async t => {
  const f = fixture(t); await f.port.execute(await f.port.prepare(f.input, f.context), {...f.context, recordCreatedInside() {}});
  const receipt = f.receipt();
  if (mutation === 'digest') receipt.digest = 'f'.repeat(64);
  if (mutation === 'owner') receipt.projectId = randomUUID();
  if (mutation === 'phase') receipt.phase = ['registered'];
  if (mutation === 'asset') object(receipt.asset).id = randomUUID();
  if (mutation === 'extra') receipt.surprise = true;
  writeFileSync(f.receiptFile, JSON.stringify(receipt)); const before = f.counts(), saved = readFileSync(f.receiptFile);
  assert.equal((await f.port.lookup(f.input, f.context)).outcome, 'unknown'); assert.deepEqual(f.counts(), before); assert.deepEqual(readFileSync(f.receiptFile), saved);
});

function childWrite(file: string): unknown {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite';let db;try{db=new DatabaseSync(process.argv[1],{timeout:0});db.exec('BEGIN IMMEDIATE;ROLLBACK');console.log(JSON.stringify({ok:true}));}catch(error){console.log(JSON.stringify({ok:false,errcode:error.errcode}));}finally{db?.close();}`, file], {encoding: 'utf8', timeout: 60000});
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim()) as unknown;
}
for (const kind of ['project', 'history', 'cache', 'application'] as const) test(`held ${kind} cannot be opened as a source or receipt, preserving its interprocess write lock`, async t => {
  const f = fixture(t), file = {project: f.projectFile, history: path.join(f.store.localDir, 'history.db'), cache: path.join(f.store.cacheDir, 'cache.db'), application: f.app.databaseFile}[kind];
  const alias = path.join(f.projectDir, kind + '.png'); linkSync(file, alias); assert.deepEqual(childWrite(file), {ok: false, errcode: 5});
  await assert.rejects(f.port.prepare({...f.input, sourcePath: alias}, f.context)); assert.deepEqual(childWrite(file), {ok: false, errcode: 5});
  ensurePrivateDirectory(path.dirname(f.receiptFile), {create: true}); linkSync(file, f.receiptFile);
  assert.equal((await f.port.lookup(f.input, f.context)).outcome, 'unknown'); assert.deepEqual(childWrite(file), {ok: false, errcode: 5});
});
