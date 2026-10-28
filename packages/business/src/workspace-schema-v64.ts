import type {DatabaseSync} from 'node:sqlite';
import {createWorkspaceRestoreProfileV63} from './workspace-restore-schema-v63.ts';
import {oneProfilePerConstructor} from './workspace-restore-profile-cache.ts';
import {classifyWorkspaceSchemaV64V65} from './workspace-restore-schema-v65.ts';
import {installPrevisDefinitions,validatePrevisRows} from './previs-schema.ts';
const profile63=oneProfilePerConstructor(createWorkspaceRestoreProfileV63);

/** Ordinary62 to ordinary64: camera previs receipts, the thumbnail cache and
 * previs node bounds. Only fixed DDL and markers change; historical JSON and
 * receipts stay intact. */
export function initializeWorkspaceSchema64(db:DatabaseSync,initializeThrough24:(db:DatabaseSync)=>void):void {
 if(db.isTransaction)throw Object.assign(new Error('Isolated migration required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const main=profile63(initializeThrough24);
 let value;try{value=main.classifyWorkspaceSchemaV62V63(db);}catch(strictFailure){try{value=main.classifyWorkspaceSchemaV62V63AllowingUnknown(db);}catch{throw strictFailure;}}
 if(value.schemaVersion!==62)throw Object.assign(new Error('Ordinary62 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 db.exec('BEGIN IMMEDIATE');
 try{
  installPrevisDefinitions(db);db.exec('INSERT INTO schema_version VALUES(64)');
  validatePrevisRows(db);db.exec('COMMIT');
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
export function validateWorkspaceSchema64(db:DatabaseSync):void {
 if(classifyWorkspaceSchemaV64V65(db).schemaVersion!==64)throw Object.assign(new Error('Ordinary64 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}
