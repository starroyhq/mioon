import type {DatabaseSync} from 'node:sqlite';
import {createWorkspaceRestoreProfileV51} from './workspace-restore-schema-v51.ts';
import {classifyWorkspaceSchemaV52V53} from './workspace-restore-schema-v53.ts';
import {installAgentTaskDefinitionsV2,validateAgentTaskRowsV2} from './agent/task-schema-v2.ts';

/** Frozen remote50 is the only new migration source; the unreleased harness50
 * catalog is different and must never be inferred or silently converted. */
export function initializeWorkspaceSchema52(db:DatabaseSync,initializeThrough24:(db:DatabaseSync)=>void):void {
 if(db.isTransaction)throw Object.assign(new Error('Isolated migration required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 if(db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name GLOB 'agent_task_*' OR name GLOB 'agent_target_*' OR name GLOB 'agent_quota_*' OR name GLOB 'immutable_agent_task_*' OR name GLOB 'retain_agent_task_*' LIMIT 1").get())throw Object.assign(new Error('Unclassified Agent task evidence'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const source=createWorkspaceRestoreProfileV51(initializeThrough24);let role;
 try{role=source.classifyWorkspaceSchemaV50V51(db);}
 catch(strictFailure){try{role=source.classifyWorkspaceSchemaV50V51AllowingUnknown(db);}catch{throw strictFailure;}}
 if(role.schemaVersion!==50)throw Object.assign(new Error('Ordinary50 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 db.exec('BEGIN IMMEDIATE');
 try{installAgentTaskDefinitionsV2(db);db.exec('INSERT INTO schema_version VALUES(52)');validateAgentTaskRowsV2(db);db.exec('COMMIT');}
 catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
export function validateWorkspaceSchema52(db:DatabaseSync):void {
 if(classifyWorkspaceSchemaV52V53(db).schemaVersion!==52)throw Object.assign(new Error('Ordinary52 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}
