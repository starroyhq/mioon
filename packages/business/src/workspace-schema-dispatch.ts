import {initializeWorkspaceSchema48} from './workspace-schema-v48.ts';
import {createWorkspaceRestoreProfileV49} from './workspace-restore-schema-v49.ts';
import {initializeWorkspaceSchema44} from './workspace-schema-v44.ts';
import {createWorkspaceRestoreProfileV45} from './workspace-restore-schema-v45.ts';
import {validateHistoricalRestoreCapture} from './workspace-restore-capture-integrity.ts';
import {initializeWorkspaceSchema40} from './workspace-schema-v40.ts';
import {createWorkspaceRestoreProfileV41} from './workspace-restore-schema-v41.ts';
import {validateWorkspaceVolumeEnvelopeRows} from './workspace-volume-envelope-validation.ts';
import {initializeWorkspaceSchema38} from './workspace-schema-v38.ts';
import {createWorkspaceRestoreProfileV39} from './workspace-restore-schema-v39.ts';
import {hasWorkspaceAudioRoleEvidence,validateWorkspaceAudioRoleRows} from './workspace-audio-role-validation.ts';
import {initializeWorkspaceSchema36,assertNoAssetAnnotationSchema} from './workspace-schema-v36.ts';
import {createWorkspaceRestoreProfileV37} from './workspace-restore-schema-v37.ts';
import {DatabaseSync} from 'node:sqlite';
import type {WorkspaceSchemaReader} from './workspace-schema-profile.ts';
import {initializeWorkspaceSchema26} from './workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from './workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from './workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from './workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from './workspace-schema-v34.ts';
import {createWorkspaceRestoreProfileV35} from './workspace-restore-schema-v35.ts';
import {createWorkspaceRestoreProfileV33} from './workspace-restore-schema-v33.ts';
import {createWorkspaceRestoreProfileV31} from './workspace-restore-schema-v31.ts';
import {validateWorkspaceColourRows} from './workspace-colour-validation.ts';
import {createWorkspaceRestoreProfileV29} from './workspace-restore-schema-v29.ts';
import {createWorkspaceRestoreProfileV27} from './workspace-restore-schema-v27.ts';
import type {WorkspaceRestoreMetadataV27} from './workspace-restore-schema-v27.ts';

export type CurrentWorkspaceRole = 'ordinary-48' | 'restored-49-evidence' | 'ordinary-44' | 'restored-45-evidence' | 'ordinary-through-24' | 'ordinary-26' | 'ordinary-28' | 'ordinary-30' | 'ordinary-32' | 'ordinary-40' | 'ordinary-38' | 'ordinary-36' | 'ordinary-34' | 'restored-25-evidence' | 'restored-27-evidence' | 'restored-29-evidence' | 'restored-31-evidence' | 'restored-33-evidence' | 'restored-35-evidence' | 'restored-37-evidence' | 'restored-39-evidence' | 'restored-41-evidence';
interface Classification {readonly schemaVersion: number; readonly profile: string}
export interface LegacyWorkspaceProfile<T extends object> {
  initializeThrough24(db: DatabaseSync): void;
  detectRestoreEvidence(db: WorkspaceSchemaReader): boolean;
  classify(db: DatabaseSync): Classification;
  install(db: DatabaseSync, metadata: WorkspaceRestoreMetadataV27): T;
  validate(db: DatabaseSync): T;
}
const unsupported = (): never => {throw Object.assign(new Error('Workspace schema role is unsupported'), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});};
const row = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return unsupported();
  return value as Record<string, unknown>;
};
const fold = (value: string): string => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
// The historical marker declaration has no quoted identifiers/string literals.
// Accept only its harmless keyword case, whitespace, comment and IF NOT EXISTS
// variants. Never query an imported virtual/unknown marker table definition.
function markerDeclaration(sql: string): boolean {
  const clean = fold(sql.replace(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\//g, ' '))
    .trim().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1')
    .replace(/^create table if not exists /, 'create table ');
  return clean === 'create table schema_version(version integer primary key)';
}

// One-way fail-closed evidence only: a new operation in the operation CHECK
// cannot be routed into an older missing-marker repair. SQL never grants a role
// or capability. Tokenization ignores comments and preserves literal bytes.
function hasLoudnessApplyOperation(sql: string): boolean {
  const tokens: string[] = [];
  const lexer = /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g;
  for (const match of sql.matchAll(lexer)) {
    const token = match[0];
    if (token.startsWith('--') || token.startsWith('/*')) continue;
    tokens.push(token.startsWith("'") ? token : fold(token));
  }
  const operationIdentifiers = new Set(['operation', '"operation"', '`operation`', '[operation]']);
  for (let index = 0; index + 5 < tokens.length; index++) {
    if (tokens[index] !== 'check' || tokens[index + 1] !== '(' || !operationIdentifiers.has(tokens[index + 2] ?? '') ||
        tokens[index + 3] !== 'in' || tokens[index + 4] !== '(') continue;
    for (let item = index + 5; item < tokens.length && tokens[item] !== ')'; item++) {
      if (tokens[item] === "'timeline.loudness.apply'") return true;
    }
  }
  return false;
}

/** Role-only preflight. Complete historical/new fixed-profile validation is a
 * separate gate; ordinary legacy repair eligibility does not prove that every
 * schema object is known. Numeric ordering never confers restoration authority. */
export function readCurrentWorkspaceRole(db: WorkspaceSchemaReader): CurrentWorkspaceRole {
  let marker = false, restoreEvidence = false, rippleEvidence = false, loudnessApplyEvidence = false, lutEvidence = false, annotationEvidence=false, deletionEvidence=false, count = 0;
  for (const item of db.prepare("SELECT type,CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name,CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql FROM main.sqlite_schema LIMIT 1025").iterate()) {
    const value = row(item);
    if (++count > 1024 || typeof value.name !== 'string' || Buffer.byteLength(value.name) > 128)
      throw Object.assign(new Error('RESTORE_SCHEMA_LIMIT'), {code: 'RESTORE_SCHEMA_LIMIT'});
    const name = fold(value.name);
    if(name.startsWith('project_deletion_')||name==='project_mutation_requests')deletionEvidence=true;
    if (/asset_annotation|annotation_cross|cross_annotation/.test(name)) annotationEvidence=true;
    if (/project_lut_resources|lut_import_requests/.test(name)) lutEvidence = true;
    if (name.startsWith('workspace_restor') || name.startsWith('restore_')) restoreEvidence = true;
    if (name === 'edit_tasks') {
      if (value.type !== 'table' || typeof value.sql !== 'string') return unsupported();
      if (/executionepoch/i.test(value.sql)) restoreEvidence = true;
      if (hasLoudnessApplyOperation(value.sql)) loudnessApplyEvidence = true;
      if (value.sql.includes("'timeline.clip.rippleRemove'")) rippleEvidence = true;
    }
    if (name === 'schema_version') {
      if (marker || value.type !== 'table' || typeof value.sql !== 'string' || !markerDeclaration(value.sql)) return unsupported();
      marker = true;
    }
  }
  if (!marker) {
    if(deletionEvidence)return unsupported();
    if (rippleEvidence || loudnessApplyEvidence || lutEvidence || annotationEvidence) return unsupported();
    return restoreEvidence ? 'restored-25-evidence' : 'ordinary-through-24';
  }
  const extra = db.prepare('SELECT CAST(version AS TEXT) AS version,typeof(version) AS type FROM main.schema_version WHERE version NOT IN (1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24) ORDER BY main.schema_version.version LIMIT 12').all().map(row);
  if (extra.length === 0) {
    if(deletionEvidence)return unsupported();
    if (rippleEvidence || loudnessApplyEvidence || lutEvidence || annotationEvidence) return unsupported();
    return restoreEvidence ? 'restored-25-evidence' : 'ordinary-through-24';
  }
  if (extra.some(value => value.type !== 'integer')) return unsupported();
  if (extra.length === 1 && extra[0]?.version === '25') {
    if (rippleEvidence || loudnessApplyEvidence || lutEvidence || annotationEvidence) return unsupported();
    return 'restored-25-evidence';
  }
  const lifecycleLineage=['26','28','30','32','34','36','38','40','44','48'];
  const ordinary48=extra.length===10&&extra.every((value,index)=>value.version===lifecycleLineage[index]);
  const restored49=extra.length===11&&extra.every((value,index)=>value.version===[...lifecycleLineage,'49'][index]);
  if(ordinary48||restored49){
    const known=db.prepare('SELECT CAST(version AS TEXT) AS version FROM main.schema_version WHERE main.schema_version.version BETWEEN 1 AND 24 ORDER BY main.schema_version.version LIMIT 25').all().map(row);
    if(!deletionEvidence||ordinary48&&restoreEvidence||restored49&&!restoreEvidence||known.length!==24||known.some((value,index)=>value.version!==String(index+1)))return unsupported();
    return ordinary48?'ordinary-48':'restored-49-evidence';
  }
  if(deletionEvidence)return unsupported();
  const ordinary44 = extra.length===9 && extra.every((value,index)=>value.version===['26','28','30','32','34','36','38','40','44'][index]);
  const restored45 = extra.length===10 && extra.every((value,index)=>value.version===['26','28','30','32','34','36','38','40','44','45'][index]);
  const ordinary26 = extra.length === 1 && extra[0]?.version === '26';
  const restored27 = extra.length === 2 && extra[0]?.version === '26' && extra[1]?.version === '27';
  const ordinary28 = extra.length === 2 && extra[0]?.version === '26' && extra[1]?.version === '28';
  const restored29 = extra.length === 3 && extra[0]?.version === '26' && extra[1]?.version === '28' && extra[2]?.version === '29';
  const ordinary30 = extra.length === 3 && extra[0]?.version === '26' && extra[1]?.version === '28' && extra[2]?.version === '30';
  const restored31 = extra.length === 4 && extra[0]?.version === '26' && extra[1]?.version === '28' && extra[2]?.version === '30' && extra[3]?.version === '31';
  const ordinary32 = extra.length === 4 && extra[0]?.version === '26' && extra[1]?.version === '28' && extra[2]?.version === '30' && extra[3]?.version === '32';
  const restored33 = extra.length === 5 && extra[0]?.version === '26' && extra[1]?.version === '28' && extra[2]?.version === '30' && extra[3]?.version === '32' && extra[4]?.version === '33';
  const ordinary34 = extra.length === 5 && extra[0]?.version === '26' && extra[1]?.version === '28' && extra[2]?.version === '30' && extra[3]?.version === '32' && extra[4]?.version === '34';
  const restored35 = extra.length === 6 && extra[0]?.version === '26' && extra[1]?.version === '28' && extra[2]?.version === '30' && extra[3]?.version === '32' && extra[4]?.version === '34' && extra[5]?.version === '35';
  const ordinary36 = extra.length===6 && extra.slice(0,5).every((value,index)=>value.version===['26','28','30','32','34'][index]) && extra[5]?.version==='36';
  const restored37 = extra.length===7 && extra.slice(0,6).every((value,index)=>value.version===['26','28','30','32','34','36'][index]) && extra[6]?.version==='37';
  const ordinary38 = extra.length===7 && extra.every((value,index)=>value.version===['26','28','30','32','34','36','38'][index]);
  const restored39 = extra.length===8 && extra.every((value,index)=>value.version===['26','28','30','32','34','36','38','39'][index]);
  const ordinary40 = extra.length===8 && extra.every((value,index)=>value.version===['26','28','30','32','34','36','38','40'][index]);
  const restored41 = extra.length===9 && extra.every((value,index)=>value.version===['26','28','30','32','34','36','38','40','41'][index]);
  if(annotationEvidence && !ordinary44 && !restored45 && !ordinary40 && !restored41 && !ordinary38 && !restored39 && !ordinary36 && !restored37) return unsupported();
  if (!ordinary44 && !restored45 && !ordinary26 && !restored27 && !ordinary28 && !restored29 && !ordinary30 && !restored31 && !ordinary32 && !restored33 && !ordinary34 && !restored35 && !ordinary36 && !restored37 && !ordinary40 && !restored41 && !ordinary38 && !restored39) return unsupported();
  if ((ordinary26 || restored27) && lutEvidence) return unsupported();
  const known = db.prepare('SELECT CAST(version AS TEXT) AS version FROM main.schema_version WHERE version IN (1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24) ORDER BY main.schema_version.version LIMIT 25').all().map(row);
  if (known.length !== 24 || known.some((value, index) => value.version !== String(index + 1))) return unsupported();
  if ((ordinary26 || ordinary28 || ordinary30 || ordinary32 || ordinary34 || ordinary36 || ordinary38 || ordinary40 || ordinary44) && restoreEvidence) return unsupported();
  return ordinary44 ? 'ordinary-44' : restored45 ? 'restored-45-evidence' : ordinary40 ? 'ordinary-40' : restored41 ? 'restored-41-evidence' : ordinary38 ? 'ordinary-38' : restored39 ? 'restored-39-evidence' : ordinary36 ? 'ordinary-36' : restored37 ? 'restored-37-evidence' : ordinary34 ? 'ordinary-34' : restored35 ? 'restored-35-evidence' : ordinary32 ? 'ordinary-32' : restored33 ? 'restored-33-evidence' : ordinary30 ? 'ordinary-30' : restored31 ? 'restored-31-evidence' : ordinary26 ? 'ordinary-26' : ordinary28 ? 'ordinary-28' : restored29 ? 'restored-29-evidence' : 'restored-27-evidence';
}

function preEnvelopeHistoricalRole(role:CurrentWorkspaceRole): boolean {
  // Fixed capture profiles before schema40 preserved opaque historical receipts
  // byte-for-byte in their restore archive tables; those cells can never carry
  // readable envelope evidence. ordinary-through-24/restored-25 stay strict for
  // current admission as the BLOB admission boundary pins.
  return role==='ordinary-26'||role==='ordinary-28'||role==='ordinary-30'||role==='ordinary-32'||role==='ordinary-34'||role==='ordinary-36'||role==='ordinary-38'
    ||role==='restored-27-evidence'||role==='restored-29-evidence'||role==='restored-31-evidence'||role==='restored-33-evidence'||role==='restored-35-evidence'||role==='restored-37-evidence'||role==='restored-39-evidence';
}
function volumeEnvelopeAdmission(role:CurrentWorkspaceRole) {
  return {allowVolumeEnvelopes:role==='ordinary-40'||role==='restored-41-evidence'||role==='ordinary-44'||role==='restored-45-evidence'||role==='ordinary-48'||role==='restored-49-evidence',
    // Historical ordinary schemas predate envelopes: opaque retained cells are
    // preserved history and cannot grant envelope capability, so read-only
    // classification tolerates them. Restored profiles and current admission
    // keep the strict default and still fail closed.
    allowOpaqueCells:preEnvelopeHistoricalRole(role)};
}
function frozenAdmission(role:CurrentWorkspaceRole) {
  return role==='ordinary-40'||role==='restored-41-evidence'||role==='ordinary-44'||role==='restored-45-evidence'||role==='ordinary-48'||role==='restored-49-evidence'?{frozenEvidenceProfile:'workspace40-restored41' as const}:{};
}
function audioRoleAdmission(role:CurrentWorkspaceRole) {
  return {allowAudioRoles:['ordinary-38','restored-39-evidence','ordinary-40','restored-41-evidence','ordinary-44','restored-45-evidence','ordinary-48','restored-49-evidence'].includes(role),...frozenAdmission(role)};
}
function colourAdmission(role:CurrentWorkspaceRole) {
  return {...frozenAdmission(role),allowColour:['ordinary-30','restored-31-evidence','ordinary-32','restored-33-evidence','ordinary-34','restored-35-evidence','ordinary-36','restored-37-evidence','ordinary-38','restored-39-evidence','ordinary-40','restored-41-evidence','ordinary-44','restored-45-evidence','ordinary-48','restored-49-evidence'].includes(role),
    allowMixedImages:['ordinary-32','restored-33-evidence','ordinary-34','restored-35-evidence','ordinary-36','restored-37-evidence','ordinary-38','restored-39-evidence','ordinary-40','restored-41-evidence','ordinary-44','restored-45-evidence','ordinary-48','restored-49-evidence'].includes(role),
    allowJpegImages:['ordinary-34','restored-35-evidence','ordinary-36','restored-37-evidence','ordinary-38','restored-39-evidence','ordinary-40','restored-41-evidence','ordinary-44','restored-45-evidence','ordinary-48','restored-49-evidence'].includes(role)};
}

/** Read-only row admission for callers which need a migration guard without
 * claiming fixed-catalog restoration capability or mutating the source. */
export function validateCurrentWorkspaceColourProfile(db: DatabaseSync): void {
  const role=readCurrentWorkspaceRole(db);
  validateWorkspaceVolumeEnvelopeRows(db,volumeEnvelopeAdmission(role));
  validateWorkspaceAudioRoleRows(db,audioRoleAdmission(role));
  validateWorkspaceColourRows(db, colourAdmission(role));
}

/** Bound once by existing db wiring. Only application-owned fixed constructors
 * are supplied here; no public DTO may select or replace schema implementations. */
export function createWorkspaceSchemaDispatch<T extends object>(legacy: LegacyWorkspaceProfile<T>) {
  const restored27 = createWorkspaceRestoreProfileV27(legacy.initializeThrough24);
  const restored29 = createWorkspaceRestoreProfileV29(legacy.initializeThrough24);
  const restored31 = createWorkspaceRestoreProfileV31(legacy.initializeThrough24);
  const restored33 = createWorkspaceRestoreProfileV33(legacy.initializeThrough24);
  const restored41 = createWorkspaceRestoreProfileV41(legacy.initializeThrough24);
  const restored49 = createWorkspaceRestoreProfileV49(legacy.initializeThrough24);
  const restored45 = createWorkspaceRestoreProfileV45(legacy.initializeThrough24);
  const restored39 = createWorkspaceRestoreProfileV39(legacy.initializeThrough24);
  const restored37 = createWorkspaceRestoreProfileV37(legacy.initializeThrough24);
  const restored35 = createWorkspaceRestoreProfileV35(legacy.initializeThrough24);
  // Ordinary restarts historically recreated the fixed receipt/retention
  // guards additively. Recreate only missing application-owned triggers/indexes
  // from a freshly constructed ordinary48 catalog, inside one transaction, and
  // require the same strict classifier afterward. Missing tables, changed
  // definitions, extra managed objects or any failed validation still leave the
  // database byte-identical and fail closed.
  let ordinaryProtectionCatalog: readonly {type: string; name: string; table: string; sql: string}[] | undefined;
  const expectedOrdinaryProtections = () => {
    if (ordinaryProtectionCatalog) return ordinaryProtectionCatalog;
    const fresh = new DatabaseSync(':memory:');
    try {
      fresh.exec('PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;');
      legacy.initializeThrough24(fresh);
      initializeWorkspaceSchema26(fresh); initializeWorkspaceSchema28(fresh);
      initializeWorkspaceSchema30(fresh); initializeWorkspaceSchema32(fresh);
      initializeWorkspaceSchema34(fresh); initializeWorkspaceSchema36(fresh);
      initializeWorkspaceSchema38(fresh); initializeWorkspaceSchema40(fresh);
      initializeWorkspaceSchema44(fresh, legacy.initializeThrough24);
      initializeWorkspaceSchema48(fresh, legacy.initializeThrough24);
      ordinaryProtectionCatalog = Object.freeze(fresh.prepare("SELECT type,name,tbl_name AS guardedTable,sql FROM main.sqlite_schema WHERE type IN ('trigger','index') AND sql IS NOT NULL ORDER BY type,name").all().map(value => row(value)).filter(value => typeof value.type === 'string' && typeof value.name === 'string' && typeof value.guardedTable === 'string' && typeof value.sql === 'string').map(value => Object.freeze({type: value.type as string, name: value.name as string, table: value.guardedTable as string, sql: value.sql as string})));
    } finally { fresh.close(); }
    return ordinaryProtectionCatalog;
  };
  const repairMissingOrdinaryProtections = (db: DatabaseSync): boolean => {
    if (db.isTransaction) return false;
    const expected = expectedOrdinaryProtections();
    const existing = new Set(db.prepare("SELECT name FROM main.sqlite_schema WHERE type IN ('trigger','index')").all().map(value => row(value).name));
    const missing = expected.filter(value => !existing.has(value.name));
    if (missing.length === 0) return false;
    const tables = new Set(db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table'").all().map(value => row(value).name));
    if (missing.some(value => !tables.has(value.table))) return false;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const value of missing) db.exec(value.sql as string);
      restored49.classifyWorkspaceSchemaV48V49(db);
      db.exec('COMMIT');
      return true;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      return false;
    }
  };
  const detect = (db: WorkspaceSchemaReader): boolean => {
    const role = readCurrentWorkspaceRole(db);
    if (role === 'ordinary-through-24' || role === 'restored-25-evidence') return legacy.detectRestoreEvidence(db);
    return role === 'restored-49-evidence' || role === 'restored-45-evidence' || role === 'restored-27-evidence' || role === 'restored-29-evidence' || role === 'restored-31-evidence' || role === 'restored-33-evidence' || role === 'restored-35-evidence' || role === 'restored-37-evidence' || role === 'restored-39-evidence' || role === 'restored-41-evidence';
  };
  const classify = (db: DatabaseSync): Classification => {
    const role = readCurrentWorkspaceRole(db);
    validateWorkspaceVolumeEnvelopeRows(db,volumeEnvelopeAdmission(role));
    validateWorkspaceAudioRoleRows(db,audioRoleAdmission(role));
    validateWorkspaceColourRows(db, colourAdmission(role));
    if (role === 'ordinary-48' || role === 'restored-49-evidence') return restored49.classifyWorkspaceSchemaV48V49(db);
    if (role === 'ordinary-44' || role === 'restored-45-evidence') return restored45.classifyWorkspaceSchemaV44V45(db);
    if (role === 'ordinary-40' || role === 'restored-41-evidence') return restored41.classifyWorkspaceSchemaV40V41(db);
    if (role === 'ordinary-38' || role === 'restored-39-evidence') return restored39.classifyWorkspaceSchemaV38V39(db);
    if (role === 'ordinary-36' || role === 'restored-37-evidence') return restored37.classifyWorkspaceSchemaV36V37(db);
    if (role === 'ordinary-34' || role === 'restored-35-evidence') return restored35.classifyWorkspaceSchemaV34V35(db);
    if (role === 'ordinary-32' || role === 'restored-33-evidence') return restored33.classifyWorkspaceSchemaV32V33(db);
    if (role === 'ordinary-30' || role === 'restored-31-evidence') return restored31.classifyWorkspaceSchemaV30V31(db);
    if (role === 'ordinary-28' || role === 'restored-29-evidence') return restored29.classifyWorkspaceSchemaV28V29(db);
    return role === 'ordinary-26' || role === 'restored-27-evidence'
      ? restored27.classifyWorkspaceSchemaV26V27(db) : legacy.classify(db);
  };
  const validateRestore = (db: DatabaseSync) => {
    const role = readCurrentWorkspaceRole(db);
    validateWorkspaceVolumeEnvelopeRows(db,volumeEnvelopeAdmission(role));
    validateWorkspaceAudioRoleRows(db,audioRoleAdmission(role));
    validateWorkspaceColourRows(db, colourAdmission(role));
    if (role === 'restored-49-evidence') return restored49.validateWorkspaceRestoreSchemaV49(db);
    if (role === 'restored-45-evidence') return restored45.validateWorkspaceRestoreSchemaV45(db);
    if (role === 'restored-41-evidence') return restored41.validateWorkspaceRestoreSchemaV41(db);
    if (role === 'restored-39-evidence') {const result=restored39.validateWorkspaceRestoreSchemaV39(db); validateHistoricalRestoreCapture(db,39); return result;}
    if (role === 'restored-37-evidence') {const result=restored37.validateWorkspaceRestoreSchemaV37(db); validateHistoricalRestoreCapture(db,37); return result;}
    if (role === 'restored-35-evidence') {const result=restored35.validateWorkspaceRestoreSchemaV35(db); validateHistoricalRestoreCapture(db,35); return result;}
    if (role === 'restored-33-evidence') {const result=restored33.validateWorkspaceRestoreSchemaV33(db); validateHistoricalRestoreCapture(db,33); return result;}
    if (role === 'restored-31-evidence') {const result=restored31.validateWorkspaceRestoreSchemaV31(db); validateHistoricalRestoreCapture(db,31); return result;}
    if (role === 'restored-25-evidence') {const result=legacy.validate(db); validateHistoricalRestoreCapture(db,25); return result;}
    if (role === 'restored-27-evidence') {const result=restored27.validateWorkspaceRestoreSchemaV27(db); validateHistoricalRestoreCapture(db,27); return result;}
    if (role === 'restored-29-evidence') {const result=restored29.validateWorkspaceRestoreSchemaV29(db); validateHistoricalRestoreCapture(db,29); return result;}
    return unsupported();
  };
  const initialize = (db: DatabaseSync) => {
    const role = readCurrentWorkspaceRole(db);
    if (role === 'ordinary-48') {
      try { restored49.classifyWorkspaceSchemaV48V49(db); return null; }
      catch (strictFailure) {
        // Additive historical safety bootstrap only: missing fixed guards are
        // recreated and the strict catalog must then pass unchanged.
        if (!repairMissingOrdinaryProtections(db)) throw strictFailure;
        restored49.classifyWorkspaceSchemaV48V49(db);
        return null;
      }
    }
    if (role === 'restored-49-evidence') return validateRestore(db);
    if (role === 'ordinary-44') {initializeWorkspaceSchema48(db,legacy.initializeThrough24); return null;}
    if (role === 'restored-45-evidence') return validateRestore(db);
    if (role === 'restored-25-evidence' || role === 'restored-27-evidence' || role === 'restored-29-evidence' || role === 'restored-31-evidence' || role === 'restored-33-evidence' || role === 'restored-35-evidence' || role === 'restored-37-evidence' || role === 'restored-39-evidence' || role === 'restored-41-evidence') return validateRestore(db);
    validateWorkspaceVolumeEnvelopeRows(db,{allowVolumeEnvelopes:role==='ordinary-40'});
    validateWorkspaceAudioRoleRows(db,audioRoleAdmission(role));
    validateWorkspaceColourRows(db, colourAdmission(role));
    if (role === 'ordinary-40') {initializeWorkspaceSchema40(db); initializeWorkspaceSchema44(db,legacy.initializeThrough24); initializeWorkspaceSchema48(db,legacy.initializeThrough24); return null;}
    if(role!=='ordinary-36'&&role!=='ordinary-38')assertNoAssetAnnotationSchema(db);
    if (role === 'ordinary-38' || role === 'ordinary-36') {initializeWorkspaceSchema38(db); initializeWorkspaceSchema40(db); initializeWorkspaceSchema44(db,legacy.initializeThrough24); initializeWorkspaceSchema48(db,legacy.initializeThrough24); return null;}
    if (role === 'ordinary-34') {initializeWorkspaceSchema36(db); initializeWorkspaceSchema38(db); initializeWorkspaceSchema40(db); initializeWorkspaceSchema44(db,legacy.initializeThrough24); initializeWorkspaceSchema48(db,legacy.initializeThrough24); return null;}
    if (role === 'ordinary-32') {initializeWorkspaceSchema34(db); initializeWorkspaceSchema36(db); initializeWorkspaceSchema38(db); initializeWorkspaceSchema40(db); initializeWorkspaceSchema44(db,legacy.initializeThrough24); initializeWorkspaceSchema48(db,legacy.initializeThrough24); return null;}
    if (role === 'ordinary-30') {initializeWorkspaceSchema32(db); initializeWorkspaceSchema34(db); initializeWorkspaceSchema36(db); initializeWorkspaceSchema38(db); initializeWorkspaceSchema40(db); initializeWorkspaceSchema44(db,legacy.initializeThrough24); initializeWorkspaceSchema48(db,legacy.initializeThrough24); return null;}
    if (role === 'ordinary-28') {initializeWorkspaceSchema30(db); initializeWorkspaceSchema32(db); initializeWorkspaceSchema34(db); initializeWorkspaceSchema36(db); initializeWorkspaceSchema38(db); initializeWorkspaceSchema40(db); initializeWorkspaceSchema44(db,legacy.initializeThrough24); initializeWorkspaceSchema48(db,legacy.initializeThrough24); return null;}
    // The28 additive initializer validates the retained26 structures and repairs
    // allowed receipt guards in its own transaction. Do not commit an earlier
    // repair before28 has rejected a conflicting imported LUT object.
    if (role === 'ordinary-26') {initializeWorkspaceSchema28(db); initializeWorkspaceSchema30(db); initializeWorkspaceSchema32(db); initializeWorkspaceSchema34(db); initializeWorkspaceSchema36(db); initializeWorkspaceSchema38(db); initializeWorkspaceSchema40(db); initializeWorkspaceSchema44(db,legacy.initializeThrough24); initializeWorkspaceSchema48(db,legacy.initializeThrough24); return null;}
    // Completed24 enters the strict migration before any historical bootstrap
    // writes. In particular INSERT OR IGNORE still fires BEFORE INSERT
    // triggers, so rerunning the old constructor here is not a read-only check.
    // Role validation above guarantees any existing marker rows are in 1–24;
    // genuine historical gaps/missing markers retain the old repair path.
    const marker = db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='schema_version' COLLATE NOCASE").get();
    const complete24 = marker && db.prepare('SELECT COUNT(*) AS count FROM main.schema_version').get()?.count === 24;
    if (!complete24) legacy.initializeThrough24(db);
    initializeWorkspaceSchema26(db);
    initializeWorkspaceSchema28(db);
    initializeWorkspaceSchema30(db);
    initializeWorkspaceSchema32(db);
    initializeWorkspaceSchema34(db);
    initializeWorkspaceSchema36(db);
    initializeWorkspaceSchema38(db); initializeWorkspaceSchema40(db); initializeWorkspaceSchema44(db,legacy.initializeThrough24); initializeWorkspaceSchema48(db,legacy.initializeThrough24);
    return null;
  };
  const installRestore = (db: DatabaseSync, metadata: WorkspaceRestoreMetadataV27) => {
    const profile = classify(db);
    if (profile.schemaVersion === 24 && profile.profile === 'ordinary') return legacy.install(db, metadata);
    if (profile.schemaVersion === 26 && profile.profile === 'ordinary') return restored27.installWorkspaceRestoreSchemaV27(db, metadata);
    if (profile.schemaVersion === 28 && profile.profile === 'ordinary') return restored29.installWorkspaceRestoreSchemaV29(db, metadata);
    if (profile.schemaVersion === 48 && profile.profile === 'ordinary') return restored49.installWorkspaceRestoreSchemaV49(db, metadata);
    if (profile.schemaVersion === 44 && profile.profile === 'ordinary') return restored45.installWorkspaceRestoreSchemaV45(db, metadata);
    if (profile.schemaVersion === 40 && profile.profile === 'ordinary') return restored41.installWorkspaceRestoreSchemaV41(db, metadata);
    if (profile.schemaVersion === 38 && profile.profile === 'ordinary') return restored39.installWorkspaceRestoreSchemaV39(db, metadata);
    if (profile.schemaVersion === 36 && profile.profile === 'ordinary') return restored37.installWorkspaceRestoreSchemaV37(db, metadata);
    if (profile.schemaVersion === 34 && profile.profile === 'ordinary') return restored35.installWorkspaceRestoreSchemaV35(db, metadata);
    if (profile.schemaVersion === 32 && profile.profile === 'ordinary') return restored33.installWorkspaceRestoreSchemaV33(db, metadata);
    if (profile.schemaVersion === 30 && profile.profile === 'ordinary') return restored31.installWorkspaceRestoreSchemaV31(db, metadata);
    return unsupported();
  };
  return {detect, classify, validateRestore, initialize, installRestore};
}

/** Positive schema-role gate; absence or table-name probing never grants compatibility. */
export function usesAssetAnnotationSchema(db:WorkspaceSchemaReader):boolean{
 const role=readCurrentWorkspaceRole(db);return role==='ordinary-36'||role==='restored-37-evidence'||role==='ordinary-38'||role==='restored-39-evidence'||role==='ordinary-40'||role==='restored-41-evidence'||role==='ordinary-44'||role==='restored-45-evidence'||role==='ordinary-48'||role==='restored-49-evidence';
}

/** Runtime negative capability gate; existing invocation/origin checks still apply. */
export function assertTimelineAudioRoleWorkspace(db:WorkspaceSchemaReader,value:unknown):void {
 if(!hasWorkspaceAudioRoleEvidence(value))return;
 const role=readCurrentWorkspaceRole(db);
 if(role!=='ordinary-38'&&role!=='restored-39-evidence'&&role!=='ordinary-40'&&role!=='restored-41-evidence'&&role!=='ordinary-44'&&role!=='restored-45-evidence'&&role!=='ordinary-48'&&role!=='restored-49-evidence')unsupported();
}
