import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, getWorkspaceRestoreContext } from '../packages/business/src/db.mjs';
import { createServices } from '../packages/business/src/services.mjs';
import { startWorker } from '../packages/business/src/jobs.mjs';
import { run } from '../packages/business/src/media-runtime.mjs';
import { createWorkspaceBackup } from '../packages/business/src/workspace-backup.mjs';
import { restoreWorkspaceBackup } from '../packages/business/src/workspace-restore.mjs';

test('project-owned Look survives removed source file, cold reopen, render and restored33 backup', { timeout: 120000 }, async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'mioon-look-portable-')), root = path.join(base, 'workspace');
  t.after(() => rm(base, { recursive: true, force: true }));
  const localPack = path.join(base, 'selected.mioon-look.cube'), source = path.join(base, 'source.mp4');
  const original = await readFile(new URL('../examples/look-packs/synthetic-nonlinear.mioon-look.cube', import.meta.url));
  await writeFile(localPack, original, { flag: 'wx', mode: 0o600 });
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'color=c=0x18bf57:s=64x48:r=30:d=1', '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', source], { timeout: 30000, maxStdoutBytes: 0 });
  let store = openStore(root), services = createServices(store, new Map()), worker;
  let project, input, imported, inspection, timeline;
  try {
    project = await services.call('project.create', { name: 'Look pack portability' });
    const asset = await services.call('asset.import', { projectId: project.id, name: 'SDR.mp4', mimeType: 'video/mp4', dataBase64: (await readFile(source)).toString('base64') });
    input = { projectId: project.id, name: path.basename(localPack), requestId: randomUUID(), dataBase64: (await readFile(localPack)).toString('base64') };
    imported = await services.call('lut.import', input);
    inspection = await services.call('lut.look.inspect', { projectId: project.id, lutId: imported.resource.id }); assert.equal(inspection.status, 'verified');
    timeline = await services.call('timeline.get', { projectId: project.id });
    timeline = await services.call('timeline.clip.add', { projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), assetId: asset.id, trackId: timeline.tracks[0].id, startFrame: 0, durationFrames: 6 });
    const colour = { profileId: 'mioon-rec709-sdr-clip-v1', source: { profileId: 'rec709-yuv-sdr-v1', assetSha256: asset.sha256, streamIndex: 0, range: 'limited', declaredBy: 'user', declaredAt: new Date().toISOString() },
      look: { resourceId: imported.resource.id, resourceSha256: imported.resource.sha256, resourceProfile: imported.resource.profile, purpose: 'rec709-sdr-creative', declaredBy: 'user', enabled: true, strength: 0.7 } };
    timeline = await services.call('timeline.clip.update', { projectId: project.id, clipId: timeline.clips[0].id, expectedRevision: timeline.revision, requestId: randomUUID(), patch: { colour } });
  } finally { await services.drain(); store.close(); }
  await rm(localPack); await assert.rejects(readFile(localPack), { code: 'ENOENT' });
  store = openStore(root); services = createServices(store, new Map());
  try {
    assert.deepEqual(await services.call('lut.import', input), imported, 'exact receipt survives source removal and cold reopen');
    assert.deepEqual(await services.call('lut.look.inspect', { projectId: project.id, lutId: imported.resource.id }), inspection);
    assert.deepEqual(Buffer.from(store.db.prepare('SELECT content FROM project_lut_resources WHERE id=?').get(imported.resource.id).content), original);
    const accepted = await services.call('timeline.render', { projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export' });
    worker = startWorker(store, services, new Map()); await worker.tick();
    const result = await services.call('export.get', { exportId: accepted.id }); assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
  } finally { await worker?.stop(); await services.drain(); store.close(); }
  const backup = path.join(base, 'backup'), restored = path.join(base, 'restored');
  assert.equal((await createWorkspaceBackup({ source: root, destination: backup })).databaseSchemaVersion, 32);
  assert.equal((await restoreWorkspaceBackup({ directory: backup, destination: restored })).databaseSchemaVersion, 33);
  store = openStore(restored); services = createServices(store, new Map()); worker = undefined;
  try {
    assert.deepEqual(await services.call('lut.look.inspect', { projectId: project.id, lutId: imported.resource.id }), inspection);
    assert.deepEqual(Buffer.from(store.db.prepare('SELECT content FROM project_lut_resources WHERE id=?').get(imported.resource.id).content), original);
    assert.equal((await services.call('workspace.restore.inspect', {})).operationPolicy.find(p => p.operation === 'lut.look.inspect').available, true);
    await assert.rejects(services.call('lut.import', input), { code: 'RESTORE_OPERATION_UNAVAILABLE' });
    const accepted = await services.call('timeline.render', { projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export' }, { expectedWorkspaceOrigin: getWorkspaceRestoreContext(store).workspaceOrigin });
    worker = startWorker(store, services, new Map()); await worker.tick();
    const result = await services.call('export.get', { exportId: accepted.id }); assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM project_lut_resources').get().n, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM lut_import_requests').get().n, 1);
  } finally { await worker?.stop(); await services.drain(); store.close(); }
});
