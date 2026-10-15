import type {DatabaseSync} from 'node:sqlite';
import {isClipAudioRole,isTimelineAudioRoleSnapshot,getTimelineAudioRoleIssue,TIMELINE_AUDIO_ROLE_PROFILE} from '../../contracts/src/timeline-audio-role.ts';

const JSON_BYTES=4*1024*1024;
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function invalid(allowed:boolean):never {throw Object.assign(new Error(allowed?'Workspace audio-role records are invalid.':'Audio roles require an explicit supported workspace profile.'),{code:allowed?'WORKSPACE_AUDIO_ROLE_INVALID':'RESTORE_SCHEMA_UNSUPPORTED'});}
const families=[['timelines',['data']],['timeline_history',['beforeSnapshot','afterSnapshot']],['timeline_requests',['response']],['edit_tasks',['input']],['exports',['data']],['workspace_restore_timeline_history',['beforeSnapshot','afterSnapshot']],['agent_edit_proposals',['definition']]] as const;

/** Own keys, including explicit clears, are capability evidence. */
export function hasWorkspaceAudioRoleEvidence(root:unknown):boolean {
 const pending:{value:unknown;depth:number}[]=[{value:root,depth:0}];let nodes=0;
 while(pending.length){const {value,depth}=pending.pop()!;if(++nodes>200000||depth>128)invalid(false);
  if(value===null||typeof value!=='object')continue;
  if(object(value)&&(Object.hasOwn(value,'audioRole')||Object.hasOwn(value,'audioRoleProfile')))return true;
  for(const child of Object.values(value))pending.push({value:child,depth:depth+1});
 }
 return false;
}

/** Bounded negative admission before migration writes. SQLite sees escaped and
 * duplicate keys before JSON.parse could discard evidence. No rows are changed. */
export function validateWorkspaceAudioRoleRows(db:Pick<DatabaseSync,'prepare'>,{allowAudioRoles}:{allowAudioRoles:boolean}):void {
 const names=new Map<string,{type:unknown;sql:unknown}>();
 for(const row of db.prepare("SELECT type,lower(name) AS name,CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql FROM main.sqlite_schema WHERE name COLLATE NOCASE IN ('timelines','timeline_history','timeline_requests','edit_tasks','exports','workspace_restore_timeline_history','agent_edit_proposals')").iterate()){
  if(typeof row.name!=='string'||names.has(row.name))invalid(allowAudioRoles);names.set(row.name,{type:row.type,sql:row.sql});
 }
 function inspect(root:unknown,owner:unknown,bindings:boolean):void{
  const pending:{value:unknown;owner:unknown;depth:number}[]=[{value:root,owner,depth:0}];let nodes=0;
  while(pending.length){const entry=pending.pop()!,value=entry.value;if(++nodes>200000||entry.depth>128)invalid(true);
   if(value===null||typeof value!=='object')continue;
   if(Array.isArray(value)){for(const item of value)pending.push({value:item,owner:entry.owner,depth:entry.depth+1});continue;}
   if(!object(value))continue;
   const projectId=entry.owner??value.projectId;
   if(Object.hasOwn(value,'audioRole')){
    if(!isClipAudioRole(value.audioRole))invalid(true);
    if(bindings){
     if(typeof value.assetId!=='string'||value.assetId.length!==36||typeof projectId!=='string')invalid(true);
     const row=db.prepare("SELECT CASE WHEN typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 131072 THEN data END AS data FROM main.assets WHERE id=?").get(value.assetId);
     if(!row||row.projectId!==projectId||typeof row.data!=='string')invalid(true);
     let asset:unknown;try{asset=JSON.parse(row.data);}catch{invalid(true);}if(getTimelineAudioRoleIssue(value,asset))invalid(true);
    }
   }
   if(Object.hasOwn(value,'audioRoleProfile')&&(value.audioRoleProfile!==TIMELINE_AUDIO_ROLE_PROFILE||!isTimelineAudioRoleSnapshot(value)))invalid(true);
   if(object(value.timeline)&&Array.isArray(value.assets)&&!isTimelineAudioRoleSnapshot(value))invalid(true);
   for(const child of Object.values(value))pending.push({value:child,owner:projectId,depth:entry.depth+1});
  }
 }
 for(const [table,fields] of families){
  const catalog=names.get(table);if(!catalog)continue;
  if(catalog.type!=='table'||typeof catalog.sql!=='string'||/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(catalog.sql))invalid(allowAudioRoles);
  const columns=new Set(db.prepare(`PRAGMA main.table_info(${quote(table)})`).all().map(row=>row.name));
  if(!allowAudioRoles&&table==='edit_tasks'&&columns.has('errorCode')&&db.prepare("SELECT 1 FROM main.edit_tasks WHERE errorCode IN ('INVALID_AUDIO_ROLE','AUDIO_ROLE_CLIP_UNSUPPORTED') LIMIT 1").get())invalid(false);
  const owner=columns.has('projectId')?"CASE WHEN typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36 THEN projectId END":'NULL';
  for(const field of fields.filter(field=>columns.has(field))){
   const column=quote(field);
   const query=`SELECT ${owner} AS owner,CASE WHEN length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${JSON_BYTES} THEN json_valid(${column}) ELSE 0 END AS valid,CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${JSON_BYTES} THEN ${column} END AS value,CASE WHEN length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${JSON_BYTES} THEN CASE WHEN json_valid(${column}) THEN EXISTS(SELECT 1 FROM json_tree(${column}) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1) ELSE 1 END ELSE 1 END AS duplicates FROM main.${quote(table)} WHERE CASE WHEN length(CAST(${column} AS BLOB))>${JSON_BYTES} THEN 1 WHEN typeof(${column})!='text' OR length(CAST(${column} AS BLOB))=0 THEN 0 WHEN json_valid(${column}) THEN EXISTS(SELECT 1 FROM json_tree(${column}) WHERE key IN ('audioRole','audioRoleProfile')) ELSE 1 END`;
   for(const row of db.prepare(query).iterate()){
    // Malformed legacy JSON stays with its historic reader unless a decoded
    // member token supplies positive role evidence. Never parse oversized cells.
    if(row.valid===0&&typeof row.value==='string'){
     let evidence=false;
     for(const match of row.value.matchAll(/"(?:[^"\\]|\\.)*"\s*:/g)){
      try{const key=JSON.parse(match[0].replace(/\s*:$/,''));if(key==='audioRole'||key==='audioRoleProfile')evidence=true;}catch{}
     }
     if(!evidence)continue;
    }
    if(!allowAudioRoles||typeof row.value!=='string'||row.duplicates!==0)invalid(allowAudioRoles);
    let value:unknown;try{value=JSON.parse(row.value);}catch{invalid(true);}inspect(value,row.owner,table!=='edit_tasks'&&table!=='agent_edit_proposals');
   }
  }
 }
}
