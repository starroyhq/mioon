import type {DatabaseSync} from 'node:sqlite';
import {createWorkspaceRestoreProfileV59} from './workspace-restore-schema-v59.ts';
import {createWorkspaceRestoreProfileV59 as createPrivateStorageProfileV59} from './workspace-storage-restore-schema-v59.ts';
import {classifyWorkspaceSchemaV60V61} from './workspace-restore-schema-v61.ts';
import {installSceneDefinitions,validateSceneRows} from './scene-schema.ts';
import {installAgentTaskStorageDefinitionsV2,validateAgentTaskStorageRowsV2} from './agent/task-storage-schema-v2.ts';

/** Main58 and the precisely classified development-only storage58 converge on
 * one60 profile. Only fixed DDL/markers change; historical JSON stays intact. */
export function initializeWorkspaceSchema60(db:DatabaseSync,initializeThrough24:(db:DatabaseSync)=>void):void {
 if(db.isTransaction)throw Object.assign(new Error('Isolated migration required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 let privateStorage=false;
 const main=createWorkspaceRestoreProfileV59(initializeThrough24),privateProfile=createPrivateStorageProfileV59(initializeThrough24);
 try {let value;try{value=main.classifyWorkspaceSchemaV58V59(db);}catch(strictFailure){try{value=main.classifyWorkspaceSchemaV58V59AllowingUnknown(db);}catch{throw strictFailure;}}if(value.schemaVersion!==58)throw Object.assign(new Error('Ordinary58 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});}
 catch(mainFailure){try {const value=privateProfile.classifyWorkspaceSchemaV58V59(db);if(value.schemaVersion!==58)throw mainFailure;privateStorage=true;}catch{throw mainFailure;}}
 db.exec('BEGIN IMMEDIATE');
 try {
  if(privateStorage){for(const suffix of ['update','delete','replace'])db.exec(`DROP TRIGGER agent_task_model_request_${suffix}_v58`);installSceneDefinitions(db);}
  installAgentTaskStorageDefinitionsV2(db);db.exec('INSERT INTO schema_version VALUES(60)');
  validateAgentTaskStorageRowsV2(db);validateSceneRows(db);db.exec('COMMIT');
 } catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
export function validateWorkspaceSchema60(db:DatabaseSync):void {
 if(classifyWorkspaceSchemaV60V61(db).schemaVersion!==60)throw Object.assign(new Error('Ordinary60 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}
