import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {validateWorkspaceSchema60} from '../packages/business/src/workspace-schema-v60.ts';
import {assertTimelineVolumeEnvelopeWorkspace} from '../packages/business/src/timeline-volume-envelope-admission.ts';
import {initializeFrozenUpgradeFixtureSchema} from './helpers/opacity-upgrade-fixture.ts';
import {hash} from '../packages/business/src/services.ts';
import {VOLUME_ENVELOPE_PROFILE as profileId} from '../packages/contracts/src/timeline-volume-envelope.ts';
const id='11111111-1111-4111-8111-111111111111';
const points=()=>[{frame:0,multiplier:1},{frame:20,multiplier:.5}];
const add=()=>({projectId:id,expectedRevision:1,requestId:'live-envelope-request',assetId:id,trackId:id,startFrame:0,durationFrames:20,volumeEnvelope:{profileId,points:points()}});
const update=()=>({projectId:id,expectedRevision:1,requestId:'live-envelope-request',clipId:id,patch:{volumeEnvelope:{profileId,points:points()}}});
function fixture(t,{seedProject=false}={}){
 // Approved disposable synthetic fixture, confined to this isolated checkout.
 const root=mkdtempSync(path.join(process.cwd(),'.tmp-envelope-ingress-')),store=openStore(root);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const tasks=createEditTasks({store,services:{call(){throw Error('Preparation must never dispatch.');}}});
 if(seedProject){
  store.put('projects',{id,name:'Synthetic ingress',description:'',revision:1});
  store.put('assets',{id,projectId:id,name:'Synthetic audio',mimeType:'audio/wav',duration:2,hasAudio:true,provenance:'user-import',sha256:'a'.repeat(64),relativePath:'media/synthetic.wav',createdAt:'2026-10-15T00:00:00.000Z'});
  validateWorkspaceSchema60(store.db);
 }
 const prepare=(operation,input)=>tasks.prepare({projectId:id,operation,input,origin:'new'});
 const state=()=>({changes:store.db.prepare('SELECT total_changes() AS n').get().n,rows:store.db.prepare('SELECT count(*) AS n FROM edit_tasks').get().n});
 return {store,tasks,prepare,state};
}
test('frozen old38 admission refuses both typed paths and explicit null before any durable insert',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());initializeFrozenUpgradeFixtureSchema(db,38);
 assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v,38);
 for(const operation of ['timeline.clip.add','timeline.clip.update'])for(const value of [null,{profileId,points:points()}]){
  const input=operation.endsWith('.add')?add():update();(input.patch??input).volumeEnvelope=value;const before=db.prepare('SELECT total_changes() AS n').get().n;
  assert.throws(()=>assertTimelineVolumeEnvelopeWorkspace(db,input),{code:'TIMELINE_VOLUME_ENVELOPE_WORKSPACE_REQUIRED'});
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n,before);assert.equal(db.prepare('SELECT count(*) n FROM edit_tasks').get().n,0);
 }
});
test('frozen ordinary40 still admits valid envelope evidence without acquiring execution authority',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());initializeFrozenUpgradeFixtureSchema(db,40);
 const before=db.prepare('SELECT total_changes() AS n').get().n;
 for(const input of [add(),update()])assert.doesNotThrow(()=>assertTimelineVolumeEnvelopeWorkspace(db,input));
 assert.equal(db.prepare('SELECT total_changes() AS n').get().n,before);assert.equal(db.prepare('SELECT count(*) n FROM edit_tasks').get().n,0);
});
test('outer prepare and nested point capture execute zero getter/proxy traps',t=>{
 const f=fixture(t);let calls=0;const get=()=>{calls++;throw Error('Untrusted getter or trap executed.');};
 const handler={get,getPrototypeOf:get,ownKeys:get,getOwnPropertyDescriptor:get};
 const bad=input=>{const before=f.state();assert.throws(()=>f.prepare('timeline.clip.add',input),{code:'EDIT_TASK_VALIDATION'});assert.deepEqual(f.state(),before);};
 bad(new Proxy(add(),handler));bad({...add(),volumeEnvelope:new Proxy(add().volumeEnvelope,handler)});bad({...add(),volumeEnvelope:{profileId,points:new Proxy(points(),handler)}});
 const root=add();Object.defineProperty(root,'volumeEnvelope',{enumerable:true,get});bad(root);
 const point={frame:0};Object.defineProperty(point,'multiplier',{enumerable:true,get});bad({...add(),volumeEnvelope:{profileId,points:[point]}});
 const array=points();Object.defineProperty(array,'0',{enumerable:true,get});bad({...add(),volumeEnvelope:{profileId,points:array}});
 const shell={projectId:id,input:add(),origin:'new'};Object.defineProperty(shell,'operation',{enumerable:true,get});assert.throws(()=>f.tasks.prepare(shell),{code:'EDIT_TASK_VALIDATION'});
 assert.throws(()=>f.tasks.prepare(new Proxy({projectId:id,operation:'timeline.clip.add',input:add(),origin:'new'},handler)),{code:'EDIT_TASK_VALIDATION'});
 assert.equal(calls,0);
});
test('typed arrays do not relax unrelated paths, malformed Unicode or the 128-node/depth8 budgets',t=>{
 const f=fixture(t),bad=input=>assert.throws(()=>f.prepare('timeline.clip.add',input),{code:'EDIT_TASK_VALIDATION'});
 for(const points of [[],new Array(2),Object.assign([{frame:0,multiplier:1}],{extra:1}),Object.setPrototypeOf([{frame:0,multiplier:1}],null),[[0,1]]])bad({...add(),volumeEnvelope:{profileId,points}});
 for(const key of ['rect','name','gain','assetId','unexpected'])bad({...add(),[key]:[]});
 for(const multiplier of [-0,NaN,Infinity,undefined,Symbol('x')])bad({...add(),volumeEnvelope:{profileId,points:[{frame:0,multiplier}]}});
 bad({...add(),name:'\ud800'});bad({...add(),unexpected:undefined});
 const symbol=add();symbol[Symbol('key')]=1;bad(symbol);
 const nodes=add();nodes.unexpected=Object.fromEntries(Array.from({length:128},(_,n)=>['n'+n,0]));bad(nodes);
 const deep=add();deep.unexpected={};let cursor=deep.unexpected;for(let n=0;n<9;n++)cursor=cursor.next={};bad(deep);
 assert.equal(f.state().rows,0);
});

test('owned ordinary58 coordinator captures both exact points paths and production hashes without dispatch',t=>{
 for(const operation of ['timeline.clip.add','timeline.clip.update']){
  const f=fixture(t,{seedProject:true}),input=operation.endsWith('.add')?add():update(),original=JSON.parse(JSON.stringify(input));
  const saved=f.prepare(operation,input);assert.deepEqual(saved.task.input,original);
  assert.equal(saved.task.digest,hash({operation,input:original}));
  const row=f.store.db.prepare('SELECT input,digest FROM edit_tasks WHERE id=?').get(saved.task.id);
  assert.equal(row.input,JSON.stringify(original));assert.equal(row.digest,saved.task.digest);
  (input.patch??input).volumeEnvelope.points[1].multiplier=.75;
  assert.deepEqual(saved.task.input,original,'capture is detached before schema, hash and persistence');
  const reread=f.tasks.get({projectId:id,taskId:saved.task.id});assert.deepEqual(reread.task.input,original);assert.equal(reread.task.digest,row.digest);
  assert.deepEqual(f.prepare(operation,original),saved,'exact duplicate prepare returns retained identity');
  assert.throws(()=>f.prepare(operation,input),{code:'EDIT_TASK_CONFLICT'});
  assert.equal(f.state().rows,1);
 }
});
test('real live coordinator construction admits validated58 without insertion or dispatch',t=>{
 const f=fixture(t,{seedProject:true}),before=f.state();
 assert.doesNotThrow(()=>createEditTasks({store:f.store,services:{call(){throw Error('Must not dispatch.');}}}));
 assert.deepEqual(f.state(),before);
});
