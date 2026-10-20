import test from 'node:test';
import {openLegacyWorkspaceStore} from './helpers/legacy-workspace-store.ts';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {openStore} from '../packages/business/src/db.ts';
import {currentMarkerChain,currentOrdinary48Delta,currentOrdinary50Delta,currentOrdinary52Delta} from './helpers/current-schema-delta.ts';
import {snapshot as rawSnapshot} from './workspace-schema26-fixtures.mjs';
import {createServices,canonical} from '../packages/business/src/services.ts';

async function fixture(t,{open=openStore}={}){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-source-ranges-'));
 let store=open(root),services=createServices(store,new Map());
 const f={root,get store(){return store;},call:(op,input)=>services.call(op,input),
  restart(){store.close();store=openStore(root);services=createServices(store,new Map());},
  asset(mimeType='video/mp4',duration=2,projectId=f.project.id){return store.put('assets',{id:randomUUID(),projectId,name:'Private fixture',mimeType,duration,sha256:'a'.repeat(64),relativePath:'media/fixture',url:'/media/fixture'});},
  input(asset,patch={}){return {projectId:asset.projectId,assetId:asset.id,expectedRevision:0,requestId:randomUUID(),inFrame:0,outFrame:30,...patch};},
 };
 f.project=await f.call('project.create',{name:'Source ranges'});f.other=await f.call('project.create',{name:'Foreign private project'});
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return f;
}
const snapshot=(f,omit=[])=>Object.fromEntries(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().filter(({name})=>!omit.includes(name)).map(({name})=>[name,f.store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));

function assertReviewed52Migration(f,before,rawBefore,expectedTargetCount){
 const actual=rawSnapshot(f.store.db),names=new Set(currentOrdinary52Delta.objectNames),objects=actual.objects.filter(object=>names.has(object.name));
 assert.deepEqual(objects,currentOrdinary52Delta.objects,'independent frozen52 task and target SQL');
 assert.equal(objects.length,currentOrdinary52Delta.v2Catalog.count);
 assert.equal(createHash('sha256').update(JSON.stringify(objects)).digest('hex'),currentOrdinary52Delta.v2Catalog.sha256,'exact reviewed52 catalog');
 assert.deepEqual(actual.objects.filter(object=>/^(?:agent_task_|agent_target_)/.test(object.name)&&!names.has(object.name)),[],'unknown task/target objects are not reviewed52 additions');
 const revisions=[];
 for(const[kind,table]of [['project','projects'],['shot','shots'],['asset','assets'],['asset_range','asset_ranges']])
  for(const row of before[table]??[])revisions.push({retainedRowid:BigInt(revisions.length+1),projectId:kind==='project'?row.id:row.projectId,kind,targetId:kind==='asset_range'?row.assetId:row.id,revision:1n});
 assert.equal(revisions.length,expectedTargetCount,'the independent legacy seed has the exact target count');
 for(const[name,table]of Object.entries(currentOrdinary52Delta.tables)){
  assert.deepEqual(actual.tables[name].fields,table.fields,`${name}: reviewed52 fields`);
  if(name==='agent_task_target_revisions_v2'){
   const statement=f.store.db.prepare('SELECT rowid AS retainedRowid,* FROM agent_task_target_revisions_v2 ORDER BY rowid');statement.setReadBigInts(true);
   const rows=statement.all().map(row=>({...row}));
   assert.deepEqual(rows.map(row=>({retainedRowid:row.retainedRowid,kind:row.kind})),revisions.map(row=>({retainedRowid:row.retainedRowid,kind:row.kind})),'initial target rowids and kind ranges');
   // An unordered initial SQL scan may use a covering index. Preserve exact
   // identities without making the first UUID scan order a migration contract.
   const targets=values=>values.map(row=>{const value={...row};delete value.retainedRowid;return value;}).sort((a,b)=>a.kind.localeCompare(b.kind)||a.targetId.localeCompare(b.targetId));
   assert.deepEqual(targets(rows),targets(revisions),'original legacy project/target identities and exact initial revision1');
  }else assert.deepEqual(actual.tables[name].rows,[],`${name}: reviewed empty52 rows`);
 }
 for(const[name,table]of Object.entries(rawBefore.tables))if(name!=='schema_version')assert.deepEqual(actual.tables[name],table,`${name}: original SQLite types, raw bytes, rowids and sequence`);
}
const changes=f=>f.store.db.prepare('SELECT total_changes() AS n').get().n;
const read=(f,asset)=>f.call('asset.range.get',{projectId:asset.projectId,assetId:asset.id});
const count=(f,table)=>f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const safeMissing=error=>error.code==='NOT_FOUND'&&error.status===404&&error.message==='找不到记录'&&!error.details.current&&!error.details.mutationOutcome;
const noDisclosure=error=>!Object.hasOwn(error.details??{},'current')&&!/Private fixture|Foreign private project|media\/fixture/.test(JSON.stringify(error.details));
function replaceAsset(f,asset,patch={},owner=asset.projectId){f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(owner,JSON.stringify({...asset,...patch}),asset.id);}

test('default range reads write nothing, create no timeline, and return exact revision-zero envelopes',async t=>{
 const f=await fixture(t);
 for(const mimeType of ['video/mp4','video/webm','audio/wav','audio/mpeg','audio/mp4']){
  const asset=f.asset(mimeType),before=snapshot(f),writes=changes(f);
  const expected={id:asset.id,assetId:asset.id,projectId:asset.projectId,revision:0,range:null,sourceFrameCount:60,fps:30};
  for(let i=0;i<3;i++)assert.deepEqual(await read(f,asset),expected);
  assert.equal(changes(f),writes);assert.deepEqual(snapshot(f),before);
 }
 assert.equal(count(f,'asset_ranges'),0);assert.equal(count(f,'timelines'),0);assert.equal(count(f,'asset_range_requests'),0);
});

test('range saves are metadata-only with exclusive bounds; long source spans remain independent of timeline limits',async t=>{
 const f=await fixture(t),asset=f.asset('video/mp4',1000);
 const shot=await f.call('shot.create',{projectId:f.project.id,title:'Untouched selected version'}),jobId=randomUUID(),versionId=randomUUID();
 f.store.put('jobs',{id:jobId,projectId:f.project.id,shotId:shot.id,versionId});
 f.store.put('versions',{id:versionId,projectId:f.project.id,jobId,shotId:shot.id,assetId:asset.id,sha256:asset.sha256});
 f.store.put('shots',{...shot,selectedVersionId:versionId});
 const timeline=await f.call('timeline.get',{projectId:f.project.id});
 const clipInput={projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),trackId:timeline.tracks[0].id,assetId:asset.id,startFrame:0,durationFrames:30};
 await f.call('timeline.clip.add',clipInput);
 const media=path.join(f.root,'media','fixture');await writeFile(media,'unchanged synthetic media');
 const before=snapshot(f,['asset_ranges','asset_range_requests']),bytes=await readFile(media);
 let input=f.input(asset,{inFrame:1,outFrame:30000});const first=await f.call('asset.range.set',input);
 assert.deepEqual(first.range,{inFrame:1,outFrame:30000});assert.equal(first.revision,1);assert.equal(first.sourceFrameCount,30000);
 assert.deepEqual(await read(f,asset),first);
 const second=await f.call('asset.range.set',f.input(asset,{expectedRevision:1,inFrame:29999,outFrame:30000}));assert.equal(second.revision,2);
 assert.equal(before.agent_task_target_revisions_v2.some(row=>row.kind==='asset_range'&&row.targetId===asset.id),false);
 before.agent_task_target_revisions_v2.push(Object.assign(Object.create(null),{projectId:asset.projectId,kind:'asset_range',targetId:asset.id,revision:2}));
 assert.deepEqual(snapshot(f,['asset_ranges','asset_range_requests']),before);assert.deepEqual(await readFile(media),bytes);
 assert.equal(count(f,'mutation_requests'),0);assert.equal(count(f,'asset_ranges'),1);assert.equal(count(f,'asset_range_requests'),2);
 await assert.rejects(f.call('timeline.clip.add',{...clipInput,requestId:randomUUID(),expectedRevision:2,durationFrames:18001}),{code:'VALIDATION_ERROR'});
});

test('audio and fractional duration boundaries share timeline source counts; unsupported sources never write',async t=>{
 const f=await fixture(t),audio=f.asset('audio/wav',2.001),input=f.input(audio,{inFrame:59,outFrame:60});
 assert.equal((await f.call('asset.range.set',input)).range.outFrame,60);
 let before=snapshot(f);
 await assert.rejects(f.call('asset.range.set',f.input(audio,{expectedRevision:1,outFrame:61})),{code:'SOURCE_BOUNDS'});assert.deepEqual(snapshot(f),before);
 for(const duration of [undefined,null,'2',-1,0,0.01,Number.MAX_SAFE_INTEGER]){
  const asset=f.asset('video/mp4',duration);if(duration===undefined)replaceAsset(f,asset,{duration:undefined});
  before=snapshot(f);
  await assert.rejects(read(f,asset),{code:'SOURCE_RANGE_UNSUPPORTED'});
  await assert.rejects(f.call('asset.range.set',f.input(asset)),{code:'SOURCE_RANGE_UNSUPPORTED'});
  assert.deepEqual(snapshot(f),before);
 }
 const image=f.asset('image/png',2);before=snapshot(f);
 await assert.rejects(read(f,image),{code:'SOURCE_RANGE_UNSUPPORTED'});await assert.rejects(f.call('asset.range.set',f.input(image)),{code:'SOURCE_RANGE_UNSUPPORTED'});assert.deepEqual(snapshot(f),before);
 const fractional=f.asset('video/mp4',1.999);assert.equal((await read(f,fractional)).sourceFrameCount,59);
 await assert.rejects(f.call('asset.range.set',f.input(fractional,{outFrame:60})),{code:'SOURCE_BOUNDS'});
 const timeline=await f.call('timeline.get',{projectId:f.project.id});
 await assert.rejects(f.call('timeline.clip.add',{projectId:f.project.id,expectedRevision:1,requestId:randomUUID(),assetId:fractional.id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:60}),{code:'SOURCE_BOUNDS'});
});

test('exact range replay survives later edits and restart without writes; stale fresh keys conflict with safe current state',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset),original=await f.call('asset.range.set',input);
 const second=await f.call('asset.range.set',f.input(asset,{expectedRevision:1,inFrame:30,outFrame:60}));f.restart();
 const before=snapshot(f),writes=changes(f);
 for(let i=0;i<3;i++)assert.deepEqual(await f.call('asset.range.set',input),original);
 assert.deepEqual(await read(f,asset),second);assert.deepEqual(snapshot(f),before);assert.equal(changes(f),writes);
 await assert.rejects(f.call('asset.range.set',{...input,requestId:randomUUID()}),error=>error.code==='REVISION_CONFLICT'&&error.details.currentRevision===2&&JSON.stringify(error.details.current)===JSON.stringify(second)&&error.details.mutationOutcome==='not_applied');
 const receipt=f.store.db.prepare('SELECT * FROM asset_range_requests WHERE requestId=?').get(input.requestId);
 const {requestId,...fields}=input;assert.equal(receipt.canonicalInput,canonical(fields));assert.deepEqual(JSON.parse(receipt.response),original);
 for(const patch of [{outFrame:31},{inFrame:1},{expectedRevision:1},{assetId:randomUUID()},{projectId:f.other.id}])
  await assert.rejects(f.call('asset.range.set',{...input,...patch}),error=>error.code==='IDEMPOTENCY_CONFLICT'&&noDisclosure(error)&&!error.details.mutationOutcome);
 assert.deepEqual(snapshot(f),before);
});

test('cross-operation and cross-project keys conflict globally before ownership lookup, without leaked response bytes',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset);await f.call('asset.range.set',input);
 const legacy={projectId:f.project.id,title:'Legacy receipt secret',requestId:randomUUID()};await f.call('shot.create',legacy);
 const before=snapshot(f);
 for(const [operation,value] of [
  ['shot.create',{projectId:randomUUID(),title:'Changed',requestId:input.requestId}],
  ['node.create',{projectId:f.other.id,type:'text',position:{x:0,y:0},requestId:input.requestId}],
  ['asset.range.set',{...input,assetId:randomUUID(),requestId:legacy.requestId}],
  ['asset.range.set',{...input,projectId:f.other.id}],
 ])await assert.rejects(f.call(operation,value),error=>error.code==='IDEMPOTENCY_CONFLICT'&&noDisclosure(error)&&!error.details.mutationOutcome);
 assert.deepEqual(snapshot(f),before);
});

test('missing and foreign reads/writes are uniform; exact replay revalidates both owner copies and retained project',async t=>{
 const f=await fixture(t),asset=f.asset(),foreign=f.asset('video/mp4',2,f.other.id),input=f.input(asset);await f.call('asset.range.set',input);
 for(const target of [{projectId:f.project.id,assetId:randomUUID()},{projectId:f.project.id,assetId:foreign.id},{projectId:randomUUID(),assetId:asset.id}]){
  await assert.rejects(f.call('asset.range.get',target),safeMissing);
  await assert.rejects(f.call('asset.range.set',{...input,...target,requestId:randomUUID()}),safeMissing);
 }
 // Foreign malformed content is never decoded, even for exact replay.
 replaceAsset(f,asset,{projectId:f.other.id},f.other.id);
 f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run('{private-unreadable',asset.id);
 const before=snapshot(f);await assert.rejects(f.call('asset.range.set',input),safeMissing);assert.deepEqual(snapshot(f),before);
 replaceAsset(f,asset,{projectId:f.other.id});
 await assert.rejects(read(f,asset),safeMissing);await assert.rejects(f.call('asset.range.set',input),safeMissing);
 replaceAsset(f,asset);
 f.store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...f.project,id:f.other.id}),f.project.id);
 await assert.rejects(read(f,asset),{code:'INVALID_SOURCE_RANGE_RECORD'});await assert.rejects(f.call('asset.range.set',input),{code:'INVALID_SOURCE_RANGE_RECORD'});
 f.store.db.exec('PRAGMA foreign_keys=OFF');f.store.db.prepare('DELETE FROM projects WHERE id=?').run(f.project.id);f.store.db.exec('PRAGMA foreign_keys=ON');
 await assert.rejects(read(f,asset),safeMissing);await assert.rejects(f.call('asset.range.set',input),safeMissing);
});

test('damaged saved range rows and retained acknowledgements fail closed before revision/current disclosure',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset),saved=await f.call('asset.range.set',input);
 f.store.db.exec('DROP TRIGGER immutable_asset_range_identity');
 f.store.db.prepare('UPDATE asset_ranges SET projectId=? WHERE assetId=?').run(f.other.id,asset.id);
 for(const operation of ['asset.range.get','asset.range.set'])await assert.rejects(f.call(operation,operation.endsWith('get')?{projectId:asset.projectId,assetId:asset.id}:input),error=>error.code==='INVALID_SOURCE_RANGE_RECORD'&&noDisclosure(error));
 f.store.db.prepare('UPDATE asset_ranges SET projectId=?,outFrame=61 WHERE assetId=?').run(asset.projectId,asset.id);
 await assert.rejects(read(f,asset),{code:'INVALID_SOURCE_RANGE_RECORD'});
 f.store.db.prepare('UPDATE asset_ranges SET outFrame=30 WHERE assetId=?').run(asset.id);
 f.store.db.exec('DROP TRIGGER immutable_asset_range_requests');
 for(const patch of [{range:{inFrame:1,outFrame:30}},{assetId:randomUUID()},{projectId:f.other.id},{revision:2},{sourceFrameCount:59},{extra:'private'}]){
  f.store.db.prepare('UPDATE asset_range_requests SET response=? WHERE requestId=?').run(JSON.stringify({...saved,...patch}),input.requestId);
  await assert.rejects(f.call('asset.range.set',input),error=>error.code==='INVALID_SOURCE_RANGE_RECORD'&&noDisclosure(error));
 }
 f.store.db.prepare('UPDATE asset_range_requests SET response=? WHERE requestId=?').run(JSON.stringify(saved),input.requestId);
 f.store.db.prepare('DELETE FROM asset_ranges WHERE assetId=?').run(asset.id);
 await assert.rejects(f.call('asset.range.set',input),{code:'INVALID_SOURCE_RANGE_RECORD'});
});

test('duplicate receipts and wrong operation/table pairing fail closed before target lookup',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset);await f.call('asset.range.set',input);
 const row=f.store.db.prepare('SELECT * FROM asset_range_requests WHERE requestId=?').get(input.requestId);
 f.store.db.exec('DROP TRIGGER reject_mutation_cross_range_request; PRAGMA ignore_check_constraints=ON');
 f.store.db.prepare('INSERT INTO mutation_requests VALUES(?,?,?,?,?)').run(row.requestId,row.operation,row.projectId,row.canonicalInput,row.response);
 await assert.rejects(f.call('asset.range.set',input),{code:'IDEMPOTENCY_CONFLICT'});
 f.store.db.exec('DROP TRIGGER retain_asset_range_requests');f.store.db.prepare('DELETE FROM asset_range_requests WHERE requestId=?').run(row.requestId);
 await assert.rejects(f.call('asset.range.set',input),{code:'IDEMPOTENCY_CONFLICT'});
});

test('range, receipt, and trigger-induced ownership changes roll back together',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset),before=snapshot(f);
 f.store.db.exec("CREATE TRIGGER fail_range_receipt BEFORE INSERT ON asset_range_requests BEGIN SELECT RAISE(ABORT,'injected receipt failure');END;");
 await assert.rejects(f.call('asset.range.set',input),/injected receipt failure/);assert.deepEqual(snapshot(f),before);assert.equal(f.store.db.isTransaction,false);
 f.store.db.exec('DROP TRIGGER fail_range_receipt');
 // The post-receipt guard closes even an in-transaction reassignment by a trigger.
 f.store.db.exec(`CREATE TRIGGER reassign_after_receipt AFTER INSERT ON asset_range_requests BEGIN UPDATE assets SET projectId='${f.other.id}',data=json_set(data,'$.projectId','${f.other.id}') WHERE id='${asset.id}';END;`);
 await assert.rejects(f.call('asset.range.set',input),safeMissing);assert.deepEqual(snapshot(f),before);
 f.store.db.exec('DROP TRIGGER reassign_after_receipt');
 const first=await f.call('asset.range.set',input),updated=f.input(asset,{expectedRevision:1,inFrame:30,outFrame:60}),saved=snapshot(f);
 f.store.db.exec("CREATE TRIGGER fail_update_receipt BEFORE INSERT ON asset_range_requests BEGIN SELECT RAISE(ABORT,'injected update failure');END;");
 await assert.rejects(f.call('asset.range.set',updated),/injected update failure/);assert.deepEqual(snapshot(f),saved);assert.deepEqual(await read(f,asset),first);
});

test('retained source receipts reject update/delete/replacement, and cross-table SQL inserts cannot duplicate keys',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset);await f.call('asset.range.set',input);
 const row=f.store.db.prepare('SELECT * FROM asset_range_requests WHERE requestId=?').get(input.requestId),before=snapshot(f);
 assert.throws(()=>f.store.db.prepare('UPDATE asset_range_requests SET response=? WHERE requestId=?').run('{}',input.requestId),/immutable/);
 assert.throws(()=>f.store.db.prepare('DELETE FROM asset_range_requests WHERE requestId=?').run(input.requestId),/retained/);
 assert.throws(()=>f.store.db.prepare('INSERT OR REPLACE INTO asset_range_requests VALUES(?,?,?,?,?)').run(row.requestId,row.operation,row.projectId,row.canonicalInput,'{}'),/immutable/);
 assert.throws(()=>f.store.db.prepare('INSERT INTO mutation_requests VALUES(?,?,?,?,?)').run(row.requestId,'shot.create',row.projectId,'{}','{}'),/already retained/);
 assert.deepEqual(snapshot(f),before);f.restart();assert.deepEqual(snapshot(f),before);
});

test('targeted v11/v12 additive reapplication preserves all old receipt bytes and fresh schema invariants',async t=>{
 const f=await fixture(t,{open:openLegacyWorkspaceStore});await f.call('shot.create',{projectId:f.project.id,title:'Legacy keyed shot',requestId:randomUUID()});
 const old=f.store.db.prepare('SELECT * FROM mutation_requests').get();
 for(const table of ['timeline_requests','reference_requests'])f.store.db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(randomUUID(),'old-hash',' { "old": true, "preserve": "spacing" } ');
 const fullSchema=()=>f.store.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
 const current=await fixture(t);
 // The reviewed current-schema view of the range/trigger catalog: the historical fixture predates the annotation cross-table guards and lifecycle wrappers, so the current fresh store is the byte-exact expected catalog here (historical rows/bytes are asserted separately above).
 const fresh=current.store.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE '%asset_range%' OR name='reject_mutation_cross_range_request' ORDER BY name").all();
 const completeFresh=current.store.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
 // Reapply only the two removed asset companions and the subject extension
 // that owns reciprocal triggers on them. Keep unrelated later schema markers:
 // deleting those while retaining their tables would fabricate a downgrade.
 // Reapplying subject schema rebuilds the edit-task CHECK. Remove the later
 // empty format extension and its marker together, so startup can truthfully
 // compose schema21 and schema22 again rather than leave a newer marker on an older table.
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM timeline_format_requests').get().n,0);
 f.store.db.exec('DROP TABLE timeline_format_requests; DROP INDEX timeline_requests_project; DELETE FROM schema_version WHERE version IN (21,22);');
 f.store.db.exec('DROP TRIGGER reject_mutation_cross_disposition_request; DROP TRIGGER reject_asset_range_cross_disposition_request; DROP TABLE asset_disposition_requests; DROP TABLE asset_dispositions; DELETE FROM schema_version WHERE version IN (12,15);');
 f.store.db.exec('DROP TRIGGER reject_mutation_cross_range_request; DROP TABLE asset_range_requests; DROP TABLE asset_ranges; DELETE FROM schema_version WHERE version=11;');
 const before=snapshot(f,['schema_version']),rawBefore=rawSnapshot(f.store.db);f.restart();
 assertReviewed52Migration(f,before,rawBefore,3);
 assert.deepEqual(snapshot(f,['schema_version','asset_ranges','asset_range_requests','asset_dispositions','asset_disposition_requests','timeline_format_requests','project_lut_resources','lut_import_requests','asset_annotations','asset_annotation_requests',...Object.keys(currentOrdinary48Delta.lifecycleTables),...Object.keys(currentOrdinary50Delta.tables),...Object.keys(currentOrdinary52Delta.tables)]),before);
 for(const table of Object.keys(currentOrdinary50Delta.tables))assert.equal(f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM mutation_requests').get(),old);
 assert.deepEqual(f.store.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE '%asset_range%' OR name='reject_mutation_cross_range_request' ORDER BY name").all(),fresh);
 assert.ok(f.store.db.prepare('SELECT version FROM schema_version WHERE version=11').get());
 assert.deepEqual(f.store.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...currentMarkerChain]);
 assert.deepEqual(fullSchema(),completeFresh);
 const migrated=snapshot(f),migratedRaw=rawSnapshot(f.store.db);f.restart();assert.deepEqual(snapshot(f),migrated);assert.deepEqual(rawSnapshot(f.store.db),migratedRaw);assert.deepEqual(fullSchema(),completeFresh);
});

// Child processes use two genuinely independent SQLite connections. The winner
// holds BEGIN IMMEDIATE before either helper inspects a key; the loser attempts
// its write lock before the parent releases the first transaction.
const childCode=`
 import {existsSync} from 'node:fs';
 import {openStore} from './packages/business/src/db.ts';
 import {createServices} from './packages/business/src/services.ts';
 const [root,operation,json,release]=process.argv.slice(1),store=openStore(root,{lock:false});
 const tx=store.tx,signal=new Int32Array(new SharedArrayBuffer(4));
 const wrapped={...store,tx:callback=>{process.send({phase:'attempt'});return tx(()=>{
  if(release){process.send({phase:'locked'});while(!existsSync(release))Atomics.wait(signal,0,0,10);}
  return callback();
 });}};
 const services=createServices(wrapped,new Map());process.send({phase:'ready'});
 process.once('message',async()=>{try{const value=await services.call(operation,JSON.parse(json));process.send({phase:'result',ok:true,value});}
 catch(error){process.send({phase:'result',ok:false,code:error.code,details:error.details});}
 finally{store.close();process.disconnect();}});
`;
function child(t,f,operation,input,release=''){
 const proc=spawn(process.execPath,['--input-type=module','-e',childCode,f.root,operation,JSON.stringify(input),release],{cwd:path.resolve(new URL('..',import.meta.url).pathname),stdio:['ignore','pipe','pipe','ipc']});
 const messages=[],pending=[];let errorText='';
 proc.stderr.setEncoding('utf8').on('data',chunk=>errorText+=chunk);
 proc.on('message',value=>{messages.push(value);for(const p of [...pending])if(p.phase===value.phase){pending.splice(pending.indexOf(p),1);p.resolve(value);}});
 proc.on('error',error=>{for(const p of pending.splice(0))p.reject(error);});
 proc.on('exit',(code,signal)=>{for(const p of pending.splice(0))p.reject(Error(`Race child exited ${code}/${signal}: ${errorText}`));});
 t.after(()=>{if(proc.exitCode===null)proc.kill('SIGKILL');});
 return {proc,wait:phase=>{const value=messages.find(v=>v.phase===phase);return value?Promise.resolve(value):new Promise((resolve,reject)=>pending.push({phase,resolve,reject}));}};
}
for(const winnerOperation of ['asset.range.set','shot.create'])test(`two-process cross-table key race: ${winnerOperation} commits once and the opposite helper conflicts`,{timeout:15000},async t=>{
 const f=await fixture(t),asset=f.asset(),requestId=randomUUID(),range=f.input(asset,{requestId}),legacy={projectId:f.project.id,title:'Race winner',requestId};
 const loserOperation=winnerOperation==='asset.range.set'?'shot.create':'asset.range.set';
 const inputs={'asset.range.set':range,'shot.create':legacy},release=path.join(f.root,'release-writer');
 const winner=child(t,f,winnerOperation,inputs[winnerOperation],release),loser=child(t,f,loserOperation,inputs[loserOperation]);
 await Promise.all([winner.wait('ready'),loser.wait('ready')]);winner.proc.send('start');await winner.wait('locked');
 loser.proc.send('start');await loser.wait('attempt');await writeFile(release,'release');
 const [accepted,rejected]=await Promise.all([winner.wait('result'),loser.wait('result')]);
 assert.equal(accepted.ok,true);assert.equal(rejected.ok,false);assert.equal(rejected.code,'IDEMPOTENCY_CONFLICT');assert.ok(!rejected.details.current);
 assert.equal(count(f,'mutation_requests')+count(f,'asset_range_requests'),1);
 assert.equal(count(f,'asset_ranges'),winnerOperation==='asset.range.set'?1:0);
 assert.equal(count(f,'shots'),winnerOperation==='shot.create'?1:0);
 assert.deepEqual(await f.call(winnerOperation,inputs[winnerOperation]),accepted.value);
});


test('oversized asset or project JSON is rejected without materialization, writes, or current-record disclosure',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset);await f.call('asset.range.set',input);
 for(const [table,value] of [['assets',asset],['projects',f.project]]){
  f.store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify({...value,padding:'x'.repeat(16384)}),value.id);
  const before=snapshot(f),writes=changes(f);
  await assert.rejects(read(f,asset),error=>error.code==='INVALID_SOURCE_RANGE_RECORD'&&noDisclosure(error));
  await assert.rejects(f.call('asset.range.set',input),error=>error.code==='INVALID_SOURCE_RANGE_RECORD'&&noDisclosure(error));
  await assert.rejects(f.call('asset.range.set',{...input,requestId:randomUUID(),expectedRevision:999}),error=>error.code==='INVALID_SOURCE_RANGE_RECORD'&&noDisclosure(error));
  assert.deepEqual(snapshot(f),before);assert.equal(changes(f),writes);
  f.store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value),value.id);
 }
});

test('revision overflow and lost or malformed asset rows never expose retained range responses',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset);await f.call('asset.range.set',input);
 f.store.db.prepare('UPDATE asset_ranges SET revision=? WHERE assetId=?').run(Number.MAX_SAFE_INTEGER,asset.id);
 const before=snapshot(f);
 await assert.rejects(f.call('asset.range.set',{...input,requestId:randomUUID(),expectedRevision:Number.MAX_SAFE_INTEGER}),{code:'RANGE_REVISION_LIMIT'});
 assert.deepEqual(snapshot(f),before);
 f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run('{broken',asset.id);
 await assert.rejects(read(f,asset),{code:'INVALID_SOURCE_RANGE_RECORD'});await assert.rejects(f.call('asset.range.set',input),{code:'INVALID_SOURCE_RANGE_RECORD'});
 f.store.db.exec('PRAGMA foreign_keys=OFF');f.store.db.prepare('DELETE FROM assets WHERE id=?').run(asset.id);f.store.db.exec('PRAGMA foreign_keys=ON');
 await assert.rejects(read(f,asset),safeMissing);await assert.rejects(f.call('asset.range.set',input),safeMissing);
});

test('a legacy operation misplaced in the companion journal is never replayed',async t=>{
 const f=await fixture(t),input={projectId:f.project.id,title:'Private legacy reply',requestId:randomUUID()};
 await f.call('shot.create',input);
 const row=f.store.db.prepare('SELECT * FROM mutation_requests WHERE requestId=?').get(input.requestId);
 f.store.db.exec('DROP TRIGGER reject_asset_range_cross_request; DROP TRIGGER retain_mutation_requests; PRAGMA ignore_check_constraints=ON');
 f.store.db.prepare('DELETE FROM mutation_requests WHERE requestId=?').run(input.requestId);
 f.store.db.prepare('INSERT INTO asset_range_requests VALUES(?,?,?,?,?)').run(row.requestId,row.operation,row.projectId,row.canonicalInput,row.response);
 const before=snapshot(f);
 await assert.rejects(f.call('shot.create',input),error=>error.code==='IDEMPOTENCY_CONFLICT'&&noDisclosure(error));
 assert.deepEqual(snapshot(f),before);
});
