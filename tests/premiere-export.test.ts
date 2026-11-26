import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {createProjectAssetReferenceServices} from '../packages/business/src/project-asset-references.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createPremiereExportServices} from '../packages/business/src/premiere-export.ts';
import {createProjectBackgroundState} from '../packages/business/src/background-task-state.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {
  premiereExportGetOutputSchema, premiereExportPreviewOutputSchema, premiereExportStartOutputSchema,
} from '../packages/contracts/src/premiere-export.ts';
import type {PremiereExportGetOutput, PremiereExportStartInput} from '../packages/contracts/src/premiere-export.ts';
import {premiereExportTaskSchema} from '../packages/contracts/src/project-registry.ts';
import {TIMELINE_SUBTITLE_PROFILE_ID} from '../packages/contracts/src/timeline-subtitle-profile.ts';
import {createEditUiWireFixture, WIRE_IDS} from './helpers/edit-ui-wire-fixture.ts';

async function fixture(t: test.TestContext, mediaSize: number) {
  const f = await createEditUiWireFixture({width: 1080, height: 1920});
  const application = createProjectServiceApplication(f.library, undefined, {});
  const cores: ReturnType<typeof createPremiereExportServices>[] = [];
  t.after(async () => {
    try {
      await Promise.all([f.services.drain(), ...cores.map(core => core.drain())]);
    } finally {
      f.store.close();
      f.library.close();
      rmSync(f.root, {recursive: true, force: true});
    }
  });
  const bytes = Buffer.alloc(mediaSize, 5);
  bytes.writeUInt32BE(24);
  bytes.write('ftypisom', 4, 'ascii');
  const mediaDir = path.join(f.root, 'media');
  mkdirSync(mediaDir);
  const references = createProjectAssetReferenceServices(f.store, application);
  const newAssets = [[randomUUID(), '一号 #.mp4'], [randomUUID(), '同内容.mp4']] as const;
  for (const [id, name] of newAssets) {
    writeFileSync(path.join(mediaDir, name), bytes);
    const {reference} = await references.referenceForImport(path.join(mediaDir, name));
    f.store.put('assets', {id, projectId: f.projectId, name, mimeType: 'video/mp4', duration: 2, hasAudio: true,
      reference, referenceRevision: 1,
      sha256: reference.fullSha256, sizeBytes: reference.sizeBytes});
  }
  const timeline = readFormat5TimelineRecord(f.store.db, 'project');
  assert.ok(timeline);
  const overlays = newAssets.map(([assetId], index) => {
    const startFrame = 5 + index * 12;
    return {
      id: randomUUID(), trackId: WIRE_IDS.video2, name: '叠加镜头 ' + (index + 1), startFrame, durationFrames: 12,
      sourceInFrame: 15, rect: {x: 0, y: 0, width: 1080, height: 1920}, gain: 1, assetId,
      sourceState: 'ready', anchor: {clipId: WIRE_IDS.clipA, offsetFrames: startFrame},
    };
  });
  f.store.put('timelines', {...timeline, clips: [...timeline.clips, ...overlays], subtitles: {profileId: TIMELINE_SUBTITLE_PROFILE_ID, cues: [{
    id: randomUUID(), text: '只写进清单的字幕', startFrame: 4, durationFrames: 15,
    anchor: {clipId: WIRE_IDS.clipA, offsetFrames: 4},
  }]}});
  return {...f, bytes, outputDir: path.join(f.root, '导出'), core(options: Partial<Parameters<typeof createPremiereExportServices>[1]>) {
    const core = createPremiereExportServices(f.store, {...application, ...options});
    cores.push(core);
    return core;
  }};
}

async function terminal(get: () => PremiereExportGetOutput | Promise<PremiereExportGetOutput>) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const task = await get();
    if (task.status !== 'running') return task;
    await delay(10);
  }
  assert.fail('Premiere export did not finish');
}

test('Premiere project RPC writes an xmeml package and isolates both editor export kinds', async t => {
  const {services, projectId, outputDir, bytes} = await fixture(t, 8192);
  const previewInput = {projectId, copyMedia: true};
  const preview = premiereExportPreviewOutputSchema.parse(await services.call('export.premiere.preview', previewInput));
  assert.deepEqual(preview.timeline, {width: 1080, height: 1920, fps: 30, durationFrames: 150, clipCount: 6});
  assert.equal(preview.projectDestination.displayPath, outputDir);
  assert.equal(preview.mediaFiles, 1);
  assert.equal(preview.mediaBytes, bytes.length);
  assert.deepEqual(preview.missing.map(item => item.code).sort(), ['MEDIA_MISSING', 'PLACEHOLDER', 'SUBTITLES']);
  assert.deepEqual(preview.approximations.flatMap(item => item.clips.map(clip => clip.name)), ['叠加镜头 1', '叠加镜头 2']);
  assert.equal(existsSync(outputDir), false);

  const first = {projectId, requestId: 'same-request', name: '试剪 #.xml', copyMedia: true, destination: {kind: 'project'}} as const;
  const start = async (input: PremiereExportStartInput) =>
    premiereExportStartOutputSchema.parse(await services.call('export.premiere.start', input));
  const key = await start(first);
  assert.deepEqual(await start(first), key);
  await assert.rejects(services.call('export.premiere.start', {...first, copyMedia: false}), {code: 'IDEMPOTENCY_CONFLICT'});
  const identity = {projectId, ...key};
  const get = async (id: typeof identity) => premiereExportGetOutputSchema.parse(await services.call('export.premiere.get', id));
  const done = await terminal(() => get(identity));
  assert.equal(done.status, 'done');
  assert.equal(done.result?.bundleName, '试剪 # Premiere');
  assert.deepEqual(done.progress, {files: 1, totalFiles: 1, bytes: bytes.length, totalBytes: bytes.length});
  const bundle = path.join(outputDir, done.result!.bundleName);
  const xmlFile = path.join(bundle, '试剪 #.xml');
  const mediaName = '001_一号 #.mp4';
  const mediaFile = path.join(bundle, 'Media', mediaName);
  assert.deepEqual(readdirSync(path.join(bundle, 'Media')), [mediaName]);
  assert.deepEqual(readFileSync(mediaFile), bytes);
  const xml = readFileSync(xmlFile, 'utf8');
  assert.match(xml, /<xmeml version="5">/u);
  assert.ok(xml.includes(pathToFileURL(mediaFile).href));
  assert.doesNotMatch(xml, /只写进清单的字幕|占位镜头 B/u);
  const manifest = JSON.parse(readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  assert.equal(manifest.xmemlVersion, '5');
  assert.deepEqual(manifest.missing, preview.missing);
  assert.deepEqual(manifest.approximations, preview.approximations);
  assert.deepEqual(manifest.media, [{file: 'Media/' + mediaName, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length}]);
  assert.match(readFileSync(path.join(bundle, 'missing.md'), 'utf8'), /Premiere Pro[\s\S]+只写进清单的字幕/u);
  assert.equal(services.premiereExport.completedBundle(identity)?.path, bundle);
  assert.equal(services.premiereExport.completedXml(identity)?.path, xmlFile);
  assert.deepEqual(await services.call('export.premiere.cancel', identity), {status: 'done'});
  const task = premiereExportTaskSchema.parse(await services.call('export.get', key));
  assert.equal(task.kind, 'premiere-export');
  const project = await services.call('project.get', {projectId}) as {exports: unknown[]};
  assert.deepEqual(project.exports, [task]);
  await assert.rejects(services.call('export.activity.get', identity), {code: 'NOT_FOUND'});
  await assert.rejects(services.call('export.fcpxml.get', identity), {code: 'NOT_FOUND'});

  const secondId = await start({...first, requestId: 'second'});
  const second = await terminal(() => get({projectId, ...secondId}));
  assert.equal(second.result?.bundleName, '试剪 # Premiere 2');
  assert.equal(readFileSync(xmlFile, 'utf8'), xml);
  const secondXml = path.join(outputDir, second.result!.bundleName, '试剪 #.xml');
  assert.ok(readFileSync(secondXml, 'utf8').includes(pathToFileURL(path.join(path.dirname(secondXml), 'Media', mediaName)).href));
  const fcpId = premiereExportStartOutputSchema.parse(await services.call('export.fcpxml.start', first));
  assert.notEqual(fcpId.exportId, key.exportId);
  await assert.rejects(services.call('export.premiere.get', {projectId, ...fcpId}), {code: 'NOT_FOUND'});
  assert.equal((await terminal(() => services.fcpExport.get({projectId, ...fcpId}))).status, 'done');
  const parked = xmlFile + '.old';
  renameSync(xmlFile, parked);
  symlinkSync(parked, xmlFile);
  assert.equal(services.premiereExport.completedXml(identity), null);
  assert.equal(services.premiereExport.completedBundle(identity), null);
});

test('Premiere uses a target-bound directory token and cancels a real partial copy', async t => {
  const f = await fixture(t, 3 * 1024 * 1024);
  const {projectId, outputDir} = f;
  const chosen = path.join(f.root, 'outside');
  mkdirSync(chosen);
  const directory = lstatSync(chosen, {bigint: true});
  const token = randomUUID();
  const choice = {projectId, token, directory: chosen, device: String(directory.dev), inode: String(directory.ino)};
  let checkpoint = () => {};
  const core = f.core({assertMutationAllowed() {checkpoint();}});
  f.services.fcpExport.chooseDestination(choice);
  const input = {projectId, requestId: 'cancel-me', name: '试剪', copyMedia: true, destination: {kind: 'chosen', token}} as const;
  assert.throws(() => core.start(input), {code: 'NOT_WRITABLE'});
  assert.deepEqual(core.chooseDestination(choice), {token, displayPath: chosen});
  const state = createProjectBackgroundState(f.store);
  const identity = {projectId, ...core.start(input)};
  assert.ok(state.snapshot().some(ref => ref.taskId === identity.exportId && ref.keepAlive));
  let cancel: ReturnType<typeof core.cancel> | undefined;
  const partialFile = path.join(chosen, '试剪 Premiere', 'Media', '001_一号 #.mp4');
  checkpoint = () => {
    if (!cancel && (statSync(partialFile, {throwIfNoEntry: false})?.size ?? 0) > 0) cancel = core.cancel(identity);
  };
  assert.equal((await terminal(() => core.get(identity))).status, 'cancelled');
  assert.deepEqual(await cancel, {status: 'cancelled'});
  assert.deepEqual(readdirSync(chosen), []);
  assert.equal(existsSync(outputDir), false);
  assert.deepEqual(core.start(input), {exportId: identity.exportId});
});
