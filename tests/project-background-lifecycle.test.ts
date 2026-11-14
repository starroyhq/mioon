import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fork, type ChildProcess} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {run} from '../packages/business/src/media.ts';
import {createBackgroundLifecycleHost} from './fixtures/project-background-lifecycle-host.ts';
import {createServerProject} from './helpers/project-database.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {Provider} from '../packages/business/src/provider-registry.ts';
import {createProjectBackgroundState} from '../packages/business/src/background-task-state.ts';
import {backgroundHistorySource} from '../apps/server/src/project-host/background-history.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';

const object = (value: unknown): Record<string, unknown> => {assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;};
async function until(check: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {if (Date.now() >= deadline) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 20));}
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 's3-lifecycle-')), dataDir = path.join(root, 'app'), source = path.join(root, 'source.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'color=c=blue:s=144x256:r=30:d=0.2',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', source], {timeout: 30_000});
  const bytes = await readFile(source), calls = {submit: 0, poll: 0, download: 0}, remoteJobs = new Map<string, string>();
  let complete = false;
  const remote = createServer(async (req, res) => {
    try {
      let response: unknown;
      if (req.url?.startsWith('/download/')) {calls.download++; res.writeHead(200, {'content-type': 'video/mp4'}); res.end(bytes); return;}
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) {length += chunk.length; if (length > 4096) throw new Error('Synthetic request limit'); chunks.push(Buffer.from(chunk));}
      const input = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (req.url === '/submit') {calls.submit++; const requestId = String(input.requestId), providerJobId = 'accepted-' + requestId;
        remoteJobs.set(requestId, providerJobId); response = {providerJobId};}
      else if (req.url === '/poll') {calls.poll++; assert.ok([...remoteJobs.values()].includes(String(input.providerJobId))); response = {status: complete ? 'succeeded' : 'running', progress: 0.5};}
      else if (req.url === '/reconcile') response = remoteJobs.has(String(input.requestId)) ? {providerJobId: remoteJobs.get(String(input.requestId))} : null;
      else throw new Error('Unexpected route');
      res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(response));
    } catch {res.writeHead(500).end();}
  });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address(); assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`, hosts = new Set<ReturnType<typeof createBackgroundLifecycleHost>>(), children = new Set<ChildProcess>();
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {child.kill('SIGKILL'); await once(child, 'exit');}
    for (const host of hosts) await host.close();
    remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); await rm(root, {recursive: true, force: true});
  });
  const open = () => {const host = createBackgroundLifecycleHost({dataDir, remote: url}); hosts.add(host); return host;};
  const start = async () => {
    const host = open(), project = await host.manager.create({name: 'Background lifecycle'}), window = await host.manager.acquire(project.projectId, 'window');
    const services = window.host.runtime.services, shot = object(await services.call('shot.create', {projectId: project.projectId, title: 'Blue', prompt: 'A blue rectangle', duration: 4}));
    const requestId = randomUUID(), job = object(await services.call('generation.submit', {shotId: shot.id, expectedRevision: shot.revision, providerId: 'ark', requestId}));
    await until(() => calls.submit === 1 && calls.poll > 0, 'The real worker did not reach provider polling');
    return {host, project, window, jobId: String(job.id), requestId, providerJobId: remoteJobs.get(requestId)!};
  };
  const completed = async (host: ReturnType<typeof open>, projectId: string, jobId: string, requestId: string, providerJobId: string) => {
    complete = true;
    await until(() => host.library.taskIndex.listProject(projectId).every(item => item.phase === 'archived' || item.phase === 'done'), 'The real task did not commit its terminal state');
    await until(() => host.manager.status(projectId) === null, 'S3 did not release the completed background host');
    const saved = host.manager.inspectProject(projectId, db => ({job: JSON.parse(String(db.prepare('SELECT data FROM jobs WHERE id=?').get(jobId)!.data)),
      assets: db.prepare('SELECT count(*) AS n FROM project.assets').get()!.n, versions: db.prepare('SELECT count(*) AS n FROM project.versions').get()!.n}));
    assert.equal(saved.job.status, 'succeeded'); assert.equal(saved.job.providerJobId, providerJobId); assert.equal(saved.job.requestId, requestId);
    assert.equal(saved.job.submissionCount, 1); assert.equal(saved.assets, 1); assert.equal(saved.versions, 1);
    assert.equal(calls.submit, 1); assert.equal(calls.download, 1);
  };
  return {root, dataDir, url, calls, children, open, start, completed, setComplete() {complete = true;}};
}

test('real generation finishes and publishes exactly once after its window lease is released', {timeout: 30_000}, async t => {
  const f = await fixture(t), current = await f.start();
  current.window.release(); assert.equal(current.host.manager.status(current.project.projectId)!.leases.task, 1);
  await f.completed(current.host, current.project.projectId, current.jobId, current.requestId, current.providerJobId);
});

test('losing the project pauses the original provider job and a real reopen resumes rather than submits again', {timeout: 30_000}, async t => {
  const f = await fixture(t), current = await f.start(), offline = path.join(f.root, 'external-offline.mioon');
  current.window.release(); await rename(current.project.projectFile, offline);
  await until(() => current.host.manager.status(current.project.projectId) === null, 'Missing project did not drain');
  const indexed = current.host.library.taskIndex.listProject(current.project.projectId);
  assert.equal(indexed.length, 1); assert.equal(indexed[0]!.phase, 'blocked'); assert.equal(f.calls.submit, 1);
  const pollCount = f.calls.poll; await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(f.calls.poll, pollCount, 'offline S3-A does not keep observing the provider');
  await rename(offline, current.project.projectFile);
  const window = await current.host.manager.acquire(current.project.projectId, 'window'); window.release();
  await f.completed(current.host, current.project.projectId, current.jobId, current.requestId, current.providerJobId);
});

test('normal stop and SIGKILL restart recover the same accepted task without a second provider submission', {timeout: 30_000}, async t => {
  const f = await fixture(t), current = await f.start();
  current.window.release(); await current.host.close();
  const config = path.join(f.root, 'child.json'); await writeFile(config, JSON.stringify({dataDir: f.dataDir, remote: f.url, projectId: current.project.projectId}), {mode: 0o600});
  const before = f.calls.poll, child = fork('tests/fixtures/project-background-lifecycle-worker.ts', [config], {cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  f.children.add(child);
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => {throw new Error('Recovery child exited before ready');})]);
  assert.deepEqual(message[0], {type: 'ready', taskLeases: 1});
  await until(() => f.calls.poll > before, 'Restarted worker did not poll the accepted provider ID');
  child.kill('SIGKILL'); const [code, signal] = await once(child, 'exit'); assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  assert.equal(f.calls.submit, 1);
  const restarted = f.open(), restored = await restarted.restore(); assert.equal(restored.failures.length, 0);
  await f.completed(restarted, current.project.projectId, current.jobId, current.requestId, current.providerJobId);
});

test('real domain preview and application admission accept done-plus-new at full capacity and reject a global overflow before COMMIT', {timeout: 30_000}, async t => {
  const f = await fixture(t), host = f.open(), project = await host.manager.create({name: 'Capacity'}), window = await host.manager.acquire(project.projectId, 'window');
  // This case exercises storage admission only; the three cases above execute
  // the real provider/publication path. Stop the idle worker before raw seeding.
  await window.host.runtime.worker()!.stop();
  const store = window.host.store, jobs = Array.from({length: 512}, () => ({id: randomUUID(), projectId: project.projectId,
    revision: 1, status: 'queued', phase: 'waiting', providerId: 'ark', providerJobId: null, submissionCount: 0, error: null}));
  store.tx(() => {for (const job of jobs) store.put('jobs', job);});
  assert.equal(host.library.taskIndex.listProject(project.projectId).length, 512);
  host.library.tx(() => {
    for (let p = 0; p < 7; p++) {
      const projectId = randomUUID();
      for (let i = 0; i < 512; i++) host.library.taskIndex.upsert({projectId, projectFile: path.join(f.root, 'retained.mioon'),
        kind: 'job', taskId: randomUUID(), indexedAt: new Date().toISOString(), phase: 'blocked', reason: 'PROJECT_MISSING', sourceHistory: 'a'.repeat(64)});
    }
  });
  assert.equal(host.library.taskIndex.list().length, 4096);
  const overflow = {...jobs[0]!, id: randomUUID()};
  assert.throws(() => store.tx(() => store.put('jobs', overflow)), {code: 'BACKGROUND_TASK_INDEX_LIMIT'});
  assert.equal(store.get('jobs', overflow.id), null);
  const replacement = {...overflow, id: randomUUID()};
  store.tx(() => {
    // New is written first on purpose; both validators/writers must evaluate
    // the final batch, retiring a terminal discovery before inserting new.
    store.put('jobs', replacement);
    store.put('jobs', {...jobs[0]!, revision: 2, status: 'cancelled', cancelScope: 'local_only'});
  });
  assert.equal(host.library.taskIndex.listProject(project.projectId).length, 512);
  assert.equal(host.library.taskIndex.list().length, 4096);
  assert.equal(host.library.taskIndex.listProject(project.projectId).some(entry => entry.taskId === replacement.id), true);
  assert.equal(host.library.taskIndex.listProject(project.projectId).some(entry => entry.taskId === jobs[0]!.id), false);
  store.tx(() => store.put('jobs', {...jobs[1]!, revision: 2, status: 'cancelled', cancelScope: 'local_only'}));
  host.library.taskIndex.upsert({projectId: randomUUID(), projectFile: path.join(f.root, 'retained.mioon'), kind: 'job', taskId: randomUUID(),
    indexedAt: new Date().toISOString(), phase: 'blocked', reason: 'PROJECT_MISSING', sourceHistory: 'b'.repeat(64)});
  const before = host.library.db.prepare('SELECT total_changes() AS n').get()!.n, globallyFull = {...overflow, id: randomUUID()};
  assert.throws(() => store.tx(() => store.put('jobs', globallyFull)), {code: 'APP_LIBRARY_LIMIT'});
  assert.equal(store.get('jobs', globallyFull.id), null);
  assert.equal(host.library.db.prepare('SELECT total_changes() AS n').get()!.n, before, 'pre-COMMIT capacity admission performs no application write');
  assert.equal(host.library.taskIndex.list().length, 4096); assert.equal(f.calls.submit, 0);
  window.release();
});

test('initial real-history repair retires 512 stale hints before discovering and dispatching a missing indexed task', {timeout: 30_000}, async t => {
  const f = await fixture(t), seed = createServerProject(f.dataDir, {name: 'Committed without index'});
  const noDispatch = async (): Promise<never> => {throw new Error('Cold seed has no worker');};
  const provider: Provider = {id: 'ark', capabilities: {models: ['fixture'], inputModes: ['text'], aspectRatios: ['9:16'], durations: [4],
    configured: true, enabled: true, mock: false}, submit: noDispatch, poll: noDispatch, reconcile: noDispatch, download: noDispatch};
  const services = createServices(seed.store, new Map([['ark', provider]]), {env: {}});
  const shot = object(await services.call('shot.create', {projectId: seed.projectId, title: 'Cold repair', prompt: 'A blue rectangle', duration: 4}));
  const requestId = randomUUID(), job = object(await services.call('generation.submit', {shotId: shot.id, expectedRevision: shot.revision, providerId: 'ark', requestId}));
  const source = backgroundHistorySource(seed.store), projectFile = seed.store.projectFile;
  await services.drain(); createProjectBackgroundState(seed.store).dispose(); seed.store.close();
  const app = openAppLibrary({dataDir: f.dataDir});
  try {
    assert.equal(app.taskIndex.listProject(seed.projectId).length, 0);
    app.tx(() => {for (let i = 0; i < 512; i++) app.taskIndex.upsert({projectId: seed.projectId, projectFile,
      kind: 'job', taskId: randomUUID(), indexedAt: new Date().toISOString(), sourceHistory: source, phase: 'active', reason: null});});
    assert.equal(app.taskIndex.listProject(seed.projectId).length, 512);
  } finally {app.close();}
  const host = f.open(), window = await host.manager.acquire(seed.projectId, 'window');
  assert.equal(host.library.taskIndex.listProject(seed.projectId).length, 1);
  assert.equal(host.library.taskIndex.listProject(seed.projectId)[0]!.taskId, job.id);
  await until(() => f.calls.submit === 1 && f.calls.poll > 0, 'The repaired task was not safely dispatched');
  window.release();
  await f.completed(host, seed.projectId, String(job.id), requestId, 'accepted-' + requestId);
});
