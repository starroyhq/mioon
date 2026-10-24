import {withoutReviewedSceneObjects,currentOrdinary58Delta} from './helpers/current-schema58-delta.ts';
import {withoutReviewedInteractionObjects} from './helpers/current-schema56-delta.ts';
function withoutReviewedCurrentAgentObjects(objects){return withoutReviewedConversationObjects(withoutReviewedInteractionObjects(withoutReviewedSceneObjects(objects)));}
import {withoutReviewedConversationObjects} from './helpers/current-schema54-delta.ts';
import test from 'node:test';
import {currentMarkerChain} from './helpers/current-schema-delta.ts';
import {currentOrdinary48Delta,currentOrdinary50Delta,currentOrdinary52Delta,reviewedObjectSql} from './helpers/current-schema-delta.ts';
import {openLegacyWorkspaceStore} from './helpers/legacy-workspace-store.ts';
import assert from 'node:assert/strict';
import {normalizeAgentEditProposalObject,legacyAgentEditProposalRows,assertAgentEditTargetTrigger} from './agent-edit-migration-preservation.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices,hash} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {bootstrapEditTaskSchema,migrateSubjectEditTasks} from '../packages/business/src/edit-task-schema.ts';
import {schemas,DURABLE_EDIT_OPERATIONS,editTaskLane} from '@mioon/contracts';

// Independently frozen from schema 14 at 1b08cf2. Do not derive this fixture
// from the replacement table or import its production DDL helper: either would
// allow a migration regression to silently redefine the historical fixture.
const LEGACY_EDIT_TASK_SCHEMA = String.raw` CREATE TABLE IF NOT EXISTS edit_tasks(
 position INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE CHECK(length(CAST(id AS BLOB))=36),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 operation TEXT NOT NULL CHECK(operation IN ('timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.split','timeline.seed','timeline.undo','timeline.redo','reference.attach','reference.detach')),
 input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object' AND length(CAST(input AS BLOB)) BETWEEN 1 AND 8192),
 requestId TEXT NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 digest TEXT NOT NULL CHECK(length(CAST(digest AS BLOB))=64),
 lane TEXT NOT NULL CHECK(lane IN ('timeline:mutation','reference:mutation')),
 origin TEXT NOT NULL CHECK(origin IN ('new','legacy_session')),
 status TEXT NOT NULL CHECK(status IN ('prepared','dispatching','unknown','applied','not_applied')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 acknowledged INTEGER NOT NULL CHECK(acknowledged IN (0,1)),
 claim TEXT CHECK(claim IS NULL OR length(CAST(claim AS BLOB))=36),
 claimInstance TEXT CHECK(claimInstance IS NULL OR length(CAST(claimInstance AS BLOB))=36),
 receiptDigest TEXT CHECK(receiptDigest IS NULL OR length(CAST(receiptDigest AS BLOB))=64),
 errorCode TEXT CHECK(errorCode IS NULL OR length(CAST(errorCode AS BLOB)) BETWEEN 1 AND 80),
 createdAt TEXT NOT NULL CHECK(length(CAST(createdAt AS BLOB)) BETWEEN 1 AND 40),
 updatedAt TEXT NOT NULL CHECK(length(CAST(updatedAt AS BLOB)) BETWEEN 1 AND 40),
 bytes INTEGER NOT NULL CHECK(bytes=16384),UNIQUE(lane,requestId),
 CHECK(json_extract(input,'$.projectId')=projectId AND json_extract(input,'$.requestId')=requestId),
 CHECK((operation LIKE 'timeline.%' AND lane='timeline:mutation') OR (operation LIKE 'reference.%' AND lane='reference:mutation')),
 CHECK((status='applied')=(receiptDigest IS NOT NULL)),CHECK((status='not_applied')=(errorCode IS NOT NULL)),
 CHECK((claim IS NULL)=(claimInstance IS NULL)),CHECK(status!='dispatching' OR claim IS NOT NULL),
 CHECK(status!='prepared' OR (origin='new' AND claim IS NULL)),CHECK(acknowledged=0 OR status IN ('applied','not_applied')));
 CREATE UNIQUE INDEX IF NOT EXISTS edit_task_one_pending_lane ON edit_tasks(projectId,lane) WHERE acknowledged=0;
 CREATE INDEX IF NOT EXISTS edit_tasks_project_page ON edit_tasks(projectId,position DESC);
 CREATE INDEX IF NOT EXISTS edit_tasks_project_pending_page ON edit_tasks(projectId,acknowledged,position DESC);
 CREATE TRIGGER IF NOT EXISTS reject_edit_task_replacement BEFORE INSERT ON edit_tasks
 WHEN EXISTS(SELECT 1 FROM edit_tasks WHERE id=NEW.id OR position=NEW.position OR (lane=NEW.lane AND requestId=NEW.requestId))
 BEGIN SELECT RAISE(ABORT,'edit task identities are immutable');END;
 CREATE TRIGGER IF NOT EXISTS immutable_edit_task_identity BEFORE UPDATE ON edit_tasks
 WHEN NEW.position IS NOT OLD.position OR NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR
 NEW.operation IS NOT OLD.operation OR NEW.input IS NOT OLD.input OR NEW.requestId IS NOT OLD.requestId OR
 NEW.digest IS NOT OLD.digest OR NEW.lane IS NOT OLD.lane OR NEW.origin IS NOT OLD.origin OR
 NEW.createdAt IS NOT OLD.createdAt OR NEW.bytes IS NOT OLD.bytes
 BEGIN SELECT RAISE(ABORT,'edit task identities are immutable');END;
 CREATE TRIGGER IF NOT EXISTS retain_edit_tasks BEFORE DELETE ON edit_tasks
 BEGIN SELECT RAISE(ABORT,'edit task identities must be retained');END;
 CREATE TRIGGER IF NOT EXISTS edit_task_state_transitions BEFORE UPDATE ON edit_tasks
 WHEN NEW.revision!=OLD.revision+1 OR OLD.revision>=9007199254740991 OR
 NOT ((OLD.status='prepared' AND NEW.status IN ('dispatching','applied')) OR
      (OLD.status='unknown' AND NEW.status IN ('dispatching','applied')) OR
      (OLD.status='dispatching' AND NEW.status IN ('unknown','applied','not_applied')) OR
      (OLD.status IN ('applied','not_applied') AND NEW.status=OLD.status AND OLD.acknowledged=0 AND NEW.acknowledged=1)) OR
 (OLD.status NOT IN ('applied','not_applied') AND NEW.acknowledged!=0) OR
 (OLD.status IN ('applied','not_applied') AND (NEW.receiptDigest IS NOT OLD.receiptDigest OR NEW.errorCode IS NOT OLD.errorCode)) OR
 (NEW.status!='dispatching' AND (NEW.claim IS NOT OLD.claim OR NEW.claimInstance IS NOT OLD.claimInstance)) OR
 (NEW.status='dispatching' AND (NEW.claim IS NULL OR NEW.claim IS OLD.claim))
 BEGIN SELECT RAISE(ABORT,'invalid edit task transition');END;
`;
const LEGACY_OPERATIONS = Object.freeze([
 'timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update',
 'timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.split','timeline.seed',
 'timeline.undo','timeline.redo','reference.attach','reference.detach',
]);
const SUBJECT_TABLES = ['subjects','subject_versions','subject_bindings','subject_requests'];
const LATER_IMAGE_TABLES = ['image_groups','image_tasks','image_versions','image_requests','image_reviews','image_remote_runs','image_remote_observations'];
const LATER_FRAME_TABLES = ['frame_tasks','frame_requests'];
const COLUMNS = ['position','id','projectId','operation','input','requestId','digest','lane','origin','status',
 'revision','acknowledged','claim','claimInstance','receiptDigest','errorCode','createdAt','updatedAt','bytes'];
const WHEN = '2026-09-08T07:06:05.004Z';
const quote = name => '"'+name.replaceAll('"','""')+'"';
const rows = (db,table) => db.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all();
const schema = db => db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
const editObjects = db => schema(db).filter(row => row.tbl_name==='edit_tasks' && row.type!=='table');
const sequence = db => db.prepare("SELECT * FROM sqlite_sequence WHERE name='edit_tasks'").all();
const current48Tables = new Set([...Object.keys(currentOrdinary48Delta.lifecycleTables),'asset_annotations','asset_annotation_requests','lut_import_requests','project_lut_resources']);
const current50Tables = new Set(Object.keys(currentOrdinary50Delta.tables));
const allRecords = db => Object.fromEntries(schema(db).filter(row=>row.type==='table' && row.name!=='schema_version' && !SUBJECT_TABLES.includes(row.name) && !LATER_IMAGE_TABLES.includes(row.name) && !LATER_FRAME_TABLES.includes(row.name) && row.name!=='timeline_format_requests' && !current48Tables.has(row.name) && !current50Tables.has(row.name)).map(row=>[row.name,rows(db,row.name)]));
export const snapshotSchema14 = db => ({records:allRecords(db),schema:schema(db),editTasks:rows(db,'edit_tasks'),
 inputBytes:db.prepare('SELECT position,hex(CAST(input AS BLOB)) AS raw FROM edit_tasks ORDER BY position').all(),
 editObjects:editObjects(db),sequence:sequence(db),versions:rows(db,'schema_version')});

function insertTask(db,row) {
 db.prepare(`INSERT INTO edit_tasks(${COLUMNS.join(',')}) VALUES(${COLUMNS.map(()=>'?').join(',')})`).run(...COLUMNS.map(key=>row[key]));
}
function retainedTask(operation,input,{position,status='applied',acknowledged=1,result,origin='new',revision}={}) {
 // JSON identity stays semantically canonical, but its persisted byte string is
 // deliberately not JSON.stringify(input): whitespace, escapes and key order
 // are all observable historical data and must survive INSERT SELECT exactly.
 const ordered=Object.fromEntries(Object.entries(input).reverse());
 const raw=' \n'+JSON.stringify(ordered,null,'\t').replaceAll('界','\\u754c')+'\n ';
 assert.deepEqual(JSON.parse(raw),input);
 assert.equal(schemas[operation].safeParse(input).success,true,operation);
 const claimed=status==='dispatching'||status==='not_applied'||(status==='applied'&&origin==='new');
 return {position,id:randomUUID(),projectId:input.projectId,operation,input:raw,requestId:input.requestId,
 digest:hash({operation,input}),lane:operation.startsWith('timeline.')?'timeline:mutation':'reference:mutation',origin,status,
 revision:revision??(status==='prepared'?1:status==='dispatching'?2:acknowledged?4:3),acknowledged,
 claim:claimed?randomUUID():null,claimInstance:claimed?randomUUID():null,
 receiptDigest:status==='applied'?hash(result):null,errorCode:status==='not_applied'?'REVISION_CONFLICT':null,
 createdAt:WHEN,updatedAt:'2026-09-08T08:07:06.005Z',bytes:16384};
}

function temporaryRoot(t) {
 const root=mkdtempSync(path.join(tmpdir(),'mioon-subject-migration-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));return root;
}
function rawDatabase(root) {const db=new DatabaseSync(path.join(root,'workbench.sqlite'));db.exec('PRAGMA foreign_keys=ON');return db;}
function openForTest(t,root) {const store=openStore(root);t.after(()=>store.close());return store;}

// Temporary 15/16/17/18/19/20/21/22/23/24 markers gate later migrations while the unchanged
// frozen through24 constructor populates the v1–14 IF NOT EXISTS tables. They are removed
// before any fixture data or snapshot is made. The edit table comes solely from
// the frozen SQL above; no v15 table is ever downgraded to manufacture a fixture.
export function createSchema14Store(root) {
 let db=rawDatabase(root);
 db.exec('CREATE TABLE schema_version(version INTEGER PRIMARY KEY); CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);');
 db.exec(LEGACY_EDIT_TASK_SCHEMA);db.prepare('INSERT INTO schema_version VALUES(?)').run(15);db.prepare('INSERT INTO schema_version VALUES(?)').run(16);db.prepare('INSERT INTO schema_version VALUES(?)').run(17);db.prepare('INSERT INTO schema_version VALUES(?)').run(18);db.prepare('INSERT INTO schema_version VALUES(?)').run(19);db.prepare('INSERT INTO schema_version VALUES(?)').run(20);db.prepare('INSERT INTO schema_version VALUES(?)').run(21);db.prepare('INSERT INTO schema_version VALUES(?)').run(22);db.prepare('INSERT INTO schema_version VALUES(?)').run(23);db.prepare('INSERT INTO schema_version VALUES(?)').run(24);db.close();
 const store=openLegacyWorkspaceStore(root);
 assert.deepEqual(SUBJECT_TABLES.filter(name=>store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)),[]);
 store.db.exec('DELETE FROM schema_version WHERE version IN (15,16,17,18,19,20,21,22,23,24)');
 assert.equal(store.db.prepare('SELECT max(version) n FROM schema_version').get().n,14);
 return store;
}

function asset(store,projectId,patch={}) {
 const id=randomUUID();return store.put('assets',{id,projectId,name:'Migration source',mimeType:'video/mp4',duration:10,
 width:720,height:1280,hasAudio:true,hasVideo:true,provenance:'user-import',sha256:'a'.repeat(64),
 relativePath:`media/${id}.fixture`,createdAt:WHEN,...patch});
}

// All twelve original operations produce real retained domain receipts. No
// provider, media process, native shell or network operation is invoked.
async function exerciseLegacyOperations(store,{retain=false}={}) {
 const services=createServices(store,new Map()),project=await services.call('project.create',{name:'Schema 14 legacy operations'});
 const recovered=[],generated=asset(store,project.id,{provenance:'generated'});
 const shot=await services.call('shot.create',{projectId:project.id,title:'Selected migration shot'}),jobId=randomUUID(),versionId=randomUUID();
 store.put('jobs',{id:jobId,projectId:project.id,shotId:shot.id,versionId,assetId:generated.id,status:'succeeded',snapshot:{projectId:project.id,shotId:shot.id}});
 store.put('versions',{id:versionId,projectId:project.id,shotId:shot.id,jobId,assetId:generated.id,sha256:generated.sha256,number:1});
 store.put('shots',{...shot,selectedVersionId:versionId});
 const tasks=createEditTasks({store,services});let timeline=await services.call('timeline.get',{projectId:project.id});
 async function edit(operation,fields={}) {
  const requestId=`migration-界-"\\-${recovered.length}-${randomUUID()}`;
  const input={projectId:project.id,...(operation.startsWith('timeline.')?{expectedRevision:timeline.revision}:{}),requestId,...fields};
  let result,row;
  if(retain) {
   result=await services.call(operation,input);
   row=retainedTask(operation,input,{position:3+recovered.length*7,result,origin:recovered.length%2?'new':'legacy_session'});
   insertTask(store.db,row);
  } else {
   const prepared=tasks.prepare({projectId:project.id,operation,input,origin:'new'});
   const applied=await tasks.execute({projectId:project.id,taskId:prepared.task.id,digest:prepared.task.digest,instanceId:prepared.instanceId});
   assert.equal(applied.task.status,'applied',operation);result=applied.result;
   tasks.acknowledge({projectId:project.id,taskId:applied.task.id,digest:applied.task.digest,expectedRevision:applied.task.revision,status:'applied'});
   row=store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(prepared.task.id);
  }
  recovered.push({operation,input,result,row});if(operation.startsWith('timeline.'))timeline=result;return result;
 }
 await edit('timeline.seed');await edit('timeline.track.add',{kind:'audio',name:'Escaped "quote" \\ path\t界'});
 await edit('timeline.track.update',{trackId:timeline.tracks[0].id,patch:{name:'Revised\n界'}});
 const source=asset(store,project.id),replacement=asset(store,project.id);
 await edit('timeline.clip.add',{assetId:source.id,trackId:timeline.tracks[1].id,startFrame:90,durationFrames:60});
 const clipId=timeline.clips.at(-1).id;
 await edit('timeline.clip.update',{clipId,patch:{gain:.5}});await edit('timeline.clip.split',{clipId,atFrame:120});
 await edit('timeline.clip.replaceSource',{clipId,assetId:replacement.id});await edit('timeline.clip.remove',{clipId});
 await edit('timeline.undo');await edit('timeline.redo');
 const image=asset(store,project.id,{mimeType:'image/png'});
 const node=await services.call('node.create',{projectId:project.id,type:'image',assetId:image.id,position:{x:0,y:0}});
 const target=await services.call('shot.create',{projectId:project.id,title:'Migration reference target'});
 const attached=await edit('reference.attach',{sourceNodeId:node.id,targetShotId:target.id,expectedSourceRevision:node.revision,expectedShotRevision:target.revision,role:'first_frame'});
 await edit('reference.detach',{edgeId:attached.edge.id,expectedShotRevision:attached.shot.revision});
 assert.deepEqual(new Set(recovered.map(item=>item.operation)),new Set(LEGACY_OPERATIONS));
 return {project,recovered};
}

export async function seedSchema14Fixture(store) {
 const {project,recovered}=await exerciseLegacyOperations(store,{retain:true});
 const services=createServices(store,new Map());let position=130;
 for(const [status,acknowledged,origin] of [['prepared',0,'new'],['dispatching',0,'new'],['unknown',0,'legacy_session'],['applied',0,'new'],['not_applied',0,'new'],['not_applied',1,'new']]) {
  const owner=await services.call('project.create',{name:`Legacy ${status} ${acknowledged}`});
  const input={projectId:owner.id,requestId:`state-界-${randomUUID()}`,expectedRevision:status==='not_applied'?99:1,kind:'audio'};
  const result=status==='applied'?await services.call('timeline.track.add',input):undefined;
  const row=retainedTask('timeline.track.add',input,{position:position+=13,status,acknowledged,origin,result});insertTask(store.db,row);
  if(status==='applied')recovered.push({operation:row.operation,input,result,row});
 }
 const input={projectId:project.id,requestId:`reference-界-${randomUUID()}`,edgeId:randomUUID(),expectedShotRevision:1};
 insertTask(store.db,retainedTask('reference.detach',input,{position:position+=13,status:'unknown',acknowledged:0,origin:'legacy_session'}));
 // A valid AUTOINCREMENT high-water can exceed every surviving position. It
 // must not be reconstructed using max(position), which would reuse old IDs.
 store.db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='edit_tasks'").run(7000);
 const snapshot=snapshotSchema14(store.db);
 assert.deepEqual(new Set(snapshot.editTasks.map(row=>row.status)),new Set(['prepared','dispatching','unknown','applied','not_applied']));
 assert.ok(snapshot.editTasks.some(row=>row.acknowledged===1));assert.ok(snapshot.editTasks.some(row=>row.acknowledged===0));
 assert.ok(snapshot.editTasks.some(row=>row.input.includes('\\u754c')));
 assert.equal(snapshot.editTasks.length,19);assert.equal(snapshot.sequence[0].seq,7000);
 assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
 return {snapshot,recovered};
}


// This catalog comes from the independent committed52 delta. Initial target
// identities and revision1 come only from the original schema14 seed snapshot.
function assertReviewed52(db,legacyRecords) {
 const names=new Set(currentOrdinary52Delta.objectNames),objects=withoutReviewedCurrentAgentObjects(schema(db)),reviewed=objects.filter(value=>names.has(value.name));
 assert.deepEqual(reviewed.map(value=>({...value})),currentOrdinary52Delta.objects,'independent frozen52 task and target SQL');
 assert.equal(reviewed.length,currentOrdinary52Delta.v2Catalog.count);
 assert.equal(createHash('sha256').update(JSON.stringify(reviewed)).digest('hex'),currentOrdinary52Delta.v2Catalog.sha256,'exact reviewed52 catalog');
 assert.deepEqual(objects.filter(value=>/^(?:agent_task_|agent_target_)/.test(value.name)&&!names.has(value.name)),[],'unknown task/target objects are not reviewed52 additions');
 for(const[name,table]of Object.entries(currentOrdinary52Delta.tables)){
  assert.deepEqual(db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(value=>value.name),table.fields,`${name}: reviewed52 fields`);
  if(name!=='agent_task_target_revisions_v2')assert.deepEqual(rows(db,name),[],`${name}: reviewed empty52 rows`);
 }
 if(!legacyRecords)return;
 const expected=[],add=(kind,projectId,targetId)=>expected.push({rowid:expected.length+1,projectId,kind,targetId,revision:1});
 for(const[kind,table]of [['project','projects'],['shot','shots'],['node','nodes'],['job','jobs'],['asset','assets'],['export','exports'],['version','versions']])
  for(const row of legacyRecords[table])add(kind,kind==='project'?row.id:row.projectId,row.id);
 const timelines=legacyRecords.timelines.map(row=>({projectId:row.projectId,data:JSON.parse(row.data)}));
 for(const[field,kind]of [['clips','timeline_clip'],['tracks','timeline_track'],['subtitles','timeline_subtitle']])
  for(const timeline of timelines)for(const target of timeline.data[field]??[])add(kind,timeline.projectId,target.id);
 for(const timeline of timelines)add('timeline',timeline.projectId,timeline.projectId);
 const actual=db.prepare('SELECT rowid,projectId,kind,targetId,revision FROM agent_task_target_revisions_v2 ORDER BY rowid').all().map(row=>({...row}));
 // SQLite may use an existing covering index within one kind; all new rowids
 // and kind ranges remain exact, and later cold snapshots retain their mapping.
 assert.deepEqual(actual.map(row=>({rowid:row.rowid,kind:row.kind})),expected.map(row=>({rowid:row.rowid,kind:row.kind})),'initial target rowids and kind ranges');
 const targets=values=>values.map(row=>{const value={...row};delete value.rowid;return value;}).sort((a,b)=>a.kind.localeCompare(b.kind)||a.targetId.localeCompare(b.targetId));
 assert.deepEqual(targets(actual),targets(expected),'original schema14 project/target identities and initial revision1');
}

function assertLegacyPreserved(db,before) {
 assertReviewed52(db,before.records);
 const after=snapshotSchema14(db);
 for(const name of Object.keys(currentOrdinary52Delta.tables))delete after.records[name];
 for(const name of Object.keys(currentOrdinary58Delta.tables)){assert.deepEqual(after.records[name],[],`${name}: reviewed empty58 table`);delete after.records[name];}
 assertAgentEditTargetTrigger(after.schema);
 after.records.agent_edit_proposals=legacyAgentEditProposalRows(after.records.agent_edit_proposals);
 assert.deepEqual(after.records,before.records,'all preexisting table records, including sequence rows, remain byte-for-byte equivalent');
 assert.deepEqual(after.editTasks,before.editTasks,'all task columns and positions survive without normalization or recovery');
 assert.deepEqual(after.inputBytes,before.inputBytes,'raw UTF-8 input bytes survive unchanged');
 assert.deepEqual(after.sequence,before.sequence,'AUTOINCREMENT high-water and row absence survive');
 const reviewedObjects=values=>values.map(row=>{const reviewed=currentOrdinary48Delta.objectSql[row.name];return reviewed===undefined?row:Object.assign(Object.create(Object.getPrototypeOf(row)),row,{sql:reviewed});});
 assert.deepEqual(reviewedObjects(after.editObjects),reviewedObjects(before.editObjects),'all legacy indexes and triggers retain exact definitions');
 for(const object of before.schema.filter(row=>!(row.type==='table'&&row.name==='edit_tasks'))){
  const current=after.schema.find(row=>row.type===object.type&&row.name===object.name);
  const normalized=object.type==='table'&&object.name==='agent_edit_proposals'?normalizeAgentEditProposalObject(current):current;
  const reviewed=!db.prepare('SELECT 1 FROM schema_version WHERE version=48').get()||currentOrdinary48Delta.objectSql[object.name]===undefined?object:Object.assign(Object.create(Object.getPrototypeOf(object)),object,{sql:reviewedObjectSql(object.name,object.sql)});
  assert.deepEqual(normalized,reviewed,`preexisting schema object ${object.name} remains unchanged outside the pinned schema24 additions`);
 }
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
}
function assertNewSchema(db) {
 assertReviewed52(db);
 const names=new Set(currentOrdinary50Delta.objects.map(value=>value.name));
 assert.deepEqual(schema(db).filter(value=>names.has(value.name)).map(value=>({...value})),currentOrdinary50Delta.objects,'schema50 matches its independent exact delta');
 for(const table of current50Tables)assert.deepEqual(rows(db,table),[],'later task disposition migration never manufactures task records');
 assert.deepEqual(SUBJECT_TABLES.filter(name=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)),SUBJECT_TABLES);
 assert.equal(db.prepare('SELECT count(*) n FROM schema_version WHERE version=15').get().n,1);
 assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...currentMarkerChain]);
 for(const table of LATER_IMAGE_TABLES)assert.deepEqual(rows(db,table),[],'later image migration never manufactures image records');
 for(const table of LATER_FRAME_TABLES)assert.deepEqual(rows(db,table),[],'later frame migration never manufactures extraction records');
 assert.deepEqual(rows(db,'timeline_format_requests'),[],'later format migration never manufactures request provenance');
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='edit_tasks_subjects'").get().n,0);
 assert.deepEqual(db.prepare('PRAGMA table_info(edit_tasks)').all().map(row=>row.name),COLUMNS);
}
function rollbackProbe(db,fn) {
 db.exec('SAVEPOINT migration_probe');
 try{return fn();}finally{db.exec('ROLLBACK TO migration_probe; RELEASE migration_probe');}
}
function candidate(db,{operation='timeline.track.add',lane='timeline:mutation',status='prepared',acknowledged=0,...patch}={}) {
 const projectId=randomUUID(),requestId=randomUUID(),id=randomUUID();
 db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId,JSON.stringify({id:projectId}));
 const input={projectId,requestId,expectedRevision:1,kind:'audio'};
 const claimed=status==='dispatching'||status==='not_applied';
 return {position:null,id,projectId,operation,input:JSON.stringify(input),requestId,digest:hash({operation,input}),lane,
 origin:'new',status,revision:status==='prepared'?1:3,acknowledged,claim:claimed?randomUUID():null,
 claimInstance:claimed?randomUUID():null,receiptDigest:status==='applied'?'a'.repeat(64):null,
 errorCode:status==='not_applied'?'REVISION_CONFLICT':null,createdAt:WHEN,updatedAt:WHEN,bytes:16384,...patch};
}
function assertConstraintAndTriggerBehavior(db,{expanded}) {
 const before=snapshotSchema14(db);
 for(const operation of LEGACY_OPERATIONS)rollbackProbe(db,()=>{
  const row=candidate(db,{operation,lane:operation.startsWith('timeline.')?'timeline:mutation':'reference:mutation'});
  insertTask(db,row);assert.equal(db.prepare('SELECT operation FROM edit_tasks WHERE id=?').get(row.id).operation,operation);
 });
 const additions=['subject.create','subject.version.add','subject.binding.set'];
 for(const operation of additions)rollbackProbe(db,()=>{
  const row=candidate(db,{operation,lane:'subject:mutation'});
  if(expanded){insertTask(db,row);assert.equal(db.prepare('SELECT lane FROM edit_tasks WHERE id=?').get(row.id).lane,'subject:mutation');}
  else assert.throws(()=>insertTask(db,row),/CHECK constraint failed/);
 });
 for(const operation of ['subject.delete','subject.get','subject.execute','subject.version.update','timeline.render','timeline.anything','reference.anything','generation.create'])rollbackProbe(db,()=>{
  const row=candidate(db,{operation,lane:operation.startsWith('subject.')?'subject:mutation':operation.startsWith('reference.')?'reference:mutation':'timeline:mutation'});
  assert.throws(()=>insertTask(db,row),/CHECK constraint failed/,operation);
 });
 for(const patch of [
  {operation:'reference.attach',lane:'timeline:mutation'}, {operation:'timeline.track.add',lane:'reference:mutation'},
  {operation:'subject.create',lane:'timeline:mutation'}, {operation:'timeline.track.add',lane:'subject:mutation'},
  {lane:'generic:mutation'}, {bytes:16383}, {revision:0}, {revision:Number.MAX_SAFE_INTEGER+1},
  {revision:1.5}, {acknowledged:1}, {status:'dispatching'}, {status:'applied'}, {status:'not_applied'},
  {claim:randomUUID()}, {origin:'legacy_session'}, {input:'[]'}, {input:'not JSON'},
  {input:JSON.stringify({projectId:randomUUID(),requestId:randomUUID()})}, {digest:'short'}, {createdAt:''},
 ])rollbackProbe(db,()=>{const row={...candidate(db),...patch};assert.throws(()=>insertTask(db,row),undefined,JSON.stringify(patch));});
 rollbackProbe(db,()=>{const row=candidate(db);row.projectId=randomUUID();row.input=JSON.stringify({...JSON.parse(row.input),projectId:row.projectId});assert.throws(()=>insertTask(db,row),/FOREIGN KEY constraint failed/);});
 rollbackProbe(db,()=>{
  const row=candidate(db);insertTask(db,row);
  const stored=db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(row.id);
  for(const key of ['position','id','projectId','operation','input','requestId','digest','lane','origin','createdAt','bytes']) {
   const changed=typeof stored[key]==='number'?stored[key]+1:`${stored[key]}!`;
   assert.throws(()=>db.prepare(`UPDATE edit_tasks SET ${quote(key)}=?,status='dispatching',revision=revision+1,claim=?,claimInstance=? WHERE id=?`).run(changed,randomUUID(),randomUUID(),row.id),/edit task identities are immutable/,key);
  }
  assert.throws(()=>db.prepare('DELETE FROM edit_tasks WHERE id=?').run(row.id),/edit task identities must be retained/);
  for(const duplicate of [{...stored},{...stored,id:randomUUID(),position:null},{...stored,id:randomUUID(),requestId:randomUUID()}])
   assert.throws(()=>insertTask(db,duplicate),/edit task identities are immutable/);
  assert.throws(()=>db.prepare('INSERT OR REPLACE INTO edit_tasks SELECT * FROM edit_tasks WHERE id=?').run(row.id),/edit task identities are immutable/);
  const otherKey=randomUUID();
  assert.throws(()=>insertTask(db,{...stored,position:null,id:randomUUID(),requestId:otherKey,input:JSON.stringify({...JSON.parse(stored.input),requestId:otherKey})}),/UNIQUE constraint failed: edit_tasks.projectId, edit_tasks.lane/);
  assert.throws(()=>db.prepare("UPDATE edit_tasks SET status='unknown',revision=revision+1 WHERE id=?").run(row.id),/invalid edit task transition/);
  assert.throws(()=>db.prepare("UPDATE edit_tasks SET status='dispatching',claim=?,claimInstance=? WHERE id=?").run(randomUUID(),randomUUID(),row.id),/invalid edit task transition/);
  const claim=randomUUID(),instance=randomUUID();
  db.prepare("UPDATE edit_tasks SET status='dispatching',revision=revision+1,claim=?,claimInstance=? WHERE id=?").run(claim,instance,row.id);
  assert.throws(()=>db.prepare("UPDATE edit_tasks SET status='dispatching',revision=revision+1 WHERE id=?").run(row.id),/invalid edit task transition/);
  db.prepare("UPDATE edit_tasks SET status='unknown',revision=revision+1 WHERE id=?").run(row.id);
  assert.throws(()=>db.prepare("UPDATE edit_tasks SET status='dispatching',revision=revision+1 WHERE id=?").run(row.id),/invalid edit task transition/);
  db.prepare("UPDATE edit_tasks SET status='dispatching',revision=revision+1,claim=?,claimInstance=? WHERE id=?").run(randomUUID(),randomUUID(),row.id);
  db.prepare("UPDATE edit_tasks SET status='not_applied',revision=revision+1,errorCode='REVISION_CONFLICT' WHERE id=?").run(row.id);
  assert.throws(()=>db.prepare("UPDATE edit_tasks SET acknowledged=1,revision=revision+1,errorCode='DIFFERENT' WHERE id=?").run(row.id),/invalid edit task transition/);
  db.prepare('UPDATE edit_tasks SET acknowledged=1,revision=revision+1 WHERE id=?').run(row.id);
  assert.throws(()=>db.prepare('UPDATE edit_tasks SET acknowledged=1,revision=revision+1 WHERE id=?').run(row.id),/invalid edit task transition/);
  // Acknowledgement releases precisely this project's lane but keeps the old identity.
  insertTask(db,{...row,id:randomUUID(),requestId:otherKey,input:JSON.stringify({...JSON.parse(row.input),requestId:otherKey})});
 });
 rollbackProbe(db,()=>{
  const row=candidate(db);insertTask(db,row);
  db.prepare("UPDATE edit_tasks SET status='applied',receiptDigest=?,revision=revision+1 WHERE id=?").run('b'.repeat(64),row.id);
  assert.throws(()=>db.prepare('UPDATE edit_tasks SET receiptDigest=?,acknowledged=1,revision=revision+1 WHERE id=?').run('c'.repeat(64),row.id),/invalid edit task transition/);
  db.prepare('UPDATE edit_tasks SET acknowledged=1,revision=revision+1 WHERE id=?').run(row.id);
 });
 // sqlite_master text alone cannot prove the unique partial index or triggers
 // are active. Every probe above is rolled back, including sequence increments.
 assert.deepEqual(snapshotSchema14(db),before);
}

test('schema14 bootstrap helper exactly matches the independently frozen historical task schema',t=>{
 const root=temporaryRoot(t),store=createSchema14Store(root);t.after(()=>store.close());
 const before=snapshotSchema14(store.db),fresh=new DatabaseSync(':memory:');
 try {
  fresh.exec('CREATE TABLE schema_version(version INTEGER PRIMARY KEY); CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);');
  bootstrapEditTaskSchema(fresh);
  assert.deepEqual(schema(fresh).filter(row=>row.tbl_name==='edit_tasks'),before.schema.filter(row=>row.tbl_name==='edit_tasks'));
 }finally{fresh.close();}
 bootstrapEditTaskSchema(store.db);
 assert.deepEqual(snapshotSchema14(store.db),before);
 assertConstraintAndTriggerBehavior(store.db,{expanded:false});
});

test('subject migration preserves all old rows, raw inputs, claims, receipts, indexes, triggers and sequence across repeated startup',async t=>{
 const root=temporaryRoot(t);let store=createSchema14Store(root);t.after(()=>store.close());
 const {snapshot,recovered}=await seedSchema14Fixture(store);
 assertConstraintAndTriggerBehavior(store.db,{expanded:false});store.close();store=openStore(root);
 assertNewSchema(store.db);assertLegacyPreserved(store.db,snapshot);
 for(const table of SUBJECT_TABLES)assert.deepEqual(rows(store.db,table),[],'migration never derives subjects or bindings from legacy data');
 const tasks=createEditTasks({store,services:{call(){assert.fail('migration/replay must never dispatch');}}});
 for(const {row,result} of recovered) {
  const replay=tasks.reconcile({projectId:row.projectId,taskId:row.id,digest:row.digest});
  assert.deepEqual(replay.result,result);assert.equal(replay.task.id,row.id);assert.equal(replay.task.revision,row.revision);
 }
 assertLegacyPreserved(store.db,snapshot);assertConstraintAndTriggerBehavior(store.db,{expanded:true});
 const after=snapshotSchema14(store.db);
 for(let n=0;n<3;n++){store.close();store=openStore(root);assert.deepEqual(snapshotSchema14(store.db),after);assertNewSchema(store.db);}
 rollbackProbe(store.db,()=>{const row=candidate(store.db);insertTask(store.db,row);assert.equal(store.db.prepare('SELECT position FROM edit_tasks WHERE id=?').get(row.id).position,7001);});
});

test('fresh and upgraded stores expose identical v15 schema and retain original twelve service/receipt behaviors',async t=>{
 const root=temporaryRoot(t);let upgraded=createSchema14Store(root);t.after(()=>upgraded.close());
 upgraded.close();upgraded=openStore(root);
 const fresh=openForTest(t,temporaryRoot(t));assertNewSchema(upgraded.db);assertNewSchema(fresh.db);
 assert.deepEqual(schema(upgraded.db),schema(fresh.db));
 assert.deepEqual(DURABLE_EDIT_OPERATIONS,['timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.rippleRemove','timeline.clip.split','timeline.seed','timeline.undo','timeline.redo','reference.attach','reference.detach','subject.create','subject.version.add','subject.binding.set','timeline.format.set','timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove','timeline.loudness.apply']);
 for(const operation of LEGACY_OPERATIONS)assert.equal(editTaskLane(operation),operation.startsWith('timeline.')?'timeline:mutation':'reference:mutation');
 for(const store of [upgraded,fresh]) {
  assertConstraintAndTriggerBehavior(store.db,{expanded:true});
  const {recovered}=await exerciseLegacyOperations(store);
  assert.equal(recovered.length,12);
  assert.equal(store.db.prepare('SELECT count(*) n FROM timeline_requests').get().n,10);
  assert.equal(store.db.prepare('SELECT count(*) n FROM reference_requests').get().n,2);
  assert.deepEqual(rows(store.db,'subject_requests'),[]);
 }
});

for(const priorSequence of [null,0,8123])test(`empty legacy task migration preserves sqlite_sequence ${priorSequence===null?'absence':priorSequence}`,t=>{
 const root=temporaryRoot(t);let store=createSchema14Store(root);t.after(()=>store.close());
 assert.deepEqual(sequence(store.db),[]);
 if(priorSequence!==null)store.db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('edit_tasks',?)").run(priorSequence);
 const before=snapshotSchema14(store.db);store.close();store=openStore(root);assertNewSchema(store.db);assertLegacyPreserved(store.db,before);
 rollbackProbe(store.db,()=>{const row=candidate(store.db);insertTask(store.db,row);assert.equal(store.db.prepare('SELECT position FROM edit_tasks WHERE id=?').get(row.id).position,(priorSequence??0)+1);});
});

test('failure after the rebuild rolls back every schema15 change, all rows and sequence, then normal restart succeeds',async t=>{
 const root=temporaryRoot(t);let store=createSchema14Store(root);t.after(()=>store.close());
 await seedSchema14Fixture(store);
 store.db.exec("CREATE TRIGGER abort_subject_upgrade BEFORE INSERT ON schema_version WHEN NEW.version=15 BEGIN SELECT RAISE(ABORT,'injected schema15 failure');END");
 const before=snapshotSchema14(store.db);store.close();
 assert.throws(()=>openStore(root),/injected schema15 failure/);
 assert.equal(existsSync(path.join(root,'server.lock')),false,'failed migration releases its own lock');
 let db=rawDatabase(root),beforeRetry;
 try {
  assert.deepEqual(snapshotSchema14(db),before,'DDL, table replacement, raw rows, indexes, triggers and AUTOINCREMENT all roll back');
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='edit_tasks_subjects' OR name IN ('subjects','subject_versions','subject_bindings','subject_requests')").get().n,0);
  db.exec('DROP TRIGGER abort_subject_upgrade');beforeRetry=snapshotSchema14(db);
 }finally{db.close();}
 store=openStore(root);assertNewSchema(store.db);assertLegacyPreserved(store.db,beforeRetry);
});

test('direct helper rejects unowned transactions and rolls back a collision without modifying legacy task state',async t=>{
 const root=temporaryRoot(t),store=createSchema14Store(root);t.after(()=>store.close());
 await seedSchema14Fixture(store);const before=snapshotSchema14(store.db);
 assert.throws(()=>migrateSubjectEditTasks(store.db),/requires a transaction/);assert.deepEqual(snapshotSchema14(store.db),before);
 assert.throws(()=>store.tx(()=>{store.db.exec('CREATE TABLE edit_tasks_subjects(marker TEXT)');migrateSubjectEditTasks(store.db);}),/staging table already exists/);
 assert.deepEqual(snapshotSchema14(store.db),before);
});
