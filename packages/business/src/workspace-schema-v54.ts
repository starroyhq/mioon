import type {DatabaseSync} from 'node:sqlite';
import {createWorkspaceRestoreProfileV53} from './workspace-restore-schema-v53.ts';
import {oneProfilePerConstructor} from './workspace-restore-profile-cache.ts';
import {classifyWorkspaceSchemaV54V55} from './workspace-restore-schema-v55.ts';
import {installAgentConversationDefinitionsV2,validateAgentConversationRowsV2} from './agent/task-conversation-schema-v2.ts';
const sourceProfile=oneProfilePerConstructor(createWorkspaceRestoreProfileV53);

/** Only an explicitly classified ordinary52 may acquire conversation metadata.
 * Restored53 stays an unchanged, read-only historical recovery profile. */
export function initializeWorkspaceSchema54(db:DatabaseSync,initializeThrough24:(db:DatabaseSync)=>void):void {
 if(db.isTransaction)throw Object.assign(new Error('Isolated migration required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const source=sourceProfile(initializeThrough24);let role;
 try{role=source.classifyWorkspaceSchemaV52V53(db);}
 catch(strictFailure){try{role=source.classifyWorkspaceSchemaV52V53AllowingUnknown(db);}catch{throw strictFailure;}}
 if(role.schemaVersion!==52||db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name GLOB 'agent_task_conversation_*' LIMIT 1").get())throw Object.assign(new Error('Ordinary52 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 db.exec('BEGIN IMMEDIATE');
 try{installAgentConversationDefinitionsV2(db);db.exec('INSERT INTO schema_version VALUES(54)');validateAgentConversationRowsV2(db);db.exec('COMMIT');}
 catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
export function validateWorkspaceSchema54(db:DatabaseSync):void {
 if(classifyWorkspaceSchemaV54V55(db).schemaVersion!==54)throw Object.assign(new Error('Ordinary54 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}
