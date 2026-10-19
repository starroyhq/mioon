import type {DatabaseSync, SQLInputValue} from 'node:sqlite';

function unsupported(): never {
  throw Object.assign(new Error('Ripple task schema migration is unsupported.'), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
}
const quote = (value: string): string => '"' + value.replaceAll('"', '""') + '"';

/** The caller first proves a complete, fixed ordinary source catalog. This
 * changes only the operation CHECK and marker, preserving retained input bytes,
 * protection SQL and the sequence's original value, rowid and storage class. */
export function migrateRippleTaskSchema(db: DatabaseSync, version: 44 | 46, classifySource: (db: DatabaseSync) => unknown): void {
  if (db.isTransaction || db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
      db.prepare('PRAGMA trusted_schema').get()?.trusted_schema !== 0 ||
      db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get()) unsupported();
  classifySource(db);
  const table = db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name='edit_tasks'").get()?.sql;
  if (typeof table !== 'string' || !table.includes("'timeline.clip.remove'") || table.includes('timeline.clip.rippleRemove')) unsupported();
  const expanded = table.replace("'timeline.clip.remove'", "'timeline.clip.remove','timeline.clip.rippleRemove'");
  const staging = `edit_tasks_ripple_${version}`;
  const creation = expanded.replace(/^(CREATE TABLE(?: IF NOT EXISTS)?\s+)(?:"edit_tasks"|`edit_tasks`|\[edit_tasks\]|edit_tasks)(?=\s*\()/iu, `$1${quote(staging)}`);
  if (creation === expanded || db.prepare('SELECT 1 FROM main.sqlite_schema WHERE name=?').get(staging)) unsupported();
  const columns = db.prepare('PRAGMA main.table_info(edit_tasks)').all().map(row => row.name);
  if (columns.some(column => typeof column !== 'string')) unsupported();
  const selection = (columns as string[]).map(quote).join(',');
  const protections = db.prepare("SELECT sql FROM main.sqlite_schema WHERE tbl_name='edit_tasks' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all();
  if (protections.some(row => typeof row.sql !== 'string')) unsupported();
  const sequenceRead = db.prepare("SELECT rowid,seq,typeof(seq) AS kind FROM main.sqlite_sequence WHERE name='edit_tasks'");
  sequenceRead.setReadBigInts(true);
  const sequences = sequenceRead.all();
  if (sequences.length > 1) unsupported();
  const sequence = sequences[0];
  if (sequence && !(typeof sequence.rowid === 'bigint' &&
      (sequence.kind === 'integer' && typeof sequence.seq === 'bigint' ||
       sequence.kind === 'real' && typeof sequence.seq === 'number' && Number.isSafeInteger(sequence.seq)))) unsupported();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(creation);
    db.exec(`INSERT INTO ${quote(staging)}(${selection}) SELECT ${selection} FROM main.edit_tasks`);
    if (db.prepare(`SELECT 1 FROM (SELECT ${selection} FROM main.edit_tasks EXCEPT SELECT ${selection} FROM ${quote(staging)}) LIMIT 1`).get()) unsupported();
    db.exec(`DROP TABLE main.edit_tasks; ALTER TABLE ${quote(staging)} RENAME TO edit_tasks;`);
    for (const row of protections) db.exec(row.sql as string);
    db.prepare("DELETE FROM main.sqlite_sequence WHERE name='edit_tasks'").run();
    if (sequence) db.prepare("INSERT INTO main.sqlite_sequence(rowid,name,seq) VALUES(?,'edit_tasks',?)")
      .run(sequence.rowid as SQLInputValue, sequence.seq as SQLInputValue);
    db.prepare('INSERT INTO main.schema_version(version) VALUES(?)').run(version);
    if (db.prepare('PRAGMA main.foreign_key_check').get()) unsupported();
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
