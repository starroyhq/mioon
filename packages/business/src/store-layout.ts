import type {DatabaseSync} from 'node:sqlite';
import {isProjectDatabase} from './project-file/connection.ts';
import {isProjectStore} from './project-file/store.ts';
import {SCHEMA_MANIFEST} from './project-file/schema/manifest.ts';

/** Layout comes from the live kernel registry, never marker tables, attached
 * schema names or caller-supplied store fields. */
export function isProjectLayout(db: unknown): boolean {
  return isProjectDatabase(db);
}

type StoreSchema = 'main' | 'project' | 'cache';
const projectTables = new Map<string, StoreSchema>();
for (const [kind, schema] of [['history', 'main'], ['project', 'project'], ['cache', 'cache']] as const) {
  // Shared names such as schema_version resolve to main first, as an
  // unqualified SQLite query does on this attachment order.
  for (const entry of SCHEMA_MANIFEST[kind].entries) if (entry.type === 'table' && !projectTables.has(entry.name)) projectTables.set(entry.name, schema);
}

/** Kernel opens validated these manifests. Legacy callers still inspect the
 * actual main schema; this never grants or substitutes a legacy role. */
export function storeTableSchema(db: DatabaseSync, table: string): StoreSchema | null {
  if (isProjectLayout(db)) return projectTables.get(table) ?? null;
  return db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(table) ? 'main' : null;
}
export function hasStoreTable(db: DatabaseSync, table: string): boolean {
  return storeTableSchema(db, table) !== null;
}

export interface StoreDirectories {
  readonly projectDir: string;
  readonly localDir: string;
  readonly cacheDir: string;
  readonly tempDir: string;
}
/** Legacy modules retain their existing subdirectories below root. Copied
 * fields cannot manufacture a kernel store's separate directory authority. */
export function storeDirectories(store: {readonly root: string}): StoreDirectories {
  if (isProjectStore(store)) {
    const {projectDir, localDir, cacheDir, tempDir} = store;
    return {projectDir, localDir, cacheDir, tempDir};
  }
  return {projectDir: store.root, localDir: store.root, cacheDir: store.root, tempDir: store.root};
}
