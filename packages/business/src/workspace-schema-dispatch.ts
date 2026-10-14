import type {DatabaseSync} from 'node:sqlite';
import type {WorkspaceSchemaReader} from './workspace-schema-profile.ts';
import {initializeWorkspaceSchema26} from './workspace-schema-v26.ts';
import {createWorkspaceRestoreProfileV27} from './workspace-restore-schema-v27.ts';
import type {WorkspaceRestoreMetadataV27} from './workspace-restore-schema-v27.ts';

export type CurrentWorkspaceRole = 'ordinary-through-24' | 'ordinary-26' | 'restored-25-evidence' | 'restored-27-evidence';
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
  let marker = false, restoreEvidence = false, loudnessApplyEvidence = false, count = 0;
  for (const item of db.prepare("SELECT type,CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name,CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql FROM main.sqlite_schema LIMIT 1025").iterate()) {
    const value = row(item);
    if (++count > 1024 || typeof value.name !== 'string' || Buffer.byteLength(value.name) > 128)
      throw Object.assign(new Error('RESTORE_SCHEMA_LIMIT'), {code: 'RESTORE_SCHEMA_LIMIT'});
    const name = fold(value.name);
    if (name.startsWith('workspace_restor') || name.startsWith('restore_')) restoreEvidence = true;
    if (name === 'edit_tasks') {
      if (value.type !== 'table' || typeof value.sql !== 'string') return unsupported();
      if (/executionepoch/i.test(value.sql)) restoreEvidence = true;
      if (hasLoudnessApplyOperation(value.sql)) loudnessApplyEvidence = true;
    }
    if (name === 'schema_version') {
      if (marker || value.type !== 'table' || typeof value.sql !== 'string' || !markerDeclaration(value.sql)) return unsupported();
      marker = true;
    }
  }
  if (!marker) {
    if (loudnessApplyEvidence) return unsupported();
    return restoreEvidence ? 'restored-25-evidence' : 'ordinary-through-24';
  }
  const extra = db.prepare('SELECT CAST(version AS TEXT) AS version,typeof(version) AS type FROM main.schema_version WHERE version NOT IN (1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24) ORDER BY main.schema_version.version LIMIT 3').all().map(row);
  if (extra.length === 0) {
    if (loudnessApplyEvidence) return unsupported();
    return restoreEvidence ? 'restored-25-evidence' : 'ordinary-through-24';
  }
  if (extra.some(value => value.type !== 'integer')) return unsupported();
  if (extra.length === 1 && extra[0]?.version === '25') {
    if (loudnessApplyEvidence) return unsupported();
    return 'restored-25-evidence';
  }
  const ordinary26 = extra.length === 1 && extra[0]?.version === '26';
  const restored27 = extra.length === 2 && extra[0]?.version === '26' && extra[1]?.version === '27';
  if (!ordinary26 && !restored27) return unsupported();
  const known = db.prepare('SELECT CAST(version AS TEXT) AS version FROM main.schema_version WHERE version IN (1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24) ORDER BY main.schema_version.version LIMIT 25').all().map(row);
  if (known.length !== 24 || known.some((value, index) => value.version !== String(index + 1))) return unsupported();
  if (ordinary26 && restoreEvidence) return unsupported();
  return ordinary26 ? 'ordinary-26' : 'restored-27-evidence';
}

/** Bound once by existing db wiring. Only application-owned fixed constructors
 * are supplied here; no public DTO may select or replace schema implementations. */
export function createWorkspaceSchemaDispatch<T extends object>(legacy: LegacyWorkspaceProfile<T>) {
  const restored27 = createWorkspaceRestoreProfileV27(legacy.initializeThrough24);
  const detect = (db: WorkspaceSchemaReader): boolean => {
    const role = readCurrentWorkspaceRole(db);
    if (role === 'ordinary-through-24' || role === 'restored-25-evidence') return legacy.detectRestoreEvidence(db);
    return role === 'restored-27-evidence';
  };
  const classify = (db: DatabaseSync): Classification => {
    const role = readCurrentWorkspaceRole(db);
    return role === 'ordinary-26' || role === 'restored-27-evidence'
      ? restored27.classifyWorkspaceSchemaV26V27(db) : legacy.classify(db);
  };
  const validateRestore = (db: DatabaseSync) => {
    const role = readCurrentWorkspaceRole(db);
    if (role === 'restored-25-evidence') return legacy.validate(db);
    if (role === 'restored-27-evidence') return restored27.validateWorkspaceRestoreSchemaV27(db);
    return unsupported();
  };
  const initialize = (db: DatabaseSync) => {
    const role = readCurrentWorkspaceRole(db);
    if (role === 'restored-25-evidence' || role === 'restored-27-evidence') return validateRestore(db);
    if (role === 'ordinary-26') {initializeWorkspaceSchema26(db); return null;}
    // Completed24 enters the strict migration before any historical bootstrap
    // writes. In particular INSERT OR IGNORE still fires BEFORE INSERT
    // triggers, so rerunning the old constructor here is not a read-only check.
    // Role validation above guarantees any existing marker rows are in 1–24;
    // genuine historical gaps/missing markers retain the old repair path.
    const marker = db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='schema_version' COLLATE NOCASE").get();
    const complete24 = marker && db.prepare('SELECT COUNT(*) AS count FROM main.schema_version').get()?.count === 24;
    if (!complete24) legacy.initializeThrough24(db);
    initializeWorkspaceSchema26(db);
    return null;
  };
  const installRestore = (db: DatabaseSync, metadata: WorkspaceRestoreMetadataV27) => {
    const profile = classify(db);
    if (profile.schemaVersion === 24 && profile.profile === 'ordinary') return legacy.install(db, metadata);
    if (profile.schemaVersion === 26 && profile.profile === 'ordinary') return restored27.installWorkspaceRestoreSchemaV27(db, metadata);
    return unsupported();
  };
  return {detect, classify, validateRestore, initialize, installRestore};
}
