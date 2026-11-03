import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore,openServerTestStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {createProjectAssetReferenceServices} from '../packages/business/src/project-asset-references.ts';
import {validateImageConsumption} from '../packages/business/src/image-consumption.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS} from '../packages/contracts/src/images.ts';
import {mp4HeaderFixture,mediaFixturePath} from './helpers/media-reference-fixtures.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const record=(value:unknown):Record<string,unknown>=>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;};
const hash=(bytes:Buffer):string=>createHash('sha256').update(bytes).digest('hex');
async function until(read:()=>unknown|Promise<unknown>,label:string):Promise<Record<string,unknown>>{
 for(let attempt=0;attempt<2000;attempt++){
  const value=record(await read());if(value.state==='succeeded')return value;
  if(['failed','local_result_error','outcome_unknown'].includes(String(value.state)))assert.fail(`${label}: ${JSON.stringify(value)}`);
  await pause(5);
 }
 assert.fail(`Timed out: ${label}`);
}

/** Compare all portable media names, bytes and file identities, excluding held
 * SQLite files and local companions. Version writes may change those databases. */
function mediaTree(store:ReturnType<typeof openStore>,external?:string):unknown{
 const visit=(directory:string):unknown[]=>readdirSync(directory).sort().map(name=>{
  const file=path.join(directory,name),info=lstatSync(file,{bigint:true});
  assert.equal(info.isSymbolicLink(),false);
  return info.isDirectory()?{name,directory:visit(file)}:{name,sha256:hash(readFileSync(file)),size:String(info.size),dev:String(info.dev),ino:String(info.ino),mtime:String(info.mtimeNs),ctime:String(info.ctimeNs)};
 });
 const project=readdirSync(store.projectDir).sort().filter(name=>name!=='.mioon-store'&&name!==path.basename(store.projectFile)&&!name.startsWith(path.basename(store.projectFile)+'-')).map(name=>{
  const file=path.join(store.projectDir,name);return {name,entries:lstatSync(file).isDirectory()?visit(file):hash(readFileSync(file))};
 });
 return {project,...(external?{external:visit(external)}:{})};
}

async function fixture(t:TestContext){
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-output-version-'))),original=openStore(path.join(root,'original')),projectId=original.projectId;
 original.put('projects',{id:projectId,name:'Real S2 outputs',description:'Saved project content',revision:1});
 const sourceId=randomUUID(),sourceBytes=mp4HeaderFixture('explicitly stubbed frame and scene decoder source'),sourceHash=hash(sourceBytes),sourcePath=`media/${sourceId}.mp4`;
 writeFileSync(path.join(original.projectDir,sourcePath),sourceBytes,{mode:0o600});
 original.put('assets',{id:sourceId,projectId,name:'Source.mp4',mimeType:'video/mp4',sha256:sourceHash,sizeBytes:sourceBytes.length,relativePath:sourcePath,width:16,height:16,duration:3,provenance:'user-import'});
 const decoded=png({width:16,height:16,rgba:false,tagged:false}),probe={streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:16,height:16,rotation:0,sarNumerator:1,sarDenominator:1};
 const producer=createServices(original,new Map(),{env:{},imageOptions:{autoRun:true},
  frameOptions:{decode:async input=>{input!.beforeSpawn!(input!.signal!);return {bytes:decoded,metadata:{mimeType:'image/png',width:16,height:16,byteLength:decoded.length,sha256:hash(decoded)},provenance:{profileId:'local-png-1024-v1',selectionRule:'first-pts-at-or-after-v1',sourceFrame:Number(input!.requestedFrame),fps:30,sourceHash,probe}};}},
  sceneOptions:{detect:async input=>{input.beforeSpawn!(input.signal!);return {profileId:'scene-cuts-v1',fps:30,frameCount:90,options:{mode:'adaptive',sensitivity:60,minShotSeconds:0.6},cuts:[{frame:30,score:0.8}],segments:[],sourceHash,analysis:{width:256,height:144,decodedFrames:90}};},
   decodeKeyframes:async input=>{input.beforeSpawn!(input.signal!);input.marks!.forEach((_,index)=>input.onFrame!({index,marks:[index],bytes:decoded}));return {profileId:'local-png-1024-v1',selectionRule:'first-pts-at-or-after-v1',sourceHash,width:16,height:16,probe,frameOf:input.marks!.map((_,index)=>index)};}}});
 let originalClosed=false,store:ReturnType<typeof openStore>|undefined,services:ReturnType<typeof createServices>|undefined;
 t.after(async()=>{try{if(!originalClosed){await producer.drain();original.close();}if(services)await services.drain();store?.close();}finally{rmSync(root,{recursive:true,force:true});}});
 // The image uses the actual mock adapter/PNG encoder. Frame/scene decoders
 // are explicit stand-ins; task admission, publication and registration are real.
 const imageAck=record(await producer.call('image.generate',{projectId,name:'Saved generated image',prompt:'A local generated reference',providerId:'mock',model:IMAGE_MODELS.mock,options:IMAGE_FIXED_OPTIONS,requestId:randomUUID()}));
 const image=await until(()=>producer.call('image.task.get',{projectId,taskId:imageAck.id}),'image generation');
 const imageVersion=original.db.prepare('SELECT assetId FROM image_versions WHERE id=?').get(String(image.versionId));assert.ok(imageVersion);
 const frameAck=record(await producer.call('frame.extract',{projectId,sourceAssetId:sourceId,sourceHash,sourceFrame:7,requestId:randomUUID()}));
 const frame=await until(()=>producer.call('frame.task.get',{projectId,taskId:frameAck.id}),'frame extraction');
 const detectedAck=record(await producer.call('scene.detect',{projectId,sourceAssetId:sourceId,sourceHash,requestId:randomUUID()}));
 const detected=await until(()=>producer.call('scene.task.get',{projectId,taskId:detectedAck.id}),'scene detection');
 const sceneAck=record(await producer.call('scene.shots.create',{projectId,sourceAssetId:sourceId,sourceHash,resultId:record(detected.result).id,segments:[2],requestId:randomUUID()}));
 const scene=await until(()=>producer.call('scene.task.get',{projectId,taskId:sceneAck.id}),'scene keyframe publication'),built=record((scene.shots as unknown[])[0]);
 const ids={image:String(imageVersion.assetId),frame:String(record(frame.result).assetId),scene:String(built.assetId)},sceneShotId=String(built.shotId);
 await producer.drain();original.close();originalClosed=true;
 const received=path.join(root,'received');mkdirSync(received,{mode:0o700});cpSync(path.join(root,'original','project.mioon'),path.join(received,'project.mioon'));
 for(const directory of ['media','生成'])cpSync(path.join(root,'original',directory),path.join(received,directory),{recursive:true,preserveTimestamps:true});
 // Only project content and media cross machines: no original history, jobs,
 // tasks, cache or publication intents are installed in the receiving project.
 const companions=path.join(received,'.mioon-store');
 store=openServerTestStore({projectFile:path.join(received,'project.mioon'),locate:()=>({localDir:path.join(companions,'records'),cacheDir:path.join(companions,'cache'),tempDir:path.join(companions,'tmp')})},path.join(companions,'app'));
 services=createServices(store,new Map(),{env:{},imageOptions:{autoRun:false},frameOptions:{autoRun:false},sceneOptions:{autoRun:false}});
 const currentStore=store,currentServices=services,library=testProjectAppLibrary(store);assert.ok(library);
 const versions=createProjectVersions(store,{assertMutationAllowed:services.assertMutationAllowed,assertRestoreAllowed:()=>{
  currentServices.assertMutationAllowed();if(currentServices.isBusy())throw Object.assign(Error('Project is busy'),{code:'PROJECT_HOST_BUSY'});
 }});
 const references=createProjectAssetReferenceServices(store,{outsidePaths:library.outsidePaths}),asset=(id:string)=>record(currentStore.get('assets',id));
 const before:Record<string,Record<string,unknown>>=Object.fromEntries(Object.entries(ids).map(([kind,id])=>[kind,asset(id)]));
 const graph=createOwnedMediaGraphReader(store.db,projectId),sources={image:graph.imageSource(ids.image),frame:graph.frameSource(ids.frame),scene:graph.sceneKeyframeSource(ids.scene)};
 const processRows=()=>Object.fromEntries(['jobs','image_tasks','image_requests','frame_tasks','frame_requests','scene_tasks','scene_requests'].map(table=>[table,currentStore.db.prepare(`SELECT * FROM main.${table} ORDER BY rowid`).all()]));
 assert.ok(Object.values(processRows()).every(rows=>rows.length===0));
 const save=()=>versions.save({projectId,requestId:randomUUID(),name:'Published output checkpoint'});
 const restore=(versionId:string)=>{const preview=versions.preview({projectId,versionId});assert.equal(preview.restoreAvailable,true);const input={projectId,versionId,requestId:randomUUID(),expectedContentSequence:preview.contentSequence,previewDigest:preview.previewDigest};return {preview,input,result:versions.restore(input)};};
 const relink=async(id:string,file:string)=>{const preview=record(await currentServices.call('asset.media.relink.preview',{projectId,assetId:id,sourcePath:file,expectedReferenceRevision:asset(id).referenceRevision}));assert.equal(record(preview.chosen).matches,true);await currentServices.call('asset.media.relink.apply',{projectId,requestId:randomUUID(),previewToken:preview.previewToken});return asset(id);};
 const read=async(id:string)=>{const value=asset(id);assert.equal(validateImageConsumption(currentStore.db,{id,provenance:value.provenance},projectId).id,id);return (await references.read(id,{maxBytes:Number(value.sizeBytes),expectedSha256:String(value.sha256),expectedReferenceRevision:Number(value.referenceRevision)})).bytes;};
 return {root,store,services,projectId,ids,sceneShotId,imageVersionId:String(image.versionId),library,versions,references,before,sources,processRows,asset,save,restore,relink,read};
}

test('public version restoration keeps current S2 image/frame/scene locators and coherent identity while restoring mutable metadata',async t=>{
 const f=await fixture(t),saved=f.save(),linked=new Map<string,Record<string,unknown>>();
 mkdirSync(path.join(f.store.projectDir,'素材'),{mode:0o755});
 for(const [kind,id] of Object.entries(f.ids)){
  const original=f.asset(id),file=path.join(f.store.projectDir,'素材',`${kind}-relinked.png`);cpSync(mediaFixturePath(f.store.projectDir,original),file);
  const current=await f.relink(id,file);assert.equal(current.referenceRevision,2);assert.notDeepEqual(current.reference,original.reference);
  f.store.put('assets',{...current,name:`Changed ${kind} name`,width:Number(current.width)+1});linked.set(id,current);
 }
 const files=mediaTree(f.store),grants=f.library.outsidePaths.list(f.projectId),process=f.processRows(),changes=f.store.db.prepare('SELECT total_changes() n').get()!.n;
 const preview=f.versions.preview({projectId:f.projectId,versionId:saved.version.id});
 assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,changes);assert.deepEqual(mediaTree(f.store),files);
 for(const id of Object.values(f.ids))assert.match(preview.changes.find(change=>change.table==='assets'&&change.key.includes(id))!.reason!,/定位.*保持当前/);
 const restored=f.restore(saved.version.id);assert.equal(restored.result.appliedChanges.filter(change=>change.table==='assets').length,3);
 for(const [kind,id] of Object.entries(f.ids)){
  const current=linked.get(id)!,original=f.before[kind],value=f.asset(id);
  assert.deepEqual(value.publication,original.publication);
  assert.deepEqual(value,{...original,reference:current.reference,referenceRevision:current.referenceRevision,sha256:current.sha256,sizeBytes:current.sizeBytes});
  assert.deepEqual(await f.read(id),readFileSync(mediaFixturePath(f.store.projectDir,current)));
 }
 const graph=createOwnedMediaGraphReader(f.store.db,f.projectId);assert.deepEqual(graph.imageSource(f.ids.image),f.sources.image);assert.deepEqual(graph.frameSource(f.ids.frame),f.sources.frame);assert.deepEqual(graph.sceneKeyframeSource(f.ids.scene),f.sources.scene);
 assert.equal(record(graph.imageVersion(f.imageVersionId)).assetId,f.ids.image);
 assert.deepEqual(f.processRows(),process);assert.deepEqual(f.library.outsidePaths.list(f.projectId),grants);assert.deepEqual(mediaTree(f.store),files);
});

for(const removeMedia of [false,true])test(`public restore adds missing portable frame/scene facts with ${removeMedia?'missing':'retained'} bytes without writing or deleting media`,async t=>{
 const f=await fixture(t),saved=f.save();
 // These portable rows have no local task owner. Keep all real FK/retention
 // guards enabled; the mutable scene shot is removed before its two assets.
 f.store.tx(()=>{assert.equal(f.store.db.prepare('DELETE FROM project.shots WHERE id=?').run(f.sceneShotId).changes,1);for(const id of [f.ids.frame,f.ids.scene])assert.equal(f.store.db.prepare('DELETE FROM project.assets WHERE id=?').run(id).changes,1);});
 if(removeMedia)for(const kind of ['frame','scene'])unlinkSync(mediaFixturePath(f.store.projectDir,f.before[kind]));
 writeFileSync(path.join(f.store.projectDir,'生成','keep-unregistered.bin'),'Unrelated output must survive restore',{mode:0o600});
 const files=mediaTree(f.store),grants=f.library.outsidePaths.list(f.projectId),process=f.processRows(),restored=f.restore(saved.version.id);
 for(const kind of ['frame','scene'] as const){
  const id=f.ids[kind],original=f.before[kind];assert.equal(restored.preview.changes.find(change=>change.table==='assets'&&change.key.includes(id))?.action,'add');
  assert.deepEqual(f.asset(id),original);assert.ok(original.publication);assert.ok(original[kind==='frame'?'frameResult':'sceneResult']);
  if(removeMedia){assert.equal(existsSync(mediaFixturePath(f.store.projectDir,original)),false);await assert.rejects(f.read(id),{code:'MEDIA_MISSING'});}
  else assert.deepEqual(await f.read(id),readFileSync(mediaFixturePath(f.store.projectDir,original)));
 }
 const graph=createOwnedMediaGraphReader(f.store.db,f.projectId);assert.deepEqual(graph.frameSource(f.ids.frame),f.sources.frame);assert.deepEqual(graph.sceneKeyframeSource(f.ids.scene),f.sources.scene);assert.equal(record(f.store.get('shots',f.sceneShotId)).id,f.sceneShotId);
 assert.deepEqual(f.processRows(),process);assert.deepEqual(f.library.outsidePaths.list(f.projectId),grants);assert.deepEqual(mediaTree(f.store),files);
});

test('restoring a missing S2 frame from an external-reference snapshot never reinstates a revoked directory grant',async t=>{
 const f=await fixture(t),external=path.join(f.root,'external');mkdirSync(external,{mode:0o755});
 const file=path.join(external,'frame.png');cpSync(mediaFixturePath(f.store.projectDir,f.before.frame),file);
 // Trusted chooser setup grants the real B1 directory before ordinary relink.
 f.library.outsidePaths.confirm({projectId:f.projectId,directory:external,confirmedAt:new Date().toISOString()});
 const linked=await f.relink(f.ids.frame,file);assert.equal(linked.referenceRevision,2);assert.deepEqual(await f.read(f.ids.frame),readFileSync(file));
 const saved=f.save();f.store.tx(()=>assert.equal(f.store.db.prepare('DELETE FROM project.assets WHERE id=?').run(f.ids.frame).changes,1));f.library.outsidePaths.revoke(f.projectId,external);
 const files=mediaTree(f.store,external),process=f.processRows();assert.deepEqual(f.library.outsidePaths.list(f.projectId),[]);
 f.restore(saved.version.id);assert.deepEqual(f.asset(f.ids.frame),linked);assert.deepEqual(createOwnedMediaGraphReader(f.store.db,f.projectId).frameSource(f.ids.frame),f.sources.frame);
 const state=await f.references.inspect(f.ids.frame);assert.equal(state.status,'online');assert.equal(state.outside,true);assert.equal(state.readable,false);
 await assert.rejects(f.read(f.ids.frame),{code:'MEDIA_OUTSIDE_NOT_CONFIRMED'});assert.deepEqual(f.library.outsidePaths.list(f.projectId),[]);assert.deepEqual(f.processRows(),process);assert.deepEqual(mediaTree(f.store,external),files);
});
