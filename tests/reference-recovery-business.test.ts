import type {TypedCall,MediaNode,MediaShot,MediaJob} from './helpers/strict-service-responses.ts';
import type {FixtureAsset,FixtureVersion} from './helpers/strict-timeline-core-types.ts';
interface RecoveryFixture {root:string;readonly store:TypedStore;call:TypedCall;projectId:string;otherId:string;restart():void;capture():Record<string,Record<string,SQLOutputValue>[]>;changes():SQLOutputValue;
asset(patch?:Record<string,unknown>):FixtureAsset;image(patch?:Record<string,unknown>):Promise<{asset:FixtureAsset;node:MediaNode}>;shot(patch?:Record<string,unknown>):Promise<MediaShot>;generated(shot: Pick<MediaShot,'id'|'revision'>,refs?: string[]):Promise<{asset:FixtureAsset;job:MediaJob;version:FixtureVersion}>}
import type {MediaProcessEvent} from '../packages/business/src/media-processes.ts';
import type {Failure} from './helpers/strict-timeline-audio-types.ts';
import type {MediaEdge, TypedServices, TypedStore} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {AppError,REFERENCE_RESPONSE_BYTES,hasRequestNotAppliedProof} from '@mioon/contracts';
import {openStore, type WorkspaceStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {DatabaseSync, type SQLOutputValue} from 'node:sqlite';
import {openLegacyWorkspaceStore} from './helpers/legacy-workspace-store.ts';
import {snapshot as rawSnapshot} from './workspace-schema26-fixtures.mjs';

const at='2026-10-10T00:00:00.000Z',clone=<T>(value: T): T=>JSON.parse(JSON.stringify(value));
const tables=['projects','assets','shots','nodes','edges','jobs','versions','exports','timelines','reference_requests','timeline_requests','idempotency'];
async function fixture(t: test.TestContext,{open=openStore}:{open?:(root:string)=>WorkspaceStore|ReturnType<typeof openLegacyWorkspaceStore>}={}){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-reference-recovery-'));
 let store=open(root) as TypedStore,services=(createServices(store,new Map()) as TypedServices);
 const f={root,get store(){return store;},call:<O extends string>(operation: O,input: unknown)=>services.call(operation,input),
  restart(){store.close();store=open(root) as TypedStore;services=(createServices(store,new Map()) as TypedServices);},
  capture(){return Object.fromEntries(tables.map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));},
  changes(){return store.db.prepare('SELECT total_changes() AS n').get()!.n;},
  asset(patch={}){const id=randomUUID();return store.put('assets',{id,projectId:f.projectId,name:'Reference fixture',mimeType:'image/png',
   width:720,height:1280,provenance:'user-import',sha256:'a'.repeat(64),relativePath:`media/${id}.png`,createdAt:at,...patch});},
  async image(patch={}){const asset=f.asset(patch),node=await f.call('node.create',{projectId:asset.projectId,type:'image',assetId:asset.id,position:{x:0,y:0}});return {asset,node};},
  shot(patch={}){return f.call('shot.create',{projectId:f.projectId,title:'Recovery shot',...patch});},
  async generated(shot: Pick<MediaShot,'id'|'revision'>,refs: string[]=[]){
   const asset=f.asset({mimeType:'video/mp4',provenance:'generated'}),jobId=randomUUID(),versionId=randomUUID();
   const snapshot={projectId:f.projectId,shotId:shot.id,referenceAssetIds:refs};
   const job=store.put('jobs',{id:jobId,projectId:f.projectId,shotId:shot.id,versionId,assetId:asset.id,status:'succeeded',snapshot});
   const version=store.put('versions',{id:versionId,projectId:f.projectId,shotId:shot.id,jobId,assetId:asset.id,sha256:asset.sha256,number:1,snapshot});
   store.put('shots',{...shot,selectedVersionId:version.id});return {asset,job,version};
  },
 } as unknown as RecoveryFixture;
 f.projectId=(await f.call('project.create',{name:'Reference recovery'})).id;
 f.otherId=(await f.call('project.create',{name:'FOREIGN_SECRET'})).id;
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return f;
}
const attach=(f: Awaited<ReturnType<typeof fixture>>,node: Pick<MediaNode,'id'|'revision'>,shot: Pick<MediaShot,'id'|'revision'>,patch={})=>({projectId:f.projectId,sourceNodeId:node.id,targetShotId:shot.id,expectedSourceRevision:node.revision,expectedShotRevision:shot.revision,requestId:randomUUID(),role:'first_frame',...patch});
const detach=(f: Awaited<ReturnType<typeof fixture>>,edge: MediaEdge,shot: Pick<MediaShot,'id'|'revision'>,patch={})=>({projectId:f.projectId,edgeId:edge.id,expectedShotRevision:shot.revision,requestId:randomUUID(),...patch});
async function rejected(f: Awaited<ReturnType<typeof fixture>>,operation: string,input: unknown,{code='INVALID_REFERENCE_RECORD',proof=false,writes=false,call=f.call}:{code?:string|null;proof?:boolean;writes?:boolean;call?:(operation:string,input:unknown)=>Promise<unknown>}={}){
 const before=f.capture(),changes=f.changes(),events: (MediaProcessEvent)[]=[],off=onMediaProcess(event=>events.push(event));
 try{
  await assert.rejects(call(operation,input),error=>{
   if(code)assert.equal((error as Failure).code,code);
   assert.equal((error as Failure).details?.mutationOutcome,proof?'not_applied':undefined);
   assert.equal(hasRequestNotAppliedProof(error,input,{operation}),proof);
   assert.ok(!JSON.stringify(error).includes('FOREIGN_SECRET'));
   if(proof){assert.equal((error as Failure).details.requestId,(input as {requestId:string}).requestId);assert.equal((error as Failure).details.operation,operation);assert.equal((error as Failure).details.projectId,(input as {projectId:string}).projectId);}
   return true;
  });
  assert.deepEqual(f.capture(),before);if(!writes)assert.equal(f.changes(),changes);
  assert.deepEqual((events as unknown),[]);
 }finally{off();}
}
async function prepared(f: Awaited<ReturnType<typeof fixture>>,operation: string){
 const {asset,node}=await f.image(),shot=await f.shot(),input=attach(f,node,shot);
 if(operation==='reference.attach')return {asset,node,shot,input};
 const bound=await f.call('reference.attach',input);
 return {asset,node,shot:bound.shot,edge:bound.edge,input:detach(f,bound.edge,bound.shot)};
}

// No media file is created: all mutation/recovery paths must be metadata-only.
test('lost ACKs, no-op attach, detached historical edges and later rebinding replay unchanged after restart',async t=>{
 const f=await fixture(t),first=await f.image(),second=await f.image();let shot=await f.shot();
 const add=attach(f,first.node,shot),added=await f.call('reference.attach',add);
 const noop=attach(f,first.node,added.shot),same=await f.call('reference.attach',noop);assert.deepEqual(same,added);
 const remove=detach(f,added.edge,same.shot),removed=await f.call('reference.detach',remove);
 const bound=await f.call('reference.attach',attach(f,second.node,removed.shot));
 await f.call('node.update',{nodeId:first.node.id,expectedRevision:first.node.revision,patch:{label:'Later label',position:{x:900,y:42}}});
 await f.call('shot.update',{shotId:shot.id,expectedRevision:bound.shot.revision,patch:{prompt:'Later prompt'}});
 const receipts=[['reference.attach',add,added],['reference.attach',noop,same],['reference.detach',remove,removed]] as const;
 const bytes=f.store.db.prepare('SELECT * FROM reference_requests ORDER BY requestId').all();f.restart();
 const before=f.capture(),changes=f.changes(),events: (MediaProcessEvent)[]=[],off=onMediaProcess(event=>events.push(event));
 t.mock.method(globalThis,'fetch',()=>{throw Error('Reference replay must never fetch');});
 try{for(const [operation,input,response] of receipts)assert.deepEqual(await f.call(operation,input),response);}
 finally{off();}
 assert.equal(f.changes(),changes);assert.deepEqual(f.capture(),before);assert.deepEqual((events as unknown),[]);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM reference_requests ORDER BY requestId').all(),bytes);
 const independent=(openStore(f.root,{lock:false}) as TypedStore);try{
  const service=(createServices(independent,new Map()) as TypedServices);for(const [operation,input,response] of receipts)assert.deepEqual(await service.call(operation,input),response);
 }finally{independent.close();}
});

test('every matching falsy, malformed, oversized or structurally corrupt receipt is retained without fresh execution',async t=>{
 const corruptions=['','null','false','0','""','[]','{}','FOREIGN_SECRET broken JSON',' '.repeat(REFERENCE_RESPONSE_BYTES+1),Buffer.from('FOREIGN_SECRET')];
 for(const operation of ['reference.attach','reference.detach'])await t.test(operation,async t=>{
  const f=await fixture(t),{input}=await prepared(f,operation),response=await f.call(operation,input);
  f.store.db.exec('DROP TRIGGER immutable_reference_responses');
  for(const text of corruptions){
   f.store.db.prepare('UPDATE reference_requests SET response=? WHERE requestId=?').run(text,input.requestId);
   await rejected(f,operation,input);
  }
  for(const alter of [(value: {edge:{projectId:string;target:string;source:string;role:string};shot:MediaShot & {secret:string}})=>value.edge.projectId=f.otherId,(value: {edge:{projectId:string;target:string;source:string;role:string};shot:MediaShot & {secret:string}})=>value.shot.projectId=f.otherId,
(   value: {edge:{projectId:string;target:string;source:string;role:string};shot:MediaShot & {secret:string}})=>value.edge.target=randomUUID(),(value: {edge:{projectId:string;target:string;source:string;role:string};shot:MediaShot & {secret:string}})=>value.edge.source=randomUUID(),(value: {edge:{projectId:string;target:string;source:string;role:string};shot:MediaShot & {secret:string}})=>value.edge.role='other',
(   value: {edge:{projectId:string;target:string;source:string;role:string};shot:MediaShot & {secret:string}})=>value.shot.revision=0,(value: {edge:{projectId:string;target:string;source:string;role:string};shot:MediaShot & {secret:string}})=>value.shot.selectedVersionId='invalid',(value: {edge:{projectId:string;target:string;source:string;role:string};shot:MediaShot & {secret:string}})=>value.shot.secret='FOREIGN_SECRET',
(   value: {edge:{projectId:string;target:string;source:string;role:string};shot:MediaShot & {secret:string}})=>value.shot.referenceAssetIds=[randomUUID()]]){
   const value=clone(response) as {edge:{projectId:string;target:string;source:string;role:string};shot:MediaShot & {selectedVersionId:string;secret:string}};alter(value);f.store.db.prepare('UPDATE reference_requests SET response=? WHERE requestId=?').run(JSON.stringify(value),input.requestId);
   await rejected(f,operation,input);
  }
  f.store.db.prepare('UPDATE reference_requests SET response=?,requestHash=? WHERE requestId=?').run(JSON.stringify(response),'g'.repeat(64),input.requestId);
  await rejected(f,operation,input);
 });
});

test('changed operation, project, target, role or revision cannot reuse a retained reference key',async t=>{
 const f=await fixture(t),{input,node,shot}=await prepared(f,'reference.attach'),added=await f.call('reference.attach',input);
 for(const patch of [{projectId:f.otherId},{sourceNodeId:randomUUID()},{targetShotId:randomUUID()},{expectedShotRevision:2},{expectedSourceRevision:2}])
  await rejected(f,'reference.attach',{...input,...patch},{code:'IDEMPOTENCY_CONFLICT'});
 await rejected(f,'reference.detach',detach(f,added.edge,added.shot,{requestId:input.requestId}),{code:'IDEMPOTENCY_CONFLICT'});
 const remove=detach(f,added.edge,added.shot);await f.call('reference.detach',remove);
 await rejected(f,'reference.attach',attach(f,node,shot,{requestId:remove.requestId}),{code:'IDEMPOTENCY_CONFLICT'});
});

test('SQL owners, JSON owners and stable identities are checked on fresh requests and historical receipts',async t=>{
 const cases=['project id','node SQL owner','node JSON owner','node id','asset SQL owner','asset JSON owner','asset id','shot SQL owner','shot JSON owner','shot id','source asset reassigned','node JSON','shot oversized'];
 for(const operation of ['reference.attach','reference.detach'])for(const replay of [false,true])for(const kind of cases)await t.test(`${operation} ${replay?'replay':'fresh'} ${kind}`,async t=>{
  const f=await fixture(t),preparedValue=await prepared(f,operation),{input,node,asset,shot}=preparedValue;
  if(replay)await f.call(operation,input);
  const ids:Record<string,string>={node:node.id,asset:asset.id,shot:shot.id};
  if(kind==='project id')f.store.db.prepare("UPDATE projects SET data=json_set(data,'$.id',?) WHERE id=?").run(f.otherId,f.projectId);
  else if(kind==='source asset reassigned')f.store.put('nodes',{...node,assetId:f.asset().id});
  else if(kind==='node JSON')f.store.db.prepare('UPDATE nodes SET data=? WHERE id=?').run('FOREIGN_SECRET malformed',node.id);
  else if(kind==='shot oversized')f.store.db.prepare('UPDATE shots SET data=? WHERE id=?').run(' '.repeat(100000),shot.id);
  else{
   const [entity,...rest]=kind.split(' '),table=`${entity}s`,field=rest.join(' ');
   if(field==='SQL owner')f.store.db.prepare(`UPDATE ${table} SET projectId=? WHERE id=?`).run(f.otherId,ids[entity]);
   else f.store.db.prepare(`UPDATE ${table} SET data=json_set(data,'$.${field==='id'?'id':'projectId'}',?) WHERE id=?`).run(f.otherId,ids[entity]);
  }
  // A fresh unbound source can choose a different owned asset; the prior edge
  // is the stable identity for both detach and retained attach acknowledgements.
  if(!replay&&operation==='reference.attach'&&kind==='source asset reassigned'){
   const result=await f.call(operation,input);assert.notEqual(result.edge.sourceAssetId,asset.id);
  }else await rejected(f,operation,input);
 });
});

test('indirect current and frozen selected-version, snapshot references and generated-asset owners fail closed',async t=>{
 for(const replay of [false,true])for(const kind of ['reference SQL','reference JSON','version SQL','version JSON','version job SQL','job SQL','job JSON','job shot','snapshot reference','snapshot connection node'])await t.test(`${replay?'replay':'fresh'} ${kind}`,async t=>{
  const f=await fixture(t),{node}=await f.image(),reference=f.asset();let shot=await f.shot();
  const generated=await f.generated(shot,[reference.id]);shot=f.store.get('shots',shot.id)!;
  const input=attach(f,node,shot);if(replay)await f.call('reference.attach',input);
  const foreign=await f.image({projectId:f.otherId,name:'FOREIGN_SECRET'});
  if(kind==='reference SQL')f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.otherId,reference.id);
  if(kind==='reference JSON')f.store.db.prepare("UPDATE assets SET data=json_set(data,'$.projectId',?) WHERE id=?").run(f.otherId,reference.id);
  if(kind.startsWith('version')){
   f.store.db.exec('DROP TRIGGER immutable_versions');
   if(kind==='version SQL')f.store.db.prepare('UPDATE versions SET projectId=? WHERE id=?').run(f.otherId,generated.version.id);
   if(kind==='version JSON')f.store.db.prepare("UPDATE versions SET data=json_set(data,'$.projectId',?) WHERE id=?").run(f.otherId,generated.version.id);
   if(kind==='version job SQL'){const job=f.store.put('jobs',{...generated.job,id:randomUUID()});f.store.db.prepare('UPDATE versions SET jobId=? WHERE id=?').run(job.id,generated.version.id);}
  }
  if(kind==='job SQL')f.store.db.prepare('UPDATE jobs SET projectId=? WHERE id=?').run(f.otherId,generated.job.id);
  if(kind==='job JSON')f.store.db.prepare("UPDATE jobs SET data=json_set(data,'$.projectId',?) WHERE id=?").run(f.otherId,generated.job.id);
  if(kind==='job shot')f.store.put('jobs',{...generated.job,shotId:randomUUID()});
  if(kind==='snapshot reference')f.store.put('jobs',{...generated.job,snapshot:{...generated.job.snapshot,referenceAssetIds:[foreign.asset.id]}});
  if(kind==='snapshot connection node')f.store.put('jobs',{...generated.job,snapshot:{...generated.job.snapshot,referenceConnections:[{sourceNodeId:foreign.node.id,sourceAssetId:foreign.asset.id}]}});
  await rejected(f,'reference.attach',input);
 });
});

test('historical replay checks frozen selected lineage even after current shot selects another valid version',async t=>{
 const f=await fixture(t),{node}=await f.image();let shot=await f.shot();const old=await f.generated(shot);shot=f.store.get('shots',shot.id)!;
 const input=attach(f,node,shot),response=await f.call('reference.attach',input);
 const newer=await f.generated(response.shot);assert.notEqual(newer.version.id,old.version.id);
 assert.deepEqual(await f.call('reference.attach',input),response);
 f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.otherId,old.asset.id);
 await rejected(f,'reference.attach',input);
});

test('matching historical keys reject reassigned edges while absent detached edges remain valid',async t=>{
 const f=await fixture(t),{input}=await prepared(f,'reference.attach'),response=await f.call('reference.attach',input);
 f.store.db.prepare('UPDATE edges SET projectId=? WHERE id=?').run(f.otherId,response.edge.id);
 await rejected(f,'reference.attach',input);
 f.store.db.prepare('UPDATE edges SET projectId=? WHERE id=?').run(f.projectId,response.edge.id);
 const remove=detach(f,response.edge,response.shot),removed=await f.call('reference.detach',remove);
 assert.deepEqual(await f.call('reference.detach',remove),removed);
 const foreign=f.store.put('edges',{...response.edge,projectId:f.otherId});
 await rejected(f,'reference.detach',remove);assert.equal(foreign.id,response.edge.id);
});

test('pre-write business rejections get exact rollback-backed proof, including safe revision limits',async t=>{
 const f=await fixture(t),{node}=await f.image(),other=await f.image(),shot=await f.shot();
 await rejected(f,'reference.attach',attach(f,node,shot,{expectedSourceRevision:2}),{code:'REVISION_CONFLICT',proof:true});
 const text=await f.call('node.create',{projectId:f.projectId,type:'text',position:{x:0,y:0}});
 await rejected(f,'reference.attach',attach(f,text,shot),{code:'INVALID_REFERENCE_SOURCE',proof:true});
 const decorative=await f.call('edge.create',{projectId:f.projectId,source:node.id,target:shot.id});
 await rejected(f,'reference.detach',detach(f,decorative,shot),{code:'INVALID_REFERENCE_EDGE',proof:true});
 const selected=await f.shot({referenceAssetIds:[other.asset.id]});
 await rejected(f,'reference.attach',attach(f,node,selected),{code:'REFERENCE_SELECTION_EXISTS',proof:true});
 const added=await f.call('reference.attach',attach(f,node,shot));
 await rejected(f,'reference.attach',attach(f,other.node,added.shot),{code:'REFERENCE_CONNECTED',proof:true});
 await rejected(f,'reference.detach',detach(f,added.edge,shot),{code:'REVISION_CONFLICT',proof:true});
 f.store.put('shots',{...added.shot,referenceAssetIds:[node.assetId,other.asset.id]});
 await rejected(f,'reference.detach',detach(f,added.edge,added.shot),{code:'REFERENCE_STATE_CONFLICT'});
 const max={...added.shot,revision:Number.MAX_SAFE_INTEGER};f.store.put('shots',max);
 assert.equal((await f.call('reference.attach',attach(f,node,max))).shot.revision,Number.MAX_SAFE_INTEGER);
 await rejected(f,'reference.detach',detach(f,added.edge,max),{code:'REFERENCE_REVISION_LIMIT',proof:true});
 const empty=await f.shot();f.store.put('shots',{...empty,revision:Number.MAX_SAFE_INTEGER});
 await rejected(f,'reference.attach',attach(f,node,{...empty,revision:Number.MAX_SAFE_INTEGER}),{code:'REFERENCE_REVISION_LIMIT',proof:true});
});

test('combined malformed managed sources and foreign target or snapshot owners never produce proof',async t=>{
 for(const operation of ['reference.attach','reference.detach'])for(const replay of [false,true])for(const kind of ['target','snapshot'])await t.test(`${operation} ${replay?'replay':'fresh'} ${kind}`,async t=>{
  const f=await fixture(t),{input,asset,shot}=await prepared(f,operation);
  if(replay)await f.call(operation,input);
  f.store.put('assets',{...asset,relativePath:null});
  if(kind==='target')f.store.db.prepare('UPDATE shots SET projectId=? WHERE id=?').run(f.otherId,shot.id);
  else{
   const generated=await f.generated(f.store.get('shots',shot.id)!),foreign=f.asset({projectId:f.otherId,name:'FOREIGN_SECRET'});
   f.store.put('jobs',{...generated.job,snapshot:{...generated.job.snapshot,referenceAssetIds:[foreign.id]}});
  }
  await rejected(f,operation,input);
 });
});

test('receipt insert failures and post-write owner corruption roll back atomically without proof',async t=>{
 for(const operation of ['reference.attach','reference.detach'])for(const kind of ['receipt failure','receipt owner','domain owner'])await t.test(`${operation} ${kind}`,async t=>{
  const f=await fixture(t),{input,shot}=await prepared(f,operation);
  if(kind==='receipt failure')f.store.db.exec("CREATE TRIGGER fail_reference_receipt BEFORE INSERT ON reference_requests BEGIN SELECT RAISE(ABORT,'injected receipt failure');END;");
  else f.store.db.exec(`CREATE TRIGGER corrupt_reference_owner AFTER ${kind==='receipt owner'?'INSERT ON reference_requests':'UPDATE ON shots'} BEGIN UPDATE shots SET projectId='${f.otherId}' WHERE id='${shot.id}';END;`);
  await rejected(f,operation,input,{code:kind==='receipt failure'?null:'INVALID_REFERENCE_RECORD',writes:true});
 });
});

test('trigger-created extra bindings are rejected after domain and receipt writes',async t=>{
 for(const operation of ['reference.attach','reference.detach'])for(const when of ['domain','receipt'])await t.test(`${operation} ${when}`,async t=>{
  const f=await fixture(t),{input,node,asset,shot}=await prepared(f,operation),id=randomUUID();
  const edge={id,projectId:f.projectId,source:node.id,target:shot.id,kind:'reference',role:'first_frame',sourceAssetId:asset.id,createdAt:at};
  f.store.db.exec(`CREATE TRIGGER duplicate_reference AFTER ${when==='receipt'?'INSERT ON reference_requests':'UPDATE ON shots'} BEGIN
   INSERT INTO edges(id,projectId,data) VALUES('${id}','${f.projectId}','${JSON.stringify(edge)}');END;`);
  await rejected(f,operation,input,{writes:true});
 });
});

test('fresh no-op attach rolls back a receipt-triggered extra binding without releasing its key',async t=>{
 const f=await fixture(t),{input,node}=await prepared(f,'reference.attach'),original=await f.call('reference.attach',input);
 const noop=attach(f,node,original.shot),extra={...original.edge,id:randomUUID()};
 f.store.db.exec(`CREATE TRIGGER duplicate_noop_reference AFTER INSERT ON reference_requests BEGIN
  INSERT INTO edges(id,projectId,data) VALUES('${extra.id}','${f.projectId}','${JSON.stringify(extra)}');END;`);
 // This request writes only its receipt before the trigger fires. Even though
 // no domain write was intended, a failed receipt publication is never proof.
 await rejected(f,'reference.attach',noop,{writes:true});
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM reference_requests WHERE requestId=?').get(noop.requestId)!.n,0);
 assert.deepEqual(await f.call('reference.attach',input),original);
 f.store.db.exec('DROP TRIGGER duplicate_noop_reference');
 assert.deepEqual(await f.call('reference.attach',noop),original);
});

test('commit uncertainty, failed transaction entry and incomplete rollback never emit not-applied proof',async t=>{
 const f=await fixture(t),{input,node,shot}=await prepared(f,'reference.attach');
 const uncertain=(createServices(({...f.store,tx:(fn: () => unknown)=>{f.store.tx(fn);throw new AppError('REVISION_CONFLICT','Synthetic lost ACK',409);}} as unknown as Parameters<typeof createServices>[0]),new Map()) as TypedServices);
 await assert.rejects(uncertain.call('reference.attach',input),error=>(error as Failure).code==='REVISION_CONFLICT'&&(error as Failure).details?.mutationOutcome===undefined);
 const saved=JSON.parse((f.store.db.prepare('SELECT response FROM reference_requests WHERE requestId=?').get(input.requestId)!.response as string));
 f.restart();assert.deepEqual(await f.call('reference.attach',input),saved);
 const stale=attach(f,node,shot,{requestId:randomUUID(),expectedSourceRevision:2});
 const noEntry=(createServices(({...f.store,tx:()=>{throw new AppError('REVISION_CONFLICT','Transaction did not begin',409);}} as unknown as Parameters<typeof createServices>[0]),new Map()) as TypedServices);
 await rejected(f,'reference.attach',stale,{code:'REVISION_CONFLICT',call:(operation: string,input: unknown)=>noEntry.call(operation,input)});
 const failedRollback=(createServices(({...f.store,tx:(fn: () => unknown)=>{f.store.db.exec('BEGIN IMMEDIATE');return fn();}} as unknown as Parameters<typeof createServices>[0]),new Map()) as TypedServices);
 await rejected(f,'reference.attach',stale,{code:'REVISION_CONFLICT',call:(operation: string,input: unknown)=>failedRollback.call(operation,input)});
 assert.equal(f.store.db.isTransaction,true);f.store.db.exec('ROLLBACK');
 const replacedError=(createServices(({...f.store,tx:(fn: () => unknown)=>{try{return f.store.tx(fn);}catch{throw new AppError('REVISION_CONFLICT','Different transaction failure',409);}}} as unknown as Parameters<typeof createServices>[0]),new Map()) as TypedServices);
 await rejected(f,'reference.attach',stale,{code:'REVISION_CONFLICT',call:(operation: string,input: unknown)=>replacedError.call(operation,input)});
});

test('fixed through24 retention triggers bootstrap additively, preserve legacy bytes and block delete or replacement',async t=>{
 const f=await fixture(t,{open:openLegacyWorkspaceStore}),{input}=await prepared(f,'reference.attach'),response=await f.call('reference.attach',input);
 const legacy=['legacy-preserved-key','old-hash',' { "legacy": true, "spacing": "preserve" } '];
 f.store.db.prepare('INSERT INTO reference_requests VALUES(?,?,?)').run(...legacy);
 const schema=f.store.db.prepare('SELECT * FROM schema_version ORDER BY version').all(),saved=f.capture();
 f.store.db.exec('DROP TRIGGER reject_reference_request_replacement; DROP TRIGGER retain_reference_requests;');f.restart();
 assert.deepEqual(f.capture(),saved);assert.deepEqual(f.store.db.prepare('SELECT * FROM schema_version ORDER BY version').all(),schema);
 assert.equal(f.store.db.prepare('SELECT response FROM reference_requests WHERE requestId=?').get(legacy[0])!.response,legacy[2]);
 assert.deepEqual(await f.call('reference.attach',input),response);
 for(const sql of ['DELETE FROM reference_requests WHERE requestId=?','INSERT OR REPLACE INTO reference_requests VALUES(?,?,?)','INSERT INTO reference_requests VALUES(?,?,?) ON CONFLICT(requestId) DO NOTHING']){
  assert.throws(()=>f.store.db.prepare(sql).run(...(sql.startsWith('DELETE')?[input.requestId]:[input.requestId,'changed-hash','{}'])),/immutable|retained/);
  assert.deepEqual(f.capture(),saved);
 }
 const removed=await f.call('reference.detach',detach(f,response.edge,response.shot));assert.equal(removed.detached,true);
 const project=await f.call('project.create',{name:'Ordinary lifecycle'});assert.ok(project.id);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM reference_requests').get()!.n,3);
});

test('current52 startup refuses missing reference retention guards without repairing or rewriting retained evidence',async t=>{
 const f=await fixture(t),{input}=await prepared(f,'reference.attach');await f.call('reference.attach',input);
 f.store.db.prepare('INSERT INTO reference_requests VALUES(?,?,?)').run('legacy-preserved-key','old-hash',' { "legacy": true, "spacing": "preserve" } ');
 f.store.db.exec('DROP TRIGGER reject_reference_request_replacement; DROP TRIGGER retain_reference_requests;');
 const before=rawSnapshot(f.store.db);
 assert.throws(()=>f.restart(),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const db=new DatabaseSync(path.join(f.root,'workbench.sqlite'),{readOnly:true});
 try{assert.deepEqual(rawSnapshot(db),before,'all SQL, SQLite types, raw bytes, rowids, receipts and sequence survive strict refusal');}
 finally{db.close();}
});

test('schema-valid maximally escaped shots remain attachable and replayable within the receipt budget',async t=>{
 const f=await fixture(t),{node}=await f.image(),shot=await f.shot({title:'\0'.repeat(150),prompt:'\0'.repeat(5000),parameters:{seed:1e100},position:{x:1e300,y:-1e300}});
 const input=attach(f,node,shot),response=await f.call('reference.attach',input);
 assert.ok(Buffer.byteLength(JSON.stringify(response))>30000);assert.ok(Buffer.byteLength(JSON.stringify(response))<=REFERENCE_RESPONSE_BYTES);
 const receipt=f.store.db.prepare('SELECT response FROM reference_requests WHERE requestId=?').get(input.requestId)!.response;
 f.restart();assert.deepEqual(await f.call('reference.attach',input),response);
 assert.equal(f.store.db.prepare('SELECT response FROM reference_requests WHERE requestId=?').get(input.requestId)!.response,receipt);
});

test('independent SQLite writers return one exact receipt and competing fresh keys get pre-write proof',async t=>{
 const f=await fixture(t),{input,node}=await prepared(f,'reference.attach');
 const source=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {openStore}=await import(workerData.db);const {createServices}=await import(workerData.services);const store=openStore(workerData.root,{lock:false});parentPort.postMessage({ready:true});parentPort.once('message',async()=>{try{parentPort.postMessage({response:await createServices(store,new Map()).call(workerData.operation,workerData.input)});}catch(error){parentPort.postMessage({code:error.code,details:error.details});}finally{store.close();}});})();`;
 async function race(operation: string,inputs: unknown[]){
  const workers=inputs.map((input: unknown)=>new Worker(source,{eval:true,workerData:{root:f.root,operation,input,db:new URL('../packages/business/src/db.ts',import.meta.url).href,services:new URL('../packages/business/src/services.ts',import.meta.url).href}}));
  t.after(()=>Promise.all(workers.map((worker: Worker)=>worker.terminate())));
  await Promise.all(workers.map((worker: Worker)=>new Promise<{response?:{edge:MediaEdge;shot:MediaShot};code?:string;details:{mutationOutcome:string}}>((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);})));const pending=workers.map((worker: Worker)=>new Promise<{response?:{edge:MediaEdge;shot:MediaShot};code?:string;details:{mutationOutcome:string}}>((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}));
  workers.forEach((worker: Worker)=>worker.postMessage('go'));return Promise.all(pending);
 }
 const results=await race('reference.attach',[input,input]);assert.ok(results[0].response);assert.deepEqual(results[0].response,results[1].response);
 const {edge,shot}=results[0].response,remove=detach(f,edge,shot),released=await race('reference.detach',[remove,remove]);
 assert.ok(released[0].response);assert.deepEqual(released[0].response,released[1].response);
 const other=await f.image(),competitors=await race('reference.attach',[node,other.node].map((node: Pick<MediaNode,'id'|'revision'>)=>attach(f,node,released[0].response!.shot)));
 assert.equal(competitors.filter(x=>x.response).length,1);const error=competitors.find(x=>x.code);
 assert.equal(error!.code,'REVISION_CONFLICT');assert.equal(error!.details.mutationOutcome,'not_applied');
 assert.equal(f.store.list('edges').length,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM reference_requests').get()!.n,3);
});
