import type {DatabaseSync} from 'node:sqlite';
import {initializeWorkspaceSchema42, classifyWorkspaceSchema42} from './workspace-schema-v42.ts';
import {classifyWorkspaceSchemaV46V47} from './workspace-restore-schema-v47.ts';
import {migrateRippleTaskSchema} from './workspace-ripple-schema.ts';

/** Explicit opacity+ripple branch. Ordinary44 never invokes this constructor. */
export function initializeWorkspaceSchema46(db: DatabaseSync): void {
  if (!db.prepare('SELECT 1 FROM main.sqlite_schema LIMIT 1').get()) initializeWorkspaceSchema42(db);
  const marked = db.prepare('SELECT 1 FROM main.schema_version WHERE version=46').get();
  if (marked) {classifyWorkspaceSchema46(db);return;}
  migrateRippleTaskSchema(db, 46, classifyWorkspaceSchema42);
}
export function classifyWorkspaceSchema46(db: DatabaseSync): Readonly<{schemaVersion:46;profile:'ordinary'}> {
  const profile = classifyWorkspaceSchemaV46V47(db);
  if (profile.schemaVersion !== 46 || profile.profile !== 'ordinary')
    throw Object.assign(new Error('Expected explicit opacity+ripple ordinary46.'), {code:'RESTORE_SCHEMA_UNSUPPORTED'});
  return profile;
}
