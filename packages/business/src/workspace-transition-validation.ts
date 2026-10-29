import type {DatabaseSync} from 'node:sqlite';
import {isClipTransition} from '../../contracts/src/timeline-clip-transition.ts';
import {TIMELINE_CLIP_TRANSITION_OPERATION,clipTransitionSchema} from '../../contracts/src/timeline-clip-transition-operation.ts';

// Clip transitions are admitted from schema72 on. This additive role gate never
// rewrites JSON; rows without a transition keep their existing validation.
// It reads the raw rows, not the wrapped-receipt view: a setTransition receipt
// is itself transition evidence even after it cleared the cut's transition.
const JSON_BYTES=4*1024*1024;
const families=[
 ['timelines',['data']],['timeline_history',['beforeSnapshot','afterSnapshot']],
 ['timeline_requests',['response']],['edit_tasks',['input']],['exports',['data']],
 ['workspace_restore_timeline_history',['beforeSnapshot','afterSnapshot']],
 ['agent_edit_proposals',['definition']],
] as const;
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function invalid(allowTransitions:boolean):never {
 throw Object.assign(new Error(allowTransitions?'Workspace clip transitions do not match their supported profile.':'Clip transitions require a schema72 workspace.'),
  {code:allowTransitions?'WORKSPACE_TRANSITION_INVALID':'RESTORE_SCHEMA_UNSUPPORTED'});
}
/** Rejects every persisted transition unless allowed; when allowed, each one
 * must match the transition profile. Whether it fits its cut is the timeline's
 * concern, checked where the timeline is used. */
export function validateWorkspaceTransitionRows(db:Pick<DatabaseSync,'prepare'>,{allowTransitions}:{allowTransitions:boolean}):void {
 const names=new Map<string,{type:unknown;sql:unknown}>();
 for(const row of db.prepare(`SELECT type,lower(name) AS name,CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql FROM main.sqlite_schema WHERE name COLLATE NOCASE IN (${families.map(([table])=>`'${table}'`).join(',')}) LIMIT 64`).iterate()){
  if(typeof row.name!=='string'||names.has(row.name))invalid(allowTransitions);
  names.set(row.name,{type:row.type,sql:row.sql});
 }
 function inspect(root:unknown,receipt:boolean):void {
  const pending:{value:unknown;depth:number}[]=[{value:root,depth:0}];
  while(pending.length){
   const {value,depth}=pending.pop()!;
   if(value===null||typeof value!=='object')continue;
   if(depth>128)invalid(allowTransitions);
   if(Array.isArray(value)){for(const item of value)pending.push({value:item,depth:depth+1});continue;}
   const record=value as Record<string,unknown>;
   if(receipt&&record===root){
    // The receipt root names the cut's previous and new transition; the saved
    // timeline inside it is checked like any other below.
    for(const key of ['transition','previousTransition'])if(record[key]!==null&&!clipTransitionSchema.safeParse(record[key]).success)invalid(allowTransitions);
    pending.push({value:record.timeline,depth:depth+1});continue;
   }
   if(Object.hasOwn(record,'transitionIn')&&(record.transitionIn===null||!isClipTransition(record.transitionIn)))invalid(allowTransitions);
   for(const item of Object.values(record))pending.push({value:item,depth:depth+1});
  }
 }
 for(const [table,fields]of families){
  const catalog=names.get(table);if(!catalog)continue;
  if(catalog.type!=='table'||typeof catalog.sql!=='string'||/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(catalog.sql))invalid(allowTransitions);
  const columns=new Set(db.prepare(`PRAGMA main.table_info(${quote(table)})`).all().map(row=>row.name));
  for(const field of fields.filter(name=>columns.has(name))){
   // Only transition-bearing records cross into JS; over-budget cells fail closed.
   const column=quote(field);
   const query=`SELECT CASE WHEN length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${JSON_BYTES} THEN CASE WHEN json_valid(${column}) THEN EXISTS(SELECT 1 FROM json_tree(${column}) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1) ELSE 1 END ELSE 1 END AS duplicateKeys,CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${JSON_BYTES} THEN ${column} END AS value FROM main.${quote(table)} WHERE CASE WHEN length(CAST(${column} AS BLOB))>${JSON_BYTES} THEN 1 ELSE CASE WHEN json_valid(${column}) THEN EXISTS(SELECT 1 FROM json_tree(${column}) WHERE key IN ('transitionIn','previousTransition') OR key='operation' AND atom='${TIMELINE_CLIP_TRANSITION_OPERATION}') ELSE 0 END END`;
   for(const row of db.prepare(query).iterate()){
    if(!allowTransitions||typeof row.value!=='string'||row.duplicateKeys!==0)invalid(allowTransitions);
    let value:unknown;try{value=JSON.parse(row.value);}catch{invalid(allowTransitions);}
    inspect(value,table==='timeline_requests'&&object(value)&&value.operation===TIMELINE_CLIP_TRANSITION_OPERATION);
   }
  }
 }
}
