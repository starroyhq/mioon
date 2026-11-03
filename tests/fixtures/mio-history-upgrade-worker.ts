import {writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {openProjectConnection} from '../../packages/business/src/project-file/connection.ts';

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
  if (!upgrading && (sql.startsWith('DROP TABLE main.agent_task_')||sql.startsWith('DROP TRIGGER main.quota_mio_')||sql.startsWith('CREATE TABLE main.mio_rule_writes('))) {
    // Force the schema reset to spill dirty pages before COMMIT, so a kill
    // exercises journal recovery rather than only discarding an in-memory DDL.
    exec.call(this, 'PRAGMA main.cache_size=8; PRAGMA project.cache_size=8; PRAGMA cache_spill=ON');
  }
  if(point==='counter-after-init'&&sql==='UPDATE main.schema_version SET version=5')barrier();
  exec.call(this, sql);
  if (sql.startsWith('DROP TABLE main.agent_task_')||sql.startsWith('DROP TRIGGER main.quota_mio_')||sql.startsWith('CREATE TABLE main.mio_rule_writes(')) upgrading = true;
  if (point === 'after-drop' && sql === 'DROP TABLE main.agent_task_runs_v2'
    || point === 'after-cleanup' && sql.startsWith('CREATE TRIGGER project.project_file_sequence_agent_task_target_revisions_v2_delete ')
    || point === 'after-version' && sql === 'UPDATE main.schema_version SET version=5'
    || point === 'after-commit' && upgrading && sql === 'COMMIT'
    || point === 'counter-after-create' && sql.startsWith('CREATE TABLE main.mio_storage_counters(')
    || point === 'counter-after-version' && sql === 'UPDATE main.schema_version SET version=5'
    || point === 'counter-after-commit' && upgrading && sql === 'COMMIT'
    || point === 'rule-after-create' && sql.startsWith('CREATE TABLE main.mio_rule_writes(')
    || point === 'rule-after-trigger' && sql.startsWith('CREATE TRIGGER main.quota_mio_rule_writes_update ')
    || point === 'rule-after-version' && sql === 'UPDATE main.schema_version SET version=5'
    || point === 'rule-after-commit' && upgrading && sql === 'COMMIT') barrier();
};
openProjectConnection({projectFile: required('MIO_UPGRADE_PROJECT'), locate: () => ({
  localDir: required('MIO_UPGRADE_LOCAL'), cacheDir: required('MIO_UPGRADE_CACHE'), tempDir: required('MIO_UPGRADE_TMP'),
})}).close();
throw new Error('The requested upgrade barrier was not reached');
