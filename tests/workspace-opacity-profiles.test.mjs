import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initializeWorkspaceSchema42, classifyWorkspaceSchema42} from '../packages/business/src/workspace-schema-v42.ts';
import {initializeOpacityLegacyThrough40} from '../packages/business/src/workspace-opacity-legacy.ts';
import {classifyWorkspaceSchemaV42V43, installWorkspaceRestoreSchemaV43, validateWorkspaceRestoreSchemaV43} from '../packages/business/src/workspace-restore-schema-v43.ts';
import {createWorkspaceRestoreProfileV41} from '../packages/business/src/workspace-restore-schema-v41.ts';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-16T00:00:00.000Z';
const metadata = () => ({restorationId: id(90), workspaceOrigin: id(91), sourceBackupId: id(92), manifestHash: 'c'.repeat(64), sourceDbHash: 'd'.repeat(64), createdAt: stamp});
const opacity = () => ({profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: 0, opacity: 0}, {frame: 30, opacity: 1}]});
const quote = name => '"' + name.replaceAll('"', '""') + '"';
function database(t, version = 42) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
  if (version === 40) initializeOpacityLegacyThrough40(db); else initializeWorkspaceSchema42(db);
  return db;
}
function snapshot(db) {
  const catalog = db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all();
  const tables = catalog.filter(row => row.type === 'table').map(row => [row.name, db.prepare(`SELECT rowid,* FROM ${quote(row.name)} ORDER BY rowid`).all()]);
  return JSON.stringify({catalog, tables});
}
function seed(db) {
  const project = {id: id(1), name: 'Synthetic metadata fixture', revision: 1, createdAt: stamp, updatedAt: stamp};
  const asset = {id: id(2), projectId: project.id, name: 'No media file exists', mimeType: 'video/mp4', duration: 1, width: 720, height: 1280,
    hasVideo: true, hasAudio: true, sha256: 'a'.repeat(64), relativePath: 'media/never-opened.mp4', createdAt: stamp};
  const clip = {id: id(5), trackId: id(4), assetId: asset.id, name: 'Mixed synthetic metadata', startFrame: 0, durationFrames: 30, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, audioRole: 'human',
    colour: {profileId: 'mioon-rec709-sdr-clip-v1', source: {assetSha256: asset.sha256, streamIndex: 0, profileId: 'rec709-yuv-sdr-v1', range: 'limited', declaredBy: 'user', declaredAt: stamp}, look: null},
    volumeEnvelope: {profileId: 'mioon-clip-linear-attenuation-v1', points: [{frame: 0, multiplier: .5}, {frame: 30, multiplier: 1}]}, opacityEnvelope: opacity()};
  const timeline = {id: id(3), projectId: project.id, revision: 1, fps: 30, width: 720, height: 1280,
    tracks: [{id: id(4), name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false}], clips: [clip], durationFrames: 30, createdAt: stamp, updatedAt: stamp};
  db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(project.id, JSON.stringify(project));
  db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(asset.id, project.id, JSON.stringify(asset));
  const raw = JSON.stringify(timeline, null, 2), history = JSON.stringify({tracks: timeline.tracks, clips: timeline.clips, durationFrames: 30}, null, 1);
  db.prepare('INSERT INTO timelines(id,projectId,data) VALUES(?,?,?)').run(timeline.id, project.id, raw);
  db.prepare('INSERT INTO timeline_history(id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot) VALUES(?,?,1,?,?,?,?)').run(id(6), project.id, 'timeline.clip.update', stamp, history, history);
  db.prepare('INSERT INTO timeline_history_cursors(projectId,position) VALUES(?,1)').run(project.id);
  db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run('synthetic-opacity-ack', 'b'.repeat(64), raw);
  const input = {projectId: project.id, requestId: 'synthetic-opacity-intent', expectedRevision: 1, clipId: clip.id, patch: {volumeEnvelope: clip.volumeEnvelope, opacityEnvelope: clip.opacityEnvelope, colour: clip.colour, audioRole: clip.audioRole}};
  db.prepare("INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes) VALUES(?,?,'timeline.clip.update',?,?,?,'timeline:mutation','new','prepared',1,0,?,?,16384)")
    .run(id(7), project.id, JSON.stringify(input, null, 1), input.requestId, 'e'.repeat(64), stamp, stamp);
  return {project, asset, timeline, raw, history, input};
}

test('fixed42 admits mixed opacity/volume/role/real colour declaration and reopens without rewriting raw evidence', t => {
  const db = database(t), f = seed(db), before = snapshot(db), changes = db.prepare('SELECT total_changes() AS n').get().n;
  assert.deepEqual(classifyWorkspaceSchema42(db), {schemaVersion: 42, profile: 'ordinary'});
  initializeWorkspaceSchema42(db);
  assert.equal(snapshot(db), before);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.equal(db.prepare('SELECT data FROM timelines').get().data, f.raw);
});

test('fresh-only42 entry refuses an existing40 and fixed41 refuses genuine42/43', t => {
  const old = database(t, 40), before = snapshot(old);
  assert.throws(() => initializeWorkspaceSchema42(old), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
  assert.equal(snapshot(old), before);
  const db = database(t), legacy = createWorkspaceRestoreProfileV41(initializeWorkspaceSchemaThrough24);
  assert.throws(() => legacy.classifyWorkspaceSchemaV40V41(db), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
  installWorkspaceRestoreSchemaV43(db, metadata());
  assert.throws(() => legacy.classifyWorkspaceSchemaV40V41(db), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
  assert.equal(validateWorkspaceRestoreSchemaV43(db).schemaVersion, 43);
});

test('raw duplicates, wrong opacity paths, unknown fields, foreign source and render wrappers refuse without writes', t => {
  for (const kind of ['duplicate', 'wrong-path', 'unknown-field', 'foreign-source', 'render']) {
    const db = database(t), f = seed(db);
    if (kind === 'duplicate') db.prepare('UPDATE timelines SET data=?').run(f.raw.replace('"opacityEnvelope":', '"opacityEnvelope": null, "opacityEnvelope":'));
    if (kind === 'wrong-path') db.prepare('UPDATE timelines SET data=?').run(JSON.stringify({...f.timeline, extra: {opacityEnvelope: opacity()}}));
    if (kind === 'unknown-field') db.prepare('UPDATE timelines SET data=?').run(JSON.stringify({...f.timeline, clips: [{...f.timeline.clips[0], arbitraryEffect: 1}]}));
    if (kind === 'foreign-source') {
      db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(id(20), JSON.stringify({id: id(20)}));
      db.prepare('UPDATE assets SET projectId=?').run(id(20));
    }
    if (kind === 'render') db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)')
      .run('synthetic-opacity-invalid-render', 'b'.repeat(64), JSON.stringify({snapshot: {timeline: f.timeline, assets: [f.asset]}}));
    const before = snapshot(db), changes = db.prepare('SELECT total_changes() AS n').get().n;
    assert.throws(() => classifyWorkspaceSchemaV42V43(db), error => ['WORKSPACE_OPACITY_INVALID', 'INVALID_OPACITY_CANDIDATE'].includes(error.code), kind);
    assert.equal(snapshot(db), before, kind);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes, kind);
    assert.equal(db.isTransaction, false);
  }
});

test('fixed43 captures actual original bytes and preserves inherited held/unique replacement/epoch guards', t => {
  const db = database(t), f = seed(db), originalTask = db.prepare('SELECT input FROM edit_tasks').get().input;
  const info = installWorkspaceRestoreSchemaV43(db, metadata());
  assert.equal(info.schemaVersion, 43); assert.equal(info.sourceSchema, 42); assert.equal(info.profile, 'restored-local-v10');
  assert.equal(db.prepare('SELECT data FROM timelines').get().data, f.raw);
  assert.equal(db.prepare('SELECT input FROM edit_tasks').get().input, originalTask);
  assert.equal(db.prepare('SELECT beforeSnapshot FROM workspace_restore_timeline_history').get().beforeSnapshot, f.history);
  const before = snapshot(db);
  for (const sql of [
    "UPDATE edit_tasks SET acknowledged=1", "DELETE FROM timeline_requests", "UPDATE workspace_restore_timeline_history SET beforeSnapshot='{}'",
    "INSERT OR REPLACE INTO timeline_requests SELECT * FROM timeline_requests",
    'INSERT INTO schema_version VALUES(44)',
    "INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes) SELECT '00000000-0000-4000-8000-000000000008',projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes FROM edit_tasks",
  ]) {
    assert.throws(() => db.exec(sql));
    assert.equal(snapshot(db), before, sql);
  }
  assert.equal(validateWorkspaceRestoreSchemaV43(db).workspaceOrigin, metadata().workspaceOrigin);
});

test('43 install rolls back a failure after guard construction, preserving exact42 catalog and rows', t => {
  const db = database(t); seed(db);
  const before = snapshot(db), originalExec = db.exec;
  db.exec = function(sql) {
    const result = Reflect.apply(originalExec, this, [sql]);
    if (sql.includes('CREATE TRIGGER restore_legacy_schema_gate')) throw Error('Synthetic fault after43 guard construction');
    return result;
  };
  try {assert.throws(() => installWorkspaceRestoreSchemaV43(db, metadata()), /Synthetic fault after43 guard construction/);}
  finally {db.exec = originalExec;}
  assert.equal(db.isTransaction, false);
  assert.equal(snapshot(db), before);
  assert.equal(classifyWorkspaceSchema42(db).schemaVersion, 42);
  assert.equal(installWorkspaceRestoreSchemaV43(db, metadata()).schemaVersion, 43);
});

test('unknown catalog or temporary objects never select an opacity profile', t => {
  for (const sql of ['CREATE TABLE unexpected(value)', 'CREATE TEMP TABLE timelines(value)']) {
    const db = database(t); db.exec(sql);
    const before = snapshot(db);
    assert.throws(() => classifyWorkspaceSchemaV42V43(db), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
    assert.equal(snapshot(db), before);
  }
});
