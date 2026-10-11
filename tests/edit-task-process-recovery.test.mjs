import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, realpath, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {isEditTaskEnvelope} from '@mioon/contracts';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const workerPath = fileURLToPath(new URL('./helpers/edit-task-process-worker.mjs', import.meta.url));
const domainTables = ['projects', 'assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports', 'timelines',
  'timeline_requests', 'reference_requests', 'timeline_history', 'timeline_history_cursors', 'idempotency', 'job_events',
  'mutation_requests', 'asset_ranges', 'asset_range_requests', 'asset_dispositions', 'asset_disposition_requests',
  'subjects', 'subject_versions', 'subject_bindings', 'subject_requests'];
const action = task => ({projectId: task.projectId, taskId: task.id, digest: task.digest});
const execute = envelope => ({...action(envelope.task), instanceId: envelope.instanceId});
const acknowledge = task => ({...action(task), expectedRevision: task.revision, status: task.status});

// WORKER_STARTUP_DIAGNOSTIC: observation only; readiness and cleanup deadlines stay unchanged.
const startupPhases = new Set(['entry-after-imports', 'open-store-start', 'open-store-end',
  'services-start', 'services-end', 'tasks-start', 'tasks-end', 'reconcile-start', 'reconcile-end']);
const startupResourceKeys = ['userCPUTime', 'systemCPUTime', 'maxRSS', 'fsRead', 'fsWrite',
  'voluntaryContextSwitches', 'involuntaryContextSwitches'];
const startupNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const startupResources = value => Object.fromEntries(startupResourceKeys
  .filter(key => startupNumber(value?.[key])).map(key => [key, value[key]]));

function deadline(promise, label, ms = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), ms);
  })]).finally(() => clearTimeout(timer));
}

function startWorker(root) {
  const started = process.hrtime.bigint(), observations = [];
  const elapsed = () => Math.round(Number(process.hrtime.bigint() - started) / 1000) / 1000;
  const observe = (event, details = {}) => {
    if (observations.length < 16) observations.push({event, elapsedMs: elapsed(), ...details});
  };
  const exitDetails = (code, signal) => ({code: Number.isInteger(code) ? code : null,
    signal: ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(signal) ? signal : null});
  observe('launch');
  const child = spawn(process.execPath, [workerPath, root], {cwd: repo, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {PATH: process.env.PATH || '', TMPDIR: root, LANG: 'C.UTF-8', NODE_ENV: 'test', MIOON_ENABLE_LIVE_PROVIDER: '0'}});
  let output = '', stdoutBytes = 0, stderrBytes = 0;
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.setEncoding('utf8').on('data', chunk => {
    output = (output + chunk).slice(-20000);
    if (name === 'stdout') stdoutBytes = Math.min(Number.MAX_SAFE_INTEGER, stdoutBytes + Buffer.byteLength(chunk));
    else stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + Buffer.byteLength(chunk));
  });
  const ready = Promise.withResolvers(), exited = Promise.withResolvers(), pending = new Map();
  let stopped;
  const rejectPending = error => { ready.reject(error); for (const reply of pending.values()) reply.reject(error); };
  child.once('spawn', () => observe('spawn'));
  child.once('error', error => { observe('error'); rejectPending(error); });
  child.once('exit', (code, signal) => observe('exit', exitDetails(code, signal)));
  child.once('close', (code, signal) => {
    observe('close', exitDetails(code, signal));
    stopped = {code, signal};
    rejectPending(Object.assign(Error(`Worker exited (${code}, ${signal})\n${output}`), {code: 'WORKER_EXITED', signal}));
    exited.resolve(stopped);
  });
  child.on('message', message => {
    if (message.type === 'startup-phase') {
      if (startupPhases.has(message.phase) && startupNumber(message.elapsedMs))
        observe('phase', {phase: message.phase, workerElapsedMs: message.elapsedMs,
          resourceUsage: startupResources(message.resourceUsage)});
    } else if (message.type === 'ready') { observe('ready'); ready.resolve(message); }
    else if (message.type === 'fatal') { observe('fatal'); rejectPending(Error(message.message)); }
    else if (message.type === 'reply') {
      const reply = pending.get(message.id);
      if (message.error) reply?.reject(Object.assign(Error(message.error.message), {code: message.error.code}));
      else reply?.resolve(message.data);
    }
  });
  return {pid: child.pid, ready: ready.promise, exited: exited.promise,
    startupDiagnostic: () => ({elapsedMs: elapsed(), observations: observations.map(value => ({...value})),
      stdoutBytes, stderrBytes, connected: child.connected, ...exitDetails(child.exitCode, child.signalCode),
      parentResourceUsage: startupResources(process.resourceUsage())}),
    async ask(method, input) {
      if (stopped) throw Error('Worker is already stopped');
      const id = randomUUID(), reply = Promise.withResolvers();
      pending.set(id, reply);
      child.send({id, method, input}, error => { if (error) reply.reject(error); });
      try { return await deadline(reply.promise, `${method} reply`); }
      finally { pending.delete(id); }
    },
    async close() {
      if (!stopped && child.connected) child.send({method: 'close'});
      try { return await deadline(exited.promise, 'worker close'); }
      catch (error) { child.kill('SIGKILL'); await deadline(exited.promise, 'worker kill'); throw error; }
    },
  };
}

async function fixture(t) {
  // Canonicalize only this newly created private directory; keep all storage guards enabled.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-edit-task-process-'))), workers = [], timedOutWorkers = new Set();
  let worker;
  t.after(async () => {
    try {
      const results = await Promise.allSettled(workers.map(value => value.close()));
      for (const value of timedOutWorkers)
        t.diagnostic(`Worker readiness cleanup observation: ${JSON.stringify(value.startupDiagnostic())}`);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      t.diagnostic(`All ${workers.length} workers reaped: ${workers.map(value => value.pid).join(', ')}`);
    } finally { await rm(root, {recursive: true, force: true}); }
  });
  const store = openStore(root);
  let project, other, source, second, foreign, video, shot;
  try {
    const services = createServices(store, new Map());
    project = await services.call('project.create', {name: 'Synthetic process recovery'});
    other = await services.call('project.create', {name: 'Synthetic other project'});
    const asset = (projectId, sha, patch = {}) => {
      const id = randomUUID();
      return store.put('assets', {id, projectId, name: 'Synthetic metadata only', mimeType: 'image/png',
        relativePath: `media/${id}.fixture`, sha256: sha.repeat(64), sizeBytes: 100, duration: 0, width: 64, height: 64,
        hasVideo: true, hasAudio: false, provenance: 'user-import', createdAt: new Date().toISOString(), ...patch});
    };
    source = asset(project.id, 'a'); second = asset(project.id, 'b'); foreign = asset(other.id, 'c');
    video = asset(project.id, 'd', {mimeType: 'video/mp4', duration: 10, hasAudio: true});
    shot = await services.call('shot.create', {projectId: project.id, title: 'Synthetic shot'});
  } finally { store.close(); }
  const f = {root, project, other, source, second, foreign, video, shot,
    get worker() { return worker; },
    async start() {
      worker = startWorker(root); workers.push(worker);
      let ready;
      try { ready = await deadline(worker.ready, 'worker ready'); }
      catch (error) {
        if (error.message === 'Timed out: worker ready') {
          timedOutWorkers.add(worker);
          t.diagnostic(`Worker readiness timeout observation: ${JSON.stringify(worker.startupDiagnostic())}`);
        }
        throw error; // The fixture's existing owned-worker cleanup runs immediately after rejection.
      }
      assert.equal(ready.pid, worker.pid); assert.notEqual(ready.pid, process.pid);
      assert.equal(await readFile(path.join(root, 'server.lock'), 'utf8'), String(worker.pid));
      return ready;
    },
    async restart() { await worker.close(); return this.start(); },
    ask: (method, input) => worker.ask(method, input),
    prepare: (operation, input) => worker.ask('prepare', {projectId: input.projectId, operation, input, origin: 'new'}),
    rpc: (operation, input) => worker.ask('rpc', {operation, input}),
    createInput: (patch = {}) => ({projectId: project.id, kind: 'character', name: 'Synthetic hero', assetId: source.id, requestId: randomUUID(), ...patch}),
    read(fn) {
      const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
      try { return fn(db); } finally { db.close(); }
    },
    snapshot(tables = domainTables) {
      return this.read(db => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
    },
    receipt(requestId) { return this.read(db => db.prepare('SELECT * FROM subject_requests WHERE requestId=?').get(requestId)); },
    async crash(phase, method, input) {
      const oldPid = worker.pid;
      await worker.ask('arm', phase);
      await assert.rejects(worker.ask(method, input), {code: 'WORKER_EXITED', signal: 'SIGKILL'});
      assert.deepEqual(await worker.exited, {code: null, signal: 'SIGKILL'});
      assert.equal(await readFile(path.join(root, 'server.lock'), 'utf8'), String(oldPid), 'crash must not clean up the store');
      t.diagnostic(`${phase}: worker ${oldPid} exited by SIGKILL before IPC reply`);
    },
  };
  assert.deepEqual((await f.start()).startup, {processed: 0, unavailable: 0});
  return f;
}

async function noDispatch(f) {
  assert.deepEqual((await f.ask('observe')).dispatches, []);
}

for (const phase of ['afterPreparePersist', 'afterClaim']) {
  test(`subject ${phase}: process death retains intent but startup, observation and acknowledgement cannot dispatch`, {timeout: 30000}, async t => {
    const f = await fixture(t), input = f.createInput(), before = f.snapshot();
    let prepared;
    if (phase === 'afterPreparePersist') {
      await f.crash(phase, 'prepare', {projectId: f.project.id, operation: 'subject.create', input, origin: 'new'});
    } else {
      prepared = await f.prepare('subject.create', input);
      await f.crash(phase, 'execute', execute(prepared));
    }
    const [retained] = f.snapshot(['edit_tasks']).edit_tasks;
    assert.equal(retained.status, prepared ? 'dispatching' : 'prepared');
    assert.equal(retained.input, JSON.stringify(input));
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual((await f.start()).startup, {processed: prepared ? 1 : 0, unavailable: 0});
    const current = await f.ask('get', {projectId: f.project.id, taskId: retained.id});
    assert.ok(isEditTaskEnvelope(current));
    assert.equal(current.task.status, prepared ? 'unknown' : 'prepared');
    assert.deepEqual(current.task.input, input);
    if (prepared) {
      assert.notEqual(current.instanceId, prepared.instanceId);
      await assert.rejects(f.ask('execute', execute(prepared)), {code: 'EDIT_TASK_STALE_INSTANCE'});
    }
    const rows = f.snapshot(['edit_tasks']);
    assert.deepEqual((await f.ask('list', {projectId: f.project.id})).items, [current.task]);
    assert.deepEqual(await f.prepare('subject.create', input), current);
    assert.deepEqual(await f.ask('reconcile', action(current.task)), current);
    assert.deepEqual(await f.ask('reconcileStartup'), {processed: 0, unavailable: 0});
    await assert.rejects(f.ask('acknowledge', {...acknowledge(current.task), status: 'applied'}), {code: 'EDIT_TASK_CONFLICT'});
    await noDispatch(f);
    assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.snapshot(['edit_tasks']), rows);
    const applied = await f.ask('execute', execute(current));
    assert.equal(applied.task.status, 'applied'); assert.equal(applied.task.requestId, input.requestId);
    assert.deepEqual((await f.ask('observe')).dispatches, [{operation: 'subject.create', input}]);
    const after = f.snapshot();
    assert.equal(after.subjects.length, 1); assert.equal(after.subject_versions.length, 1); assert.equal(after.subject_requests.length, 1);
    assert.deepEqual(await f.ask('execute', execute(current)), applied);
    assert.deepEqual(f.snapshot(), after);
    assert.deepEqual((await f.ask('observe')).dispatches, [{operation: 'subject.create', input}]);
  });
}

for (const phase of ['afterBusinessCommit', 'beforeOutcomePersist', 'afterOutcomePersist']) {
  test(`subject ${phase}: lost process reply replays the original result after a newer head without a second create`, {timeout: 30000}, async t => {
    const f = await fixture(t), input = f.createInput(), prepared = await f.prepare('subject.create', input);
    await f.crash(phase, 'execute', execute(prepared));
    const receipt = f.receipt(input.requestId), original = JSON.parse(receipt.response), committed = f.snapshot();
    assert.equal(receipt.operation, 'subject.create'); assert.equal(receipt.projectId, f.project.id);
    assert.equal(original.revision, 1); assert.equal(committed.subjects.length, 1);
    assert.equal(committed.subject_versions.length, 1); assert.equal(committed.subject_requests.length, 1);
    assert.equal(f.snapshot(['edit_tasks']).edit_tasks[0].status, phase === 'afterOutcomePersist' ? 'applied' : 'dispatching');
    assert.deepEqual((await f.start()).startup, {processed: phase === 'afterOutcomePersist' ? 0 : 1, unavailable: 0});
    assert.deepEqual(f.snapshot(), committed); await noDispatch(f);
    const current = await f.prepare('subject.create', input);
    assert.equal(current.task.id, prepared.task.id); assert.equal(current.task.digest, prepared.task.digest);
    assert.deepEqual(current.task.input, input); assert.equal(current.task.status, 'applied');
    assert.notEqual(current.instanceId, prepared.instanceId);
    await assert.rejects(f.ask('execute', execute(prepared)), {code: 'EDIT_TASK_STALE_INSTANCE'});
    const head = await f.rpc('subject.version.add', {projectId: f.project.id, subjectId: original.id,
      expectedRevision: 1, assetId: f.second.id, requestId: randomUUID()});
    assert.equal(head.revision, 2); assert.notEqual(head.headVersionId, original.headVersionId);
    const newer = f.snapshot(), rows = f.snapshot(['edit_tasks']);
    assert.deepEqual(await f.ask('get', {projectId: f.project.id, taskId: current.task.id}), current);
    assert.deepEqual((await f.ask('list', {projectId: f.project.id})).items, [current.task]);
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await f.prepare('subject.create', {...input}), current);
      assert.deepEqual((await f.ask('execute', execute(current))).result, original);
      assert.deepEqual((await f.ask('reconcile', action(current.task))).result, original);
      assert.deepEqual(await f.rpc('subject.create', {...input}), original);
    }
    assert.deepEqual((await f.rpc('subject.list', {projectId: f.project.id})).items, [head]);
    assert.deepEqual(f.receipt(input.requestId), receipt, 'original response bytes must stay immutable');
    assert.deepEqual(f.snapshot(), newer); assert.deepEqual(f.snapshot(['edit_tasks']), rows); await noDispatch(f);
    assert.equal(newer.subjects.length, 1); assert.equal(newer.subject_versions.length, 2); assert.equal(newer.subject_requests.length, 2);
    const ack = await f.ask('acknowledge', acknowledge(current.task));
    assert.equal(ack.task.acknowledged, true);
    assert.deepEqual((await f.ask('list', {projectId: f.project.id})).items, []);
    assert.deepEqual((await f.ask('execute', execute(ack))).result, original);
    assert.deepEqual(f.snapshot(), newer); await noDispatch(f);
  });
}

test('subject acknowledgement committed before process death stays acknowledged without redispatch', {timeout: 30000}, async t => {
  const f = await fixture(t), input = f.createInput(), prepared = await f.prepare('subject.create', input);
  const applied = await f.ask('execute', execute(prepared)), before = f.snapshot();
  await f.crash('afterAcknowledge', 'acknowledge', acknowledge(applied.task));
  const rows = f.snapshot(['edit_tasks']);
  assert.equal(rows.edit_tasks[0].acknowledged, 1);
  assert.equal(rows.edit_tasks[0].revision, applied.task.revision + 1);
  assert.deepEqual((await f.start()).startup, {processed: 0, unavailable: 0});
  const current = await f.prepare('subject.create', input);
  assert.notEqual(current.instanceId, applied.instanceId); assert.equal(current.task.id, applied.task.id);
  assert.equal(current.task.acknowledged, true);
  assert.deepEqual((await f.ask('list', {projectId: f.project.id})).items, []);
  assert.deepEqual((await f.ask('list', {projectId: f.project.id, pendingOnly: false})).items, [current.task]);
  await assert.rejects(f.ask('acknowledge', acknowledge(applied.task)), {code: 'EDIT_TASK_CONFLICT'});
  assert.deepEqual(await f.ask('acknowledge', acknowledge(current.task)), current);
  assert.deepEqual((await f.ask('execute', execute(current))).result, applied.result);
  assert.deepEqual((await f.ask('reconcile', action(current.task))).result, applied.result);
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.snapshot(['edit_tasks']), rows); await noDispatch(f);
});

test('subject retained keys still conflict with changed input, project and subject operation after process restart', {timeout: 30000}, async t => {
  const f = await fixture(t), input = f.createInput(), prepared = await f.prepare('subject.create', input);
  const applied = await f.ask('execute', execute(prepared));
  await f.ask('acknowledge', acknowledge(applied.task));
  await f.restart();
  const before = f.snapshot([...domainTables, 'edit_tasks']);
  const cases = [
    ['subject.create', {...input, name: 'Different intent'}],
    ['subject.create', {...input, projectId: f.other.id, assetId: f.foreign.id}],
    ['subject.version.add', {projectId: f.project.id, subjectId: applied.result.id, assetId: f.second.id,
      expectedRevision: 1, requestId: input.requestId}],
    ['subject.binding.set', {projectId: f.project.id, subjectId: applied.result.id, shotId: f.shot.id, role: 'subject',
      subjectVersionId: applied.result.headVersionId, expectedRevision: 0, expectedSubjectRevision: 1, requestId: input.requestId}],
  ];
  for (const [operation, changed] of cases) {
    await assert.rejects(f.prepare(operation, changed), {code: 'EDIT_TASK_CONFLICT'});
    await assert.rejects(f.rpc(operation, changed), {code: 'IDEMPOTENCY_CONFLICT'});
    assert.deepEqual(f.snapshot([...domainTables, 'edit_tasks']), before);
  }
  assert.deepEqual(await f.rpc('subject.create', input), applied.result); await noDispatch(f);
});

const sharedOperations = [
  ['node.create', (f, requestId) => ({projectId: f.project.id, type: 'text', text: 'Synthetic key owner', position: {x: 0, y: 0}, requestId})],
  ['asset.range.set', (f, requestId) => ({projectId: f.project.id, assetId: f.video.id, expectedRevision: 0, inFrame: 0, outFrame: 30, requestId})],
  ['asset.disposition.set', (f, requestId) => ({projectId: f.project.id, assetId: f.source.id, expectedRevision: 0, disposition: 'favorite', requestId})],
];
for (const [operation, inputFor] of sharedOperations) {
  test(`subject and ${operation} receipts keep their shared key reservation in both directions after restart`, {timeout: 30000}, async t => {
    const f = await fixture(t), reserved = randomUUID(), localInput = inputFor(f, reserved);
    const localResult = await f.rpc(operation, localInput);
    await f.restart();
    const before = f.snapshot([...domainTables, 'edit_tasks']), collision = f.createInput({requestId: reserved});
    await assert.rejects(f.prepare('subject.create', collision), {code: 'EDIT_TASK_CONFLICT'});
    await assert.rejects(f.rpc('subject.create', collision), {code: 'IDEMPOTENCY_CONFLICT'});
    assert.deepEqual(await f.rpc(operation, localInput), localResult);
    assert.deepEqual(f.snapshot([...domainTables, 'edit_tasks']), before); await noDispatch(f);
    const input = f.createInput(), applied = await f.ask('execute', execute(await f.prepare('subject.create', input)));
    await f.ask('acknowledge', acknowledge(applied.task));
    await f.restart();
    const after = f.snapshot([...domainTables, 'edit_tasks']);
    await assert.rejects(f.rpc(operation, inputFor(f, input.requestId)), {code: 'IDEMPOTENCY_CONFLICT'});
    assert.deepEqual(await f.rpc('subject.create', input), applied.result);
    assert.deepEqual(f.snapshot([...domainTables, 'edit_tasks']), after); await noDispatch(f);
  });
}
