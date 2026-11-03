import type {DatabaseSync} from 'node:sqlite';

// Pure connection-local SQL support. Schema construction/probes import this
// leaf without opening a project, importing a store or loading its manifest.
const registered = new WeakSet<DatabaseSync>();
const active = new WeakMap<DatabaseSync, {rows: ReadonlySet<string>; owner: () => boolean}>();
export function restoreAdmissionKey(table: string, text: string): string {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Restore admission needs one complete SQL row');
  return `${table}\0${JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, (value as Record<string,unknown>)[key]])))}`;
}
export function installRestoreScopeFunction(db: DatabaseSync): void {
  if (registered.has(db)) return;
  db.function('mioon_restore_row_allowed', (table, text) => {
    const scope = active.get(db);
    if (!scope || !db.isTransaction || !scope.owner() || typeof table !== 'string' || typeof text !== 'string') return 0;
    try {return scope.rows.has(restoreAdmissionKey(table,text)) ? 1 : 0;} catch {return 0;}
  });
  registered.add(db);
}
/** The business capability validates the real store and complete plan first;
 * this leaf only carries their exact row tokens during one synchronous call. */
export function withRestoreAdmissionRowsInside<T>(db: DatabaseSync, rows: ReadonlySet<string>, owner: () => boolean, run: () => T): T {
  if (!db.isTransaction || active.has(db) || !owner()) throw new TypeError('Restore row scope requires one owned transaction');
  installRestoreScopeFunction(db);
  active.set(db,{rows,owner});
  try {return run();} finally {active.delete(db);}
}
