/** Isolated crash fixture. It adds no production fault or inspection API. */
import {DatabaseSync} from 'node:sqlite';
import {openProjectConnection} from '../../packages/business/src/project-file/connection.ts';
import {HISTORY_SCHEMA_VERSION} from '../../packages/business/src/project-file/schema/databases.ts';

const input = JSON.parse(process.argv[2] ?? 'null') as {projectFile: string; localDir: string; cacheDir: string; tempDir: string; point: string};
if (!input || ![input.projectFile, input.localDir, input.cacheDir, input.tempDir, input.point].every(value => typeof value === 'string' && value.length > 0)) throw Error('Missing owned generation-services upgrade fixture');
const exec = DatabaseSync.prototype.exec, version = `UPDATE main.schema_version SET version=${HISTORY_SCHEMA_VERSION}`;
let upgrading = false;
DatabaseSync.prototype.exec = function(sql: string): void {
  if (input.point === 'before-version' && sql === version) process.kill(process.pid, 'SIGKILL');
  exec.call(this, sql);
  if (sql === 'DROP TABLE main.image_reviews') upgrading = true;
  if (input.point === 'after-drop' && sql === 'DROP TABLE main.image_reviews' ||
      input.point === 'after-create' && sql.startsWith('CREATE TABLE main."image_reviews"(') ||
      input.point === 'after-copy' && sql.startsWith('INSERT INTO main.image_reviews(rowid,') ||
      input.point === 'after-index' && sql.startsWith('CREATE INDEX main.image_reviews_project_page ') ||
      input.point === 'after-trigger' && /^CREATE TRIGGER main.\w+ .*\bON image_reviews\b/u.test(sql) ||
      input.point === 'after-version' && sql === version || input.point === 'after-commit' && upgrading && sql === 'COMMIT') process.kill(process.pid, 'SIGKILL');
};
openProjectConnection({projectFile: input.projectFile, locate: () => ({localDir: input.localDir, cacheDir: input.cacheDir, tempDir: input.tempDir})}).close();
throw Error('The requested generation-services upgrade boundary was not reached');
