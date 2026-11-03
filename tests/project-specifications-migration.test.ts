
















import type {SQLInputValue} from 'node:sqlite';
interface SchemaObject {type:string;name:string;tbl_name:string;sql:string|null}

import test from 'node:test';


import assert from 'node:assert/strict';

import {DatabaseSync} from 'node:sqlite';

import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';



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
 ['unknown',0,'new'],['applied',0,'new'],['applied',1,'legacy_session'],['not_applied',0,'new'],['not_applied',1,'new']] as const;
const COLUMNS=['position','id','projectId','operation','input','requestId','digest','lane','origin','status','revision',
 'acknowledged','claim','claimInstance','receiptDigest','errorCode','createdAt','updatedAt','bytes'];
const AT='2026-10-11T00:00:00.000Z';
const quote=(name: string)=>'"'+name.replaceAll('"','""')+'"';
const canonical=(value:unknown)=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const hash=(value: unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const raw=(value: ArrayLike<unknown>|{ [s: string]: unknown; }|{ expectedRevision: number; projectId: string; requestId: string; }|{ sourceNodeId: `${string}-${string}-${string}-${string}-${string}`; targetShotId: `${string}-${string}-${string}-${string}-${string}`; expectedSourceRevision: number; expectedShotRevision: number; role: string; projectId: string; requestId: string; }|{ edgeId: `${string}-${string}-${string}-${string}-${string}`; expectedShotRevision: number; projectId: string; requestId: string; }|{ kind: string; name: string; assetId: `${string}-${string}-${string}-${string}-${string}`; projectId: string; requestId: string; })=>' \n'+JSON.stringify(Object.fromEntries(Object.entries(value).reverse()),null,'\t').replaceAll('界','\\u754c')+'\n ';
const lane=(operation: string)=>operation.startsWith('timeline.')?'timeline:mutation':operation.startsWith('reference.')?'reference:mutation':'subject:mutation';
const insert=(db: DatabaseSync,table: string,row: { [s: string]: unknown; }|ArrayLike<unknown>)=>{const keys=Object.keys(row);return db.prepare(`INSERT INTO ${quote(table)}(${keys.map(quote).join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row) as SQLInputValue[]);};
function transaction(db: DatabaseSync,fn: { (): void; (): void; (): void; (): void; (): void; (): void; (): unknown; }){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
function probe(db: DatabaseSync,fn: { (): void; (): void; (): void; (): void; (): void; (): void; (): unknown; }){db.exec('SAVEPOINT migration_probe');try{return fn();}finally{db.exec('ROLLBACK TO migration_probe;RELEASE migration_probe');}}

function database(filename=':memory:'){
 const db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=ON');
 db.exec(readFileSync(new URL('./fixtures/images-legacy-schema18.sql',import.meta.url),'utf8'));
 transaction(db,()=>{migrateComfyImageReviewSchema(db);migrateComfyImageSchema(db);db.exec('INSERT INTO schema_version VALUES(19)');});
 transaction(db,()=>{migrateFrameSchema(db);db.exec('INSERT INTO schema_version VALUES(20)');});
 // A started v20 store already contains this unchanged journal singleton.
 insert(db,'agent_chat_quota',{id:1,runs:0,bytes:0,reservedBytes:0});
 assert.equal(db.prepare('SELECT max(version) AS n FROM schema_version').get()!.n,20);
 return db;
}
function migrate(db: DatabaseSync){return transaction(db,()=>{migrateTimelineFormatSchema(db);migrateTimelineFormatEditTasks(db);db.exec('INSERT INTO schema_version VALUES(21)');});}
function snapshot(db: DatabaseSync){
 const objects=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all() as unknown as SchemaObject[];
 const records=Object.fromEntries(objects.filter((row)=>row.type==='table').map(({name})=>[name,
  db.prepare(name==='sqlite_sequence'?'SELECT rowid AS retainedRowid,* FROM sqlite_sequence ORDER BY name':`SELECT rowid AS retainedRowid,* FROM ${quote((name as string))} ORDER BY rowid`).all()]));
 return {objects,records,inputBytes:db.prepare('SELECT position,hex(CAST(input AS BLOB)) AS raw FROM edit_tasks ORDER BY position').all(),
  columns:db.prepare('PRAGMA table_info(edit_tasks)').all(),foreignKeys:db.prepare('PRAGMA foreign_key_list(edit_tasks)').all()};
}

function project(db: DatabaseSync,label='界 raw project'){
 const id=randomUUID();insert(db,'projects',{id,data:raw({id,name:label,revision:1,createdAt:AT,updatedAt:AT})});return id;
}
function legacyInput(operation: string,projectId: string,requestId: string){
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
function candidate(db: DatabaseSync,{operation='timeline.track.add',status='prepared',acknowledged=0,origin='new',position=null,...patch}:{operation?:string;status?:string;acknowledged?:number;origin?:string;position?:number|null;[key:string]:unknown}={}){
 const projectId=project(db),requestId=`retained-界-"\\-${randomUUID()}`;
 const input=legacyInput(operation,projectId,requestId);
 const claimed=status==='dispatching'||status==='not_applied'||(status==='applied'&&origin==='new')||(status==='unknown'&&origin==='new');
 return {position,id:randomUUID(),projectId,operation,input:raw(input),requestId,digest:hash({operation,input}),lane:lane(operation),origin,status,
  revision:status==='prepared'?1:status==='dispatching'?2:acknowledged?4:3,acknowledged,
  claim:claimed?randomUUID():null,claimInstance:claimed?randomUUID():null,receiptDigest:status==='applied'?'b'.repeat(64):null,
  errorCode:status==='not_applied'?'REVISION_CONFLICT':null,createdAt:AT,updatedAt:'2026-10-11T01:02:03.004Z',bytes:16384,...patch};
}
















test('expanded edit-task allowlist keeps all original lane, identity, transition and retained-capacity constraints',t=>{
 const db=database();t.after(()=>db.close());migrate(db);const before=snapshot(db);
 for(const operation of [...LEGACY_OPERATIONS,'timeline.format.set'])probe(db,()=>{insert(db,'edit_tasks',candidate(db,{operation}));});
 for(const operation of ['timeline.format.get','timeline.render','timeline.format.delete','subject.delete','reference.anything'])probe(db,()=>{
  assert.throws(()=>insert(db,'edit_tasks',candidate(db,{operation})),/CHECK constraint/);
 });
 for(const patch of [{lane:'format:mutation'},{lane:'reference:mutation'},{lane:'subject:mutation'},{bytes:16383},{revision:0},{revision:1.5},{revision:9007199254740992},
  {acknowledged:1},{status:'dispatching',claim:null,claimInstance:null},{status:'applied',receiptDigest:null},{status:'not_applied',errorCode:null},
  {claim:randomUUID()},{origin:'legacy_session'},{input:'[]'},{input:'not JSON'},{input:JSON.stringify({projectId:randomUUID(),requestId:randomUUID()})},{digest:'short'},{createdAt:''}])probe(db,()=>{
  assert.throws(()=>insert(db,'edit_tasks',{...candidate(db,{operation:'timeline.format.set'}),...patch}),undefined as unknown as Parameters<typeof assert.throws>[1],JSON.stringify(patch));
 });
 probe(db,()=>{
  const row=candidate(db,{operation:'timeline.format.set'});insert(db,'edit_tasks',row);
  assert.throws(()=>db.prepare('DELETE FROM edit_tasks WHERE id=?').run(row.id),/retained/);
  assert.throws(()=>db.prepare('INSERT OR REPLACE INTO edit_tasks SELECT * FROM edit_tasks WHERE id=?').run(row.id),/immutable/);
  for(const key of ['id','projectId','operation','input','requestId','digest','lane','origin','createdAt','bytes'])
   assert.throws(()=>db.prepare(`UPDATE edit_tasks SET ${quote(key)}=?,revision=revision+1,status='dispatching',claim=?,claimInstance=? WHERE id=?`).run(typeof row[(key as keyof typeof row)]==='number'?(row[(key as keyof typeof row)] as number)+1:row[(key as keyof typeof row)]+'!',randomUUID(),randomUUID(),row.id),/immutable/,key);
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
 assert.deepEqual((db.prepare('PRAGMA foreign_key_check').all() as unknown),[]);
});
