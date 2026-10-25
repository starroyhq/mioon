import {installAgentConversationDefinitionsV2} from './agent/task-conversation-schema-v2.ts';
import {installAgentInteractionDefinitionsV2,validateAgentInteractionRowsV2} from './agent/task-interaction-schema-v2.ts';
import {installSceneDefinitions,validateSceneRows} from './scene-schema.ts';
// Fixed project-lifecycle source58 / restored59 profile; no opacity candidate capability. Historical source and restored
// closures are not widened, converted or changed by this implementation.
// Fixed schema58/59 profiles used by startup, backup inspection and restore.
// No imported SQL is executed to discover a profile. All expected definitions
// come from application-owned schema code on a fresh in-memory connection.
import {DatabaseSync} from 'node:sqlite';
import {installAgentTaskDefinitionsV2,AGENT_TASK_TABLES,dropAgentTaskTargetTriggersV2} from './agent/task-schema-v2.ts';
import {assertNoRippleWorkspaceOpacity} from './workspace-ripple-evidence.ts';
import {initializeRippleLegacyThrough24} from './workspace-ripple-legacy.ts';
import {createHash} from 'node:crypto';
import {initializeWorkspaceSchema26} from './workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from './workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from './workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from './workspace-schema-v32.ts';
import {initializeWorkspaceSchema38} from './workspace-schema-v38.ts';
import {initializeWorkspaceSchema44} from './workspace-schema-v44.ts';
import {installTaskDispositionDefinitions,validateTaskDispositionRows} from './task-disposition-schema.ts';
import {installProjectLifecycleDefinitions,validateProjectLifecycleRows} from './project-lifecycle-schema.ts';
import {initializeWorkspaceSchema40} from './workspace-schema-v40.ts';
import {validateWorkspaceVolumeEnvelopeRows} from './workspace-volume-envelope-validation.ts';
import {validateWorkspaceAudioRoleRows} from './workspace-audio-role-validation.ts';
import {initializeWorkspaceSchema36} from './workspace-schema-v36.ts';
import {validateAssetAnnotationRows} from './asset-annotation-validation.ts';
import {initializeWorkspaceSchema34} from './workspace-schema-v34.ts';
import {validateWorkspaceColourRows} from './workspace-colour-validation.ts';
import {validateLutResourceRows} from './lut-resource-validation.ts';
import type {SQLInputValue} from 'node:sqlite';

export const WORKSPACE_RESTORE_PROFILE_V59='restored-local-v18' as const;
const WORKSPACE_RESTORE_PROFILE=WORKSPACE_RESTORE_PROFILE_V59;
const WORKSPACE_RESTORE_LIMITS=Object.freeze({records:20000,archiveBytes:64*1024*1024,databaseBytes:512*1024*1024,schemaObjects:1024,schemaBytes:1024*1024});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/;
function fail(code: string, message=code): never {throw Object.assign(new Error(message),{code});}
const quote=(name: string)=>`"${name.replaceAll('"','""')}"`;
const sqlString=(value: string)=>`'${value.replaceAll("'","''")}'`;
function safety(db: DatabaseSync){
 db.exec('PRAGMA trusted_schema=OFF;');
 if(db.prepare('PRAGMA trusted_schema').get()!.trusted_schema!==0)fail('RESTORE_SCHEMA_UNSAFE');
}
// Token comparison deliberately supports only harmless spelling variants:
// whitespace/comments and unquoted keyword/identifier case. Only the three
// reviewed SQLite table-rename identifier spellings are dequoted in table
// declaration/reference positions; quoted keywords remain distinct tokens.
// String literal bytes and every operator/constraint/expression remain exact.
function normalize(sql: string | null): string | null {
 if(sql===null)return null;
 const tokens: string[]=[],re=/\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|<>|!=|<=|>=|==|\|\||[-+*/%=<>().,;?]/gy;
 let at=0;
 while(at<sql.length){re.lastIndex=at;const match=re.exec(sql);if(!match)fail('RESTORE_SCHEMA_UNSUPPORTED');let token=match[0];at=re.lastIndex;
  if(/^\s|^--|^\/\*/.test(token))continue;
  if(/^['"]/.test(token)&&token[0]==="'"){tokens.push(token);continue;}
  if(/^["`\[]/.test(token)){
   const identifier=token.slice(1,-1).toLowerCase(),previous=tokens.at(-1);
   if(['edit_tasks','image_reviews','agent_edit_proposals'].includes(identifier)&&['table','references'].includes(previous ?? ''))token=identifier;
   else{tokens.push('quoted:'+token);continue;}
  }
  tokens.push(token.toLowerCase());
 }
 return JSON.stringify(tokens.filter((_,i)=>!(tokens[i]==='if'&&tokens[i+1]==='not'&&tokens[i+2]==='exists')&&!(tokens[i-1]==='if'&&tokens[i]==='not'&&tokens[i+1]==='exists')&&!(tokens[i-2]==='if'&&tokens[i-1]==='not'&&tokens[i]==='exists')));
}
function schema(db: DatabaseSync): Catalog {
 const result: Catalog=new Map();let bytes=0;
 for(const row of db.prepare(`SELECT type,CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name,CASE WHEN length(CAST(tbl_name AS BLOB))<=128 THEN tbl_name END AS tbl_name,CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql,length(CAST(sql AS BLOB)) AS bytes FROM main.sqlite_schema ORDER BY type,name LIMIT ${WORKSPACE_RESTORE_LIMITS.schemaObjects+1}`).iterate()){
  if(result.size>=WORKSPACE_RESTORE_LIMITS.schemaObjects||typeof row.name!=='string'||typeof row.tbl_name!=='string'||Buffer.byteLength(row.name)>128||typeof row.type!=='string'||(row.sql!==null&&typeof row.sql!=='string')||Number(row.bytes)>131072||(bytes+=Number(row.bytes)||0)>WORKSPACE_RESTORE_LIMITS.schemaBytes)fail('RESTORE_SCHEMA_LIMIT');
  result.set(row.name,{type:row.type,name:row.name,table:row.tbl_name,sql:normalize(row.sql)});
 }
 return result;
}
// Optional constructor-owned schema from providers/mock.ts, deliberately kept
// as fixed SQL here so restored startup never imports/constructs a provider.
// Dedicated tests compare all five objects to the actual ordinary constructor.
const MOCK_SCHEMA_SQL=`
 CREATE TABLE IF NOT EXISTS mock_provider_tasks (
  provider_job_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
  snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL, scenario TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, ready_at_ms INTEGER NOT NULL,
  poll_count INTEGER NOT NULL DEFAULT 0, download_attempts INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0
 );
 CREATE TABLE IF NOT EXISTS mock_provider_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL,
  job_id TEXT, provider_job_id TEXT, created_at_ms INTEGER NOT NULL, outcome TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS mock_provider_submissions_request ON mock_provider_submissions(request_id);
`;
const mockTables=['mock_provider_tasks','mock_provider_submissions'];
const mockObjects=new Set([...mockTables,'mock_provider_submissions_request','sqlite_autoindex_mock_provider_tasks_1','sqlite_autoindex_mock_provider_tasks_2']);
const mockEvidenceSources=[...mockTables.map(table=>({name:table,table,where:''})),{name:'sqlite_sequence_mock_provider_submissions',table:'sqlite_sequence',where:"WHERE name='mock_provider_submissions'"}];
const mockMetadataSql=`CREATE TABLE workspace_restore_mock_evidence(
 name TEXT PRIMARY KEY NOT NULL CHECK(name IN ('mock_provider_tasks','mock_provider_submissions','sqlite_sequence_mock_provider_submissions')),
 digest TEXT NOT NULL CHECK(typeof(digest)='text' AND length(CAST(digest AS BLOB))=64 AND digest NOT GLOB '*[^a-f0-9]*'),
 records INTEGER NOT NULL CHECK(typeof(records)='integer' AND records BETWEEN 0 AND 20000));`;
type CatalogEntry={type: string;name: string;table: string;sql: string | null};
type Catalog=Map<string,CatalogEntry>;
interface Profiles {ordinary: Catalog;ordinaryMock: Catalog;restored: Catalog;restoredMock: Catalog}
export interface WorkspaceRestoreMetadataV59 {
 readonly restorationId: string; readonly workspaceOrigin: string; readonly sourceBackupId: string;
 readonly manifestHash: string; readonly sourceDbHash: string; readonly createdAt: string;
}
export interface WorkspaceRestoreInfoV59 extends WorkspaceRestoreMetadataV59 {
 readonly schemaVersion: 59; readonly sourceSchema: 58; readonly profile: typeof WORKSPACE_RESTORE_PROFILE_V59;
 readonly heldCounts: Readonly<Record<string,number>>;
}
export type WorkspaceClassificationV58V59 = Readonly<{schemaVersion:58;profile:'ordinary'} | {schemaVersion:59;profile:typeof WORKSPACE_RESTORE_PROFILE_V59}>;
interface Preservation {fields: string[];digest: string}
interface Family {table: string;key: string;project: string | null;request: string | null;operation: string | null;namespace: string | null}
interface CapturedIdentity {id: string; projectId: string | null; namespace: string | null; requestId: string | null; operation: string | null}

// The only injected dependency is the application-owned historical through24
// constructor. Keep one private cache per exact constructor; the dispatcher
// binds the frozen constructor once. Imported database SQL is never executed.
export function createWorkspaceRestoreProfileV59(initializeThrough24: (db: DatabaseSync)=>void) {
function mockGuardsSql(){return immutable('workspace_restore_mock_evidence')+mockTables.map(table=>['INSERT','UPDATE','DELETE'].map(event=>
 `CREATE TRIGGER restore_hold_${table}_${event.toLowerCase()} BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT,'RESTORED_RECORD_HELD');END;`).join('\n')).join('\n');}
function optionalMockTables(db: DatabaseSync){return db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='mock_provider_tasks'").get()?mockTables:[];}
 let profiles: Profiles | undefined;
 let uniqueKeys: Map<string,string[][]>;
 function fixedProfilesV58V59(): Profiles {
  if(profiles)return profiles;
  const db=new DatabaseSync(':memory:');
  try {
   safety(db);db.exec('PRAGMA foreign_keys=ON;');
   initializeThrough24(db);initializeWorkspaceSchema26(db);initializeWorkspaceSchema28(db);initializeWorkspaceSchema30(db);initializeWorkspaceSchema32(db);initializeWorkspaceSchema34(db);initializeWorkspaceSchema36(db);initializeWorkspaceSchema38(db);initializeWorkspaceSchema40(db);initializeWorkspaceSchema44(db,initializeThrough24);installProjectLifecycleDefinitions(db);db.exec('INSERT INTO schema_version VALUES(48);BEGIN IMMEDIATE');installTaskDispositionDefinitions(db);db.exec('INSERT INTO schema_version VALUES(50)');installAgentTaskDefinitionsV2(db);db.exec('INSERT INTO schema_version VALUES(52)');installAgentConversationDefinitionsV2(db);db.exec('INSERT INTO schema_version VALUES(54)');installAgentInteractionDefinitionsV2(db);db.exec('INSERT INTO schema_version VALUES(56)');installSceneDefinitions(db);db.exec('INSERT INTO schema_version VALUES(58);COMMIT');
   const ordinary=schema(db);
   installDefinitionsV59(db);const restored=schema(db);
   db.exec(MOCK_SCHEMA_SQL);
   const extra=new Map([...schema(db)].filter(([name])=>mockObjects.has(name)));
   if(extra.size!==5)fail('RESTORE_SCHEMA_UNSUPPORTED');
   const ordinaryMock=new Map([...ordinary,...extra]);
   db.exec(mockMetadataSql+mockGuardsSql());
   profiles={ordinary,ordinaryMock,restored,restoredMock:schema(db)};
   return profiles;
  } finally {db.close();}
 }
 function matches(actual: Catalog,expected: Catalog): boolean {
  return actual.size===expected.size&&[...expected].every(([name,value])=>JSON.stringify(actual.get(name))===JSON.stringify(value));
 }
 /** Cold-archive/historical reading tolerates unknown application-unmanaged
  * retained objects while every managed object, marker and row validator stays
  * exact. Restore candidate classification keeps the strict default. */
 function matchesToleratingUnknown(actual: Catalog,expected: Catalog): boolean {
  const managed=new Set([...expected.values()].map(value=>value.name));
  for(const [name,value] of expected)if(JSON.stringify(actual.get(name))!==JSON.stringify(value))return false;
  for(const [name,value] of actual){
   if(expected.has(name))continue;
   if(managed.has(name)||managed.has(value.table))return false;
  }
  return true;
 }
 function markers(db: DatabaseSync, restored: boolean): void {
  const expected=[...Array.from({length:24},(_,i)=>i+1),26,28,30,32,34,36,38,40,44,48,50,52,54,56,58,...(restored?[59]:[])];
  const values=db.prepare("SELECT CASE WHEN typeof(version)='integer' AND (version BETWEEN 1 AND 24 OR version IN (26,28,30,32,34,36,38,40,44,48,50,52,54,56,58,59)) THEN version END AS version,typeof(version) AS type FROM main.schema_version ORDER BY main.schema_version.version LIMIT 41").all();
  if(values.length!==expected.length||values.some((row,i)=>row.type!=='integer'||row.version!==expected[i]))fail('RESTORE_SCHEMA_UNSUPPORTED','Schema markers are incomplete or unsupported');
 }
 function classifyWorkspaceSchemaV58V59(db: DatabaseSync): WorkspaceClassificationV58V59 {
  safety(db);
  // Offline candidates have fresh connections. Refuse temporary objects rather
  // than allowing shadow tables/triggers to alter any unqualified fixed query.
  if(db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get())fail('RESTORE_SCHEMA_UNSUPPORTED');
  assertNoRippleWorkspaceOpacity(db);
  const actual=schema(db),fixed=fixedProfilesV58V59();
  if(matches(actual,fixed.ordinary)||matches(actual,fixed.ordinaryMock)){
   markers(db,false);validateTaskDispositionRows(db);validateAgentInteractionRowsV2(db);validateSceneRows(db);validateProjectLifecycleRows(db);validateAssetAnnotationRows(db);validateWorkspaceAudioRoleRows(db,{allowAudioRoles:true,frozenEvidenceProfile:'workspace40-restored41'});validateWorkspaceVolumeEnvelopeRows(db,{allowVolumeEnvelopes:true});validateWorkspaceColourRows(db,{allowColour:true,allowMixedImages:true,allowJpegImages:true,frozenEvidenceProfile:'workspace40-restored41'});return Object.freeze({schemaVersion:58,profile:'ordinary'});
  }
  if(matches(actual,fixed.restored)||matches(actual,fixed.restoredMock)){
   markers(db,true);validateTaskDispositionRows(db);validateAgentInteractionRowsV2(db);validateSceneRows(db);validateProjectLifecycleRows(db);validateAssetAnnotationRows(db);validateWorkspaceAudioRoleRows(db,{allowAudioRoles:true,frozenEvidenceProfile:'workspace40-restored41'});validateWorkspaceVolumeEnvelopeRows(db,{allowVolumeEnvelopes:true});validateWorkspaceColourRows(db,{allowColour:true,allowMixedImages:true,allowJpegImages:true,frozenEvidenceProfile:'workspace40-restored41'});return Object.freeze({schemaVersion:59,profile:WORKSPACE_RESTORE_PROFILE});
  }
  fail('RESTORE_SCHEMA_UNSUPPORTED');
 }
 function classifyWorkspaceSchemaV58V59AllowingUnknown(db: DatabaseSync): WorkspaceClassificationV58V59 {
  safety(db);
  if(db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get())fail('RESTORE_SCHEMA_UNSUPPORTED');
  assertNoRippleWorkspaceOpacity(db);
  const actual=schema(db),fixed=fixedProfilesV58V59();
  if(!matchesToleratingUnknown(actual,fixed.ordinary))fail('RESTORE_SCHEMA_UNSUPPORTED');
  markers(db,false);validateTaskDispositionRows(db);validateAgentInteractionRowsV2(db);validateSceneRows(db);validateProjectLifecycleRows(db);validateAssetAnnotationRows(db);validateWorkspaceAudioRoleRows(db,{allowAudioRoles:true,frozenEvidenceProfile:'workspace40-restored41'});validateWorkspaceVolumeEnvelopeRows(db,{allowVolumeEnvelopes:true});validateWorkspaceColourRows(db,{allowColour:true,allowMixedImages:true,allowJpegImages:true,frozenEvidenceProfile:'workspace40-restored41'});
  return Object.freeze({schemaVersion:58,profile:'ordinary'});
 }

// These descriptors are fixed application code, never request-provided SQL.
// Read-only journals are held as well as executable rows, preserving all raw
// receipts/approvals/events against replacement even with recursive_triggers=OFF.
const families=[
 ['jobs','id','projectId',null,null,'job'],['exports','id','projectId',"CASE WHEN json_valid(data) THEN json_extract(data,'$.requestId') END",null,'export'],
 ['versions','id','projectId'],['job_events','id',null],
 ['project_mutation_requests','requestId','projectId','requestId',null,'project'],['project_deletion_receipts','requestId',null,'requestId',null,'project.delete'],['project_deletion_cleanup','requestId',null,'requestId',null,'project.cleanup'],
 ['task_dispositions','composite','projectId',null,null,'task-disposition'],['task_disposition_requests','requestId','projectId','requestId','operation','task-disposition'],
 ['timeline_requests','requestId',null,'requestId',null,'timeline'],['reference_requests','requestId',null,'requestId',null,'reference'],
 ['idempotency',"json_array(scope,requestId)",null,'requestId',null,'scope'],
 ['mutation_requests','requestId','projectId','requestId','operation','local-mutation'],['asset_range_requests','requestId','projectId','requestId','operation','local-mutation'],['asset_disposition_requests','requestId','projectId','requestId','operation','local-mutation'],
 ['asset_annotations','assetId','projectId'],['asset_annotation_requests','requestId','projectId','requestId','operation','local-mutation'],
 ['subject_requests','requestId','projectId','requestId','operation','local-mutation'],
 ['agent_chat_threads','id','projectId'],['agent_chat_requests','requestId','projectId','requestId',null,'chat'],['agent_chat_runs','id','projectId','requestId'],
 ['agent_chat_events',"json_array(runId,seq)",null],['agent_chat_steps','id','projectId'],['agent_chat_quota','id',null],['agent_edit_proposals','id','projectId'],
 ...AGENT_TASK_TABLES.map(table=>[table,table==='agent_task_events_v2'?'json_array(runId,sequence)':table==='agent_task_target_revisions_v2'?'json_array(projectId,kind,targetId)':table==='agent_task_edit_owners_v2'?'json_array(projectId,ownerId)':table==='agent_task_job_origins_v2'?'json_array(kind,jobId)':table==='agent_task_controls_v2'||table==='agent_task_control_states_v2'||table==='agent_task_edit_receipts_v2'||table==='agent_task_policy_requests_v2'?'requestId':'id',table==='agent_task_policy_v2'||table==='agent_task_policy_requests_v2'?null:'projectId']),
 ['edit_tasks','id','projectId','requestId','operation','lane'],
 ['image_groups','id','projectId'],['image_tasks','id','projectId','requestId'],['image_versions','id','projectId'],['image_requests','requestId','projectId','requestId','operation','image'],
 ['image_reviews','id','projectId','requestId',null,'image.review'],['image_remote_runs','taskId','projectId'],['image_remote_observations','id','projectId','requestId',null,'image.remote'],
 ['project_lut_resources','id','projectId'],['lut_import_requests','requestId','projectId','requestId',null,'lut-import'],
 ['frame_tasks','id','projectId','requestId'],['frame_requests','requestId','projectId','requestId','operation','frame'],['waveform_cache','cacheKey','projectId'],
 ['scene_tasks','id','projectId','requestId'],['scene_requests','requestId','projectId','requestId','operation','scene'],['scene_results','id','projectId']
].map(([table,key,project,request,operation,namespace])=>Object.freeze({table:table!,key:key!,project:project??null,request:request??null,operation:operation??null,namespace:namespace??null})) satisfies Family[];
const familyMap=new Map(families.map(value=>[value.table,value]));
const identity=(family: Family,prefix='')=>{
 if(family.table==='agent_task_events_v2')return `json_array(${prefix}runId,${prefix}sequence)`;
 if(family.table==='agent_task_target_revisions_v2')return `json_array(${prefix}projectId,${prefix}kind,${prefix}targetId)`;
 if(family.table==='agent_task_edit_owners_v2')return `json_array(${prefix}projectId,${prefix}ownerId)`;
 if(family.table==='agent_task_job_origins_v2')return `json_array(${prefix}kind,${prefix}jobId)`;
 if(family.table==='task_dispositions')return `json_array(${prefix}projectId,${prefix}kind,${prefix}taskId)`;
 if(family.table==='idempotency')return `json_array(${prefix}scope,${prefix}requestId)`;
 if(family.table==='agent_chat_events')return `json_array(${prefix}runId,${prefix}seq)`;
 return `CAST(${prefix}${quote(family.key)} AS TEXT)`;
};
function immutable(table: string,{insert=true}={}){return `${insert?`CREATE TRIGGER restore_${table}_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'RESTORE_METADATA_IMMUTABLE');END;`:''}
 CREATE TRIGGER restore_${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'RESTORE_METADATA_IMMUTABLE');END;
 CREATE TRIGGER restore_${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'RESTORE_METADATA_IMMUTABLE');END;`;}
const metadataSql=`
 CREATE TABLE workspace_restoration(id INTEGER PRIMARY KEY CHECK(id=1),restorationId TEXT NOT NULL UNIQUE CHECK(length(CAST(restorationId AS BLOB))=36),workspaceOrigin TEXT NOT NULL UNIQUE CHECK(length(CAST(workspaceOrigin AS BLOB))=36),
 sourceBackupId TEXT NOT NULL CHECK(length(CAST(sourceBackupId AS BLOB))=36),manifestHash TEXT NOT NULL CHECK(length(CAST(manifestHash AS BLOB))=64),sourceDbHash TEXT NOT NULL CHECK(length(CAST(sourceDbHash AS BLOB))=64),sourceSchema INTEGER NOT NULL CHECK(sourceSchema=58),
 profile TEXT NOT NULL CHECK(profile='restored-local-v18'),createdAt TEXT NOT NULL CHECK(length(CAST(createdAt AS BLOB)) BETWEEN 1 AND 40));
 CREATE TABLE workspace_restore_holds(kind TEXT NOT NULL CHECK(kind IN (${families.map(value=>sqlString(value.table)).join(',')})),id TEXT NOT NULL CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 2048),capturedRowid INTEGER NOT NULL CHECK(typeof(capturedRowid)='integer'),projectId TEXT CHECK(projectId IS NULL OR length(CAST(projectId AS BLOB))=36),namespace TEXT CHECK(namespace IS NULL OR length(CAST(namespace AS BLOB))<=2048),requestId TEXT CHECK(requestId IS NULL OR length(CAST(requestId AS BLOB))<=2048),operation TEXT CHECK(operation IS NULL OR length(CAST(operation AS BLOB))<=2048),rowHash TEXT NOT NULL CHECK(length(CAST(rowHash AS BLOB))=64),PRIMARY KEY(kind,id),UNIQUE(kind,capturedRowid));
 CREATE TABLE workspace_restore_timeline_history(capturedRowid INTEGER PRIMARY KEY,id TEXT NOT NULL,projectId TEXT NOT NULL,position INTEGER NOT NULL,operation TEXT NOT NULL,createdAt TEXT NOT NULL,beforeSnapshot TEXT NOT NULL,afterSnapshot TEXT NOT NULL);
 CREATE TABLE workspace_restore_timeline_cursors(capturedRowid INTEGER PRIMARY KEY,projectId TEXT NOT NULL,position INTEGER NOT NULL);
 CREATE TABLE workspace_restore_evidence(name TEXT PRIMARY KEY CHECK(name IN ('workspace_restore_timeline_history','workspace_restore_timeline_cursors')),digest TEXT NOT NULL CHECK(length(CAST(digest AS BLOB))=64),records INTEGER NOT NULL CHECK(typeof(records)='integer' AND records BETWEEN 0 AND 20000));
 CREATE TABLE workspace_restore_export_origins(exportId TEXT PRIMARY KEY REFERENCES exports(id),projectId TEXT NOT NULL REFERENCES projects(id),workspaceOrigin TEXT NOT NULL,
 requestScope TEXT NOT NULL CHECK(requestScope IN ('export','timeline.render')),requestId TEXT NOT NULL,requestHash TEXT NOT NULL,identityHash TEXT NOT NULL);
 ALTER TABLE edit_tasks ADD COLUMN executionEpoch TEXT NOT NULL DEFAULT 'captured';
 DROP INDEX edit_task_one_pending_lane;
 CREATE UNIQUE INDEX edit_task_one_pending_lane ON edit_tasks(projectId,lane,executionEpoch) WHERE acknowledged=0;
`;
function guardSql(){return `
 CREATE TRIGGER restore_legacy_schema_gate BEFORE INSERT ON schema_version
 WHEN NEW.version BETWEEN 1 AND 24 OR NEW.version IN (26,28,30,32,34,36,38,40,44,48,50,52,54,56,58) BEGIN SELECT RAISE(ABORT,'RESTORE_LEGACY_RUNTIME_BLOCKED');END;
 CREATE TRIGGER restore_schema_marker_insert BEFORE INSERT ON schema_version
 WHEN NEW.version NOT BETWEEN 1 AND 24 AND NEW.version NOT IN (26,28,30,32,34,36,38,40,44,48,50,52,54,56,58) BEGIN SELECT RAISE(ABORT,'RESTORE_SCHEMA_MARKERS_IMMUTABLE');END;
 CREATE TRIGGER restore_schema_marker_update BEFORE UPDATE ON schema_version
 BEGIN SELECT RAISE(ABORT,'RESTORE_SCHEMA_MARKERS_IMMUTABLE');END;
 CREATE TRIGGER restore_schema_marker_delete BEFORE DELETE ON schema_version
 BEGIN SELECT RAISE(ABORT,'RESTORE_SCHEMA_MARKERS_IMMUTABLE');END;
 CREATE TRIGGER restore_edit_epoch_insert BEFORE INSERT ON edit_tasks
 WHEN NEW.executionEpoch IS NOT (SELECT workspaceOrigin FROM workspace_restoration WHERE id=1)
 BEGIN SELECT RAISE(ABORT,'RESTORE_ORIGIN_REQUIRED');END;
 ${[...AGENT_TASK_TABLES,'project_mutation_requests','project_deletion_receipts','project_deletion_cleanup','project_deletion_scope','task_dispositions','task_disposition_requests','asset_annotations','asset_annotation_requests','scene_tasks','scene_requests','scene_results'].map(table=>`CREATE TRIGGER restore_${table}_new_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'RESTORE_OPERATION_UNAVAILABLE');END;`).join('\n')}
 CREATE TRIGGER restore_lut_resource_import_insert BEFORE INSERT ON project_lut_resources
 BEGIN SELECT RAISE(ABORT,'RESTORE_OPERATION_UNAVAILABLE');END;
 CREATE TRIGGER restore_lut_import_receipt_insert BEFORE INSERT ON lut_import_requests
 BEGIN SELECT RAISE(ABORT,'RESTORE_OPERATION_UNAVAILABLE');END;
 CREATE TRIGGER restore_loudness_apply_insert BEFORE INSERT ON edit_tasks
 WHEN NEW.operation='timeline.loudness.apply'
 BEGIN SELECT RAISE(ABORT,'RESTORE_OPERATION_UNAVAILABLE');END;
 CREATE TRIGGER restore_edit_epoch_update BEFORE UPDATE OF executionEpoch ON edit_tasks
 WHEN NEW.executionEpoch IS NOT OLD.executionEpoch BEGIN SELECT RAISE(ABORT,'RESTORE_EPOCH_IMMUTABLE');END;
 ${['workspace_restoration','workspace_restore_holds','workspace_restore_timeline_history','workspace_restore_timeline_cursors','workspace_restore_evidence'].map(table=>immutable(table)).join('\n')}
 ${families.map(family=>['UPDATE','DELETE','INSERT'].map(event=>{
 const row=event==='INSERT'?'NEW':'OLD';
 // Reject replacement by every conflicting UNIQUE key, not only the primary
 // key. The generic conflict query below is generated from trusted profiles.
 const predicate=event==='INSERT'?replacementPredicate(family):`h.id=${identity(family,`${row}.`)}`;
 return `CREATE TRIGGER restore_hold_${family.table}_${event.toLowerCase()} BEFORE ${event} ON ${family.table}
 WHEN EXISTS(SELECT 1 FROM workspace_restore_holds h WHERE h.kind=${sqlString(family.table)} AND ${predicate})
 BEGIN SELECT RAISE(ABORT,'RESTORED_RECORD_HELD');END;`;
 }).join('\n')).join('\n')}
 ${immutable('workspace_restore_export_origins',{insert:false})}
 CREATE TRIGGER restore_export_origin_insert BEFORE INSERT ON workspace_restore_export_origins
 WHEN EXISTS(SELECT 1 FROM workspace_restore_export_origins WHERE exportId=NEW.exportId)
 OR EXISTS(SELECT 1 FROM workspace_restore_holds WHERE kind='exports' AND id=NEW.exportId)
 OR NEW.workspaceOrigin IS NOT (SELECT workspaceOrigin FROM workspace_restoration WHERE id=1)
 OR length(NEW.identityHash)!=64 OR NEW.identityHash GLOB '*[^a-f0-9]*'
 OR NOT EXISTS(SELECT 1 FROM exports WHERE id=NEW.exportId AND projectId=NEW.projectId)
 OR (NEW.requestScope='export' AND NOT EXISTS(SELECT 1 FROM idempotency WHERE scope='export' AND requestId=NEW.requestId AND requestHash=NEW.requestHash AND resourceId=NEW.exportId))
 OR (NEW.requestScope='timeline.render' AND NOT EXISTS(SELECT 1 FROM timeline_requests WHERE requestId=NEW.requestId AND requestHash=NEW.requestHash AND json_extract(response,'$.id')=NEW.exportId AND json_extract(response,'$.projectId')=NEW.projectId))
 BEGIN SELECT RAISE(ABORT,'RESTORE_EXPORT_BINDING_INVALID');END;
`;}
function replacementPredicate(family: Family){
 const keys=uniqueKeys.get(family.table);
 if(!keys)fail('RESTORE_SCHEMA_UNSUPPORTED');
 return `EXISTS(SELECT 1 FROM ${quote(family.table)} old WHERE old.rowid=h.capturedRowid AND (${keys.map(columns=>`(${columns.map(column=>`old.${quote(column)}=NEW.${quote(column)}`).join(' AND ')})`).join(' OR ')}))`;
}
function discoverTrustedKeys(db: DatabaseSync){
 const keys=new Map<string,string[][]>();
 for(const family of families){
  const sets=[['rowid']];
  for(const index of db.prepare(`PRAGMA index_list(${quote(family.table)})`).all())if(index.unique){
   if(typeof index.name!=='string')fail('RESTORE_SCHEMA_UNSUPPORTED');
   const columns=db.prepare(`PRAGMA index_info(${quote(index.name)})`).all().map(value=>value.name as string);
   // Expression-only uniqueness (frame receipt asset) cannot REPLACE a row
   // unless this trusted JSON expression is checked explicitly below.
   if(columns.every(Boolean))sets.push(columns);
   else if(family.table!=='frame_tasks')fail('RESTORE_SCHEMA_UNSUPPORTED');
  }
  keys.set(family.table,sets);
 }
 uniqueKeys=keys;
}
function installDefinitionsV59(db: DatabaseSync){
 // Called only for trusted reference construction or a classified source40.
 db.exec(metadataSql);dropAgentTaskTargetTriggersV2(db);discoverTrustedKeys(db);
 db.exec('INSERT INTO schema_version VALUES(59);');
 db.exec(guardSql()+`CREATE TRIGGER restore_hold_frame_receipt_replacement BEFORE INSERT ON frame_tasks
 WHEN NEW.stagedReceipt IS NOT NULL AND EXISTS(SELECT 1 FROM frame_tasks old JOIN workspace_restore_holds h ON h.kind='frame_tasks' AND h.id=old.id WHERE json_extract(old.stagedReceipt,'$.assetId')=json_extract(NEW.stagedReceipt,'$.assetId'))
 BEGIN SELECT RAISE(ABORT,'RESTORED_RECORD_HELD');END;`);
}

function columns(db: DatabaseSync,table: string): string[]{return db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row=>row.name as string);}
function rowDigest(db: DatabaseSync,table: string,rowid: SQLInputValue,fields: string[]){
 const digest=createHash('sha256');digest.update(String(rowid)+'\0');
 for(const column of fields){
  const cell=db.prepare(`SELECT typeof(${quote(column)}) AS type,length(CAST(${quote(column)} AS BLOB)) AS bytes FROM ${quote(table)} WHERE rowid=?`).get(rowid);
  if(!cell)fail('RESTORE_PRESERVATION_FAILED');digest.update(column+'\0'+cell.type+'\0'+String(cell.bytes)+'\0');
  const expression=cell.type==='real'?`CAST(printf('%!.26g',${quote(column)}) AS BLOB)`:`CAST(${quote(column)} AS BLOB)`;
  const read=db.prepare(`SELECT substr(${expression},?,1048576) AS value FROM ${quote(table)} WHERE rowid=?`);
  for(let offset=1;;offset+=1048576){const value=read.get(offset,rowid)!.value;if(value===null)break;if(!(value instanceof Uint8Array))fail('RESTORE_PRESERVATION_FAILED');if(!value.length)break;digest.update(value);}
 }
 return digest.digest('hex');
}
function tableDigest(db: DatabaseSync,table: string,fields: string[],where=''){
 const digest=createHash('sha256'),stmt=db.prepare(`SELECT rowid AS id FROM ${quote(table)} ${where} ORDER BY rowid`);stmt.setReadBigInts(true);
 for(const {id} of stmt.iterate())digest.update(rowDigest(db,table,id,fields));return digest.digest('hex');
}
function preservation(db: DatabaseSync): Map<string,Preservation>{
 const result=new Map();
 for(const object of schema(db).values())if(object.type==='table'){
  const fields=columns(db,object.name);result.set(object.name,{fields,digest:tableDigest(db,object.name,fields)});
 }
 return result;
}
function verifyPreservation(db: DatabaseSync,before: Map<string,Preservation>){
 for(const [table,{fields,digest}] of before)if(tableDigest(db,table,fields,table==='schema_version'?'WHERE version<=24 OR version IN (26,28,30,32,34,36,38,40,44,48,50,52,54,56,58)':'')!==digest)fail('RESTORE_PRESERVATION_FAILED',`Preservation check failed: ${table}`);
}
function bounds(db: DatabaseSync){
 const bytes=Number(db.prepare('PRAGMA page_count').get()!.page_count)*Number(db.prepare('PRAGMA page_size').get()!.page_size);
 if(bytes>WORKSPACE_RESTORE_LIMITS.databaseBytes)fail('RESTORE_DATABASE_LIMIT');
 let count=0;
 for(const table of [...families.map(value=>value.table),'timeline_history','timeline_history_cursors',...optionalMockTables(db)]){
  count+=Number(db.prepare(`SELECT count(*) AS count FROM (SELECT 1 FROM ${quote(table)} LIMIT ${WORKSPACE_RESTORE_LIMITS.records+1})`).get()!.count);
  if(count>WORKSPACE_RESTORE_LIMITS.records)fail('RESTORE_RECORD_LIMIT');
 }
 let archive=0;
 for(const table of ['timeline_history','timeline_history_cursors']){
  const terms=['rowid',...columns(db,table)].map(column=>`COALESCE(length(CAST(${quote(column)} AS BLOB)),0)`);
  archive+=Number(db.prepare(`SELECT COALESCE(SUM(${terms.join('+')}),0) AS bytes FROM ${quote(table)}`).get()!.bytes);
 }
 if(archive>WORKSPACE_RESTORE_LIMITS.archiveBytes)fail('RESTORE_ARCHIVE_LIMIT');
}
function validateIdentity(db: DatabaseSync){
 const sequences=[['job_events','id'],['agent_edit_proposals','position'],['waveform_cache','position'],['edit_tasks','position'],...(optionalMockTables(db).length?[['mock_provider_submissions','id']]:[])];
 if(db.prepare(`SELECT 1 FROM sqlite_sequence WHERE typeof(name)!='text' OR name NOT IN (${sequences.map(([name])=>sqlString(name)).join(',')}) OR typeof(seq)!='integer' OR seq<0 LIMIT 1`).get()||db.prepare('SELECT 1 FROM sqlite_sequence GROUP BY name HAVING count(*)>1 LIMIT 1').get())fail('RESTORE_SEQUENCE_INVALID');
 for(const [table,column] of sequences){
  if(db.prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM ${quote(table)}) AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name=? AND seq>=(SELECT max(${quote(column)}) FROM ${quote(table)}))`).get(table))fail('RESTORE_SEQUENCE_INVALID');
 }
 if(db.prepare("SELECT 1 FROM timeline_history WHERE typeof(position)!='integer' OR position NOT BETWEEN 1 AND 9007199254740991 LIMIT 1").get()||db.prepare("SELECT 1 FROM timeline_history_cursors WHERE typeof(position)!='integer' OR position NOT BETWEEN 0 AND 9007199254740991 LIMIT 1").get())fail('RESTORE_HISTORY_IDENTITY_INVALID');
 if(db.prepare('PRAGMA foreign_key_check').get())fail('RESTORE_RELATIONSHIP_INVALID');
 for(const table of ['projects','assets','shots','nodes','edges','jobs','versions','exports','timelines']){
  const project=table==='projects'?'':` OR NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=t.projectId) OR json_extract(t.data,'$.projectId') IS NOT t.projectId`;
  if(db.prepare(`SELECT 1 FROM ${table} t WHERE typeof(t.id)!='text' OR length(CAST(t.id AS BLOB))!=36 OR NOT json_valid(t.data) OR CASE WHEN json_valid(t.data) THEN json_extract(t.data,'$.id') IS NOT t.id${project} ELSE 1 END LIMIT 1`).get())fail('RESTORE_IDENTITY_INVALID',`Invalid relational identity in ${table}`);
 }
}
function metadata(input: unknown): Omit<WorkspaceRestoreInfoV59,'heldCounts'> {
 if(!input||typeof input!=='object'||Array.isArray(input))fail('RESTORE_METADATA_INVALID');
 const row=input as Record<string,unknown>;
 const keys=['restorationId','workspaceOrigin','sourceBackupId','manifestHash','sourceDbHash','createdAt'] as const;
 if(keys.some(key=>typeof row[key]!=='string'))fail('RESTORE_METADATA_INVALID');
 const value=row as unknown as WorkspaceRestoreMetadataV59;
 if(value.restorationId.length!==36||!UUID.test(value.restorationId)||value.workspaceOrigin.length!==36||!UUID.test(value.workspaceOrigin)||value.sourceBackupId.length!==36||!UUID.test(value.sourceBackupId)||value.manifestHash.length!==64||!HASH.test(value.manifestHash)||value.sourceDbHash.length!==64||!HASH.test(value.sourceDbHash)||value.createdAt.length>40||!Number.isFinite(Date.parse(value.createdAt)))fail('RESTORE_METADATA_INVALID');
 return Object.freeze({restorationId:value.restorationId,workspaceOrigin:value.workspaceOrigin,sourceBackupId:value.sourceBackupId,manifestHash:value.manifestHash,sourceDbHash:value.sourceDbHash,createdAt:value.createdAt,schemaVersion:59,profile:WORKSPACE_RESTORE_PROFILE,sourceSchema:58});
}
function capturedIdentityMetadata(db: DatabaseSync,family: Family,rowid: SQLInputValue,saved: CapturedIdentity | null=null): CapturedIdentity{
 const bounded=(expression: string | null)=>expression?`CASE WHEN length(CAST(${expression} AS BLOB))<=2048 THEN ${expression} END`:'NULL';
 const ns=family.namespace?(['scope','lane'].includes(family.namespace)?family.namespace:sqlString(family.namespace)):null;
 const row=db.prepare(`SELECT ${bounded(identity(family))} AS id,${bounded(family.project)} AS projectId,${bounded(ns)} AS namespace,${bounded(family.request)} AS requestId,${bounded(family.operation)} AS operation FROM ${quote(family.table)} WHERE rowid=?`).get(rowid) as unknown as CapturedIdentity;
 if(family.table==='exports'){
  const raw=db.prepare(`SELECT CASE WHEN length(CAST(json_extract(data,'$.mode') AS BLOB))<=64 THEN json_extract(data,'$.mode') END AS mode,json_type(data,'$.mode') AS modeType,json_type(data,'$.requestId') AS requestType FROM exports WHERE rowid=?`).get(rowid) as {mode: string | null;modeType:string | null;requestType:string | null};
  if(![null,'null','text'].includes(raw.requestType)||raw.mode===null&&raw.modeType!==null&&raw.modeType!=='null'||row.requestId===null&&raw.requestType!==null&&raw.requestType!=='null'||raw.mode!==null&&!['timeline','storyboard'].includes(raw.mode))fail('RESTORE_EXPORT_IDENTITY_UNSUPPORTED');
  row.namespace=raw.mode==='timeline'?'timeline':'export';row.operation=raw.mode==='timeline'?'timeline.render':'export.create';
  if(saved){
   // Reopening uses the original captured key and existing receipt PK. It must
   // not reverse-scan an ever-growing live receipt table for each old export.
   if(!['export','timeline'].includes(saved.namespace??'')||(row.requestId!==null&&row.requestId!==saved.requestId)||(raw.mode!==null&&row.namespace!==saved.namespace))fail('RESTORE_EXPORT_IDENTITY_UNSUPPORTED');
   const receipt=saved.namespace==='export'
    ?db.prepare("SELECT CASE WHEN length(CAST(resourceId AS BLOB))=36 THEN resourceId END AS id FROM idempotency WHERE scope='export' AND requestId=?").get(saved.requestId)
    :db.prepare("SELECT CASE WHEN json_valid(response) THEN CASE WHEN length(CAST(json_extract(response,'$.id') AS BLOB))=36 THEN json_extract(response,'$.id') END END AS id,CASE WHEN json_valid(response) THEN CASE WHEN length(CAST(json_extract(response,'$.projectId') AS BLOB))=36 THEN json_extract(response,'$.projectId') END END AS projectId FROM timeline_requests WHERE requestId=?").get(saved.requestId);
   if(receipt&&(receipt.id!==row.id||(saved.namespace==='timeline'&&receipt.projectId!==row.projectId))||!receipt&&row.requestId===null)fail('RESTORE_EXPORT_IDENTITY_UNSUPPORTED');
   row.namespace=saved.namespace;row.requestId=saved.requestId;row.operation=row.namespace==='timeline'?'timeline.render':'export.create';
  }else{
   const receipts=db.prepare(`SELECT ${bounded('requestId')} AS requestId,'export' AS namespace FROM idempotency WHERE scope='export' AND resourceId=?
    UNION ALL SELECT ${bounded('requestId')} AS requestId,'timeline' AS namespace FROM timeline_requests WHERE CASE WHEN json_valid(response) THEN json_extract(response,'$.id')=? AND json_extract(response,'$.projectId')=? END LIMIT 2`).all(row.id,row.id,row.projectId);
   if(receipts.length>1)fail('RESTORE_EXPORT_IDENTITY_UNSUPPORTED');
   if(receipts.length===1){
    if(typeof receipts[0].requestId!=='string'||!receipts[0].requestId.length||(row.requestId!==null&&row.requestId!==receipts[0].requestId)||(raw.mode!==null&&row.namespace!==receipts[0].namespace))fail('RESTORE_EXPORT_IDENTITY_UNSUPPORTED');
    row.requestId=receipts[0].requestId;row.namespace=receipts[0].namespace as string;row.operation=row.namespace==='timeline'?'timeline.render':'export.create';
   }
  }
  if(typeof row.requestId!=='string'||!row.requestId.length)fail('RESTORE_EXPORT_IDENTITY_UNSUPPORTED');
 }
 if(typeof row.id!=='string'||!row.id.length||Buffer.byteLength(row.id)>2048||(family.project&&(typeof row.projectId!=='string'||row.projectId.length!==36||!UUID.test(row.projectId)))||(family.request&&(typeof row.requestId!=='string'||!row.requestId.length))||(family.operation&&(typeof row.operation!=='string'||!row.operation.length)))fail('RESTORE_IDENTITY_INVALID',`Unbounded or invalid captured identity: ${family.table}`);
 return row;
}
function captureHolds(db: DatabaseSync){
 const insert=db.prepare('INSERT INTO workspace_restore_holds(kind,id,capturedRowid,projectId,namespace,requestId,operation,rowHash) VALUES(?,?,?,?,?,?,?,?)');
 for(const family of families){
  const fields=columns(db,family.table).filter(column=>column!=='executionEpoch'),rows=db.prepare(`SELECT rowid AS capturedRowid FROM ${quote(family.table)} ORDER BY rowid`);rows.setReadBigInts(true);
  for(const {capturedRowid:rowid} of rows.iterate()){
   const row=capturedIdentityMetadata(db,family,rowid);
   insert.run(family.table,row.id,rowid,row.projectId,row.namespace,row.requestId,row.operation,rowDigest(db,family.table,rowid,fields));
  }
 }
}
function validateCapturedBounds(db: DatabaseSync){
 // Restart limits concern only the immutable capture. Legitimate current-origin
 // work may grow the live DB; 512 MiB total is an activation/publication limit,
 // not a new lifetime cap imposed on later ordinary local edits.
 let count=0;
 for(const table of ['workspace_restore_holds','workspace_restore_timeline_history','workspace_restore_timeline_cursors',...optionalMockTables(db)]){
  count+=Number(db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${quote(table)} LIMIT ${WORKSPACE_RESTORE_LIMITS.records+1})`).get()!.n);
  if(count>WORKSPACE_RESTORE_LIMITS.records)fail('RESTORE_RECORD_LIMIT');
 }
 const limits={kind:128,id:2048,projectId:36,namespace:2048,requestId:2048,operation:2048,rowHash:64};
 if(db.prepare(`SELECT 1 FROM workspace_restore_holds WHERE ${Object.entries(limits).map(([name,max])=>`(${quote(name)} IS NOT NULL AND (typeof(${quote(name)})!='text' OR length(CAST(${quote(name)} AS BLOB))>${max}))`).join(' OR ')} OR typeof(capturedRowid)!='integer' OR kind IS NULL OR id IS NULL OR rowHash IS NULL OR length(CAST(rowHash AS BLOB))!=64 OR rowHash GLOB '*[^a-f0-9]*' LIMIT 1`).get())fail('RESTORE_IDENTITY_INVALID');
 let archiveBytes=0,capturedBytes=0;
 for(const table of ['workspace_restore_timeline_history','workspace_restore_timeline_cursors']){
  const terms=columns(db,table).map(column=>`COALESCE(length(CAST(${quote(column)} AS BLOB)),0)`);
  archiveBytes+=Number(db.prepare(`SELECT COALESCE(SUM(${terms.join('+')}),0) AS bytes FROM ${quote(table)}`).get()!.bytes);
  if(archiveBytes>WORKSPACE_RESTORE_LIMITS.archiveBytes)fail('RESTORE_ARCHIVE_LIMIT');
 }
 for(const family of families){
  const terms=columns(db,family.table).filter(column=>column!=='executionEpoch').map(column=>`COALESCE(length(CAST(t.${quote(column)} AS BLOB)),0)`);
  capturedBytes+=Number(db.prepare(`SELECT COALESCE(SUM(${terms.join('+')}),0) AS bytes FROM workspace_restore_holds h JOIN ${quote(family.table)} t ON t.rowid=h.capturedRowid WHERE h.kind=?`).get(family.table)!.bytes);
  if(capturedBytes>WORKSPACE_RESTORE_LIMITS.databaseBytes)fail('RESTORE_CAPTURE_LIMIT');
 }
 for(const table of optionalMockTables(db)){
  const terms=columns(db,table).map(column=>`COALESCE(length(CAST(${quote(column)} AS BLOB)),0)`);
  capturedBytes+=Number(db.prepare(`SELECT COALESCE(SUM(${terms.join('+')}),0) AS bytes FROM ${quote(table)}`).get()!.bytes);
  if(capturedBytes>WORKSPACE_RESTORE_LIMITS.databaseBytes)fail('RESTORE_CAPTURE_LIMIT');
 }
}
function installMockEvidence(db: DatabaseSync){
 db.exec(mockMetadataSql);
 for(const source of mockEvidenceSources){
  const records=db.prepare(`SELECT count(*) AS n FROM ${quote(source.table)} ${source.where}`).get()!.n;
  db.prepare('INSERT INTO workspace_restore_mock_evidence VALUES(?,?,?)').run(source.name,tableDigest(db,source.table,columns(db,source.table),source.where),records);
 }
 db.exec(mockGuardsSql());
}
function validateMockEvidence(db: DatabaseSync){
 if(!optionalMockTables(db).length)return;
 // Caller has already bounded both immutable ledgers by the combined record
 // and captured-byte limits. The optional sequence row is separately bounded.
 if(Number(db.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM sqlite_sequence WHERE name='mock_provider_submissions' LIMIT 2)").get()!.n)>1||
  db.prepare("SELECT 1 FROM sqlite_sequence WHERE name='mock_provider_submissions' AND (typeof(seq)!='integer' OR seq<0) LIMIT 1").get())fail('RESTORE_SEQUENCE_INVALID');
 const evidence=db.prepare("SELECT CASE WHEN typeof(name)='text' AND length(CAST(name AS BLOB))<=64 THEN name END AS name,CASE WHEN typeof(digest)='text' AND length(CAST(digest AS BLOB))=64 THEN digest END AS digest,CASE WHEN typeof(records)='integer' AND records BETWEEN 0 AND 20000 THEN records END AS records FROM workspace_restore_mock_evidence LIMIT 4").all();
 if(evidence.length!==3)fail('RESTORE_CAPTURE_CHANGED');
 for(const source of mockEvidenceSources){
  const saved=evidence.find(item=>item.name===source.name);
  if(!saved||typeof saved.digest!=='string'||!HASH.test(saved.digest)||typeof saved.records!=='number'||!Number.isSafeInteger(saved.records)||saved.records!==db.prepare(`SELECT count(*) AS n FROM ${quote(source.table)} ${source.where}`).get()!.n||saved.digest!==tableDigest(db,source.table,columns(db,source.table),source.where))fail('RESTORE_CAPTURE_CHANGED');
 }
}

function installWorkspaceRestoreSchemaV59(db: DatabaseSync,input: WorkspaceRestoreMetadataV59): WorkspaceRestoreInfoV59{
 if(db.isTransaction)fail('RESTORE_TRANSACTION_REQUIRED','Restore construction requires an isolated connection');
 const info=metadata(input),classification=classifyWorkspaceSchemaV58V59(db);
 if(classification.schemaVersion!==58||classification.profile!=='ordinary')fail('RESTORE_SOURCE_SCHEMA_UNSUPPORTED');
 db.exec('PRAGMA foreign_keys=ON;');bounds(db);validateIdentity(db);validateLutResourceRows(db);
 if(Object.values(db.prepare('PRAGMA quick_check(1)').get()!)[0]!=='ok')fail('RESTORE_DATABASE_INVALID');
 const before=preservation(db);
 db.exec('BEGIN IMMEDIATE');
 try{
  db.exec(metadataSql);dropAgentTaskTargetTriggersV2(db);discoverTrustedKeys(db);
  db.prepare('INSERT INTO workspace_restoration VALUES(1,?,?,?,?,?,58,?,?)').run(info.restorationId,info.workspaceOrigin,info.sourceBackupId,info.manifestHash,info.sourceDbHash,info.profile,info.createdAt);
  captureHolds(db);
  db.exec('INSERT INTO workspace_restore_timeline_history SELECT rowid,id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot FROM timeline_history; INSERT INTO workspace_restore_timeline_cursors SELECT rowid,projectId,position FROM timeline_history_cursors; INSERT INTO schema_version VALUES(59);');
  for(const [source,target] of [['timeline_history','workspace_restore_timeline_history'],['timeline_history_cursors','workspace_restore_timeline_cursors']]){
   const fields=columns(db,source),digest=tableDigest(db,target,fields);
   if(digest!==before.get(source)!.digest)fail('RESTORE_ARCHIVE_CHANGED');
   db.prepare('INSERT INTO workspace_restore_evidence VALUES(?,?,?)').run(target,digest,db.prepare(`SELECT count(*) AS count FROM ${quote(target)}`).get()!.count);
  }
  db.exec(guardSql()+`CREATE TRIGGER restore_hold_frame_receipt_replacement BEFORE INSERT ON frame_tasks
 WHEN NEW.stagedReceipt IS NOT NULL AND EXISTS(SELECT 1 FROM frame_tasks old JOIN workspace_restore_holds h ON h.kind='frame_tasks' AND h.id=old.id WHERE json_extract(old.stagedReceipt,'$.assetId')=json_extract(NEW.stagedReceipt,'$.assetId'))
 BEGIN SELECT RAISE(ABORT,'RESTORED_RECORD_HELD');END;`);
  if(optionalMockTables(db).length)installMockEvidence(db);
  verifyPreservation(db,before);bounds(db);const result=validateWorkspaceRestoreSchemaV59(db);db.exec('COMMIT');return result;
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
function validateWorkspaceRestoreSchemaV59(db: DatabaseSync): WorkspaceRestoreInfoV59{
 const classification=classifyWorkspaceSchemaV58V59(db);if(classification.profile!==WORKSPACE_RESTORE_PROFILE)fail('RESTORE_SCHEMA_INVALID');
 const row=db.prepare("SELECT id,sourceSchema,CASE WHEN length(CAST(restorationId AS BLOB))=36 THEN restorationId END AS restorationId,CASE WHEN length(CAST(workspaceOrigin AS BLOB))=36 THEN workspaceOrigin END AS workspaceOrigin,CASE WHEN length(CAST(sourceBackupId AS BLOB))=36 THEN sourceBackupId END AS sourceBackupId,CASE WHEN length(CAST(manifestHash AS BLOB))=64 THEN manifestHash END AS manifestHash,CASE WHEN length(CAST(sourceDbHash AS BLOB))=64 THEN sourceDbHash END AS sourceDbHash,CASE WHEN length(CAST(profile AS BLOB))<=40 THEN profile END AS profile,CASE WHEN length(CAST(createdAt AS BLOB))<=40 THEN createdAt END AS createdAt FROM workspace_restoration LIMIT 2").all();if(row.length!==1||row[0].id!==1||row[0].sourceSchema!==58||row[0].profile!==WORKSPACE_RESTORE_PROFILE)fail('RESTORE_METADATA_INVALID');
 validateCapturedBounds(db);validateLutResourceRows(db);validateMockEvidence(db);
 const info=metadata(row[0]),heldCounts: Record<string,number>={};let total=0;
 const evidence=db.prepare("SELECT CASE WHEN typeof(name)='text' AND name IN ('workspace_restore_timeline_history','workspace_restore_timeline_cursors') THEN name END AS name,CASE WHEN typeof(digest)='text' AND length(CAST(digest AS BLOB))=64 AND digest NOT GLOB '*[^a-f0-9]*' THEN digest END AS digest,CASE WHEN typeof(records)='integer' AND records BETWEEN 0 AND 20000 THEN records END AS records FROM workspace_restore_evidence ORDER BY name LIMIT 3").all();
 if(evidence.length!==2)fail('RESTORE_ARCHIVE_CHANGED');
 for(const [source,target] of [['timeline_history','workspace_restore_timeline_history'],['timeline_history_cursors','workspace_restore_timeline_cursors']]){
  const saved=evidence.find(value=>value.name===target);
  if(!saved||typeof saved.records!=='number'||typeof saved.digest!=='string'||!Number.isSafeInteger(saved.records)||saved.records<0||saved.records>WORKSPACE_RESTORE_LIMITS.records||db.prepare(`SELECT count(*) AS count FROM ${quote(target)}`).get()!.count!==saved.records||tableDigest(db,target,columns(db,source))!==saved.digest)fail('RESTORE_ARCHIVE_CHANGED');
 }
 for(const entry of db.prepare('SELECT kind,count(*) AS count FROM workspace_restore_holds GROUP BY kind').iterate()){
  if(typeof entry.kind!=='string'||typeof entry.count!=='number'||!familyMap.has(entry.kind)||(total+=entry.count)>WORKSPACE_RESTORE_LIMITS.records)fail('RESTORE_IDENTITY_INVALID');heldCounts[entry.kind]=entry.count;
 }
 for(const family of families){
  const fields=columns(db,family.table).filter(column=>column!=='executionEpoch');
  const held=db.prepare(`SELECT h.*,t.rowid AS liveRowid FROM workspace_restore_holds h LEFT JOIN ${quote(family.table)} t ON t.rowid=h.capturedRowid WHERE h.kind=?`);held.setReadBigInts(true);
  for(const item of held.iterate(family.table)){
   if(item.liveRowid===null||item.liveRowid!==item.capturedRowid||typeof item.rowHash!=='string'||!HASH.test(item.rowHash)||rowDigest(db,family.table,item.liveRowid,fields)!==item.rowHash)fail('RESTORE_CAPTURE_CHANGED');
   const binding=capturedIdentityMetadata(db,family,item.liveRowid,item as unknown as CapturedIdentity);
   if((Object.keys(binding) as (keyof CapturedIdentity)[]).some(key=>binding[key]!==item[key]))fail('RESTORE_CAPTURE_CHANGED');
  }
  // Restored profiles' disabled families cannot gain uncaptured rows. Only edits and exports
  // have a defined positive-origin route in the restored profile.
  if(!['edit_tasks','exports','timeline_requests','reference_requests','mutation_requests','asset_range_requests','asset_disposition_requests','subject_requests','idempotency'].includes(family.table)&&db.prepare(`SELECT 1 FROM ${quote(family.table)} t WHERE NOT EXISTS(SELECT 1 FROM workspace_restore_holds h WHERE h.kind=? AND h.id=${identity(family,'t.')}) LIMIT 1`).get(family.table))fail('RESTORE_UNBOUND_RECORD');
 }
 if(db.prepare("SELECT 1 FROM edit_tasks t WHERE operation='timeline.loudness.apply' AND NOT EXISTS(SELECT 1 FROM workspace_restore_holds WHERE kind='edit_tasks' AND id=t.id) LIMIT 1").get())fail('RESTORE_UNBOUND_RECORD');
 if(db.prepare("SELECT 1 FROM edit_tasks t WHERE (executionEpoch='captured') IS NOT EXISTS(SELECT 1 FROM workspace_restore_holds WHERE kind='edit_tasks' AND id=t.id) OR executionEpoch NOT IN ('captured',?) LIMIT 1").get(info.workspaceOrigin))fail('RESTORE_EPOCH_INVALID');
 if(db.prepare('PRAGMA foreign_key_check').get())fail('RESTORE_RELATIONSHIP_INVALID');
 return Object.freeze({...info,heldCounts:Object.freeze(heldCounts)});
}
return Object.freeze({classifyWorkspaceSchemaV58V59,classifyWorkspaceSchemaV58V59AllowingUnknown,installWorkspaceRestoreSchemaV59,validateWorkspaceRestoreSchemaV59});
}

const rippleProfile = createWorkspaceRestoreProfileV59(initializeRippleLegacyThrough24);
export const classifyWorkspaceSchemaV58V59 = rippleProfile.classifyWorkspaceSchemaV58V59;
export const installWorkspaceRestoreSchemaV59 = rippleProfile.installWorkspaceRestoreSchemaV59;
export const validateWorkspaceRestoreSchemaV59 = rippleProfile.validateWorkspaceRestoreSchemaV59;
