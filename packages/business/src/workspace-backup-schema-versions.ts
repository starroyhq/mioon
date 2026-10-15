import {validateWorkspaceSchema36} from './workspace-schema-v36.ts';
import type {DatabaseSync} from 'node:sqlite';
import {validateWorkspaceSchema26} from './workspace-schema-v26.ts';
import {validateWorkspaceSchema28} from './workspace-schema-v28.ts';
import {validateWorkspaceSchema30} from './workspace-schema-v30.ts';
import {validateWorkspaceSchema32} from './workspace-schema-v32.ts';
import {validateWorkspaceSchema34} from './workspace-schema-v34.ts';
import {validateWorkspaceColourRows} from './workspace-colour-validation.ts';

function invalid(): never {throw Object.assign(new Error('Invalid workspace database schema.'),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});}

/** Cold archives preserve unrelated unknown objects just as historical1–24
 * capture did. New26/28/30/32/34 still require its exact markers and migration-owned task
 * structure. Integrity verification does not grant fixed-profile restoration;
 * the separate offline restore classifier remains stricter. */
export function readWorkspaceBackupSchemaVersion(db:DatabaseSync): number {
 const versions=new Set<number>();let version=0;
 // Project only the small approved integer set before SQLite crosses into JS.
 // Verify also handles imported nonstandard marker tables, whose values may be
 // arbitrarily large text or blobs; a row cap alone does not bound those cells.
 for(const row of db.prepare(`SELECT CASE WHEN typeof(version)='integer' AND
   (version BETWEEN 1 AND 24 OR version IN (26,28,30,32,34,36)) THEN version ELSE NULL END AS version
   FROM main.schema_version LIMIT 32`).iterate()){
  if(versions.size>=30||typeof row.version!=='number'||
     !((row.version>=1&&row.version<=24)||row.version===26||row.version===28||row.version===30||row.version===32||row.version===34||row.version===36)||versions.has(row.version))invalid();
  versions.add(row.version);version=Math.max(version,row.version);
 }
 if(!version)invalid();
 try{validateWorkspaceColourRows(db,{allowColour:version===30||version===32||version===34||version===36,allowMixedImages:version===32||version===34||version===36,allowJpegImages:version===34||version===36});}catch{invalid();}
 if(version===26){
  try{validateWorkspaceSchema26(db);}catch{invalid();}
 }
 if(version===28){
  try{validateWorkspaceSchema28(db);}catch{invalid();}
 }
 if(version===30){
  try{validateWorkspaceSchema30(db);}catch{invalid();}
 }
 if(version===32){
  try{validateWorkspaceSchema32(db);}catch{invalid();}
 }
 if(version===34){
  try{validateWorkspaceSchema34(db);}catch{invalid();}
 }
 if(version===36){try{validateWorkspaceSchema36(db);}catch{invalid();}}
 return version;
}

/** Positive-only cold-capture refusal. This does not assign a supported role or
 * authorize any imported schema. Partial restore artifacts must retain the
 * established explicit backup-unavailable diagnostic even when the stricter
 * current role classifier rejects their contradictory ordinary26 markers. */
export function hasWorkspaceBackupRestoreEvidence(db:DatabaseSync): boolean {
 let count=0;
 for(const value of db.prepare(`SELECT type,
   CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name,
   CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql
   FROM main.sqlite_schema LIMIT 1025`).iterate()){
  if(++count>1024||typeof value.name!=='string'||Buffer.byteLength(value.name)>128)
   throw Object.assign(new Error('RESTORE_SCHEMA_LIMIT'),{code:'RESTORE_SCHEMA_LIMIT'});
  const name=value.name.replace(/[A-Z]/g,letter=>letter.toLowerCase());
  if(name.startsWith('workspace_restor')||name.startsWith('restore_'))return true;
  if(name==='edit_tasks'){
   if(value.type!=='table'||typeof value.sql!=='string')
    throw Object.assign(new Error('RESTORE_SCHEMA_UNSUPPORTED'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
   if(/executionepoch/i.test(value.sql))return true;
  }
 }
 return false;
}
