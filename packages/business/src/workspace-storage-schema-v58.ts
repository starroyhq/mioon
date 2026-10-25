import type {DatabaseSync} from 'node:sqlite';
import {createWorkspaceRestoreProfileV57} from './workspace-restore-schema-v57.ts';
import {classifyWorkspaceSchemaV58V59} from './workspace-storage-restore-schema-v59.ts';
import {installAgentTaskStorageDefinitionsV58 as installAgentTaskStorageDefinitionsV2,validateAgentTaskStorageRowsV2} from './agent/task-storage-schema-v2.ts';

/** Only classified ordinary56 gains request references and the bounded256MiB
 * journal. Restored57 and every historical evidence row stay untouched. */
export function initializeWorkspaceSchema58(db:DatabaseSync,initializeThrough24:(db:DatabaseSync)=>void):void {
 if(db.isTransaction)throw Object.assign(new Error('Isolated migration required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const source=createWorkspaceRestoreProfileV57(initializeThrough24);let role;
 try{role=source.classifyWorkspaceSchemaV56V57(db);}
 catch(strictFailure){try{role=source.classifyWorkspaceSchemaV56V57AllowingUnknown(db);}catch{throw strictFailure;}}
 if(role.schemaVersion!==56||db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name GLOB 'agent_task_model_request_*_v58' LIMIT 1").get())throw Object.assign(new Error('Ordinary56 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 db.exec('BEGIN IMMEDIATE');
 try{installAgentTaskStorageDefinitionsV2(db);db.exec('INSERT INTO schema_version VALUES(58)');validateAgentTaskStorageRowsV2(db);db.exec('COMMIT');}
 catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
export function validateWorkspaceSchema58(db:DatabaseSync):void {
 if(classifyWorkspaceSchemaV58V59(db).schemaVersion!==58)throw Object.assign(new Error('Ordinary58 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}

export const validateWorkspaceStorageSchema58=validateWorkspaceSchema58;
