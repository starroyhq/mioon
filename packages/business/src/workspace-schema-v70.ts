import type {DatabaseSync} from 'node:sqlite';
import {createWorkspaceRestoreProfileV69} from './workspace-restore-schema-v69.ts';
import {oneProfilePerConstructor} from './workspace-restore-profile-cache.ts';
import {classifyWorkspaceSchemaV70V71} from './workspace-restore-schema-v71.ts';
const profile69=oneProfilePerConstructor(createWorkspaceRestoreProfileV69);

/** Ordinary68 to ordinary70: a marker-only migration, as ordinary40's was for
 * volume envelopes. From schema70 on, persisted timelines may carry clip
 * transforms; no schema object or retained row changes. */
export function initializeWorkspaceSchema70(db:DatabaseSync,initializeThrough24:(db:DatabaseSync)=>void):void {
 if(db.isTransaction)throw Object.assign(new Error('Isolated migration required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const main=profile69(initializeThrough24);
 let value;try{value=main.classifyWorkspaceSchemaV68V69(db);}catch(strictFailure){try{value=main.classifyWorkspaceSchemaV68V69AllowingUnknown(db);}catch{throw strictFailure;}}
 if(value.schemaVersion!==68)throw Object.assign(new Error('Ordinary68 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 db.exec('BEGIN IMMEDIATE');
 try{db.exec('INSERT INTO schema_version VALUES(70)');db.exec('COMMIT');}
 catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
export function validateWorkspaceSchema70(db:DatabaseSync):void {
 if(classifyWorkspaceSchemaV70V71(db).schemaVersion!==70)throw Object.assign(new Error('Ordinary70 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}
