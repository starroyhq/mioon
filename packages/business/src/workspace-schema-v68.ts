import type {DatabaseSync} from 'node:sqlite';
import {createWorkspaceRestoreProfileV67} from './workspace-restore-schema-v67.ts';
import {oneProfilePerConstructor} from './workspace-restore-profile-cache.ts';
import {classifyWorkspaceSchemaV68V69} from './workspace-restore-schema-v69.ts';
import {migrateSceneKeyframeEditReviewSchema} from './images/review-schema-v68.ts';
const profile67=oneProfilePerConstructor(createWorkspaceRestoreProfileV67);

/** Ordinary66 to ordinary68: a storyboard keyframe may be the source of an
 * edit (intent v5 gains a scene-keyframe origin). Only the image_reviews CHECK
 * and the marker change; every retained row stays intact. The image_reviews
 * rebuild needs the same isolated foreign-key guard as schema62. */
export function initializeWorkspaceSchema68(db:DatabaseSync,initializeThrough24:(db:DatabaseSync)=>void):void {
 if(db.isTransaction)throw Object.assign(new Error('Isolated migration required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const main=profile67(initializeThrough24);
 let value;try{value=main.classifyWorkspaceSchemaV66V67(db);}catch(strictFailure){try{value=main.classifyWorkspaceSchemaV66V67AllowingUnknown(db);}catch{throw strictFailure;}}
 if(value.schemaVersion!==66)throw Object.assign(new Error('Ordinary66 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 try{
  db.exec('PRAGMA foreign_keys=OFF');
  if(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys!==0)throw new Error('Could not guard the schema68 image review rebuild');
  db.exec('BEGIN IMMEDIATE');
  migrateSceneKeyframeEditReviewSchema(db);db.exec('INSERT INTO schema_version VALUES(68)');
  if(db.prepare('PRAGMA foreign_key_check').get())throw Object.assign(new Error('Schema68 foreign keys are invalid'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  db.exec('COMMIT');
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
 finally{db.exec('PRAGMA foreign_keys=ON');}
}
export function validateWorkspaceSchema68(db:DatabaseSync):void {
 if(classifyWorkspaceSchemaV68V69(db).schemaVersion!==68)throw Object.assign(new Error('Ordinary68 required'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}
