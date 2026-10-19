import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import {initializeLegacyWorkspaceSchema} from '../packages/business/src/workspace-fixed-schema.ts';
import {installWorkspaceRestoreSchema} from '../packages/business/src/workspace-restore-schema.ts';
import {createImageHistoryReaders} from '../packages/business/src/images/history.ts';
import {createFrameHistoryReaders} from '../packages/business/src/frames-history.ts';
import {createImageServices} from '../packages/business/src/images.ts';
import {createFrameServices} from '../packages/business/src/frames.ts';
import {IMAGE_LIMITS,IMAGE_MODELS,IMAGE_FIXED_OPTIONS,canonicalImageInput as canonical} from '../packages/contracts/src/images.ts';
import {FRAME_LIMITS,FRAME_PROFILE,FRAME_PROFILE_ID,FRAME_SELECTION_RULE} from '../packages/contracts/src/frame-extraction.ts';
import {insert} from './images-fixture.mjs';

const at='2026-10-12T00:00:00.000Z',hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const code=expected=>cause=>cause.code===expected;
const snapshot=db=>JSON.stringify(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT rowid AS capturedRowid,* FROM "${name}" ORDER BY rowid`).all()]));
function seedImage(db,projectId,state='queued'){
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
  insert(db,'assets',{id:assetId,projectId,data:JSON.stringify(asset)});insert(db,'image_versions',{id:versionId,projectId,groupId,taskId,number:1,assetId,data:JSON.stringify(version)});
  db.prepare("UPDATE image_tasks SET state='succeeded',versionId=?,revision=4 WHERE id=?").run(versionId,taskId);
  db.prepare('UPDATE image_groups SET revision=2,headVersionId=?,activeTaskId=NULL WHERE id=?').run(versionId,groupId);
 }
 db.exec('COMMIT');return {projectId,groupId,taskId,requestId,versionId,assetId,input,ack,asset,version};
}
function seedFrame(db,projectId,state='queued'){
 const taskId=randomUUID(),requestId=randomUUID(),sourceId=randomUUID(),assetId=randomUUID();
 const source={id:sourceId,projectId,name:'Saved source.mp4',mimeType:'video/mp4',sha256:'b'.repeat(64),sizeBytes:256,relativePath:`media/${sourceId}.mp4`,duration:3,width:1920,height:1080,hasVideo:true,hasAudio:true,provenance:'user-import',createdAt:at};
 const input={projectId,sourceAssetId:sourceId,sourceHash:source.sha256,sourceFrame:56,requestId};
 const frozen={schemaVersion:1,projectId,taskId,source:{assetId:sourceId,sha256:source.sha256,mimeType:source.mimeType,sizeBytes:source.sizeBytes,relativePath:source.relativePath,duration:source.duration,width:source.width,height:source.height},requested:{sourceFrame:56,fps:30},profile:FRAME_PROFILE};
 const ack={id:taskId,projectId,requestId,sourceAssetId:sourceId,sourceHash:source.sha256,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,state:'queued',revision:1,started:false,result:null,errorCode:null,createdAt:at,updatedAt:at};
 const receipt={schemaVersion:1,projectId,taskId,inputHash:hash(input),sourceAssetId:sourceId,sourceHash:source.sha256,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,assetId,sha256:'c'.repeat(64),mimeType:'image/png',width:1024,height:576,byteLength:100,probe:{streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:1920,height:1080,rotation:0,sarNumerator:1,sarDenominator:1}};
 const asset={id:assetId,projectId,name:'Saved frame.png',sha256:receipt.sha256,mimeType:'image/png',provenance:'extracted-frame',relativePath:`media/${assetId}.png`,width:1024,height:576,sizeBytes:100,createdAt:at};
 db.exec('BEGIN');insert(db,'assets',{id:sourceId,projectId,data:JSON.stringify(source)});
 insert(db,'frame_tasks',{id:taskId,projectId,requestId,inputHash:hash(input),input:canonical(input),snapshot:canonical(frozen),state:'queued',revision:1,started:0,stagedReceipt:null,assetId:null,errorCode:null,createdAt:at,updatedAt:at});
 insert(db,'frame_requests',{requestId,operation:'frame.extract',projectId,taskId,inputHash:hash(input),canonicalInput:canonical(input),response:canonical(ack)});
 if(state!=='queued')db.prepare("UPDATE frame_tasks SET state='running',started=1,revision=2 WHERE id=?").run(taskId);
 if(state==='succeeded'){
  db.prepare("UPDATE frame_tasks SET state='persisting',stagedReceipt=?,revision=3 WHERE id=?").run(canonical(receipt),taskId);
  insert(db,'assets',{id:assetId,projectId,data:JSON.stringify(asset)});
  db.prepare("UPDATE frame_tasks SET state='succeeded',assetId=?,revision=4 WHERE id=?").run(assetId,taskId);
 }
 db.exec('COMMIT');return {projectId,taskId,requestId,sourceId,assetId,input,ack,source,asset};
}
function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF');initializeLegacyWorkspaceSchema(db);t.after(()=>db.close());
 const projectId=randomUUID(),otherProjectId=randomUUID();for(const id of [projectId,otherProjectId])insert(db,'projects',{id,data:JSON.stringify({id,name:'Saved history 界'})});
 return {db,projectId,otherProjectId};
}
function seal(db){return installWorkspaceRestoreSchema(db,{restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'d'.repeat(64),sourceDbHash:'e'.repeat(64),createdAt:at});}
function readOnlyStore(db){
 const queries=[],rows=[],transactions=[];
 const readDb=new Proxy(db,{get(target,key){
  if(key==='prepare')return sql=>{assert.match(sql,/^SELECT\b/i);queries.push(sql);const statement=target.prepare(sql);return new Proxy(statement,{get(s,method){const fn=Reflect.get(s,method,s);if(['get','all'].includes(method))return(...args)=>{const value=fn.apply(s,args);rows.push({sql,args,value});return value;};if(method==='run')return()=>assert.fail('Read used SQL run');return typeof fn==='function'?fn.bind(s):fn;}});};
  if(key==='exec')return sql=>{assert.ok(['BEGIN DEFERRED','COMMIT'].includes(sql),sql);transactions.push(sql);return target.exec(sql);};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 const store=new Proxy({db:readDb},{get(target,key){assert.equal(key,'db','Pure factory inspected a non-DB store capability');return target.db;}});
 return {store,queries,rows,transactions};
}
function withoutIO(t,fn){
 const guards=[];
 for(const [object,names] of [[fs,['readFileSync','openSync','lstatSync','statSync','accessSync','realpathSync','readdirSync','readSync','readFile','open','stat','lstat','access','readdir','createReadStream','createWriteStream','writeFileSync','mkdirSync']],
  [fsPromises,['readFile','open','stat','lstat','access','readdir','writeFile','mkdir']],
  [childProcess,['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']],[http,['request','get']],[https,['request','get']],[net,['connect','createConnection']],[globalThis,['fetch','queueMicrotask']]])
  for(const name of names)guards.push(t.mock.method(object,name,()=>assert.fail(`Pure history entered ${name}`)));
 syncBuiltinESMExports();try{return fn();}finally{for(const guard of guards)guard.mock.restore();syncBuiltinESMExports();}
}
const readers=store=>({...createImageHistoryReaders(store).handlers,...createFrameHistoryReaders(store).handlers});
const cases=(image,frame)=>[
 ['image.request.get',{projectId:image.projectId,requestId:image.requestId}],['image.task.get',{projectId:image.projectId,taskId:image.taskId}],
 ['image.group.get',{projectId:image.projectId,groupId:image.groupId}],['image.task.list',{projectId:image.projectId}],['image.group.list',{projectId:image.projectId}],['image.version.list',{projectId:image.projectId,groupId:image.groupId}],
 ['frame.request.get',{projectId:frame.projectId,requestId:frame.requestId}],['frame.task.get',{projectId:frame.projectId,taskId:frame.taskId}],['frame.task.list',{projectId:frame.projectId}],
];

test('restored pure factories and every saved history handler do zero SQL writes, file I/O, scheduling, provider access, network or spawn',t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId,'succeeded'),frame=seedFrame(f.db,f.projectId,'succeeded');seal(f.db);
 const before=snapshot(f.db),changes=f.db.prepare('SELECT total_changes() n').get().n,guard=readOnlyStore(f.db);
 const hostile=new Proxy({},{get(){assert.fail('Pure factory inspected provider options');}});
 withoutIO(t,()=>{
  const read={...createImageHistoryReaders(guard.store,hostile).handlers,...createFrameHistoryReaders(guard.store,hostile).handlers};
  assert.deepEqual(Object.keys(read).sort(),cases(image,frame).map(([op])=>op).sort());
  for(const [op,input] of cases(image,frame))assert.ok(read[op](input));
  assert.deepEqual(read['image.request.get']({projectId:f.projectId,requestId:image.requestId}).response,image.ack);
  assert.deepEqual(read['frame.request.get']({projectId:f.projectId,requestId:frame.requestId}).response,frame.ack);
 });
 assert.ok(guard.queries.length);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);assert.equal(snapshot(f.db),before);
});

for(const [imageState,frameState] of [['queued','queued'],['dispatching','running'],['outcome_unknown','running']])test(`captured ${imageState}/${frameState} reads preserve states, revisions and original ACK bytes`,t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId,imageState),frame=seedFrame(f.db,f.projectId,frameState);seal(f.db);const before=snapshot(f.db),read=readers(readOnlyStore(f.db).store);
 assert.equal(read['image.task.get']({projectId:f.projectId,taskId:image.taskId}).state,imageState);
 assert.equal(read['frame.task.get']({projectId:f.projectId,taskId:frame.taskId}).state,frameState);
 assert.equal(JSON.stringify(read['image.request.get']({projectId:f.projectId,requestId:image.requestId}).response),JSON.stringify(image.ack));
 assert.equal(canonical(read['frame.request.get']({projectId:f.projectId,requestId:frame.requestId}).response),canonical(frame.ack));
 for(const [op,input] of cases(image,frame))read[op](input);assert.equal(snapshot(f.db),before);
});

test('normal lifecycle and pure readers return identical response bytes without constructing lifecycle on restored data',async t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId,'succeeded'),frame=seedFrame(f.db,f.projectId,'succeeded');
 const store={db:f.db,root:'/synthetic-history-no-files',tx:()=>assert.fail('Read used a write transaction')};
 const imageService=createImageServices(store,{autoRun:false,generate:()=>assert.fail('Generation entered')}),frameService=createFrameServices(store,{autoRun:false,decode:()=>assert.fail('Decode entered')});
 try{
  const normal={...imageService.handlers,...frameService.handlers},expected=cases(image,frame).map(([op,input])=>JSON.stringify(normal[op](input)));
  seal(f.db);const read=readers(readOnlyStore(f.db).store),before=snapshot(f.db);
  for(const [index,[op,input]] of cases(image,frame).entries())assert.equal(JSON.stringify(read[op](input)),expected[index],op);
  assert.equal(snapshot(f.db),before);
 }finally{await imageService.drain();await frameService.drain();}
});

test('read snapshots preserve caller transactions, including failed reads',t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId),frame=seedFrame(f.db,f.projectId);seal(f.db);const guard=readOnlyStore(f.db),read=readers(guard.store);
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
 seal(f.db);const guard=readOnlyStore(f.db),read=readers(guard.store),before=snapshot(f.db);
 for(const family of ['image','frame']){
  const op=`${family}.task.list`,input={projectId:f.projectId,limit:1},first=read[op](input),next=read[op]({...input,cursor:first.nextCursor});
  assert.equal(first.items.length,1);assert.equal(next.items.length,1);assert.notEqual(first.items[0].id,next.items[0].id);assert.ok(first.nextCursor);
  for(const patch of [{projectId:f.otherProjectId},{limit:2},{cursor:first.nextCursor.slice(0,-1)+'!'}])assert.throws(()=>read[op]({...input,cursor:first.nextCursor,...patch}),code('INVALID_CURSOR'));
  if(family==='image')assert.throws(()=>read['image.group.list']({...input,cursor:first.nextCursor}),code('INVALID_CURSOR'));
  const previous=guard.rows.length;
  for(const limit of [0,-1,1.5,Number.MAX_SAFE_INTEGER])assert.throws(()=>read[op]({...input,limit}),code('VALIDATION_ERROR'));
  assert.throws(()=>read[op]({...input,extra:true}),code('VALIDATION_ERROR'));
  assert.throws(()=>read[op]({...input,cursor:'x'.repeat(769)}),code('VALIDATION_ERROR'));
  assert.ok(guard.rows.slice(previous).every(({sql})=>sql.includes('sqlite_master')),'Invalid input materialized history rows');
 }
 for(const entry of guard.rows.filter(({sql})=>/ORDER BY createdAt DESC,id DESC LIMIT/.test(sql)))assert.equal(entry.args.at(-1),2);
 assert.equal(snapshot(f.db),before);
});

test('foreign and absent requests remain undisclosed; tasks and groups preserve the normal ownership errors',t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId),frame=seedFrame(f.db,f.projectId);seal(f.db);const read=readers(readOnlyStore(f.db).store),before=snapshot(f.db);
 for(const [family,item] of [['image',image],['frame',frame]]){
  assert.equal(read[`${family}.request.get`]({projectId:f.otherProjectId,requestId:item.requestId}),null);
  assert.equal(read[`${family}.request.get`]({projectId:f.projectId,requestId:randomUUID()}),null);
  assert.throws(()=>read[`${family}.task.get`]({projectId:f.otherProjectId,taskId:item.taskId}),code(`${family.toUpperCase()}_NOT_FOUND`));
 }
 assert.throws(()=>read['image.group.get']({projectId:f.otherProjectId,groupId:image.groupId}),code('IMAGE_NOT_FOUND'));assert.equal(snapshot(f.db),before);
});

function corrupt(db){
 db.exec('PRAGMA foreign_keys=OFF;PRAGMA ignore_check_constraints=ON');
 for(const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all())db.exec(`DROP TRIGGER "${name}"`);
}
for(const family of ['image','frame'])for(const damage of ['oversized-input','missing-source','foreign-source','mixed-video-owner'])test(`${family} request/task/list fail closed for ${damage}, without returning oversized private data`,t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId,'succeeded'),frame=seedFrame(f.db,f.projectId,'succeeded'),item=family==='image'?image:frame;
 corrupt(f.db);
 if(damage==='oversized-input')f.db.prepare(`UPDATE ${family}_tasks SET input=? WHERE id=?`).run('PRIVATE_SENTINEL'.repeat((family==='image'?IMAGE_LIMITS:FRAME_LIMITS).inputBytes),item.taskId);
 else if(damage==='missing-source')f.db.prepare('DELETE FROM assets WHERE id=?').run(family==='image'?image.assetId:frame.sourceId);
 else if(damage==='foreign-source')f.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.otherProjectId,family==='image'?image.assetId:frame.sourceId);
 else{
  const shotId=randomUUID(),jobId=randomUUID(),versionId=randomUUID(),assetId=item.assetId;
  insert(f.db,'shots',{id:shotId,projectId:f.projectId,data:JSON.stringify({id:shotId,projectId:f.projectId,referenceAssetIds:[]})});
  insert(f.db,'jobs',{id:jobId,projectId:f.projectId,data:JSON.stringify({id:jobId,projectId:f.projectId,shotId,assetId,versionId})});
  insert(f.db,'versions',{id:versionId,projectId:f.projectId,jobId,data:JSON.stringify({id:versionId,projectId:f.projectId,jobId,shotId,assetId})});
 }
 const guard=readOnlyStore(f.db),read=readers(guard.store),before=snapshot(f.db);
 for(const [op,input] of [[`${family}.request.get`,{projectId:f.projectId,requestId:item.requestId}],[`${family}.task.get`,{projectId:f.projectId,taskId:item.taskId}],[`${family}.task.list`,{projectId:f.projectId}]])
  assert.throws(()=>read[op](input),cause=>['IMAGE_RECORD_INVALID','INSPECTION_UNAVAILABLE'].includes(cause.code)&&!JSON.stringify(cause).includes('PRIVATE_SENTINEL'),op);
 assert.ok(guard.rows.every(({value})=>!JSON.stringify(value??null).includes('PRIVATE_SENTINEL')));assert.equal(snapshot(f.db),before);
});

test('one result claimed by both image and frame history fails closed from either read family',t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId,'succeeded'),frame=seedFrame(f.db,f.projectId,'succeeded');corrupt(f.db);
 const row=f.db.prepare('SELECT stagedReceipt FROM frame_tasks WHERE id=?').get(frame.taskId),receipt=JSON.parse(row.stagedReceipt);
 Object.assign(receipt,{assetId:image.assetId,sha256:image.asset.sha256,width:image.asset.width,height:image.asset.height,byteLength:image.asset.sizeBytes});
 f.db.prepare('UPDATE frame_tasks SET assetId=?,stagedReceipt=? WHERE id=?').run(image.assetId,canonical(receipt),frame.taskId);
 const read=readers(readOnlyStore(f.db).store),before=snapshot(f.db);
 for(const [family,item] of [['image',image],['frame',frame]])for(const [op,input] of [
  [`${family}.request.get`,{projectId:f.projectId,requestId:item.requestId}],
  [`${family}.task.get`,{projectId:f.projectId,taskId:item.taskId}],
  [`${family}.task.list`,{projectId:f.projectId}],
 ])assert.throws(()=>read[op](input),cause=>['IMAGE_RECORD_INVALID','INSPECTION_UNAVAILABLE'].includes(cause.code),op);
 assert.equal(snapshot(f.db),before);
});

for(const family of ['image','frame'])test(`${family} original receipt input and response bounds apply inside SQLite`,t=>{
 const f=fixture(t),image=seedImage(f.db,f.projectId),frame=seedFrame(f.db,f.projectId),item=family==='image'?image:frame;corrupt(f.db);
 const original=f.db.prepare(`SELECT * FROM ${family}_requests WHERE requestId=?`).get(item.requestId),guard=readOnlyStore(f.db),read=readers(guard.store);
 for(const field of ['canonicalInput','response']){
  f.db.prepare(`UPDATE ${family}_requests SET ${field}=? WHERE requestId=?`).run('PRIVATE_SENTINEL'.repeat((family==='image'?IMAGE_LIMITS:FRAME_LIMITS).responseBytes),item.requestId);
  const before=snapshot(f.db);assert.throws(()=>read[`${family}.request.get`]({projectId:f.projectId,requestId:item.requestId}),code(`${family.toUpperCase()}_RECORD_INVALID`));
  assert.equal(snapshot(f.db),before);assert.ok(guard.rows.every(({value})=>!JSON.stringify(value??null).includes('PRIVATE_SENTINEL')));
  f.db.prepare(`UPDATE ${family}_requests SET ${field}=? WHERE requestId=?`).run(original[field],item.requestId);
 }
});
