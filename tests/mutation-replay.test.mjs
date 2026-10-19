import test from 'node:test';
import {openLegacyWorkspaceStore} from './helpers/legacy-workspace-store.ts';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../packages/business/src/db.ts';
import {initializeLegacyWorkspaceSchema} from '../packages/business/src/workspace-fixed-schema.ts';
import {createServices,canonical} from '../packages/business/src/services.ts';
import {createMutationReplay} from '../packages/business/src/mutation-replay.ts';
import {AppError} from '@mioon/contracts';

async function fixture(t,{open=openStore}={}) {
 const root=await mkdtemp(path.join(tmpdir(),'mioon-mutation-'));
 let store=open(root),services=createServices(store,new Map());
 const f={root,get store(){return store;},get services(){return services;},
  call:(op,input)=>services.call(op,input),
  restart(){store.close();store=openStore(root);services=createServices(store,new Map());},
  asset(projectId,mimeType='image/png'){
   return store.put('assets',{id:randomUUID(),projectId,name:'Local fixture',mimeType,sha256:'a'.repeat(64),relativePath:'media/fixture',url:'/media/fixture'});
  },
  async shot(projectId,fields={}){return f.call('shot.create',{projectId,title:'Shot',...fields});},
  async node(projectId,fields={}){return f.call('node.create',{projectId,type:'text',position:{x:0,y:0},...fields});},
  version(shot){
   const asset=f.asset(shot.projectId,'video/mp4'),jobId=randomUUID(),id=randomUUID();
   store.put('jobs',{id:jobId,projectId:shot.projectId,shotId:shot.id,status:'succeeded',versionId:id});
   return store.put('versions',{id,projectId:shot.projectId,shotId:shot.id,jobId,assetId:asset.id,number:1});
  },
 };
 f.project=await f.call('project.create',{name:'Local mutations'});
 f.other=await f.call('project.create',{name:'Foreign private project'});
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 return f;
}
function capture(f,omit=[]) {
 return Object.fromEntries(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  .filter(({name})=>!omit.includes(name)).map(({name})=>[name,f.store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
}
const journal=f=>f.store.db.prepare('SELECT * FROM mutation_requests ORDER BY requestId').all();
const changes=f=>f.store.db.prepare('SELECT total_changes() AS n').get().n;
// These fixtures deliberately characterize the six legacy optional-key operations.
// The required-key source-range extension has its own replay/collision matrix.
const LEGACY_OPERATIONS=['shot.create','shot.update','shot.reorder','node.create','node.update','version.select'];
const key=()=>randomUUID();
const conflict=error=>error.code==='IDEMPOTENCY_CONFLICT'&&error.status===409&&!Object.hasOwn(error.details,'mutationOutcome');
function corrupt(f,table,id,patch={},columns={}) {
 if(table==='versions')f.store.db.exec('DROP TRIGGER IF EXISTS immutable_versions');
 const record={...f.store.get(table,id),...patch};
 f.store.db.prepare(`UPDATE ${table} SET data=?${Object.keys(columns).map(k=>`,${k}=?`).join('')} WHERE id=?`)
  .run(JSON.stringify(record),...Object.values(columns),id);
}
async function inputFor(f,operation) {
 const projectId=f.project.id,requestId=key();
 if(operation==='shot.create')return {projectId,title:'Created once',requestId};
 if(operation==='node.create')return {projectId,type:'text',position:{x:10,y:20},requestId};
 if(operation==='node.update'){const node=await f.node(projectId);return {nodeId:node.id,expectedRevision:node.revision,patch:{label:'Saved label'},requestId};}
 const shot=await f.shot(projectId);
 if(operation==='shot.update')return {shotId:shot.id,expectedRevision:shot.revision,patch:{title:'Saved title'},requestId};
 if(operation==='version.select'){const version=f.version(shot);return {shotId:shot.id,versionId:version.id,expectedRevision:shot.revision,requestId};}
 return {projectId,expectedRevision:f.store.get('projects',projectId).revision,shotIds:[shot.id],requestId};
}
async function advance(f,operation,response) {
 if(operation==='shot.reorder')await f.shot(f.project.id,{title:'A later shot'});
 else if(operation.startsWith('node.'))await f.call('node.update',{nodeId:response.id,expectedRevision:response.revision,patch:{text:'A later edit'}});
 else await f.call('shot.update',{shotId:response.id,expectedRevision:response.revision,patch:{prompt:'A later edit'}});
}

for(const operation of LEGACY_OPERATIONS)test(`${operation}: immutable exact response replays before current revision checks without writes, including restart`,async t=>{
 const f=await fixture(t),input=await inputFor(f,operation),response=await f.call(operation,input);
 assert.ok(!Object.hasOwn(response,'requestId'));
 const row=journal(f)[0];assert.equal(row.operation,operation);assert.equal(row.projectId,f.project.id);
 assert.deepEqual(JSON.parse(row.response),response);
 const {requestId,...fields}=input;assert.equal(row.canonicalInput,canonical(fields));
 await advance(f,operation,response);f.restart();
 const before=capture(f),writes=changes(f);
 for(let i=0;i<3;i++)assert.deepEqual(await f.call(operation,JSON.parse(JSON.stringify(input))),response);
 assert.equal(changes(f),writes);assert.deepEqual(capture(f),before);assert.equal(journal(f).length,1);
 if(operation.endsWith('create'))assert.equal(f.store.list(operation.startsWith('node')?'nodes':'shots',f.project.id).length,1);
});

for(const operation of LEGACY_OPERATIONS)test(`${operation}: journal insertion failure rolls the business mutation back atomically`,async t=>{
 const f=await fixture(t),input=await inputFor(f,operation),before=capture(f);
 f.store.db.exec("CREATE TRIGGER reject_mutation_receipt BEFORE INSERT ON mutation_requests BEGIN SELECT RAISE(ABORT,'injected journal failure');END;");
 await assert.rejects(f.call(operation,input),/injected journal failure/);
 assert.equal(f.store.db.isTransaction,false);assert.deepEqual(capture(f),before);
 f.store.db.exec('DROP TRIGGER reject_mutation_receipt');
 const response=await f.call(operation,input);assert.deepEqual(await f.call(operation,input),response);assert.equal(journal(f).length,1);
});

test('key binding rejects changed operation, project, optional fields, revision, and payload without leaking the prior response',async t=>{
 const f=await fixture(t),input={projectId:f.project.id,title:'Secret original',requestId:key()};
 await f.call('shot.create',input);
 const before=capture(f),writes=changes(f);
 for(const changed of [{...input,title:'Changed'},{...input,projectId:f.other.id},{...input,prompt:''},{...input,referenceAssetIds:[]},{...input,parameters:{}},{...input,position:{x:80,y:100}}])
  await assert.rejects(f.call('shot.create',changed),conflict);
 await assert.rejects(f.call('node.create',{projectId:f.project.id,type:'text',position:{x:0,y:0},requestId:input.requestId}),conflict);
 assert.deepEqual(capture(f),before);assert.equal(changes(f),writes);
 const update=await inputFor(f,'shot.update');await f.call('shot.update',update);
 await assert.rejects(f.call('shot.update',{...update,expectedRevision:2}),conflict);
 await assert.rejects(f.call('shot.update',{...update,patch:{title:'Other title'}}),conflict);
 const reordered={requestId:update.requestId,patch:{title:'Saved title'},expectedRevision:update.expectedRevision,shotId:update.shotId};
 assert.deepEqual(await f.call('shot.update',reordered),JSON.parse(journal(f).find(r=>r.requestId===update.requestId).response));
});

test('keyless legacy calls create distinct IDs, retain original fields, and require fresh revisions',async t=>{
 const f=await fixture(t),projectId=f.project.id;
 const a=await f.shot(projectId),b=await f.shot(projectId);assert.notEqual(a.id,b.id);
 assert.deepEqual(Object.keys(a),['id','projectId','title','prompt','referenceAssetIds','aspectRatio','duration','parameters','position','orderIndex','revision','selectedVersionId','createdAt','updatedAt']);
 const na=await f.node(projectId),nb=await f.node(projectId);assert.notEqual(na.id,nb.id);
 assert.deepEqual(Object.keys(na),['id','projectId','type','position','label','text','revision','createdAt']);
 for(const [operation,input] of [['shot.update',{shotId:a.id,expectedRevision:1,patch:{prompt:'Changed'}}],['node.update',{nodeId:na.id,expectedRevision:1,patch:{}}]]){
  await f.call(operation,input);
  await assert.rejects(f.call(operation,input),error=>error.code==='REVISION_CONFLICT'&&!Object.hasOwn(error.details,'mutationOutcome'));
 }
 let project=f.store.get('projects',projectId);
 const order={projectId,shotIds:[b.id,a.id],expectedRevision:project.revision};project=await f.call('shot.reorder',order);
 await assert.rejects(f.call('shot.reorder',order),{code:'REVISION_CONFLICT'});
 assert.equal((await f.call('shot.reorder',{...order,expectedRevision:project.revision})).revision,project.revision+1);
 const version=f.version(b),selection={shotId:b.id,versionId:version.id,expectedRevision:b.revision};
 const selected=await f.call('version.select',selection);
 await assert.rejects(f.call('version.select',selection),{code:'REVISION_CONFLICT'});
 assert.equal((await f.call('version.select',{...selection,expectedRevision:selected.revision})).revision,selected.revision+1);
 assert.deepEqual(journal(f),[]);
});

test('requestId is never persisted on a node, and text-node asset IDs still require same-project ownership',async t=>{
 const f=await fixture(t),requestId=key();
 const node=await f.node(f.project.id,{requestId});
 assert.ok(!Object.hasOwn(node,'requestId'));assert.ok(!Object.hasOwn(f.store.get('nodes',node.id),'requestId'));
 const foreign=f.asset(f.other.id),before=capture(f);
 for(const type of ['text','image'])await assert.rejects(f.node(f.project.id,{type,assetId:foreign.id,requestId:key()}),{code:'CROSS_PROJECT_REFERENCE'});
 assert.deepEqual(capture(f),before);
});

test('fresh-key definite rollback proof is bound to the request; receipt conflicts and replay failures never carry it',async t=>{
 const f=await fixture(t),input=await inputFor(f,'shot.update');
 await f.call('shot.update',{...input,requestId:undefined});
 await assert.rejects(f.call('shot.update',input),error=>error.code==='REVISION_CONFLICT'&&error.details.mutationOutcome==='not_applied'&&error.details.requestId===input.requestId);
 assert.equal(journal(f).length,0);
 const current=f.store.get('shots',input.shotId),fresh={...input,expectedRevision:current.revision};await f.call('shot.update',fresh);
 await assert.rejects(f.call('shot.update',input),conflict);
 f.store.db.prepare('DELETE FROM shots WHERE id=?').run(input.shotId);
 await assert.rejects(f.call('shot.update',fresh),error=>error.code==='NOT_FOUND'&&!Object.hasOwn(error.details,'mutationOutcome'));
 assert.equal(journal(f).length,1);
});

for(const operation of ['shot.create','shot.update','node.create','node.update','version.select','shot.reorder'])test(`${operation}: a retained receipt does not return a deleted or reassigned target`,async t=>{
 const f=await fixture(t),input=await inputFor(f,operation),response=await f.call(operation,input);
 const table=operation.startsWith('node')?'nodes':'shots';
 const id=operation==='shot.reorder'?input.shotIds[0]:response.id;
 const original=f.store.get(table,id);
 // Changing both ownership copies must not let the old receipt disclose data.
 corrupt(f,table,id,{projectId:f.other.id},{projectId:f.other.id});
 const before=capture(f);
 await assert.rejects(f.call(operation,input),error=>['IDEMPOTENCY_CONFLICT','CROSS_PROJECT_REFERENCE'].includes(error.code)&&!Object.hasOwn(error.details,'mutationOutcome'));
 assert.deepEqual(capture(f),before);
 corrupt(f,table,id,original,{projectId:original.projectId});
 f.store.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
 await assert.rejects(f.call(operation,input),error=>error.code==='NOT_FOUND'&&!Object.hasOwn(error.details,'mutationOutcome'));
 assert.equal(journal(f).length,1);
});

test('missing projects and records fail without creating receipts or leaking saved data',async t=>{
 const f=await fixture(t),before=capture(f);
 const inputs={
  'shot.create':{projectId:randomUUID(),title:'Missing'},
  'node.create':{projectId:randomUUID(),type:'text',position:{x:0,y:0}},
  'shot.update':{shotId:randomUUID(),expectedRevision:1,patch:{title:'Missing'}},
  'node.update':{nodeId:randomUUID(),expectedRevision:1,patch:{}},
  'shot.reorder':{projectId:randomUUID(),expectedRevision:1,shotIds:[]},
  'version.select':{shotId:randomUUID(),versionId:randomUUID(),expectedRevision:1},
 };
 for(const [operation,input] of Object.entries(inputs))await assert.rejects(f.call(operation,{...input,requestId:key()}),{code:'NOT_FOUND'});
 assert.deepEqual(capture(f),before);
});

test('foreign and corrupt asset, shot, version and job relations fail before current record disclosure',async t=>{
 const f=await fixture(t),shot=await f.shot(f.project.id),foreignAsset=f.asset(f.other.id);
 const node=await f.node(f.project.id),version=f.version(shot);
 for(const [operation,input] of [
  ['shot.create',{projectId:f.project.id,title:'Invalid',referenceAssetIds:[foreignAsset.id]}],
  ['shot.update',{shotId:shot.id,expectedRevision:99,patch:{referenceAssetIds:[foreignAsset.id]}}],
  ['shot.reorder',{projectId:f.project.id,expectedRevision:1,shotIds:[(await f.shot(f.other.id)).id]}],
 ])await assert.rejects(f.call(operation,{...input,requestId:key()}),error=>error.code==='CROSS_PROJECT_REFERENCE'&&!Object.hasOwn(error.details,'current'));
 const cases=[
  ['shots',shot.id,{projectId:f.other.id},{}],
  ['shots',shot.id,{referenceAssetIds:[foreignAsset.id]},{}],
  ['nodes',node.id,{assetId:foreignAsset.id},{}],
  ['versions',version.id,{projectId:f.other.id},{}],
  ['versions',version.id,{assetId:foreignAsset.id},{}],
  ['versions',version.id,{shotId:randomUUID()},{}],
  ['versions',version.id,{jobId:randomUUID()},{}],
  ['jobs',version.jobId,{projectId:f.other.id},{}],
  ['jobs',version.jobId,{shotId:randomUUID()},{}],
 ];
 for(const [table,id,patch,columns] of cases){
  const original=f.store.get(table,id);corrupt(f,table,id,patch,columns);
  const before=capture(f);
  const operation=table==='nodes'?'node.update':'version.select';
  const input=table==='nodes'?{nodeId:node.id,expectedRevision:99,patch:{label:'Changed'}}:{shotId:shot.id,versionId:version.id,expectedRevision:99};
  await assert.rejects(f.call(operation,{...input,requestId:key()}),error=>['CROSS_PROJECT_REFERENCE','INVALID_MUTATION_RECORD','INVALID_VERSION'].includes(error.code)&&!Object.hasOwn(error.details,'current'));
  assert.deepEqual(capture(f),before);corrupt(f,table,id,original);
 }
 f.store.db.prepare('UPDATE nodes SET data=? WHERE id=?').run('{broken',node.id);
 await assert.rejects(f.call('node.update',{nodeId:node.id,expectedRevision:1,patch:{},requestId:key()}),{code:'INVALID_MUTATION_RECORD'});
 assert.equal(journal(f).length,0);
});

test('shared reference guard still rejects direct reference edits and leaves every existing journal untouched',async t=>{
 const f=await fixture(t),asset=f.asset(f.project.id),node=await f.node(f.project.id,{type:'image',assetId:asset.id}),shot=await f.shot(f.project.id);
 const attached=await f.call('reference.attach',{projectId:f.project.id,sourceNodeId:node.id,targetShotId:shot.id,expectedSourceRevision:1,expectedShotRevision:1,requestId:key(),role:'first_frame'});
 const before=capture(f);
 await assert.rejects(f.call('shot.update',{shotId:shot.id,expectedRevision:attached.shot.revision,patch:{referenceAssetIds:[]},requestId:key()}),{code:'REFERENCE_CONNECTED'});
 assert.deepEqual(capture(f),before);
});

test('journal entries cannot be updated, deleted or replaced and retain exact response bytes',async t=>{
 const f=await fixture(t),input=await inputFor(f,'shot.create');await f.call('shot.create',input);
 const before=journal(f);
 assert.throws(()=>f.store.db.prepare('UPDATE mutation_requests SET response=? WHERE requestId=?').run('{}',input.requestId),/immutable/);
 assert.throws(()=>f.store.db.prepare('DELETE FROM mutation_requests WHERE requestId=?').run(input.requestId),/retained/);
 const row=before[0];
 assert.throws(()=>f.store.db.prepare('INSERT OR REPLACE INTO mutation_requests VALUES(?,?,?,?,?)').run(row.requestId,row.operation,row.projectId,row.canonicalInput,'{}'),/immutable/);
 assert.deepEqual(journal(f),before);f.restart();assert.deepEqual(journal(f),before);
});

test('additive first migration and repeated startup preserve old rows and journal response bytes',async t=>{
 const seed=await fixture(t,{open:openLegacyWorkspaceStore}),projectId=seed.project.id;
 await seed.shot(projectId);await seed.node(projectId);
 const root=await mkdtemp(path.join(tmpdir(),'mioon-mutation-schema8-'));
 let store=null,db=new DatabaseSync(path.join(root,'workbench.sqlite'));
 t.after(async()=>{store?.close();if(db.isOpen)db.close();await rm(root,{recursive:true,force:true});});
 db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
 // Execute the frozen constructor only through its real schema8 boundary.
 // Removing schema9 from a completed schema24 leaves later reciprocal guards
 // behind and fabricates a historical catalog that never existed.
 const boundary=new Error('schema9 not installed');
 assert.throws(()=>initializeLegacyWorkspaceSchema({exec(sql){
  if(sql.includes('CREATE TABLE IF NOT EXISTS mutation_requests('))throw boundary;
  return db.exec(sql);
 }}),error=>error===boundary);
 assert.equal(db.isTransaction,false);
 assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[1,2,3,4,5,6,7,8]);
 assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='mutation_requests'").get(),undefined);
 for(const table of ['projects','shots','nodes'])for(const row of seed.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()){
  const columns=Object.keys(row);db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values(row));
 }
 for(const table of ['timeline_requests','reference_requests'])db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(key(),'old-hash',' { "legacy": true, "spacing": "preserve" } ');
 db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run('generation',key(),'legacy-hash',randomUUID());
 const f={get store(){return {db};}},before=capture(f,['schema_version']);
 const restart=()=>{if(store)store.close();else db.close();store=openStore(root);db=store.db;};
 restart();const after=capture(f);
 for(const [table,rows]of Object.entries(before))assert.deepEqual(after[table],rows,`${table} retains its original row bytes`);
 for(const table of ['project_lut_resources','lut_import_requests','asset_annotations','asset_annotation_requests'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 assert.deepEqual(journal(f),[]);assert.ok(db.prepare('SELECT version FROM schema_version WHERE version=9').get());
 const migrated=capture(f);restart();assert.deepEqual(capture(f),migrated);
});

test('transactions reject async work and nesting, roll back thenables and remain usable afterward',async t=>{
 const f=await fixture(t),before=capture(f);let entered=false;
 assert.throws(()=>f.store.tx(async()=>{entered=true;f.store.put('projects',{...f.project,name:'Async'});}),/synchronous/);assert.equal(entered,false);
 assert.throws(()=>f.store.tx(()=>{f.store.put('projects',{...f.project,name:'Promise'});return Promise.resolve('too late');}),/synchronous/);
 assert.deepEqual(capture(f),before);
 assert.throws(()=>f.store.tx(()=>{f.store.put('projects',{...f.project,name:'Nested'});return f.store.tx(()=>42);}),/Nested transactions/);
 assert.deepEqual(capture(f),before);assert.equal(f.store.db.isTransaction,false);
 f.store.db.exec('BEGIN IMMEDIATE');assert.throws(()=>f.store.tx(()=>42),/Nested transactions/);assert.equal(f.store.db.isTransaction,true);f.store.db.exec('ROLLBACK');
 const mutate=createMutationReplay(f.store,{canonical});
 const base={resolve:()=>({projectId:f.project.id}),apply:()=>f.project,replay:()=>{}};
 for(const name of ['resolve','validate','apply','replay'])assert.throws(()=>mutate('shot.create',{requestId:key()},{...base,[name]:async()=>{entered=true;}}),/synchronous/);
 assert.equal(entered,false);assert.deepEqual(capture(f),before);
 assert.throws(()=>mutate('shot.create',{requestId:key()},{...base,apply:()=>{f.store.put('projects',{...f.project,name:'Thenable'});return {then(){}};}}),/synchronous/);
 assert.deepEqual(capture(f),before);assert.equal(f.store.tx(()=>42),42);
});

test('rollback proof never upgrades an unknown/internal error or an authorization-style AppError',async t=>{
 const f=await fixture(t),mutate=createMutationReplay(f.store,{canonical}),before=capture(f);
 for(const error of [new Error('internal detail'),new AppError('AUTHORIZATION_DENIED','Denied',403)]){
  assert.throws(()=>mutate('shot.create',{requestId:key()},{resolve:()=>({projectId:f.project.id}),apply:()=>{throw error;},replay:()=>{}}),caught=>caught===error&&!caught.details?.mutationOutcome);
 }
 assert.deepEqual(capture(f),before);
});


test('missing indirect version, asset or job records reject fresh writes and retained replies atomically',async t=>{
 for(const relation of ['version','asset','job']){
  const f=await fixture(t),input=await inputFor(f,'version.select');
  await f.call('version.select',input);
  const version=f.store.get('versions',input.versionId);
  const [table,id]=relation==='version'?['versions',version.id]:relation==='asset'?['assets',version.assetId]:['jobs',version.jobId];
  f.store.db.exec('PRAGMA foreign_keys=OFF');f.store.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);f.store.db.exec('PRAGMA foreign_keys=ON');
  const before=capture(f);
  await assert.rejects(f.call('version.select',input),error=>error.code==='NOT_FOUND'&&!Object.hasOwn(error.details,'mutationOutcome'));
  await assert.rejects(f.call('version.select',{...input,requestId:key()}),{code:'NOT_FOUND'});
  assert.deepEqual(capture(f),before);
 }
});

test('retained responses require the original project still to exist and to retain consistent identity',async t=>{
 const f=await fixture(t),input=await inputFor(f,'node.create');await f.call('node.create',input);
 corrupt(f,'projects',f.project.id,{id:f.other.id});
 await assert.rejects(f.call('node.create',input),error=>error.code==='INVALID_MUTATION_RECORD'&&!Object.hasOwn(error.details,'mutationOutcome'));
 corrupt(f,'projects',f.project.id,f.project);
 f.store.db.exec('PRAGMA foreign_keys=OFF');f.store.db.prepare('DELETE FROM projects WHERE id=?').run(f.project.id);f.store.db.exec('PRAGMA foreign_keys=ON');
 const before=capture(f);
 await assert.rejects(f.call('node.create',input),error=>error.code==='NOT_FOUND'&&!Object.hasOwn(error.details,'mutationOutcome'));
 assert.deepEqual(capture(f),before);
});

test('mutation replay helper and durable operation constraint cannot expand the six-operation allowlist',async t=>{
 const f=await fixture(t),mutate=createMutationReplay(f.store,{canonical}),before=capture(f);let called=false;
 for(const operation of ['project.create','asset.import','edge.create','generation.submit']){
  assert.throws(()=>mutate(operation,{requestId:key()},{resolve:()=>{called=true;return {projectId:f.project.id};},apply:()=>f.project,replay:()=>{}}),{code:'UNKNOWN_OPERATION'});
  assert.throws(()=>f.store.db.prepare('INSERT INTO mutation_requests VALUES(?,?,?,?,?)').run(key(),operation,f.project.id,'{}','{}'),/CHECK constraint/);
 }
 assert.equal(called,false);assert.deepEqual(capture(f),before);
});


test('foreign version selection preserves legacy INVALID_VERSION without exposing or decoding foreign data',async t=>{
 const f=await fixture(t),shot=await f.shot(f.project.id),other=await f.shot(f.other.id),version=f.version(other);
 const input={shotId:shot.id,versionId:version.id,expectedRevision:shot.revision};
 const before=capture(f);
 for(const supplied of [input,{...input,requestId:key()}])await assert.rejects(f.call('version.select',supplied),error=>error.code==='INVALID_VERSION'&&error.status===400&&!Object.hasOwn(error.details,'current')&&!Object.hasOwn(error.details,'mutationOutcome'));
 assert.deepEqual(capture(f),before);
 f.store.db.exec('DROP TRIGGER immutable_versions');
 f.store.db.prepare('UPDATE versions SET data=? WHERE id=?').run('{foreign-unreadable',version.id);
 const corruptBefore=capture(f);
 await assert.rejects(f.call('version.select',{...input,requestId:key()}),{code:'INVALID_VERSION'});
 assert.deepEqual(capture(f),corruptBefore);
});
