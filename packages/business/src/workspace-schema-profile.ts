// A role preflight, not proof that a complete workspace schema is supported.
// Ordinary startup deliberately keeps its existing missing-marker repair path.
// New ordinary and restored profiles must be explicitly added in a later,
// separately reviewed migration; numeric ordering does not imply either role.
export type WorkspaceSchemaMarkerRole = 'ordinary-through-24' | 'restored-25-evidence';

export interface WorkspaceSchemaReader {
  prepare(sql: string): {
    all(): unknown[];
    iterate(): Iterable<unknown>;
  };
}

function unsupported(): never {
  throw Object.assign(new Error('Schema markers are incomplete or unsupported'), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
}

function row(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return unsupported();
  return value as Record<string, unknown>;
}

// The INTEGER PRIMARY KEY marker table has already been structurally checked
// by the caller. Known legacy gaps remain eligible for the old repair code.
// Read at most two exceptional rows, rather than scanning/materializing an
// unbounded imported marker table. main qualification defeats TEMP shadowing.
export function inspectWorkspaceSchemaMarkerRole(db: WorkspaceSchemaReader): WorkspaceSchemaMarkerRole {
  const exceptional = db.prepare(`SELECT version,typeof(version) AS type FROM main.schema_version
    WHERE version NOT IN (1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24) LIMIT 2`).all();
  if (exceptional.length === 0) return 'ordinary-through-24';
  if (exceptional.length !== 1) return unsupported();
  const value = row(exceptional[0]);
  if (value.type !== 'integer' || value.version !== 25) return unsupported();
  return 'restored-25-evidence';
}

export function detectFixedWorkspaceRestoreEvidence(
  db: WorkspaceSchemaReader,
  normalizeSql: (sql: string) => string,
  schemaObjects: number,
): boolean {
  let count = 0;
  for (const value of db.prepare(`SELECT type,CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name,CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql FROM main.sqlite_schema LIMIT ${schemaObjects + 1}`).iterate()) {
    const object = row(value);
    if (++count > schemaObjects || typeof object.name !== 'string' || Buffer.byteLength(object.name) > 128) {
      throw Object.assign(new Error('RESTORE_SCHEMA_LIMIT'), {code: 'RESTORE_SCHEMA_LIMIT'});
    }
    // SQLite identifiers are ASCII case insensitive, including imported DDL.
    const name = object.name.replace(/[A-Z]/g, letter => letter.toLowerCase());
    if (name.startsWith('workspace_restor') || name.startsWith('restore_')) return true;
    if (name === 'edit_tasks') {
      if (object.type !== 'table' || typeof object.sql !== 'string') return unsupported();
      if (/executionepoch/i.test(object.sql)) return true;
    }
    if (name !== 'schema_version') continue;
    if (object.type !== 'table' || typeof object.sql !== 'string') return unsupported();
    if (normalizeSql(object.sql) !== normalizeSql('CREATE TABLE schema_version(version INTEGER PRIMARY KEY)')) return unsupported();
    if (inspectWorkspaceSchemaMarkerRole(db) === 'restored-25-evidence') return true;
  }
  return false;
}
