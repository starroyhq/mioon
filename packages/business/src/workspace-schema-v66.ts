import type {DatabaseSync} from 'node:sqlite';
import {createWorkspaceRestoreProfileV65} from './workspace-restore-schema-v65.ts';
import {oneProfilePerConstructor} from './workspace-restore-profile-cache.ts';
import {classifyWorkspaceSchemaV66V67} from './workspace-restore-schema-v67.ts';
import {installAgentPolicyAnswerDefinitionsV2,validateAgentPolicyAnswerRowsV2} from './agent/task-policy-answer-schema-v2.ts';
const profile65=oneProfilePerConstructor(createWorkspaceRestoreProfileV65);
/** Ordinary64 to ordinary66: per-conversation confirmation modes and Mio's
 * questions waiting for an answer. Only fixed DDL and markers change; existing
 * runs, steps and receipts stay intact. */
export function initializeWorkspaceSchema66(db:DatabaseSync,initializeThrough24:(db:DatabaseSync)=>void):void {
 if(db.isTransaction)throw Object.assign(new Error('Isolated migration required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const main=profile65(initializeThrough24);
 let value;try{value=main.classifyWorkspaceSchemaV64V65(db);}catch(strictFailure){try{value=main.classifyWorkspaceSchemaV64V65AllowingUnknown(db);}catch{throw strictFailure;}}
 if(value.schemaVersion!==64)throw Object.assign(new Error('Ordinary64 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 db.exec('BEGIN IMMEDIATE');
 try{
  installAgentPolicyAnswerDefinitionsV2(db);db.exec('INSERT INTO schema_version VALUES(66)');
  validateAgentPolicyAnswerRowsV2(db);db.exec('COMMIT');
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
export function validateWorkspaceSchema66(db:DatabaseSync):void {
 if(classifyWorkspaceSchemaV66V67(db).schemaVersion!==66)throw Object.assign(new Error('Ordinary66 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}
