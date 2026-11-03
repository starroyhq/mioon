import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {openStore} from '../packages/business/src/project-file/index.ts';
import type {ProjectStore} from '../packages/business/src/project-file/index.ts';
import {captureProjectDocumentInside, assertProjectSnapshotTableLedger, canonicalJson, PROJECT_SNAPSHOT_EXCLUSIONS,
  PROJECT_SNAPSHOT_TABLES, rowKey, validateProjectDocument} from '../packages/business/src/project-versions/document.ts';
import type {ProjectDocument} from '../packages/business/src/project-versions/document.ts';
import {decodeProjectDocument, encodeProjectDocument, PROJECT_SNAPSHOT_MAX_RAW_BYTES, PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES} from '../packages/business/src/project-versions/codec.ts';
import {parseLutBytes} from '../packages/business/src/lut-resource-validation.ts';

const now = '2026-11-03T00:00:00.000Z';
const invalid = {code: 'PROJECT_VERSION_SNAPSHOT_INVALID'};
function fixture(t: TestContext): ProjectStore {
  const root = mkdtempSync(path.join(tmpdir(), 'project-version-snapshot-'));
  const store = openStore(path.join(root, 'project'));
  store.put('projects', {id: store.projectId, name: '完整快照', notes: {z: 1, a: ['保留顺序', 2, 1]}});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  return store;
}
const capture = (store: ProjectStore): ProjectDocument => store.tx(() => captureProjectDocumentInside(store));
const rawBlob = (text: string) => {
  const raw = Buffer.from(text), payload = gzipSync(raw);
  return {profile: 1 as const, codec: 'gzip' as const, hash: createHash('sha256').update(raw).digest('hex'), rawBytes: raw.length, compressedBytes: payload.length, payload};
};

test('the independently enumerated table ledger covers all project tables and rejects an unclassified new table', t => {
  const store = fixture(t);
  const expected = ['projects','assets','asset_annotations','asset_dispositions','asset_ranges','shots','nodes','edges','versions','timelines',
    'subjects','subject_versions','subject_bindings','image_groups','image_versions','scene_results','project_lut_resources'];
  assert.deepEqual([...PROJECT_SNAPSHOT_TABLES], expected);
  assert.deepEqual(Object.keys(PROJECT_SNAPSHOT_EXCLUSIONS).sort(), ['agent_task_target_revisions_v2','project_file','schema_version']);
  const actual = store.db.prepare("SELECT name FROM project.sqlite_schema WHERE type='table'").all().map(row => String(row.name));
  assert.doesNotThrow(() => assertProjectSnapshotTableLedger(actual));
  assert.throws(() => assertProjectSnapshotTableLedger([...actual, 'future_content']), invalid);
  assert.throws(() => assertProjectSnapshotTableLedger(actual.filter(name => name !== 'shots')), invalid);
  store.db.exec('CREATE TABLE project.future_content(id TEXT)');
  assert.throws(() => capture(store), invalid);
});

test('snapshot capture needs the exact live owner and its existing synchronous transaction', t => {
  const store = fixture(t);
  assert.throws(() => captureProjectDocumentInside(store), TypeError);
  assert.throws(() => store.tx(() => captureProjectDocumentInside({...store})), TypeError);
  assert.equal(capture(store).projectId, store.projectId);
  store.close();
  assert.throws(() => captureProjectDocumentInside(store), TypeError);
});

test('all retained content, true IDs, tombstones, BLOB bytes and provenance survive with no history or media reads', t => {
  const store = fixture(t), projectId = store.projectId;
  const assetId = randomUUID(), shotId = randomUUID(), nodeId = randomUUID(), edgeId = randomUUID(), versionId = randomUUID(), jobId = randomUUID();
  const subjectId = randomUUID(), subjectVersionId = randomUUID(), bindingId = randomUUID(), groupId = randomUUID(), imageVersionId = randomUUID();
  const imageAssetId = randomUUID(), imageTaskId = randomUUID(), sceneResultId = randomUUID(), sceneTaskId = randomUUID(), lutId = randomUUID();
  const content = Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
  store.tx(() => {
    store.put('assets', {id: assetId, projectId, name: 'missing media', hidden: true, relativePath: 'media/absent.png'});
    store.put('assets', {id: imageAssetId, projectId, kind: 'image'});
    store.put('shots', {id: shotId, projectId, title: '镜头', selectedVersionId: versionId});
    store.put('versions', {id: versionId, projectId, jobId, shotId, hidden: true});
    store.put('nodes', {id: nodeId, projectId, type: 'note', text: '画布内容'});
    store.put('edges', {id: edgeId, projectId, from: nodeId, to: nodeId});
    store.put('timelines', {id: randomUUID(), projectId, clips: [{assetId, label: 'timeline content'}], tracks: []});
    store.db.prepare("INSERT INTO asset_annotations VALUES(?,?,1,'[\"标签\"]','保留标注')").run(assetId, projectId);
    store.db.prepare("INSERT INTO asset_dispositions VALUES(?,?,1,'rejected')").run(assetId, projectId);
    store.db.prepare('INSERT INTO asset_ranges VALUES(?,?,1,0,30)').run(assetId, projectId);
    store.db.prepare("INSERT INTO subjects VALUES(?,?,'character','主体',1,?,?,?)").run(subjectId, projectId, subjectVersionId, now, now);
    store.db.prepare('INSERT INTO subject_versions VALUES(?,?,?,1,?,?)').run(subjectVersionId, projectId, subjectId, assetId,
      JSON.stringify({id: subjectVersionId, projectId, subjectId, number: 1, assetId, variant: {batchId: randomUUID(), kind: 'pose'}}));
    store.db.prepare("INSERT INTO subject_bindings VALUES(?,?,?,?,'subject',1,NULL,?,?,?)").run(bindingId, projectId, shotId, subjectId, subjectVersionId, now, now);
    store.db.prepare("INSERT INTO image_groups VALUES(?,?,'图像组',1,?,NULL,?,?)").run(groupId, projectId, imageVersionId, now, now);
    store.db.prepare('INSERT INTO image_versions VALUES(?,?,?,?,1,?,?)').run(imageVersionId, projectId, groupId, imageTaskId, imageAssetId,
      JSON.stringify({id: imageVersionId, projectId, groupId, taskId: imageTaskId, number: 1, assetId: imageAssetId}));
    // Seed copied content whose local detection history is absent. The exact
    // temporary creation gate is restored before the snapshot runs; production
    // capture itself never alters constraints or reconstructs a fake task.
    const gate = store.db.prepare("SELECT sql FROM sqlite_temp_schema WHERE name='scene_result_identity'").get()?.sql;
    assert.equal(typeof gate, 'string');
    store.db.exec('DROP TRIGGER temp.scene_result_identity');
    try {store.db.prepare("INSERT INTO scene_results VALUES(?,?,?,1,?,'detected',?,NULL,NULL,'scene-profile',30,30,'{}','[0]',?)")
      .run(sceneResultId, projectId, assetId, 'a'.repeat(64), sceneTaskId, now);}
    finally {store.db.exec(String(gate).replace(/^CREATE TRIGGER /u, 'CREATE TEMP TRIGGER '));}
    store.db.prepare("INSERT INTO project_lut_resources VALUES(?,?,'原始 LUT',?,?,'mioon-cube3d-normalized-tetrahedral-v1',?,?,?)")
      .run(lutId, projectId, createHash('sha256').update(content).digest('hex'), content.length, JSON.stringify(parseLutBytes(content).metadata), content, now);
    store.db.prepare("INSERT INTO idempotency VALUES('snapshot-test','local-request','hash','not-project-content')").run();
  });
  const before = store.db.prepare('SELECT total_changes() n').get()?.n;
  const document = capture(store), decoded = decodeProjectDocument(encodeProjectDocument(document));
  assert.deepEqual(decoded, document);
  for (const table of PROJECT_SNAPSHOT_TABLES) assert.ok(document.tables[table].length > 0, `${table}: retained nonempty table, not only a table-name oracle`);
  assert.equal(document.tables.versions[0]!.jobId, jobId);
  assert.equal(JSON.parse(String(document.tables.versions[0]!.data)).hidden, true);
  assert.equal(document.tables.subject_bindings[0]!.subjectVersionId, null);
  assert.equal(document.tables.image_versions[0]!.taskId, imageTaskId);
  assert.equal(document.tables.scene_results[0]!.taskId, sceneTaskId);
  assert.deepEqual(document.tables.project_lut_resources[0]!.content, {type: 'blob', base64: content.toString('base64')});
  assert.equal(store.db.prepare('SELECT count(*) n FROM jobs').get()?.n, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM image_tasks').get()?.n, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM scene_tasks').get()?.n, 0);
  assert.ok(!canonicalJson(document).includes('not-project-content'));
  assert.ok(!Object.hasOwn(document.tables, 'agent_task_target_revisions_v2'));
  assert.ok(document.evidence.targetRevisions.length > 0);
  assert.equal(store.db.prepare('SELECT total_changes() n').get()?.n, before);
  assert.equal(document.evidence.contentSequence, store.db.prepare('SELECT contentSequence FROM project.project_file').get()?.contentSequence);
});

test('canonical snapshots sort object keys and row keys while retaining user string bytes and array order', t => {
  const store = fixture(t), a = randomUUID(), b = randomUUID();
  store.put('nodes', {id: b, projectId: store.projectId, z: 1, a: [3, 2, 1], text: '  bytes\r\n'});
  store.put('nodes', {id: a, projectId: store.projectId, a: [1, 2, 3]});
  const document = capture(store), encoded = encodeProjectDocument(document);
  assert.deepEqual(document.tables.nodes.map(row => String(row.id)), [a, b].sort());
  assert.equal(rowKey('projects', document.tables.projects[0]!), canonicalJson([store.projectId]));
  assert.equal(canonicalJson({b: 1, a: [3, 2, 1]}), '{"a":[3,2,1],"b":1}');
  assert.equal(JSON.parse(String(document.tables.nodes.find(row => row.id === b)!.data)).text, '  bytes\r\n');
  assert.deepEqual(encodeProjectDocument(document), encoded);
  assert.equal(Object.isFrozen(document), true);
  assert.equal(Reflect.set(document.tables.nodes[0]!, 'data', '{}'), false, 'verified rows cannot be changed after validation is memoized');
  assert.deepEqual(JSON.parse(String(document.tables.nodes.find(row => row.id === b)!.data)).a, [3, 2, 1]);
});

test('untrusted documents reject unknown profiles, ownership, columns, duplicate keys, row constraints and broken dependencies', t => {
  const store = fixture(t), assetId = randomUUID();
  store.put('assets', {id: assetId, projectId: store.projectId, name: 'Asset'});
  const document = capture(store);
  const changed = (edit: (value: Record<string, unknown>) => void) => {const value = JSON.parse(JSON.stringify(document)); edit(value); return value;};
  for (const bad of [
    changed(value => {value.snapshotProfileVersion = 2;}), changed(value => {value.projectId = randomUUID();}),
    changed(value => {value.projectFormatVersion = 999;}), changed(value => {value.unknown = true;}),
    {...document, tables: {...document.tables, newTable: []}},
    {...document, tables: {...document.tables, assets: [...document.tables.assets, ...document.tables.assets]}},
    {...document, tables: {...document.tables, assets: [{...document.tables.assets[0]!, projectId: randomUUID()}]}},
    {...document, tables: {...document.tables, assets: [{...document.tables.assets[0]!, extra: 'column'}]}},
    {...document, tables: {...document.tables, assets: [{...document.tables.assets[0]!, data: canonicalJson({id: randomUUID(), projectId: store.projectId})}]}},
    {...document, tables: {...document.tables, asset_annotations: [{assetId: randomUUID(), projectId: store.projectId, revision: 1, tags: '[]', note: ''}]}},
    {...document, tables: {...document.tables, asset_ranges: [{assetId, projectId: store.projectId, revision: 1, inFrame: 2, outFrame: 1}]}},
  ]) assert.throws(() => validateProjectDocument(bad), invalid);
  assert.throws(() => canonicalJson({value: Number.NaN}), invalid);
  const cyclic: {self?: unknown} = {}; cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), invalid);
  store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(`{"id":"${assetId}","projectId":"${store.projectId}","label":1,"label":2}`, assetId);
  assert.throws(() => capture(store), invalid, 'duplicate JSON keys must not change meaning between SQLite and JSON.parse');
});

test('codec bounds decompression and verifies exact metadata, UTF-8, canonical JSON and byte hashes', t => {
  const document = capture(fixture(t)), encoded = encodeProjectDocument(document);
  assert.equal(encoded.profile, 1); assert.equal(encoded.codec, 'gzip');
  assert.equal(encoded.compressedBytes, encoded.payload.length);
  for (const bad of [
    {...encoded, hash: 'a'.repeat(64)}, {...encoded, profile: 2}, {...encoded, codec: 'other'},
    {...encoded, rawBytes: encoded.rawBytes - 1}, {...encoded, compressedBytes: encoded.compressedBytes + 1},
    {...encoded, payload: encoded.payload.slice(0, -1), compressedBytes: encoded.compressedBytes - 1},
    rawBlob(' ' + canonicalJson(document)), rawBlob('{"not":"a snapshot"}'),
  ]) assert.throws(() => decodeProjectDocument(bad as typeof encoded), invalid);
  assert.throws(() => decodeProjectDocument({...encoded, rawBytes: PROJECT_SNAPSHOT_MAX_RAW_BYTES + 1}), {code: 'PROJECT_VERSION_SNAPSHOT_LIMIT'});
  assert.throws(() => decodeProjectDocument({...encoded, compressedBytes: PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES + 1,
    payload: new Uint8Array(PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES + 1)}), {code: 'PROJECT_VERSION_SNAPSHOT_LIMIT'});
  const bomb = gzipSync(Buffer.alloc(1024 * 1024, 0));
  assert.throws(() => decodeProjectDocument({...encoded, payload: bomb, compressedBytes: bomb.length, rawBytes: 100}), invalid);
  const nonUtf8 = Buffer.from([0xff]), payload = gzipSync(nonUtf8);
  assert.throws(() => decodeProjectDocument({profile: 1, codec: 'gzip', hash: createHash('sha256').update(nonUtf8).digest('hex'),
    rawBytes: 1, compressedBytes: payload.length, payload}), invalid);
});

function legalLutBytes(length: number): Buffer {
  const size = 33, header = `LUT_3D_SIZE ${size}\n`, rows: string[] = [];
  let padding = length - Buffer.byteLength(header) - size ** 3 * 6;
  for (let i = 0; i < size ** 3; i++) {const spaces = Math.min(245, padding); rows.push('0 0 0' + ' '.repeat(spaces) + '\n'); padding -= spaces;}
  assert.equal(padding, 0);
  const bytes = Buffer.from(header + rows.join(''));
  assert.equal(bytes.length, length); assert.equal(parseLutBytes(bytes).metadata.size, size);
  return bytes;
}

test('the largest legal aggregate LUT content fits the calibrated raw bound with ordinary project content', t => {
  const store = fixture(t), max = legalLutBytes(7 * 1024 * 1024), tail = legalLutBytes(1024 * 1024);
  const insert = store.db.prepare("INSERT INTO project_lut_resources VALUES(?,?,'最大合法 LUT',?,?,'mioon-cube3d-normalized-tetrahedral-v1',?,?,?)");
  store.tx(() => {
    for (let index = 0; index < 10; index++) {
      const bytes = index === 9 ? tail : max;
      insert.run(randomUUID(), store.projectId, createHash('sha256').update(bytes).digest('hex'), bytes.length, JSON.stringify(parseLutBytes(bytes).metadata), bytes, now);
    }
    store.put('timelines', {id: randomUUID(), projectId: store.projectId, tracks: [], clips: Array.from({length: 500}, (_, index) => ({id: randomUUID(), label: `合法组合 ${index}`}))});
  });
  assert.equal(store.db.prepare('SELECT sum(sizeBytes) n FROM project_lut_resources').get()?.n, 64 * 1024 * 1024);
  const start = performance.now(), encoded = encodeProjectDocument(capture(store));
  assert.ok(encoded.rawBytes > 64 * 1024 * 1024, 'base64 expands the legal BLOB aggregate beyond the uncalibrated 64 MiB raw proposal');
  assert.ok(encoded.rawBytes <= PROJECT_SNAPSHOT_MAX_RAW_BYTES); assert.ok(encoded.compressedBytes <= PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES);
  assert.equal(PROJECT_SNAPSHOT_MAX_RAW_BYTES, 128 * 1024 * 1024);
  assert.equal(PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES, 64 * 1024 * 1024);
  const decoded = decodeProjectDocument(encoded);
  assert.equal(decoded.tables.project_lut_resources.length, 10);
  assert.equal(decoded.tables.timelines.length, 1);
  assert.equal(decoded.tables.project_lut_resources.reduce((total, row) => total + Number(row.sizeBytes), 0), 64 * 1024 * 1024);
  console.log(JSON.stringify({scenario: 'legal-64MiB-LUTs-plus-content', rawBytes: encoded.rawBytes, compressedBytes: encoded.compressedBytes,
    elapsedMs: Math.round(performance.now() - start), rssBytes: process.memoryUsage().rss}));
});
