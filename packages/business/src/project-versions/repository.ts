import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../../contracts/src/app-error.ts';
import {projectVersionSummarySchema} from '../../../contracts/src/project-versions.ts';
import type {ProjectVersionSummary} from '../../../contracts/src/project-versions.ts';
import type {ProjectVersionTrigger} from '../../../contracts/src/project-versions.ts';
import type {EncodedProjectDocument} from './codec.ts';
import {decodeProjectDocument} from './codec.ts';

export const versionError = (code: string, message: string, status = 409) => new AppError(code, message, status);
export function versionSummary(row: Record<string, unknown>): ProjectVersionSummary {
  const {id,projectId,trigger,name,mioRunId,contentSequence,createdAt}=row;
  const parsed=projectVersionSummarySchema.safeParse({id,projectId,trigger,name,mioRunId,contentSequence,createdAt});
  if(!parsed.success)throw versionError('PROJECT_VERSION_RECORD_INVALID','本机版本记录无效。',422);
  return parsed.data;
}
export function readVersion(db:DatabaseSync,projectId:string,id:string):Record<string,unknown>{
  const row=db.prepare('SELECT * FROM main.project_versions WHERE projectId=? AND id=?').get(projectId,id);
  if(!row)throw versionError('PROJECT_VERSION_NOT_FOUND','找不到这个项目版本。',404);
  return row;
}
export interface StoreProjectVersionInput {
  readonly projectId:string;
  readonly trigger:ProjectVersionTrigger;
  readonly name?:string|null;
  readonly mioRunId?:string|null;
  readonly contentSequence:number;
  readonly blob:EncodedProjectDocument;
  /** Captured before the content mutation, not when its observer runs. */
  readonly mioChangeRowid:number;
  readonly createdAt?:string;
}
export function storeProjectVersionInside(db:DatabaseSync,input:StoreProjectVersionInput):ProjectVersionSummary{
  if(!db.isTransaction)throw new TypeError('Version save requires a transaction');
  const {projectId,contentSequence,blob,mioChangeRowid}=input;
  const summary=versionSummary({id:randomUUID(),projectId,trigger:input.trigger,name:input.name??null,mioRunId:input.mioRunId??null,
    contentSequence,createdAt:input.createdAt??new Date().toISOString()});
  if(!Number.isSafeInteger(mioChangeRowid)||mioChangeRowid<0)throw new TypeError('A captured nonnegative Mio rowid is required');
  const exists=db.prepare('SELECT * FROM main.project_version_blobs WHERE hash=?').get(blob.hash);
  if(exists){
    const document=decodeProjectDocument(exists as unknown as EncodedProjectDocument);
    if(document.projectId!==projectId||document.evidence.contentSequence!==contentSequence)throw versionError('PROJECT_VERSION_RECORD_INVALID','版本正文与摘要不一致。',422);
  }
  if(!exists)db.prepare('INSERT INTO main.project_version_blobs(hash,profile,codec,rawBytes,compressedBytes,payload) VALUES(?,?,?,?,?,?)')
    .run(blob.hash,blob.profile,blob.codec,blob.rawBytes,blob.compressedBytes,blob.payload);
  db.prepare('INSERT INTO main.project_versions(id,projectId,trigger,name,mioRunId,contentSequence,createdAt,blobHash,mioChangeRowid) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(summary.id,projectId,summary.trigger,summary.name,summary.mioRunId,contentSequence,summary.createdAt,blob.hash,mioChangeRowid);
  return summary;
}
export function storeManualVersionInside(db:DatabaseSync, projectId:string, name:string|null, contentSequence:number, blob:EncodedProjectDocument):ProjectVersionSummary{
  if(!db.isTransaction)throw new TypeError('Version save requires a transaction');
  const boundary=Number(db.prepare('SELECT COALESCE(max(rowid),0) n FROM main.mio_changes').get()?.n);
  return storeProjectVersionInside(db,{projectId,trigger:'manual',name,contentSequence,blob,mioChangeRowid:boundary});
}
