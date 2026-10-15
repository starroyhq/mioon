import {frozenReceiptBindingsV40,type FrozenEvidenceProfile} from './workspace-frozen-evidence-v40.ts';
import type {DatabaseSync} from 'node:sqlite';
import {isTimelineClipColour,isTimelineColourSnapshot,nullableTimelineClipColourSchema,timelineColourPlanSchema,timelineImageClipColourSchema,timelineMixedColourPlanSchema,TIMELINE_JPEG_CLIP_COLOUR_PROFILE,TIMELINE_JPEG_SOURCE_PROFILE,TIMELINE_JPEG_MIXED_COLOUR_RENDER_PROFILE,TIMELINE_IMAGE_CLIP_COLOUR_PROFILE,TIMELINE_IMAGE_SOURCE_PROFILE,TIMELINE_MIXED_COLOUR_RENDER_PROFILE} from '../../contracts/src/timeline-colour.ts';

// This is an additive role admission gate, not a change to a frozen24–33
// classifier. It never rewrites legacy JSON or invents a declaration. Rows
// without the new keys retain the historical profile's validation semantics.
const JSON_BYTES=4*1024*1024;
const jpegProfiles=new Set<string>([TIMELINE_JPEG_CLIP_COLOUR_PROFILE,TIMELINE_JPEG_SOURCE_PROFILE,TIMELINE_JPEG_MIXED_COLOUR_RENDER_PROFILE]);
const mixedProfiles=new Set<string>([TIMELINE_IMAGE_CLIP_COLOUR_PROFILE,TIMELINE_IMAGE_SOURCE_PROFILE,TIMELINE_MIXED_COLOUR_RENDER_PROFILE]);
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function invalid(allowColour:boolean):never {
 throw Object.assign(new Error(allowColour?'Workspace colour records do not match their supported profile.':'Colour records require a supported explicit colour workspace profile.'),
  {code:allowColour?'WORKSPACE_COLOUR_INVALID':'RESTORE_SCHEMA_UNSUPPORTED'});
}
const families=[
 ['timelines',['data']],['timeline_history',['beforeSnapshot','afterSnapshot']],
 ['timeline_requests',['response']],['edit_tasks',['input']],['exports',['data']],
 ['workspace_restore_timeline_history',['beforeSnapshot','afterSnapshot']],
 // Proposals can retain a timeline edit intent even before an edit task exists.
 ['agent_edit_proposals',['definition']],
] as const;

export function validateWorkspaceColourRows(db:Pick<DatabaseSync,'prepare'>,{allowColour,allowMixedImages=false,allowJpegImages=false,frozenEvidenceProfile}:{allowColour:boolean;allowMixedImages?:boolean;allowJpegImages?:boolean;frozenEvidenceProfile?:FrozenEvidenceProfile}):void {
 const names=new Map<string,{type:unknown;sql:unknown}>();
 for(const row of db.prepare("SELECT type,lower(name) AS name,CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql FROM main.sqlite_schema WHERE name COLLATE NOCASE IN ('timelines','timeline_history','timeline_requests','edit_tasks','exports','workspace_restore_timeline_history','agent_edit_proposals')").iterate()) {
  if(typeof row.name!=='string'||names.has(row.name))invalid(allowColour);
  names.set(row.name,{type:row.type,sql:row.sql});
 }
 const assets=new Map<string,{projectId:unknown;sha256:unknown;mimeType:unknown}>(),luts=new Map<string,{projectId:unknown;sha256:unknown;profile:unknown}>();
 function asset(assetId:string){
  if(assets.has(assetId))return assets.get(assetId)!;
  const row=db.prepare("SELECT CASE WHEN typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 131072 THEN CASE WHEN json_valid(data) THEN CASE WHEN length(CAST(json_extract(data,'$.sha256') AS BLOB))=64 THEN json_extract(data,'$.sha256') END END END AS sha256,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 131072 THEN CASE WHEN json_valid(data) THEN CASE WHEN length(CAST(json_extract(data,'$.mimeType') AS BLOB))<=80 THEN json_extract(data,'$.mimeType') END END END AS mimeType FROM main.assets WHERE id=?").get(assetId);
  if(!row)invalid(allowColour);const value={projectId:row.projectId,sha256:row.sha256,mimeType:row.mimeType};if(assets.size>=1024)assets.clear();assets.set(assetId,value);return value;
 }
 function lut(resourceId:string){
  if(luts.has(resourceId))return luts.get(resourceId)!;
  const row=db.prepare("SELECT CASE WHEN typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId,CASE WHEN typeof(sha256)='text' AND length(CAST(sha256 AS BLOB))=64 THEN sha256 END AS sha256,CASE WHEN typeof(profile)='text' AND length(CAST(profile AS BLOB))<=80 THEN profile END AS profile FROM main.project_lut_resources WHERE id=?").get(resourceId);
  if(!row)invalid(allowColour);const value={projectId:row.projectId,sha256:row.sha256,profile:row.profile};luts.set(resourceId,value);return value;
 }
 function inspect(root:unknown,projectId:unknown,enforceBindings:boolean,table:string,rowIdentity:unknown):void {
  const frozen=frozenEvidenceProfile==='workspace40-restored41'?frozenReceiptBindingsV40(db,root,projectId,table,rowIdentity,()=>invalid(allowColour)):undefined;
  const pending:{value:unknown;projectId:unknown;tracks:unknown;depth:number}[]=[{value:root,projectId,tracks:undefined,depth:0}];
  while(pending.length){
   const entry=pending.pop()!,value=entry.value;
   if(value===null||typeof value!=='object')continue;
   if(entry.depth>128)invalid(allowColour);
   if(Array.isArray(value)){
    for(const item of value)pending.push({value:item,projectId:entry.projectId,tracks:entry.tracks,depth:entry.depth+1});
    continue;
   }
   if(!object(value))continue;
   // Standalone declarations/evidence can also occur in retained receipts or
   // intents. Historical roles may never acquire mixed-image capability by
   // omitting the outer colour/colourPlan key.
   if(typeof value.profileId==='string'&&(!allowMixedImages&&mixedProfiles.has(value.profileId)||!allowJpegImages&&jpegProfiles.has(value.profileId)))invalid(allowColour);
   const owner=entry.projectId??value.projectId,tracks=Array.isArray(value.tracks)?value.tracks:entry.tracks;
   if(Object.hasOwn(value,'colour')){
    if(!allowColour||!isTimelineClipColour(value.colour)||
     !allowJpegImages&&!nullableTimelineClipColourSchema.safeParse(value.colour).success&&!(allowMixedImages&&timelineImageClipColourSchema.safeParse(value.colour).success))invalid(allowColour);
    const colour=value.colour;
    if(colour!==null&&enforceBindings){
     if(!uuid(owner)||!uuid(value.assetId))invalid(allowColour);
     const media=frozen?.get(value)??asset(value.assetId);
     // Source replacement keeps the chosen look but invalidates interpretation.
     // Only the mixed role can retain either profile with source:null across
     // a supported visual MIME change; a non-null declaration is exact.
     const allowedMime=allowMixedImages&&colour.source===null?['video/mp4','video/webm','image/png',...(allowJpegImages?['image/jpeg']:[])]:
      allowJpegImages&&colour.profileId===TIMELINE_JPEG_CLIP_COLOUR_PROFILE?['image/jpeg']:
      allowMixedImages&&colour.profileId===TIMELINE_IMAGE_CLIP_COLOUR_PROFILE?['image/png']:['video/mp4','video/webm'];
     if(media.projectId!==owner||!allowedMime.includes(String(media.mimeType))||colour.source!==null&&media.sha256!==colour.source.assetSha256)invalid(allowColour);
     if(Array.isArray(tracks)&&!tracks.some(track=>object(track)&&track.id===value.trackId&&track.kind==='video'))invalid(allowColour);
     if(colour.look!==null){
      const saved=lut(colour.look.resourceId);
      if(saved.projectId!==owner||saved.sha256!==colour.look.resourceSha256||saved.profile!==colour.look.resourceProfile)invalid(allowColour);
     }
    }
   }
   if(Object.hasOwn(value,'colourPlan')&&(!allowColour||
    !allowJpegImages&&!timelineColourPlanSchema.safeParse(value.colourPlan).success&&!(allowMixedImages&&timelineMixedColourPlanSchema.safeParse(value.colourPlan).success)||
    !isTimelineColourSnapshot(value)))invalid(allowColour);
   // A missing plan on a managed frozen snapshot is just as corrupt as a
   // changed plan. Editable timelines/history need no render plan.
   if(allowColour&&object(value.timeline)&&Array.isArray(value.assets)&&!isTimelineColourSnapshot(value))invalid(allowColour);
   for(const [key,item]of Object.entries(value)){
    // Declarations are strict leaves. A resource/plan's fields are not clips.
    if(key==='colour'||key==='colourPlan')continue;
    pending.push({value:item,projectId:owner,tracks,depth:entry.depth+1});
   }
  }
 }
 for(const [table,fields]of families){
  const catalog=names.get(table);if(!catalog)continue;
  if(catalog.type!=='table'||typeof catalog.sql!=='string'||/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(catalog.sql))invalid(allowColour);
  const columns=new Set(db.prepare(`PRAGMA main.table_info(${quote(table)})`).all().map(row=>row.name));
  // A newly definite image-budget rejection is stored outside task input JSON.
  // Do not let the shared proof decoder retroactively widen an old role.
  if(!allowMixedImages&&table==='edit_tasks'&&columns.has('errorCode')&&db.prepare("SELECT 1 FROM main.edit_tasks WHERE errorCode='TIMELINE_IMAGE_AGGREGATE_BUDGET' LIMIT 1").get())invalid(allowColour);
  // A malformed schema remains the responsibility of its existing classifier.
  // Scan only known JSON columns which actually exist on an old partial schema.
  const present=fields.filter(field=>columns.has(field));if(!present.length)continue;
  const owner=columns.has('projectId')?"CASE WHEN typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36 THEN projectId END":'NULL';
  for(const field of present){
   // SQLite decodes escaped JSON member names. Only colour-bearing or mixed-profile records
   // cross into JS, leaving unrelated old/corrupt JSON to its historic reader.
   // Over-budget values fail closed before either JSON virtual table runs.
   const column=quote(field);
   const identity=frozenEvidenceProfile==='workspace40-restored41'&&(table==='timeline_requests'||table==='exports')?`CASE WHEN typeof(${table==='timeline_requests'?'requestId':'id'})='text' AND length(CAST(${table==='timeline_requests'?'requestId':'id'} AS BLOB))<=800 THEN ${table==='timeline_requests'?'requestId':'id'} END`:'';
   const query=`SELECT ${identity?`${identity} AS rowIdentity,`:''}${owner} AS owner,CASE WHEN length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${JSON_BYTES} THEN CASE WHEN json_valid(${column}) THEN EXISTS(SELECT 1 FROM json_tree(${column}) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1) ELSE 1 END ELSE 1 END AS duplicateKeys,CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${JSON_BYTES} THEN ${column} END AS value FROM main.${quote(table)} WHERE CASE WHEN length(CAST(${column} AS BLOB))>${JSON_BYTES} THEN 1 ELSE CASE WHEN json_valid(${column}) THEN EXISTS(SELECT 1 FROM json_tree(${column}) WHERE key IN ('colour','colourPlan') OR key='profileId' AND atom IN ('mioon-srgb-image-clip-v1','png-rgb8-srgb-v1','mioon-mixed-sdr-render-v2','mioon-jfif-image-clip-v1','jfif-ycbcr8-srgb-v1','mioon-mixed-sdr-render-v3')) ELSE 0 END END`;
   for(const row of db.prepare(query).iterate()){
    if(!allowColour||typeof row.value!=='string'||row.duplicateKeys!==0)invalid(allowColour);
    let value:unknown;try{value=JSON.parse(row.value);}catch{invalid(allowColour);}
    // An unresolved/not-applied durable intent may legitimately contain a
    // missing resource or stale hash. Validate its shape, never reinterpret
    // that rejected intention as accepted timeline/source ownership.
    inspect(value,row.owner,table!=='edit_tasks'&&table!=='agent_edit_proposals',table,row.rowIdentity);
   }
  }
 }
}
