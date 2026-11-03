import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {mediaReferenceSchema} from '../packages/contracts/src/media-reference.ts';
import {registeredProjectStoreForDatabase} from '../packages/business/src/project-media-storage.ts';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import {kernelFixture,snapshot as currentSnapshot} from './helpers/current-retained-fixture.ts';

import {createImageHistoryReaders} from '../packages/business/src/images/history.ts';
import {createFrameHistoryReaders} from '../packages/business/src/frames-history.ts';
import {createImageServices} from '../packages/business/src/images.ts';
import {createFrameServices} from '../packages/business/src/frames.ts';
import {IMAGE_LIMITS,IMAGE_MODELS,IMAGE_FIXED_OPTIONS,canonicalImageInput as canonical} from '../packages/contracts/src/images.ts';
import {FRAME_LIMITS,FRAME_PROFILE,FRAME_PROFILE_ID,FRAME_SELECTION_RULE} from '../packages/contracts/src/frame-extraction.ts';
import {insert} from './images-fixture.mjs';

const at='2026-10-12T00:00:00.000Z',hash=(value: unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const code=(expected: string)=>(cause: { code: unknown; })=>(cause as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code===expected;
const snapshot=(db: DatabaseSync)=>JSON.stringify(currentSnapshot(db));
function currentAsset<T extends {id:string;relativePath:string;sizeBytes:number}>(db:DatabaseSync,value:T){
 const owner=registeredProjectStoreForDatabase(db);assert.ok(owner);
 fs.writeFileSync(path.join(owner.projectDir,value.relativePath),Buffer.alloc(value.sizeBytes));
 owner.put('assets',value);
 const persisted=owner.get('assets',value.id);assert.ok(persisted&&typeof persisted==='object'&&!Array.isArray(persisted));
 const record=persisted as Record<string,unknown>;assert.equal(record.referenceRevision,1);
 return {...value,reference:mediaReferenceSchema.parse(record.reference),referenceRevision:1};
}
function seedImage(db: DatabaseSync,projectId: string,state='queued'){
 const groupId=randomUUID(),taskId=randomUUID(),requestId=randomUUID(),versionId=randomUUID(),assetId=randomUUID();
 const input={projectId,name:'Saved image 界',prompt:'Synthetic historical image',providerId:'mock',model:IMAGE_MODELS.mock,options:IMAGE_FIXED_OPTIONS,requestId};
 const frozen={schemaVersion:1,projectId,groupId,taskId,name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options};
 const ack={id:taskId,projectId,groupId,requestId,name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options,state:'queued',revision:1,dispatched:false,versionId:null,errorCode:null,createdAt:at,updatedAt:at};
 const receipt={schemaVersion:1,taskId,projectId,groupId,inputHash:hash(input),assetId,versionId,sha256:'a'.repeat(64),mimeType:'image/png',width:1024,height:1024,byteLength:128,isMock:true};
 const asset={id:assetId,projectId,name:'Saved image.png',mimeType:'image/png',width:1024,height:1024,sizeBytes:128,sha256:receipt.sha256,relativePath:`media/${assetId}.png`,provenance:'synthetic-mock',createdAt:at};
 const version={id:versionId,projectId,groupId,taskId,number:1,assetId,sha256:receipt.sha256,mimeType:'image/png',width:1024,height:1024,byteLength:128,isMock:true,providerId:input.providerId,model:input.model,options:input.options,createdAt:at};
 db.exec('BEGIN');
 insert(db,'image_groups',{id:groupId,projectId,name:input.name,revision:1,headVersionId:null,activeTaskId:taskId,createdAt:at,updatedAt:at});
 insert(db,'image_tasks',{id:taskId,projectId,groupId,requestId,inputHash:hash(input),input:canonical(input),snapshot:canonical(frozen),state:'queued',revision:1,dispatched:0,stagedReceipt:null,versionId:null,errorCode:null,createdAt:at,updatedAt:at});
 insert(db,'image_requests',{requestId,operation:'image.generate',projectId,inputHash:hash(input),canonicalInput:canonical(input),response:JSON.stringify(ack)});
 if(state!=='queued')db.prepare("UPDATE image_tasks SET state='dispatching',dispatched=1,revision=2 WHERE id=?").run(taskId);
 if(state==='outcome_unknown')db.prepare("UPDATE image_tasks SET state='outcome_unknown',revision=3,errorCode='IMAGE_OUTCOME_UNKNOWN' WHERE id=?").run(taskId);
 if(state==='succeeded'){
  db.prepare("UPDATE image_tasks SET state='persisting',stagedReceipt=?,revision=3 WHERE id=?").run(JSON.stringify(receipt),taskId);
  currentAsset(db,asset);insert(db,'image_versions',{id:versionId,projectId,groupId,taskId,number:1,assetId,data:JSON.stringify(version)});
  db.prepare("UPDATE image_tasks SET state='succeeded',versionId=?,revision=4 WHERE id=?").run(versionId,taskId);
  db.prepare('UPDATE image_groups SET revision=2,headVersionId=?,activeTaskId=NULL WHERE id=?').run(versionId,groupId);
 }
 db.exec('COMMIT');return {projectId,groupId,taskId,requestId,versionId,assetId,input,ack,asset,version};
}
function seedFrame(db: DatabaseSync,projectId: string,state='queued'){
 const taskId=randomUUID(),requestId=randomUUID(),sourceId=randomUUID(),assetId=randomUUID();
 const source=currentAsset(db,{id:sourceId,projectId,name:'Saved source.mp4',mimeType:'video/mp4',sha256:'b'.repeat(64),sizeBytes:256,relativePath:`media/${sourceId}.mp4`,duration:3,width:1920,height:1080,hasVideo:true,hasAudio:true,provenance:'user-import',createdAt:at});
 const input={projectId,sourceAssetId:sourceId,sourceHash:source.sha256,sourceFrame:56,requestId};
 const frozen={schemaVersion:1,projectId,taskId,source:{assetId:sourceId,sha256:source.sha256,mimeType:source.mimeType,sizeBytes:source.sizeBytes,reference:source.reference,referenceRevision:source.referenceRevision,duration:source.duration,width:source.width,height:source.height},requested:{sourceFrame:56,fps:30},profile:FRAME_PROFILE};
 const ack={id:taskId,projectId,requestId,sourceAssetId:sourceId,sourceHash:source.sha256,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,state:'queued',revision:1,started:false,result:null,errorCode:null,createdAt:at,updatedAt:at};
 const receipt={schemaVersion:1,projectId,taskId,inputHash:hash(input),sourceAssetId:sourceId,sourceHash:source.sha256,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,assetId,sha256:'c'.repeat(64),mimeType:'image/png',width:1024,height:576,byteLength:100,probe:{streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:1920,height:1080,rotation:0,sarNumerator:1,sarDenominator:1}};
 const asset={id:assetId,projectId,name:'Saved frame.png',sha256:receipt.sha256,mimeType:'image/png',provenance:'extracted-frame',relativePath:`media/${assetId}.png`,width:1024,height:576,sizeBytes:100,createdAt:at};
 db.exec('BEGIN');
 insert(db,'frame_tasks',{id:taskId,projectId,requestId,inputHash:hash(input),input:canonical(input),snapshot:canonical(frozen),state:'queued',revision:1,started:0,stagedReceipt:null,assetId:null,errorCode:null,createdAt:at,updatedAt:at});
 insert(db,'frame_requests',{requestId,operation:'frame.extract',projectId,taskId,inputHash:hash(input),canonicalInput:canonical(input),response:canonical(ack)});
 if(state!=='queued')db.prepare("UPDATE frame_tasks SET state='running',started=1,revision=2 WHERE id=?").run(taskId);
 if(state==='succeeded'){
  db.prepare("UPDATE frame_tasks SET state='persisting',stagedReceipt=?,revision=3 WHERE id=?").run(canonical(receipt),taskId);
  currentAsset(db,asset);
  db.prepare("UPDATE frame_tasks SET state='succeeded',assetId=?,revision=4 WHERE id=?").run(assetId,taskId);
 }
 db.exec('COMMIT');return {projectId,taskId,requestId,sourceId,assetId,input,ack,source,asset};
}
function fixture(t: test.TestContext){
 const native=kernelFixture(t,'Saved reader'),foreign=kernelFixture(t,'Foreign reader');
 const db=native.store.db;
 const projectId=native.projectId,otherProjectId=foreign.projectId;
 return {db,store:native.store,foreignStore:foreign.store,projectId,otherProjectId};
}
// Observe the exact owner connection: a DB proxy would lose the kernel identity.
const readScopes=new WeakMap<object,<T>(read:()=>T)=>T>();
function readOnlyStore(db: DatabaseSync){
 const queries:string[]=[],rows:{sql:string;args:unknown[];value:unknown}[]=[],transactions:string[]=[];
 const store=new Proxy({db},{get(target,key){assert.equal(key,'db','Pure factory inspected a non-DB store capability');return target.db;}});
 function run<T>(read:()=>T):T {
  const prepare=db.prepare,exec=db.exec,prepareOwn=Object.getOwnPropertyDescriptor(db,'prepare'),execOwn=Object.getOwnPropertyDescriptor(db,'exec');
  Object.defineProperty(db,'prepare',{configurable:true,value:(sql:string)=>{
   assert.match(sql,/^SELECT\b/i);queries.push(sql);const statement=prepare.call(db,sql);
   return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key,target);if(key==='get'||key==='all')return(...args:unknown[])=>{const result=value.apply(target,args);rows.push({sql,args,value:result});return result;};if(key==='run')return()=>assert.fail('Read used SQL run');return typeof value==='function'?value.bind(target):value;}});
  }});
  Object.defineProperty(db,'exec',{configurable:true,value:(sql:string)=>{assert.ok(['BEGIN DEFERRED','COMMIT'].includes(sql),sql);transactions.push(sql);return exec.call(db,sql);}});
  try{return read();}finally{if(prepareOwn)Object.defineProperty(db,'prepare',prepareOwn);else Reflect.deleteProperty(db,'prepare');if(execOwn)Object.defineProperty(db,'exec',execOwn);else Reflect.deleteProperty(db,'exec');}
 }
 readScopes.set(store,run);return {store,queries,rows,transactions,run};
}
function withoutIO(t: test.TestContext,fn: { (): void; (): unknown; }){
 const guards: {mock:{restore():void}}[]=[];
 for(const [object,names] of [[fs,['readFileSync','openSync','lstatSync','statSync','accessSync','realpathSync','readdirSync','readSync','readFile','open','stat','lstat','access','readdir','createReadStream','createWriteStream','writeFileSync','mkdirSync']],
  [fsPromises,['readFile','open','stat','lstat','access','readdir','writeFile','mkdir']],
  [childProcess,['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']],[http,['request','get']],[https,['request','get']],[net,['connect','createConnection']],[globalThis,['fetch','queueMicrotask']]] as const)
  for(const name of names)guards.push((t.mock.method as unknown as (object:object,name:PropertyKey,fn:()=>never)=>{mock:{restore():void}})(object,name,()=>assert.fail(`Pure history entered ${name}`)));
 syncBuiltinESMExports();try{return fn();}finally{for(const guard of guards)guard.mock.restore();syncBuiltinESMExports();}
}
const rawReaders=(store: { db: unknown; })=>({...(createImageHistoryReaders as unknown as (store:Parameters<typeof createImageHistoryReaders>[0],options?:unknown)=>import('./helpers/strict-workspace-boundary-types.ts').ImageHistory)((store as unknown as Parameters<typeof createImageHistoryReaders>[0])).handlers,...(createFrameHistoryReaders as unknown as (store:Parameters<typeof createFrameHistoryReaders>[0],options?:unknown)=>import('./helpers/strict-workspace-boundary-types.ts').FrameHistory)((store as unknown as Parameters<typeof createFrameHistoryReaders>[0])).handlers});
const readers=(store:Parameters<typeof rawReaders>[0])=>{
 const handlers=rawReaders(store),run=readScopes.get(store);
 return Object.fromEntries(Object.entries(handlers).map(([operation,handler])=>[operation,(input:unknown)=>run?run(()=>handler(input as never)):handler(input as never)])) as typeof handlers;
};
const cases=(image: { projectId: unknown; groupId: unknown; taskId: unknown; requestId: unknown; versionId?: `${string}-${string}-${string}-${string}-${string}`; assetId?: `${string}-${string}-${string}-${string}-${string}`; input?: { projectId: unknown; name: string; prompt: string; providerId: string; model: "mock-image-v1"; options: Readonly<{ size: "1024x1024"; quality: "low"; outputFormat: "png"; background: "opaque"; n: 1; }>; requestId: `${string}-${string}-${string}-${string}-${string}`; }; ack?: { id: `${string}-${string}-${string}-${string}-${string}`; projectId: unknown; groupId: `${string}-${string}-${string}-${string}-${string}`; requestId: `${string}-${string}-${string}-${string}-${string}`; name: string; prompt: string; providerId: string; model: "mock-image-v1"; options: Readonly<{ size: "1024x1024"; quality: "low"; outputFormat: "png"; background: "opaque"; n: 1; }>; state: string; revision: number; dispatched: boolean; versionId: null; errorCode: null; createdAt: string; updatedAt: string; }; asset?: { id: `${string}-${string}-${string}-${string}-${string}`; projectId: unknown; name: string; mimeType: string; width: number; height: number; sizeBytes: number; sha256: string; relativePath: string; provenance: string; createdAt: string; }; version?: { id: `${string}-${string}-${string}-${string}-${string}`; projectId: unknown; groupId: `${string}-${string}-${string}-${string}-${string}`; taskId: `${string}-${string}-${string}-${string}-${string}`; number: number; assetId: `${string}-${string}-${string}-${string}-${string}`; sha256: string; mimeType: string; width: number; height: number; byteLength: number; isMock: boolean; providerId: string; model: "mock-image-v1"; options: Readonly<{ size: "1024x1024"; quality: "low"; outputFormat: "png"; background: "opaque"; n: 1; }>; createdAt: string; }; },frame: { projectId: unknown; taskId: unknown; requestId: unknown; sourceId?: `${string}-${string}-${string}-${string}-${string}`; assetId?: `${string}-${string}-${string}-${string}-${string}`; input?: { projectId: unknown; sourceAssetId: `${string}-${string}-${string}-${string}-${string}`; sourceHash: string; sourceFrame: number; requestId: `${string}-${string}-${string}-${string}-${string}`; }; ack?: { id: `${string}-${string}-${string}-${string}-${string}`; projectId: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; sourceAssetId: `${string}-${string}-${string}-${string}-${string}`; sourceHash: string; sourceFrame: number; fps: number; profileId: string; state: string; revision: number; started: boolean; result: null; errorCode: null; createdAt: string; updatedAt: string; }; source?: { id: `${string}-${string}-${string}-${string}-${string}`; projectId: unknown; name: string; mimeType: string; sha256: string; sizeBytes: number; relativePath: string; duration: number; width: number; height: number; hasVideo: boolean; hasAudio: boolean; provenance: string; createdAt: string; }; asset?: { id: `${string}-${string}-${string}-${string}-${string}`; projectId: unknown; name: string; sha256: string; mimeType: string; provenance: string; relativePath: string; width: number; height: number; sizeBytes: number; createdAt: string; }; })=>[
 ['image.request.get',{projectId:image.projectId,requestId:image.requestId}],['image.task.get',{projectId:image.projectId,taskId:image.taskId}],
 ['image.group.get',{projectId:image.projectId,groupId:image.groupId}],['image.task.list',{projectId:image.projectId}],['image.group.list',{projectId:image.projectId}],['image.version.list',{projectId:image.projectId,groupId:image.groupId}],
 ['frame.request.get',{projectId:frame.projectId,requestId:frame.requestId}],['frame.task.get',{projectId:frame.projectId,taskId:frame.taskId}],['frame.task.list',{projectId:frame.projectId}],
] as const;

test('current pure factories and every saved history handler do zero SQL writes, file I/O, scheduling, provider access, network or spawn',t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId,'succeeded'),frame=seedFrame(f.db,f.projectId,'succeeded');
 const before=snapshot(f.db),changes=f.db.prepare('SELECT total_changes() n').get()!.n,guard=readOnlyStore(f.db);
 const hostile=new Proxy({},{get(){assert.fail('Pure factory inspected provider options');}});
 withoutIO(t,()=>{
  const raw={...(createImageHistoryReaders as unknown as (store:Parameters<typeof createImageHistoryReaders>[0],options?:unknown)=>import('./helpers/strict-workspace-boundary-types.ts').ImageHistory)(guard.store,hostile).handlers,...(createFrameHistoryReaders as unknown as (store:Parameters<typeof createFrameHistoryReaders>[0],options?:unknown)=>import('./helpers/strict-workspace-boundary-types.ts').FrameHistory)(guard.store,hostile).handlers};
  const read=Object.fromEntries(Object.entries(raw).map(([op,handler])=>[op,(input:unknown)=>guard.run(()=>handler(input as never))])) as typeof raw;
  assert.deepEqual(Object.keys(read).sort(),cases(image,frame).map(([op])=>op).sort());
  for(const [op,input] of cases(image,frame))assert.ok(read[op](input));
  assert.deepEqual(read['image.request.get']({projectId:f.projectId,requestId:image.requestId})!.response,image.ack);
  assert.deepEqual(read['frame.request.get']({projectId:f.projectId,requestId:frame.requestId})!.response,frame.ack);
 });
 assert.ok(guard.queries.length);assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n,changes);assert.equal(snapshot(f.db),before);
});

for(const [imageState,frameState] of [['queued','queued'],['dispatching','running'],['outcome_unknown','running']] as const)test(`captured ${imageState}/${frameState} reads preserve states, revisions and original ACK bytes`,t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId,imageState),frame=seedFrame(f.db,f.projectId,frameState);const before=snapshot(f.db),read=readers(readOnlyStore(f.db).store);
 assert.equal(read['image.task.get']({projectId:f.projectId,taskId:image.taskId}).state,imageState);
 assert.equal(read['frame.task.get']({projectId:f.projectId,taskId:frame.taskId}).state,frameState);
 assert.equal(JSON.stringify(read['image.request.get']({projectId:f.projectId,requestId:image.requestId})!.response),JSON.stringify(image.ack));
 assert.equal(canonical(read['frame.request.get']({projectId:f.projectId,requestId:frame.requestId})!.response),canonical(frame.ack));
 for(const [op,input] of cases(image,frame))read[op](input);assert.equal(snapshot(f.db),before);
});

test('normal lifecycle and pure readers return identical response bytes on the same real kernel connection',async t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId,'succeeded'),frame=seedFrame(f.db,f.projectId,'succeeded');
 const store=f.store;
 const imageService=createImageServices(store,{autoRun:false,generate:()=>assert.fail('Generation entered')}),frameService=createFrameServices(store,{autoRun:false,decode:()=>assert.fail('Decode entered')});
 try{
  const normal={...imageService.handlers,...frameService.handlers},expected=cases(image,frame).map(([op,input])=>JSON.stringify(normal[op](input)));
  const read=readers(readOnlyStore(f.db).store),before=snapshot(f.db);
  for(const [index,[op,input]] of cases(image,frame).entries())assert.equal(JSON.stringify(read[op](input)),expected[index],(op as unknown as Parameters<typeof assert.equal>[2]));
  assert.equal(snapshot(f.db),before);
 }finally{await imageService.drain();await frameService.drain();}
});

test('read snapshots preserve caller transactions, including failed reads',t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId),frame=seedFrame(f.db,f.projectId);const guard=readOnlyStore(f.db),read=readers(guard.store);
 f.db.exec('BEGIN');try{
  for(const [op,input] of cases(image,frame))read[op](input);
  assert.throws(()=>read['image.task.get']({projectId:f.projectId,taskId:randomUUID()}),code('IMAGE_NOT_FOUND'));
  assert.throws(()=>read['frame.task.get']({projectId:f.projectId,taskId:randomUUID()}),code('FRAME_NOT_FOUND'));
  assert.equal(f.db.isTransaction,true);assert.deepEqual(guard.transactions,[]);
 }finally{f.db.exec('ROLLBACK');}
 read['image.task.get']({projectId:f.projectId,taskId:image.taskId});read['frame.task.get']({projectId:f.projectId,taskId:frame.taskId});
 assert.deepEqual(guard.transactions,['BEGIN DEFERRED','COMMIT','BEGIN DEFERRED','COMMIT']);
});

test('history cursors retain project, operation, group and limit binding; page/input limits reject before materialization',t=>{
 const f=fixture(t);for(let n=0;n<3;n++){seedImage(f.db,f.projectId);seedFrame(f.db,f.projectId,'succeeded');}
 const guard=readOnlyStore(f.db),read=readers(guard.store),before=snapshot(f.db);
 for(const family of ['image','frame'] as const){
  const op=`${family}.task.list` as const,input={projectId:f.projectId,limit:1},first=read[op](input),next=read[op]({...input,cursor:first.nextCursor});
  assert.equal(first.items.length,1);assert.equal(next.items.length,1);assert.notEqual(first.items[0].id,next.items[0].id);assert.ok(first.nextCursor);
  for(const patch of [{projectId:f.otherProjectId},{limit:2},{cursor:first.nextCursor.slice(0,-1)+'!'}] as const)assert.throws(()=>('projectId' in patch&&patch.projectId===f.otherProjectId?readers(readOnlyStore(f.foreignStore.db).store):read)[op]({...input,cursor:first.nextCursor,...patch}),code('INVALID_CURSOR'));
  if(family==='image')assert.throws(()=>read['image.group.list']({...input,cursor:first.nextCursor}),code('INVALID_CURSOR'));
  const previous=guard.rows.length;
  for(const limit of [0,-1,1.5,Number.MAX_SAFE_INTEGER] as const)assert.throws(()=>read[op]({...input,limit}),code('VALIDATION_ERROR'));
  assert.throws(()=>read[op]({...input,extra:true}),code('VALIDATION_ERROR'));
  assert.throws(()=>read[op]({...input,cursor:'x'.repeat(769)}),code('VALIDATION_ERROR'));
  assert.ok(guard.rows.slice(previous).every(({sql})=>sql.includes('sqlite_master')),'Invalid input materialized history rows');
 }
 for(const entry of guard.rows.filter(({sql})=>/ORDER BY createdAt DESC,id DESC LIMIT/.test((sql as string))))assert.equal(entry.args.at(-1),2);
 assert.equal(snapshot(f.db),before);
});

test('foreign and absent requests remain undisclosed; tasks and groups preserve the normal ownership errors',t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId),frame=seedFrame(f.db,f.projectId);const read=readers(readOnlyStore(f.db).store),before=snapshot(f.db);
 for(const [family,item] of [['image',image],['frame',frame]] as const){
  assert.equal(readers(readOnlyStore(f.foreignStore.db).store)[`${family}.request.get`]({projectId:f.otherProjectId,requestId:item.requestId}),null);
  assert.equal(read[`${family}.request.get`]({projectId:f.projectId,requestId:randomUUID()}),null);
  assert.throws(()=>read[`${family}.task.get`]({projectId:f.otherProjectId,taskId:item.taskId}),code(`${family.toUpperCase()}_NOT_FOUND`));
 }
 assert.throws(()=>read['image.group.get']({projectId:f.otherProjectId,groupId:image.groupId}),code('IMAGE_NOT_FOUND'));assert.equal(snapshot(f.db),before);
});

function corrupt(db: DatabaseSync,write:()=>void){
 const definitions=['main','project','temp'].flatMap(schema=>db.prepare(`SELECT name,sql FROM ${schema}.sqlite_schema WHERE type='trigger'`).all().map(row=>({schema,name:String(row.name),sql:String(row.sql)})));
 const foreign=Number(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys),ignored=Number(db.prepare('PRAGMA ignore_check_constraints').get()!.ignore_check_constraints);
 try{db.exec('PRAGMA foreign_keys=OFF;PRAGMA ignore_check_constraints=ON');for(const row of definitions)db.exec(`DROP TRIGGER ${row.schema}."${row.name}"`);write();}
 finally{for(const row of definitions){const sql=row.schema==='temp'?row.sql.replace(/^CREATE TRIGGER /,'CREATE TEMP TRIGGER '):row.sql.replace(/^CREATE TRIGGER /,`CREATE TRIGGER ${row.schema}.`);db.exec(sql);assert.equal(db.prepare(`SELECT sql FROM ${row.schema}.sqlite_schema WHERE name=?`).get(row.name)!.sql,row.sql);}db.exec(`PRAGMA foreign_keys=${foreign};PRAGMA ignore_check_constraints=${ignored}`);}
}
for(const family of ['image','frame'] as const)for(const damage of ['oversized-input','missing-source','foreign-source','mixed-video-owner'] as const)test(`${family} request/task/list fail closed for ${damage}, without returning oversized private data`,t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId,'succeeded'),frame=seedFrame(f.db,f.projectId,'succeeded'),item=family==='image'?image:frame;
 corrupt(f.db,()=>{
 if(damage==='oversized-input')f.db.prepare(`UPDATE ${family}_tasks SET input=? WHERE id=?`).run('PRIVATE_SENTINEL'.repeat((family==='image'?IMAGE_LIMITS:FRAME_LIMITS).inputBytes),item.taskId);
 else if(damage==='missing-source')f.db.prepare('DELETE FROM assets WHERE id=?').run(family==='image'?image.assetId:frame.sourceId);
 else if(damage==='foreign-source')f.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.otherProjectId,family==='image'?image.assetId:frame.sourceId);
 else{
  const shotId=randomUUID(),jobId=randomUUID(),versionId=randomUUID(),assetId=item.assetId;
  insert(f.db,'shots',{id:shotId,projectId:f.projectId,data:JSON.stringify({id:shotId,projectId:f.projectId,referenceAssetIds:[]})});
  insert(f.db,'jobs',{id:jobId,projectId:f.projectId,data:JSON.stringify({id:jobId,projectId:f.projectId,shotId,assetId,versionId})});
  insert(f.db,'versions',{id:versionId,projectId:f.projectId,jobId,data:JSON.stringify({id:versionId,projectId:f.projectId,jobId,shotId,assetId})});
 }
 });
 const guard=readOnlyStore(f.db),read=readers(guard.store),before=snapshot(f.db);
 for(const [op,input] of [[`${family}.request.get`,{projectId:f.projectId,requestId:item.requestId}],[`${family}.task.get`,{projectId:f.projectId,taskId:item.taskId}],[`${family}.task.list`,{projectId:f.projectId}]] as const)
  assert.throws(()=>read[op](input),cause=>['IMAGE_RECORD_INVALID','INSPECTION_UNAVAILABLE'].includes((cause as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code)&&!JSON.stringify(cause).includes('PRIVATE_SENTINEL'),op);
 assert.ok(guard.rows.every(({value})=>!JSON.stringify(value??null).includes('PRIVATE_SENTINEL')));assert.equal(snapshot(f.db),before);
});

test('one result claimed by both image and frame history fails closed from either read family',t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId,'succeeded'),frame=seedFrame(f.db,f.projectId,'succeeded');
 corrupt(f.db,()=>{
 const row=f.db.prepare('SELECT stagedReceipt FROM frame_tasks WHERE id=?').get(frame.taskId),receipt=JSON.parse(((row!.stagedReceipt as string)));
 Object.assign(receipt,{assetId:image.assetId,sha256:image.asset.sha256,width:image.asset.width,height:image.asset.height,byteLength:image.asset.sizeBytes});
 f.db.prepare('UPDATE frame_tasks SET assetId=?,stagedReceipt=? WHERE id=?').run(image.assetId,canonical(receipt),frame.taskId);
 });
 const read=readers(readOnlyStore(f.db).store),before=snapshot(f.db);
 for(const [family,item] of [['image',image],['frame',frame]] as const)for(const [op,input] of [
  [`${family}.request.get`,{projectId:f.projectId,requestId:item.requestId}],
  [`${family}.task.get`,{projectId:f.projectId,taskId:item.taskId}],
  [`${family}.task.list`,{projectId:f.projectId}],
 ] as const)assert.throws(()=>read[op](input),cause=>['IMAGE_RECORD_INVALID','INSPECTION_UNAVAILABLE'].includes((cause as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code),op);
 assert.equal(snapshot(f.db),before);
});

for(const family of ['image','frame'] as const)test(`${family} original receipt input and response bounds apply inside SQLite`,t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId),frame=seedFrame(f.db,f.projectId),item=family==='image'?image:frame;
 const original=f.db.prepare(`SELECT * FROM ${family}_requests WHERE requestId=?`).get(item.requestId),guard=readOnlyStore(f.db),read=readers(guard.store);
 for(const field of ['canonicalInput','response'] as const){
  corrupt(f.db,()=>f.db.prepare(`UPDATE ${family}_requests SET ${field}=? WHERE requestId=?`).run('PRIVATE_SENTINEL'.repeat((family==='image'?IMAGE_LIMITS:FRAME_LIMITS).responseBytes),item.requestId));
  const before=snapshot(f.db);assert.throws(()=>read[`${family}.request.get`]({projectId:f.projectId,requestId:item.requestId}),code(`${family.toUpperCase()}_RECORD_INVALID`));
  assert.equal(snapshot(f.db),before);assert.ok(guard.rows.every(({value})=>!JSON.stringify(value??null).includes('PRIVATE_SENTINEL')));
  corrupt(f.db,()=>f.db.prepare(`UPDATE ${family}_requests SET ${field}=? WHERE requestId=?`).run(original![field],item.requestId));
 }
});
