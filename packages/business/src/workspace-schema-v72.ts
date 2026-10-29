import type {DatabaseSync} from 'node:sqlite';
import {createWorkspaceRestoreProfileV71} from './workspace-restore-schema-v71.ts';
import {oneProfilePerConstructor} from './workspace-restore-profile-cache.ts';
import {classifyWorkspaceSchemaV72V73} from './workspace-restore-schema-v73.ts';
const profile71=oneProfilePerConstructor(createWorkspaceRestoreProfileV71);

/** Ordinary70 to ordinary72: a marker-only migration, as ordinary70's was for
 * clip transforms. From schema72 on, persisted timelines may carry clip
 * transitions; no schema object or retained row changes. */
export function initializeWorkspaceSchema72(db:DatabaseSync,initializeThrough24:(db:DatabaseSync)=>void):void {
 if(db.isTransaction)throw Object.assign(new Error('Isolated migration required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const main=profile71(initializeThrough24);
 let value;try{value=main.classifyWorkspaceSchemaV70V71(db);}catch(strictFailure){try{value=main.classifyWorkspaceSchemaV70V71AllowingUnknown(db);}catch{throw strictFailure;}}
 if(value.schemaVersion!==70)throw Object.assign(new Error('Ordinary70 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 db.exec('BEGIN IMMEDIATE');
 try{db.exec('INSERT INTO schema_version VALUES(72)');db.exec('COMMIT');}
 catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
export function validateWorkspaceSchema72(db:DatabaseSync):void {
 if(classifyWorkspaceSchemaV72V73(db).schemaVersion!==72)throw Object.assign(new Error('Ordinary72 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}
