import type {DatabaseSync} from 'node:sqlite';
import {isProjectDatabase} from './project-file/held-files.ts';

/** SQL readers may be exercised independently on bounded fuzz databases. The
 * production admission entry separately requires the exact live kernel. */
export function retainedTimelineCatalog(db:Pick<DatabaseSync,'prepare'>,names:readonly string[]) {
 const schemas=isProjectDatabase(db)?['main','project','cache'] as const:['main'] as const;
 return schemas.flatMap(schema=>db.prepare(`SELECT type,lower(name) AS name,CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql FROM ${schema}.sqlite_schema WHERE name COLLATE NOCASE IN (${names.map(()=>'?').join(',')}) LIMIT 1025`).all(...names));
}
