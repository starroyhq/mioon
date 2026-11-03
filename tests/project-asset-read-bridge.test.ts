import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {deflateSync} from 'node:zlib';
import {setTimeout as pause} from 'node:timers/promises';
import {createAssetMediaServices} from '../packages/business/src/asset-media-services.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import {isTimelineRecord} from '../packages/contracts/src/timeline-replacement.ts';
import {isTimelineRenderRecord} from '../packages/contracts/src/timeline-acknowledgement.ts';
import {createFrameServices} from '../packages/business/src/frames.ts';
import {createFrameOwnershipReader} from '../packages/business/src/frame-ownership.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {validatePng} from '../packages/business/src/images/png.ts';
import {FRAME_PROFILE_ID, FRAME_SELECTION_RULE, frameTaskResponseSchema} from '../packages/contracts/src/frame-extraction.ts';
import path from 'node:path';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {referenceForFile, computeFullSha256} from '../packages/business/src/media-reference/index.ts';
import {registerProjectMediaStore, registeredProjectAssetReferences, validatedProjectAssetSource, prepareProjectAssetFullHash, referenceForPublishedMedia} from '../packages/business/src/project-media-storage.ts';
import {validateManagedSource, verifiedManagedHash} from '../packages/business/src/managed-media.ts';
import {readProviderReferenceBytes} from '../packages/business/src/providers/live-common.ts';
import {publishOutputFixture,markProjectOutputRegistered} from './helpers/project-output-fixture.ts';
import {exportOutputArtifactIdentity} from '../packages/contracts/src/output-artifact.ts';
import {isProjectExportObservation} from '../packages/business/src/project-export-observation.ts';

function timelineRecord(value:unknown){assert.ok(isTimelineRecord(value));return value;}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: TestContext, outside = false, video = false) {
 const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-reference-read-'));
 const projectDir = path.join(root, 'project'), directory = path.join(root, 'external');
 mkdirSync(projectDir, {mode: 0o755}); mkdirSync(directory, {mode: 0o755});
 const store = openStore(projectDir), app = openAppLibrary({dataDir: path.join(root, 'app')});
 store.put('projects', {id: store.projectId, name: 'Reference reader'});
 const file = path.join(outside ? directory : projectDir, video ? 'movie.mp4' : 'source.png');
 const bytes = randomBytes(2 * 1024 * 1024);
 (video ? Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]) : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])).copy(bytes);
 writeFileSync(file, bytes, {mode: 0o644});
 const access = {projectDir, projectFile: store.projectFile, mayReadOutside: () => true};
 let reference = (await referenceForFile(access, file)).reference;
 if (!video) reference = (await computeFullSha256(access, reference)).reference;
 const asset = {id: randomUUID(), projectId: store.projectId, name: path.basename(file), mimeType: video ? 'video/mp4' : 'image/png', sizeBytes: bytes.length, sha256: reference.fullSha256, reference, referenceRevision: 1, provenance: 'user-import'};
 store.put('assets', asset);
 const release = registerProjectMediaStore(store, {outsidePaths: app.outsidePaths});
 t.after(() => {release(); store.close(); app.close(); rmSync(root, {recursive: true, force: true});});
 const confirm = (): void => app.outsidePaths.confirm({projectId: store.projectId, directory, confirmedAt: '2026-11-03T00:00:00.000Z'});
 return {root, projectDir, directory, store, app, file, bytes, asset, confirm};
}

test('ordinary project files and exact confirmed external files use one reference capability', async t => {
 const f = await fixture(t, true);
 assert.throws(() => validatedProjectAssetSource(f.projectDir, f.asset), {code: 'MEDIA_OUTSIDE_NOT_CONFIRMED'});
 f.confirm();
 assert.equal(validateManagedSource(f.projectDir, f.asset).file, f.file);
 const read = await readProviderReferenceBytes(f.projectDir, f.asset, f.bytes.length);
 assert.deepEqual(read, f.bytes);
 const hash = await verifiedManagedHash(f.projectDir, f.asset);
 assert.equal(hash.sha256, digest(f.bytes));
 f.app.outsidePaths.revoke(f.store.projectId, f.directory);
 await assert.rejects(verifiedManagedHash(f.projectDir, f.asset), {code: 'MEDIA_OUTSIDE_NOT_CONFIRMED'});
});

test('a project reader rejects a legacy locator, forged reference and changed row revision', async t => {
 const f = await fixture(t);
 assert.throws(() => validateManagedSource(f.projectDir, {...f.asset, reference: undefined, relativePath: 'media/source.png'}), {code: 'MEDIA_CHANGED'});
 assert.throws(() => validateManagedSource(f.projectDir, {...f.asset, reference: {...f.asset.reference, path: '../external/source.png'}}), {code: 'MEDIA_CHANGED'});
 f.store.put('assets', {...f.asset, referenceRevision: 2});
 await assert.rejects(verifiedManagedHash(f.projectDir, f.asset), {code: 'MEDIA_CHANGED'});
});

test('revocation and asset revision changes interrupt chunked reference reads', async t => {
 const f = await fixture(t, true); f.confirm();
 const refs = registeredProjectAssetReferences(f.projectDir)!;
 let revoked = false;
 await assert.rejects(refs.read(f.asset.id, {maxBytes: f.bytes.length, onBytes() {
  if (!revoked) {revoked = true; f.app.outsidePaths.revoke(f.store.projectId, f.directory);}
 }}), {code: 'MEDIA_OUTSIDE_NOT_CONFIRMED'});
 f.confirm(); let changed = false;
 await assert.rejects(refs.read(f.asset.id, {maxBytes: f.bytes.length, onBytes() {
  if (!changed) {changed = true; f.store.put('assets', {...f.asset, referenceRevision: 2});}
 }}), {code: 'MEDIA_CHANGED_DURING_READ'});
});

test('sampled videos compute read-only hashes, then strong preparation CAS stores the full hash', async t => {
 const f = await fixture(t, false, true);
 assert.equal(f.asset.sha256, null);
 assert.equal((await verifiedManagedHash(f.projectDir, f.asset)).sha256, digest(f.bytes));
 assert.equal((f.store.get('assets', f.asset.id) as typeof f.asset).sha256, null);
 const prepared = await prepareProjectAssetFullHash(f.projectDir, f.asset.id);
 assert.equal(prepared.sha256, digest(f.bytes));
 assert.equal(prepared.referenceRevision, 1);
 assert.equal((f.store.get('assets', f.asset.id) as typeof f.asset).sha256, digest(f.bytes));
 assert.throws(() => f.store.tx(() => prepareProjectAssetFullHash(f.projectDir, f.asset.id)), TypeError);
});

test('published file registration returns one reference and verifies the supplied complete hash', async t => {
 const f = await fixture(t);
 const result = await referenceForPublishedMedia(f.store, f.file, {sha256: digest(f.bytes)});
 assert.equal(result.reference.path, 'source.png');
 assert.equal(result.referenceRevision, 1);
 assert.equal(result.sizeBytes, f.bytes.length);
 assert.equal(result.sha256, digest(f.bytes));
 assert.equal(Object.hasOwn(result, 'relativePath'), false);
 await assert.rejects(referenceForPublishedMedia(f.store, f.file, {sha256: 'f'.repeat(64)}), {code: 'MEDIA_CHANGED'});
});


function framePng(): Buffer {
 const chunk=(name: string,data: Buffer): Buffer=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(name,4);data.copy(out,8);let crc=0xffffffff;for(const byte of out.subarray(4,-4)){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(4);header.writeUInt32BE(2,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(26))),chunk('IEND',Buffer.alloc(0))]);
}
for(const staged of [false,true])test(`same-content real relink preserves ${staged?'retained receipt but fences recovery':'finished frame history and original ACK'}`,async t=>{
 const f=await fixture(t,false,true),bytes=framePng(),sourceHash=digest(f.bytes);
 f.store.put('assets',{...f.asset,width:4,height:2,duration:1,hasVideo:true,hasAudio:false});
 const frames=createFrameServices(f.store,{autoRun:true,fault:stage=>{if(staged&&stage==='after_result_receipt')throw Error('Retain the complete local result');},decode:async input=>{
  assert.ok(input?.signal);assert.equal(typeof input.beforeSpawn,'function');input.beforeSpawn!(input.signal);
  return {bytes,metadata:await validatePng(bytes,{width:4,height:2}),provenance:{profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,sourceFrame:0,fps:30,sourceHash,
   probe:{streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:4,height:2,rotation:0,sarNumerator:1,sarDenominator:1}}};
 }});
 try{
  const input={projectId:f.store.projectId,sourceAssetId:f.asset.id,sourceHash,sourceFrame:0,requestId:randomUUID()};
  const ack=frameTaskResponseSchema.parse(await frames.handlers['frame.extract']!(input));
  const wanted=staged?'local_result_error':'succeeded',deadline=Date.now()+10000;
  let value=frameTaskResponseSchema.parse(await frames.handlers['frame.task.get']!({projectId:f.store.projectId,taskId:ack.id}));
  while(value.state!==wanted&&Date.now()<deadline){await pause(5);value=frameTaskResponseSchema.parse(await frames.handlers['frame.task.get']!({projectId:f.store.projectId,taskId:ack.id}));}
  assert.equal(value.state,wanted);
  const immutable=()=>f.store.db.prepare('SELECT inputHash,input,snapshot,stagedReceipt FROM frame_tasks WHERE id=?').get(ack.id);
  const original=immutable(),receipt=f.store.db.prepare('SELECT response FROM frame_requests WHERE requestId=?').get(input.requestId);
  const relocated=path.join(f.projectDir,'relocated.mp4');writeFileSync(relocated,f.bytes,{mode:0o644});
  const media=createAssetMediaServices(f.store,{outsidePaths:f.app.outsidePaths});
  const preview:unknown=await media.call('asset.media.relink.preview',{projectId:f.store.projectId,assetId:f.asset.id,sourcePath:relocated,expectedReferenceRevision:1});
  assert.ok(preview&&typeof preview==='object'&&'previewToken' in preview&&typeof preview.previewToken==='string');
  await media.call('asset.media.relink.apply',{projectId:f.store.projectId,previewToken:preview.previewToken,requestId:randomUUID()});
  const relocatedAsset=f.store.get('assets',f.asset.id) as Record<string,unknown>;
  assert.equal(relocatedAsset.referenceRevision,2);assert.equal(relocatedAsset.sha256,sourceHash);
  assert.deepEqual(createFrameOwnershipReader(f.store.db,f.store.projectId).task(ack.id).dto,value);
  assert.deepEqual(await frames.handlers['frame.extract']!(input),ack);
  assert.deepEqual(immutable(),original);assert.deepEqual(f.store.db.prepare('SELECT response FROM frame_requests WHERE requestId=?').get(input.requestId),receipt);
  if(staged){
   await assert.rejects(Promise.resolve().then(()=>frames.handlers['frame.task.recoverResult']!({projectId:f.store.projectId,taskId:ack.id,expectedRevision:value.revision,requestId:randomUUID()})),{code:'FRAME_SOURCE_CHANGED'});
  }else{
   assert.ok(value.result);assert.equal(createOwnedMediaGraphReader(f.store.db,f.store.projectId).asset(value.result.assetId).id,value.result.assetId);
   const changedHash='f'.repeat(64);f.store.put('assets',{...relocatedAsset,sha256:changedHash,reference:{...(relocatedAsset.reference as object),fullSha256:changedHash}});
   assert.throws(()=>createFrameOwnershipReader(f.store.db,f.store.projectId).task(ack.id),{code:'INSPECTION_UNAVAILABLE'});
   f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...relocatedAsset,projectId:randomUUID()}),f.asset.id);
   assert.throws(()=>createFrameOwnershipReader(f.store.db,f.store.projectId).task(ack.id),{code:'INSPECTION_UNAVAILABLE'});
   f.store.put('assets',relocatedAsset);
  }
 }finally{await frames.drain();}
});


test('sampled videos can be edited through business timeline entries before render freezes a complete hash',async t=>{
 const f=await fixture(t,false,true),services=createServices(f.store,new Map(),{application:createProjectServiceApplication(f.app)});
 try{
  f.store.put('assets',{...f.asset,width:4,height:2,duration:1,hasVideo:true,hasAudio:false});
  let timeline=timelineRecord(await services.call('timeline.get',{projectId:f.store.projectId}));
  timeline=timelineRecord(await services.call('timeline.clip.add',{projectId:f.store.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),
   trackId:timeline.tracks.find(track=>track.kind==='video')!.id,assetId:f.asset.id,startFrame:0,durationFrames:30}));
  assert.equal((f.store.get('assets',f.asset.id) as Record<string,unknown>).sha256,null);
  const secondFile=path.join(f.projectDir,'replacement.mp4');writeFileSync(secondFile,f.bytes);
  const reference=(await referenceForFile({projectDir:f.projectDir,projectFile:f.store.projectFile,mayReadOutside:()=>false},secondFile)).reference;
  const second=f.store.put('assets',{...f.asset,id:randomUUID(),name:'Replacement.mp4',reference,width:4,height:2,duration:1,hasVideo:true,hasAudio:false});
  const replaced=await services.call('timeline.clip.replaceSource',{projectId:f.store.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),clipId:timeline.clips[0]!.id,assetId:second.id});
  timeline=timelineRecord(replaced);
  assert.equal((f.store.get('assets',second.id) as Record<string,unknown>).sha256,null);
  const input={projectId:f.store.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'preview'};
  const ack=await services.call('timeline.render',input);assert.ok(isTimelineRenderRecord(ack,input));
  const prepared=f.store.get('assets',second.id) as Record<string,unknown>;
  assert.equal(prepared.sha256,digest(f.bytes));assert.equal(prepared.referenceRevision,1);
  unlinkSync(secondFile);assert.deepEqual(await services.call('timeline.render',input),ack);
 }finally{await services.drain();}
});

test('published export observation uses its strict proof and conservatively excludes relinked outputs',async t=>{
 const f=await fixture(t,false,true),services=createServices(f.store,new Map(),{application:createProjectServiceApplication(f.app)});
 try{
  f.store.put('assets',{...f.asset,width:4,height:2,duration:1,hasVideo:true,hasAudio:false});
  let timeline=timelineRecord(await services.call('timeline.get',{projectId:f.store.projectId}));
  timeline=timelineRecord(await services.call('timeline.clip.add',{projectId:f.store.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),trackId:timeline.tracks.find(track=>track.kind==='video')!.id,assetId:f.asset.id,startFrame:0,durationFrames:30}));
  const ack=await services.call('timeline.render',{projectId:f.store.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export'});
  assert.ok(ack&&typeof ack==='object'&&'id' in ack&&typeof ack.id==='string');const exportId=ack.id,id=randomUUID(),accepted=f.store.get('exports',exportId) as Record<string,unknown>;
  const publication=await publishOutputFixture(f.store,{assetId:id,owner:{kind:'export',id:exportId,requestId:String(accepted.requestId),inputHash:createHash('sha256').update(exportOutputArtifactIdentity(accepted)).digest('hex')},targetKind:'exports',bytes:f.bytes,mimeType:'video/mp4'});
  const output={id,projectId:f.store.projectId,name:'Published.mp4',mimeType:'video/mp4',provenance:'export',producer:{kind:'export',id:exportId},url:`/media/${id}`,width:4,height:2,duration:1,...publication};
  const published={...accepted,status:'succeeded',assetId:id,url:`/media/${id}`,updatedAt:new Date().toISOString()};f.store.tx(()=>{f.store.put('assets',output);f.store.put('exports',published);});
  await markProjectOutputRegistered(f.store,publication.publication);
  const observe=()=>createOwnedMediaGraphReader(f.store.db,f.store.projectId).asset(id);
  const valid=()=>isProjectExportObservation(f.store.db,f.store.projectId,exportId,observe());
  const observed=observe();assert.equal(observed.relativePath,undefined);assert.equal(Object.hasOwn(observed,'relativePath'),false);assert.equal(Object.hasOwn({...observed},'relativePath'),false);assert.doesNotMatch(JSON.stringify({...observed,publication:undefined}),/"relativePath"/u);assert.deepEqual(observed.publication,publication.publication);
  assert.equal(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(observed),'relativePath'),undefined);assert.equal(valid(),true);assert.match(output.reference.path,/^导出\//u);
  assert.equal((await verifiedManagedHash(f.projectDir,observed)).sha256,digest(f.bytes));
  for(const producer of [undefined,{kind:'generation',id:exportId},{kind:'export',id:randomUUID()}]){
   f.store.put('assets',{...output,producer});assert.equal(valid(),false);
  }
  f.store.put('assets',{...output,reference:{...output.reference,path:`导出/${randomUUID()}.mp4`}});assert.equal(valid(),false);
  f.store.put('assets',output);
  f.store.db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify({...published,projectId:randomUUID()}),exportId);assert.equal(valid(),false);f.store.put('exports',published);
  const external=path.join(f.directory,'relocated-output.mp4');writeFileSync(external,f.bytes);f.confirm();
  const media=createAssetMediaServices(f.store,{outsidePaths:f.app.outsidePaths}),preview=await media.call('asset.media.relink.preview',{projectId:f.store.projectId,assetId:id,sourcePath:external,expectedReferenceRevision:1});
  assert.ok(preview&&typeof preview==='object'&&'previewToken' in preview&&typeof preview.previewToken==='string');await media.call('asset.media.relink.apply',{projectId:f.store.projectId,previewToken:preview.previewToken,requestId:randomUUID()});
  const relocated=observe();assert.equal(relocated.relativePath,undefined);assert.equal(valid(),false);assert.equal(Object.hasOwn(f.store.get('assets',id)!,'relativePath'),false);
  const status=await registeredProjectAssetReferences(f.projectDir)!.inspect(id);assert.equal(status.status,'online');assert.equal(status.readable,true);assert.equal((await verifiedManagedHash(f.projectDir,relocated)).sha256,digest(f.bytes));
  unlinkSync(external);await assert.rejects(verifiedManagedHash(f.projectDir,relocated),{code:'MEDIA_MISSING'});
 }finally{await services.drain();}
});
