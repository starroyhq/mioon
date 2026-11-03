import type {DatabaseSync} from 'node:sqlite';
import {hasAssetReference,validAssetLocator} from './asset-reference-record.ts';
import {isProjectDatabase} from './project-file/held-files.ts';

type RecordValue=Record<string,unknown>;
const object=(value:unknown):value is RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);

/** The unchanged local observation reader still asks for a producer filename.
 * Expose only that actual canonical reference path on a read-only prototype;
 * it cannot enter JSON, object spreads, or a persisted asset locator. All I/O
 * authorization continues to use the reference and exact current owner.
 * An external/renamed relink has no such observation and is conservatively
 * unavailable to that old check, even when the reference itself is readable. */
export function projectExportObservation(db:DatabaseSync,projectId:string,asset:RecordValue):RecordValue {
 if(!isProjectDatabase(db)||!validAssetLocator(db,asset)||!hasAssetReference(asset)||asset.projectId!==projectId||
  !uuid(asset.id)||asset.provenance!=='export'||asset.mimeType!=='video/mp4'||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(asset.sha256)||
  !Number.isSafeInteger(asset.sizeBytes)||Number(asset.sizeBytes)<1||asset.reference.fullSha256!==asset.sha256||asset.reference.sizeBytes!==asset.sizeBytes||
  !object(asset.producer)||asset.producer.kind!=='export'||!uuid(asset.producer.id)||asset.reference.pathForm!=='relative'||asset.reference.volume!==null)return asset;
 const relativePath=asset.reference.path,exportId=asset.producer.id;
 if(!new RegExp(`^media/export-${exportId}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.mp4$`,'u').test(relativePath))return asset;
 // Predicates stay inside the bounded JSON document; only the indexed owner
 // identity leaves SQLite, never an export snapshot or an unbounded string.
 const owner=db.prepare("SELECT id FROM exports WHERE id=? AND projectId=? AND typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 4194304 AND json_valid(data) AND json_extract(data,'$.id')=? AND json_extract(data,'$.projectId')=? AND json_extract(data,'$.status')='succeeded' AND json_extract(data,'$.assetId')=? AND json_extract(data,'$.url')=? LIMIT 1")
  .get(exportId,projectId,exportId,projectId,asset.id,`/media/${asset.id}`);
 if(!owner)return asset;
 const prototype=Object.create(Object.prototype,{relativePath:{get:()=>relativePath,enumerable:false,configurable:false}});
 Object.freeze(prototype);
 return Object.create(prototype,Object.getOwnPropertyDescriptors(asset)) as RecordValue;
}
