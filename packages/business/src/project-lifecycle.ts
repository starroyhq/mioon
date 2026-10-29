import {validateWorkspaceSchema58} from './workspace-schema-v58.ts';
import {AGENT_TASK_TABLES} from './agent/task-schema-v2.ts';
import {AGENT_TASK_STORAGE_BYTES_V60} from './agent/task-storage-schema-v2.ts';
import {readCurrentWorkspaceRole,isWorkspaceRoleSince} from './workspace-schema-dispatch.ts';
import {validateFixedWorkspaceRole} from './workspace-role-validation.ts';
import {validateWorkspaceSchema56} from './workspace-schema-v56.ts';
import {validateWorkspaceSchema54} from './workspace-schema-v54.ts';
import {createHash} from 'node:crypto';
import {constants,openSync,opendirSync,fstatSync,closeSync,fsyncSync,unlinkSync} from 'node:fs';
import type {Stats} from 'node:fs';
import path from 'node:path';
import {isProxy} from 'node:util/types';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {projectRenameInputSchema,projectNotesSetInputSchema,projectDeleteInputSchema,projectDeleteManifestSchema} from '../../contracts/src/project-lifecycle.ts';
import type {ProjectDeleteManifest} from '../../contracts/src/project-lifecycle.ts';
import {validateWorkspaceSchema48} from './workspace-schema-v48.ts';
import {validateWorkspaceSchema52} from './workspace-schema-v52.ts';
import {validateWorkspaceSchema50} from './workspace-schema-v50.ts';
// Ordinary roles from schema60 on validate by role; older ordinary profiles keep their marker gates.
const validateLifecycleSchema=(db:DatabaseSync):void=>{const role=readCurrentWorkspaceRole(db);if(isWorkspaceRoleSince(role,60,'ordinary')){validateFixedWorkspaceRole(db,role);return;}if(db.prepare('SELECT 1 FROM schema_version WHERE version=58').get()){validateWorkspaceSchema58(db);return;}if(db.prepare('SELECT 1 FROM schema_version WHERE version=56').get()){validateWorkspaceSchema56(db);return;}if(db.prepare('SELECT 1 FROM schema_version WHERE version=54').get()){validateWorkspaceSchema54(db);return;}if(db.prepare('SELECT 1 FROM schema_version WHERE version=52').get()){validateWorkspaceSchema52(db);return;}if(db.prepare('SELECT 1 FROM schema_version WHERE version=50').get())validateWorkspaceSchema50(db);else validateWorkspaceSchema48(db);};

interface Store{db:DatabaseSync;root:string;get(table:string,id:string):unknown;put(table:string,value:Record<string,unknown>):unknown;tx<T>(callback:()=>T):T}
export interface ProjectDeletionCompanions{assertDeletable(projectId:string):void;removeProject(projectId:string):void}
interface Options{ownsLock():boolean;isReadOnly():boolean;assertIdle():void;storage:{validateManagedFile(file:string,options:{root:string;allowMissing?:boolean}):Stats|null;validateManagedDirectory(directory:string,options:{root:string}):Stats|null};signal?:AbortSignal;now?:()=>string;fault?:(point:'beforeCommit'|'afterCommit'|'beforeUnlink'|'afterUnlink')=>void}
type Row=Record<string,SQLInputValue>;
const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code='PROJECT_DELETE_UNAVAILABLE',status=409):never{
  const messages:Record<string,string>={PROJECT_DELETE_BUSY:'项目仍有运行或待对账的任务，请处理完成后再删除。',PROJECT_DELETE_REFERENCED:'其他项目仍引用此项目的资源，无法永久删除。',PROJECT_DELETE_UNAVAILABLE:'无法安全永久删除项目，已有内容保持不变。',PROJECT_DELETE_COMPANION_UNAVAILABLE:'项目草稿清理尚未就绪，暂时不能删除。',PROJECT_DELETE_MEDIA_INVALID:'无法验证待删除的托管文件，暂时不能删除。',REVISION_CONFLICT:'项目已有新版本，请重新读取后再操作。',IDEMPOTENCY_CONFLICT:'同一请求 ID 已用于不同操作。',NOT_FOUND:'找不到项目。',VALIDATION_ERROR:'项目操作参数无效。'};
  throw Object.assign(new Error(messages[code]??messages.PROJECT_DELETE_UNAVAILABLE),{code,status});
}
function parse<T>(schema:{safeParse(value:unknown):{success:true;data:T}|{success:false}},value:unknown):T{
  if(!object(value)||isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('VALIDATION_ERROR',400);
  for(const key of Reflect.ownKeys(value)){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))fail('VALIDATION_ERROR',400);}
  const result=schema.safeParse(value);if(!result.success)fail('VALIDATION_ERROR',400);return result.data;
}
function decoded(value:SQLInputValue|undefined):Record<string,unknown>{
  if(typeof value!=='string'||Buffer.byteLength(value)>4*1024*1024)fail();
  let result:unknown;try{result=JSON.parse(value);}catch{fail();}if(!object(result))fail();return result;
}
function strings(value:unknown,visit:(key:string,value:string)=>void,key='',depth=0,budget={nodes:0}):void{
  if(++budget.nodes>200000||depth>48)fail();
  if(typeof value==='string'){visit(key,value);return;}
  if(Array.isArray(value)){for(const item of value)strings(item,visit,key,depth+1,budget);return;}
  if(object(value))for(const [name,item] of Object.entries(value))strings(item,visit,name,depth+1,budget);
}

/** Local-only lifecycle. The transaction removes scoped DB rows and commits a
 * cleanup manifest together. Files/companions are removed only after that
 * commit; restart retries only this cleanup, never a provider or mutation. */
export function createProjectLifecycleServices(store:Store,{ownsLock,isReadOnly,assertIdle,storage:{validateManagedFile,validateManagedDirectory},signal,now=()=>new Date().toISOString(),fault=()=>{}}:Options){
  const {db,root}=store;let companions:ProjectDeletionCompanions|undefined;
  function owned():void{if(signal?.aborted||isReadOnly()||!ownsLock())fail();}
  function project(projectId:string):Record<string,unknown>{const value=store.get('projects',projectId);if(!object(value)||value.id!==projectId)fail('NOT_FOUND',404);return value;}
  function revision(value:Record<string,unknown>,expected:number):void{if(value.revision!==expected)fail('REVISION_CONFLICT');}
  function tables():string[]{return db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row=>{if(typeof row.name!=='string')fail();return row.name;});}
  function rows(table:string,where='',args:SQLInputValue[]=[]):Row[]{
    const columns=db.prepare(`PRAGMA main.table_info(${quote(table)})`).all().map(row=>{if(typeof row.name!=='string')fail();return quote(row.name);});
    const bytes=columns.map(column=>`CASE WHEN typeof(${column}) IN ('text','blob') THEN length(CAST(${column} AS BLOB)) ELSE 8 END`).join('+');
    // Imported legacy JSON columns are not all constrained. Bound the complete
    // native result before any payload crosses into JavaScript.
    const size=db.prepare(`SELECT count(*) AS records,coalesce(sum(${bytes}),0) AS bytes FROM (SELECT * FROM ${quote(table)} ${where} LIMIT 20001)`).get(...args);
    // Journal quotas charge JSON evidence; this native projection also carries
    // its duplicated SQL owner/identity columns. Keep a finite metadata margin
    // so a journal near its admitted limit can still be explicitly deleted.
    const maximumBytes=AGENT_TASK_TABLES.some(name=>name===table)&&isWorkspaceRoleSince(readCurrentWorkspaceRole(db),60,'ordinary')?AGENT_TASK_STORAGE_BYTES_V60+8*1024*1024:64*1024*1024;
    if(!size||typeof size.records!=='number'||size.records>20000||typeof size.bytes!=='number'||size.bytes>maximumBytes)fail();
    const read=db.prepare(`SELECT rowid AS deletionRowid,* FROM ${quote(table)} ${where} LIMIT 20001`);read.setReadBigInts(true);return read.all(...args) as Row[];
  }
  function blocked(projectId:string):void{
    for(const row of rows('jobs','WHERE projectId=?',[projectId])){
      const job=decoded(row.data);
      if(!['succeeded','failed','cancelled'].includes(String(job.status))||job.phase==='output_review_required'||job.status==='cancelled'&&(job.providerJobId!=null||Number(job.submissionCount)>0))fail('PROJECT_DELETE_BUSY');
    }
    for(const row of rows('exports','WHERE projectId=?',[projectId]))if(!['succeeded','failed','cancelled'].includes(String(decoded(row.data).status)))fail('PROJECT_DELETE_BUSY');
    const gates=[
      ['image_tasks',"state NOT IN ('succeeded','cancelled_before_dispatch','failed')"],
      ['image_remote_runs',"state NOT IN ('completed','failed') OR contentVerified!=1"],
      ['image_remote_observations',"state IN ('queued','running')"],
      ['frame_tasks',"state NOT IN ('succeeded','cancelled_before_start','failed')"],
      ['scene_tasks',"state IN ('queued','running','cancelling','persisting')"],
      ['edit_tasks',"status NOT IN ('applied','not_applied')"],
      ['agent_edit_proposals',"status IN ('pending','approved','dispatching','unknown')"],
      ['agent_chat_runs',"status='running' OR json_extract(data,'$.modelRequestState') IN ('dispatch_started','unknown')"],
      ['agent_chat_steps',"status IN ('intent','dispatch_started','unknown')"],
      ['agent_task_runs_v2',"status IN ('accepted','running','paused','awaiting_approval','awaiting_answer','interrupted')"],
      ['agent_task_steps_v2',"status IN ('dispatch_started','unknown')"],
      ['agent_task_edit_claims_v2','1=1'],
      ['waveform_cache',"status IN ('queued','running')"],
    ] as const;
    for(const [table,predicate] of gates)if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)&&db.prepare(`SELECT 1 FROM ${quote(table)} WHERE projectId=? AND (${predicate}) LIMIT 1`).get(projectId))fail('PROJECT_DELETE_BUSY');
    companions?.assertDeletable(projectId);assertIdle();
  }
  function collect(projectId:string):{selected:Map<string,Row[]>;identities:Set<string>}{
    const selected=new Map<string,Row[]>(),identities=new Set<string>([projectId]);let count=0;
    const add=(table:string,records:Row[])=>{if(!records.length)return;if((count+=records.length)>20000)fail();selected.set(table,records);for(const record of records)for(const name of ['id','taskId','assetId','requestId'])if(typeof record[name]==='string')identities.add(record[name]);};
    const names=tables();
    for(const table of names){
      if(['project_deletion_receipts','project_deletion_cleanup','project_deletion_scope'].includes(table))continue;
      const columns=db.prepare(`PRAGMA main.table_info(${quote(table)})`).all().map(row=>row.name);
      if(table==='projects')add(table,rows(table,'WHERE id=?',[projectId]));
      else if(columns.includes('projectId'))add(table,rows(table,'WHERE projectId=?',[projectId]));
    }
    const ids=(table:string,key='id')=>new Set((selected.get(table)??[]).map(row=>row[key]));
    const jobIds=ids('jobs'),runIds=ids('agent_chat_runs'),requests=ids('jobs','requestId');
    // Legacy JSON job identity lives in data, never in a guessed prefix.
    for(const row of selected.get('jobs')??[]){const value=decoded(row.data);if(typeof value.requestId==='string')requests.add(value.requestId);}
    add('job_events',rows('job_events').filter(row=>jobIds.has(row.jobId)));
    add('agent_chat_events',rows('agent_chat_events').filter(row=>runIds.has(row.runId)));
    add('idempotency',rows('idempotency').filter(row=>typeof row.resourceId==='string'&&identities.has(row.resourceId)));
    for(const table of ['timeline_requests','reference_requests'])add(table,rows(table).filter(row=>{
      const response=decoded(row.response),projects=new Set<string>();strings(response,(key,value)=>{if(key==='projectId')projects.add(value);});
      if(!projects.has(projectId))return false;if(projects.size!==1)fail('PROJECT_DELETE_REFERENCED');return true;
    }));
    if(names.includes('mock_provider_tasks'))add('mock_provider_tasks',rows('mock_provider_tasks').filter(row=>requests.has(row.request_id)));
    if(names.includes('mock_provider_submissions'))add('mock_provider_submissions',rows('mock_provider_submissions').filter(row=>jobIds.has(row.job_id)||requests.has(row.request_id)));
    // Do not leave semantic dangling references hidden in another project's
    // JSON (several historical relationships predate relational foreign keys).
    for(const table of names){
      if(['project_deletion_receipts','project_deletion_cleanup','project_deletion_scope'].includes(table))continue;
      const columns=db.prepare(`PRAGMA main.table_info(${quote(table)})`).all().map(row=>row.name);
      if(!columns.includes('projectId'))continue;
      for(const row of rows(table,'WHERE projectId!=?',[projectId]))for(const name of ['data','input','snapshot','canonicalInput','canonicalIntent','response','definition','approval','outcome','acceptance','stagedReceipt','metadata','rawGraph','outputDescriptor','beforeSnapshot','afterSnapshot','state']){
        if(name==='state'&&table!=='workspace_preferences')continue;
        if(typeof row[name]!=='string')continue;let value:unknown;try{value=JSON.parse(row[name]);}catch{fail();}
        strings(value,(_key,item)=>{if(identities.has(item))fail('PROJECT_DELETE_REFERENCED');});
      }
    }
    return {selected,identities};
  }
  function captureFiles(selected:Map<string,Row[]>,projectId:string):ProjectDeleteManifest['files']{
    const files:ProjectDeleteManifest['files']=[],candidates=new Set<string>();
    const others=new Set(rows('assets','WHERE projectId!=?',[projectId]).map(row=>decoded(row.data).relativePath));
    const sharedIdentities=new Set<string>();
    for(const relative of others){
      if(typeof relative!=='string'||!/^media\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(relative))continue;
      let info;try{info=validateManagedFile(path.join(root,relative),{root,allowMissing:true});}catch{fail('PROJECT_DELETE_MEDIA_INVALID');}
      if(info)sharedIdentities.add(`${info.dev}:${info.ino}`);
    }
    for(const row of selected.get('assets')??[]){const asset=decoded(row.data);if(typeof asset.relativePath!=='string')fail('PROJECT_DELETE_MEDIA_INVALID');if(others.has(asset.relativePath))continue;candidates.add(asset.relativePath);}
    for(const row of selected.get('agent_task_imports_v2')??[]){if(typeof row.id!=='string'||row.relativePath!==`agent-imports/${row.id}.bin`)fail('PROJECT_DELETE_MEDIA_INVALID');candidates.add(String(row.relativePath));}
    for(const [table,directory] of [['image_tasks','image-staging'],['frame_tasks','frame-staging']] as const)for(const row of selected.get(table)??[]){if(typeof row.id!=='string'||!/^[a-f0-9-]{36}$/iu.test(row.id))fail();for(const extension of ['png','json'])candidates.add(`${directory}/${row.id}.${extension}`);}
    // Legacy video/export workers can leave an unpublished result or partial
    // file. Use the same exact accepted-task naming as cold-backup inventory;
    // an unrecognized file never becomes owned through a loose prefix match.
    const jobIds=new Set((selected.get('jobs')??[]).map(row=>String(row.id).toLowerCase())),exportIds=new Set((selected.get('exports')??[]).map(row=>String(row.id).toLowerCase()));
    const media=path.join(root,'media'),before=validateManagedDirectory(media,{root}),directory=opendirSync(media);let entries=0;
    const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
    try{for(let entry=directory.readSync();entry;entry=directory.readSync()){
      if(++entries>32768)fail();const video=new RegExp(`^result-(${uuid})\\.mp4(?:\\.part\\.mp4)?$`,'iu').exec(entry.name),exported=new RegExp(`^export-(${uuid})-(${uuid})\\.mp4(?:\\.part\\.mp4)?$`,'iu').exec(entry.name);
      if(video&&jobIds.has(video[1]!.toLowerCase())||exported&&exportIds.has(exported[1]!.toLowerCase()))candidates.add(`media/${entry.name}`);
    }}finally{directory.closeSync();}
    const after=validateManagedDirectory(media,{root});if(!before||!after||before.dev!==after.dev||before.ino!==after.ino)fail('PROJECT_DELETE_MEDIA_INVALID');
    for(const relativePath of candidates){
      if(!/^(?:media|image-staging|frame-staging|agent-imports)\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(relativePath))fail('PROJECT_DELETE_MEDIA_INVALID');
      let info;try{info=validateManagedFile(path.join(root,relativePath),{root,allowMissing:true});}catch{fail('PROJECT_DELETE_MEDIA_INVALID');}
      if(!info||sharedIdentities.has(`${info.dev}:${info.ino}`))continue;files.push({relativePath,dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs,birthtimeMs:info.birthtimeMs});
    }
    const result=projectDeleteManifestSchema.safeParse({version:1,projectId,files,companions:true});if(!result.success||Buffer.byteLength(JSON.stringify(result.data))>1048576)fail();return result.data.files;
  }
  function syncDirectory(directory:string):void{
    const expected=validateManagedDirectory(directory,{root}),fd=openSync(directory,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const actual=fstatSync(fd);if(!expected||actual.dev!==expected.dev||actual.ino!==expected.ino)fail();fsyncSync(fd);}finally{closeSync(fd);}
  }
  function persistManifest(requestId:string,manifest:ProjectDeleteManifest):void{owned();db.prepare('UPDATE project_deletion_cleanup SET manifest=? WHERE requestId=?').run(JSON.stringify(manifest),requestId);}
  function cleanup(requestId:string):'complete'|'pending'{
    owned();const row=db.prepare('SELECT manifest FROM project_deletion_cleanup WHERE requestId=?').get(requestId);if(!row)return 'complete';
    if(typeof row.manifest!=='string'||Buffer.byteLength(row.manifest)>1048576)fail();let raw:unknown;try{raw=JSON.parse(row.manifest);}catch{fail();}
    const parsed=projectDeleteManifestSchema.safeParse(raw);if(!parsed.success)fail();const manifest=parsed.data;
    // A project ID must never be recycled while its cleanup is pending.
    if(store.get('projects',manifest.projectId))return 'pending';
    for(const file of [...manifest.files]){
      try{
        owned();const [directory]=file.relativePath.split('/');
        if(directory==='media'&&rows('assets').some(row=>{
          const relative=decoded(row.data).relativePath;if(relative===file.relativePath)return true;
          if(typeof relative!=='string'||!/^media\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(relative))return false;
          const info=validateManagedFile(path.join(root,relative),{root,allowMissing:true});return info?.dev===file.dev&&info?.ino===file.ino;
        }))continue;
        const target=path.join(root,file.relativePath),info=validateManagedFile(target,{root,allowMissing:true});
        if(info){if(info.dev!==file.dev||info.ino!==file.ino||info.size!==file.size||info.mtimeMs!==file.mtimeMs||info.birthtimeMs!==file.birthtimeMs)continue;
          fault('beforeUnlink');owned();unlinkSync(target);fault('afterUnlink');}
        syncDirectory(path.dirname(target));manifest.files=manifest.files.filter(item=>item.relativePath!==file.relativePath);persistManifest(requestId,manifest);
      }catch{/* Keep the durable manifest until this exact cleanup is confirmed. */}
    }
    if(manifest.companions&&companions){try{owned();companions.removeProject(manifest.projectId);manifest.companions=false;persistManifest(requestId,manifest);}catch{/* Preserve pending project drafts for a later explicit/local retry. */}}
    if(manifest.files.length||manifest.companions)return 'pending';
    owned();db.prepare('DELETE FROM project_deletion_cleanup WHERE requestId=?').run(requestId);return 'complete';
  }
  function rename(value:unknown):unknown{
    owned();const input=parse(projectRenameInputSchema,value),digest=hash(input);validateLifecycleSchema(db);
    return store.tx(()=>{owned();const previous=db.prepare('SELECT projectId,digest,response FROM project_mutation_requests WHERE requestId=?').get(input.requestId);
      if(previous){if(previous.projectId!==input.projectId||previous.digest!==digest)fail('IDEMPOTENCY_CONFLICT');return decoded(previous.response);}
      const current=project(input.projectId);revision(current,input.expectedRevision);if(input.expectedRevision===Number.MAX_SAFE_INTEGER)fail('REVISION_CONFLICT');
      const updated={...current,name:input.name,revision:input.expectedRevision+1,updatedAt:now()};store.put('projects',updated);
      db.prepare('INSERT INTO project_mutation_requests VALUES(?,?,?,?)').run(input.requestId,input.projectId,digest,JSON.stringify(updated));return updated;
    });
  }
  /** Project notes live on the project record (C6), under the same project
   * revision and immutable request receipts as a rename. Blank text clears them. */
  function setNotes(value:unknown):unknown{
    owned();const input=parse(projectNotesSetInputSchema,value),digest=hash(input);validateLifecycleSchema(db);
    return store.tx(()=>{owned();const previous=db.prepare('SELECT projectId,digest,response FROM project_mutation_requests WHERE requestId=?').get(input.requestId);
      if(previous){if(previous.projectId!==input.projectId||previous.digest!==digest)fail('IDEMPOTENCY_CONFLICT');return decoded(previous.response);}
      const current=project(input.projectId);revision(current,input.expectedRevision);if(input.expectedRevision===Number.MAX_SAFE_INTEGER)fail('REVISION_CONFLICT');
      const {notes:_previous,...rest}=current;
      const updated={...rest,...(input.notes.trim()?{notes:input.notes}:{}),revision:input.expectedRevision+1,updatedAt:now()};store.put('projects',updated);
      db.prepare('INSERT INTO project_mutation_requests VALUES(?,?,?,?)').run(input.requestId,input.projectId,digest,JSON.stringify(updated));return updated;
    });
  }
  function remove(value:unknown):unknown{
    owned();const input=parse(projectDeleteInputSchema,value),digest=hash(input);validateLifecycleSchema(db);
    const previous=db.prepare('SELECT projectId,digest FROM project_deletion_receipts WHERE requestId=?').get(input.requestId);
    if(previous){if(previous.projectId!==input.projectId||previous.digest!==digest)fail('IDEMPOTENCY_CONFLICT');return {requestId:input.requestId,projectId:input.projectId,deleted:true,cleanup:cleanup(input.requestId)};}
    if(!companions)fail('PROJECT_DELETE_COMPANION_UNAVAILABLE',503);
    assertIdle();companions.assertDeletable(input.projectId);
    store.tx(()=>{
      owned();revision(project(input.projectId),input.expectedRevision);blocked(input.projectId);const {selected}=collect(input.projectId),files=captureFiles(selected,input.projectId);
      db.exec('PRAGMA defer_foreign_keys=ON');
      const gate=db.prepare('INSERT INTO project_deletion_scope(tableName,rowId) VALUES(?,?)');
      for(const [table,records] of selected)for(const row of records)gate.run(table,row.deletionRowid!);
      // Quota is shared derived accounting; remove only this terminal project's
      // charged thread/request/run/event/step bytes and run count.
      let charged=0;for(const table of ['agent_chat_requests','agent_chat_runs','agent_chat_events','agent_chat_steps'])for(const row of selected.get(table)??[]){const value=Number(row.bytes);if(!Number.isSafeInteger(value)||value<0)fail();charged+=value;}
      for(const row of selected.get('agent_chat_threads')??[])charged+=Buffer.byteLength(JSON.stringify({id:row.id,projectId:row.projectId,revision:0,nextPosition:1}));
      if(charged){const result=db.prepare('UPDATE agent_chat_quota SET bytes=bytes-?,runs=runs-? WHERE id=1 AND bytes>=? AND runs>=?').run(charged,(selected.get('agent_chat_runs')??[]).length,charged,(selected.get('agent_chat_runs')??[]).length);if(result.changes!==1)fail();}
      for(const [table,records] of selected){const statement=db.prepare(`DELETE FROM ${quote(table)} WHERE rowid=?`);for(const row of records)statement.run(row.deletionRowid!);}
      db.exec('DELETE FROM project_deletion_scope');
      db.prepare('INSERT INTO project_deletion_receipts VALUES(?,?,?,?)').run(input.requestId,input.projectId,digest,now());
      db.prepare('INSERT INTO project_deletion_cleanup VALUES(?,?)').run(input.requestId,JSON.stringify({version:1,projectId:input.projectId,files,companions:true}));
      if(db.prepare('PRAGMA foreign_key_check').get())fail('PROJECT_DELETE_REFERENCED');owned();fault('beforeCommit');
    });
    fault('afterCommit');return {requestId:input.requestId,projectId:input.projectId,deleted:true,cleanup:cleanup(input.requestId)};
  }
  function setProjectDeletionCompanions(value:ProjectDeletionCompanions):{pending:number}{
    companions=value;if(isReadOnly())return {pending:0};owned();let pending=0;
    const requests=db.prepare('SELECT requestId FROM project_deletion_cleanup ORDER BY requestId LIMIT 20001').all();if(requests.length>20000)fail();
    for(const row of requests){if(typeof row.requestId!=='string')fail();if(cleanup(row.requestId)==='pending')pending++;}
    return {pending};
  }
  return {handlers:{'project.rename':rename,'project.notes.set':setNotes,'project.delete':remove},setProjectDeletionCompanions};
}
