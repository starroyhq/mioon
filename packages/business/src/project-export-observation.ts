import type {DatabaseSync} from 'node:sqlite';
import {hasAssetReference,validAssetLocator} from './asset-reference-record.ts';
import {isProjectDatabase} from './project-file/held-files.ts';
import {createHash} from 'node:crypto';
import {exportOutputArtifactIdentity} from '../../contracts/src/output-artifact.ts';
import {isPublishedProjectOutput} from './project-output-publication.ts';

type RecordValue=Record<string,unknown>;
const object=(value:unknown):value is RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);

/** Pure metadata proof for a native project's exact retained export. The
 * expected owner hash comes from its saved frozen record, never the asset's
 * own claim. File availability is separately checked through the real L1
 * reference; this does not create a path alias or read media bytes. */
export function isProjectExportObservation(db:DatabaseSync,projectId:string,exportId:string,asset:RecordValue):boolean {
 if(!isProjectDatabase(db)||!validAssetLocator(db,asset)||!hasAssetReference(asset)||asset.projectId!==projectId||
  !uuid(asset.id)||asset.provenance!=='export'||asset.mimeType!=='video/mp4'||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(asset.sha256)||
  !Number.isSafeInteger(asset.sizeBytes)||Number(asset.sizeBytes)<1||asset.reference.fullSha256!==asset.sha256||asset.reference.sizeBytes!==asset.sizeBytes||
  !uuid(exportId)||!object(asset.producer)||asset.producer.kind!=='export'||asset.producer.id!==exportId)return false;
 const row=db.prepare("SELECT id,projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 4194304 THEN data END AS data FROM exports WHERE id=? AND projectId=? LIMIT 1").get(exportId,projectId);
 if(!row||typeof row.data!=='string')return false;
 let owner:unknown;try{owner=JSON.parse(row.data);}catch{return false;}
 if(!object(owner)||owner.id!==row.id||owner.projectId!==row.projectId||owner.status!=='succeeded'||owner.assetId!==asset.id||
  owner.url!==`/media/${asset.id}`||typeof owner.requestId!=='string'||owner.requestId.length<8||owner.requestId.length>200)return false;
 return isPublishedProjectOutput(asset,{projectId,assetId:asset.id,owner:{kind:'export',id:exportId,requestId:owner.requestId,
  inputHash:createHash('sha256').update(exportOutputArtifactIdentity(owner)).digest('hex')},targetKind:'exports',mimeType:'video/mp4',sha256:asset.sha256,sizeBytes:Number(asset.sizeBytes)});
}
export function projectExportObservation(_db:DatabaseSync,_projectId:string,asset:RecordValue):RecordValue {
 // Ordinary media keeps its real locator, including an authorized relink.
 // Export consumers use the strict gate above; no inherited path is invented.
 return asset;
}
