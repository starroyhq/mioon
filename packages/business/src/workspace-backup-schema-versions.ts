import {validateWorkspaceSchema64} from './workspace-schema-v64.ts';
import {createWorkspaceRestoreProfileV65} from './workspace-restore-schema-v65.ts';
import {validateWorkspaceSchema66} from './workspace-schema-v66.ts';
import {createWorkspaceRestoreProfileV67} from './workspace-restore-schema-v67.ts';
import {validateWorkspaceSchema70} from './workspace-schema-v70.ts';
import {createWorkspaceRestoreProfileV71} from './workspace-restore-schema-v71.ts';
import {validateWorkspaceTransformRows} from './workspace-transform-validation.ts';
import {validateWorkspaceSchema72} from './workspace-schema-v72.ts';
import {createWorkspaceRestoreProfileV73} from './workspace-restore-schema-v73.ts';
import {validateWorkspaceTransitionRows} from './workspace-transition-validation.ts';
import {validateWorkspaceSchema68} from './workspace-schema-v68.ts';
import {createWorkspaceRestoreProfileV69} from './workspace-restore-schema-v69.ts';
import {validateWorkspaceSchema62} from './workspace-schema-v62.ts';
import {createWorkspaceRestoreProfileV63} from './workspace-restore-schema-v63.ts';
import {validateWorkspaceSchema60} from './workspace-schema-v60.ts';
import {createWorkspaceRestoreProfileV61} from './workspace-restore-schema-v61.ts';
import {createWorkspaceRestoreProfileV59 as createPrivateStorageProfileV59} from './workspace-storage-restore-schema-v59.ts';
import {validateWorkspaceSchema58} from './workspace-schema-v58.ts';
import {createWorkspaceRestoreProfileV59} from './workspace-restore-schema-v59.ts';
import {validateWorkspaceSchema56} from './workspace-schema-v56.ts';
import {createWorkspaceRestoreProfileV57} from './workspace-restore-schema-v57.ts';
import {validateWorkspaceSchema54} from './workspace-schema-v54.ts';
import {createWorkspaceRestoreProfileV55} from './workspace-restore-schema-v55.ts';
import {validateWorkspaceSchema52} from './workspace-schema-v52.ts';
import {createWorkspaceRestoreProfileV53} from './workspace-restore-schema-v53.ts';
import {validateWorkspaceSchema50} from './workspace-schema-v50.ts';
import {createWorkspaceRestoreProfileV51} from './workspace-restore-schema-v51.ts';
import {validateWorkspaceSchema48} from './workspace-schema-v48.ts';
import {createWorkspaceRestoreProfileV49} from './workspace-restore-schema-v49.ts';
import {createWorkspaceRestoreProfileV45} from './workspace-restore-schema-v45.ts';
import {createWorkspaceRestoreProfileV41} from './workspace-restore-schema-v41.ts';
import {initializeWorkspaceSchemaThrough24} from './workspace-fixed-schema.ts';
import {validateWorkspaceSchema44} from './workspace-schema-v44.ts';
import {validateWorkspaceSchema40} from './workspace-schema-v40.ts';
import {validateWorkspaceVolumeEnvelopeRows} from './workspace-volume-envelope-validation.ts';
import {validateWorkspaceSchema38} from './workspace-schema-v38.ts';
import {validateWorkspaceAudioRoleRows} from './workspace-audio-role-validation.ts';
import {validateWorkspaceSchema36} from './workspace-schema-v36.ts';
import type {DatabaseSync} from 'node:sqlite';
import {validateWorkspaceSchema26} from './workspace-schema-v26.ts';
import {validateWorkspaceSchema28} from './workspace-schema-v28.ts';
import {validateWorkspaceSchema30} from './workspace-schema-v30.ts';
import {validateWorkspaceSchema32} from './workspace-schema-v32.ts';
import {validateWorkspaceSchema34} from './workspace-schema-v34.ts';
import {validateWorkspaceColourRows} from './workspace-colour-validation.ts';
import {isWorkspaceSchemaSince,workspaceSchemasSince} from '../../contracts/src/workspace-schema-lineage.ts';

function invalid(): never {throw Object.assign(new Error('Invalid workspace database schema.'),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});}
// The approved marker set: 1–24 plus every later ordinary lineage version.
const LINEAGE_MARKERS=workspaceSchemasSince(26),MARKER_LIMIT=24+LINEAGE_MARKERS.length;

/** Cold archives preserve unrelated unknown objects just as historical1–24
 * capture did. New26/28/30/32/34 still require its exact markers and migration-owned task
 * structure. Integrity verification does not grant fixed-profile restoration;
 * the separate offline restore classifier remains stricter. */
export function readWorkspaceBackupSchemaVersion(db:DatabaseSync): number {
 const versions=new Set<number>();let version=0;
 // Project only the small approved integer set before SQLite crosses into JS.
 // Verify also handles imported nonstandard marker tables, whose values may be
 // arbitrarily large text or blobs; a row cap alone does not bound those cells.
 for(const row of db.prepare(`SELECT CASE WHEN typeof(version)='integer' AND
   (version BETWEEN 1 AND 24 OR version IN (${LINEAGE_MARKERS.join(',')})) THEN version ELSE NULL END AS version
   FROM main.schema_version LIMIT ${MARKER_LIMIT+1}`).iterate()){
  if(versions.size>=MARKER_LIMIT||typeof row.version!=='number'||
     !((row.version>=1&&row.version<=24)||isWorkspaceSchemaSince(26,row.version))||versions.has(row.version))invalid();
  versions.add(row.version);version=Math.max(version,row.version);
 }
 if(!version)invalid();
 // Clip transforms exist from schema70 on; an older archive cannot carry one.
 if(!isWorkspaceSchemaSince(70,version))try{validateWorkspaceTransformRows(db,{allowTransforms:false});}catch{invalid();}
 // Clip transitions exist from schema72 on; an older archive cannot carry one.
 if(!isWorkspaceSchemaSince(72,version))try{validateWorkspaceTransitionRows(db,{allowTransitions:false});}catch{invalid();}
 if(version===64){try{validateWorkspaceSchema64(db);}catch{try{const classification=createWorkspaceRestoreProfileV65(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV64V65AllowingUnknown(db);if(classification.schemaVersion!==64)invalid();}catch{invalid();}}return version;}
 if(version===70){try{validateWorkspaceSchema70(db);}catch{try{const classification=createWorkspaceRestoreProfileV71(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV70V71AllowingUnknown(db);if(classification.schemaVersion!==70)invalid();}catch{invalid();}}return version;}
 if(version===72){try{validateWorkspaceSchema72(db);}catch{try{const classification=createWorkspaceRestoreProfileV73(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV72V73AllowingUnknown(db);if(classification.schemaVersion!==72)invalid();}catch{invalid();}}return version;}
 if(version===68){try{validateWorkspaceSchema68(db);}catch{try{const classification=createWorkspaceRestoreProfileV69(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV68V69AllowingUnknown(db);if(classification.schemaVersion!==68)invalid();}catch{invalid();}}return version;}
 if(version===66){try{validateWorkspaceSchema66(db);}catch{try{const classification=createWorkspaceRestoreProfileV67(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV66V67AllowingUnknown(db);if(classification.schemaVersion!==66)invalid();}catch{invalid();}}return version;}
 if(version===62){try{validateWorkspaceSchema62(db);}catch{try{const classification=createWorkspaceRestoreProfileV63(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV62V63AllowingUnknown(db);if(classification.schemaVersion!==62)invalid();}catch{invalid();}}return version;}
 if(version===60){try{validateWorkspaceSchema60(db);}catch{try{const classification=createWorkspaceRestoreProfileV61(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV60V61AllowingUnknown(db);if(classification.schemaVersion!==60)invalid();}catch{invalid();}}return version;}
 if(version===58){try{validateWorkspaceSchema58(db);}catch{try{const classification=createWorkspaceRestoreProfileV59(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV58V59AllowingUnknown(db);if(classification.schemaVersion!==58)invalid();}catch{try{const classification=createPrivateStorageProfileV59(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV58V59(db);if(classification.schemaVersion!==58)invalid();}catch{invalid();}}}return version;}
 if(version===56){try{validateWorkspaceSchema56(db);}catch{try{const classification=createWorkspaceRestoreProfileV57(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV56V57AllowingUnknown(db);if(classification.schemaVersion!==56)invalid();}catch{invalid();}}return version;}
 if(version===54){try{validateWorkspaceSchema54(db);}catch{try{const classification=createWorkspaceRestoreProfileV55(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV54V55AllowingUnknown(db);if(classification.schemaVersion!==54)invalid();}catch{invalid();}}return version;}
 if(version===52){try{validateWorkspaceSchema52(db);}catch{try{const classification=createWorkspaceRestoreProfileV53(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV52V53AllowingUnknown(db);if(classification.schemaVersion!==52)invalid();}catch{invalid();}}return version;}
 if(version===50){try{validateWorkspaceSchema50(db);}catch{try{const classification=createWorkspaceRestoreProfileV51(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV50V51AllowingUnknown(db);if(classification.schemaVersion!==50)invalid();}catch{invalid();}}return version;}
 if(version===48){try{validateWorkspaceSchema48(db);}catch{try{const classification=createWorkspaceRestoreProfileV49(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV48V49AllowingUnknown(db);if(classification.schemaVersion!==48)invalid();}catch{invalid();}}return version;}
 if(version===44){try{validateWorkspaceSchema44(db);}catch{try{const classification=createWorkspaceRestoreProfileV45(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV44V45AllowingUnknown(db);if(classification.schemaVersion!==44)invalid();}catch{invalid();}}return version;}
 if(version===40){try{validateWorkspaceSchema40(db);}catch{try{const classification=createWorkspaceRestoreProfileV41(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV40V41AllowingUnknown(db);if(classification.schemaVersion!==40)invalid();}catch{invalid();}}return version;}
 try{validateWorkspaceVolumeEnvelopeRows(db,{allowVolumeEnvelopes:false,allowOpaqueCells:true});}catch{invalid();}
 try{validateWorkspaceAudioRoleRows(db,{allowAudioRoles:version===38});}catch{invalid();}
 try{validateWorkspaceColourRows(db,{allowColour:version===30||version===32||version===34||version===36||version===38,allowMixedImages:version===32||version===34||version===36||version===38,allowJpegImages:version===34||version===36||version===38});}catch{invalid();}
 if(version===26){
  try{validateWorkspaceSchema26(db);}catch{invalid();}
 }
 if(version===28){
  try{validateWorkspaceSchema28(db);}catch{invalid();}
 }
 if(version===30){
  try{validateWorkspaceSchema30(db);}catch{invalid();}
 }
 if(version===32){
  try{validateWorkspaceSchema32(db);}catch{invalid();}
 }
 if(version===34){
  try{validateWorkspaceSchema34(db);}catch{invalid();}
 }
 if(version===36){try{validateWorkspaceSchema36(db);}catch{invalid();}}
 if(version===38){try{validateWorkspaceSchema38(db);}catch{invalid();}}
 return version;
}

/** Positive-only cold-capture refusal. This does not assign a supported role or
 * authorize any imported schema. Partial restore artifacts must retain the
 * established explicit backup-unavailable diagnostic even when the stricter
 * current role classifier rejects their contradictory ordinary26 markers. */
export function hasWorkspaceBackupRestoreEvidence(db:DatabaseSync): boolean {
 let count=0;
 for(const value of db.prepare(`SELECT type,
   CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name,
   CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql
   FROM main.sqlite_schema LIMIT 1025`).iterate()){
  if(++count>1024||typeof value.name!=='string'||Buffer.byteLength(value.name)>128)
   throw Object.assign(new Error('RESTORE_SCHEMA_LIMIT'),{code:'RESTORE_SCHEMA_LIMIT'});
  const name=value.name.replace(/[A-Z]/g,letter=>letter.toLowerCase());
  if(name.startsWith('workspace_restor')||name.startsWith('restore_'))return true;
  if(name==='edit_tasks'){
   if(value.type!=='table'||typeof value.sql!=='string')
    throw Object.assign(new Error('RESTORE_SCHEMA_UNSUPPORTED'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
   if(/executionepoch/i.test(value.sql))return true;
  }
 }
 return false;
}
