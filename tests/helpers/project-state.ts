/** Whole-project snapshots for tests that compare what a running server or
 * worker saw with what the test reads after it stops (docs/PROJECT-FILE.md,
 * “测试”). Both functions read on the connection they are given and open none:
 * pass the server's or worker's own connection while it holds the project
 * (inspectProject, a worker's snapshot message), or the test's own connection
 * once the holder has let go (openProjectDatabase). Reading both sides with the
 * same function keeps the two snapshots the same shape. */
import type {DatabaseSync} from 'node:sqlite';
import {schemaObjects} from './project-database.ts';

export interface ProjectState {
  schema: {type: string; name: string; tbl_name: string; sql: string | null}[];
  tables: Record<string, Record<string, unknown>[]>;
}

/** Every schema object, and every table's rows by rowid as plain objects.
 * Objects are found by name in every database on the connection, so the shape
 * survives the switch to the project-file kernel. */
export function readProjectState(db: DatabaseSync): ProjectState {
  const objects = schemaObjects(db);
  return {
    schema: objects.map(({type, name, tbl_name, sql}) => ({type, name, tbl_name, sql})),
    tables: Object.fromEntries(objects.filter(({type}) => type === 'table').map(({name}) =>
      [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all().map(row => ({...row}))])),
  };
}

/** [data_version, total_changes()] of this connection: data_version moves on
 * other connections' commits, total_changes() on this connection's own row
 * changes, rolled-back ones included. */
export function changeMarks(db: DatabaseSync): [number, number] {
  return [Number(db.prepare('PRAGMA data_version').get()!.data_version), Number(db.prepare('SELECT total_changes() AS n').get()!.n)];
}
