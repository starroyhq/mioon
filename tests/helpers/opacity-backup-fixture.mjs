import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {openNewOpacityCandidateApplicationStore} from '../../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateLocalDrafts} from '../../packages/business/src/opacity-candidate-local-drafts.ts';
import {createOpacityCandidateApplicationServices} from '../../packages/business/src/opacity-candidate-services.ts';

export const opacityBackupStamp = '2026-10-16T00:00:00.000Z';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
export const raw = value => ' \n' + JSON.stringify(value, null, '\t').replaceAll('界', '\\u754c') + '\n ';
const quote = name => '"' + name.replaceAll('"', '""') + '"';
export function tree(root) {
  const visit = relative => {
    const file = path.join(root, relative), info = fs.lstatSync(file);
    if (info.isSymbolicLink()) return [[relative, {mode: info.mode, link: fs.readlinkSync(file)}]];
    if (info.isDirectory()) return [[relative, {mode: info.mode}], ...fs.readdirSync(file).sort().flatMap(name => visit(path.join(relative, name)))];
    return [[relative, {mode: info.mode, bytes: info.size, sha256: hash(fs.readFileSync(file))}]];
  };
  return visit('');
}
export function logicalTables(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").all().map(({name}) => {
    const fields = db.prepare(`PRAGMA main.table_info(${quote(name)})`).all().map(row => row.name);
    const statement = db.prepare(`SELECT rowid AS originalRowid,${fields.map(quote).join(',')} FROM main.${quote(name)} ORDER BY rowid`);
    statement.setReadBigInts(true);
    return [name, {fields, rows: statement.all()}];
  }));
}
export function originalRows(db, table, fields, where = '') {
  const statement = db.prepare(`SELECT rowid AS originalRowid,${fields.map(quote).join(',')} FROM main.${quote(table)} ${where} ORDER BY rowid`);
  statement.setReadBigInts(true); return statement.all();
}

/** Owns every path, exact42 handle and synthetic byte. No codec, provider,
 * backend, network or actual project participates in this cold fixture. */
export async function opacityBackupFixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-opacity-offline-'));
  const source = path.join(base, 'source42'), backup = path.join(base, 'backup42'), destination = path.join(base, 'restored43');
  const cleanup = [], stores = [];
  t.after(async () => {
    try {for (const finish of cleanup.toReversed()) await finish();}
    finally {for (const store of stores) {try {store.close();} catch {}} fs.rmSync(base, {recursive: true, force: true});}
  });
  const seeded = await seedOpacityBackupWorkspace(source); stores.push(seeded.store);
  return {base, source, backup, destination, stores, ...seeded, manage: finish => cleanup.push(finish)};
}

/** Reusable owned seed for independent CLI qualification. The explicit target
 * must not exist. Returns only after its real services drain and store closes;
 * the caller owns subsequent removal, so qualification evidence may be kept. */
export async function seedOpacityBackupWorkspace(source) {
  const store = openNewOpacityCandidateApplicationStore(source);
  let services;
  try {
  services = createOpacityCandidateApplicationServices(store);
  const projectId = randomUUID(), assetId = randomUUID(), timelineId = randomUUID(), trackId = randomUUID(), clipId = randomUUID(), taskId = randomUUID();
  const project = {id: projectId, name: 'Owned synthetic opacity 界', revision: 1, createdAt: opacityBackupStamp, updatedAt: opacityBackupStamp};
  // Opaque fixture bytes deliberately never enter probing or rendering.
  const mediaBytes = Buffer.from('SYNTHETIC_OPAQUE_ASSET\0\u754c\n', 'utf8'), relativePath = `media/${assetId}.mp4`;
  const asset = {id: assetId, projectId, name: 'Synthetic metadata only', mimeType: 'video/mp4', relativePath,
    sha256: hash(mediaBytes), sizeBytes: mediaBytes.length, duration: 1, width: 720, height: 1280,
    hasVideo: true, hasAudio: false, provenance: 'user-import', createdAt: opacityBackupStamp};
  const opacityEnvelope = {profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: 0, opacity: .25}, {frame: 30, opacity: 1}]};
  const clip = {id: clipId, assetId, trackId, name: 'Saved opacity 界', startFrame: 0, durationFrames: 30, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, opacityEnvelope};
  const track = {id: trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false};
  const timeline = {id: timelineId, projectId, revision: 3, fps: 30, width: 720, height: 1280,
    tracks: [track], clips: [clip], durationFrames: 30, createdAt: opacityBackupStamp, updatedAt: opacityBackupStamp};
  const beforeClip = {...clip, opacityEnvelope: null}, historyBefore = raw({tracks: [track], clips: [beforeClip], durationFrames: 30});
  const historyAfter = raw({tracks: [track], clips: [clip], durationFrames: 30}), timelineText = raw(timeline);
  const receiptRequestId = randomUUID(), requestId = randomUUID();
  const input = {projectId, requestId, expectedRevision: 3, clipId, patch: {name: 'Captured pending 界'}};
  const digest = hash(canonical({operation: 'timeline.clip.update', input})), taskText = raw(input), receiptText = raw(timeline);
  const db = store.db;
  db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId, raw(project));
  db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(assetId, projectId, raw(asset));
  db.prepare('INSERT INTO timelines(id,projectId,data) VALUES(?,?,?)').run(timelineId, projectId, timelineText);
  db.prepare('INSERT INTO timeline_history(id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot) VALUES(?,?,1,?,?,?,?)')
    .run(randomUUID(), projectId, 'timeline.clip.update', opacityBackupStamp, historyBefore, historyAfter);
  db.prepare('INSERT INTO timeline_history_cursors(projectId,position) VALUES(?,1)').run(projectId);
  db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run(receiptRequestId, 'a'.repeat(64), receiptText);
  db.prepare("INSERT INTO edit_tasks(position,id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes) VALUES(17,?,?,'timeline.clip.update',?,?,?,'timeline:mutation','new','prepared',1,0,?,?,16384)")
    .run(taskId, projectId, taskText, requestId, digest, opacityBackupStamp, opacityBackupStamp);
  db.exec("UPDATE sqlite_sequence SET seq=7001 WHERE name='edit_tasks'");
  fs.writeFileSync(path.join(source, relativePath), mediaBytes, {mode: 0o600});
  const drafts = createOpacityCandidateLocalDrafts(store), key = {projectId, timelineId, clipId}, initial = drafts.get(key);
  const draft = drafts.put({...key, workspaceScope: initial.workspaceScope, instanceId: initial.instanceId, expectedRevision: 0,
    baseRevision: 3, source: {assetId, assetSha256: asset.sha256}, raw: {name: 'Unfinished opacity 界', trackId,
      startFrame: '0', durationFrames: '30', sourceInFrame: '0', rect: {x: '0', y: '0', width: '720', height: '1280'}, gain: '1',
      opacityEnvelope: {profileId: opacityEnvelope.profileId, points: [{frame: '0', opacity: '.'}, {frame: '30', opacity: '1'}]}}});
  const observed = await services.call('timeline.get', {projectId});
  if (observed.id !== timelineId || observed.revision !== 3) throw Error('Owned42 service read did not retain the seeded timeline.');
  const draftBytes = fs.readFileSync(path.join(source, 'local-drafts-v3.json')), before = logicalTables(db);
  return {source, store, projectId, assetId, timelineId, trackId, clipId, taskId, requestId,
    digest, input, relativePath, mediaBytes, timeline, opacityEnvelope, timelineText, historyBefore, historyAfter, taskText, receiptText,
    receiptRequestId, draft, draftBytes, before};
  } finally {try {await services?.drain();} finally {store.close();}}
}
