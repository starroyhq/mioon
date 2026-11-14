import {testEnv} from './helpers/test-env.ts';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createProjectFile, openProjectConnection} from '../packages/business/src/project-file/connection.ts';
import {buildDatabase, HISTORY_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {HISTORY_UPGRADES} from '../packages/business/src/project-file/schema/history-upgrades.ts';
import {SCHEMA_MANIFEST} from '../packages/business/src/project-file/schema/manifest.ts';
import {S8_HISTORY_V9_MANIFEST} from '../packages/business/src/project-file/schema/history-v9-manifest.ts';
import {readSchemaManifest} from '../packages/business/src/project-file/schema/manifest-check.ts';
import {LEGACY_MIO_TABLES} from '../packages/business/src/project-file/schema/tables.ts';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS, canonicalImageInput as canonical} from '../packages/contracts/src/images.ts';
import {IMAGE_EDIT_REVIEW_DESTINATION, IMAGE_REVIEW_DESTINATION, IMAGE_REVIEW_POLICY, imageReviewIntentSchema} from '../packages/contracts/src/image-reviews.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';
import {COMFY_IMAGE_OPTIONS, COMFY_IMAGE_POLICY, DEFAULT_COMFY_IMAGE_CONFIGURATION} from '../packages/contracts/src/comfy-images.ts';
import {buildComfyWorkflow, hashComfyWorkflow} from '../packages/business/src/comfy/workflow.ts';
import {buildPreviousHistoryDatabase, type PreviousHistoryVersion} from './fixtures/kernel-history-previous-schema.ts';

const at = '2026-11-04T00:00:00.000Z', FINAL_VERSION = 'UPDATE main.schema_version SET version=10';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const WORKER = fileURLToPath(new URL('./helpers/generation-services-history-upgrade-worker.ts', import.meta.url));
const POINTS = ['after-drop', 'after-create', 'after-copy', 'after-index', 'after-trigger', 'before-version', 'after-version'] as const;

function readAll(db: DatabaseSync) {
  const tables = db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").all().map(row => String(row.name));
  return {manifest: readSchemaManifest(db, 'main'), version: db.prepare('SELECT version FROM main.schema_version ORDER BY version').all(),
    tables: Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT rowid AS retained_rowid,* FROM main.${quote(name)} ORDER BY rowid`).all()])),
    columns: Object.fromEntries(tables.map(name => [name, db.prepare(`PRAGMA main.table_info(${quote(name)})`).all().map(row => String(row.name))]))};
}

/** Historical declarations come only from frozen SQL. These values seed
 * retained rows, never derive an old declaration from today's constructor. */
function review(projectId: string, schemaVersion = 1) {
  const input: Record<string, unknown> = {projectId, requestId: randomUUID(), name: `Retained review v${schemaVersion}`, providerId: 'openai', model: IMAGE_MODELS.openai, prompt: '保留原始 JSON 🙂\r\n第二行', options: {...IMAGE_FIXED_OPTIONS}};
  const intent: Record<string, unknown> = {schemaVersion, reviewId: randomUUID(), input, settingsRevision: 1, destination: IMAGE_REVIEW_DESTINATION, policy: {...IMAGE_REVIEW_POLICY}};
  if (schemaVersion === 2 || schemaVersion === 6) {
    const configuration = {...(schemaVersion === 2 ? DEFAULT_CUSTOM_IMAGE_CONFIGURATION : DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2), enabled: true, baseUrl: 'https://images.example.com/v1', model: 'retained-custom-model'};
    input.providerId = 'openai-compatible'; input.model = configuration.model;
    intent.configuration = configuration; intent.destination = configuration.baseUrl + '/images/generations';
    if (schemaVersion === 6) {intent.connectionId = randomUUID(); intent.configurationRevision = 1;}
  }
  if (schemaVersion === 3) {
    const configuration = {...DEFAULT_COMFY_IMAGE_CONFIGURATION, enabled: true, baseUrl: 'http://127.0.0.1:8188', model: 'retained.safetensors'};
    input.providerId = 'comfy-local'; input.model = configuration.model; input.options = {...COMFY_IMAGE_OPTIONS};
    const outputNonce = randomUUID(), seed = 123, graph = buildComfyWorkflow({prompt: String(input.prompt), checkpoint: configuration.model, seed, outputNonce});
    intent.configuration = configuration; intent.destination = configuration.baseUrl + '/prompt'; intent.policy = {...COMFY_IMAGE_POLICY};
    intent.execution = {workflowId: 'comfy-t2i-png-v1', workflowVersion: 1, comfyVersion: '0.39.0', seed, promptId: randomUUID(), clientId: randomUUID(), outputNonce, filenamePrefix: `mioon_${outputNonce}`, graph, graphHash: hashComfyWorkflow(graph)};
  }
  if (schemaVersion === 4 || schemaVersion === 5) {
    const assetId = randomUUID(), hash = 'a'.repeat(64), name = '保留源图.png';
    input.purpose = 'edit'; input.inputImage = {assetId, sha256: hash}; intent.destination = IMAGE_EDIT_REVIEW_DESTINATION;
    intent.sourceImage = {assetId, sha256: hash, mimeType: 'image/png', byteLength: 100, width: 64, height: 96, name,
      origin: schemaVersion === 4 ? {kind: 'user-import'} : {kind: 'previs-output', publicationId: randomUUID(), previsOutput: {projectId, nodeId: randomUUID(), keyframeId: 'k1', sceneRevision: 2, requestId: randomUUID(), name, sha256: hash, width: 64, height: 96}}};
  }
  imageReviewIntentSchema.parse(intent);
  return {input, intent};
}
function insertReview(db: DatabaseSync, projectId: string, schemaVersion: number, rowid: number, state: 'pending' | 'approved' | 'rejected' = 'pending') {
  const {input, intent} = review(projectId, schemaVersion), originalInput = canonical(input), originalIntent = canonical(intent);
  db.prepare(`INSERT INTO image_reviews(rowid,id,projectId,requestId,inputHash,canonicalInput,intentHash,canonicalIntent,state,revision,taskId,postAttempts,createdAt,updatedAt,approvedAt,rejectedAt,dispatchedAt)
    VALUES(?,?,?,?,?,?,?,?,'pending',1,NULL,0,?,?,NULL,NULL,NULL)`).run(rowid, String(intent.reviewId), projectId, String(input.requestId), sha(originalInput), originalInput, sha(originalIntent), originalIntent, at, at);
  if (state === 'approved') {
    const taskId = randomUUID(), groupId = randomUUID(), snapshot = canonical({schemaVersion: 1, projectId, groupId, taskId, name: input.name, prompt: input.prompt, providerId: input.providerId, model: input.model, options: input.options});
    db.prepare(`INSERT INTO image_tasks(id,projectId,groupId,requestId,inputHash,input,snapshot,state,revision,dispatched,stagedReceipt,versionId,errorCode,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,'queued',1,0,NULL,NULL,NULL,?,?)`).run(taskId, projectId, groupId, String(input.requestId), sha(originalInput), originalInput, snapshot, at, at);
    db.prepare("UPDATE image_reviews SET state='approved',revision=2,taskId=?,approvedAt=? WHERE id=?").run(taskId, at, String(intent.reviewId));
  } else if (state === 'rejected') db.prepare("UPDATE image_reviews SET state='rejected',revision=2,rejectedAt=? WHERE id=?").run(at, String(intent.reviewId));
}
function seedDrafts(db: DatabaseSync, projectId: string) {
  for (const kind of ['clip', 'delivery', 'shot-text']) db.prepare('INSERT INTO local_draft_states(kind,workspaceScope) VALUES(?,?)').run(kind, sha('G1 retained workspace'));
  const timelineId = randomUUID(), clipId = randomUUID(), shotId = randomUUID();
  const clip = JSON.stringify({projectId, timelineId, clipId, revision: 2, draft: {raw: {name: '原始剪辑🙂', sourceInFrame: '0.'}}});
  db.prepare('INSERT INTO local_clip_drafts(rowid,projectId,timelineId,clipId,revision,data,ordinal) VALUES(31,?,?,?,?,?,7)').run(projectId, timelineId, clipId, 2, clip);
  const delivery = JSON.stringify({projectId, draftRevision: 3, intentRevision: 0, draft: {raw: {name: '交付草稿🙂'}}, intent: null});
  db.prepare('INSERT INTO local_delivery_drafts(rowid,projectId,draftRevision,intentRevision,intentId,requestId,intentStatus,data,ordinal) VALUES(43,?,3,0,NULL,NULL,NULL,?,19)').run(projectId, delivery);
  const shot = JSON.stringify({projectId, shotId, draftRevision: 1, intentRevision: 0, draft: {prompt: '镜头文本原字节🙂'}, intent: null});
  db.prepare('INSERT INTO local_shot_text_drafts(rowid,projectId,shotId,draftRevision,intentRevision,intentId,requestId,intentStatus,data,ordinal) VALUES(53,?,?,1,0,NULL,NULL,NULL,?,23)').run(projectId, shotId, shot);
}
function fixture(t: TestContext, version: PreviousHistoryVersion = 9) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-g1-history-upgrade-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  const projectFile = path.join(root, 'Project.mioon'), projectId = createProjectFile(projectFile), localDir = path.join(root, 'records'), cacheDir = path.join(root, 'cache'), tempDir = path.join(root, 'tmp');
  for (const directory of [localDir, cacheDir, tempDir]) mkdirSync(directory, {mode: 0o700});
  const project = new DatabaseSync(projectFile); let stamp: {contentSequence: number; contentToken: string};
  try {project.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId, JSON.stringify({id: projectId, name: 'G1 retained project', revision: 1})); stamp = project.prepare('SELECT contentSequence,contentToken FROM project_file').get() as typeof stamp;} finally {project.close();}
  const cache = new DatabaseSync(path.join(cacheDir, 'cache.db')); try {cache.exec('BEGIN'); buildDatabase(cache, 'cache', 'main'); cache.exec('COMMIT');} finally {cache.close();}
  const historyFile = path.join(localDir, 'history.db'), history = new DatabaseSync(historyFile);
  try {
    history.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; BEGIN'); buildPreviousHistoryDatabase(history, version);
    if (version >= 6) history.exec('INSERT INTO mio_storage_counters VALUES(1,0,1)');
    if (version >= 8) history.prepare('INSERT INTO history_state VALUES(1,?,?,?)').run(projectId, stamp.contentSequence, stamp.contentToken);
    else history.prepare('INSERT INTO history_state VALUES(1,?,?)').run(projectId, stamp.contentSequence);
    insertReview(history, projectId, 1, 17); insertReview(history, projectId, 1, 41, 'approved'); insertReview(history, projectId, 1, 73, 'rejected');
    if (version === 9) {for (const [index, branch] of [2, 3, 4, 5].entries()) insertReview(history, projectId, branch, 101 + index * 36); seedDrafts(history, projectId);}
    history.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run('g1-retained', 'opaque-request', 'opaque-hash', 'original-resource');
    history.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(randomUUID(), projectId, '{"status":"running","raw":"原始任务🙂"}');
    if (version === 2) {
      const runId = randomUUID(), stepId = randomUUID();
      history.prepare('INSERT INTO agent_task_runs_v2 VALUES(?,?,?,?,?,?,?)').run(runId, projectId, randomUUID(), 'a'.repeat(64), 'completed', 1, JSON.stringify({conversationId: randomUUID(), notes: [], skippedTargets: []}));
      history.prepare('INSERT INTO agent_task_steps_v2 VALUES(?,?,?,?,?,?)').run(stepId, runId, projectId, 1, 'completed', '{}');
      history.prepare('INSERT INTO agent_task_changes_v2 VALUES(?,?,?,?,?)').run(randomUUID(), runId, stepId, projectId, '{"retained":"pre-release undo"}');
    } else {
      const blob = '原始 Mio 请求🙂\r\n'; history.prepare('INSERT INTO mio_blobs VALUES(?,?,?,?)').run(sha(blob), Buffer.byteLength(blob), blob, at);
      history.prepare('INSERT INTO mio_conversations VALUES(?,?,?,?)').run(randomUUID(), projectId, at, at);
    }
    if (version >= 6) {
      const raw = Buffer.from('{"frozen":"版本内容🙂"}'), payload = gzipSync(raw), digest = sha(raw);
      history.prepare("INSERT INTO project_version_blobs VALUES(?,1,'gzip',?,?,?)").run(digest, raw.length, payload.length, payload);
      history.prepare("INSERT INTO project_versions(rowid,id,projectId,trigger,name,mioRunId,contentSequence,createdAt,blobHash,mioChangeRowid) VALUES(71,?,?,'manual','Retained version',NULL,?,?,?,9)").run(randomUUID(), projectId, stamp.contentSequence, at, digest);
      history.prepare("INSERT INTO project_version_requests VALUES(?,?,'project.version.save',?,?)").run(projectId, randomUUID(), 'a'.repeat(64), '{"receipt":"原始回执🙂"}');
    }
    history.exec('COMMIT'); assert.deepEqual(history.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {history.close();}
  const inspect = () => {const db = new DatabaseSync(historyFile); try {return readAll(db);} finally {db.close();}};
  const files = () => ({project: sha(readFileSync(projectFile)), cache: sha(readFileSync(path.join(cacheDir, 'cache.db')))});
  const open = () => openProjectConnection({projectFile, locate: () => ({localDir, cacheDir, tempDir})});
  return {root, projectFile, projectId, localDir, cacheDir, tempDir, historyFile, inspect, files, open};
}
function retained(before: ReturnType<typeof readAll>, db: DatabaseSync, version = 9) {
  for (const [name, rows] of Object.entries(before.tables)) {
    if (name === 'schema_version' || version === 2 && LEGACY_MIO_TABLES.includes(name)) continue;
    assert.deepEqual(db.prepare(`SELECT rowid AS retained_rowid,${before.columns[name]!.map(quote).join(',')} FROM main.${quote(name)} ORDER BY rowid`).all(), rows, `${name}: retain original columns, rowids and bytes`);
  }
}
function hit(point: string, sql: string): boolean {
  if (point === 'before-version' || point === 'after-version') return sql === FINAL_VERSION;
  if (point === 'after-drop') return sql === 'DROP TABLE main.image_reviews';
  if (point === 'after-create') return sql.startsWith('CREATE TABLE main."image_reviews"(');
  if (point === 'after-copy') return sql.startsWith('INSERT INTO main.image_reviews(rowid,');
  if (point === 'after-index') return sql.startsWith('CREATE INDEX main.image_reviews_project_page ');
  return point === 'after-trigger' && /^CREATE TRIGGER main\.\w+ .*\bON image_reviews\b/u.test(sql);
}

test('the sealed S8 v9 SQL matches its exact manifest and admits all five retained review intents', t => {
  const f = fixture(t), before = f.inspect(); assert.equal(before.version[0]!.version, 9); assert.deepEqual(before.manifest, S8_HISTORY_V9_MANIFEST.entries);
  assert.deepEqual([...new Set(before.tables.image_reviews!.map(row => JSON.parse(String(row.canonicalIntent)).schemaVersion))].sort(), [1, 2, 3, 4, 5]);
  const db = new DatabaseSync(f.historyFile); try {assert.throws(() => insertReview(db, f.projectId, 6, 999), /CHECK constraint failed/); assert.deepEqual(readAll(db), before);} finally {db.close();}
});

for (const version of [2, 3, 4, 5, 6, 7, 8, 9] as const) test(`the exact history${version} profile upgrades directly to10, retaining reviews, task FKs and unrelated domains`, t => {
  const f = fixture(t, version), before = f.inspect(), files = f.files();
  const upgrade = HISTORY_UPGRADES.find(value => value.from.version === version); assert.ok(upgrade); assert.equal(upgrade.toVersion, 10); assert.deepEqual(before.manifest, upgrade.from.entries);
  const connection = f.open();
  try {
    assert.equal(HISTORY_SCHEMA_VERSION, 10); assert.equal(connection.db.prepare('SELECT version FROM main.schema_version').get()!.version, 10);
    assert.deepEqual(readSchemaManifest(connection.db, 'main'), SCHEMA_MANIFEST.history.entries); retained(before, connection.db, version);
    assert.equal(connection.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1); assert.deepEqual(connection.db.prepare('PRAGMA main.foreign_key_check').all(), []);
    assert.equal(connection.historyState, version >= 8 ? 'current' : 'diverged');
    if (version === 2) {for (const table of LEGACY_MIO_TABLES) assert.equal(connection.db.prepare('SELECT 1 FROM main.sqlite_schema WHERE name=?').get(table), undefined); assert.equal(connection.db.prepare('SELECT count(*) n FROM main.mio_runs').get()!.n, 0);}
  } finally {connection.close();}
  assert.deepEqual(f.files(), files); const after = f.inspect(); f.open().close(); assert.deepEqual(f.inspect(), after, 'current10 reopen does not repeat a rebuild');
});

test('v9 writes version10 exactly once and last inside the same image-review rebuild transaction', t => {
  const f = fixture(t), exec = DatabaseSync.prototype.exec, changes: {sql: string; transaction: boolean; version: unknown}[] = []; let rebuilding = false;
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string): void {
    if (sql.startsWith('CREATE TEMP TABLE s2_retained_image_reviews ')) rebuilding = true;
    if (rebuilding && /^(?:CREATE|DROP|INSERT|UPDATE) /u.test(sql)) changes.push({sql, transaction: this.isTransaction, version: this.prepare('SELECT version FROM main.schema_version').get()!.version});
    exec.call(this, sql); if (rebuilding && sql === 'COMMIT') rebuilding = false;
  });
  try {f.open().close();} finally {mock.mock.restore();}
  assert.ok(changes.length > 10); assert.ok(changes.every(change => change.transaction && change.version === 9));
  assert.equal(changes.filter(change => change.sql === FINAL_VERSION).length, 1); assert.equal(changes.at(-1)!.sql, FINAL_VERSION);
});

test('upgraded v9 accepts a new v6 service intent without rewriting any v1–5 review or local draft', t => {
  const f = fixture(t), before = f.inspect(); f.open().close();
  const db = new DatabaseSync(f.historyFile);
  try {
    insertReview(db, f.projectId, 6, 999); assert.equal(db.prepare('SELECT count(*) n FROM image_reviews').get()!.n, before.tables.image_reviews!.length + 1);
    assert.deepEqual(db.prepare('SELECT rowid AS retained_rowid,* FROM image_reviews WHERE rowid<>999 ORDER BY rowid').all(), before.tables.image_reviews);
    for (const table of ['local_draft_states', 'local_clip_drafts', 'local_delivery_drafts', 'local_shot_text_drafts']) assert.deepEqual(db.prepare(`SELECT rowid AS retained_rowid,* FROM ${table} ORDER BY rowid`).all(), before.tables[table]);
  } finally {db.close();}
});

for (const point of POINTS) test(`v9 exception ${point} restores the complete old schema, rowids, reviews and drafts`, t => {
  const f = fixture(t), before = f.inspect(), files = f.files(), exec = DatabaseSync.prototype.exec; let reached = false;
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string): void {
    if (point === 'before-version' && hit(point, sql)) {reached = true; throw Error('G1 injected before-version failure');}
    exec.call(this, sql); if (point !== 'before-version' && hit(point, sql)) {reached = true; throw Error('G1 injected rebuild failure');}
  });
  try {assert.throws(() => f.open(), {code: 'PROJECT_INVALID'}); assert.equal(reached, true);} finally {mock.mock.restore();}
  assert.deepEqual(f.inspect(), before); assert.deepEqual(f.files(), files); const connection = f.open(); try {retained(before, connection.db);} finally {connection.close();}
});

for (const point of [...POINTS, 'after-commit']) test(`v9 SIGKILL ${point} recovers exact old9 or fully committed10`, {timeout: 60000}, t => {
  const f = fixture(t), before = f.inspect(), files = f.files();
  const result = spawnSync(process.execPath, [WORKER, JSON.stringify({projectFile: f.projectFile, localDir: f.localDir, cacheDir: f.cacheDir, tempDir: f.tempDir, point})], {env: testEnv(), stdio: 'ignore', timeout: 30000});
  assert.equal(result.error, undefined); assert.equal(result.signal, 'SIGKILL');
  if (point === 'after-commit') {
    const recovered = f.inspect(); assert.deepEqual(recovered.manifest, SCHEMA_MANIFEST.history.entries); assert.equal(recovered.version[0]!.version, 10);
    const db = new DatabaseSync(f.historyFile); try {retained(before, db);} finally {db.close();}
  } else assert.deepEqual(f.inspect(), before);
  assert.deepEqual(f.files(), files); const connection = f.open(); try {retained(before, connection.db);} finally {connection.close();}
});

test('a lost acknowledgement after COMMIT leaves complete10 rather than claiming a false rollback', t => {
  const f = fixture(t), before = f.inspect(), files = f.files(), exec = DatabaseSync.prototype.exec; let rebuilding = false, reached = false;
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string): void {
    exec.call(this, sql); if (sql === 'DROP TABLE main.image_reviews') rebuilding = true;
    if (rebuilding && sql === 'COMMIT') {reached = true; throw Error('G1 lost upgrade acknowledgement after COMMIT');}
  });
  try {assert.throws(() => f.open(), {code: 'PROJECT_INVALID'}); assert.equal(reached, true);} finally {mock.mock.restore();}
  const db = new DatabaseSync(f.historyFile); try {assert.equal(db.prepare('SELECT version FROM schema_version').get()!.version, 10); assert.deepEqual(readSchemaManifest(db, 'main'), SCHEMA_MANIFEST.history.entries); retained(before, db);} finally {db.close();}
  assert.deepEqual(f.files(), files); f.open().close();
});

for (const damage of ['extra-object', 'missing-index', 'changed-trigger', 'extra-version', 'unknown-version', 'future-version', 'labelled8'] as const) test(`unrecognized v9 ${damage} is rejected without schema or data repair`, t => {
  const f = fixture(t), db = new DatabaseSync(f.historyFile);
  try {
    if (damage === 'extra-object') db.exec('CREATE TABLE unreviewed_generation_service(value TEXT)');
    else if (damage === 'missing-index') db.exec('DROP INDEX image_reviews_project_page');
    else if (damage === 'changed-trigger') db.exec('DROP TRIGGER retain_image_reviews;CREATE TRIGGER retain_image_reviews BEFORE DELETE ON image_reviews BEGIN SELECT 1;END');
    else if (damage === 'extra-version') db.exec('INSERT INTO schema_version VALUES(8)');
    else db.prepare('UPDATE schema_version SET version=?').run(damage === 'future-version' ? 11 : damage === 'unknown-version' ? 1 : 8);
  } finally {db.close();}
  const before = f.inspect(), files = f.files(), bytes = sha(readFileSync(f.historyFile));
  assert.throws(() => f.open(), {code: damage === 'future-version' ? 'PROJECT_FORMAT_NEWER' : 'PROJECT_INVALID'});
  assert.deepEqual(f.inspect(), before); assert.deepEqual(f.files(), files); assert.equal(sha(readFileSync(f.historyFile)), bytes);
});
