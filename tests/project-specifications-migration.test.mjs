import test from 'node:test';
import {currentMarkerChain} from './helpers/current-schema-delta.ts';
import {currentOrdinary48Delta,reviewedObjectSql} from './helpers/current-schema-delta.ts';
import assert from 'node:assert/strict';
import {normalizeAgentEditProposalObject,legacyAgentEditProposalRows,assertAgentEditTargetTrigger} from './agent-edit-migration-preservation.mjs';
import {DatabaseSync} from 'node:sqlite';
import {normalizeImageReviewObject} from './image-edit-migration-preservation.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {migrateComfyImageReviewSchema} from '../packages/business/src/images/review-schema.ts';
import {migrateComfyImageSchema} from '../packages/business/src/comfy-image-schema.ts';
import {migrateFrameSchema} from '../packages/business/src/frame-schema.ts';
import {migrateTimelineFormatSchema} from '../packages/business/src/timeline-format-schema.ts';
import {migrateTimelineFormatEditTasks} from '../packages/business/src/edit-task-schema.ts';

// Schema20 is independently reconstructed from the frozen schema18 SQL and the
// unchanged schema19/20 migrations at eac925c. In particular, no production v21
// edit-task DDL or current operation registry manufactures the legacy fixture.
const LEGACY_OPERATIONS=Object.freeze([
 'timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update',
 'timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.split','timeline.seed',
 'timeline.undo','timeline.redo','reference.attach','reference.detach',
 'subject.create','subject.version.add','subject.binding.set',
]);
const STATES=[['prepared',0,'new'],['dispatching',0,'new'],['unknown',0,'legacy_session'],
 ['unknown',0,'new'],['applied',0,'new'],['applied',1,'legacy_session'],['not_applied',0,'new'],['not_applied',1,'new']];
const COLUMNS=['position','id','projectId','operation','input','requestId','digest','lane','origin','status','revision',
 'acknowledged','claim','claimInstance','receiptDigest','errorCode','createdAt','updatedAt','bytes'];
const AT='2026-10-11T00:00:00.000Z';
const quote=name=>'"'+name.replaceAll('"','""')+'"';
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const raw=value=>' \n'+JSON.stringify(Object.fromEntries(Object.entries(value).reverse()),null,'\t').replaceAll('界','\\u754c')+'\n ';
const lane=operation=>operation.startsWith('timeline.')?'timeline:mutation':operation.startsWith('reference.')?'reference:mutation':'subject:mutation';
const insert=(db,table,row)=>{const keys=Object.keys(row);return db.prepare(`INSERT INTO ${quote(table)}(${keys.map(quote).join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));};
function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
function probe(db,fn){db.exec('SAVEPOINT migration_probe');try{return fn();}finally{db.exec('ROLLBACK TO migration_probe;RELEASE migration_probe');}}
function root(t){const value=mkdtempSync(path.join(tmpdir(),'mioon-format-v20-'));t.after(()=>rmSync(value,{recursive:true,force:true}));return value;}
function database(filename=':memory:'){
 const db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=ON');
 db.exec(readFileSync(new URL('./fixtures/images-legacy-schema18.sql',import.meta.url),'utf8'));
 transaction(db,()=>{migrateComfyImageReviewSchema(db);migrateComfyImageSchema(db);db.exec('INSERT INTO schema_version VALUES(19)');});
 transaction(db,()=>{migrateFrameSchema(db);db.exec('INSERT INTO schema_version VALUES(20)');});
 // A started v20 store already contains this unchanged journal singleton.
 insert(db,'agent_chat_quota',{id:1,runs:0,bytes:0,reservedBytes:0});
 assert.equal(db.prepare('SELECT max(version) AS n FROM schema_version').get().n,20);
 return db;
}
function migrate(db){return transaction(db,()=>{migrateTimelineFormatSchema(db);migrateTimelineFormatEditTasks(db);db.exec('INSERT INTO schema_version VALUES(21)');});}
function snapshot(db){
 const objects=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 const records=Object.fromEntries(objects.filter(row=>row.type==='table').map(({name})=>[name,
  db.prepare(name==='sqlite_sequence'?'SELECT rowid AS retainedRowid,* FROM sqlite_sequence ORDER BY name':`SELECT rowid AS retainedRowid,* FROM ${quote(name)} ORDER BY rowid`).all()]));
 return {objects,records,inputBytes:db.prepare('SELECT position,hex(CAST(input AS BLOB)) AS raw FROM edit_tasks ORDER BY position').all(),
  columns:db.prepare('PRAGMA table_info(edit_tasks)').all(),foreignKeys:db.prepare('PRAGMA foreign_key_list(edit_tasks)').all()};
}
function preserved(db,before){
 const after=snapshot(db),agentTargets=Boolean(db.prepare('SELECT 1 FROM schema_version WHERE version=24').get());
 if(agentTargets)assertAgentEditTargetTrigger(after.objects);
 for(const [table,rows] of Object.entries(before.records)){
  const actual=table==='schema_version'?after.records[table].filter(row=>row.version<=20):agentTargets&&table==='agent_edit_proposals'?legacyAgentEditProposalRows(after.records[table]):after.records[table];
  assert.deepEqual(actual,rows,`${table}: raw columns and historical rowids remain unchanged`);
  assert.equal(hash(actual),hash(rows),`${table}: byte-sensitive record hash`);
 }
 assert.deepEqual(after.inputBytes,before.inputBytes,'input whitespace, escaping, key order and UTF-8 bytes');
 assert.deepEqual(after.columns,before.columns,'no task columns, affinities, nullability or defaults change');
 assert.deepEqual(after.foreignKeys,before.foreignKeys,'legacy task foreign keys remain unchanged');
 for(const object of before.objects.filter(row=>!(row.type==='table'&&row.name==='edit_tasks'))){
  const current=after.objects.find(row=>row.type===object.type&&row.name===object.name);
  const normalized=object.type==='table'&&object.name==='image_reviews'&&db.prepare('SELECT 1 FROM schema_version WHERE version=23').get()?normalizeImageReviewObject(current):agentTargets&&object.type==='table'&&object.name==='agent_edit_proposals'?normalizeAgentEditProposalObject(current):current;
  const reviewed=!db.prepare('SELECT 1 FROM schema_version WHERE version=48').get()||currentOrdinary48Delta.objectSql[object.name]===undefined?object:Object.assign(Object.create(Object.getPrototypeOf(object)),object,{sql:reviewedObjectSql(object.name,object.sql)});
  assert.deepEqual(normalized,reviewed,`${object.type} ${object.name}: exact SQL retained outside the pinned schema23/24 additions`);
 }
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
}
function project(db,label='界 raw project'){
 const id=randomUUID();insert(db,'projects',{id,data:raw({id,name:label,revision:1,createdAt:AT,updatedAt:AT})});return id;
}
function legacyInput(operation,projectId,requestId){
 const base={projectId,requestId},revision={...base,expectedRevision:1};
 switch(operation){
  case 'timeline.track.add':return {...revision,kind:'audio'};
  case 'timeline.track.update':return {...revision,trackId:randomUUID(),patch:{name:'界 retained track'}};
  case 'timeline.clip.add':return {...revision,assetId:randomUUID(),trackId:randomUUID(),startFrame:0,durationFrames:30};
  case 'timeline.clip.update':return {...revision,clipId:randomUUID(),patch:{name:'界 retained clip'}};
  case 'timeline.clip.replaceSource':return {...revision,clipId:randomUUID(),assetId:randomUUID()};
  case 'timeline.clip.remove':return {...revision,clipId:randomUUID()};
  case 'timeline.clip.split':return {...revision,clipId:randomUUID(),atFrame:15};
  case 'reference.attach':return {...base,sourceNodeId:randomUUID(),targetShotId:randomUUID(),expectedSourceRevision:1,expectedShotRevision:1,role:'first_frame'};
  case 'reference.detach':return {...base,edgeId:randomUUID(),expectedShotRevision:1};
  case 'subject.create':return {...base,kind:'character',name:'界 retained subject',assetId:randomUUID()};
  case 'subject.version.add':return {...revision,subjectId:randomUUID(),assetId:randomUUID()};
  case 'subject.binding.set':return {...base,shotId:randomUUID(),subjectId:randomUUID(),role:'subject',subjectVersionId:null,expectedRevision:0,expectedSubjectRevision:1};
  case 'timeline.format.set':return {...base,expectedRevision:0,expectedProjectRevision:1,presetId:'landscape_720'};
  default:return revision;
 }
}
function candidate(db,{operation='timeline.track.add',status='prepared',acknowledged=0,origin='new',position=null,...patch}={}){
 const projectId=project(db),requestId=`retained-界-"\\-${randomUUID()}`;
 const input=legacyInput(operation,projectId,requestId);
 const claimed=status==='dispatching'||status==='not_applied'||(status==='applied'&&origin==='new')||(status==='unknown'&&origin==='new');
 return {position,id:randomUUID(),projectId,operation,input:raw(input),requestId,digest:hash({operation,input}),lane:lane(operation),origin,status,
  revision:status==='prepared'?1:status==='dispatching'?2:acknowledged?4:3,acknowledged,
  claim:claimed?randomUUID():null,claimInstance:claimed?randomUUID():null,receiptDigest:status==='applied'?'b'.repeat(64):null,
  errorCode:status==='not_applied'?'REVISION_CONFLICT':null,createdAt:AT,updatedAt:'2026-10-11T01:02:03.004Z',bytes:16384,...patch};
}
function seed(db){
 const projectId=project(db),assetId=randomUUID(),shotId=randomUUID(),jobId=randomUUID();
 for(const [table,id] of [['assets',assetId],['shots',shotId],['nodes',randomUUID()],['edges',randomUUID()],['jobs',jobId],['exports',randomUUID()],['timelines',randomUUID()]])
  insert(db,table,{id,projectId,data:raw({id,projectId,revision:17,name:'界 retained JSON',omitted:null,legacy:[3,2,1]})});
 insert(db,'versions',{id:randomUUID(),projectId,jobId,data:raw({assetId,projectId,legacy:'界 frozen version'})});
 insert(db,'job_events',{id:17,jobId,event:'{ "legacy" : "界" }',createdAt:AT});
 for(const table of ['timeline_requests','reference_requests'])insert(db,table,{requestId:randomUUID(),requestHash:'a'.repeat(64),response:' \n{ "historical": "界", "order" : [3,2,1] }\n'});
 insert(db,'timeline_history',{id:randomUUID(),projectId,position:1,operation:'timeline.clip.add',createdAt:AT,beforeSnapshot:'{ "clips": [] }',afterSnapshot:'{ "clips": [], "legacy": "界" }'});
 insert(db,'timeline_history_cursors',{projectId,position:0});
 insert(db,'idempotency',{scope:'export',requestId:randomUUID(),requestHash:'b'.repeat(64),resourceId:randomUUID()});
 insert(db,'workspace_preferences',{projectId,revision:3,state:'{ "legacy": "界", "expanded" : false }'});
 for(const [table,operation] of [['mutation_requests','shot.create'],['asset_range_requests','asset.range.set'],['asset_disposition_requests','asset.disposition.set']])
  insert(db,table,{requestId:randomUUID(),operation,projectId,canonicalInput:raw({projectId,note:'界 retained input'}),response:raw({projectId,note:'界 exact ACK'})});
 insert(db,'asset_ranges',{assetId,projectId,revision:2,inFrame:5,outFrame:31});
 insert(db,'asset_dispositions',{assetId,projectId,revision:3,disposition:'favorite'});
 insert(db,'waveform_cache',{position:8,cacheKey:'a'.repeat(64),projectId,sourceSha256:'c'.repeat(64),algorithm:'legacy-v1',status:'interrupted',attemptId:randomUUID(),data:'{ "retained": "界" }',bytes:40,reservedBytes:20});
 const threadId=randomUUID(),runId=randomUUID(),chatRequestId=randomUUID();
 insert(db,'agent_chat_threads',{id:threadId,projectId,revision:2,nextPosition:2});
 insert(db,'agent_chat_requests',{requestId:chatRequestId,projectId,threadId,runId,fingerprint:'legacy fingerprint',acceptance:'{ "accepted" : "界" }',bytes:40});
 insert(db,'agent_chat_runs',{id:runId,projectId,threadId,requestId:chatRequestId,position:1,status:'interrupted',data:'{ "legacy": "界" }',bytes:40});
 insert(db,'agent_chat_events',{runId,seq:1,data:'{ "legacy": "界" }',bytes:40});
 insert(db,'agent_chat_steps',{id:randomUUID(),runId,projectId,position:1,kind:'model',status:'unknown',data:'{ "legacy": "界" }',bytes:40});
 insert(db,'agent_edit_proposals',{position:6,id:randomUUID(),projectId,runId,shotId,digest:'d'.repeat(64),definition:'{ "legacy": "界" }',status:'pending',approval:null,outcome:null,createdAt:AT,updatedAt:AT,bytes:100});
 const subjectId=randomUUID(),subjectVersionId=randomUUID();
 transaction(db,()=>{
  insert(db,'subjects',{id:subjectId,projectId,kind:'character',name:'界 subject',revision:1,headVersionId:subjectVersionId,createdAt:AT,updatedAt:AT});
  insert(db,'subject_versions',{id:subjectVersionId,projectId,subjectId,number:1,assetId,data:raw({id:subjectVersionId,projectId,subjectId,number:1,assetId})});
 });
 insert(db,'subject_bindings',{id:randomUUID(),projectId,shotId,subjectId,role:'subject',revision:1,subjectVersionId:null,reviewedHeadVersionId:subjectVersionId,createdAt:AT,updatedAt:AT});
 insert(db,'subject_requests',{requestId:randomUUID(),operation:'subject.create',projectId,canonicalInput:raw({projectId,note:'界 original'}),response:raw({projectId,subjectId})});
 const groupId=randomUUID(),imageTaskId=randomUUID(),imageRequestId=randomUUID();
 const imageInput={projectId,requestId:imageRequestId,providerId:'mock',model:'mock-image-v1',prompt:'界 original'},imageSnapshot={schemaVersion:1,projectId,groupId,taskId:imageTaskId};
 transaction(db,()=>{
  insert(db,'image_groups',{id:groupId,projectId,name:'界 queued image',revision:1,headVersionId:null,activeTaskId:imageTaskId,createdAt:AT,updatedAt:AT});
  insert(db,'image_tasks',{id:imageTaskId,projectId,groupId,requestId:imageRequestId,inputHash:hash(imageInput),input:raw(imageInput),snapshot:raw(imageSnapshot),state:'queued',revision:1,dispatched:0,stagedReceipt:null,versionId:null,errorCode:null,createdAt:AT,updatedAt:AT});
  insert(db,'image_requests',{requestId:imageRequestId,operation:'image.generate',projectId,inputHash:hash(imageInput),canonicalInput:raw(imageInput),response:raw({projectId,id:imageTaskId,state:'queued'})});
 });
 const frameId=randomUUID(),frameRequestId=randomUUID(),frameInput={projectId,requestId:frameRequestId,sourceAssetId:assetId,sourceHash:'c'.repeat(64),sourceFrame:5};
 const frameSnapshot={schemaVersion:1,projectId,taskId:frameId,source:{assetId,sha256:frameInput.sourceHash},requested:{sourceFrame:5,fps:30},profile:{id:'local-png-1024-v1',selectionRule:'first-pts-at-or-after-v1',maxEdge:1024,mimeType:'image/png',upscale:false}};
 transaction(db,()=>{
  insert(db,'frame_tasks',{id:frameId,projectId,requestId:frameRequestId,inputHash:hash(frameInput),input:raw(frameInput),snapshot:raw(frameSnapshot),state:'queued',revision:1,started:0,stagedReceipt:null,assetId:null,errorCode:null,createdAt:AT,updatedAt:AT});
  insert(db,'frame_requests',{requestId:frameRequestId,operation:'frame.extract',projectId,taskId:frameId,inputHash:hash(frameInput),canonicalInput:raw(frameInput),response:raw({id:frameId,projectId,requestId:frameRequestId,sourceAssetId:assetId,sourceHash:frameInput.sourceHash,sourceFrame:5,fps:30,profileId:'local-png-1024-v1',state:'queued',revision:1,started:false,result:null,errorCode:null,createdAt:AT,updatedAt:AT})});
 });
 let position=3;
 for(const operation of LEGACY_OPERATIONS)for(const [status,acknowledged,origin] of STATES){insert(db,'edit_tasks',candidate(db,{operation,status,acknowledged,origin,position}));position+=7;}
 db.prepare("UPDATE sqlite_sequence SET seq=40000 WHERE name='edit_tasks'").run();
 const rows=db.prepare('SELECT * FROM edit_tasks').all();
 assert.equal(rows.length,LEGACY_OPERATIONS.length*STATES.length);
 assert.deepEqual(new Set(rows.map(row=>row.lane)),new Set(['timeline:mutation','reference:mutation','subject:mutation']));
 assert.deepEqual(new Set(rows.map(row=>row.status)),new Set(['prepared','dispatching','unknown','applied','not_applied']));
 assert.ok(rows.every(row=>row.input.includes('\\u754c')));
}
function assertTaskSqlExpansion(current,previous,{startup=false}={}){
 const additions=['timeline.format.set',...(startup?['timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove','timeline.loudness.apply']:[]),...(current.includes(",'timeline.clip.rippleRemove'")?['timeline.clip.rippleRemove']:[])];
 const operationList=sql=>sql.match(/CHECK\(operation IN \(([^)]+)\)\)/)[1].split(',').map(value=>value.trim().slice(1,-1));
 assert.deepEqual(operationList(current).sort(),[...LEGACY_OPERATIONS,...additions].sort(),'only the exact named task operations are admitted, once each');
 let retained=current;
 for(const operation of additions){
  const token=`,'${operation}'`;
  assert.equal(retained.split(token).length,2,`only one explicit later operation ${operation} changes historical SQL`);
  retained=retained.replace(token,'');
 }
 assert.equal(retained,previous,'the exact named operation tokens are the only task table DDL change');
}
function assertNarrowExpansion(db,before,{startup=false}={}){
 const previous=before.objects.find(row=>row.type==='table'&&row.name==='edit_tasks').sql;
 const current=db.prepare("SELECT sql FROM sqlite_schema WHERE name='edit_tasks'").get().sql;
 assertTaskSqlExpansion(current,previous,{startup});
 assert.deepEqual(db.prepare('PRAGMA table_info(edit_tasks)').all().map(row=>row.name),COLUMNS);
 assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),startup?[...currentMarkerChain]:Array.from({length:21},(_,index)=>index+1));
 assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name LIKE 'edit_tasks_%'").get().n,0);
 assert.deepEqual(db.prepare('SELECT * FROM timeline_format_requests').all(),[],'migration invents no requests or specifications');
}

test('startup SQL normalization rejects missing, duplicate, extra and isolated loudness expansion',t=>{
 const db=database();t.after(()=>db.close());
 const previous=snapshot(db).objects.find(row=>row.type==='table'&&row.name==='edit_tasks').sql;
 migrate(db);
 const isolated=db.prepare("SELECT sql FROM sqlite_schema WHERE name='edit_tasks'").get().sql;
 const current=isolated.replace(/(CHECK\(operation IN \([^)]+)(\)\))/,(_,head,tail)=>head+['timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove','timeline.loudness.apply'].map(operation=>`,'${operation}'`).join('')+tail);
 assertTaskSqlExpansion(isolated,previous);
 assertTaskSqlExpansion(current,previous,{startup:true});
 const token=",'timeline.loudness.apply'";
 for(const changed of [current.replace(token,''),current.replace(token,token+token),current.replace(token,token+",'timeline.loudness.preview'"),current.replace('CHECK(bytes=16384)','CHECK(bytes=16385)')]){
  assert.throws(()=>assertTaskSqlExpansion(changed,previous,{startup:true}),assert.AssertionError);
 }
 assert.throws(()=>assertTaskSqlExpansion(current,previous),assert.AssertionError,'isolated historical migrations cannot admit loudness');
});

test('schema21 preserves independently frozen schema20 rows, raw task inputs, all states, every index and trigger',t=>{
 const db=database();t.after(()=>db.close());seed(db);const before=snapshot(db);
 migrate(db);preserved(db,before);assertNarrowExpansion(db,before);
 const added=snapshot(db).objects.filter(row=>row.type==='table'&&!before.objects.some(old=>old.type==='table'&&old.name===row.name));
 assert.deepEqual(added.map(row=>row.name),['timeline_format_requests']);
 probe(db,()=>{const row=candidate(db,{operation:'timeline.format.set'});insert(db,'edit_tasks',row);assert.equal(db.prepare('SELECT position FROM edit_tasks WHERE id=?').get(row.id).position,40001);});
 preserved(db,before);
});

test('actual schema20 startup migration matches fresh schema26 and is byte-stable across repeated restarts',t=>{
 const upgradedRoot=root(t),freshRoot=root(t),legacy=database(path.join(upgradedRoot,'workbench.sqlite'));seed(legacy);const before=snapshot(legacy);legacy.close();
 let upgraded=openStore(upgradedRoot);const fresh=openStore(freshRoot);t.after(()=>{upgraded.close();fresh.close();});
 preserved(upgraded.db,before);assertNarrowExpansion(upgraded.db,before,{startup:true});
 const relevant=db=>snapshot(db).objects.filter(row=>row.tbl_name==='edit_tasks'||row.tbl_name==='timeline_format_requests');
 assert.deepEqual(relevant(upgraded.db),relevant(fresh.db));
 const after=snapshot(upgraded.db);
 for(let count=0;count<2;count++){upgraded.close();upgraded=openStore(upgradedRoot);assert.deepEqual(snapshot(upgraded.db),after);}
});

for(const priorSequence of [null,0,8123])test(`schema21 keeps an empty v20 edit-task sequence ${priorSequence===null?'absent':priorSequence}`,t=>{
 const db=database();t.after(()=>db.close());
 if(priorSequence!==null)insert(db,'sqlite_sequence',{name:'edit_tasks',seq:priorSequence});
 const before=snapshot(db);migrate(db);preserved(db,before);
 probe(db,()=>{const row=candidate(db,{operation:'timeline.format.set'});insert(db,'edit_tasks',row);assert.equal(db.prepare('SELECT position FROM edit_tasks WHERE id=?').get(row.id).position,(priorSequence??0)+1);});
});

test('failed schema21 marker rolls back both new objects and raw-column task rebuild, then startup succeeds',t=>{
 const location=root(t),filename=path.join(location,'workbench.sqlite');let db=database(filename);seed(db);
 db.exec("CREATE TRIGGER reject_schema21 BEFORE INSERT ON schema_version WHEN NEW.version=21 BEGIN SELECT RAISE(ABORT,'injected schema21 marker failure');END");
 const before=snapshot(db);db.close();assert.throws(()=>openStore(location),/injected schema21 marker failure/);
 db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=ON');assert.deepEqual(snapshot(db),before);
 db.exec('DROP TRIGGER reject_schema21');const retryBefore=snapshot(db);db.close();
 const store=openStore(location);t.after(()=>store.close());preserved(store.db,retryBefore);assertNarrowExpansion(store.db,retryBefore,{startup:true});
});

test('migration transaction preconditions and inconsistent task sequence fail without partial rebuild',t=>{
 const db=database();t.after(()=>db.close());
 assert.throws(()=>migrateTimelineFormatSchema(db),/transaction/i);assert.throws(()=>migrateTimelineFormatEditTasks(db),/transaction/i);
 insert(db,'edit_tasks',candidate(db,{position:30}));db.prepare("UPDATE sqlite_sequence SET seq=29 WHERE name='edit_tasks'").run();
 const before=snapshot(db);assert.throws(()=>migrate(db),/sequence/i);assert.deepEqual(snapshot(db),before);
});

test('expanded edit-task allowlist keeps all original lane, identity, transition and retained-capacity constraints',t=>{
 const db=database();t.after(()=>db.close());migrate(db);const before=snapshot(db);
 for(const operation of [...LEGACY_OPERATIONS,'timeline.format.set'])probe(db,()=>{insert(db,'edit_tasks',candidate(db,{operation}));});
 for(const operation of ['timeline.format.get','timeline.render','timeline.format.delete','subject.delete','reference.anything'])probe(db,()=>{
  assert.throws(()=>insert(db,'edit_tasks',candidate(db,{operation})),/CHECK constraint/);
 });
 for(const patch of [{lane:'format:mutation'},{lane:'reference:mutation'},{lane:'subject:mutation'},{bytes:16383},{revision:0},{revision:1.5},{revision:9007199254740992},
  {acknowledged:1},{status:'dispatching',claim:null,claimInstance:null},{status:'applied',receiptDigest:null},{status:'not_applied',errorCode:null},
  {claim:randomUUID()},{origin:'legacy_session'},{input:'[]'},{input:'not JSON'},{input:JSON.stringify({projectId:randomUUID(),requestId:randomUUID()})},{digest:'short'},{createdAt:''}])probe(db,()=>{
  assert.throws(()=>insert(db,'edit_tasks',{...candidate(db,{operation:'timeline.format.set'}),...patch}),undefined,JSON.stringify(patch));
 });
 probe(db,()=>{
  const row=candidate(db,{operation:'timeline.format.set'});insert(db,'edit_tasks',row);
  assert.throws(()=>db.prepare('DELETE FROM edit_tasks WHERE id=?').run(row.id),/retained/);
  assert.throws(()=>db.prepare('INSERT OR REPLACE INTO edit_tasks SELECT * FROM edit_tasks WHERE id=?').run(row.id),/immutable/);
  for(const key of ['id','projectId','operation','input','requestId','digest','lane','origin','createdAt','bytes'])
   assert.throws(()=>db.prepare(`UPDATE edit_tasks SET ${quote(key)}=?,revision=revision+1,status='dispatching',claim=?,claimInstance=? WHERE id=?`).run(typeof row[key]==='number'?row[key]+1:row[key]+'!',randomUUID(),randomUUID(),row.id),/immutable/,key);
  const nextRequestId=randomUUID();
  assert.throws(()=>insert(db,'edit_tasks',{...row,id:randomUUID(),requestId:nextRequestId,input:raw({...JSON.parse(row.input),requestId:nextRequestId})}),/UNIQUE constraint/);
  assert.throws(()=>db.prepare("UPDATE edit_tasks SET status='unknown',revision=revision+1 WHERE id=?").run(row.id),/transition/);
  db.prepare("UPDATE edit_tasks SET status='dispatching',revision=revision+1,claim=?,claimInstance=? WHERE id=?").run(randomUUID(),randomUUID(),row.id);
  db.prepare("UPDATE edit_tasks SET status='unknown',revision=revision+1 WHERE id=?").run(row.id);
  assert.throws(()=>db.prepare("UPDATE edit_tasks SET status='dispatching',revision=revision+1 WHERE id=?").run(row.id),/transition/);
  db.prepare("UPDATE edit_tasks SET status='dispatching',revision=revision+1,claim=?,claimInstance=? WHERE id=?").run(randomUUID(),randomUUID(),row.id);
  db.prepare("UPDATE edit_tasks SET status='not_applied',revision=revision+1,errorCode='REVISION_CONFLICT' WHERE id=?").run(row.id);
  assert.throws(()=>db.prepare("UPDATE edit_tasks SET acknowledged=1,revision=revision+1,errorCode='DIFFERENT' WHERE id=?").run(row.id),/transition/);
  db.prepare('UPDATE edit_tasks SET acknowledged=1,revision=revision+1 WHERE id=?').run(row.id);
  insert(db,'edit_tasks',{...row,id:randomUUID(),requestId:nextRequestId,input:raw({...JSON.parse(row.input),requestId:nextRequestId})});
 });
 assert.deepEqual(snapshot(db),before,'constraint probes do not consume sequence or alter retained rows');
});

test('format companion binds a retained timeline request and preserves immutable canonical input bytes',t=>{
 const db=database();t.after(()=>db.close());migrate(db);const projectId=project(db),requestId=randomUUID();
 const input={projectId,requestId,expectedProjectRevision:1,expectedRevision:0,presetId:'landscape_720'};
 const row={requestId,projectId,input:canonical(input)};
 for(const patch of [{requestId:null},{requestId:'short'},{input:'{}'},{input:'[]'},{input:'not JSON'},
  {input:canonical({...input,projectId:randomUUID()})},{input:canonical({...input,requestId:randomUUID()})},
  {input:canonical({requestId,presetId:'landscape_720'})},{input:canonical({projectId,presetId:'landscape_720'})}]){
  assert.throws(()=>insert(db,'timeline_format_requests',{...row,...patch}),/CHECK|NOT NULL|malformed JSON/,JSON.stringify(patch));
 }
 assert.throws(()=>insert(db,'timeline_format_requests',row),/FOREIGN KEY/);
 insert(db,'timeline_requests',{requestId,requestHash:hash({operation:'timeline.format.set',input}),response:'{}'});
 insert(db,'timeline_format_requests',row);
 assert.deepEqual({...db.prepare('SELECT * FROM timeline_format_requests WHERE requestId=?').get(requestId)},row);
 for(const statement of ['UPDATE timeline_format_requests SET input=input','UPDATE timeline_format_requests SET projectId=projectId','DELETE FROM timeline_format_requests',
  'INSERT OR REPLACE INTO timeline_format_requests SELECT * FROM timeline_format_requests'])assert.throws(()=>db.exec(statement),/immutable|retained|replaced/);
 assert.throws(()=>db.prepare('DELETE FROM timeline_requests WHERE requestId=?').run(requestId),/FOREIGN KEY|retained|immutable/);
 const columns=db.prepare('PRAGMA foreign_key_list(timeline_format_requests)').all();
 assert.ok(columns.some(row=>row.table==='timeline_requests'&&row.from==='requestId'&&row.to==='requestId'));
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
