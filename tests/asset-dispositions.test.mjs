import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {LOCAL_MUTATION_OPERATIONS} from '@mioon/contracts';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices,canonical} from '../packages/business/src/services.mjs';

async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-asset-dispositions-'));
 let store=openStore(root),services=createServices(store,new Map());
 const f={root,get store(){return store;},call:(op,input)=>services.call(op,input),
  restart(){store.close();store=openStore(root);services=createServices(store,new Map());},
  asset(mimeType='video/mp4',projectId=f.project.id){return store.put('assets',{id:randomUUID(),projectId,name:'Private disposition asset',mimeType,duration:2,sha256:'a'.repeat(64),relativePath:'media/fixture',url:'/media/fixture'});},
  input(asset,patch={}){return {projectId:asset.projectId,assetId:asset.id,expectedRevision:0,requestId:randomUUID(),disposition:'favorite',...patch};},
 };
 f.project=await f.call('project.create',{name:'Asset dispositions'});f.other=await f.call('project.create',{name:'Foreign private project'});
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return f;
}
const snapshot=(f,omit=[])=>Object.fromEntries(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().filter(({name})=>!omit.includes(name)).map(({name})=>{
 const statement=f.store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`);statement.setReadBigInts(true);
 return [name,statement.all()];
}));
const changes=f=>f.store.db.prepare('SELECT total_changes() AS n').get().n;
const list=(f,assets)=>f.call('asset.disposition.list',{projectId:f.project.id,assetIds:assets.map(asset=>asset.id)});
const read=async(f,asset)=>(await list(f,[asset])).items[0];
const count=(f,table)=>f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const safeMissing=error=>error.code==='NOT_FOUND'&&error.status===404&&error.message==='找不到记录'&&Object.keys(error.details).length===0;
const noDisclosure=error=>!Object.hasOwn(error.details??{},'current')&&!/Private disposition asset|Foreign private project|media\/fixture|retained secret/.test(JSON.stringify(error.details));
const conflict=error=>error.code==='IDEMPOTENCY_CONFLICT'&&error.status===409&&!error.details.mutationOutcome&&noDisclosure(error);
function replaceAsset(f,asset,patch={},owner=asset.projectId){f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(owner,JSON.stringify({...asset,...patch}),asset.id);}
const receiptTables=['mutation_requests','asset_range_requests','asset_disposition_requests'];
const operationTable=op=>op==='asset.disposition.set'?'asset_disposition_requests':op==='asset.range.set'?'asset_range_requests':'mutation_requests';

test('ordered bounded reads confirm absent neutral revision zero without writes, rows or lazy timeline creation',async t=>{
 const f=await fixture(t),assets=Array.from({length:100},(_,i)=>f.asset(['image/png','video/mp4','audio/wav'][i%3])).reverse();
 const before=snapshot(f),writes=changes(f);
 const expected={projectId:f.project.id,items:assets.map(asset=>({id:asset.id,assetId:asset.id,projectId:f.project.id,revision:0,disposition:'neutral'}))};
 for(let i=0;i<3;i++)assert.deepEqual(await list(f,assets),expected);
 assert.equal(changes(f),writes);assert.deepEqual(snapshot(f),before);
 for(const table of ['asset_dispositions','asset_disposition_requests','timelines'])assert.equal(count(f,table),0);
 for(const assetIds of [undefined,[],[assets[0].id,assets[0].id],Array.from({length:101},()=>randomUUID())])
  await assert.rejects(f.call('asset.disposition.list',{projectId:f.project.id,assetIds}),{code:'VALIDATION_ERROR'});
 assert.deepEqual(snapshot(f),before);assert.equal(changes(f),writes);
});

test('favorite/rejected/neutral edits retain independent revisions and leave all asset bytes, names, relationships and timelines unchanged',async t=>{
 const f=await fixture(t),asset=f.asset(),image=f.asset('image/png'),audio=f.asset('audio/wav');
 const shot=await f.call('shot.create',{projectId:f.project.id,title:'Untouched selected version'}),jobId=randomUUID(),versionId=randomUUID();
 f.store.put('jobs',{id:jobId,projectId:f.project.id,shotId:shot.id,versionId});
 f.store.put('versions',{id:versionId,projectId:f.project.id,jobId,shotId:shot.id,assetId:asset.id,sha256:asset.sha256});
 f.store.put('shots',{...shot,selectedVersionId:versionId});
 await f.call('node.create',{projectId:f.project.id,type:'image',assetId:image.id,position:{x:0,y:0}});
 const timeline=await f.call('timeline.get',{projectId:f.project.id});
 await f.call('timeline.clip.add',{projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),trackId:timeline.tracks[0].id,assetId:asset.id,startFrame:0,durationFrames:30});
 await f.call('asset.range.set',{projectId:f.project.id,assetId:asset.id,expectedRevision:0,requestId:randomUUID(),inFrame:1,outFrame:30});
 const media=path.join(f.root,'media','fixture');await writeFile(media,'unchanged synthetic media');
 const before=snapshot(f,['asset_dispositions','asset_disposition_requests']),bytes=await readFile(media);
 for(const target of [asset,image,audio]){
  for(const [index,disposition] of ['neutral','favorite','rejected','neutral','neutral'].entries()){
   const result=await f.call('asset.disposition.set',f.input(target,{disposition,expectedRevision:index}));
   assert.deepEqual(result,{id:target.id,assetId:target.id,projectId:f.project.id,revision:index+1,disposition});
   assert.deepEqual(await read(f,target),result);
  }
 }
 assert.deepEqual(snapshot(f,['asset_dispositions','asset_disposition_requests']),before);assert.deepEqual(await readFile(media),bytes);
 assert.equal(count(f,'asset_dispositions'),3);assert.equal(count(f,'asset_disposition_requests'),15);
 assert.equal((await f.call('asset.range.get',{projectId:f.project.id,assetId:asset.id})).revision,1);
});

test('exact replay precedes CAS after current ownership validation and survives later labels, reset and restart without writes',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset),original=await f.call('asset.disposition.set',input);
 await f.call('asset.disposition.set',f.input(asset,{expectedRevision:1,disposition:'rejected'}));
 const latest=await f.call('asset.disposition.set',f.input(asset,{expectedRevision:2,disposition:'neutral'}));f.restart();
 const before=snapshot(f),writes=changes(f);
 for(let i=0;i<3;i++)assert.deepEqual(await f.call('asset.disposition.set',input),original);
 assert.deepEqual(await read(f,asset),latest);assert.equal(changes(f),writes);assert.deepEqual(snapshot(f),before);
 await assert.rejects(f.call('asset.disposition.set',{...input,requestId:randomUUID()}),error=>error.code==='REVISION_CONFLICT'&&error.details.currentRevision===3&&
  JSON.stringify(error.details.current)===JSON.stringify(latest)&&error.details.mutationOutcome==='not_applied');
 const row=f.store.db.prepare('SELECT * FROM asset_disposition_requests WHERE requestId=?').get(input.requestId),{requestId,...fields}=input;
 assert.equal(row.canonicalInput,canonical(fields));assert.deepEqual(JSON.parse(row.response),original);
 for(const patch of [{disposition:'neutral'},{expectedRevision:1},{assetId:randomUUID()},{projectId:f.other.id}])
  await assert.rejects(f.call('asset.disposition.set',{...input,...patch}),conflict);
 assert.deepEqual(snapshot(f),before);
});

test('schema-valid non-BMP request keys retain existing UTF-16 length semantics across save and replay',async t=>{
 const f=await fixture(t),asset=f.asset();
 for(const [expectedRevision,requestId] of ['😀'.repeat(4),'😀'.repeat(100),'null\0key'].map((key,index)=>[index,key])){
  const input=f.input(asset,{expectedRevision,requestId}),saved=await f.call('asset.disposition.set',input);
  const before=snapshot(f);assert.deepEqual(await f.call('asset.disposition.set',input),saved);assert.deepEqual(snapshot(f),before);
 }
 f.restart();assert.equal((await read(f,asset)).revision,3);
});

test('missing and foreign batches fail all-or-nothing uniformly, including exact replay, without foreign JSON decoding',async t=>{
 const f=await fixture(t),asset=f.asset(),foreign=f.asset('video/mp4',f.other.id),input=f.input(asset);await f.call('asset.disposition.set',input);
 f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run('{foreign retained secret',foreign.id);
 for(const target of [{projectId:f.project.id,assetId:randomUUID()},{projectId:f.project.id,assetId:foreign.id},{projectId:randomUUID(),assetId:asset.id}]){
  await assert.rejects(f.call('asset.disposition.list',{projectId:target.projectId,assetIds:[target.assetId]}),safeMissing);
  await assert.rejects(f.call('asset.disposition.set',{...input,...target,requestId:randomUUID()}),safeMissing);
 }
 const before=snapshot(f),writes=changes(f);
 for(const assetIds of [[asset.id,foreign.id],[foreign.id,asset.id],[asset.id,randomUUID()]])
  await assert.rejects(f.call('asset.disposition.list',{projectId:f.project.id,assetIds}),safeMissing);
 assert.deepEqual(snapshot(f),before);assert.equal(changes(f),writes);
 replaceAsset(f,asset,{projectId:f.other.id},f.other.id);
 f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run('{foreign retained secret',asset.id);
 await assert.rejects(f.call('asset.disposition.set',input),safeMissing);
 replaceAsset(f,asset,{projectId:f.other.id});await assert.rejects(read(f,asset),safeMissing);await assert.rejects(f.call('asset.disposition.set',input),safeMissing);
 replaceAsset(f,asset);
 f.store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...f.project,id:f.other.id}),f.project.id);
 await assert.rejects(read(f,asset),{code:'INVALID_ASSET_DISPOSITION_RECORD'});await assert.rejects(f.call('asset.disposition.set',input),{code:'INVALID_ASSET_DISPOSITION_RECORD'});
 f.store.db.exec('PRAGMA foreign_keys=OFF');f.store.db.prepare('DELETE FROM projects WHERE id=?').run(f.project.id);f.store.db.exec('PRAGMA foreign_keys=ON');
 await assert.rejects(read(f,asset),safeMissing);await assert.rejects(f.call('asset.disposition.set',input),safeMissing);
});

test('bounded asset/project identity JSON and malformed saved metadata fail closed without current state disclosure',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset);await f.call('asset.disposition.set',input);
 for(const [table,value] of [['assets',asset],['projects',f.project]]){
  for(const damaged of ['{retained secret',JSON.stringify({...value,padding:'x'.repeat(16384)}),JSON.stringify({...value,id:randomUUID()})]){
   f.store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(damaged,value.id);
   const before=snapshot(f),writes=changes(f);
   await assert.rejects(read(f,asset),error=>error.code==='INVALID_ASSET_DISPOSITION_RECORD'&&noDisclosure(error));
   for(const request of [input,{...input,requestId:randomUUID(),expectedRevision:999}])
    await assert.rejects(f.call('asset.disposition.set',request),error=>error.code==='INVALID_ASSET_DISPOSITION_RECORD'&&noDisclosure(error)&&!error.details.mutationOutcome);
   assert.deepEqual(snapshot(f),before);assert.equal(changes(f),writes);
  }
  f.store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value),value.id);
 }
 f.store.db.exec('DROP TRIGGER immutable_asset_disposition_identity; PRAGMA ignore_check_constraints=ON');
 for(const patch of [{projectId:f.other.id},{revision:0},{revision:1.5},{revision:Number.MAX_SAFE_INTEGER+1},{disposition:'private retained secret'}]){
  for(const [key,value] of Object.entries(patch))f.store.db.prepare(`UPDATE asset_dispositions SET ${key}=? WHERE assetId=?`).run(value,asset.id);
  const before=snapshot(f);
  await assert.rejects(read(f,asset),error=>error.code==='INVALID_ASSET_DISPOSITION_RECORD'&&noDisclosure(error));
  await assert.rejects(f.call('asset.disposition.set',input),error=>error.code==='INVALID_ASSET_DISPOSITION_RECORD'&&noDisclosure(error));
  assert.deepEqual(snapshot(f),before);
  f.store.db.prepare('UPDATE asset_dispositions SET projectId=?,revision=1,disposition=? WHERE assetId=?').run(f.project.id,'favorite',asset.id);
 }
});

test('malformed retained responses, lost metadata and deleted assets never expose or replay historical acknowledgements',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset),saved=await f.call('asset.disposition.set',input);
 f.store.db.exec('DROP TRIGGER immutable_asset_disposition_requests; PRAGMA ignore_check_constraints=ON');
 for(const response of ['{retained secret',JSON.stringify({...saved,padding:'x'.repeat(4096)}),...[
  {disposition:'neutral'},{assetId:randomUUID()},{projectId:f.other.id},{revision:2},{extra:'retained secret'},
 ].map(patch=>JSON.stringify({...saved,...patch}))]){
  f.store.db.prepare('UPDATE asset_disposition_requests SET response=? WHERE requestId=?').run(response,input.requestId);
  await assert.rejects(f.call('asset.disposition.set',input),error=>error.code==='INVALID_ASSET_DISPOSITION_RECORD'&&noDisclosure(error)&&!error.details.mutationOutcome);
 }
 f.store.db.prepare('UPDATE asset_disposition_requests SET response=? WHERE requestId=?').run(JSON.stringify(saved),input.requestId);
 f.store.db.prepare('DELETE FROM asset_dispositions WHERE assetId=?').run(asset.id);
 await assert.rejects(f.call('asset.disposition.set',input),{code:'INVALID_ASSET_DISPOSITION_RECORD'});
 f.store.db.prepare('DELETE FROM assets WHERE id=?').run(asset.id);
 await assert.rejects(read(f,asset),safeMissing);await assert.rejects(f.call('asset.disposition.set',input),safeMissing);
});

test('metadata, receipts and trigger-induced reassignment roll back together; scope denial never releases the pending request',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset),before=snapshot(f);
 f.store.db.exec("CREATE TRIGGER fail_disposition_receipt BEFORE INSERT ON asset_disposition_requests BEGIN SELECT RAISE(ABORT,'injected receipt failure');END;");
 await assert.rejects(f.call('asset.disposition.set',input),/injected receipt failure/);assert.deepEqual(snapshot(f),before);assert.equal(f.store.db.isTransaction,false);
 f.store.db.exec('DROP TRIGGER fail_disposition_receipt');
 f.store.db.exec(`CREATE TRIGGER reassign_after_disposition AFTER INSERT ON asset_disposition_requests BEGIN UPDATE assets SET projectId='${f.other.id}',data=json_set(data,'$.projectId','${f.other.id}') WHERE id='${asset.id}';END;`);
 await assert.rejects(f.call('asset.disposition.set',input),safeMissing);assert.deepEqual(snapshot(f),before);
 f.store.db.exec('DROP TRIGGER reassign_after_disposition');
 const first=await f.call('asset.disposition.set',input),updated=f.input(asset,{expectedRevision:1,disposition:'neutral'}),saved=snapshot(f);
 f.store.db.exec("CREATE TRIGGER fail_disposition_update_receipt BEFORE INSERT ON asset_disposition_requests BEGIN SELECT RAISE(ABORT,'injected update failure');END;");
 await assert.rejects(f.call('asset.disposition.set',updated),/injected update failure/);assert.deepEqual(snapshot(f),saved);assert.deepEqual(await read(f,asset),first);
});

test('safe revision limit and stale writes fail without mutation; independent range updates cannot conflict with disposition revisions',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset);await f.call('asset.disposition.set',input);
 await f.call('asset.range.set',{projectId:f.project.id,assetId:asset.id,expectedRevision:0,requestId:randomUUID(),inFrame:0,outFrame:30});
 assert.equal((await f.call('asset.disposition.set',f.input(asset,{expectedRevision:1,disposition:'rejected'}))).revision,2);
 f.store.db.prepare('UPDATE asset_dispositions SET revision=? WHERE assetId=?').run(Number.MAX_SAFE_INTEGER,asset.id);
 const before=snapshot(f);
 await assert.rejects(f.call('asset.disposition.set',f.input(asset,{expectedRevision:Number.MAX_SAFE_INTEGER})),error=>error.code==='DISPOSITION_REVISION_LIMIT'&&error.details.mutationOutcome==='not_applied');
 assert.deepEqual(snapshot(f),before);
});

function collisionInput(f,op,key){
 const projectId=f.project.id,assetId=randomUUID(),shotId=randomUUID(),nodeId=randomUUID(),expectedRevision=1,requestId=key;
 return {
  'shot.create':{projectId,title:'Collision',requestId},'shot.update':{shotId,expectedRevision,patch:{prompt:'Changed'},requestId},
  'shot.reorder':{projectId,expectedRevision,shotIds:[shotId],requestId},'node.create':{projectId,type:'text',position:{x:0,y:0},requestId},
  'node.update':{nodeId,expectedRevision,patch:{label:'Changed'},requestId},'version.select':{shotId,versionId:randomUUID(),expectedRevision,requestId},
  'asset.range.set':{projectId,assetId,expectedRevision:0,inFrame:0,outFrame:30,requestId},
  'asset.disposition.set':{projectId,assetId,expectedRevision:0,disposition:'favorite',requestId},
 }[op];
}
async function acceptedInput(f,op){
 const input=collisionInput(f,op,randomUUID());
 if(op.startsWith('asset.'))return {...input,assetId:f.asset().id};
 if(op.endsWith('create'))return input;
 if(op==='node.update'){const node=await f.call('node.create',{projectId:f.project.id,type:'text',position:{x:0,y:0}});return {...input,nodeId:node.id};}
 const shot=await f.call('shot.create',{projectId:f.project.id,title:'Existing shot'});
 if(op==='shot.reorder')return {...input,expectedRevision:f.store.get('projects',f.project.id).revision,shotIds:[shot.id]};
 if(op==='version.select'){
  const asset=f.asset(),jobId=randomUUID(),versionId=randomUUID();f.store.put('jobs',{id:jobId,projectId:f.project.id,shotId:shot.id,versionId});
  f.store.put('versions',{id:versionId,projectId:f.project.id,jobId,shotId:shot.id,assetId:asset.id});return {...input,shotId:shot.id,versionId};
 }
 return {...input,shotId:shot.id};
}
for(const winner of LOCAL_MUTATION_OPERATIONS)test(`${winner}: all seven other mutation writers reject its key globally before target lookup`,async t=>{
 const f=await fixture(t),input=await acceptedInput(f,winner),result=await f.call(winner,input),before=snapshot(f);
 for(const loser of LOCAL_MUTATION_OPERATIONS.filter(op=>op!==winner))await assert.rejects(f.call(loser,collisionInput(f,loser,input.requestId)),conflict);
 assert.deepEqual(snapshot(f),before);assert.deepEqual(await f.call(winner,input),result);
 assert.equal(receiptTables.reduce((sum,table)=>sum+count(f,table),0),1);
});

test('immutable companion receipts cannot be updated, deleted or replaced; SQL collision triggers guard every table direction',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset);await f.call('asset.disposition.set',input);
 const row=f.store.db.prepare('SELECT * FROM asset_disposition_requests WHERE requestId=?').get(input.requestId),before=snapshot(f);
 assert.throws(()=>f.store.db.prepare('UPDATE asset_disposition_requests SET response=? WHERE requestId=?').run('{}',input.requestId),/immutable/);
 assert.throws(()=>f.store.db.prepare('DELETE FROM asset_disposition_requests WHERE requestId=?').run(input.requestId),/retained/);
 assert.throws(()=>f.store.db.prepare('INSERT OR REPLACE INTO asset_disposition_requests VALUES(?,?,?,?,?)').run(row.requestId,row.operation,row.projectId,row.canonicalInput,'{}'),/immutable/);
 assert.throws(()=>f.store.db.prepare('UPDATE asset_dispositions SET projectId=? WHERE assetId=?').run(f.other.id,asset.id),/immutable/);
 assert.deepEqual(snapshot(f),before);
 for(const [source,operation] of [['mutation_requests','shot.create'],['asset_range_requests','asset.range.set'],['asset_disposition_requests','asset.disposition.set']]){
  const requestId=randomUUID();f.store.db.prepare(`INSERT INTO ${source} VALUES(?,?,?,?,?)`).run(requestId,operation,f.project.id,'{}','{}');
  for(const target of receiptTables.filter(table=>table!==source)){
   const targetOperation=target==='mutation_requests'?'shot.create':target==='asset_range_requests'?'asset.range.set':'asset.disposition.set';
   assert.throws(()=>f.store.db.prepare(`INSERT INTO ${target} VALUES(?,?,?,?,?)`).run(requestId,targetOperation,f.project.id,'{}','{}'),/already retained/);
  }
 }
 const retained=snapshot(f);f.restart();assert.deepEqual(snapshot(f),retained);
});

test('duplicate presence and corrupted wrong-table placement fail closed for all writers and cannot release a receipt',async t=>{
 const f=await fixture(t),asset=f.asset(),input=f.input(asset);await f.call('asset.disposition.set',input);
 const row=f.store.db.prepare('SELECT * FROM asset_disposition_requests WHERE requestId=?').get(input.requestId);
 for(const trigger of ['reject_mutation_cross_range_request','reject_asset_range_cross_request','reject_mutation_cross_disposition_request','reject_asset_range_cross_disposition_request','reject_asset_disposition_cross_request'])f.store.db.exec(`DROP TRIGGER ${trigger}`);
 f.store.db.exec('PRAGMA ignore_check_constraints=ON');
 for(const table of receiptTables.slice(0,2))f.store.db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?)`).run(row.requestId,row.operation,row.projectId,row.canonicalInput,row.response);
 const before=snapshot(f);
 for(const operation of LOCAL_MUTATION_OPERATIONS)await assert.rejects(f.call(operation,operation==='asset.disposition.set'?input:collisionInput(f,operation,input.requestId)),conflict);
 assert.deepEqual(snapshot(f),before);
 f.store.db.exec('DROP TRIGGER retain_asset_disposition_requests; DROP TRIGGER retain_asset_range_requests');
 for(const table of ['asset_disposition_requests','asset_range_requests'])f.store.db.prepare(`DELETE FROM ${table} WHERE requestId=?`).run(input.requestId);
 await assert.rejects(f.call('asset.disposition.set',input),conflict);
 for(const operation of ['shot.create','asset.range.set']){
  const original=await acceptedInput(f,operation);await f.call(operation,original);
  const table=operationTable(operation),receipt=f.store.db.prepare(`SELECT * FROM ${table} WHERE requestId=?`).get(original.requestId);
  f.store.db.exec(`DROP TRIGGER IF EXISTS retain_${table}`);f.store.db.prepare(`DELETE FROM ${table} WHERE requestId=?`).run(original.requestId);
  f.store.db.prepare('INSERT INTO asset_disposition_requests VALUES(?,?,?,?,?)').run(receipt.requestId,receipt.operation,receipt.projectId,receipt.canonicalInput,receipt.response);
  await assert.rejects(f.call(operation,original),conflict);
 }
});

test('v12 upgrade preserves all old records and response bytes and has identical fresh schema invariants on repeated restart',async t=>{
 const f=await fixture(t),asset=f.asset();await f.call('shot.create',{projectId:f.project.id,title:'Legacy keyed shot',requestId:randomUUID()});
 await f.call('asset.range.set',{projectId:f.project.id,assetId:asset.id,expectedRevision:0,requestId:randomUUID(),inFrame:0,outFrame:30});
 for(const table of ['timeline_requests','reference_requests'])f.store.db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(randomUUID(),'old-hash',' { "old": true, "preserve": "spacing" } ');
 f.store.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run('generation',randomUUID(),'old-hash',randomUUID());
 const schema=()=>f.store.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
 const fresh=schema();
 f.store.db.exec('DROP TRIGGER reject_mutation_cross_disposition_request; DROP TRIGGER reject_asset_range_cross_disposition_request; DROP TABLE asset_disposition_requests; DROP TABLE asset_dispositions; DELETE FROM schema_version WHERE version=12;');
 const old=snapshot(f,['schema_version']);f.restart();
 assert.deepEqual(snapshot(f,['schema_version','asset_dispositions','asset_disposition_requests']),old);assert.deepEqual(schema(),fresh);
 assert.equal(f.store.db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version,13);
 const migrated=snapshot(f);f.restart();assert.deepEqual(snapshot(f),migrated);assert.deepEqual(schema(),fresh);
});

// Competing processes hold and request actual BEGIN IMMEDIATE locks, so every
// helper performs the global receipt lookup only after the winner commits.
const childCode=`
 import {existsSync} from 'node:fs';
 import {openStore} from './packages/business/src/db.mjs';
 import {createServices} from './packages/business/src/services.mjs';
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
 proc.stderr.on('data',chunk=>errorText+=chunk);
 proc.on('message',value=>{messages.push(value);for(const p of [...pending])if(p.phase===value.phase){pending.splice(pending.indexOf(p),1);p.resolve(value);}});
 proc.on('error',error=>{for(const p of pending.splice(0))p.reject(error);});
 proc.on('exit',(code,signal)=>{for(const p of pending.splice(0))p.reject(Error(`Race child exited ${code}/${signal}: ${errorText}`));});
 t.after(()=>{if(proc.exitCode===null)proc.kill('SIGKILL');});
 return {proc,wait:phase=>{const value=messages.find(v=>v.phase===phase);return value?Promise.resolve(value):new Promise((resolve,reject)=>pending.push({phase,resolve,reject}));}};
}
for(const [winnerOperation,loserOperation] of [['asset.disposition.set','shot.create'],['shot.create','asset.disposition.set'],['asset.disposition.set','asset.range.set'],['asset.range.set','asset.disposition.set']])
 test(`two-process namespace race: ${winnerOperation} wins and ${loserOperation} conflicts`,{timeout:15000},async t=>{
  const f=await fixture(t),asset=f.asset(),requestId=randomUUID();
  const inputs={'asset.disposition.set':f.input(asset,{requestId}),'asset.range.set':{projectId:f.project.id,assetId:asset.id,expectedRevision:0,inFrame:0,outFrame:30,requestId},'shot.create':{projectId:f.project.id,title:'Race winner',requestId}};
  const release=path.join(f.root,'release-writer'),winner=child(t,f,winnerOperation,inputs[winnerOperation],release),loser=child(t,f,loserOperation,inputs[loserOperation]);
  await Promise.all([winner.wait('ready'),loser.wait('ready')]);winner.proc.send('start');await winner.wait('locked');
  loser.proc.send('start');await loser.wait('attempt');await writeFile(release,'release');
  const [accepted,rejected]=await Promise.all([winner.wait('result'),loser.wait('result')]);
  assert.equal(accepted.ok,true);assert.equal(rejected.ok,false);assert.equal(rejected.code,'IDEMPOTENCY_CONFLICT');assert.ok(!rejected.details.current);
  assert.equal(receiptTables.reduce((sum,table)=>sum+count(f,table),0),1);
  assert.equal(count(f,'asset_dispositions'),winnerOperation==='asset.disposition.set'?1:0);
  assert.equal(count(f,'asset_ranges'),winnerOperation==='asset.range.set'?1:0);assert.equal(count(f,'shots'),winnerOperation==='shot.create'?1:0);
  assert.deepEqual(await f.call(winnerOperation,inputs[winnerOperation]),accepted.value);
 });
