import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../../contracts/src/app-error.ts';
import {projectVersionSummarySchema} from '../../../contracts/src/project-versions.ts';
import type {ProjectVersionSummary} from '../../../contracts/src/project-versions.ts';
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
export function storeManualVersionInside(db:DatabaseSync, projectId:string, name:string|null, contentSequence:number, blob:EncodedProjectDocument):ProjectVersionSummary{
  if(!db.isTransaction)throw new TypeError('Version save requires a transaction');
  const exists=db.prepare('SELECT * FROM main.project_version_blobs WHERE hash=?').get(blob.hash);
  if(exists)decodeProjectDocument(exists as unknown as EncodedProjectDocument);
  if(!exists)db.prepare('INSERT INTO main.project_version_blobs(hash,profile,codec,rawBytes,compressedBytes,payload) VALUES(?,?,?,?,?,?)')
    .run(blob.hash,blob.profile,blob.codec,blob.rawBytes,blob.compressedBytes,blob.payload);
  const id=randomUUID(),createdAt=new Date().toISOString();
  const boundary=Number(db.prepare('SELECT COALESCE(max(rowid),0) n FROM main.mio_changes').get()?.n);
  db.prepare("INSERT INTO main.project_versions(id,projectId,trigger,name,mioRunId,contentSequence,createdAt,blobHash,mioChangeRowid) VALUES(?,?,'manual',?,NULL,?,?,?,?)")
    .run(id,projectId,name,contentSequence,createdAt,blob.hash,boundary);
  return {id,projectId,trigger:'manual',name,mioRunId:null,contentSequence,createdAt};
}
