import type {DatabaseSync} from 'node:sqlite';
import {createWorkspaceRestoreProfileV49} from './workspace-restore-schema-v49.ts';
import {classifyWorkspaceSchemaV50V51} from './workspace-restore-schema-v51.ts';
import {installTaskDispositionDefinitions,validateTaskDispositionRows} from './task-disposition-schema.ts';

/** The frozen48 classifier proves the complete source before any schema50 write. */
export function initializeWorkspaceSchema50(db:DatabaseSync,initializeThrough24:(db:DatabaseSync)=>void):void {
  if(db.isTransaction)throw Object.assign(new Error('Isolated migration required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  const source=createWorkspaceRestoreProfileV49(initializeThrough24);
  let role;
  try{role=source.classifyWorkspaceSchemaV48V49(db);}
  catch(strictFailure){try{role=source.classifyWorkspaceSchemaV48V49AllowingUnknown(db);}catch{throw strictFailure;}}
  if(role.schemaVersion!==48)throw Object.assign(new Error('Ordinary48 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  db.exec('BEGIN IMMEDIATE');
  try{installTaskDispositionDefinitions(db);db.exec('INSERT INTO schema_version VALUES(50)');validateTaskDispositionRows(db);db.exec('COMMIT');}
  catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
export function validateWorkspaceSchema50(db:DatabaseSync):void {
  if(classifyWorkspaceSchemaV50V51(db).schemaVersion!==50)throw Object.assign(new Error('Ordinary50 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}
