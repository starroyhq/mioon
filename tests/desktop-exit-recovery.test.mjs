import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {EventEmitter, once} from 'node:events';
import {mkdtemp, realpath, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {BackendSupervisor} from '../apps/desktop/src/supervisor.mjs';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {shotTextForStore} from './fixtures/local-shot-text-process-worker.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const workerPath = fileURLToPath(new URL('./helpers/edit-task-process-worker.mjs', import.meta.url));
const sourceBytes = Buffer.from('Synthetic source bytes retained across desktop backend failure');
const domainTables = ['projects', 'assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports', 'timelines',
  'timeline_requests', 'reference_requests', 'timeline_history', 'timeline_history_cursors', 'idempotency', 'job_events',
  'mutation_requests', 'asset_ranges', 'asset_range_requests', 'asset_dispositions', 'asset_disposition_requests',
  'subjects', 'subject_versions', 'subject_bindings', 'subject_requests'];
const action = envelope => ({projectId: envelope.task.projectId, taskId: envelope.task.id, digest: envelope.task.digest});
const execute = envelope => ({...action(envelope), instanceId: envelope.instanceId});

function deadline(promise, label, ms = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), ms);
  })]).finally(() => clearTimeout(timer));
}

// Only Electron's process/IPC boundary is adapted. The owned worker opens the
// real store and runs the real task manager, receipt lookup and startup recovery.
function utilityWorker(root) {
  const utility = new EventEmitter();
  const child = spawn(process.execPath, [workerPath, root], {cwd: repo, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {PATH: process.env.PATH || '', TMPDIR: root, LANG: 'C.UTF-8', NODE_ENV: 'test', MIOON_ENABLE_LIVE_PROVIDER: '0'}});
  const pending = new Map(), exited = Promise.withResolvers();
  let stopped, stderr = '';
  utility.pid = child.pid;
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  child.once('error', error => utility.emit('error', error));
  child.once('exit', (code, signal) => utility.emit('exit', code, signal));
  child.once('close', (code, signal) => {
    stopped = {code, signal};
    for (const reply of pending.values()) reply.reject(Object.assign(Error(`Owned worker exited (${code}, ${signal})\n${stderr}`),
      {code: 'WORKER_EXITED', signal}));
    exited.resolve(stopped);
  });
  child.on('message', message => {
    if (message.type === 'ready') {
      utility.startup = message.startup;
      utility.emit('message', {type: 'ready', url: 'http://127.0.0.1:49123', runtime: {node: process.versions.node, pid: child.pid}});
    } else if (message.type === 'fatal') utility.emit('error', Error(message.message));
    else if (message.type === 'reply') {
      const reply = pending.get(message.id);
      if (message.error) reply?.reject(Object.assign(Error(message.error.message), {code: message.error.code}));
      else reply?.resolve(message.data);
    }
  });
  utility.postMessage = message => {
    if (message.type === 'stop') child.send({method: 'close'});
    else assert.ok(['start', 'ping'].includes(message.type), 'Recovery cannot submit task IPC through the lifecycle protocol');
  };
  utility.kill = () => child.kill('SIGTERM');
  return Object.assign(utility, {
    async ask(method, input) {
      assert.equal(stopped, undefined);
      const id = randomUUID(), reply = Promise.withResolvers();
      pending.set(id, reply);
      child.send({id, method, input}, error => { if (error) reply.reject(error); });
      try { return await deadline(reply.promise, `${method} reply`); }
      finally { pending.delete(id); }
    },
    async close() {
      if (!stopped && child.connected) child.send({method: 'close'});
      try { return await deadline(exited.promise, 'worker close'); }
      catch (error) { child.kill('SIGKILL'); await deadline(exited.promise, 'worker cleanup'); throw error; }
    },
    exited: exited.promise
  });
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-desktop-exit-recovery-'))), workers = [];
  const supervisor = new BackendSupervisor({fork: () => {
    const worker = utilityWorker(root); workers.push(worker); return worker;
  }, modulePath: workerPath, environment: {}, startupTimeout: 15000});
  t.after(async () => {
    try {
      await supervisor.stop();
      const results = await Promise.allSettled(workers.map(worker => worker.close()));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    } finally { await rm(root, {recursive: true, force: true}); }
  });
  const store = openStore(root), services = createServices(store, new Map());
  let project, source, shot, timeline, savedDraft, originalSubject;
  try {
    project = await services.call('project.create', {name: 'Synthetic desktop recovery'});
    const id = randomUUID();
    await writeFile(path.join(root, 'media', `${id}.fixture`), sourceBytes, {flag: 'wx', mode: 0o600});
    source = store.put('assets', {id, projectId: project.id, name: 'Synthetic preserved source', mimeType: 'image/png',
      relativePath: `media/${id}.fixture`, sha256: createHash('sha256').update(sourceBytes).digest('hex'),
      sizeBytes: sourceBytes.length, duration: 0, width: 64, height: 64,
      hasVideo: true, hasAudio: false, provenance: 'user-import', createdAt: new Date().toISOString()});
    shot = await services.call('shot.create', {projectId: project.id, title: 'Saved shot', prompt: 'Saved prompt'});
    timeline = await services.call('timeline.get', {projectId: project.id});
    timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision,
      requestId: randomUUID(), assetId: source.id, trackId: timeline.tracks[0].id, startFrame: 0, durationFrames: 30});
    originalSubject = await services.call('subject.create', {projectId: project.id, kind: 'character',
      name: 'Previously committed subject', assetId: source.id, requestId: randomUUID()});
    const {local} = shotTextForStore(store, services);
    const current = local.get({projectId: project.id, shotId: shot.id});
    savedDraft = local.put({workspaceScope: current.workspaceScope, instanceId: current.instanceId,
      projectId: project.id, shotId: shot.id, expectedDraftRevision: current.draftRevision, draftId: randomUUID(),
      baseRevision: shot.revision, baseText: {title: shot.title, prompt: shot.prompt},
      raw: {title: '尚未提交的标题 🎬', prompt: '恢复后保留的原始文字\n不自动保存'}});
  } finally { await services.drain(); store.close(); }
  const f = {root, supervisor, workers, project, source, shot, timeline, savedDraft, originalSubject,
    get worker() { return workers.at(-1); },
    async start() {
      const ready = await supervisor.start({dataDir: root});
      assert.equal(ready.runtime.pid, this.worker.pid);
      assert.equal(await readFile(path.join(root, 'server.lock'), 'utf8'), String(this.worker.pid));
      return this.worker.startup;
    },
    read(fn) {
      const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
      try { return fn(db); } finally { db.close(); }
    },
    snapshot(tables = domainTables) {
      return this.read(db => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
    },
    sidecar: () => readFile(path.join(root, 'local-shot-text-v1.json'), 'utf8'),
    diagnostics: async () => (await readFile(path.join(root, 'diagnostics', 'backend-exit.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line))
  };
  assert.deepEqual(await f.start(), {processed: 0, unavailable: 0});
  return f;
}

for (const phase of ['afterClaim', 'afterBusinessCommit']) {
  test(`desktop ${phase}: controlled worker death retains evidence and explicit restart never redispatches`, {timeout: 45000}, async t => {
    const f = await fixture(t), baseline = f.snapshot(), draftBytes = await f.sidecar();
    const input = {projectId: f.project.id, kind: 'character', name: 'Interrupted subject', assetId: f.source.id, requestId: randomUUID()};
    const prepared = await f.worker.ask('prepare', {projectId: f.project.id, operation: 'subject.create', input, origin: 'new'});
    await f.worker.ask('arm', phase);
    const exit = once(f.supervisor, 'exit');
    await assert.rejects(f.worker.ask('execute', execute(prepared)), {code: 'WORKER_EXITED', signal: 'SIGKILL'});
    const [outcome] = await exit;
    assert.equal(outcome.expected, false);
    assert.equal(outcome.code, null, 'A signal death has no fabricated numeric exit code');
    assert.equal(f.supervisor.state, 'failed');
    assert.equal(f.supervisor.child, null);
    assert.equal(f.workers.length, 1, 'An abnormal exit cannot automatically fork a replacement or replay submissions');
    const crash = (await f.diagnostics()).filter(record => record.event === 'exit');
    assert.equal(crash.length, 1);
    assert.equal(crash[0].classification, 'abnormal');
    assert.equal(crash[0].code, null);
    assert.equal(crash[0].signal, null, 'The Electron boundary does not supply a signal to diagnose');
    assert.equal(crash[0].exitConfirmed, true);
    assert.equal(crash[0].runtime.node, process.versions.node);
    assert.ok(Number.isFinite(Date.parse(crash[0].time)));
    assert.equal(f.snapshot(['edit_tasks']).edit_tasks[0].status, 'dispatching');
    const committed = f.snapshot();
    for (const table of domainTables.filter(table => !['subjects', 'subject_versions', 'subject_requests'].includes(table)))
      assert.deepEqual(committed[table], baseline[table], `${table} must survive the controlled fault`);
    assert.deepEqual(committed.subject_requests.slice(0, baseline.subject_requests.length), baseline.subject_requests,
      'Previously committed receipt bytes must remain immutable');
    assert.equal(committed.subject_requests.length, baseline.subject_requests.length + (phase === 'afterBusinessCommit' ? 1 : 0));
    assert.equal(await f.sidecar(), draftBytes);
    assert.deepEqual(await readFile(path.join(f.root, f.source.relativePath)), sourceBytes);

    assert.deepEqual(await f.start(), {processed: 1, unavailable: 0});
    assert.equal(f.workers.length, 2, 'Only the explicit restart creates the replacement');
    const current = await f.worker.ask('get', {projectId: f.project.id, taskId: prepared.task.id});
    assert.equal(current.task.status, phase === 'afterClaim' ? 'unknown' : 'applied');
    assert.deepEqual(current.task.input, input);
    assert.notEqual(current.instanceId, prepared.instanceId);
    await assert.rejects(f.worker.ask('execute', execute(prepared)), {code: 'EDIT_TASK_STALE_INSTANCE'});
    const taskRows = f.snapshot(['edit_tasks']);
    assert.deepEqual((await f.worker.ask('list', {projectId: f.project.id})).items, [current.task]);
    assert.deepEqual(await f.worker.ask('prepare', {projectId: f.project.id, operation: 'subject.create', input, origin: 'new'}), current);
    const reconciled = await f.worker.ask('reconcile', action(current));
    assert.deepEqual(reconciled.task, current.task);
    if (phase === 'afterBusinessCommit') {
      const receipt = committed.subject_requests.find(row => row.requestId === input.requestId);
      assert.deepEqual(reconciled.result, JSON.parse(receipt.response), 'Recovery uses the immutable original receipt');
    }
    assert.deepEqual(await f.worker.ask('reconcileStartup'), {processed: 0, unavailable: 0});
    assert.deepEqual((await f.worker.ask('observe')).dispatches, [], 'Startup and observation can only inspect existing evidence');
    assert.deepEqual(f.snapshot(), committed);
    assert.deepEqual(f.snapshot(['edit_tasks']), taskRows);
    assert.equal(await f.sidecar(), draftBytes);
    assert.deepEqual(await readFile(path.join(f.root, f.source.relativePath)), sourceBytes);

    await f.supervisor.stop();
    await f.worker.close();
    const diagnostics = await f.diagnostics(), exits = diagnostics.filter(record => record.event === 'exit');
    assert.deepEqual(exits.map(record => record.classification), ['abnormal', 'normal']);
    assert.equal(exits[1].code, 0);
    assert.notEqual(exits[0].runId, exits[1].runId);
    for (const privateValue of [f.root, f.source.relativePath, sourceBytes.toString(), input.name,
      f.savedDraft.draft.raw.title, f.savedDraft.draft.raw.prompt])
      assert.equal(JSON.stringify(diagnostics).includes(privateValue), false, 'Diagnostics must omit workspace/task/media/draft content');
    const reopened = openStore(f.root), services = createServices(reopened, new Map());
    try {
      const {local} = shotTextForStore(reopened, services);
      assert.deepEqual(local.get({projectId: f.project.id, shotId: f.shot.id}).draft, f.savedDraft.draft);
      assert.deepEqual(await services.call('timeline.get', {projectId: f.project.id}), f.timeline);
      assert.deepEqual(reopened.get('assets', f.source.id), f.source);
    } finally { await services.drain(); reopened.close(); }
    assert.equal(await f.sidecar(), draftBytes);
  });
}
