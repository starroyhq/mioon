import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {createFcpExportServices} from '../packages/business/src/fcp-export.ts';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {createProjectAssetReferenceServices} from '../packages/business/src/project-asset-references.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {CLIP_TRANSITION_PROFILE} from '../packages/contracts/src/timeline-clip-transition.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createServices} from '../packages/business/src/services.ts';
import {fcpExportSchemas} from '../packages/contracts/src/fcp-export.ts';
import type {FcpExportGetOutput, FcpExportOperation} from '../packages/contracts/src/fcp-export.ts';

type FcpRpc<Op extends FcpExportOperation> = typeof fcpExportSchemas[Op];
type FcpExportInput<Op extends FcpExportOperation> = FcpRpc<Op>['input']['_input'];
type FcpExportOutput<Op extends FcpExportOperation> = ReturnType<FcpRpc<Op>['output']['parse']>;

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8JkyoAAAAASUVORK5CYII=', 'base64');
const time = '2026-01-01T00:00:00.000Z';

async function fixture(t: test.TestContext, {large = false, external = false} = {}) {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-fcp-'));
  const projectDir = path.join(directory, 'project');
  mkdirSync(projectDir);
  const projectId = randomUUID();
  const store = createProjectStore({projectId, projectFile: path.join(projectDir, 'Synthetic.mioon'), targetFormat: 5,
    locate: () => ({localDir: path.join(directory, 'local'), cacheDir: path.join(directory, 'cache'), tempDir: path.join(directory, 'temp')})});
  const library = openAppLibrary({dataDir: path.join(directory, 'app')});
  const application = createProjectServiceApplication(library);
  type Core = ReturnType<typeof createFcpExportServices>;
  type Services = ReturnType<typeof createServices>;
  let service: Core | Services | undefined;
  t.after(async () => {
    try {await service?.drain();} finally {
      store.close(); library.close(); rmSync(directory, {force: true, recursive: true});
    }
  });
  const bytes = large ? Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024)]) : png;
  const media = path.join(external ? directory : projectDir, 'media');
  mkdirSync(media);
  if (external) library.outsidePaths.confirm({projectId, directory: media, confirmedAt: time});
  const references = createProjectAssetReferenceServices(store, application);
  const names = ['一号 #.png', '同内容.png', '离线.png'];
  const files = names.map(name => path.join(media, name));
  const assets = [];
  for (let index = 0; index < files.length; index++) {
    const name = names[index]!;
    const file = files[index]!;
    writeFileSync(file, bytes, {mode: 0o600});
    const {reference} = await references.referenceForImport(file);
    assets.push({id: randomUUID(), projectId, name, mimeType: 'image/png', hasAudio: false, width: 1, height: 1, duration: null,
      reference, referenceRevision: 1, sha256: reference.fullSha256, sizeBytes: reference.sizeBytes});
  }
  unlinkSync(files[2]!);
  const rootId = randomUUID(), trackId = randomUUID(), timelineId = randomUUID();
  const entries = assets.map((asset, index) => ({
    asset, nodeId: randomUUID(), clipId: randomUUID(), segmentGroupId: randomUUID(), index,
  }));
  const placeholder = {shotId: randomUUID(), clipId: randomUUID(), segmentGroupId: randomUUID()};
  const rect = {x: 0, y: 0, width: 720, height: 1280};
  store.tx(() => {
    store.put('projects', {id: projectId, name: '台词剪辑', revision: 1, createdAt: time, updatedAt: time});
    store.put('nodes', {id: rootId, projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: time});
    store.put('shots', {id: placeholder.shotId, projectId, title: '未生成镜头', duration: 1, orderIndex: 0, selectedVersionId: null, createdAt: time, updatedAt: time});
    let previous = rootId;
    for (const entry of entries) {
      store.put('assets', entry.asset);
      store.put('nodes', {id: entry.nodeId, projectId, type: 'image', assetId: entry.asset.id, position: {x: 0, y: 0}, createdAt: time});
      store.put('edges', {id: randomUUID(), projectId, kind: 'sequence', source: previous, target: entry.nodeId, createdAt: time});
      previous = entry.nodeId;
    }
    store.put('edges', {id: randomUUID(), projectId, kind: 'sequence', source: previous, target: placeholder.shotId, createdAt: time});
    const clips = entries.map(entry => ({id: entry.clipId, trackId, name: entry.asset.name, startFrame: entry.index * 30,
      durationFrames: 30, sourceInFrame: 0, rect, gain: 1, assetId: entry.asset.id, sourceState: 'ready',
      sequenceSource: {kind: 'media', nodeId: entry.nodeId, segmentGroupId: entry.segmentGroupId}}));
    store.put('timelines', {id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: 120,
      createdAt: time, updatedAt: time, mainTrack: {trackId, sequenceNodeId: rootId},
      tracks: [{id: trackId, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
      clips: [...clips, {id: placeholder.clipId, trackId, name: '未生成镜头', startFrame: 90, durationFrames: 30,
        sourceInFrame: 0, rect, gain: 1, assetId: null, versionId: null, jobId: null, sourceState: 'placeholder', sequenceSource: {
          kind: 'shot', nodeId: placeholder.shotId, segmentGroupId: placeholder.segmentGroupId, versionMode: 'follow'}}]});
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootId, 1, JSON.stringify({version: 1,
        board: [...entries.map(entry => ({kind: 'media', nodeId: entry.nodeId, assetId: entry.asset.id})),
          {kind: 'shot', nodeId: placeholder.shotId, selectedVersionId: null}],
        track: [...entries.map(entry => ({kind: 'media', nodeId: entry.nodeId, clipId: entry.clipId, assetId: entry.asset.id, segmentGroupId: entry.segmentGroupId})),
          {kind: 'shot', nodeId: placeholder.shotId, clipId: placeholder.clipId, segmentGroupId: placeholder.segmentGroupId,
            versionMode: 'follow', appliedVersionId: null}]}));
  });
  return {directory, projectDir, files, store, library, bytes, projectId, outputDir: path.join(projectDir, '导出'),
    ordinary() {const services = createServices(store, new Map(), {application}); service = services; return services;},
    core(overrides?: Partial<Parameters<typeof createFcpExportServices>[1]>) {
      const core = createFcpExportServices(store, {...application, ...overrides}); service = core; return core;
    }};
}

async function settle(get: () => FcpExportGetOutput | Promise<FcpExportGetOutput>) {
  for (let retry = 0; retry < 300; retry++) {
    const status = await get();
    if (status.status !== 'running') return status;
    await delay(10);
  }
  assert.fail('FCP export did not settle');
}

test('FCP checklist matches anchors, transitions and mute present in the XML', async t => {
  const f = await fixture(t);
  const timeline = readFormat5TimelineRecord(f.store.db, 'project');
  assert.ok(timeline);
  const first = timeline.clips[0]!;
  const silentPicture = {...timeline.clips[1]!, name: 'Muted PNG', muted: true};
  const videoTrack = randomUUID(), audioTrack = randomUUID();
  const omittedAsset = randomUUID(), audioAsset = randomUUID();
  const supported = first.assetId!;
  const audioFile = path.join(f.projectDir, 'media', 'Stand-alone.wav');
  const wav = Buffer.alloc(44 + 96_000);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(96_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(96_000, 40);
  writeFileSync(audioFile, wav);
  const application = createProjectServiceApplication(f.library);
  const references = createProjectAssetReferenceServices(f.store, application);
  const {reference} = await references.referenceForImport(audioFile);
  f.store.put('assets', {id: audioAsset, projectId: f.projectId, name: 'Stand-alone.wav', mimeType: 'audio/wav', duration: 1,
    reference, referenceRevision: 1, sha256: reference.fullSha256, sizeBytes: reference.sizeBytes});
  f.store.put('assets', {id: omittedAsset, projectId: f.projectId, name: 'Omitted.webp', mimeType: 'image/webp'});
  const overlay = (name: string, startFrame: number, assetId: string) => ({id: randomUUID(), trackId: videoTrack, name,
    startFrame, assetId, sourceInFrame: 0, durationFrames: 12, rect: first.rect, gain: 1, sourceState: 'ready',
    anchor: startFrame === 0 ? {clipId: first.id, offsetFrames: 0} : null});
  const anchored = overlay('Anchored video', 0, supported);
  const transitionIn = {profileId: CLIP_TRANSITION_PROFILE, kind: 'wipeLeft', durationFrames: 6};
  const omitted = {...overlay('Omitted WebP', 12, omittedAsset), transitionIn};
  const afterOmitted = {...overlay('Cut after omitted', 24, supported), transitionIn};
  const retained = {...overlay('Retained transition', 36, supported), transitionIn};
  const audio = {...overlay('Stand-alone audio', 3, audioAsset), trackId: audioTrack, muted: true};
  f.store.put('timelines', {...timeline, tracks: [...timeline.tracks,
    {id: videoTrack, name: 'V2', kind: 'video', orderIndex: 1, hidden: false, muted: false},
    {id: audioTrack, name: 'A1', kind: 'audio', orderIndex: 2, hidden: false, muted: false},
  ], clips: [...timeline.clips.map(clip => clip.id === silentPicture.id ? silentPicture : clip), anchored, omitted, afterOmitted, retained, audio]});
  const {projectId} = f;
  const services = f.ordinary();
  const preview = fcpExportSchemas['export.fcpxml.preview'].output.parse(
    await services.call('export.fcpxml.preview', {projectId, copyMedia: true}));
  assert.deepEqual(preview.approximations.find(item => item.code === 'ANCHOR')?.clips.map(clip => clip.id), [anchored.id]);
  assert.deepEqual(preview.approximations.find(item => item.code === 'TRANSITION')?.clips.map(clip => clip.id), [retained.id]);
  assert.deepEqual(preview.approximations.find(item => item.code === 'MUTE')?.clips.map(clip => clip.id), [audio.id]);
  assert.deepEqual(preview.missing.find(item => item.code === 'UNSUPPORTED_MEDIA')?.clips.map(clip => clip.id), [omitted.id]);
  const start = fcpExportSchemas['export.fcpxml.start'].output.parse(await services.call('export.fcpxml.start',
    {projectId, requestId: 'checklist-cuts', name: 'Checklist', copyMedia: true, destination: {kind: 'project'}}));
  const done = await settle(async () => fcpExportSchemas['export.fcpxml.get'].output.parse(
    await services.call('export.fcpxml.get', {projectId, ...start})));
  assert.equal(done.status, 'done');
  const bundle = path.join(f.outputDir, done.result!.bundleName);
  const xml = readFileSync(path.join(bundle, 'Info.fcpxml'), 'utf8');
  assert.match(xml, /<asset-clip[^>]*name="Muted PNG"[^>]*\/>/u);
  assert.match(xml, /<asset-clip[^>]*name="Stand-alone audio"[^>]*><adjust-volume amount="-96dB"\/>/u);
  assert.equal(xml.match(/<transition name="Edge Wipe"/gu)?.length, 1);
  const manifest = JSON.parse(readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.approximations, preview.approximations);
  const checklist = readFileSync(path.join(bundle, 'missing.md'), 'utf8');
  assert.match(checklist, /Omitted WebP/u);
  assert.match(checklist, /静音（−96 dB）（1）\n  - Stand\\-alone audio · A1/u);
  assert.doesNotMatch(checklist, /Muted PNG|Cut after omitted/u);
});

test('project RPC previews without writing and exports one copy for equal SHA-256 sources', async t => {
  const f = await fixture(t);
  const services = f.ordinary();
  const rpc = async <Op extends FcpExportOperation>(op: Op, input: FcpExportInput<Op>): Promise<FcpExportOutput<Op>> =>
    fcpExportSchemas[op].output.parse(await services.call(op, input)) as FcpExportOutput<Op>;
  const {projectId, bytes, outputDir} = f;
  const preview = await rpc('export.fcpxml.preview', {projectId, copyMedia: true});
  assert.deepEqual(preview.timeline, {width: 720, height: 1280, fps: 30, durationFrames: 120, clipCount: 4});
  assert.equal(preview.defaultName, '台词剪辑');
  assert.equal(preview.projectDestination.displayPath, outputDir);
  assert.equal(preview.mediaFiles, 1);
  assert.equal(preview.mediaBytes, bytes.length);
  assert.deepEqual(preview.missing.map(item => item.code).sort(), ['MEDIA_MISSING', 'PLACEHOLDER']);
  assert.equal(preview.missing.find(item => item.code === 'MEDIA_MISSING')?.clips[0]?.trackLabel, 'V1');
  assert.equal(existsSync(outputDir), false);
  assert.equal(f.store.list('exports', projectId).length, 0);
  mkdirSync(outputDir);
  mkdirSync(path.join(outputDir, '台词剪辑.fcpxmld'));
  const first = {projectId, requestId: 'fcp-test-1', name: preview.defaultName, copyMedia: true, destination: {kind: 'project'}} as const;
  const key = await rpc('export.fcpxml.start', first);
  assert.deepEqual(await rpc('export.fcpxml.start', first), key);
  await assert.rejects(rpc('export.fcpxml.start', {...first, copyMedia: false}), {code: 'IDEMPOTENCY_CONFLICT'});
  const get = {projectId, ...key};
  const done = await settle(() => rpc('export.fcpxml.get', get));
  assert.equal(done.status, 'done');
  assert.deepEqual(done.progress, {files: 1, totalFiles: 1, bytes: bytes.length, totalBytes: bytes.length});
  assert.equal(done.result?.bundleName, '台词剪辑 2.fcpxmld');
  assert.equal(done.result?.missingCount, 2);
  assert.deepEqual(readdirSync(path.join(outputDir, '台词剪辑.fcpxmld')), []);
  const bundle = path.join(outputDir, done.result!.bundleName);
  const names = readdirSync(path.join(bundle, 'Media'));
  assert.deepEqual(names, ['001_一号 #.png']);
  assert.deepEqual(readFileSync(path.join(bundle, 'Media', names[0]!)), bytes);
  const xml = readFileSync(path.join(bundle, 'Info.fcpxml'), 'utf8');
  assert.ok(xml.includes(pathToFileURL(path.join(bundle, 'Media', names[0]!)).href));
  assert.match(xml, /Offline_[^"]+\.png/u);
  const manifest = JSON.parse(readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.missing, preview.missing);
  assert.deepEqual(manifest.approximations, preview.approximations);
  assert.deepEqual(manifest.media, [{file: 'Media/001_一号 #.png', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length}]);
  assert.match(readFileSync(path.join(bundle, 'missing.md'), 'utf8'), /未生成的镜头[\s\S]+离线/u);
  assert.equal(services.fcpExport.completedBundle(get)?.path, bundle);
  assert.deepEqual(await rpc('export.fcpxml.cancel', get), {status: 'done'});
  assert.equal((await services.call('export.get', {exportId: key.exportId}) as {kind: string}).kind, 'fcpxml-export');

  const originalPreview = await rpc('export.fcpxml.preview', {projectId, copyMedia: false});
  assert.equal(originalPreview.mediaBytes, 0);
  assert.equal(originalPreview.mediaFiles, 0);
  const originalKey = await rpc('export.fcpxml.start', {...first, requestId: 'fcp-test-2', name: '../链接', copyMedia: false});
  const original = await settle(() => rpc('export.fcpxml.get', {projectId, ...originalKey}));
  assert.equal(original.status, 'done');
  const originalBundle = path.join(outputDir, original.result!.bundleName);
  assert.equal(existsSync(path.join(originalBundle, 'Media')), false);
  const originalXml = readFileSync(path.join(originalBundle, 'Info.fcpxml'), 'utf8');
  for (const file of f.files.slice(0, 2)) assert.ok(originalXml.includes(pathToFileURL(file).href));
  const parked = bundle + '.old';
  renameSync(bundle, parked);
  symlinkSync(parked, bundle);
  assert.equal(services.fcpExport.completedBundle(get), null);
});

test('directory capability is bound to the selected directory and retries keep that selection', async t => {
  const f = await fixture(t);
  const service = f.core();
  const {projectId} = f;
  const directory = path.join(f.directory, 'chosen');
  mkdirSync(directory);
  const info = lstatSync(directory, {bigint: true});
  const token = randomUUID();
  const input = {projectId, requestId: 'external-1', name: 'Export', copyMedia: false, destination: {kind: 'chosen', token}} as const;
  assert.throws(() => service.start(input), {code: 'NOT_WRITABLE'});
  assert.throws(() => service.chooseDestination({projectId: randomUUID(), token, directory, device: String(info.dev), inode: String(info.ino)}), {code: 'NOT_FOUND'});
  assert.throws(() => service.chooseDestination({projectId, token, directory, device: String(info.dev), inode: '0'}), {code: 'NOT_WRITABLE'});
  assert.deepEqual(service.chooseDestination({projectId, token, directory, device: String(info.dev), inode: String(info.ino)}),
    {token, displayPath: directory});
  const first = await settle(() => service.get({projectId, ...service.start(input)}));
  assert.equal(first.status, 'done');
  const secondId = service.start({...input, requestId: 'external-2'});
  assert.equal((await settle(() => service.get({projectId, ...secondId}))).result?.bundleName, 'Export 2.fcpxmld');
  const old = directory + '.old';
  renameSync(directory, old);
  mkdirSync(directory);
  const replacement = service.start({...input, requestId: 'external-3'});
  assert.deepEqual((await settle(() => service.get({projectId, ...replacement}))).error, {code: 'NOT_WRITABLE'});
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(readdirSync(old).length, 2);
});

test('failure and cancel clean their incomplete packages and retain the original receipt', async t => {
  const f = await fixture(t, {large: true});
  let hook: () => void = () => {};
  let shortfall = 0;
  let beforeReserve: () => void = () => {};
  const service = f.core({
    assertMutationAllowed() {hook();},
    freeSpaceShortfall() {beforeReserve(); return shortfall;},
  });
  const input = {projectId: f.projectId, requestId: 'cancel-export', name: 'Partial', copyMedia: true, destination: {kind: 'project'}} as const;
  const scope = {projectId: f.projectId, ...service.start(input)};
  let cleanup: Promise<unknown> | undefined;
  hook = () => {
    if (!cleanup && existsSync(path.join(f.outputDir, 'Partial.fcpxmld', 'Media', '001_一号 #.png'))) {
      cleanup = service.cancel(scope);
    }
  };
  assert.equal((await settle(() => service.get(scope))).status, 'cancelled');
  assert.deepEqual(await cleanup, {status: 'cancelled'});
  assert.deepEqual(readdirSync(f.outputDir), []);
  assert.deepEqual(service.start(input), {exportId: scope.exportId});
  hook = () => {};
  shortfall = 123;
  const disk = service.start({...input, requestId: 'disk-full'});
  assert.deepEqual((await settle(() => service.get({projectId: f.projectId, ...disk}))).error,
    {code: 'DISK_FULL', values: {shortBytes: 123}});
  shortfall = 0;
  beforeReserve = () => {unlinkSync(f.files[0]!);};
  const badMedia = service.start({...input, requestId: 'unreadable'});
  assert.deepEqual((await settle(() => service.get({projectId: f.projectId, ...badMedia}))).error,
    {code: 'MEDIA_UNREADABLE', values: {file: '一号 #.png'}});
  assert.deepEqual(readdirSync(f.outputDir), []);
  beforeReserve = () => {throw new Error('injected write failure');};
  const generic = service.start({...input, requestId: 'failed'});
  assert.deepEqual((await settle(() => service.get({projectId: f.projectId, ...generic}))).error, {code: 'EXPORT_FAILED'});
  assert.deepEqual(await service.cancel({projectId: f.projectId, ...generic}), {status: 'failed'});
});

test('revoking a confirmed source folder during copying blocks further reads and cleans the partial package', async t => {
  const f = await fixture(t, {large: true, external: true});
  let revoked = false;
  const partial = path.join(f.outputDir, 'Revocation.fcpxmld', 'Media', '001_一号 #.png');
  const service = f.core({assertMutationAllowed() {
    if (!revoked && existsSync(partial)) {
      f.library.outsidePaths.revoke(f.projectId, path.dirname(f.files[0]!));
      revoked = true;
    }
  }});
  const {projectId} = f;
  assert.equal((await service.preview({projectId, copyMedia: true})).mediaFiles, 1);
  const id = service.start({projectId, requestId: 'revocation', name: 'Revocation', copyMedia: true, destination: {kind: 'project'}});
  const result = await settle(() => service.get({projectId, ...id}));
  assert.equal(revoked, true);
  assert.deepEqual(result.error, {code: 'MEDIA_UNREADABLE', values: {file: '一号 #.png'}});
  assert.equal(result.progress.bytes, 0);
  assert.deepEqual(readdirSync(f.outputDir), []);
});

test('a moved target never deletes a substitute and cleanup retries with the original directory', async t => {
  const f = await fixture(t, {large: true});
  const directory = path.join(f.directory, 'chosen');
  const parked = directory + '.parked';
  mkdirSync(directory);
  let moved = false;
  const service = f.core({assertMutationAllowed() {
    if (!moved && existsSync(path.join(directory, 'Moved.fcpxmld', 'Media', '001_一号 #.png'))) {
      renameSync(directory, parked);
      mkdirSync(directory);
      mkdirSync(path.join(directory, 'Moved.fcpxmld'));
      moved = true;
    }
  }});
  const {projectId} = f;
  const info = lstatSync(directory, {bigint: true});
  const {token} = service.chooseDestination({projectId, token: randomUUID(), directory, device: String(info.dev), inode: String(info.ino)});
  const id = service.start({projectId, requestId: 'move-target', name: 'Moved', copyMedia: true, destination: {kind: 'chosen', token}});
  const result = await settle(() => service.get({projectId, ...id}));
  assert.deepEqual(result.error, {code: 'NOT_WRITABLE'});
  assert.deepEqual(readdirSync(path.join(directory, 'Moved.fcpxmld')), []);
  assert.equal(existsSync(path.join(parked, 'Moved.fcpxmld')), true);
  service.recover();
  assert.equal(existsSync(path.join(parked, 'Moved.fcpxmld')), true);
  renameSync(directory, directory + '.substitute');
  renameSync(parked, directory);
  service.recover();
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(existsSync(path.join(directory + '.substitute', 'Moved.fcpxmld')), true);
});
