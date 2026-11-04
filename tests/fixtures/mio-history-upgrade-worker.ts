import {writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {openProjectConnection} from '../../packages/business/src/project-file/connection.ts';
import {HISTORY_SCHEMA_VERSION} from '../../packages/business/src/project-file/schema/databases.ts';
const CURRENT_VERSION_WRITE = `UPDATE main.schema_version SET version=${HISTORY_SCHEMA_VERSION}`;

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const point = required('MIO_UPGRADE_POINT');
const barrier = (): never => {
  writeFileSync(required('MIO_UPGRADE_MARKER'), 'ready');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('The parent must kill the worker at the barrier');
};
if (point === 'hold-old') {
  const history = new DatabaseSync(`${required('MIO_UPGRADE_LOCAL')}/history.db`);
  history.exec('BEGIN EXCLUSIVE');
  barrier();
}
const exec = DatabaseSync.prototype.exec;
let upgrading = false;
DatabaseSync.prototype.exec = function(this: DatabaseSync, sql: string): void {
  if (!upgrading && (sql.startsWith('DROP TABLE main.history_state')||sql.startsWith('DROP TABLE main.agent_task_')||sql.startsWith('DROP TRIGGER main.quota_mio_')||sql.startsWith('CREATE TABLE main.mio_rule_writes(')||sql.startsWith('CREATE TABLE main.project_version_blobs('))) {
    // Force the schema reset to spill dirty pages before COMMIT, so a kill
    // exercises journal recovery rather than only discarding an in-memory DDL.
    exec.call(this, 'PRAGMA main.cache_size=8; PRAGMA project.cache_size=8; PRAGMA cache_spill=ON');
  }
  if(point==='counter-after-init'&&sql===CURRENT_VERSION_WRITE)barrier();
  if(point==='versions-before-version'&&sql===CURRENT_VERSION_WRITE)barrier();
  exec.call(this, sql);
  if (sql.startsWith('DROP TABLE main.history_state')||sql.startsWith('DROP TABLE main.agent_task_')||sql.startsWith('DROP TRIGGER main.quota_mio_')||sql.startsWith('CREATE TABLE main.mio_rule_writes(')||sql.startsWith('CREATE TABLE main.project_version_blobs(')) upgrading = true;
  if (point === 'after-drop' && sql === 'DROP TABLE main.agent_task_runs_v2'
    || point === 'after-metadata' && sql.startsWith('CREATE TRIGGER main.history_state_guard_identity ')
    || point === 'after-version' && sql === CURRENT_VERSION_WRITE
    || point === 'after-commit' && upgrading && sql === 'COMMIT'
    || point === 'counter-after-create' && sql.startsWith('CREATE TABLE main.mio_storage_counters(')
    || point === 'counter-after-version' && sql === CURRENT_VERSION_WRITE
    || point === 'counter-after-commit' && upgrading && sql === 'COMMIT'
    || point === 'rule-after-create' && sql.startsWith('CREATE TABLE main.mio_rule_writes(')
    || point === 'rule-after-trigger' && sql.startsWith('CREATE TRIGGER main.quota_mio_rule_writes_update ')
    || point === 'rule-after-version' && sql === CURRENT_VERSION_WRITE
    || point === 'rule-after-commit' && upgrading && sql === 'COMMIT'
    || point === 'versions-after-table' && sql.startsWith('CREATE TABLE main.project_version_blobs(')
    || point === 'versions-after-trigger' && sql.startsWith('CREATE TRIGGER main.retain_project_version_capture_marks ')
    || point === 'versions-after-version' && sql === CURRENT_VERSION_WRITE
    || point === 'versions-after-commit' && upgrading && sql === 'COMMIT') barrier();
};
openProjectConnection({projectFile: required('MIO_UPGRADE_PROJECT'), locate: () => ({
  localDir: required('MIO_UPGRADE_LOCAL'), cacheDir: required('MIO_UPGRADE_CACHE'), tempDir: required('MIO_UPGRADE_TMP'),
})}).close();
throw new Error('The requested upgrade barrier was not reached');
