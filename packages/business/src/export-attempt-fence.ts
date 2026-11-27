import type {DatabaseSync} from 'node:sqlite';

/** A worker-local shortcut for an exact project store connection, whose
 * attachments stay fixed during the attempt. File and cancellation checks
 * remain the caller's responsibility at every checkpoint. */
export function createExportAttemptChunkFence(db: DatabaseSync, checkLive: () => void, checkFull: () => void): () => void {
  const count = db.prepare('SELECT total_changes() AS n');
  count.setReadBigInts(true);
  const schemas = ['main', 'project', 'cache'];
  const data = schemas.map(schema => db.prepare('PRAGMA ' + schema + '.data_version'));
  const structure = [...schemas, 'temp'].map(schema => db.prepare('PRAGMA ' + schema + '.schema_version'));
  const generation = () => [count.get()!.n, ...data.map(sql => sql.get()!.data_version),
    ...structure.map(sql => sql.get()!.schema_version)].join('/');
  let validated: string | undefined;
  return () => {
    checkLive();
    const start = db.isTransaction ? undefined : generation();
    if (start !== undefined && validated === start) return;
    validated = undefined;
    checkFull();
    if (start !== undefined && !db.isTransaction && generation() === start) validated = start;
  };
}
