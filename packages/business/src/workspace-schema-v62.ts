import type {DatabaseSync} from 'node:sqlite';
import {createWorkspaceRestoreProfileV61} from './workspace-restore-schema-v61.ts';
import {oneProfilePerConstructor} from './workspace-restore-profile-cache.ts';
import {classifyWorkspaceSchemaV62V63} from './workspace-restore-schema-v63.ts';
import {migrateSizedImageEditReviewSchema} from './images/review-schema-v62.ts';
import {installSubjectVariantDefinitions,validateSubjectVariantRows} from './subject-variant-schema.ts';
const profile61=oneProfilePerConstructor(createWorkspaceRestoreProfileV61);

/** Ordinary60 to ordinary62: sized image edit reviews (intent v5), subject
 * variant batches and the head-preserving subject identity guard. Only fixed
 * DDL and markers change; historical JSON and receipts stay intact. The
 * image_reviews rebuild needs the same isolated foreign-key guard as schema23. */
export function initializeWorkspaceSchema62(db:DatabaseSync,initializeThrough24:(db:DatabaseSync)=>void):void {
 if(db.isTransaction)throw Object.assign(new Error('Isolated migration required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const main=profile61(initializeThrough24);
 let value;try{value=main.classifyWorkspaceSchemaV60V61(db);}catch(strictFailure){try{value=main.classifyWorkspaceSchemaV60V61AllowingUnknown(db);}catch{throw strictFailure;}}
 if(value.schemaVersion!==60)throw Object.assign(new Error('Ordinary60 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 try{
  db.exec('PRAGMA foreign_keys=OFF');
  if(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys!==0)throw new Error('Could not guard the schema62 image review rebuild');
  db.exec('BEGIN IMMEDIATE');
  migrateSizedImageEditReviewSchema(db);installSubjectVariantDefinitions(db);db.exec('INSERT INTO schema_version VALUES(62)');
  validateSubjectVariantRows(db);
  if(db.prepare('PRAGMA foreign_key_check').get())throw Object.assign(new Error('Schema62 foreign keys are invalid'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  db.exec('COMMIT');
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
 finally{db.exec('PRAGMA foreign_keys=ON');}
}
export function validateWorkspaceSchema62(db:DatabaseSync):void {
 if(classifyWorkspaceSchemaV62V63(db).schemaVersion!==62)throw Object.assign(new Error('Ordinary62 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}
