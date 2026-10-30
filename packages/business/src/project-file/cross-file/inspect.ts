import type {DatabaseSync} from 'node:sqlite';
import {PROJECT_DATABASE_NAMES} from '../../../../contracts/src/project-file.ts';
import {relationConstraintName} from './install.ts';
import {CROSS_FILE_RELATIONS} from './relations.ts';

/** One `sqlite_master` row of a database on the connection, with its schema
 * name (`main`, `temp`, `project`, `cache`). */
export interface SchemaObject {
  readonly schema: string;
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

/** A row whose parent row is missing. `constraint` is `fk:<id>` (the id from
 * PRAGMA foreign_key_check) for a foreign key inside one database and
 * `project_file_fk_<NN>` for an emulated cross-file relation. */
export interface ForeignKeyViolation {
  readonly schema: string;
  readonly table: string;
  readonly rowid: number | null;
  readonly parent: string;
  readonly parentSchema: string;
  readonly constraint: string;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** The structure of every database on the connection in PRAGMA database_list
 * order, each sorted by type and name. `temp` holds the connection-level
 * triggers, including the target-revision triggers of process tables. */
export function schemaObjects(db: DatabaseSync): SchemaObject[] {
  const objects: SchemaObject[] = [];
  for (const database of db.prepare('PRAGMA database_list').all()) {
    const schema = String(database.name);
    for (const row of db.prepare(`SELECT type,name,tbl_name,sql FROM ${quote(schema)}.sqlite_master ORDER BY type,name`).all()) {
      objects.push({schema, type: String(row.type), name: String(row.name), tbl_name: String(row.tbl_name), sql: typeof row.sql === 'string' ? row.sql : null});
    }
  }
  return objects;
}

/** Every row without its parent: SQLite's foreign_key_check of each of the three
 * databases (the unqualified pragma would check main only), then a scan of every
 * emulated cross-file relation. */
export function foreignKeyCheck(db: DatabaseSync): ForeignKeyViolation[] {
  const violations: ForeignKeyViolation[] = [];
  for (const schema of [PROJECT_DATABASE_NAMES.history, PROJECT_DATABASE_NAMES.project, PROJECT_DATABASE_NAMES.cache]) {
    for (const row of db.prepare(`PRAGMA ${quote(schema)}.foreign_key_check`).all()) {
      violations.push({schema, table: String(row.table), rowid: row.rowid === null ? null : Number(row.rowid), parent: String(row.parent), parentSchema: schema, constraint: `fk:${String(row.fkid)}`});
    }
  }
  for (const relation of CROSS_FILE_RELATIONS) {
    const {child, parent} = relation;
    const keySet = child.columns.map(column => `c.${quote(column)} IS NOT NULL`).join(' AND ');
    const matches = parent.columns.map((column, i) => `p.${quote(column)}=c.${quote(child.columns[i]!)}`).join(' AND ');
    const orphans = db.prepare(`SELECT c.rowid AS rowid FROM ${quote(child.schema)}.${quote(child.table)} AS c WHERE ${keySet} AND NOT EXISTS(SELECT 1 FROM ${quote(parent.schema)}.${quote(parent.table)} AS p WHERE ${matches}) ORDER BY c.rowid`).all();
    for (const row of orphans) {
      violations.push({schema: child.schema, table: child.table, rowid: Number(row.rowid), parent: parent.table, parentSchema: parent.schema, constraint: relationConstraintName(relation)});
    }
  }
  return violations;
}
