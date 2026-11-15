import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startServer, type InspectProject} from './helpers/test-server.ts';
import {projectApiPath} from '../packages/contracts/src/project-file.ts';
import {subscribeBackgroundTaskChanges} from '../packages/business/src/background-task-events.ts';
import {createServerProject} from './helpers/project-database.ts';

test('edit HTTP preserves the committed-but-unconfirmed acknowledgement and retries the same request without a second task', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 's3-acknowledgement-')), token = 'synthetic-s3-ack-token';
  const created = createServerProject(root, {name: 'Acknowledgement'}), projectId = created.projectId;
  created.store.close();
  let inspect!: InspectProject, retain!: (id: string) => Promise<() => void>;
  const server = await startServer({dataDir: root, port: 0, token,
    inspectProject: value => {inspect = value;}, retainProjectForTest: value => {retain = value;}});
  let release: (() => void) | undefined, unsubscribe: (() => void) | undefined;
  t.after(async () => {unsubscribe?.(); release?.(); await server.close(); rmSync(root, {recursive: true, force: true});});
  release = await retain(projectId);
  const post = (suffix: readonly [string, ...string[]], input: unknown) => fetch(server.url + projectApiPath(projectId, ...suffix), {
    method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify(input),
  });
  const timeline = await (await post(['rpc'], {operation: 'timeline.get', input: {projectId}})).json();
  assert.equal(timeline.ok, true);
  const input = {projectId, operation: 'timeline.track.add', origin: 'new', input: {projectId,
    expectedRevision: timeline.data.revision, kind: 'video', name: 'Private task input', requestId: randomUUID()}};
  unsubscribe = inspect(projectId, db => subscribeBackgroundTaskChanges(db, () => {throw new Error('private observer failure: ' + root);}));
  const response = await post(['tasks', 'prepare'], input), text = await response.text(), value = JSON.parse(text);
  assert.equal(response.status, 503);
  assert.deepEqual(value.error.details, {projectId, mutationOutcome: 'unknown'});
  assert.equal(value.error.code, 'BACKGROUND_TASK_INDEX_UNCERTAIN'); assert.equal(value.error.retryable, false);
  for (const privateValue of [root, token, 'Private task input', 'private observer failure']) assert.equal(text.includes(privateValue), false);
  const rows = inspect(projectId, db => db.prepare('SELECT id,status,input FROM edit_tasks').all());
  assert.equal(rows.length, 1); assert.equal(rows[0]!.status, 'prepared');
  unsubscribe(); unsubscribe = undefined;
  const retried = await post(['tasks', 'prepare'], input), replay = await retried.json();
  assert.equal(retried.status, 200); assert.equal(replay.data.task.id, rows[0]!.id);
  assert.deepEqual(inspect(projectId, db => db.prepare('SELECT id,status,input FROM edit_tasks').all()), rows);
});
