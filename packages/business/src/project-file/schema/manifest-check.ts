import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

/** One `sqlite_master` row of a database: its kind, name, owning table and the
 * SHA-256 of its stored SQL (the empty string for automatic indexes). */
export interface ManifestEntry {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sha256: string;
}

/** The expected structure of one database at one schema version. */
export interface SchemaManifest {
  readonly version: number;
  readonly entries: readonly ManifestEntry[];
}

/** Differences between two manifests, each item written as `type:name`. */
export interface ManifestDifferences {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly changed: readonly string[];
}

const byTypeAndName = (a: ManifestEntry, b: ManifestEntry): number =>
  a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Reads every `sqlite_master` row of `schema` (including automatic indexes and
 * `sqlite_sequence`), sorted by type, then name. */
export function readSchemaManifest(db: DatabaseSync, schema: string): ManifestEntry[] {
  const rows = db.prepare(`SELECT type,name,tbl_name,sql FROM "${schema.replaceAll('"', '""')}".sqlite_master`).all();
  return rows.map(row => ({
    type: String(row.type),
    name: String(row.name),
    tbl_name: String(row.tbl_name),
    sha256: createHash('sha256').update(typeof row.sql === 'string' ? row.sql : '', 'utf8').digest('hex'),
  })).sort(byTypeAndName);
}

/** Compares an actual manifest with the expected one. */
export function compareManifest(actual: readonly ManifestEntry[], expected: readonly ManifestEntry[]): ManifestDifferences {
  const key = (entry: ManifestEntry): string => `${entry.type}:${entry.name}`;
  const actualByKey = new Map(actual.map(entry => [key(entry), entry]));
  const expectedByKey = new Map(expected.map(entry => [key(entry), entry]));
  const missing: string[] = [], unexpected: string[] = [], changed: string[] = [];
  for (const [name, entry] of expectedByKey) {
    const found = actualByKey.get(name);
    if (!found) missing.push(name);
    else if (found.tbl_name !== entry.tbl_name || found.sha256 !== entry.sha256) changed.push(name);
  }
  for (const name of actualByKey.keys()) if (!expectedByKey.has(name)) unexpected.push(name);
  return {missing: missing.sort(), unexpected: unexpected.sort(), changed: changed.sort()};
}
