import type {DatabaseSync} from 'node:sqlite';
import {assetAnnotationSchemas,isAssetAnnotationResponse} from '../../contracts/src/asset-annotations.ts';
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item!==null&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const invalid=():never=>{throw Object.assign(new Error('Invalid asset annotation records'),{code:'INVALID_ASSET_ANNOTATION_RECORD'});};
const parse=(value:unknown):any=>{if(typeof value!=='string')return invalid();try{const parsed:unknown=JSON.parse(value);return parsed!==null&&typeof parsed==='object'?parsed:invalid();}catch{return invalid();}};
export function validateAssetAnnotationRows(db:DatabaseSync):void{
 for(const row of db.prepare(`SELECT CASE WHEN typeof(d.assetId)='text' AND length(CAST(d.assetId AS BLOB))=36 THEN d.assetId END AS assetId,CASE WHEN typeof(d.projectId)='text' AND length(CAST(d.projectId AS BLOB))=36 THEN d.projectId END AS projectId,CASE WHEN typeof(d.revision)='integer' AND d.revision BETWEEN 1 AND 9007199254740991 THEN d.revision END AS revision,
 CASE WHEN length(CAST(d.tags AS BLOB))<=16384 THEN d.tags END AS tags,CASE WHEN length(CAST(d.note AS BLOB))<=16384 THEN d.note END AS note,
 CASE WHEN typeof(a.projectId)='text' AND length(CAST(a.projectId AS BLOB))=36 THEN a.projectId END AS assetProject,CASE WHEN length(CAST(a.data AS BLOB))<=16384 THEN a.data END AS assetData,
 CASE WHEN length(CAST(p.data AS BLOB))<=16384 THEN p.data END AS projectData
 FROM asset_annotations d LEFT JOIN assets a ON a.id=d.assetId LEFT JOIN projects p ON p.id=d.projectId`).iterate()){
  const asset=parse(row.assetData),project=parse(row.projectData);
  if(row.assetProject!==row.projectId||asset.id!==row.assetId||asset.projectId!==row.projectId||project.id!==row.projectId||!isAssetAnnotationResponse({id:row.assetId,assetId:row.assetId,projectId:row.projectId,revision:row.revision,tags:parse(row.tags),note:row.note}))invalid();
 }
 for(const row of db.prepare(`SELECT CASE WHEN typeof(requestId)='text' AND length(CAST(requestId AS BLOB)) BETWEEN 8 AND 800 THEN requestId END AS requestId,CASE WHEN typeof(operation)='text' AND length(CAST(operation AS BLOB))<=80 THEN operation END AS operation,CASE WHEN typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId,
 CASE WHEN length(CAST(canonicalInput AS BLOB))<=24576 THEN canonicalInput END AS canonicalInput,
 CASE WHEN length(CAST(response AS BLOB))<=24576 THEN response END AS response FROM asset_annotation_requests`).iterate()){
  const fields=parse(row.canonicalInput),response=parse(row.response),input={...fields,requestId:row.requestId};
  if(canonical(fields)!==row.canonicalInput||row.operation!=='asset.annotation.set'||!assetAnnotationSchemas['asset.annotation.set'].safeParse(input).success||fields.projectId!==row.projectId||!isAssetAnnotationResponse(response)||response.assetId!==fields.assetId||response.projectId!==fields.projectId||response.revision!==fields.expectedRevision+1||response.note!==fields.note||JSON.stringify(response.tags)!==JSON.stringify(fields.tags))invalid();
  const current=db.prepare(`SELECT CASE WHEN length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId,CASE WHEN typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991 THEN revision END AS revision,CASE WHEN length(CAST(tags AS BLOB))<=16384 THEN tags END AS tags,CASE WHEN length(CAST(note AS BLOB))<=16384 THEN note END AS note FROM asset_annotations WHERE assetId=?`).get(response.assetId);
  if(!current||current.projectId!==row.projectId||typeof current.revision!=='number'||current.revision<response.revision||current.revision===response.revision&&(current.note!==response.note||current.tags!==JSON.stringify(response.tags)))invalid();
  for(const table of ['mutation_requests','asset_range_requests','asset_disposition_requests','subject_requests'])if(db.prepare(`SELECT 1 FROM ${table} WHERE requestId=?`).get(row.requestId))invalid();
 }
}
