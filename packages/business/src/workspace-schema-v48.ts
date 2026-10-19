import type {DatabaseSync} from 'node:sqlite';
import {createWorkspaceRestoreProfileV45} from './workspace-restore-schema-v45.ts';
import {classifyWorkspaceSchemaV48V49} from './workspace-restore-schema-v49.ts';
import {migrateProjectLifecycleSchema} from './project-lifecycle-schema.ts';

export function initializeWorkspaceSchema48(db:DatabaseSync,initializeThrough24:(db:DatabaseSync)=>void):void{
  const source=createWorkspaceRestoreProfileV45(initializeThrough24);
  migrateProjectLifecycleSchema(db,value=>{const role=source.classifyWorkspaceSchemaV44V45(value);if(role.schemaVersion!==44)throw Object.assign(new Error('Ordinary44 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});});
}
export function validateWorkspaceSchema48(db:DatabaseSync):void{
  if(classifyWorkspaceSchemaV48V49(db).schemaVersion!==48)throw Object.assign(new Error('Ordinary48 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}
