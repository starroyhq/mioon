import type {DatabaseSync} from 'node:sqlite';
import {createWorkspaceRestoreProfileV55} from './workspace-restore-schema-v55.ts';
import {classifyWorkspaceSchemaV56V57} from './workspace-restore-schema-v57.ts';
import {installAgentInteractionDefinitionsV2,validateAgentInteractionRowsV2} from './agent/task-interaction-schema-v2.ts';

/** Only classified ordinary54 acquires A2/A3 metadata. Restored55 remains a
 * fixed read-only recovery format; existing request and event evidence stays. */
export function initializeWorkspaceSchema56(db:DatabaseSync,initializeThrough24:(db:DatabaseSync)=>void):void {
 if(db.isTransaction)throw Object.assign(new Error('Isolated migration required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const source=createWorkspaceRestoreProfileV55(initializeThrough24);let role;
 try{role=source.classifyWorkspaceSchemaV54V55(db);}
 catch(strictFailure){try{role=source.classifyWorkspaceSchemaV54V55AllowingUnknown(db);}catch{throw strictFailure;}}
 if(role.schemaVersion!==54||db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name GLOB 'agent_task_interaction_*' LIMIT 1").get())throw Object.assign(new Error('Ordinary54 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 db.exec('BEGIN IMMEDIATE');
 try{installAgentInteractionDefinitionsV2(db);db.exec('INSERT INTO schema_version VALUES(56)');validateAgentInteractionRowsV2(db);db.exec('COMMIT');}
 catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
export function validateWorkspaceSchema56(db:DatabaseSync):void {
 if(classifyWorkspaceSchemaV56V57(db).schemaVersion!==56)throw Object.assign(new Error('Ordinary56 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}
