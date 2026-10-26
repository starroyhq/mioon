import type {ImageServicesOptions} from '../packages/business/src/images.ts';
import type {FixtureImageTask} from './helpers/strict-service-responses.ts';
import type {ImageTaskResponse} from '../packages/contracts/src/images.ts';
type EditSource = Extract<ImageTaskResponse, {purpose:'edit'}>['sourceImage'];
type FixtureGenerate = (input: {sourceImage?:EditSource;purpose?:string}, options: {beforeDispatch:()=>void;sourceBytes:Buffer}) => Promise<{bytes:Buffer}>;
type ImageFixtureOptions = {autoRun?:boolean;generate?:FixtureGenerate;liveGenerate?:FixtureGenerate;fault?:(stage:string)=>void;comfySettings?:ImageServicesOptions['comfySettings'];comfyConnector?:unknown};
import type {DatabaseSync} from 'node:sqlite';
import type {TypedImageServices, TypedImageCall, TypedFrameServices} from './helpers/strict-timeline-audio-factory-types.ts';
import type {Failure} from './helpers/strict-timeline-audio-types.ts';
import type {TypedStore} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,unlinkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {createFrameServices} from '../packages/business/src/frames.ts';
import {FRAME_PROFILE_ID,FRAME_SELECTION_RULE} from '../packages/contracts/src/frame-extraction.ts';
import {createComfySettings} from '../packages/business/src/comfy/settings.ts';
import {DEFAULT_COMFY_IMAGE_CONFIGURATION,COMFY_IMAGE_OPTIONS} from '../packages/contracts/src/comfy-images.ts';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore} from '../packages/business/src/db.ts';
import {validateImageTaskReview} from '../packages/business/src/images/reviews.ts';
import {createImageServices} from '../packages/business/src/images.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {createImageEditSourceResolver} from '../packages/business/src/images/edit-source.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS,canonicalImageInput as canonical} from '../packages/contracts/src/images.ts';
import {IMAGE_SETTINGS_READ_CURRENT,IMAGE_SETTINGS_ASSERT_CURRENT} from '../packages/business/src/images/settings.ts';
import {DEFAULT_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import type { BinaryLike } from 'crypto';

const sha=(bytes: BinaryLike|Buffer<ArrayBuffer>)=>createHash('sha256').update(bytes).digest('hex');
let pngPromise: ReturnType<typeof renderMockImagePng> | undefined;const png=()=>pngPromise??=renderMockImagePng();
const code=(expected: string)=>(error: { code: string; })=>error.code===expected;
const noPrivate=(value: unknown)=>assert.doesNotMatch(JSON.stringify(value),/"(?:relativePath|bytes|sourceBytes|canonicalIntent|canonicalInput|apiKey|path)"\s*:/);
async function fixture(t: test.TestContext,{autoRun=true,generate,liveGenerate,fault,comfySettings,comfyConnector}:ImageFixtureOptions={}){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-image-edit-')),store=(openStore(root) as TypedStore),projectId=randomUUID(),otherProjectId=randomUUID();
 for(const id of [projectId,otherProjectId])store.put('projects',{id,name:'Image edits',description:'',revision:1});
 let revision=1,enabled=true,calls=0,posts=0;
 const settings={
  [IMAGE_SETTINGS_READ_CURRENT]:()=>({revision,configuration:{...DEFAULT_IMAGE_CONFIGURATION,enabled},secret:{configured:true}}),
  [IMAGE_SETTINGS_ASSERT_CURRENT]:(expected: {expectedRevision:number})=>expected.expectedRevision===revision&&enabled,
 };
 const adapter=async(input: unknown,options: { beforeDispatch: () => void; })=>{calls++;if(generate)return generate(input as Parameters<FixtureGenerate>[0],options as Parameters<FixtureGenerate>[1]);options.beforeDispatch();posts++;return {bytes:await png()};};
 const liveGateway={generate:async(input: unknown,options: { beforeDispatch: () => void; })=>{calls++;if(liveGenerate)return liveGenerate(input as Parameters<FixtureGenerate>[0],options as Parameters<FixtureGenerate>[1]);options.beforeDispatch();posts++;return {bytes:await png()};}};
 const images=(createImageServices(store,{autoRun,generate:adapter,settings,liveGateway,fault,comfySettings,comfyConnector} as unknown as ImageServicesOptions) as TypedImageServices);
 const bytes=await png(),assetId=randomUUID(),asset={id:assetId,projectId,name:'Source.png',mimeType:'image/png' as const,provenance:'user-import',sha256:sha(bytes),width:1024,height:1024,sizeBytes:bytes.length,relativePath:`media/${assetId}.png`,createdAt:new Date().toISOString()};
 store.put('assets',asset);writeFileSync(path.join(root,asset.relativePath),bytes,{mode:0o600});
 const f={root,store,projectId,otherProjectId,images,asset,bytes,get calls(){return calls;},get posts(){return posts;},
  call:(((operation: string|number,input: unknown)=>images.handlers[operation](input)) as unknown as TypedImageCall),
  input:(patch?: Record<string, unknown>)=>({projectId,requestId:randomUUID(),name:'Image group',providerId:'mock',model:IMAGE_MODELS.mock,prompt:'Use the selected source to make a variation.',options:{...IMAGE_FIXED_OPTIONS},purpose:'edit',inputImage:{assetId,sha256:asset.sha256},...patch}),
  configure:(patch: { revision?: number; enabled?: boolean; })=>{revision=patch.revision??revision;enabled=patch.enabled??enabled;},
  restore:()=>writeFileSync(path.join(root,asset.relativePath),bytes,{mode:0o600}),
  alter:()=>writeFileSync(path.join(root,asset.relativePath),Buffer.alloc(bytes.length,1),{mode:0o600}),
  prepare:(input: unknown)=>images.handlers['image.review.prepare']({input,settingsRevision:revision}),
  approve:(review: { id: unknown; })=>images.approveReviewed({projectId,reviewId:review.id,expectedRevision:1}),
  row:(id: string)=>store.db.prepare('SELECT * FROM image_tasks WHERE id=?').get(id) as Record<string,import('node:sqlite').SQLOutputValue> & {state:string;snapshot:string},
 };
 t.after(async()=>{await images.drain();store.close();rmSync(root,{recursive:true,force:true});});return f;
}
async function terminal(f: Awaited<ReturnType<typeof fixture>>,id: string,expected: string){
 const until=Date.now()+10000;
 while(Date.now()<until){const row=f.row(id);if(['succeeded','failed','local_result_error','outcome_unknown','cancelled_before_dispatch'].includes(row!.state)){assert.equal(row!.state,expected);return row;}await pause(5);}
 assert.fail(`Task did not reach ${expected}`);
}
const liveInput=(f: Awaited<ReturnType<typeof fixture>>)=>f.input({providerId:'openai',model:IMAGE_MODELS.openai});
const taskInput=(f: Awaited<ReturnType<typeof fixture>>,id: string)=>({projectId:f.projectId,taskId:id});

test('managed PNG edit retains one safe descriptor in ACK, snapshot and version while bytes remain private',async t=>{
 let projection,sourceBytes;
 const f=await fixture(t,{generate:async(input: unknown,options: { sourceBytes: unknown; beforeDispatch: () => void; })=>{projection=structuredClone(input);sourceBytes=Buffer.from(options.sourceBytes as Buffer);options.beforeDispatch();return {bytes:await png()};}});
 const input=f.input(),ack=await f.call('image.generate',input);await terminal(f,ack.id,'succeeded');
 assert.equal(ack.purpose,'edit');assert.deepEqual(ack.inputImage,input.inputImage);assert.equal(ack.sourceImage!.origin.kind,'user-import');noPrivate(ack);
 assert.deepEqual(sourceBytes,f.bytes);assert.deepEqual(projection!.sourceImage,ack.sourceImage);assert.equal(projection!.purpose,'edit');noPrivate(projection);
 const task=f.call('image.task.get',taskInput(f,ack.id)),version=f.call('image.version.list',{projectId:f.projectId,groupId:ack.groupId}).items[0];
 assert.deepEqual(version.sourceImage,ack.sourceImage);assert.deepEqual(task.sourceImage,ack.sourceImage);assert.equal(version.number,1);noPrivate(version);
 assert.deepEqual(JSON.parse((f.row(ack.id)!.snapshot as string)).sourceImage,ack.sourceImage);
 const stored=f.store.db.prepare('SELECT input,snapshot FROM image_tasks WHERE id=?').get(ack.id);assert.ok(!JSON.stringify(stored).includes(f.bytes.toString('base64')));
 f.alter();assert.deepEqual(await f.call('image.generate',input),ack,'exact original ACK precedes fresh file checks');
});

test('same-group older version is a valid edit source for multiple later versions',async t=>{
 const f=await fixture(t),base=f.input();delete (base as Partial<typeof base>).purpose;delete (base as Partial<typeof base>).inputImage;
 const first=await f.call('image.generate',base);await terminal(f,first.id,'succeeded');
 const source=f.call('image.version.list',{projectId:f.projectId,groupId:first.groupId}).items[0];
 for(let number=2;number<=3;number++){
  const group=f.call('image.group.get',{projectId:f.projectId,groupId:first.groupId});
  const input=f.input({groupId:group.id,expectedRevision:group.revision,inputImage:{assetId:source.assetId,sha256:source.sha256}}),ack=await f.call('image.generate',input);
  await terminal(f,ack.id,'succeeded');
  const versions=f.call('image.version.list',{projectId:f.projectId,groupId:group.id});assert.equal(versions.items[0].number,number);assert.equal((versions.items[0].sourceImage!.origin as Extract<EditSource['origin'],{imageSource:unknown}>).imageSource.imageVersionId,source.id);
  assert.equal(createOwnedMediaGraphReader(f.store.db,f.projectId).asset(versions.items[0].assetId).id,versions.items[0].assetId);
 }
});

test('private review freezes edit endpoint/source and approval binds exactly the retained descriptor',async t=>{
 const f=await fixture(t,{autoRun:false}),input=liveInput(f),review=await f.prepare(input);
 assert.equal(review.destination,'https://api.openai.com/v1/images/edits');assert.equal(review.sourceImage!.assetId,f.asset.id);assert.equal(review.state,'pending');assert.equal(f.calls,0);noPrivate(review);
 const intent=JSON.parse((f.store.db.prepare('SELECT canonicalIntent FROM image_reviews WHERE id=?').get(review.id)!.canonicalIntent as string));assert.equal(intent.schemaVersion,4);assert.deepEqual(intent.sourceImage,review.sourceImage);
 f.alter();await assert.rejects(Promise.resolve().then(()=>f.approve(review)),code('IMAGE_SOURCE_INVALID'));assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_tasks').get()!.n,0);
 assert.deepEqual(await f.prepare(input),review,'historical review replay does not read changed file');f.restore();
 const ack=await f.approve(review);assert.deepEqual(ack.sourceImage,review.sourceImage);f.alter();f.configure({revision:2,enabled:false});
 assert.deepEqual(await f.approve(review),ack,'accepted approval replay precedes source/settings checks');
});

test('changed safe metadata cannot replace source identity between review and approval',async t=>{
 const f=await fixture(t,{autoRun:false}),review=await f.prepare(liveInput(f));f.store.put('assets',{...f.asset,name:'Changed source name.png'});
 await assert.rejects(Promise.resolve().then(()=>f.approve(review)),code('IMAGE_SOURCE_INVALID'));
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_tasks').get()!.n,0);assert.equal(f.calls,0);
});

test('settings changed during asynchronous PNG verification prevent review preparation',async t=>{
 const f=await fixture(t,{autoRun:false}),pending=f.prepare(liveInput(f));f.configure({revision:2});
 await assert.rejects(pending as Promise<unknown>,code('IMAGE_REVIEW_SETTINGS_CHANGED'));assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_reviews').get()!.n,0);
});

test('concurrent edit admissions recheck group CAS after asynchronous PNG validation',async t=>{
 const f=await fixture(t,{autoRun:false}),first=await f.call('image.generate',f.input());
 f.call('image.task.cancelQueued',{...taskInput(f,first.id),expectedRevision:1,requestId:randomUUID()});
 const group=f.call('image.group.get',{projectId:f.projectId,groupId:first.groupId}),inputs=[0,1].map(()=>f.input({groupId:group.id,expectedRevision:group.revision}));
 const result=await Promise.allSettled(inputs.map(input=>f.call('image.generate',input)));assert.equal(result.filter(value=>value.status==='fulfilled').length,1);assert.equal(result.find(value=>value.status==='rejected')!.reason.code,'IMAGE_REVISION_CONFLICT');
});

test('source changed in async gateway gap fails before the durable POST fence',async t=>{
 let entered: (value?: unknown) => void,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);let posts=0;
 const f=await fixture(t,{liveGenerate:async(_input: unknown,options: { beforeDispatch: () => void; })=>{entered();await gate;options.beforeDispatch();posts++;return {bytes:await png()};}}),review=await f.prepare(liveInput(f)),ack=await f.approve(review);
 await ready;f.alter();release!();const row=await terminal(f,ack.id,'failed');assert.equal(row!.dispatched,0);assert.equal(posts,0);
 const stored=f.call('image.review.get',{projectId:f.projectId,reviewId:review.id});assert.equal(stored.postAttempts,0);
});

test('valid received result with changed source is retained locally and recovery never regenerates',async t=>{
 let f: Awaited<ReturnType<typeof fixture>>;f=await fixture(t,{generate:async(_input: unknown,options: { beforeDispatch: () => void; })=>{options.beforeDispatch();f.alter();return {bytes:await png()};}});
 const input=f.input(),ack=await f.call('image.generate',input),failed=await terminal(f,ack.id,'local_result_error');assert.equal(failed!.dispatched,1);assert.ok(failed!.stagedReceipt);assert.equal(f.calls,1);
 await assert.rejects(Promise.resolve().then(()=>f.call('image.task.recoverResult',{...taskInput(f,ack.id),expectedRevision:failed!.revision,requestId:randomUUID()})),code('IMAGE_SOURCE_INVALID'));
 f.restore();const recovery={...taskInput(f,ack.id),expectedRevision:failed!.revision,requestId:randomUUID()},recovered=await f.call('image.task.recoverResult',recovery);await terminal(f,ack.id,'succeeded');
 assert.equal(recovered.state,'persisting');assert.equal(f.calls,1);f.alter();assert.deepEqual(await f.call('image.task.recoverResult',recovery),recovered);assert.equal(f.calls,1);
});

test('source changed after media publication prevents DB commit and preserves local result',async t=>{
 let f: Awaited<ReturnType<typeof fixture>>,once=true;f=await fixture(t,{fault:(event: string)=>{if(event==='after_media_publication'&&once){once=false;f.alter();}}});
 const ack=await f.call('image.generate',f.input()),failed=await terminal(f,ack.id,'local_result_error');assert.ok(failed!.stagedReceipt);assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_versions').get()!.n,0);
 f.restore();await f.call('image.task.recoverResult',{...taskInput(f,ack.id),expectedRevision:failed!.revision,requestId:randomUUID()});await terminal(f,ack.id,'succeeded');assert.equal(f.calls,1);
});

test('queued edit cancellation stays pre-dispatch and no startup/replay resumes it',async t=>{
 const f=await fixture(t,{autoRun:false}),input=f.input(),ack=await f.call('image.generate',input),cancel=f.call('image.task.cancelQueued',{...taskInput(f,ack.id),expectedRevision:1,requestId:randomUUID()});
 assert.equal(cancel.state,'cancelled_before_dispatch');assert.equal(cancel.dispatched,false);assert.deepEqual(await f.call('image.generate',input),ack);assert.equal(f.calls,0);
});

for(const variant of ['foreign','wrong-hash','wrong-size','wrong-dimensions','non-png','bad-png','symlink','oversized'])test(`edit source ${variant} is rejected without acceptance or disclosure`,async t=>{
 const f=await fixture(t,{autoRun:false});let input=f.input(),asset={...f.asset};
 if(variant==='foreign')asset.projectId=f.otherProjectId;
 if(variant==='wrong-hash')input.inputImage.sha256='b'.repeat(64);
 if(variant==='wrong-size')asset.sizeBytes++;
 if(variant==='wrong-dimensions')asset.width=512;
 if(variant==='non-png')(asset as {mimeType:string}).mimeType='image/jpeg';
 if(variant==='bad-png'){const bad=Buffer.alloc(f.bytes.length,0);writeFileSync(path.join(f.root,asset.relativePath),bad);asset.sha256=sha(bad);input.inputImage.sha256=asset.sha256;}
 if(variant==='symlink'){const target=path.join(f.root,'media','private.png');writeFileSync(target,f.bytes,{mode:0o600});unlinkSync(path.join(f.root,asset.relativePath));symlinkSync(target,path.join(f.root,asset.relativePath));}
 if(variant==='oversized')asset.sizeBytes=8*1024*1024+1;
 f.store.put('assets',asset);await assert.rejects(Promise.resolve().then(()=>f.call('image.generate',input)),error=>{assert.equal((error as Failure).code,'IMAGE_SOURCE_INVALID');noPrivate(error);return true;});assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_tasks').get()!.n,0);
});

test('public task, version and asset roots reject mutated edit source ownership without repair',async t=>{
 const f=await fixture(t),ack=await f.call('image.generate',f.input());await terminal(f,ack.id,'succeeded');const version=f.call('image.version.list',{projectId:f.projectId,groupId:ack.groupId}).items[0];
 f.store.put('assets',{...f.asset,projectId:f.otherProjectId,name:'PRIVATE_FOREIGN_SENTINEL'});
 const count=f.store.db.prepare('SELECT total_changes() n').get()!.n;
 for(const read of [()=>f.call('image.task.get',taskInput(f,ack.id)),()=>f.call('image.version.list',{projectId:f.projectId,groupId:ack.groupId}),()=>createOwnedMediaGraphReader(f.store.db,f.projectId).asset(version.assetId)])assert.throws(read,error=>!JSON.stringify(error).includes('PRIVATE_FOREIGN_SENTINEL'));
 assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,count);
});

test('resolver never runs asynchronous PNG work inside a SQLite transaction',async t=>{
 const f=await fixture(t,{autoRun:false}),resolver=createImageEditSourceResolver(f.store);let promise!: ReturnType<ReturnType<typeof createImageEditSourceResolver>['verify']>;
 f.store.tx(()=>{promise=resolver.verify(f.input());});await assert.rejects(promise as Promise<unknown>,/outside SQLite transactions/);
});

function injectEdit(f: Awaited<ReturnType<typeof fixture>>,sourceImage: EditSource){
 const id=randomUUID(),groupId=randomUUID(),assetId=randomUUID(),versionId=randomUUID(),timestamp=new Date().toISOString();
 const input=f.input({inputImage:{assetId:sourceImage.assetId,sha256:sourceImage.sha256}}),inputHash=sha(canonical(input));
 const snapshot={schemaVersion:1,projectId:f.projectId,taskId:id,groupId,name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options,purpose:'edit',inputImage:input.inputImage,sourceImage};
 const receipt={schemaVersion:1,taskId:id,projectId:f.projectId,groupId,inputHash,assetId,versionId,sha256:f.asset.sha256,mimeType:'image/png' as const,width:1024,height:1024,byteLength:f.bytes.length,isMock:true};
 const asset={...f.asset,id:assetId,name:'Edited.png',provenance:'synthetic-mock',relativePath:`media/${assetId}.png`};
 const version={id:versionId,projectId:f.projectId,groupId,taskId:id,number:1,assetId,sha256:receipt.sha256,mimeType:'image/png' as const,width:1024,height:1024,byteLength:receipt.byteLength,isMock:true,providerId:'mock',model:IMAGE_MODELS.mock,options:{...IMAGE_FIXED_OPTIONS},purpose:'edit',inputImage:input.inputImage,sourceImage,createdAt:timestamp};
 f.store.tx(()=>{
  f.store.db.prepare('INSERT INTO image_groups VALUES(?,?,?,2,?,NULL,?,?)').run(groupId,f.projectId,input.name,versionId,timestamp,timestamp);
  f.store.db.prepare("INSERT INTO image_tasks VALUES(?,?,?,?,?,?,?,'succeeded',4,1,?,?,NULL,?,?)").run(id,f.projectId,groupId,input.requestId,inputHash,canonical(input),canonical(snapshot),canonical(receipt),versionId,timestamp,timestamp);
  f.store.put('assets',asset);f.store.db.prepare('INSERT INTO image_versions VALUES(?,?,?,?,?,?,?)').run(versionId,f.projectId,groupId,id,1,assetId,JSON.stringify(version));
 });
 return {id,groupId,assetId,versionId,input,snapshot,receipt,version,sourceImage:{assetId,sha256:asset.sha256,mimeType:'image/png' as const,byteLength:asset.sizeBytes,width:1024,height:1024,name:asset.name,origin:{kind:'synthetic-mock' as const,imageSource:{imageGroupId:groupId,imageTaskId:id,imageVersionId:versionId}}}};
}
const importedDescriptor=(f: Awaited<ReturnType<typeof fixture>>)=>({assetId:f.asset.id,sha256:f.asset.sha256,mimeType:'image/png' as const,byteLength:f.bytes.length,width:1024,height:1024,name:f.asset.name,origin:{kind:'user-import' as const}});
function removeIdentityTriggers(db: DatabaseSync){for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (tbl_name='image_tasks' OR tbl_name='image_versions')").all())db.exec(`DROP TRIGGER "${row.name}"`);db.exec('PRAGMA ignore_check_constraints=ON');}

test('actual edit-source cycle is rejected rather than hidden by pending caches',async t=>{
 const f=await fixture(t,{autoRun:false}),one=injectEdit(f,importedDescriptor(f)),two=injectEdit(f,one.sourceImage);
 assert.equal(createOwnedMediaGraphReader(f.store.db,f.projectId).asset(two.assetId).id,two.assetId);
 removeIdentityTriggers(f.store.db);
 const input={...one.input,inputImage:{assetId:two.assetId,sha256:two.sourceImage.sha256}},inputHash=sha(canonical(input)),snapshot={...one.snapshot,inputImage:input.inputImage,sourceImage:two.sourceImage},receipt={...one.receipt,inputHash},version={...one.version,inputImage:input.inputImage,sourceImage:two.sourceImage};
 f.store.db.prepare('UPDATE image_tasks SET input=?,inputHash=?,snapshot=?,stagedReceipt=? WHERE id=?').run(canonical(input),inputHash,canonical(snapshot),canonical(receipt),one.id);
 f.store.db.prepare('UPDATE image_versions SET data=? WHERE id=?').run(JSON.stringify(version),one.versionId);
 assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.projectId).asset(two.assetId));
 assert.throws(()=>f.call('image.task.get',taskInput(f,one.id)),code('IMAGE_RECORD_INVALID'));
});

test('edit source ancestry is bounded at 32 source tasks',async t=>{
 const f=await fixture(t,{autoRun:false});let source:EditSource=importedDescriptor(f),last: ReturnType<typeof injectEdit>;
 for(let depth=1;depth<=33;depth++){last=injectEdit(f,source);source=last.sourceImage;if(depth===32)assert.equal(createOwnedMediaGraphReader(f.store.db,f.projectId).asset(last.assetId).id,last.assetId);}
 assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.projectId).asset(last.assetId));
});

for(const variant of ['sql-owner-reassigned','version-deleted','foreign-extra-receipt'])test(`reverse ${variant} cannot hide an edited output behind an import label`,async t=>{
 const {validateImageConsumption}=await import('../packages/business/src/image-consumption.ts');
 const f=await fixture(t,{autoRun:false}),edited=injectEdit(f,importedDescriptor(f));removeIdentityTriggers(f.store.db);f.store.db.exec('PRAGMA foreign_keys=OFF');
 const asset={...f.store.get('assets',edited.assetId)!,provenance:'user-import'};f.store.put('assets',asset);
 if(variant==='sql-owner-reassigned')f.store.db.prepare('UPDATE image_versions SET assetId=? WHERE id=?').run(randomUUID(),edited.versionId);
 if(variant==='version-deleted')f.store.db.prepare('DELETE FROM image_versions WHERE id=?').run(edited.versionId);
 if(variant==='foreign-extra-receipt'){
  const foreign=injectEdit(f,importedDescriptor(f));f.store.db.prepare('UPDATE image_tasks SET projectId=?,stagedReceipt=? WHERE id=?').run(f.otherProjectId,canonical({...foreign.receipt,assetId:edited.assetId}),foreign.id);
 }
 assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.projectId).asset(edited.assetId));
 assert.throws(()=>validateImageConsumption(f.store.db,asset,f.projectId),code('IMAGE_SOURCE_INVALID'));
});

for(const approved of [false,true])test(`${approved?'approved':'pending'} review reads reject foreign source ownership without filesystem checks`,async t=>{
 const f=await fixture(t,{autoRun:false}),input=liveInput(f),review=await f.prepare(input);if(approved)await f.approve(review);
 f.store.put('assets',{...f.asset,projectId:f.otherProjectId,name:'PRIVATE_FOREIGN_SENTINEL'});
 for(const read of [()=>f.call('image.review.get',{projectId:f.projectId,reviewId:review.id}),()=>f.call('image.review.list',{projectId:f.projectId}),()=>f.prepare(input)])assert.throws(read,error=>(error as Failure).code==='IMAGE_SOURCE_INVALID'&&!JSON.stringify(error).includes('PRIVATE_FOREIGN_SENTINEL'));
});

test('source rejections retain the request key without unsafe absence proof',async t=>{
 const f=await fixture(t,{autoRun:false});f.alter();
 await assert.rejects(Promise.resolve().then(()=>f.call('image.generate',f.input())),error=>(error as Failure).code==='IMAGE_SOURCE_INVALID'&&!(error as Failure).details?.imageOutcome);
 await assert.rejects(Promise.resolve().then(()=>f.prepare(liveInput(f))),error=>(error as Failure).code==='IMAGE_SOURCE_INVALID'&&!(error as Failure).details?.imageOutcome);
});

test('source damage cannot prevent rejection of pending review or pre-dispatch cancellation',async t=>{
 const f=await fixture(t,{autoRun:false}),review=await f.prepare(liveInput(f)),ack=await f.call('image.generate',f.input());
 f.store.put('assets',{...f.asset,projectId:f.otherProjectId});
 const rejected=f.images.rejectReview({projectId:f.projectId,reviewId:review.id,expectedRevision:1});assert.equal(rejected.state,'rejected');assert.equal(rejected.sourceImage!.assetId,f.asset.id);
 const input={...taskInput(f,ack.id),expectedRevision:1,requestId:randomUUID()},cancelled=f.call('image.task.cancelQueued',input);assert.equal(cancelled.state,'cancelled_before_dispatch');assert.deepEqual(f.call('image.task.cancelQueued',input),cancelled);assert.equal(f.calls,0);
});

for(const reviewMode of [false,true])test(`two-window ${reviewMode?'preparation':'generation'} source rejection cannot claim an in-flight same key was not accepted`,async t=>{
 const f=await fixture(t,{autoRun:false}),input=reviewMode?liveInput(f):f.input(),invoke=()=>reviewMode?f.prepare(input):f.call('image.generate',input);
 f.alter();const rejected=invoke();f.restore();const accepted=invoke();
 await assert.rejects(rejected as Promise<unknown>,(error: { code: string; details: { imageOutcome: unknown; }; })=>error.code==='IMAGE_SOURCE_INVALID'&&!error.details?.imageOutcome);
 const value=await accepted;assert.deepEqual(await invoke(),value);assert.equal(f.store.db.prepare(`SELECT count(*) n FROM ${reviewMode?'image_reviews':'image_tasks'}`).get()!.n,1);
 f.store.put('assets',{...f.asset,projectId:f.otherProjectId});
 await assert.rejects(Promise.resolve().then(invoke),error=>!(error as Failure).details?.imageOutcome);
});

function solidPng(width: number,height=width,{alpha=255}={}){
 const chunk=(name: string,data: Buffer<ArrayBuffer>)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(name,4);data.copy(out,8);let crc=0xffffffff;for(const byte of out.subarray(4,-4)){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 const row=width*4+1,raw=Buffer.alloc(row*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++)raw[y*row+1+x*4+3]=alpha;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}

test('opaque 8-bit sources support nonsquare dimensions but reject real alpha without conversion',async t=>{
 const f=await fixture(t,{autoRun:false});
 for(const alpha of [255,0]){const bytes=solidPng(4,2,{alpha}),asset={...f.asset,width:4,height:2,sizeBytes:bytes.length,sha256:sha(bytes)};f.store.put('assets',asset);writeFileSync(path.join(f.root,asset.relativePath),bytes);const input=f.input({inputImage:{assetId:asset.id,sha256:asset.sha256}});
  if(alpha===255){const value=await f.call('image.generate',input);assert.equal(value.sourceImage!.width,4);assert.equal(value.sourceImage!.height,2);f.call('image.task.cancelQueued',{...taskInput(f,value.id),expectedRevision:1,requestId:randomUUID()});}
  else await assert.rejects(Promise.resolve().then(()=>f.call('image.generate',input)),code('IMAGE_SOURCE_INVALID'));
 }
});

test('a fully owned extracted frame is admitted with bounded typed frame provenance',async t=>{
 const f=await fixture(t),sourceId=randomUUID(),sourceBytes=Buffer.from('Synthetic video source, no decoder network'),source={id:sourceId,projectId:f.projectId,name:'Video.mp4',mimeType:'video/mp4',sha256:sha(sourceBytes),sizeBytes:sourceBytes.length,relativePath:`media/${sourceId}.mp4`,width:4,height:2,duration:1,provenance:'user-import'};
 f.store.put('assets',source);writeFileSync(path.join(f.root,source.relativePath),sourceBytes,{mode:0o600});const bytes=solidPng(4,2);
 const frames=(createFrameServices(f.store,{decode:async (input:import('../packages/business/src/frame-decoder.ts').DecodeManagedFrameOptions)=>{input!.beforeSpawn!(input!.signal!);return {bytes,provenance:{profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,sourceFrame:input!.requestedFrame as number,fps:30,sourceHash:(input!.asset as {sha256:string}).sha256,probe:{streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:4,height:2,rotation:0,sarNumerator:1,sarDenominator:1}}};}} as unknown as Parameters<typeof createFrameServices>[1]) as TypedFrameServices);t.after(()=>frames.drain());
 const frame=await frames.handlers['frame.extract']({projectId:f.projectId,sourceAssetId:source.id,sourceHash:source.sha256,sourceFrame:0,requestId:randomUUID()});let ready;
 for(let i=0;i<500;i++){ready=frames.handlers['frame.task.get']({projectId:f.projectId,taskId:frame.id});if(ready.state==='succeeded')break;await pause(5);}assert.equal(ready.state,'succeeded');
 const ack=await f.call('image.generate',f.input({inputImage:{assetId:ready.result.assetId,sha256:ready.result.sha256}}));await terminal(f,ack.id,'succeeded');
 assert.deepEqual(ack.sourceImage!.origin,{kind:'extracted-frame',frameSource:{frameTaskId:frame.id,sourceAssetId:source.id,sourceHash:source.sha256,sourceFrame:0,fps:30,profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE}});assert.equal(ack.sourceImage!.width,4);
 f.store.put('assets',{...source,projectId:f.otherProjectId});assert.throws(()=>f.call('image.task.get',taskInput(f,ack.id)),code('IMAGE_RECORD_INVALID'));
});

test('a completed Comfy image is a valid edit source only through its full remote lineage',async t=>{
 let saved: unknown=null;const settings=await createComfySettings({persistence:{load:async()=>saved,save:async value=>{saved=structuredClone(value);}},reservedPorts:()=>[4318]});t.after(()=>settings.close());
 const configuration={...DEFAULT_COMFY_IMAGE_CONFIGURATION,enabled:true,baseUrl:'http://127.0.0.1:8188',model:'synthetic.safetensors'};await settings.put({expectedRevision:0,configuration});
 const checked={ok:true,baseUrl:configuration.baseUrl,comfyVersion:'0.39.0',checkpoints:[configuration.model],nodeClasses:['CheckpointLoaderSimple','EmptyLatentImage','CLIPTextEncode','KSampler','VAEDecode','SaveImage'],selectedCheckpointAvailable:true};settings.recordCheck(checked,settings.clearCheck(checked.baseUrl));
 const bytes=solidPng(512),connector={submit:async (args: { beforeSubmit: () => void; execution: { promptId: unknown; }; })=>{args.beforeSubmit();return {state:'submitted',promptId:args.execution.promptId};},observe:async (args: { execution: { filenamePrefix: string; }; })=>({state:'completed',contentVerified:true,candidate:{bytes,mimeType:'image/png' as const,width:512,height:512,byteLength:bytes.length,sha256:sha(bytes),descriptor:{filename:args.execution.filenamePrefix+'_00001_.png',subfolder:'',type:'output'}}})};
 const f=await fixture(t,{comfySettings:settings,comfyConnector:connector}),input={projectId:f.projectId,requestId:randomUUID(),name:'Comfy source',providerId:'comfy-local',model:configuration.model,prompt:'Synthetic bounded Comfy image.',options:COMFY_IMAGE_OPTIONS},review=await f.prepare(input),ack=await f.approve(review);
 for(let i=0;i<500&&f.row(ack.id)!.state!=='receiving';i++)await pause(5);assert.equal(f.row(ack.id)!.state,'receiving');
 const remote=f.call('image.task.remote.get',taskInput(f,ack.id));f.call('image.task.observeRemote',{...taskInput(f,ack.id),requestId:randomUUID(),expectedRevision:remote.remote.revision});await terminal(f,ack.id,'succeeded');
 const version=f.call('image.version.list',{projectId:f.projectId,groupId:ack.groupId}).items[0],edited=await f.call('image.generate',f.input({inputImage:{assetId:version.assetId,sha256:version.sha256}}));await terminal(f,edited.id,'succeeded');
 assert.equal(edited.sourceImage!.width,512);assert.equal(edited.sourceImage!.origin.kind,'generated');assert.equal(edited.sourceImage!.origin.imageSource.imageTaskId,ack.id);noPrivate(edited);
});

test('source verification memory admission is shared across wrappers and released only after verification settles',async t=>{
 const f=await fixture(t,{autoRun:false}),one=createImageEditSourceResolver(f.store),two=createImageEditSourceResolver({...f.store});
 const input=f.input(),a=one.verify(input),b=two.verify(input);
 await assert.rejects(two.verify(input),code('IMAGE_QUEUE_FULL'));
 await Promise.all([a,b]);assert.equal((await two.verify(input)).descriptor.assetId,f.asset.id);
 f.alter();await assert.rejects(one.verify(input),code('IMAGE_SOURCE_INVALID'));f.restore();
 await Promise.all([one.verify(input),two.verify(input)]);
});

test('source verification memory admission bounds all projects sharing a DB handle',async t=>{
 const f=await fixture(t,{autoRun:false}),resolver=createImageEditSourceResolver(f.store),inputs=[f.input()];
 for(let index=0;index<2;index++){const projectId=randomUUID(),assetId=randomUUID(),asset={...f.asset,id:assetId,projectId,relativePath:`media/${assetId}.png`};f.store.put('projects',{id:projectId,name:'Other source project'});f.store.put('assets',asset);writeFileSync(path.join(f.root,asset.relativePath),f.bytes,{mode:0o600});inputs.push(f.input({projectId,inputImage:{assetId,sha256:asset.sha256}}));}
 const pending=[resolver.verify(inputs[0]),resolver.verify(inputs[0]),resolver.verify(inputs[1]),resolver.verify(inputs[1])];await assert.rejects(resolver.verify(inputs[2]),code('IMAGE_QUEUE_FULL'));await Promise.all(pending);assert.equal((await resolver.verify(inputs[2])).descriptor.assetId,inputs[2].inputImage.assetId);
});

test('verification admission releases its captured project bucket after caller input mutation',async t=>{
 const f=await fixture(t,{autoRun:false}),resolver=createImageEditSourceResolver(f.store),input=f.input(),pending=resolver.verify(input);input.projectId=f.otherProjectId;
 await assert.rejects(pending as Promise<unknown>,code('IMAGE_SOURCE_INVALID'));await Promise.all([resolver.verify(f.input()),resolver.verify(f.input())]);
});

test('graph review accounting includes bounded raw intent and direct task bytes before decoding',async t=>{
 const f=await fixture(t,{autoRun:false}),input=liveInput(f),review=await f.prepare(input),ack=await f.approve(review),accounted: {canonicalInput?:unknown;canonicalIntent?:unknown;input?:unknown;snapshot?:unknown}[]=[];
 validateImageTaskReview(f.store.db,f.projectId,ack.id,input,{consume:raw=>accounted.push(JSON.parse(raw))});assert.equal(accounted.length,2);assert.ok(accounted[0].canonicalInput);assert.ok(accounted[0].canonicalIntent);assert.ok(accounted[1].input);assert.ok(accounted[1].snapshot);
 f.store.db.exec('PRAGMA ignore_check_constraints=ON;DROP TRIGGER immutable_image_review_identity;DROP TRIGGER image_review_state_transitions');f.store.db.prepare('UPDATE image_reviews SET canonicalIntent=? WHERE id=?').run('{',review.id);
 const budget=Object.assign(Error('Synthetic read budget exceeded'),{code:'INSPECTION_BUDGET_EXCEEDED'});
 assert.throws(()=>validateImageTaskReview(f.store.db,f.projectId,ack.id,input,{consume:()=>{throw budget;}}),error=>error===budget);
});
