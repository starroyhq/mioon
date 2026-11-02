import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {readMioTargetRevision, readMioTargetRevisions} from '../packages/business/src/agent/mio-target-revisions.ts';

const digest = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

test('process revisions advance and retain ABA tombstones without changing the project file', t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mio-revisions-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  let store = openStore(root);
  t.after(() => store.close());
  const projectId = store.projectId, jobId = randomUUID(), exportId = randomUUID();
  store.put('projects', {id: projectId, name: 'Process revision routing'});
  const projectFile = store.projectFile;
  const sequence = store.db.prepare('SELECT contentSequence FROM project.project_file').get()?.contentSequence;
  store.close();
  const before = digest(projectFile);
  store = openStore(root);
  const db = store.db;
  assert.equal(readMioTargetRevision(db, projectId, 'job', jobId), undefined);
  store.tx(() => {
    store.put('jobs', {id: jobId, projectId, status: 'queued'});
    store.put('exports', {id: exportId, projectId, status: 'queued'});
  });
  assert.equal(readMioTargetRevision(db, projectId, 'job', jobId), 1);
  assert.equal(readMioTargetRevision(db, projectId, 'export', exportId), 1);
  store.tx(() => store.put('jobs', {id: jobId, projectId, status: 'running'}));
  assert.equal(readMioTargetRevision(db, projectId, 'job', jobId), 2);
  store.tx(() => db.prepare('UPDATE jobs SET data=data WHERE id=?').run(jobId));
  assert.equal(readMioTargetRevision(db, projectId, 'job', jobId), 2, 'no-op updates do not advance');
  assert.throws(() => store.tx(() => {
    store.put('jobs', {id: jobId, projectId, status: 'failed'});
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(readMioTargetRevision(db, projectId, 'job', jobId), 2);
  store.tx(() => db.prepare('DELETE FROM jobs WHERE id=?').run(jobId));
  assert.equal(readMioTargetRevision(db, projectId, 'job', jobId), 3);
  store.tx(() => store.put('jobs', {id: jobId, projectId, status: 'queued'}));
  assert.equal(readMioTargetRevision(db, projectId, 'job', jobId), 4);
  const frozen = readMioTargetRevisions(db, projectId);
  assert.ok(frozen.some(item => item.kind === 'job' && item.id === jobId && item.revision === 4));
  assert.ok(frozen.some(item => item.kind === 'project' && item.id === projectId));
  assert.deepEqual(frozen, [...frozen].sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  assert.equal(db.prepare("SELECT count(*) AS n FROM project.agent_task_target_revisions_v2 WHERE kind IN ('job','export','image_task','frame_task')").get()?.n, 0);
  assert.equal(db.prepare('SELECT contentSequence FROM project.project_file').get()?.contentSequence, sequence);
  const changes = db.prepare('SELECT total_changes() AS n').get()?.n;
  assert.deepEqual(readMioTargetRevisions(db, randomUUID()), []);
  readMioTargetRevision(db, projectId, 'job', jobId);
  assert.equal(db.prepare('SELECT total_changes() AS n').get()?.n, changes, 'revision reads never write');
  store.close();
  assert.equal(digest(projectFile), before, 'only read project bytes after closing its connection');
  store = openStore(root);
  assert.equal(readMioTargetRevision(store.db, projectId, 'job', jobId), 4);
  assert.deepEqual(readMioTargetRevisions(store.db, projectId), frozen);
});

test('legacy connections remain on their original ledger even if a lookalike process table exists', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE agent_task_target_revisions_v2(projectId TEXT,kind TEXT,targetId TEXT,revision INTEGER)');
    db.exec('CREATE TABLE mio_process_target_revisions(projectId TEXT,kind TEXT,targetId TEXT,revision INTEGER)');
    db.exec("INSERT INTO agent_task_target_revisions_v2 VALUES('p','job','j',7)");
    db.exec("INSERT INTO mio_process_target_revisions VALUES('p','job','j',99)");
    assert.equal(readMioTargetRevision(db, 'p', 'job', 'j'), 7);
    assert.deepEqual(readMioTargetRevisions(db, 'p'), [{kind: 'job', id: 'j', revision: 7}]);
    db.exec("UPDATE agent_task_target_revisions_v2 SET revision=-1");
    assert.throws(() => readMioTargetRevision(db, 'p', 'job', 'j'), {code: 'AGENT_TASK_STORAGE_CORRUPT'});
  } finally { db.close(); }
});
