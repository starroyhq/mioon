import {retainedTimelineCatalog} from './timeline-retained-catalog.ts';
import {retainedRenderBindings} from './timeline-retained-render-bindings.ts';
import {projectRetainedTimelineReceipt} from './timeline-retained-receipts.ts';
import type {DatabaseSync} from 'node:sqlite';
import {isClipAudioRole,isTimelineAudioRoleSnapshot,getTimelineAudioRoleIssue,TIMELINE_AUDIO_ROLE_PROFILE} from '../../contracts/src/timeline-audio-role.ts';

const JSON_BYTES=4*1024*1024;
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function invalid():never {throw Object.assign(new Error('Invalid retained audio-role records'),{code:'WORKSPACE_AUDIO_ROLE_INVALID'});}
const families=[['timelines',['data']],['timeline_history',['beforeSnapshot','afterSnapshot']],['timeline_requests',['response']],['edit_tasks',['input']],['exports',['data']],] as const;

/** Own keys, including explicit clears, are capability evidence. */
export function hasTimelineAudioRoleEvidence(root:unknown):boolean {
 const pending:{value:unknown;depth:number}[]=[{value:root,depth:0}];let nodes=0;
 while(pending.length){const {value,depth}=pending.pop()!;if(++nodes>200000||depth>128)invalid();
  if(value===null||typeof value!=='object')continue;
  if(object(value)&&(Object.hasOwn(value,'audioRole')||Object.hasOwn(value,'audioRoleProfile')))return true;
  for(const child of Object.values(value))pending.push({value:child,depth:depth+1});
 }
 return false;
}

/** Bounded negative admission before domain use. SQLite sees escaped and
 * duplicate keys before JSON.parse could discard evidence. No rows are changed. */
export function validateTimelineAudioRoleRows(db:Pick<DatabaseSync,'prepare'>,projectCell:(text:string)=>string=value=>value):void {
 const names=new Map<string,{type:unknown;sql:unknown}>();
 for(const row of retainedTimelineCatalog(db,['timelines','timeline_history','timeline_requests','edit_tasks','exports'])){
  if(typeof row.name!=='string'||names.has(row.name))invalid();names.set(row.name,{type:row.type,sql:row.sql});
 }
 function inspect(root:unknown,owner:unknown,bindings:boolean,table:string,rowIdentity:unknown):void{
  if(table==='timeline_requests')root=projectRetainedTimelineReceipt(root,rowIdentity);
  const frozen=retainedRenderBindings(db,root,owner,table,rowIdentity,()=>invalid());
  const pending:{value:unknown;owner:unknown;depth:number}[]=[{value:root,owner,depth:0}];let nodes=0;
  while(pending.length){const entry=pending.pop()!,value=entry.value;if(++nodes>200000||entry.depth>128)invalid();
   if(value===null||typeof value!=='object')continue;
   if(Array.isArray(value)){for(const item of value)pending.push({value:item,owner:entry.owner,depth:entry.depth+1});continue;}
   if(!object(value))continue;
   const projectId=entry.owner??value.projectId;
   if(Object.hasOwn(value,'audioRole')){
    if(!isClipAudioRole(value.audioRole))invalid();
    if(bindings){
     if(typeof value.assetId!=='string'||value.assetId.length!==36||typeof projectId!=='string')invalid();
     const frozenAsset=frozen?.get(value);
     if(frozenAsset){if(getTimelineAudioRoleIssue(value,frozenAsset))invalid();}
     else {
     const row=db.prepare("SELECT CASE WHEN typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 131072 THEN data END AS data FROM assets WHERE id=?").get(value.assetId);
     if(!row||row.projectId!==projectId||typeof row.data!=='string')invalid();
     let asset:unknown;try{asset=JSON.parse(row.data);}catch{invalid();}if(getTimelineAudioRoleIssue(value,asset))invalid();
     }
    }
   }
   if(Object.hasOwn(value,'audioRoleProfile')&&(value.audioRoleProfile!==TIMELINE_AUDIO_ROLE_PROFILE||!isTimelineAudioRoleSnapshot(value)))invalid();
   if(object(value.timeline)&&Array.isArray(value.assets)&&!isTimelineAudioRoleSnapshot(value))invalid();
   for(const child of Object.values(value))pending.push({value:child,owner:projectId,depth:entry.depth+1});
  }
 }
 for(const [table,fields] of families){
  const catalog=names.get(table);if(!catalog)continue;
  if(catalog.type!=='table'||typeof catalog.sql!=='string'||/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(catalog.sql))invalid();
  const columns=new Set(db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row=>row.name));

  const owner=columns.has('projectId')?"CASE WHEN typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36 THEN projectId END":'NULL';
  for(const field of fields.filter(field=>columns.has(field))){
   const column=quote(field);
   const identity=(table==='timeline_requests'||table==='exports')?`CASE WHEN typeof(${table==='timeline_requests'?'requestId':'id'})='text' AND length(CAST(${table==='timeline_requests'?'requestId':'id'} AS BLOB))<=800 THEN ${table==='timeline_requests'?'requestId':'id'} END`:'';
   const query=`SELECT ${identity?`${identity} AS rowIdentity,`:''}${owner} AS owner,CASE WHEN length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${JSON_BYTES} THEN json_valid(${column}) ELSE 0 END AS valid,CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${JSON_BYTES} THEN ${column} END AS value,CASE WHEN length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${JSON_BYTES} THEN CASE WHEN json_valid(${column}) THEN EXISTS(SELECT 1 FROM json_tree(${column}) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1) ELSE 1 END ELSE 1 END AS duplicates FROM ${quote(table)} WHERE CASE WHEN length(CAST(${column} AS BLOB))>${JSON_BYTES} THEN 1 WHEN typeof(${column})!='text' OR length(CAST(${column} AS BLOB))=0 THEN 0 WHEN json_valid(${column}) THEN EXISTS(SELECT 1 FROM json_tree(${column}) WHERE key IN ('audioRole','audioRoleProfile')) ELSE 1 END`;
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
    if(typeof row.value!=='string'||row.duplicates!==0)invalid();
    let value:unknown;try{value=JSON.parse(projectCell(row.value));}catch{invalid();}inspect(value,row.owner,table!=='edit_tasks',table,row.rowIdentity);
   }
  }
 }
}
