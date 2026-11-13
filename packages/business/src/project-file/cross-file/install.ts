import type {DatabaseSync} from 'node:sqlite';
import {PROJECT_DATABASE_NAMES} from '../../../../contracts/src/project-file.ts';
import {CONVERTED_TEMP_TRIGGERS} from './converted-triggers.ts';
import {CROSS_FILE_RELATIONS, FORMAT4_CROSS_FILE_RELATIONS} from './relations.ts';
import type {CrossFileRelation} from './relations.ts';
import {installRestoreScopeFunction} from './restore-admission.ts';

/** SQLite's own foreign-key message. The emulation raises it with RAISE(ABORT),
 * so the error code is SQLITE_CONSTRAINT_TRIGGER (1811) instead of
 * SQLITE_CONSTRAINT_FOREIGNKEY (787). */
export const FOREIGN_KEY_MESSAGE = 'FOREIGN KEY constraint failed';

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Names to use instead of a relation's own tables and schemas, so tests can put
 * the same constraint on stand-in tables. */
export interface RelationTriggerOverrides {
  readonly child?: {readonly schema?: string; readonly table?: string};
  readonly parent?: {readonly schema?: string; readonly table?: string};
}

/** `project_file_fk_07`: the prefix of a relation's four triggers and the
 * constraint name foreignKeyCheck reports for it. */
export function relationConstraintName(relation: CrossFileRelation): string {
  return `project_file_fk_${String(relation.index).padStart(2, '0')}`;
}

/** The four connection-level triggers that emulate one NO ACTION foreign key
 * across files. Inserting a child row, or setting one of its key columns, needs
 * the parent row; a referenced parent row cannot be deleted or get another key.
 * A child key with a NULL column is not checked (MATCH SIMPLE). Every check is
 * immediate, also for the two keys that format 72 declares DEFERRABLE INITIALLY
 * DEFERRED. */
export function relationTriggerStatements(relation: CrossFileRelation, overrides: RelationTriggerOverrides = {}): readonly string[] {
  const name = relationConstraintName(relation);
  const child = `${quote(overrides.child?.schema ?? relation.child.schema)}.${quote(overrides.child?.table ?? relation.child.table)}`;
  const parent = `${quote(overrides.parent?.schema ?? relation.parent.schema)}.${quote(overrides.parent?.table ?? relation.parent.table)}`;
  const childColumns = relation.child.columns.map(quote), parentColumns = relation.parent.columns.map(quote);
  if (childColumns.length === 0 || childColumns.length !== parentColumns.length) throw new Error(`Relation ${name} has mismatched key columns`);
  const childKeySet = childColumns.map(column => `NEW.${column} IS NOT NULL`).join(' AND ');
  const parentMissing = `NOT EXISTS(SELECT 1 FROM ${parent} WHERE ${parentColumns.map((column, i) => `${column}=NEW.${childColumns[i]!}`).join(' AND ')})`;
  const referenced = `EXISTS(SELECT 1 FROM ${child} WHERE ${childColumns.map((column, i) => `${column}=OLD.${parentColumns[i]!}`).join(' AND ')})`;
  const keyChanged = parentColumns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ');
  const fail = `BEGIN SELECT RAISE(ABORT,'${FOREIGN_KEY_MESSAGE}');END`;
  return Object.freeze([
    `CREATE TEMP TRIGGER ${name}_child_insert BEFORE INSERT ON ${child} WHEN ${childKeySet} AND ${parentMissing} ${fail}`,
    `CREATE TEMP TRIGGER ${name}_child_update BEFORE UPDATE OF ${childColumns.join(',')} ON ${child} WHEN ${childKeySet} AND ${parentMissing} ${fail}`,
    `CREATE TEMP TRIGGER ${name}_parent_delete BEFORE DELETE ON ${parent} WHEN ${referenced} ${fail}`,
    `CREATE TEMP TRIGGER ${name}_parent_update BEFORE UPDATE OF ${parentColumns.join(',')} ON ${parent} WHEN (${keyChanged}) AND ${referenced} ${fail}`,
  ]);
}

/** Copies every new content sequence of the project file into the local records,
 * in the same transaction. */
export const SEEN_SEQUENCE_TRIGGER = `CREATE TEMP TRIGGER project_file_seen_sequence AFTER UPDATE OF contentSequence,contentToken ON ${PROJECT_DATABASE_NAMES.project}.project_file WHEN (SELECT seenContentSequence FROM history_state)=OLD.contentSequence AND (SELECT seenContentToken FROM history_state)=OLD.contentToken BEGIN UPDATE history_state SET seenContentSequence=NEW.contentSequence,seenContentToken=NEW.contentToken;END`;

const triggerStatements = (relations: readonly CrossFileRelation[]): readonly string[] => Object.freeze([
  ...CONVERTED_TEMP_TRIGGERS.map(trigger => trigger.sql), ...relations.flatMap(relation => relationTriggerStatements(relation)), SEEN_SEQUENCE_TRIGGER,
]);
const STATEMENTS = triggerStatements(CROSS_FILE_RELATIONS);
const FORMAT4_STATEMENTS = triggerStatements(FORMAT4_CROSS_FILE_RELATIONS);

/** Every connection-level trigger of the kernel in creation order: the format-72
 * triggers that cross files, four per cross-file relation, then the
 * content-sequence copy. */
export function crossFileTriggerStatements(format4 = false): readonly string[] {
  return format4 ? FORMAT4_STATEMENTS : STATEMENTS;
}

const CREATE_TEMP_TRIGGER = /^CREATE TEMP TRIGGER (\w+) /;
/** Name and the text SQLite stores in temp.sqlite_master (it drops TEMP). */
const storedTriggers = (statements: readonly string[]): ReadonlyMap<string, string> => new Map(statements.map(sql => {
  const match = CREATE_TEMP_TRIGGER.exec(sql);
  if (!match) throw new Error(`Not a TEMP trigger: ${sql.slice(0, 60)}`);
  return [match[1]!, `CREATE TRIGGER ${sql.slice('CREATE TEMP TRIGGER '.length)}`] as const;
}));
const EXPECTED = storedTriggers(STATEMENTS);
const EXPECTED_FORMAT4 = storedTriggers(FORMAT4_STATEMENTS);
const SAVEPOINT = 'project_file_triggers';
const DATABASES = [PROJECT_DATABASE_NAMES.history, PROJECT_DATABASE_NAMES.project, PROJECT_DATABASE_NAMES.cache] as const;

const listed = (names: readonly string[]): string => names.length > 5 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', ');

/** Creates the kernel's connection-level triggers once the local records are
 * main and the project file and the cache are attached. Returns without changes
 * when exactly these triggers already exist; throws when only some of them, or
 * other TEMP triggers, exist. */
export function installCrossFileTriggers(db: DatabaseSync, format4 = false): void {
  const expected = format4 ? EXPECTED_FORMAT4 : EXPECTED;
  installRestoreScopeFunction(db);
  const attached = new Set(db.prepare('PRAGMA database_list').all().map(row => String(row.name)));
  const absent = DATABASES.filter(schema => !attached.has(schema));
  if (absent.length) throw new Error(`Cross-file triggers need the ${absent.join(', ')} database attached`);
  // Unqualified table names resolve to temp first: a temp table or view with a
  // project table's name would take over the trigger bodies' write targets.
  const tables = new Set<string>();
  for (const schema of DATABASES) {
    for (const row of db.prepare(`SELECT name FROM ${quote(schema)}.sqlite_master WHERE type='table'`).all()) tables.add(String(row.name).toLowerCase());
  }
  const shadowing = db.prepare("SELECT name FROM temp.sqlite_master WHERE type IN ('table','view')").all().map(row => String(row.name)).filter(name => tables.has(name.toLowerCase()));
  if (shadowing.length) throw new Error(`Temp objects shadow project tables: ${listed(shadowing)}`);
  const existing = db.prepare("SELECT name,sql FROM temp.sqlite_master WHERE type='trigger'").all();
  if (existing.length) {
    const found = new Map(existing.map(row => [String(row.name), String(row.sql)] as const));
    const missing = [...expected.keys()].filter(name => !found.has(name));
    const unexpected = [...found.keys()].filter(name => !expected.has(name));
    const changed = [...expected].filter(([name, sql]) => found.has(name) && found.get(name) !== sql).map(([name]) => name);
    if (missing.length === 0 && unexpected.length === 0 && changed.length === 0) return;
    throw new Error(`Connection-level triggers are partly installed: ${[
      missing.length ? `missing ${listed(missing)}` : '', unexpected.length ? `unexpected ${listed(unexpected)}` : '', changed.length ? `changed ${listed(changed)}` : '',
    ].filter(Boolean).join('; ')}`);
  }
  db.exec(`SAVEPOINT ${SAVEPOINT}`);
  try {
    for (const sql of crossFileTriggerStatements(format4)) db.exec(sql);
    db.exec(`RELEASE ${SAVEPOINT}`);
  } catch (error) {
    if (db.isTransaction) {
      db.exec(`ROLLBACK TO ${SAVEPOINT}`);
      db.exec(`RELEASE ${SAVEPOINT}`);
    }
    throw error;
  }
}

/** Extra immutable connection guards for recovery sessions. query_only also
 * blocks DDL; these triggers keep raw DML forbidden if a caller toggles it. */
export function installDivergedWriteGuards(db: DatabaseSync): void {
  for (const schema of ['main', 'project'] as const) {
    const tables = db.prepare(`SELECT name FROM ${schema}.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all();
    for (const {name} of tables) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const target = quote(String(name)), guard = quote(`project_history_readonly_${schema}_${String(name)}_${operation.toLowerCase()}`);
      db.exec(`CREATE TEMP TRIGGER ${guard} BEFORE ${operation} ON ${schema}.${target} BEGIN SELECT RAISE(ABORT,'PROJECT_HISTORY_DIVERGED');END`);
    }
  }
  db.exec('PRAGMA query_only=ON');
}
