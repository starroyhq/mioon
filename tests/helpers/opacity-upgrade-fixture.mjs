import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID, createHash} from 'node:crypto';
import {openStore} from '../../packages/business/src/db.mjs';
import {createServices} from '../../packages/business/src/services.mjs';
import {createEditTasks} from '../../packages/business/src/edit-tasks.mjs';
import {createWorkspacePreferences} from '../../packages/business/src/workspace-preferences.mjs';
import {defaultWorkspaceState} from '../../apps/web/src/workspace-state.js';
import {logicalTables, raw} from './opacity-backup-fixture.mjs';

export const upgradeFixtureHash = value => createHash('sha256').update(value).digest('hex');
export const upgradeFixtureStamp = '2026-10-16T00:00:00.000Z';
export const upgradeFixtureLut = Buffer.from('# retained original\r\nTITLE "Upgrade \\ raw"\r\nLUT_3D_SIZE 2\r\n0 0 0\r\n1 0 0\r\n0 1 0\r\n1 1 0\r\n0 0 1\r\n1 0 1\r\n0 1 1\r\n1 1 1\r\n');
/** Only this fixture's new40 directory is opened. No media bytes are decoded,
 * provider constructed, listener created, or user workspace inspected. */
export async function opacityUpgradeFixture(t, {rejectTask = false} = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-ordinary40-upgrade-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const source = path.join(base, 'source40'), backup = path.join(base, 'backup40'), destination = path.join(base, 'candidate42');
  const store = openStore(source), services = createServices(store, new Map());
  const tasks = createEditTasks({store, services});
  try {
    const project = await services.call('project.create', {name: 'Owned upgrade raw 界'}), projectId = project.id;
    const assetId = randomUUID(), timelineId = randomUUID(), trackId = randomUUID(), clipId = randomUUID();
    const mediaBytes = Buffer.from('SYNTHETIC_UPGRADE_OPAQUE_BYTES\0界\n'), relativePath = `media/${assetId}.mp4`;
    const asset = {id: assetId, projectId, name: 'Synthetic opaque import', mimeType: 'video/mp4', width: 720, height: 1280,
      duration: 1, hasVideo: true, hasAudio: false, sizeBytes: mediaBytes.length, sha256: upgradeFixtureHash(mediaBytes),
      relativePath, provenance: 'user-import', createdAt: upgradeFixtureStamp};
    store.put('assets', asset); fs.writeFileSync(path.join(source, relativePath), mediaBytes, {mode: 0o600});
    const track = {id: trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false};
    const clip = {id: clipId, assetId, trackId, name: 'Original 界', startFrame: 0, durationFrames: 30, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: .7};
    const timeline = {id: timelineId, projectId, revision: 2, fps: 30, width: 720, height: 1280, tracks: [track], clips: [clip],
      durationFrames: 30, createdAt: upgradeFixtureStamp, updatedAt: upgradeFixtureStamp};
    store.db.prepare('INSERT INTO timelines(id,projectId,data) VALUES(?,?,?)').run(timelineId, projectId, raw(timeline));
    const historyId = randomUUID();
    store.db.prepare('INSERT INTO timeline_history(id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot) VALUES(?,?,1,?,?,?,?)')
      .run(historyId, projectId, 'timeline.clip.add', upgradeFixtureStamp, raw({tracks: [track], clips: [], durationFrames: 0}), raw({tracks: [track], clips: [clip], durationFrames: 30}));
    store.db.prepare('INSERT INTO timeline_history_cursors(projectId,position) VALUES(?,1)').run(projectId);
    const input = {projectId, expectedRevision: 2, requestId: randomUUID(), clipId, patch: {name: 'Acknowledged 界'}};
    const prepared = tasks.prepare({projectId, operation: 'timeline.clip.update', input, origin: 'new'});
    const executed = await tasks.execute({projectId, taskId: prepared.task.id, digest: prepared.task.digest, instanceId: prepared.instanceId});
    const acknowledged = tasks.acknowledge({projectId, taskId: prepared.task.id, digest: prepared.task.digest, expectedRevision: executed.task.revision, status: 'applied'});
    let rejectedTask;
    if (rejectTask) {
      const rejectedInput = {...input, requestId: randomUUID(), expectedRevision: 999};
      const preparedRejection = tasks.prepare({projectId, operation: 'timeline.clip.update', input: rejectedInput, origin: 'new'});
      const rejected = await tasks.execute({projectId, taskId: preparedRejection.task.id, digest: preparedRejection.task.digest, instanceId: preparedRejection.instanceId});
      rejectedTask = tasks.acknowledge({projectId, taskId: rejected.task.id, digest: rejected.task.digest, expectedRevision: rejected.task.revision, status: rejected.task.status}).task;
    }
    const lutInput = {projectId, requestId: randomUUID(), name: 'Retained original.cube', dataBase64: upgradeFixtureLut.toString('base64')};
    const lut = await services.call('lut.import', lutInput);
    const preferenceState = defaultWorkspaceState(); delete preferenceState.shared.assetSearch;
    preferenceState.activeMode = 'editing'; preferenceState.editing.selectedClipId = clipId;
    const preferences = createWorkspacePreferences(store).put(projectId, {expectedRevision: 0, state: preferenceState});
    store.db.prepare('UPDATE timelines SET data=? WHERE id=?').run(raw(executed.result), timelineId);
    store.db.exec("UPDATE sqlite_sequence SET seq=7001.0 WHERE name='edit_tasks'");
    const before = logicalTables(store.db);
    return {base, source, backup, destination, database: path.join(source, 'workbench.sqlite'), projectId, assetId, timelineId, trackId,
      clipId, mediaBytes, relativePath, before, project, asset, timeline: executed.result, historyId, input, task: acknowledged.task,
      taskId: acknowledged.task.id, lutInput, lut, preferences, rejectedTask};
  } finally {await tasks.drain(); await services.drain(); store.close();}
}
