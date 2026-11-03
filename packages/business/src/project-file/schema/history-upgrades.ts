import type {DatabaseSync} from 'node:sqlite';
import {projectFileError} from '../errors.ts';
import {MIO_SCHEMA,MIO_COUNTER_SCHEMA,MIO_COUNTER_TRIGGERS,initializeMioStorageCounters} from './domains/mio.ts';
import {S0_HISTORY_V2_MANIFEST} from './history-v2-manifest.ts';
import {R1_HISTORY_V3_MANIFEST} from './history-v3-manifest.ts';
import {R1_HISTORY_V4_MANIFEST} from './history-v4-manifest.ts';
import {R2_HISTORY_V5_MANIFEST} from './history-v5-manifest.ts';
import {VERSION_SCHEMA} from './domains/versions.ts';
import {V1B_HISTORY_V6_MANIFEST} from './history-v6-manifest.ts';
import {HISTORY_RESOLUTION_SCHEMA,HISTORY_STATE_METADATA} from './databases.ts';
import type {SchemaManifest} from './manifest-check.ts';
import {LEGACY_MIO_TABLES} from './tables.ts';

/** Internal, reviewed transitions only. Callers cannot supply SQL or nominate
 * an arbitrary old schema. Future history domains add another exact profile. */
export interface HistoryUpgrade {
  readonly from: SchemaManifest;
  readonly toVersion: number;
  readonly clearLegacyProcessRevisions?: boolean;
  readonly apply: (db: DatabaseSync) => void;
}

const CREATE_PREFIX = /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) /;

/** Pre-release data only: S0's development Mio conversations, requests and
 * undo evidence are intentionally discarded. Every other domain is retained.
 * Released formats must use lossless migrations instead of this reset. */
function resetDevelopmentMio(db: DatabaseSync): void {
  if (!db.isTransaction) throw new TypeError('A history upgrade requires the opening transaction');
  // Reverse dependency order; DROP does not run the table's row-retention
  // triggers. Foreign keys remain enabled throughout the reset.
  for (const table of [...LEGACY_MIO_TABLES].reverse()) db.exec(`DROP TABLE main.${table}`);
  for (const sql of MIO_SCHEMA) {
    if (!CREATE_PREFIX.test(sql)) throw new TypeError('Unqualified Mio schema statement');
    db.exec(sql.replace(CREATE_PREFIX, 'CREATE $1 main.'));
  }
  initializeMioStorageCounters(db,'main');
}

/** The already-created R1 record format is retained byte-for-byte. Only the
 * accounting mechanism changes; initialization scans once under the lock. */
function addMioStorageCounters(db:DatabaseSync):void{
 if(!db.isTransaction)throw new TypeError('A history upgrade requires the opening transaction');
 for(const entry of R1_HISTORY_V3_MANIFEST.entries)if(entry.type==='trigger'&&entry.name.startsWith('quota_mio_'))db.exec(`DROP TRIGGER main.${entry.name}`);
 for(const sql of [...MIO_COUNTER_SCHEMA,...MIO_COUNTER_TRIGGERS])db.exec(sql.replace(CREATE_PREFIX,'CREATE $1 main.'));
 initializeMioStorageCounters(db,'main');
}

function addMioRuleWrites(db:DatabaseSync,counters=true):void{
 if(!db.isTransaction)throw new TypeError('A history upgrade requires the opening transaction');
 const target=/^CREATE (?:TABLE mio_rule_writes\b|INDEX mio_rule_writes_\w+\b|TRIGGER \w+ (?:BEFORE|AFTER) (?:INSERT|UPDATE|DELETE) ON mio_rule_writes\b)/u;
 for(const sql of MIO_SCHEMA)if(target.test(sql)&&(counters||!sql.startsWith('CREATE TRIGGER quota_')))db.exec(sql.replace(CREATE_PREFIX,'CREATE $1 main.'));
 // The newly added table is empty. Existing retained data and its counters
 // are unchanged; only later INSERT/UPDATE/DELETE apply a logical delta.
}

function addProjectVersions(db:DatabaseSync):void{
 if(!db.isTransaction)throw new TypeError('A history upgrade requires the opening transaction');
 for(const sql of VERSION_SCHEMA)db.exec(sql.replace(CREATE_PREFIX,'CREATE $1 main.'));
}
/** Retain old bytes while adding an explicitly unknown token. ALTER ADD's
 * stored SQL would not match the canonical manifest, so rebuild these leaves. */
function addContentStamp(db: DatabaseSync, previousVersions: boolean): void {
  if (!db.isTransaction) throw new TypeError('History admission upgrade requires a transaction');
  db.exec('CREATE TEMP TABLE v5_previous_history_state AS SELECT * FROM main.history_state');
  db.exec('DROP TABLE main.history_state');
  for (const sql of HISTORY_STATE_METADATA) db.exec(sql.replace(CREATE_PREFIX, 'CREATE $1 main.'));
  db.exec('INSERT INTO main.history_state(singleton,projectId,seenContentSequence,seenContentToken) SELECT singleton,projectId,seenContentSequence,NULL FROM temp.v5_previous_history_state');
  db.exec('DROP TABLE temp.v5_previous_history_state');
  if (previousVersions) {
    db.exec('CREATE TEMP TABLE v5_previous_versions AS SELECT * FROM main.project_versions');
    db.exec('DROP TABLE main.project_versions');
    for (const sql of VERSION_SCHEMA) if (/^CREATE (?:TABLE project_versions\(|(?:UNIQUE )?INDEX project_versions_|TRIGGER \w+ (?:BEFORE|AFTER) (?:INSERT|UPDATE|DELETE) ON project_versions\b)/u.test(sql)) {
      db.exec(sql.replace(CREATE_PREFIX, 'CREATE $1 main.'));
    }
    db.exec('INSERT INTO main.project_versions SELECT * FROM temp.v5_previous_versions');
    db.exec('DROP TABLE temp.v5_previous_versions');
  }
  db.exec(HISTORY_RESOLUTION_SCHEMA.replace(CREATE_PREFIX, 'CREATE $1 main.'));
}
export const HISTORY_UPGRADES: readonly HistoryUpgrade[] = Object.freeze([
  Object.freeze({from: S0_HISTORY_V2_MANIFEST, toVersion: 7, clearLegacyProcessRevisions:true, apply: (db:DatabaseSync)=>{resetDevelopmentMio(db);addProjectVersions(db);addContentStamp(db,false);}}),
  Object.freeze({from: R1_HISTORY_V3_MANIFEST, toVersion: 7, apply: (db:DatabaseSync)=>{addMioRuleWrites(db,false);addMioStorageCounters(db);addProjectVersions(db);addContentStamp(db,false);}}),
  Object.freeze({from: R1_HISTORY_V4_MANIFEST, toVersion: 7, apply: (db:DatabaseSync)=>{addMioRuleWrites(db);addProjectVersions(db);addContentStamp(db,false);}}),
  Object.freeze({from: R2_HISTORY_V5_MANIFEST, toVersion: 7, apply: (db:DatabaseSync)=>{addProjectVersions(db);addContentStamp(db,false);}}),
  Object.freeze({from: V1B_HISTORY_V6_MANIFEST, toVersion: 7, apply: (db:DatabaseSync)=>addContentStamp(db,true)}),
]);

/** Clears only the four local-process target kinds from an older project.
 * Called under the opening connection's exclusive lock, before TEMP triggers
 * exist. One cleanup advances the content sequence once, regardless of rows. */
export function clearProjectProcessRevisions(db: DatabaseSync, projectId: string): void {
  if (!db.isTransaction) throw new TypeError('Process-revision cleanup requires the opening transaction');
  const where = "projectId=? AND kind IN ('job','export','image_task','frame_task')";
  if (!db.prepare(`SELECT 1 FROM project.agent_task_target_revisions_v2 WHERE ${where} LIMIT 1`).get(projectId)) return;
  const name = 'project_file_sequence_agent_task_target_revisions_v2_delete';
  const row = db.prepare("SELECT sql FROM project.sqlite_master WHERE type='trigger' AND name=?").get(name);
  if (typeof row?.sql !== 'string' || !row.sql.startsWith(`CREATE TRIGGER ${name} `)) {
    throw projectFileError('PROJECT_INVALID', {database: 'project', reason: 'schema', projectId});
  }
  // The project manifest was verified before this transaction. Suspend only
  // its per-row sequence trigger, restoring the exact SQL before validation.
  db.exec(`DROP TRIGGER project.${name}`);
  db.prepare(`DELETE FROM project.agent_task_target_revisions_v2 WHERE ${where}`).run(projectId);
  const changed = db.prepare('UPDATE project.project_file SET contentSequence=contentSequence+1,contentToken=lower(hex(randomblob(16))) WHERE singleton=1 AND contentSequence<?')
    .run(Number.MAX_SAFE_INTEGER);
  if (changed.changes !== 1) throw projectFileError('PROJECT_INVALID', {database: 'project', reason: 'metadata', projectId});
  db.exec(row.sql.replace(/^CREATE TRIGGER /, 'CREATE TRIGGER project.'));
  db.prepare('UPDATE main.history_state SET seenContentSequence=(SELECT contentSequence FROM project.project_file),seenContentToken=(SELECT contentToken FROM project.project_file) WHERE singleton=1 AND projectId=?')
    .run(projectId);
}
