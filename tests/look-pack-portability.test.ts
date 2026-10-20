import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, getWorkspaceRestoreContext } from '../packages/business/src/db.ts';
import { createServices } from '../packages/business/src/services.ts';
import { startWorker } from '../packages/business/src/jobs.ts';
import { run } from '../packages/business/src/media-runtime.ts';
import { createWorkspaceBackup } from '../packages/business/src/workspace-backup.ts';
import { restoreWorkspaceBackup } from '../packages/business/src/workspace-restore.ts';

for (const sourceSchema of [50]) test(`project-owned Look survives removed source file, cold reopen, render and ordinary${sourceSchema}/restored${sourceSchema + 1} backup`, { timeout: 120000 }, async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'mioon-look-portable-')), root = path.join(base, 'workspace');
  (t as {after(callback: ()=>void): void}).after(() => rm(base, { recursive: true, force: true }));
  const localPack = path.join(base, 'selected.mioon-look.cube'), source = path.join(base, 'source.mp4');
  const original = await readFile(new URL('../examples/look-packs/synthetic-nonlinear.mioon-look.cube', import.meta.url));
  await writeFile(localPack, original, { flag: 'wx', mode: 0o600 });
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'color=c=0x18bf57:s=64x48:r=30:d=1', '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', source], { timeout: 30000, maxStdoutBytes: 0 });
  interface ProjectShape {id: string}
  interface AssetShape {id: string; sha256: string}
  interface TimelineShape {revision: number; id?: string; tracks: {id: string}[]; clips: {id: string}[]}
  interface ResourceShape {id: string; sha256: string; profile: unknown}
  interface ImportedShape {resource: ResourceShape}
  interface InspectionShape {status: string; [key: string]: unknown}
  let store: ReturnType<typeof openStore> = openStore(root), services: ReturnType<typeof createServices> = createServices(store, new Map());
  let worker: ReturnType<typeof startWorker>|undefined;
  let project!: ProjectShape, input!: Record<string, unknown>, imported!: ImportedShape, inspection!: InspectionShape, timeline!: TimelineShape;
  try {
    project = await services.call('project.create', { name: 'Look pack portability' }) as unknown as ProjectShape;
    const asset = await services.call('asset.import', { projectId: project.id, name: 'SDR.mp4', mimeType: 'video/mp4', dataBase64: (await readFile(source)).toString('base64') }) as unknown as AssetShape;
    input = { projectId: project.id, name: path.basename(localPack), requestId: randomUUID(), dataBase64: (await readFile(localPack)).toString('base64') };
    imported = await services.call('lut.import', input) as unknown as ImportedShape;
    inspection = await services.call('lut.look.inspect', { projectId: project.id, lutId: imported.resource.id }) as unknown as InspectionShape; assert.equal(inspection.status, 'verified');
    timeline = await services.call('timeline.get', { projectId: project.id }) as unknown as TimelineShape;
    timeline = await services.call('timeline.clip.add', { projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), assetId: asset.id, trackId: timeline.tracks[0]!.id, startFrame: 0, durationFrames: 6 }) as unknown as TimelineShape;
    const colour = { profileId: 'mioon-rec709-sdr-clip-v1', source: { profileId: 'rec709-yuv-sdr-v1', assetSha256: asset.sha256, streamIndex: 0, range: 'limited', declaredBy: 'user', declaredAt: new Date().toISOString() },
      look: { resourceId: imported.resource.id, resourceSha256: imported.resource.sha256, resourceProfile: imported.resource.profile, purpose: 'rec709-sdr-creative', declaredBy: 'user', enabled: true, strength: 0.7 } };
    timeline = await services.call('timeline.clip.update', { projectId: project.id, clipId: timeline.clips[0]!.id, expectedRevision: timeline.revision, requestId: randomUUID(), patch: { colour } }) as unknown as TimelineShape;
  } finally { await services.drain(); store.close(); }
  await rm(localPack); await assert.rejects(readFile(localPack), { code: 'ENOENT' });
  store = openStore(root); services = createServices(store, new Map());
  try {
    assert.deepEqual(await services.call('lut.import', input), imported, 'exact receipt survives source removal and cold reopen');
    assert.deepEqual(await services.call('lut.look.inspect', { projectId: project.id, lutId: imported.resource.id }), inspection);
    assert.deepEqual(Buffer.from((store.db.prepare('SELECT content FROM project_lut_resources WHERE id=?').get(imported.resource.id) as {content: Uint8Array}).content), original);
    const accepted = await services.call('timeline.render', { projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export' }) as unknown as {id: string};
    worker = startWorker(store, services, new Map()); await worker.tick();
    const result = await services.call('export.get', { exportId: accepted.id }) as {status: string; error?: unknown}; assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
  } finally { await worker?.stop(); await services.drain(); store.close(); }
  const backup = path.join(base, 'backup'), restored = path.join(base, 'restored');
  assert.equal((await createWorkspaceBackup({ source: root, destination: backup })).databaseSchemaVersion, sourceSchema);
  assert.equal((await restoreWorkspaceBackup({ directory: backup, destination: restored })).databaseSchemaVersion, sourceSchema + 1);
  store = openStore(restored); services = createServices(store, new Map()); worker = undefined;
  try {
    assert.deepEqual(await services.call('lut.look.inspect', { projectId: project.id, lutId: imported.resource.id }), inspection);
    assert.deepEqual(Buffer.from((store.db.prepare('SELECT content FROM project_lut_resources WHERE id=?').get(imported.resource.id) as {content: Uint8Array}).content), original);
    const inspected = await services.call('workspace.restore.inspect', {}) as {operationPolicy: {operation: string; available: boolean}[]};
    assert.equal(inspected.operationPolicy.find((p: {operation: string}) => p.operation === 'lut.look.inspect')!.available, true);
    await assert.rejects(services.call('lut.import', input), { code: 'RESTORE_OPERATION_UNAVAILABLE' });
    const accepted = await services.call('timeline.render', { projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export' }, { expectedWorkspaceOrigin: getWorkspaceRestoreContext(store)!.workspaceOrigin }) as unknown as {id: string};
    worker = startWorker(store, services, new Map()); await worker.tick();
    const result = await services.call('export.get', { exportId: accepted.id }) as {status: string; error?: unknown}; assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM project_lut_resources').get() as {n: number}).n, 1);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM lut_import_requests').get() as {n: number}).n, 1);
  } finally { await worker?.stop(); await services.drain(); store.close(); }
});
