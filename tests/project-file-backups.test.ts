import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  copyProjectBackup, copyProjectToNewFile, createProjectBackup, inspectCopiedProjectFile, inspectProjectBackup, openProjectBackup,
  openProjectStore, openStore, PROJECT_BACKUP_APPLICATION_ID, PROJECT_FILE_APPLICATION_ID,
} from '../packages/business/src/project-file/index.ts';
import {mediaMtimeMs} from '../packages/business/src/media-reference/fingerprint.ts';
import type {ProjectStore} from '../packages/business/src/project-file/index.ts';
import {CONTENT_TABLES} from '../packages/business/src/project-file/schema/tables.ts';

const referenceFixture=(root: string, relativePath: string, sha256: string, sizeBytes: number)=>({pathForm:'relative' as const,path:relativePath,volume:null,sizeBytes,
 mtimeMs:mediaMtimeMs(fs.statSync(path.join(root,relativePath),{bigint:true})),sampledSha256:sha256,fullSha256:sha256});

function scratch(t: TestContext): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-v2-kernel-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}
function fixture(t: TestContext) {
  const root = scratch(t), store = openStore(path.join(root, 'source'));
  store.put('projects', {id: store.projectId, name: '备份项目', note: store.projectId});
  t.after(() => store.close());
  const backups = path.join(root, 'backups'); mkdirSync(backups, {mode: 0o700});
  return {root, store, backupFile: path.join(backups, 'snapshot.mioon')};
}
function destination(root: string, name = 'recovered'): string {
  const directory = path.join(root, name); mkdirSync(directory, {mode: 0o700});
  return path.join(directory, 'project.mioon');
}
function openRecovered(projectFile: string): ProjectStore {
  const root = path.dirname(projectFile);
  return openProjectStore({projectFile, locate: () => ({localDir: path.join(root, 'local'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp')})});
}
const code = (expected: string) => (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === expected;
const plain = (row: object | undefined) => row === undefined ? undefined : {...row};
const sequence = (store: ProjectStore): number => Number(store.db.prepare('SELECT contentSequence FROM project.project_file').get()?.contentSequence);

test('native backup copies attached project content, not main history, and leaves the owner unchanged', async t => {
  const {root, store, backupFile} = fixture(t);
  store.db.prepare("INSERT INTO idempotency VALUES('v2',?,'hash','local-only')").run(randomUUID());
  const before = sequence(store), history = store.db.prepare('SELECT * FROM main.history_state').all();
  const identity = await createProjectBackup(store, backupFile);
  assert.equal(identity.projectId, store.projectId);
  assert.equal(identity.contentSequence, before);
  assert.equal(identity.name, '备份项目');
  assert.ok(identity.sizeBytes > 100);
  assert.equal(sequence(store), before);
  assert.deepEqual(store.db.prepare('SELECT * FROM main.history_state').all(), history);
  assert.equal(store.db.prepare('PRAGMA project.application_id').get()?.application_id, PROJECT_FILE_APPLICATION_ID);
  const reader = openProjectBackup(backupFile);
  t.after(() => reader.close());
  assert.deepEqual(reader.identity, identity);
  assert.equal(reader.db.prepare('PRAGMA application_id').get()?.application_id, PROJECT_BACKUP_APPLICATION_ID);
  assert.deepEqual(reader.db.prepare('PRAGMA database_list').all().map(row => row.name), ['main', 'temp']);
  assert.equal(reader.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('mio_runs','idempotency','history_state')").get()?.n, 0);
  assert.deepEqual(JSON.parse(String(reader.db.prepare('SELECT data FROM projects').get()?.data)), store.get('projects', store.projectId));
  assert.deepEqual(readdirSync(path.join(root, 'backups')), ['snapshot.mioon']);
});

test('only the exact live store may create a backup; existing destinations are not overwritten', async t => {
  const {store, backupFile} = fixture(t);
  await assert.rejects(createProjectBackup({...store}, backupFile), TypeError);
  assert.equal(existsSync(backupFile), false);
  const identity = await createProjectBackup(store, backupFile), bytes = readFileSync(backupFile);
  await assert.rejects(createProjectBackup(store, backupFile), code('PROJECT_FILE_EXISTS'));
  assert.deepEqual(readFileSync(backupFile), bytes);
  assert.deepEqual(inspectProjectBackup(backupFile), identity);
  assert.throws(() => store.tx(() => createProjectBackup(store, backupFile)), /synchronous result/);
  store.close();
  await assert.rejects(createProjectBackup(store, `${backupFile}.closed`), TypeError);
});

test('backup reader is genuinely read-only, checks the dedicated marker and does not create local records', async t => {
  const {root, store, backupFile} = fixture(t);
  await createProjectBackup(store, backupFile);
  const bytes = readFileSync(backupFile), reader = openProjectBackup(backupFile);
  assert.throws(() => reader.db.exec("UPDATE projects SET data='{}'"), /readonly|read-only/i);
  assert.throws(() => reader.db.exec('PRAGMA query_only=OFF; CREATE TABLE probe(id)'));
  reader.close();
  assert.deepEqual(readFileSync(backupFile), bytes);
  assert.equal(existsSync(path.join(root, 'backups', 'history.db')), false);
  assert.throws(() => openProjectBackup(store.projectFile), code('PROJECT_BACKUP_INVALID'));
  const target = destination(root), copied = await copyProjectBackup({backupFile, sourceProjectDir: store.projectDir, projectFile: target});
  assert.equal(inspectCopiedProjectFile(target).projectId, copied.projectId);
  assert.throws(() => openProjectBackup(target), code('PROJECT_BACKUP_INVALID'));
  assert.equal(existsSync(path.join(path.dirname(target), 'local')), false);
});

test('a renamed or separately copied backup cannot be opened or registered as a normal project', async t => {
  const {root, store, backupFile} = fixture(t);
  await createProjectBackup(store, backupFile);
  const copied = path.join(root, 'pretend-project.mioon'); copyFileSync(backupFile, copied);
  let located = false, checkedCopy = false;
  for (const projectFile of [backupFile, copied]) {
    assert.throws(() => openProjectStore({projectFile, checkCopy: () => { checkedCopy = true; }, locate: () => { located = true; throw new Error('must not locate'); }}),
      (error: unknown) => code('PROJECT_INVALID')(error) && (error as {details: {reason: string}}).details.reason === 'not-a-project-file');
  }
  assert.equal(located, false);
  assert.equal(checkedCopy, false);
  assert.equal(existsSync(path.join(root, 'history.db')), false);
});

test('dedicated reader rejects symlinks, hard links, unknown format and altered schema', async t => {
  const {root, store, backupFile} = fixture(t);
  await createProjectBackup(store, backupFile);
  const symbolic = path.join(root, 'symbolic.mioon'); symlinkSync(backupFile, symbolic);
  assert.throws(() => openProjectBackup(symbolic), code('PROJECT_BACKUP_INVALID'));
  const hard = path.join(root, 'hard.mioon'); linkSync(backupFile, hard);
  assert.throws(() => openProjectBackup(hard), code('PROJECT_BACKUP_INVALID'));
  rmSync(hard);
  for (const [name, sql] of [['newer', 'UPDATE schema_version SET version=999'], ['schema', 'CREATE TABLE unexpected(id)']] as const) {
    const file = path.join(root, `${name}.mioon`); copyFileSync(backupFile, file);
    const db = new DatabaseSync(file);
    try { db.exec(sql); } finally { db.close(); }
    assert.throws(() => openProjectBackup(file), code('PROJECT_BACKUP_INVALID'), name);
  }
});

test('restore preserves real IDs, immutable content, BLOBs and project-owned references with a new owner ID', async t => {
  const {root, store, backupFile} = fixture(t), oldId = store.projectId;
  const assetId = randomUUID(), shotId = randomUUID(), subjectId = randomUUID(), versionId = randomUUID(), lutId = randomUUID(), timelineId = randomUUID();
  const legacyVersionId = randomUUID(), jobId = randomUUID(), nodeId = randomUUID(), edgeId = randomUUID(), groupId = randomUUID();
  const content = Buffer.from('LUT copy bytes'), sha256 = createHash('sha256').update(content).digest('hex'), now = '2026-11-03T00:00:00Z';
  store.tx(() => {
    store.put('assets', {id: assetId, projectId: oldId, kind: 'image'});
    store.put('shots', {id: shotId, projectId: oldId, title: '镜头', selectedVersionId: legacyVersionId});
    store.put('versions', {id: legacyVersionId, projectId: oldId, jobId, shotId});
    store.put('nodes', {id: nodeId, projectId: oldId, type: 'note', text: oldId});
    store.put('edges', {id: edgeId, projectId: oldId, from: nodeId, to: nodeId});
    store.put('timelines', {id: timelineId, projectId: oldId, width: 1920, height: 1080, fps: 30, clips: [], tracks: []});
    store.db.prepare("INSERT INTO asset_annotations VALUES(?,?,1,'[]','保留标注')").run(assetId, oldId);
    store.db.prepare("INSERT INTO asset_dispositions VALUES(?,?,1,'favorite')").run(assetId, oldId);
    store.db.prepare('INSERT INTO asset_ranges VALUES(?,?,1,0,30)').run(assetId, oldId);
    store.db.prepare("INSERT INTO subjects VALUES(?,?,'character','主体',1,?,?,?)").run(subjectId, oldId, versionId, now, now);
    store.db.prepare('INSERT INTO subject_versions VALUES(?,?,?,1,?,?)').run(versionId, oldId, subjectId, assetId,
      JSON.stringify({id: versionId, projectId: oldId, subjectId, number: 1, assetId}));
    store.db.prepare("INSERT INTO image_groups VALUES(?,?,'图像组',1,NULL,NULL,?,?)").run(groupId, oldId, now, now);
    store.db.prepare("INSERT INTO project_lut_resources VALUES(?,?,'LUT',?,?,'mioon-cube3d-normalized-tetrahedral-v1','{}',?,?)").run(lutId, oldId, sha256, content.length, content, now);
    store.db.prepare("INSERT INTO idempotency VALUES('restore-source',?,'hash','not-copied')").run(randomUUID());
  });
  const before = Object.fromEntries(CONTENT_TABLES.map(table => [table, store.db.prepare(`SELECT * FROM project."${table}"`).all()]));
  await createProjectBackup(store, backupFile);
  const projectFile = destination(root), newId = randomUUID();
  const result = await copyProjectBackup({backupFile, sourceProjectDir: store.projectDir, projectFile, projectId: newId});
  assert.equal(result.projectId, newId);
  assert.notEqual(newId, oldId);
  assert.equal(result.contentSequence, sequence(store));
  assert.equal(existsSync(path.join(path.dirname(projectFile), 'local')), false);
  const restored = openRecovered(projectFile); t.after(() => restored.close());
  assert.equal(restored.historyState, 'fresh');
  assert.deepEqual(restored.get('projects', newId), {id: newId, name: '备份项目', note: oldId});
  assert.equal((restored.get('nodes', nodeId) as {text: string}).text, oldId);
  assert.deepEqual(restored.get('versions', legacyVersionId), {id: legacyVersionId, projectId: newId, jobId, shotId});
  assert.equal(restored.db.prepare('SELECT count(*) AS n FROM main.jobs').get()?.n, 0);
  assert.equal(restored.db.prepare('SELECT count(*) AS n FROM main.idempotency').get()?.n, 0);
  assert.equal(restored.db.prepare('SELECT count(*) AS n FROM main.mio_runs').get()?.n, 0);
  assert.equal(restored.db.prepare('SELECT projectId FROM subject_versions WHERE id=?').get(versionId)?.projectId, newId);
  assert.equal(JSON.parse(String(restored.db.prepare('SELECT data FROM subject_versions WHERE id=?').get(versionId)?.data)).projectId, newId);
  assert.deepEqual(Buffer.from(restored.db.prepare('SELECT content FROM project_lut_resources WHERE id=?').get(lutId)?.content as Uint8Array), content);
  assert.equal(restored.db.prepare('SELECT count(*) AS n FROM project.agent_task_target_revisions_v2 WHERE projectId=?').get(oldId)?.n, 0);
  assert.throws(() => restored.db.prepare('DELETE FROM subject_versions WHERE id=?').run(versionId), /retained/);
  assert.throws(() => restored.db.prepare('UPDATE project.project_file SET projectId=?').run(oldId), /IMMUTABLE/);
  assert.deepEqual(restored.db.prepare('PRAGMA project.foreign_key_check').all(), []);
  for (const table of CONTENT_TABLES) assert.deepEqual(store.db.prepare(`SELECT * FROM project."${table}"`).all(), before[table], `${table}: source unchanged`);
});

test('restore refuses an existing target, a reused project ID and a copied reader capability', async t => {
  const {root, store, backupFile} = fixture(t);
  await createProjectBackup(store, backupFile);
  const projectFile = destination(root); writeFileSync(projectFile, 'existing file');
  await assert.rejects(copyProjectBackup({backupFile, sourceProjectDir: store.projectDir, projectFile}), code('PROJECT_FILE_EXISTS'));
  assert.equal(readFileSync(projectFile, 'utf8'), 'existing file');
  const fresh = destination(root, 'fresh');
  await assert.rejects(copyProjectBackup({backupFile, sourceProjectDir: store.projectDir, projectFile: fresh, projectId: store.projectId}), TypeError);
  assert.equal(existsSync(fresh), false);
  const reader = openProjectBackup(backupFile);
  await assert.rejects(copyProjectToNewFile({...reader}, {sourceProjectDir: store.projectDir, projectFile: fresh}), TypeError);
  reader.close();
  await assert.rejects(copyProjectToNewFile(reader, {sourceProjectDir: store.projectDir, projectFile: fresh}), TypeError);
});

test('reference copy does not copy media or replace a destination file', async t => {
  const {root, store, backupFile} = fixture(t), assetId = randomUUID(), bytes = Buffer.from('media bytes');
  const relativePath = `media/${assetId}.png`, sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(path.join(store.projectDir, relativePath), bytes, {mode: 0o600});
  store.put('assets', {id: assetId, projectId: store.projectId, kind: 'image', reference:referenceFixture(store.projectDir,relativePath,sha256,bytes.length),referenceRevision:1,sha256,sizeBytes:bytes.length});
  await createProjectBackup(store, backupFile);
  const projectFile = destination(root), result = await copyProjectBackup({backupFile, sourceProjectDir: store.projectDir, projectFile});
  assert.equal(inspectCopiedProjectFile(projectFile).projectId, result.projectId);
  assert.equal(existsSync(path.join(path.dirname(projectFile),relativePath)),false);
  assert.deepEqual(readFileSync(path.join(store.projectDir,relativePath)),bytes);
  assert.deepEqual(readFileSync(path.join(store.projectDir, relativePath)), bytes);
  const blocked = destination(root, 'blocked'), blockedMedia = path.join(path.dirname(blocked), 'media'); mkdirSync(blockedMedia, {mode: 0o700});
  writeFileSync(path.join(blockedMedia, `${assetId}.png`), 'existing media', {mode: 0o600});
  const independent=await copyProjectBackup({backupFile,sourceProjectDir:store.projectDir,projectFile:blocked});
  assert.equal(inspectCopiedProjectFile(blocked).projectId,independent.projectId);
  assert.equal(readFileSync(path.join(blockedMedia, `${assetId}.png`), 'utf8'), 'existing media');
});

test('copy preserves a changed reference without reading or accepting its new bytes', async t => {
  const {root, store, backupFile} = fixture(t), assetId = randomUUID(), bytes = Buffer.from('original');
  const relativePath = `media/${assetId}.png`, sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(path.join(store.projectDir, relativePath), bytes, {mode: 0o600});
  store.put('assets', {id: assetId, projectId: store.projectId, reference:referenceFixture(store.projectDir,relativePath,sha256,bytes.length),referenceRevision:1,sha256,sizeBytes:bytes.length});
  await createProjectBackup(store, backupFile);
  writeFileSync(path.join(store.projectDir, relativePath), 'changed!', {mode: 0o600});
  const projectFile = destination(root);
  const copied=await copyProjectBackup({backupFile,sourceProjectDir:store.projectDir,projectFile});
  assert.equal(inspectCopiedProjectFile(projectFile).projectId,copied.projectId);
  assert.deepEqual(readdirSync(path.dirname(projectFile)),['project.mioon']);
  const recovered=openRecovered(projectFile);t.after(()=>recovered.close());
  assert.equal((recovered.get('assets',assetId) as {sha256:string}).sha256,sha256);
  assert.equal(readFileSync(path.join(store.projectDir,relativePath),'utf8'),'changed!');
  assert.equal(inspectProjectBackup(backupFile).projectId, store.projectId);
});

test('the S5 copy primitive also accepts a live owner and produces a separately openable project', async t => {
  const {root, store} = fixture(t), projectFile = destination(root), before = sequence(store);
  const result = await copyProjectToNewFile(store, {sourceProjectDir: store.projectDir, projectFile});
  assert.notEqual(result.projectId, store.projectId);
  assert.equal(sequence(store), before);
  const other = openRecovered(projectFile); t.after(() => other.close());
  assert.deepEqual(plain(other.db.prepare('SELECT projectId,seenContentSequence FROM main.history_state').get()), {projectId: result.projectId, seenContentSequence: before});
  assert.equal(other.get('projects', store.projectId), null);
  other.put('projects', {id: result.projectId, name: 'independent'});
  assert.equal((store.get('projects', store.projectId) as {name: string}).name, '备份项目');
});

test('portable 0755 project folders preserve nested references without broadening their directory permission', async t => {
  const {root, store, backupFile} = fixture(t), assetId = randomUUID(), bytes = Buffer.from('nested media');
  const relativePath = `media/nested/${assetId}.png`, sha256 = createHash('sha256').update(bytes).digest('hex');
  chmodSync(store.projectDir, 0o755);
  mkdirSync(path.join(store.projectDir, 'media', 'nested'), {mode: 0o700});
  writeFileSync(path.join(store.projectDir, relativePath), bytes, {mode: 0o600});
  store.put('assets', {id: assetId, projectId: store.projectId, reference:referenceFixture(store.projectDir,relativePath,sha256,bytes.length),referenceRevision:1,sha256,sizeBytes:bytes.length});
  await createProjectBackup(store, backupFile);
  const projectFile = destination(root); chmodSync(path.dirname(projectFile), 0o755);
  const result = await copyProjectBackup({backupFile, sourceProjectDir: store.projectDir, projectFile});
  assert.equal(inspectCopiedProjectFile(projectFile).projectId, result.projectId);
  assert.equal(existsSync(path.join(path.dirname(projectFile),relativePath)),false);
  assert.deepEqual(readFileSync(path.join(store.projectDir,relativePath)),bytes);
  const recovered = openRecovered(projectFile); t.after(() => recovered.close());
  assert.equal(recovered.projectId, result.projectId);
  const asset=recovered.get('assets',assetId) as {reference:{path:string};relativePath?:unknown};
  assert.equal(path.resolve(path.dirname(projectFile),asset.reference.path),path.join(store.projectDir,relativePath));
  assert.equal(asset.relativePath,undefined);
});

test('a directory-sync failure after publication preserves the complete reference-only target for intent recovery', async t => {
  const {root, store, backupFile} = fixture(t), assetId = randomUUID(), bytes = Buffer.from('published media');
  const relativePath = `media/${assetId}.png`, sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(path.join(store.projectDir, relativePath), bytes, {mode: 0o600});
  store.put('assets', {id: assetId, projectId: store.projectId, reference:referenceFixture(store.projectDir,relativePath,sha256,bytes.length),referenceRevision:1,sha256,sizeBytes:bytes.length});
  await createProjectBackup(store, backupFile);
  const projectFile = destination(root), projectId = randomUUID(), directory = fs.statSync(path.dirname(projectFile)), original = fs.fsyncSync;
  let injected = 0;
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    const current = fs.fstatSync(fd);
    if (current.isDirectory() && current.dev === directory.dev && current.ino === directory.ino) {
      injected++;
      throw Object.assign(new Error('directory durability unconfirmed'), {code: 'EIO'});
    }
    return original(fd);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(copyProjectBackup({backupFile, sourceProjectDir: store.projectDir, projectFile, projectId}), code('EIO'));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(injected, 1);
  assert.equal(inspectCopiedProjectFile(projectFile).projectId, projectId);
  assert.equal(existsSync(path.join(path.dirname(projectFile),relativePath)),false);
  assert.deepEqual(readFileSync(path.join(store.projectDir,relativePath)),bytes);
  assert.equal(existsSync(path.join(path.dirname(projectFile), 'local')), false);
  const recovered = openRecovered(projectFile); t.after(() => recovered.close());
  assert.equal((recovered.get('assets', assetId) as {projectId: string}).projectId, projectId);
});

test('a prepublication failure can retry the same new project ID with verified surviving media without changing its inode', async t => {
  const {root, store, backupFile} = fixture(t), assetId = randomUUID(), bytes = Buffer.from('media published before crash');
  const relativePath = `media/${assetId}.png`, sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(path.join(store.projectDir, relativePath), bytes, {mode: 0o600});
  store.put('assets', {id: assetId, projectId: store.projectId, reference:referenceFixture(store.projectDir,relativePath,sha256,bytes.length),referenceRevision:1,sha256,sizeBytes:bytes.length});
  await createProjectBackup(store, backupFile);
  const projectFile = destination(root), projectId = randomUUID(), original = fs.linkSync;
  let injected = 0;
  t.mock.method(fs, 'linkSync', (source: fs.PathLike, target: fs.PathLike) => {
    if (String(target) === projectFile) {
      injected++;
      throw Object.assign(new Error('publication interrupted'), {code: 'EIO'});
    }
    return original(source, target);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(copyProjectBackup({backupFile, sourceProjectDir: store.projectDir, projectFile, projectId}), code('EIO'));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(injected, 1);
  assert.equal(existsSync(projectFile), false);
  // Reproduce what survives an abrupt process termination before its finally
  // could remove the media: exact recorded bytes, no published project yet.
  const media = path.join(path.dirname(projectFile), 'media');
  mkdirSync(media, {mode: 0o700});
  const survived = path.join(path.dirname(projectFile), relativePath);
  copyFileSync(path.join(store.projectDir, relativePath), survived);
  const before = fs.statSync(survived, {bigint: true});
  const result = await copyProjectBackup({backupFile, sourceProjectDir: store.projectDir, projectFile, projectId});
  const after = fs.statSync(survived, {bigint: true});
  assert.equal(result.projectId, projectId);
  assert.equal(inspectCopiedProjectFile(projectFile).projectId, projectId);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(readFileSync(survived), bytes);
  assert.equal(existsSync(path.join(path.dirname(projectFile), 'local')), false);
});


test('reference relocation preserves exact Unicode spelling and case even when the file is missing',async t=>{
 const {root,store,backupFile}=fixture(t),id=randomUUID(),source='素材/Cafe\u0301.PNG';
 store.put('assets',{id,projectId:store.projectId,sha256:null,sizeBytes:7,referenceRevision:1,reference:{pathForm:'relative',path:source,volume:null,sizeBytes:7,mtimeMs:0,sampledSha256:'0'.repeat(64),fullSha256:null}});
 await createProjectBackup(store,backupFile);
 const projectFile=destination(root),result=await copyProjectBackup({backupFile,sourceProjectDir:store.projectDir,projectFile});
 const recovered=openRecovered(projectFile);t.after(()=>recovered.close());
 const asset=recovered.get('assets',id) as {reference:{path:string};projectId:string};
 assert.equal(asset.projectId,result.projectId);assert.ok(asset.reference.path.endsWith('/'+source));
 assert.equal(asset.reference.path.includes('Café'),false);assert.equal(asset.reference.path.endsWith('.PNG'),true);
 assert.equal(existsSync(path.join(path.dirname(projectFile),'素材')),false);
});
