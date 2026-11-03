import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/index.ts';
import {openAppLibrary, isAppLibraryHeld} from '../packages/business/src/app-db/index.ts';
import {isProjectFileHeld} from '../packages/business/src/project-file/held-files.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {registerProjectMediaStore} from '../packages/business/src/project-media-storage.ts';
import {createMioProjectMedia} from '../packages/business/src/agent/mio-project-media.ts';
import {readProjectOutputUnpublishedSnapshot} from '../packages/business/src/project-output-unpublished.ts';
import {publishProjectOutput, assertPublishedProjectOutput, markProjectOutputRegistered,
  restorePublishedProjectOutput, setProjectOutputPublicationTestHooks} from '../packages/business/src/project-output-publication.ts';
import type {ProjectOutputInput, PublishedProjectOutput} from '../packages/business/src/project-output-publication.ts';
import {projectOutputPublicationProofSchema} from '../packages/contracts/src/project-output-publication.ts';
import {projectMediaPath} from '../packages/contracts/src/project-file.ts';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS} from '../packages/contracts/src/images.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {CreateServicesOptions} from '../packages/business/src/services.ts';
import type {Provider} from '../packages/business/src/provider-registry.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {run} from '../packages/business/src/media.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {validatePng} from '../packages/business/src/images/png.ts';
import type {PrevisNodeRecord} from '../packages/contracts/src/previs.ts';
import {png, pngChunk} from './helpers/timeline-image-fixtures.ts';

const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
};
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const picture = png({width: 64, height: 64, rgba: false, extra: [pngChunk('tEXt', Buffer.from('comment\0' + 'x'.repeat(150000)))]});
const invalid = {code: 'MEDIA_LIST_PATH_INVALID'};

/** Test-only before/after oracle: no descriptor is opened for a held database.
 * The actual host operation is observed separately between the two captures. */
function filesUnder(roots: readonly string[]) {
  const result: {file: string; facts: readonly (bigint | string)[]; bytes?: Buffer}[] = [];
  const visit = (file: string): void => {
    const info = lstatSync(file, {bigint: true, throwIfNoEntry: false}); if (!info) return;
    const facts = [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs];
    if (info.isDirectory()) {result.push({file, facts}); for (const child of readdirSync(file).sort()) visit(path.join(file, child));}
    else {
      const identity = {dev: String(info.dev), ino: String(info.ino)};
      const protectedFile = isProjectFileHeld(identity) || isAppLibraryHeld(identity) || /\.mioon(?:-|$)/u.test(path.basename(file));
      result.push({file, facts, ...(!info.isSymbolicLink() && !protectedFile ? {bytes: readFileSync(file)} : {})});
    }
  };
  for (const root of roots) visit(root); return result;
}

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-r3-s2-'));
  const projectDir = path.join(root, 'Project'), appRoot = path.join(root, 'AppData'), cacheRoot = path.join(root, 'Cache'), tempRoot = path.join(root, 'Tmp');
  mkdirSync(projectDir); const app = openAppLibrary({dataDir: appRoot});
  const projectFile = path.join(projectDir, 'Film.mioon'), locate = (id: string) => ({
    localDir: path.join(appRoot, 'records', id), cacheDir: path.join(cacheRoot, 'projects', id), tempDir: path.join(tempRoot, 'projects', id),
  });
  let store = createProjectStore({projectFile, locate});
  store.put('projects', {id: store.projectId, name: 'S2 directory intersection', revision: 1, createdAt: '2026-11-04T00:00:00.000Z'});
  let release = registerProjectMediaStore(store, {outsidePaths: app.outsidePaths});
  let host = createMioProjectMedia({store, privateDirectories: [app.dataDir, cacheRoot, tempRoot]});
  const drains: (() => Promise<void>)[] = [];
  const drain = async (): Promise<void> => {for (const close of drains.splice(0)) await close();};
  t.after(async () => {try {await drain(); release(); store.close(); app.close();} finally {rmSync(root, {recursive: true, force: true});}});
  const totals = () => ({project: store.db.prepare('SELECT total_changes() AS n').get()!.n, application: app.db.prepare('SELECT total_changes() AS n').get()!.n});
  async function readOnly<T>(operation: () => Promise<T>): Promise<T> {
    const before = totals(), files = filesUnder([projectDir, store.tempDir]); const processes: string[] = [];
    const remove = onMediaProcess(event => {if (event.type === 'started') processes.push(event.kind ?? 'unknown');});
    try {return await operation();}
    finally {remove(); assert.deepEqual(totals(), before); assert.deepEqual(filesUnder([projectDir, store.tempDir]), files);
      assert.ok(processes.every(kind => kind === 'ffprobe'), `Listing started effects: ${processes.join(',')}`);}
  }
  const input = (kind: ProjectOutputInput['owner']['kind'] = 'image', bytes = picture): ProjectOutputInput => {
    const directory = path.join(store.tempDir, 'test-complete-artifacts'); ensurePrivateDirectory(directory, {create: true});
    const stageFile = path.join(directory, `${randomUUID()}.png`); writeFileSync(stageFile, bytes, {mode: 0o600});
    return {owner: {kind, id: randomUUID(), requestId: randomUUID(), inputHash: 'a'.repeat(64)}, assetId: randomUUID(),
      targetKind: kind === 'export' ? 'exports' : kind === 'import' ? 'assets' : 'generated', stageFile, mimeType: 'image/png', sha256: sha(bytes), sizeBytes: bytes.length};
  };
  function register(input: ProjectOutputInput, output: PublishedProjectOutput) {
    return store.tx(() => {assertPublishedProjectOutput(store, output.publication); const {relativePath: _relative, ...fields} = output;
      return store.put('assets', {id: input.assetId, projectId: store.projectId, name: 'Published fixture.png', mimeType: input.mimeType,
        width: 64, height: 64, ...fields, provenance: input.targetKind === 'exports' ? 'export' : 'generated', url: projectMediaPath(store.projectId, input.assetId)});
    });
  }
  return {root, projectDir, app, locate, input, register, totals, readOnly,
    get store() {return store;}, addDrain(close: () => Promise<void>) {drains.push(close);},
    list: (directory = '', extra: {signal?: AbortSignal; beforeEffect?: () => void} = {}) => readOnly(() => host.list(store.projectId,
      {directory}, {beforeEffect: extra.beforeEffect ?? (() => {}), ...(extra.signal ? {signal: extra.signal} : {})})),
    snapshot: () => readOnly(() => readProjectOutputUnpublishedSnapshot(store, {beforeEffect() {}})),
    async reopen() {await drain(); release(); store.close(); store = openProjectStore({projectFile, locate});
      release = registerProjectMediaStore(store, {outsidePaths: app.outsidePaths});
      host = createMioProjectMedia({store, privateDirectories: [app.dataDir, cacheRoot, tempRoot]});},
  };
}

async function succeeded(read: () => Promise<unknown>): Promise<Record<string, unknown>> {
  for (let i = 0; i < 2000; i++) {
    const value = row(await read()); if (value.state === 'succeeded') return value;
    if (['failed', 'local_result_error', 'outcome_unknown', 'interrupted'].includes(String(value.state))) assert.fail(JSON.stringify(value));
    await pause(5);
  }
  assert.fail('Local production output did not settle');
}

test('real services expose generation/image/frame/scene/previs and S1 imports in fixed directories; a shared-publisher export remains readable', async t => {
  const f = fixture(t), video = path.join(f.root, 'complete-source.mp4'), frameBytes = png({width: 144, height: 256, rgba: false});
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'color=c=blue:s=144x256:r=30:d=3',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', video]);
  const sourceHash = sha(readFileSync(video)), imageBytes = png({width: 1024, height: 1024, rgba: false});
  const imageMetadata = await validatePng(imageBytes), frameMetadata = await validatePng(frameBytes, {width: 144, height: 256});
  const provider: Provider = {id: 'ark', capabilities: {models: ['fixture'], inputModes: ['text'], aspectRatios: ['9:16'], durations: [4], configured: true, enabled: true, mock: false},
    submit: async () => ({providerJobId: 'local-completed-output'}), poll: async () => ({status: 'succeeded'}), reconcile: async () => null,
    download: async (_id, destination) => {copyFileSync(video, destination);}};
  const probe = {streamIndex: 0, timeBaseNumerator: 1, timeBaseDenominator: 15360, width: 144, height: 256, rotation: 0, sarNumerator: 1, sarDenominator: 1};
  const options: CreateServicesOptions = {application: createProjectServiceApplication(f.app, undefined, {}), env: {},
    imageOptions: {generate: async (_snapshot, context) => {if (typeof context.beforeDispatch === 'function') context.beforeDispatch();
      return {bytes: imageBytes, metadata: {...imageMetadata, isMock: true, providerRequestId: null, usage: null}};}},
    frameOptions: {decode: async input => {assert.ok(input); input.beforeSpawn?.(input.signal!); return {bytes: frameBytes,
      metadata: frameMetadata, provenance: {profileId: 'local-png-1024-v1', selectionRule: 'first-pts-at-or-after-v1', sourceFrame: Number(input.requestedFrame), fps: 30, sourceHash, probe}};}},
    sceneOptions: {detect: async input => {input.beforeSpawn?.(input.signal!); return {profileId: 'scene-cuts-v1', fps: 30, frameCount: 90,
      options: {mode: 'adaptive', sensitivity: 60, minShotSeconds: 0.6}, cuts: [{frame: 30, score: 0.8}], segments: [], sourceHash, analysis: {width: 256, height: 144, decodedFrames: 90}};},
    decodeKeyframes: async input => {input.beforeSpawn?.(input.signal!); input.marks!.forEach((_mark, index) => input.onFrame!({index, marks: [index], bytes: frameBytes}));
      return {profileId: 'local-png-1024-v1', selectionRule: 'first-pts-at-or-after-v1', sourceHash, width: 144, height: 256, probe, frameOf: input.marks!.map((_mark, index) => index)};}},
  };
  const providers = new Map([['ark', provider]]), services = createServices(f.store, providers, options); f.addDrain(() => services.drain());
  const projectId = f.store.projectId, shot = row(await services.call('shot.create', {projectId, title: 'Local video', prompt: 'Blue fixture', duration: 4}));
  const job = row(await services.call('generation.submit', {shotId: shot.id, expectedRevision: shot.revision, providerId: 'ark', requestId: randomUUID()}));
  const worker = startWorker(f.store, services, providers);
  try {await worker.tick(); await worker.tick();} finally {await worker.stop();}
  assert.equal(row(f.store.get('jobs', String(job.id))).status, 'succeeded');
  const image = row(await services.call('image.generate', {projectId, name: 'Local image', prompt: 'Fixture', providerId: 'mock', model: IMAGE_MODELS.mock,
    options: IMAGE_FIXED_OPTIONS, requestId: randomUUID()}));
  await succeeded(() => services.call('image.task.get', {projectId, taskId: image.id}));
  mkdirSync(path.join(f.projectDir, 'media')); copyFileSync(video, path.join(f.projectDir, 'media', 'user.mp4'));
  const imported = row(await services.call('asset.import', {projectId, requestId: randomUUID(), sourcePath: path.join(f.projectDir, 'media', 'user.mp4')}));
  assert.equal(imported.sha256, null);
  await services.call('asset.media.prepare', {projectId, assets: [{assetId: imported.id, referenceRevision: 1}], purpose: 'frame'});
  const frame = row(await services.call('frame.extract', {projectId, sourceAssetId: imported.id, sourceHash, sourceFrame: 7, requestId: randomUUID()}));
  await succeeded(() => services.call('frame.task.get', {projectId, taskId: frame.id}));
  const detection = row(await services.call('scene.detect', {projectId, sourceAssetId: imported.id, sourceHash, requestId: randomUUID()}));
  const detected = await succeeded(() => services.call('scene.task.get', {projectId, taskId: detection.id}));
  const scene = row(await services.call('scene.shots.create', {projectId, sourceAssetId: imported.id, sourceHash, resultId: row(detected.result).id, segments: [2], requestId: randomUUID()}));
  await succeeded(() => services.call('scene.task.get', {projectId, taskId: scene.id}));
  const created = await services.call('previs.create', {projectId, label: 'Camera', position: {x: 0, y: 0}, requestId: randomUUID()}) as PrevisNodeRecord;
  const node = await services.call('previs.scene.set', {projectId, nodeId: created.id, expectedSceneRevision: created.sceneRevision,
    scene: {...created.scene, keyframes: [{id: 'k1', name: '', camera: created.scene.camera, exports: []}], activeKeyframeId: 'k1'}, requestId: randomUUID()}) as PrevisNodeRecord;
  await services.call('previs.output.publish', {projectId, nodeId: node.id, keyframeId: 'k1', sceneRevision: node.sceneRevision,
    requestId: randomUUID(), name: 'Previs.png', sha256: sha(frameBytes), width: 144, height: 256, dataBase64: frameBytes.toString('base64')});
  await services.call('asset.import', {projectId, requestId: randomUUID(), name: 'Upload.png', mimeType: 'image/png', dataBase64: frameBytes.toString('base64')});
  // Reuse the production exporter publication seam; the existing S2 export
  // restore suite separately exercises full timeline rendering.
  const exportInput = f.input('export'), exported = await publishProjectOutput(f.store, exportInput);
  f.register(exportInput, exported); await markProjectOutputRegistered(f.store, exported.publication);
  for (let i = 0; i < 2000 && !services.isQuiescent(); i++) await pause(5);
  assert.equal(services.isQuiescent(), true);
  const kinds = f.store.list('assets', projectId).flatMap(asset => {
    const parsed = projectOutputPublicationProofSchema.safeParse(row(asset).publication); return parsed.success ? [parsed.data.owner.kind] : [];
  });
  for (const kind of ['generation', 'image', 'frame', 'scene', 'previs', 'export', 'import']) assert.ok(kinds.includes(kind as typeof kinds[number]), kind);
  assert.deepEqual((await f.list()).entries.map(entry => entry.name), ['media', '导出', '生成', '素材']);
  assert.equal((await f.list('生成')).entries.length, 5); assert.equal((await f.list('导出')).entries.length, 1);
  assert.equal((await f.list('素材')).entries.length, 1); assert.deepEqual((await f.list('media')).entries.map(entry => entry.name), ['user.mp4']);
});

test('real producer filenames containing DEL or C1 are skipped without blocking other uploaded media', async t => {
  const f = fixture(t), bytes = png({width: 64, height: 64, rgba: false});
  const services = createServices(f.store, new Map(), {application: createProjectServiceApplication(f.app, undefined, {}), env: {}});
  f.addDrain(() => services.drain());
  const importImage = async (name: string) => {
    const asset = row(await services.call('asset.import', {projectId: f.store.projectId, requestId: randomUUID(), name,
      mimeType: 'image/png', dataBase64: bytes.toString('base64')}));
    return projectOutputPublicationProofSchema.parse(row(f.store.get('assets', String(asset.id))).publication);
  };
  const visible = await importImage('Visible.png');
  for (const control of ['\u007f', '\u0085']) {
    const publication = await importImage(`Hidden${control}name.png`);
    assert.ok(publication.relativePath.includes(control), 'Exercise a real permitted producer filename, not an invented receipt');
    assert.equal(existsSync(path.join(f.projectDir, publication.relativePath)), true);
  }
  assert.equal(readdirSync(path.join(f.projectDir, '素材')).length, 3);
  const page = await f.list('素材');
  assert.deepEqual(page.entries.map(entry => entry.name), [path.basename(visible.relativePath)]);
  assert.ok(!/[\u007f-\u009f]/u.test(JSON.stringify(page))); assert.ok(!JSON.stringify(page).includes(f.root));
});

const interruptions = [
  {point: 'after_intent', forceCopy: false, decision: 'empty'},
  {point: 'after_target_create', forceCopy: true, decision: 'reject'},
  {point: 'after_target_identity', forceCopy: true, decision: 'exclude'},
  {point: 'after_copy_chunk', forceCopy: true, decision: 'exclude'},
  {point: 'after_final', forceCopy: false, decision: 'exclude'},
  {point: 'after_final', forceCopy: true, decision: 'exclude'},
] as const;
for (const scenario of interruptions) test(`host reopens ${scenario.forceCopy ? 'copy' : 'link'} ${scenario.point} without exposing or repairing an unpublished target`, async t => {
  const f = fixture(t), input = f.input(), stop = new Error('stop publication'); let file = '';
  const remove = setProjectOutputPublicationTestHooks(f.store, {forceCopy: scenario.forceCopy,
    fault: (point, proof) => {file = path.join(f.projectDir, proof.relativePath); if (point === scenario.point) throw stop;}});
  await assert.rejects(publishProjectOutput(f.store, input), error => error === stop); remove();
  for (const reopened of [false, true]) {
    if (reopened) await f.reopen();
    if (scenario.decision === 'reject') await assert.rejects(f.list('生成'), invalid);
    else {
      if (scenario.decision === 'exclude') {
        const snapshot = await f.snapshot(); assert.equal(snapshot.isExcluded(file, lstatSync(file, {bigint: true})), true);
      }
      assert.deepEqual((await f.list('生成')).entries, []);
    }
    assert.equal(f.store.get('assets', input.assetId), null);
  }
});

for (const forceCopy of [false, true]) test(`prepared ${forceCopy ? 'copy' : 'link'} is visible after the exact DB commit even before registered ACK`, async t => {
  const f = fixture(t), input = f.input(); setProjectOutputPublicationTestHooks(f.store, {forceCopy});
  const output = await publishProjectOutput(f.store, input); f.register(input, output);
  const receipt = path.join(f.store.tempDir, 'publications', output.publication.publicationId + '.json');
  assert.equal(row(JSON.parse(readFileSync(receipt, 'utf8'))).phase, 'prepared');
  assert.equal((await f.list('生成')).entries.length, 1); await f.reopen();
  assert.equal((await f.list('生成')).entries.length, 1); assert.equal(row(JSON.parse(readFileSync(receipt, 'utf8'))).phase, 'prepared');
});

for (const point of ['after_intent', 'after_target_create', 'after_target_identity', 'after_copy_chunk', 'after_final'] as const)
test(`restore ${point} distinguishes incomplete bytes from complete frozen proof despite the existing DB row`, async t => {
  const f = fixture(t), input = f.input('export'), output = await publishProjectOutput(f.store, input), asset = f.register(input, output);
  await markProjectOutputRegistered(f.store, output.publication); const file = path.join(f.projectDir, output.relativePath); unlinkSync(file);
  const stageFile = path.join(f.store.tempDir, 'restore.png'); writeFileSync(stageFile, picture, {mode: 0o600});
  const stop = new Error('stop restore'), remove = setProjectOutputPublicationTestHooks(f.store, {fault: seen => {if (seen === point) throw stop;}});
  await assert.rejects(restorePublishedProjectOutput(f.store, {asset: row(asset), stageFile}), error => error === stop); remove();
  assert.ok(f.store.get('assets', input.assetId));
  for (const reopened of [false, true]) {
    if (reopened) await f.reopen();
    if (point === 'after_intent' || point === 'after_target_create') await assert.rejects(f.list('导出'), invalid);
    else {const snapshot = await f.snapshot(), complete = point === 'after_final';
      assert.equal(snapshot.isExcluded(file, lstatSync(file, {bigint: true})), !complete);
      assert.equal((await f.list('导出')).entries.length, complete ? 1 : 0);}
  }
});

test('complete restoration is listable with original and restore receipts retained, including after reopen', async t => {
  const f = fixture(t), input = f.input('export'), output = await publishProjectOutput(f.store, input), asset = f.register(input, output);
  await markProjectOutputRegistered(f.store, output.publication); unlinkSync(path.join(f.projectDir, output.relativePath));
  const stageFile = path.join(f.store.tempDir, 'restore.png'); writeFileSync(stageFile, picture, {mode: 0o600});
  await restorePublishedProjectOutput(f.store, {asset: row(asset), stageFile});
  assert.ok(existsSync(path.join(f.store.tempDir, 'publications', `restore-${output.publication.publicationId}.json`)));
  assert.equal((await f.list('导出')).entries.length, 1); await f.reopen(); assert.equal((await f.list('导出')).entries.length, 1);
});

test('same-byte replacement of an unpublished target cannot inherit its local inode proof', async t => {
  const f = fixture(t), input = f.input(), stop = new Error('prepared'); let file = '';
  const remove = setProjectOutputPublicationTestHooks(f.store, {fault: (point, proof) => {file = path.join(f.projectDir, proof.relativePath); if (point === 'after_final') throw stop;}});
  await assert.rejects(publishProjectOutput(f.store, input), error => error === stop); remove();
  renameSync(file, file + '.retained'); writeFileSync(file, picture);
  await assert.rejects(f.list('生成'), invalid); await f.reopen(); await assert.rejects(f.list('生成'), invalid);
});

test('a real copied partial renamed into root aliases stays excluded after reopen and cannot authorize a different canonical inode', async t => {
  const f = fixture(t), input = f.input(), stop = new Error('partial copied'); let canonical = '', receipt = '';
  const remove = setProjectOutputPublicationTestHooks(f.store, {forceCopy: true, fault: (point, proof) => {
    canonical = path.join(f.projectDir, proof.relativePath);
    receipt = path.join(f.store.tempDir, 'publications', proof.publicationId + '.json');
    if (point === 'after_copy_chunk') throw stop;
  }});
  await assert.rejects(publishProjectOutput(f.store, input), error => error === stop); remove();
  const beforeReceipt = readFileSync(receipt), partial = readFileSync(canonical);
  assert.ok(partial.length > 8 && partial.length < picture.length); assert.deepEqual(partial.subarray(0, 8), picture.subarray(0, 8));
  const alias = path.join(f.projectDir, 'alias.png'), hardlink = path.join(f.projectDir, 'alias-hardlink.png');
  renameSync(canonical, alias); linkSync(alias, hardlink); writeFileSync(path.join(f.projectDir, 'visible.png'), png({rgba: false}));
  for (const reopened of [false, true]) {
    if (reopened) await f.reopen();
    const snapshot = await f.snapshot();
    assert.equal(snapshot.isExcluded(alias, lstatSync(alias, {bigint: true})), true);
    assert.equal(snapshot.isExcluded(hardlink, lstatSync(hardlink, {bigint: true})), true);
    assert.deepEqual((await f.list()).entries.map(entry => entry.name), ['生成', 'visible.png']);
    assert.deepEqual(readFileSync(receipt), beforeReceipt);
  }
  writeFileSync(canonical, picture);
  assert.notEqual(lstatSync(canonical, {bigint: true}).ino, lstatSync(alias, {bigint: true}).ino);
  await assert.rejects(f.list(), invalid); assert.deepEqual(readFileSync(receipt), beforeReceipt);
  assert.deepEqual(readFileSync(alias), partial); assert.deepEqual(readFileSync(hardlink), partial);
});

test('a surviving abandoned attempt blocks the host without treating a later completed publication as authority for it', async t => {
  const f = fixture(t), input = f.input(); let first = '';
  const remove = setProjectOutputPublicationTestHooks(f.store, {fault: (point, proof) => {
    if (point === 'after_intent') {first = path.join(f.projectDir, proof.relativePath); writeFileSync(first, picture, {flag: 'wx'});}
  }});
  const output = await publishProjectOutput(f.store, input); remove();
  assert.notEqual(path.join(f.projectDir, output.relativePath), first); f.register(input, output); await markProjectOutputRegistered(f.store, output.publication);
  await assert.rejects(f.list('生成'), invalid); unlinkSync(first);
  assert.equal((await f.list('生成')).entries.length, 1);
});

test('registered S2 history does not pin the current row or ordinary file after subsequent edits', async t => {
  const f = fixture(t), input = f.input(), output = await publishProjectOutput(f.store, input), asset = row(f.register(input, output));
  await markProjectOutputRegistered(f.store, output.publication);
  f.store.put('assets', {...asset, name: 'Later user name'});
  const file = path.join(f.projectDir, output.relativePath), replacement = png({width: 32, height: 24, rgba: false}); writeFileSync(file, replacement);
  assert.equal((await f.list('生成')).entries[0]?.sizeBytes, replacement.length);
  f.store.tx(() => f.store.db.prepare('DELETE FROM assets WHERE id=?').run(input.assetId));
  assert.equal((await f.list('生成')).entries.length, 1); await f.reopen(); assert.equal((await f.list('生成')).entries.length, 1);
});
