import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openLegacyWorkspaceStore} from '../packages/business/src/db.ts';
import {createProjectFile, openProjectStore} from '../packages/business/src/project-file/index.ts';
import {createImageStorage, type ImageStorageTask} from '../packages/business/src/image-storage.ts';
import {createFrameStorage, type FrameStorageTask} from '../packages/business/src/frame-storage.ts';
import {createSceneShotsStorage,type SceneShotsStorageTask} from '../packages/business/src/scene-shots-storage.ts';
import {createTimelineExportAdmissionServices} from '../packages/business/src/timeline-export-admission.ts';
import {renderMockImagePng, validatePng} from '../packages/business/src/images/png.ts';
import {FRAME_PROFILE_ID, FRAME_SELECTION_RULE} from '../packages/contracts/src/frame-extraction.ts';

import type {SceneShotsReceipt} from '../packages/contracts/src/scene-tasks.ts';
import {isProjectStore} from '../packages/business/src/project-file/store.ts';
import {inspectProjectOutput,markProjectOutputRegistered,setProjectOutputPublicationTestHooks} from '../packages/business/src/project-output-publication.ts';
import {projectOutputPublicationProofSchema} from '../packages/contracts/src/project-output-publication.ts';

let pngPromise: Promise<Buffer> | undefined;
const png = () => pngPromise ??= renderMockImagePng();
const check = () => {};

function fixture(t: TestContext, kernel = true) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-staging-directories-'));
  const projectDir = path.join(root, 'project');
  mkdirSync(projectDir, {mode: 0o700});
  let store, projectId: string;
  const tempDir = path.join(root, 'tmp');
  if (kernel) {
    const projectFile = path.join(projectDir, 'project.mioon');
    projectId = createProjectFile(projectFile);
    store = openProjectStore({projectFile, locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir})});
    mkdirSync(path.join(projectDir, 'media'), {mode: 0o700});store.put('projects',{id:projectId,name:'Storage publication fixture',revision:1});
  } else {
    store = openLegacyWorkspaceStore(projectDir);
    projectId = randomUUID();
  }
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  return {root, projectDir, tempDir, store, projectId, stagingRoot: kernel ? tempDir : projectDir};
}

async function stagedResults(f: ReturnType<typeof fixture>) {
  const bytes = await png();
  const image = createImageStorage(f.store, {validatePng});
  const imageTask: ImageStorageTask = {id: randomUUID(), projectId: f.projectId, groupId: randomUUID(), inputHash: 'a'.repeat(64), input: '{}', snapshot: {providerId: 'mock'}};
  const imageReceipt = await image.stage(imageTask, {bytes}, check);
  const frame = createFrameStorage(f.store, {validatePng});
  const source = {assetId: randomUUID(), sha256: 'b'.repeat(64), mimeType: 'video/mp4' as const, sizeBytes: 100, relativePath: `media/${randomUUID()}.mp4`, duration: 1, width: 1024, height: 1024};
  const frameTask: FrameStorageTask = {id: randomUUID(), projectId: f.projectId, inputHash: 'c'.repeat(64), snapshot: {source, requested: {sourceFrame: 0, fps: 30}}};
  const provenance = {profileId: FRAME_PROFILE_ID, selectionRule: FRAME_SELECTION_RULE, sourceFrame: 0, fps: 30, sourceHash: source.sha256,
    probe: {streamIndex: 0, timeBaseNumerator: 1 as const, timeBaseDenominator: 15360, width: 1024, height: 1024, rotation: 0 as const, sarNumerator: 1 as const, sarDenominator: 1 as const}};
  const frameReceipt = await frame.stage(frameTask, {bytes, provenance}, check);
  const scene = createSceneShotsStorage(f.store), sceneTaskId = randomUUID(), sceneAssetId = randomUUID();
  const sceneTask:SceneShotsStorageTask={id:sceneTaskId,projectId:f.projectId,requestId:sceneTaskId,inputHash:'d'.repeat(64),snapshot:{schemaVersion:1,projectId:f.projectId,taskId:sceneTaskId,kind:'shots',source,resultId:randomUUID(),frameCount:30,frame:{profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,fps:30},aspectRatio:'1:1',titlePrefix:'Scene',origin:{x:0,y:0},segments:[[1,0,30]]}};
  const sceneReceipt:SceneShotsReceipt={schemaVersion:1,projectId:f.projectId,taskId:sceneTaskId,inputHash:sceneTask.inputHash,sourceAssetId:source.assetId,sourceHash:source.sha256,profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,fps:30,probe:provenance.probe,keyframes:[{segment:1,sourceFrame:15,assetId:sceneAssetId,sha256:createHash('sha256').update(bytes).digest('hex'),width:1024,height:1024,byteLength:bytes.length}]};
  scene.stage(sceneTaskId,0,bytes);assert.deepEqual(scene.staged(sceneTaskId,0),bytes);scene.complete(sceneTask,sceneReceipt,check);
  const stagedPaths = [path.join(f.stagingRoot, 'image-staging', `${imageTask.id}.png`), path.join(f.stagingRoot, 'frame-staging', `${frameTask.id}.png`), path.join(f.stagingRoot, 'scene-staging', `${sceneTaskId}-0.png`)];
  const assertStaged = () => {
    for (const file of stagedPaths) assert.deepEqual(readFileSync(file), bytes);
    assert.deepEqual(image.readReceipt(imageTask), imageReceipt);
    assert.deepEqual(frame.readReceipt(frameTask), frameReceipt);
    assert.deepEqual(scene.readReceipt(sceneTask),sceneReceipt);
  };
  return {bytes, image, imageTask, imageReceipt, frame, frameTask, frameReceipt, scene, sceneTaskId, sceneAssetId, sceneTask, sceneReceipt, stagedPaths, assertStaged};
}

for (const kernel of [false, true]) test(`${kernel ? 'kernel' : 'legacy'} staging retains its owned directory and publishes only into its fixed project output directory`, async t => {
  const f = fixture(t, kernel), s = await stagedResults(f);
  if (kernel) chmodSync(f.projectDir, 0o755);
  const sentinels=isProjectStore(f.store)?[f.projectDir,f.store.localDir,f.store.cacheDir,f.tempDir].map(root=>path.join(root,'keep-unrelated.bin')):[];
  for(const file of sentinels)writeFileSync(file,'unrelated bytes',{mode:0o600});
  s.assertStaged();
  const otherRoot = kernel ? f.projectDir : f.tempDir;
  for (const family of ['image-staging', 'frame-staging', 'scene-staging']) assert.equal(existsSync(path.join(otherRoot, family)), false);
  const image = await s.image.publish(s.imageTask, s.imageReceipt, check);
  const frame = await s.frame.publish(s.frameTask, s.frameReceipt, check);
  const scene = await s.scene.publish(s.sceneTask,s.sceneReceipt,0,check);
  for (const relativePath of [image.relativePath, frame.relativePath, scene.relativePath]) {
    assert.match(relativePath,kernel?/^生成\/[^/]+\.png$/:/^media\/[a-f0-9-]+\.png$/);
    assert.deepEqual(readFileSync(path.join(f.projectDir, relativePath)), s.bytes);
    if (kernel) assert.equal(existsSync(path.join(f.tempDir, relativePath)), false);
  }
  s.assertStaged(); // Durable stages and manifests remain until a committed registration.
  assert.deepEqual(await s.image.publish(s.imageTask, s.imageReceipt, check), image);
  assert.deepEqual(await s.frame.publish(s.frameTask, s.frameReceipt, check), frame);
  assert.deepEqual(await s.scene.publish(s.sceneTask,s.sceneReceipt,0,check),scene);
  if(isProjectStore(f.store))for(const output of [image,frame,scene]){
    const proof=projectOutputPublicationProofSchema.parse('publication' in output?output.publication:null),published=await inspectProjectOutput(f.store,{owner:proof.owner,assetId:proof.assetId});assert.ok(published);
    // This storage-layer fixture records the exact asset claim; business tests
    // separately prove atomic owner/result/shot registration.
    f.store.put('assets',{id:proof.assetId,projectId:f.projectId,name:'Storage fixture.png',mimeType:'image/png',width:1024,height:1024,sha256:published.sha256,sizeBytes:published.sizeBytes,reference:published.reference,referenceRevision:published.referenceRevision,publication:published.publication,provenance:'generated'});
    await markProjectOutputRegistered(f.store,published.publication);
  }
  s.image.discardStagedPng(s.imageTask, check);
  s.frame.discardStagedPng(s.frameTask, check);
  s.scene.discard(s.sceneTaskId, 1);
  for (const file of s.stagedPaths) assert.equal(existsSync(file), false);
  assert.deepEqual(s.image.readReceipt(s.imageTask), s.imageReceipt);
  assert.deepEqual(s.frame.readReceipt(s.frameTask), s.frameReceipt);
  assert.deepEqual(s.scene.readReceipt(s.sceneTask),s.sceneReceipt);
  if(kernel)assert.deepEqual(await s.scene.artifact(s.sceneTask,s.sceneReceipt,0,check),s.bytes);
  for(const relative of [image.relativePath,frame.relativePath,scene.relativePath])assert.deepEqual(readFileSync(path.join(f.projectDir,relative)),s.bytes);
  for(const file of sentinels)assert.equal(readFileSync(file,'utf8'),'unrelated bytes');
  await s.frame.verify(s.frameTask, s.frameReceipt, check);
  await s.image.publish(s.imageTask, s.imageReceipt, check);
});

test('an incomplete scene stage never authorizes a complete manifest or publication and keeps its private bytes',async t=>{
 const f=fixture(t),s=await stagedResults(f),id=randomUUID(),task={...s.sceneTask,id,snapshot:{...s.sceneTask.snapshot,taskId:id}},receipt={...s.sceneReceipt,taskId:id};
 const partial=s.bytes.subarray(0,30);s.scene.stage(id,0,partial);
 assert.throws(()=>s.scene.complete(task,receipt,check),{code:'SCENE_STORAGE_FAILED'});assert.equal(s.scene.readReceipt(task),null);
 await assert.rejects(s.scene.publish(task,receipt,0,check),{code:'SCENE_STORAGE_FAILED'});
 assert.deepEqual(s.scene.staged(id,0),partial);assert.equal(existsSync(path.join(f.projectDir,'生成')),false);
});

test('publication collision preserves the previous file and publishes under its own new durable target',async t=>{
 const f=fixture(t),s=await stagedResults(f),other=Buffer.from('Existing different media'),occupied=new Map<string,Buffer>();assert.ok(isProjectStore(f.store));
 const restore=setProjectOutputPublicationTestHooks(f.store,{fault:(phase,proof)=>{if(phase==='after_intent'){const target=path.join(f.projectDir,proof.relativePath),bytes=proof.owner.kind==='frame'?s.bytes:other;occupied.set(target,bytes);writeFileSync(target,bytes,{mode:0o600});}}});
 t.after(restore);
 const outputs=[await s.image.publish(s.imageTask,s.imageReceipt,check),await s.frame.publish(s.frameTask,s.frameReceipt,check),await s.scene.publish(s.sceneTask,s.sceneReceipt,0,check)];
 assert.equal(occupied.size,3);for(const [file,bytes] of occupied)assert.deepEqual(readFileSync(file),bytes);
 for(const output of outputs){assert.equal(occupied.has(path.join(f.projectDir,output.relativePath)),false);assert.deepEqual(readFileSync(path.join(f.projectDir,output.relativePath)),s.bytes);}
 s.assertStaged();
});

test('legacy collision retains its existing rejection and every staged PNG',async t=>{
 const f=fixture(t,false),s=await stagedResults(f),other=Buffer.from('Existing different media');
 const paths=[s.imageReceipt.assetId,s.frameReceipt.assetId,s.sceneAssetId].map(id=>path.join(f.projectDir,'media',`${id}.png`));for(const file of paths)writeFileSync(file,other,{mode:0o600});
 await assert.rejects(s.image.publish(s.imageTask,s.imageReceipt,check),{code:'IMAGE_RESULT_INVALID'});await assert.rejects(s.frame.publish(s.frameTask,s.frameReceipt,check),{code:'FRAME_RESULT_INVALID'});
 await assert.rejects(s.scene.publish(s.sceneTask,s.sceneReceipt,0,check),{code:'SCENE_STORAGE_FAILED'});s.assertStaged();for(const file of paths)assert.deepEqual(readFileSync(file),other);
});

test('ordinary kernel media permits 0755 while private staging permissions stay enforced without losing bytes', async t => {
  const f = fixture(t), s = await stagedResults(f);
  chmodSync(path.join(f.projectDir, 'media'), 0o755);mkdirSync(path.join(f.projectDir,'生成'),{mode:0o755});
  const image = await s.image.publish(s.imageTask, s.imageReceipt, check);
  const frame = await s.frame.publish(s.frameTask, s.frameReceipt, check);
  const scene = await s.scene.publish(s.sceneTask,s.sceneReceipt,0,check);
  for (const relative of [image.relativePath, frame.relativePath, scene.relativePath]) assert.deepEqual(readFileSync(path.join(f.projectDir, relative)), s.bytes);
  assert.equal(statSync(path.join(f.projectDir, 'media')).mode & 0o777, 0o755);
  for (const family of ['image-staging', 'frame-staging', 'scene-staging']) {
    assert.equal(statSync(path.join(f.tempDir, family)).mode & 0o777, 0o700);
    chmodSync(path.join(f.tempDir, family), 0o755);
  }
  const error = {code: 'STORAGE_PRIVATE_REQUIRED', reason: 'DIRECTORY_PERMISSIONS'};
  assert.throws(() => s.image.readReceipt(s.imageTask), error);
  assert.throws(() => s.frame.readReceipt(s.frameTask), error);
  assert.throws(() => s.scene.stage(s.sceneTaskId, 1, s.bytes), error);assert.throws(()=>s.scene.readReceipt(s.sceneTask),error);
  for (const family of ['image-staging', 'frame-staging', 'scene-staging']) chmodSync(path.join(f.tempDir, family), 0o700);
  s.assertStaged();
  for (const relative of [image.relativePath, frame.relativePath, scene.relativePath]) assert.deepEqual(readFileSync(path.join(f.projectDir, relative)), s.bytes);
});

test('copied kernel fields cannot redirect staging outside the legacy root', async t => {
  const f = fixture(t), bytes = await png(), copied = {...f.store};
  const image = createImageStorage(copied, {validatePng});
  const task: ImageStorageTask = {id: randomUUID(), projectId: f.projectId, groupId: randomUUID(), inputHash: 'a'.repeat(64), input: '{}', snapshot: {providerId: 'mock'}};
  await image.stage(task, {bytes}, check);
  const scene = createSceneShotsStorage(copied), taskId = randomUUID();
  scene.stage(taskId, 0, bytes);
  assert.deepEqual(readFileSync(path.join(f.projectDir, 'image-staging', `${task.id}.png`)), bytes);
  assert.deepEqual(readFileSync(path.join(f.projectDir, 'scene-staging', `${taskId}-0.png`)), bytes);
  assert.equal(existsSync(path.join(f.tempDir, 'image-staging')), false);
  assert.equal(existsSync(path.join(f.tempDir, 'scene-staging')), false);
});

test('export capability inspection receives kernel tempDir and retains legacy and absent-root defaults', async t => {
  const kernel = fixture(t), legacy = fixture(t, false), observed: (string | undefined)[] = [];
  for (const store of [kernel.store, legacy.store, {db: legacy.store.db}]) {
    const service = createTimelineExportAdmissionServices(store, {inspect: async (_delivery, {capabilityWorkRoot}) => {
      observed.push(capabilityWorkRoot); return {status: 'available', code: 'EXPORT_CAPABILITY_AVAILABLE'};
    }});
    try { assert.deepEqual(await service.inspect({}), {status: 'available', code: 'EXPORT_CAPABILITY_AVAILABLE'}); }
    finally { await service.drain(); }
  }
  const forged = createTimelineExportAdmissionServices({...kernel.store}, {inspect: async () => { throw Error('An unverified kernel wrapper must never inspect'); }});
  try { await assert.rejects(forged.inspect({}), {code: 'RESTORE_STORE_UNVERIFIED'}); }
  finally { await forged.drain(); }
  assert.deepEqual(observed, [kernel.tempDir, legacy.projectDir, undefined]);
});
