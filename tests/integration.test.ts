import type {ServiceResponse, MediaJob, MediaShot, GenerationSnapshot} from './helpers/strict-service-responses.ts';
import type {FixtureVersion} from './helpers/strict-timeline-core-types.ts';
import type {AddressInfo} from 'node:net';
interface IntegrationVersion extends FixtureVersion {snapshot: GenerationSnapshot}
type Success<O extends string> = O extends 'version.list' ? IntegrationVersion[] : ServiceResponse<O>;
type RpcResult<O extends string, S extends number> = S extends 200 ? Success<O> : {code: string; message: string; details: Record<string, unknown>};
interface Evidence {startedAt: string; runtime: string; invocation: {executable: string; arguments: string[]}; commands: Record<string, unknown>[]; assertions: Record<string, unknown>[]; processEvents: Record<string, unknown>[]; http: Record<string, unknown>[]; finishedAt?: string; result?: string}
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { BinaryLike } from 'crypto';
import type { ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';

const exec = promisify(execFile), repo = fileURLToPath(new URL('..', import.meta.url));
const evidence = path.join(repo, 'evidence/integration');
const token = 'integration-local-token-minimum-20-characters';
const pause = (ms?: number|undefined) => new Promise(resolve => setTimeout(resolve, ms));
const sha = (bytes: BinaryLike|Buffer<ArrayBuffer>) => createHash('sha256').update(bytes).digest('hex');
const records: Evidence = { startedAt: new Date().toISOString(), runtime: process.version, invocation: { executable: process.execPath, arguments: ['--test', 'tests/integration.test.ts'] }, commands: [], assertions: [], processEvents: [], http: [] };
async function command(file: string, args?: readonly string[]|null|undefined) {
  const startedAt = new Date().toISOString();
  try { const result = await exec(file, args, { maxBuffer: 8 * 1024 * 1024 }); records.commands.push({ file, args, startedAt, exitCode: 0, stdout: result.stdout, stderr: result.stderr }); return result.stdout; }
  catch (error) { records.commands.push({ file, args, startedAt, exitCode: (error as {code: unknown}).code, stdout: (error as {stdout: unknown}).stdout, stderr: (error as {stderr: unknown}).stderr }); throw error; }
}
async function freePort() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as AddressInfo).port; await new Promise(resolve => server.close(resolve)); return port; }
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-http-')), port = await freePort();
  const base = `http://127.0.0.1:${port}`; let processHandle: ChildProcessByStdio<null,Readable,Readable>, processNumber = 0;
  async function start() {
    const number = ++processNumber;
    processHandle = spawn(process.execPath, ['server/index.ts'], { cwd: repo, env: { ...process.env, PORT: String(port), MIOON_DATA_DIR: root, MIOON_TOKEN: token, MIOON_ENABLE_LIVE_PROVIDER: '0', RUNWAYML_API_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; processHandle.stdout.setEncoding('utf8').on('data', data => stdout += data); processHandle.stderr.setEncoding('utf8').on('data', data => stderr += data);
    const childPid = processHandle.pid; processHandle.on('close', (code, signal) => records.processEvents.push({ number, pid: childPid, code, signal, stdout, stderr }));
    records.processEvents.push({ action: 'spawn', number, pid: processHandle.pid, port, dataDirectory: root });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { if (processHandle.exitCode !== null) throw Error(`Backend exited: ${stderr}`); try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {} await pause(40); }
    throw Error(`Backend failed to start: ${stderr}`);
  }
  async function stop(signal: NodeJS.Signals|number = 'SIGTERM') { if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode) return; const child = processHandle; const ended = once(child, 'exit'); records.processEvents.push({ action: 'kill', pid: child.pid, signal }); child.kill(signal); await ended; }
  async function rpc<O extends string, S extends number = 200>(operation: O, input: Record<string, unknown> = {}, expectedStatus: S = 200 as S, headers: HeadersInit = {}): Promise<RpcResult<O, S>> {
    const response = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ operation, input }) });
    const body = await response.json();
    records.http.push({ at: new Date().toISOString(), operation, input: input.dataBase64 ? { ...input, dataBase64: `[${(input.dataBase64 as string).length} base64 characters]` } : input, status: response.status, body });
    assert.equal(response.status, expectedStatus, `${operation}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, expectedStatus === 200, JSON.stringify(body));
    return (body.ok ? body.data : body.error) as RpcResult<O, S>;
  }
  async function until(jobId: string, predicate: (arg0: MediaJob) => unknown, timeout: number = 45_000) { const start = Date.now(); let job: MediaJob | undefined; while (Date.now() - start < timeout) { job = await rpc('job.get', { jobId }); if (predicate(job)) return job; await pause(100); } throw Error(`Job did not reach expected state: ${JSON.stringify(job)}`); }
  function inspect<T>(callback: (db: DatabaseSync) => T): T { const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), { readOnly: true }); try { return callback(db); } finally { db.close(); } }
  function ledger(requestId: string) { return inspect(db => ({ submissions: db.prepare('SELECT * FROM mock_provider_submissions WHERE request_id=?').all(requestId), tasks: db.prepare('SELECT * FROM mock_provider_tasks WHERE request_id=?').all(requestId) })); }
  t.after(async () => { await stop(); await mkdir(evidence, { recursive: true }); records.finishedAt = new Date().toISOString(); records.result = records.assertions.length === 8 ? 'passed' : 'failed_or_incomplete'; await writeFile(path.join(evidence, 'acceptance.json'), JSON.stringify(records, null, 2)); await rm(root, { recursive: true, force: true }); });
  await start(); return { root, port, base, start, stop, rpc, until, inspect, ledger };
}

test('durable HTTP acceptance: real process restarts, provider side effects, media and security', { timeout: 240_000 }, async t => {
  const f = await fixture(t), rpc = f.rpc;
  const imagePath = path.join(f.root, 'fixture.png'), videoPath = path.join(f.root, 'fixture.mp4');
  await command('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=1', '-frames:v', '1', '-threads', '1', imagePath]);
  await command('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24', '-t', '0.5', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', videoPath]);
  const imageBytes = await readFile(imagePath), videoBytes = await readFile(videoPath);
  const project = await rpc('project.create', { name: 'Acceptance · durable three-shot sequence', description: 'Synthetic fixture media; no paid provider calls.' });
  const image = await rpc('asset.import', { projectId: project.id, name: 'reference.png', mimeType: 'image/png', dataBase64: imageBytes.toString('base64') });
  const video = await rpc('asset.import', { projectId: project.id, name: 'reference.mp4', mimeType: 'video/mp4', dataBase64: videoBytes.toString('base64') });
  const shots: MediaShot[] = [];
  for (let i = 0; i < 3; i++) shots.push(await rpc('shot.create', { projectId: project.id, title: `Shot ${i + 1}`, prompt: `Initial prompt ${i + 1}`, referenceAssetIds: [image.id], duration: 2, position: { x: 100 + i * 300, y: 200 + i * 40 } }));
  const text = await rpc('node.create', { projectId: project.id, type: 'text', text: 'Persistent direction', position: { x: 10, y: 40 } });
  const imageNode = await rpc('node.create', { projectId: project.id, type: 'image', assetId: image.id, position: { x: 40, y: 400 } });
  const videoNode = await rpc('node.create', { projectId: project.id, type: 'video', assetId: video.id, position: { x: 400, y: 400 } });
  const edge = await rpc('edge.create', { projectId: project.id, source: text.id, target: shots[0].id });
  let latest = await rpc('shot.update', { shotId: shots[0].id, expectedRevision: shots[0].revision, patch: { prompt: 'Durable revised prompt', position: { x: 755, y: 123 } } });
  const order = [shots[2].id, shots[0].id, shots[1].id];
  const beforeOrder = (await rpc('project.get', { projectId: project.id })).project;
  await rpc('shot.reorder', { projectId: project.id, expectedRevision: beforeOrder.revision, shotIds: order });
  const beforeRestart = await rpc('project.get', { projectId: project.id });

  await t.test('A2 three shots, both import types, prompt, positions, sequence and graph survive actual SIGKILL', async () => {
    const pidBefore = f.inspect(db => db.prepare('PRAGMA journal_mode').get()); assert.equal((pidBefore)!.journal_mode, 'wal');
    await f.stop('SIGKILL'); await f.start();
    const after = await rpc('project.get', { projectId: project.id }); assert.deepEqual(after, beforeRestart);
    assert.deepEqual(after.shots.map(s => s.id), order); assert.equal(after.shots.length, 3); assert.equal(after.assets.length, 2);
    assert.equal((after.shots.find(s => s.id === shots[0].id))!.prompt, 'Durable revised prompt');
    assert.deepEqual((after.shots.find(s => s.id === shots[0].id))!.position, { x: 755, y: 123 });
    for (const asset of [image, video]) { const response = await fetch(f.base + asset.url, { headers: { authorization: `Bearer ${token}` } }); assert.equal(response.status, 200); assert.equal(sha(Buffer.from(await response.arrayBuffer())), asset.sha256); }
    records.assertions.push({ id: 'A2', result: 'passed', projectId: project.id, shotIds: order, imageNodeId: imageNode.id, videoNodeId: videoNode.id, edgeId: edge.id, restart: 'actual SIGKILL and new child process' });
  });

  let firstInput: Record<string, unknown> & {requestId: string} | undefined, firstJob!: MediaJob, secondVersion!: IntegrationVersion;
  await t.test('A4 twenty concurrent replays plus stale replay create one durable provider submission and accepted task', async () => {
    firstInput = { shotId: latest.id, expectedRevision: latest.revision, requestId: randomUUID(), providerId: 'mock', parameters: { scenario: 'delay', delayMs: 3000 } };
    const results = await Promise.all(Array.from({ length: 20 }, () => rpc('generation.submit', firstInput)));
    assert.equal(new Set(results.map(job => job.id)).size, 1); firstJob = results[0];
    latest = await rpc('shot.update', { shotId: latest.id, expectedRevision: latest.revision, patch: { prompt: 'Later prompt must not mutate the running snapshot' } });
    assert.equal((await rpc('generation.submit', firstInput)).id, firstJob.id);
    const running = await f.until(firstJob.id, (j: { status: string; }) => j.status === 'running'); assert.ok(running.providerJobId);
    const before = f.ledger(firstInput.requestId); assert.equal(before.submissions.length, 1); assert.equal(before.tasks.length, 1);
    await f.stop('SIGKILL'); await f.start();
    const finished = await f.until(firstJob.id, (j: { status: string; }) => j.status === 'succeeded'); assert.equal(finished.providerJobId, running.providerJobId); assert.equal(finished.submissionCount, 1);
    const after = f.ledger(firstInput.requestId); assert.equal(after.submissions.length, 1); assert.equal(after.tasks.length, 1); assert.equal(after.tasks[0].provider_job_id, before.tasks[0].provider_job_id);
    assert.equal((await rpc('generation.submit', firstInput)).id, firstJob.id);
    records.assertions.push({ id: 'A4-concurrent-and-restart', result: 'passed', jobId: firstJob.id, parallelReplays: 20, ledger: after });
  });

  await t.test('A5 stale shot, node, ordering and selected-version writes return HTTP 409 and preserve latest state', async () => {
    const before = await rpc('project.get', { projectId: project.id }); const shot = before.shots.find(s => s.id === latest.id);
    assert.equal((await rpc('shot.update', { shotId: (shot)!.id, expectedRevision: 1, patch: { prompt: 'STALE' } }, 409)).code, 'REVISION_CONFLICT');
    const node = await rpc('node.update', { nodeId: text.id, expectedRevision: text.revision, patch: { text: 'Latest node text' } });
    assert.equal((await rpc('node.update', { nodeId: text.id, expectedRevision: text.revision, patch: { text: 'STALE' } }, 409)).code, 'REVISION_CONFLICT');
    assert.equal((await rpc('shot.reorder', { projectId: project.id, expectedRevision: beforeOrder.revision, shotIds: [...order].reverse() }, 409)).code, 'REVISION_CONFLICT');
    const [version] = await rpc('version.list', { shotId: (shot)!.id });
    assert.equal((await rpc('version.select', { shotId: (shot)!.id, versionId: version.id, expectedRevision: 1 }, 409)).code, 'REVISION_CONFLICT');
    const after = await rpc('project.get', { projectId: project.id }); assert.deepEqual(after.shots, before.shots); assert.equal(after.project.revision, before.project.revision); assert.deepEqual(after.nodes.find(n => n.id === text.id), node);
    records.assertions.push({ id: 'A5', result: 'passed', checked: ['shot', 'node', 'shot order', 'version selection'], expectedStatus: 409 });
  });

  await t.test('A6 two real immutable versions survive later edits; original replay works and different reuse conflicts', async () => {
    const [v1] = await rpc('version.list', { shotId: latest.id }); const beforeBytes = await (await fetch(f.base + v1.url, { headers: { authorization: `Bearer ${token}` } })).arrayBuffer(); assert.equal(sha(Buffer.from(beforeBytes)), v1.sha256);
    const shot = (await rpc('project.get', { projectId: project.id })).shots.find(s => s.id === latest.id);
    const changed = await rpc('shot.update', { shotId: (shot)!.id, expectedRevision: (shot)!.revision, patch: { prompt: 'A different second-version prompt', position: { x: 777, y: 333 } } });
    const second = await rpc('generation.submit', { shotId: changed.id, expectedRevision: changed.revision, requestId: randomUUID(), providerId: 'mock' }); await f.until(second.id, (j: { status: string; }) => j.status === 'succeeded');
    const versions = await rpc('version.list', { shotId: (shot)!.id }); assert.equal(versions.length, 2); assert.deepEqual(versions[0], v1); secondVersion = versions[1]; assert.notEqual(secondVersion.sha256, v1.sha256); assert.notEqual(secondVersion.snapshot.prompt, v1.snapshot.prompt);
    const current = (await rpc('project.get', { projectId: project.id })).shots.find(s => s.id === (shot)!.id);
    await rpc('shot.update', { shotId: (shot)!.id, expectedRevision: (current)!.revision, patch: { prompt: 'Third edit after both immutable versions' } });
    assert.deepEqual(await rpc('version.list', { shotId: (shot)!.id }), versions);
    const afterBytes = await (await fetch(f.base + v1.url, { headers: { authorization: `Bearer ${token}` } })).arrayBuffer(); assert.equal(sha(Buffer.from(afterBytes)), v1.sha256);
    assert.equal((await rpc('generation.submit', firstInput)).id, firstJob.id);
    assert.equal((await rpc('generation.submit', { ...firstInput, parameters: { scenario: 'success' } }, 409)).code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(f.ledger((firstInput)!.requestId).submissions.length, 1);
    records.assertions.push({ id: 'A6', result: 'passed', versions: versions.map(v => ({ id: v.id, sha256: v.sha256, snapshot: v.snapshot })) });
  });

  const scenarioProject = await rpc('project.create', { name: 'Failure and recovery matrix' });
  const scenarioImage = await rpc('asset.import', { projectId: scenarioProject.id, name: 'reference.png', mimeType: 'image/png', dataBase64: imageBytes.toString('base64') });
  async function scenario(name: string, delayMs?: number|undefined) { const shot = await rpc('shot.create', { projectId: scenarioProject.id, title: name, prompt: `Synthetic ${name}`, referenceAssetIds: [scenarioImage.id], duration: 2 }); const requestId = randomUUID(); return rpc('generation.submit', { shotId: shot.id, expectedRevision: shot.revision, requestId, providerId: 'mock', parameters: { scenario: name, ...(delayMs === undefined ? {} : { delayMs }) } }); }

  await t.test('A7 rejection, terminal failure, unknown, poll timeout, download retry, accepted-response loss and local cancellation', async () => {
    const reject = await scenario('reject'); const rejected = await f.until(reject.id, (j: { status: string; }) => j.status === 'failed'); assert.equal(rejected.phase, 'submit_failed'); assert.equal(f.ledger(reject.requestId).tasks.length, 0);
    const failure = await scenario('failure'); await f.until(failure.id, (j: { status: string; }) => j.status === 'failed'); assert.equal(f.ledger(failure.requestId).tasks.length, 1);
    const retryId = randomUUID(), retry = await rpc('job.retry', { jobId: failure.id, requestId: retryId }); assert.notEqual(retry.id, failure.id); assert.equal(retry.retryOfJobId, failure.id); assert.deepEqual(retry.snapshot, failure.snapshot); assert.equal((await rpc('job.retry', { jobId: failure.id, requestId: retryId })).id, retry.id); await f.until(retry.id, (j: { status: string; }) => j.status === 'failed'); assert.equal(f.ledger(retryId).submissions.length, 1);
    const unknown = await scenario('unknown'); await f.until(unknown.id, (j: { status: string; }) => j.status === 'submission_unknown'); assert.equal((await rpc('job.retry', { jobId: unknown.id, requestId: randomUUID() }, 409)).code, 'UNSAFE_RETRY'); await rpc('job.reconcile', { jobId: unknown.id }); assert.equal(f.ledger(unknown.requestId).submissions.length, 1); assert.equal(f.ledger(unknown.requestId).tasks.length, 0);
    const timeout = await scenario('timeout'); const timedOut = await f.until(timeout.id, (j: MediaJob) => j.status === 'running' && j.error?.code === 'PROVIDER_POLL_TIMEOUT'); assert.ok(timedOut.providerJobId); assert.equal((await rpc('job.retry', { jobId: timeout.id, requestId: randomUUID() }, 409)).code, 'UNSAFE_RETRY');
    const recovery = await scenario('poll_timeout_then_recover'); await f.until(recovery.id, (j: MediaJob) => j.status === 'running' && j.error?.code === 'PROVIDER_POLL_TIMEOUT'); await f.until(recovery.id, (j: { status: string; }) => j.status === 'succeeded'); assert.equal(f.ledger(recovery.requestId).submissions.length, 1);
    const download = await scenario('download_fail_once'); const downloading = await f.until(download.id, (j: MediaJob) => j.status === 'downloading' && j.error?.code === 'DOWNLOAD_FAILED'); const downloadTaskId = downloading.providerJobId; await f.until(download.id, (j: { status: string; }) => j.status === 'succeeded'); const downloadLedger = f.ledger(download.requestId); assert.equal(downloadLedger.submissions.length, 1); assert.equal(downloadLedger.tasks.length, 1); assert.equal(downloadLedger.tasks[0].download_attempts, 2); assert.equal(downloadLedger.tasks[0].provider_job_id, downloadTaskId);
    const lost = await scenario('accepted_then_response_lost'); await f.until(lost.id, (j: { status: string; }) => j.status === 'submission_unknown'); const recovered = await f.until(lost.id, (j: { status: string; }) => j.status === 'succeeded'); const lostLedger = f.ledger(lost.requestId); assert.equal(lostLedger.submissions.length, 1); assert.equal(lostLedger.tasks.length, 1); assert.equal(lostLedger.submissions[0].outcome, 'accepted_response_lost'); assert.equal(recovered.providerJobId, lostLedger.tasks[0].provider_job_id);
    const delayed = await scenario('delay', 20_000); await f.until(delayed.id, (j: { status: string; }) => j.status === 'running'); const cancelled = await rpc('job.cancel', { jobId: delayed.id }); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.cancelScope, 'local_only'); assert.equal(cancelled.phase, 'local_wait_stopped'); assert.equal((cancelled.error)!.code, 'LOCAL_WAIT_STOPPED'); assert.equal(f.ledger(delayed.requestId).tasks[0].cancelled, 0);
    await rpc('job.cancel', { jobId: timeout.id }); await rpc('job.cancel', { jobId: unknown.id });
    records.assertions.push({ id: 'A7', result: 'passed', jobIds: [reject, failure, retry, unknown, timeout, recovery, download, lost, delayed].map(j => j.id), downloadLedger, lostLedger, cancellation: cancelled });
  });

  await t.test('A4 interrupted submitting state without provider ID becomes unknown and never POSTs', async () => {
    await f.stop('SIGKILL'); const injectedId = randomUUID(), requestId = randomUUID();
    const db = new DatabaseSync(path.join(f.root, 'workbench.sqlite'));
    try { const existing = JSON.parse((db.prepare('SELECT data FROM jobs WHERE id=?').get(firstJob.id))!.data as string); const injected = { ...existing, id: injectedId, requestId, status: 'submitting', phase: 'provider_submit', providerJobId: null, versionId: null, submissionCount: 1, error: null, nextPollAt: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(injected.id, injected.projectId, JSON.stringify(injected)); }
    finally { db.close(); }
    records.processEvents.push({ action: 'fault-injection', target: 'isolated fixture database only', jobId: injectedId, state: 'submitting', providerJobId: null });
    await f.start(); const recovered = await f.until(injectedId, (j: { status: string; }) => j.status === 'submission_unknown'); assert.equal(recovered.providerJobId, null);
    await pause(5300); assert.equal((await rpc('job.get', { jobId: injectedId })).status, 'submission_unknown'); assert.equal(f.ledger(requestId).submissions.length, 0); assert.equal(f.ledger(requestId).tasks.length, 0); assert.equal((await rpc('job.retry', { jobId: injectedId, requestId: randomUUID() }, 409)).code, 'UNSAFE_RETRY');
    records.assertions.push({ id: 'A4-submission-intent-gap', result: 'passed', jobId: injectedId, durableSubmitInvocations: 0, state: recovered.status, observedMilliseconds: 5300 });
    await rpc('job.cancel', { jobId: injectedId });
  });

  await t.test('security denies unauthenticated, foreign Host/Origin, paths, URLs, cross-project references and invalid MIME', async () => {
    assert.equal((await rpc('project.list', {}, 401, { authorization: '' })).code, 'UNAUTHORIZED');
    assert.equal((await rpc('project.list', {}, 403, { origin: 'https://evil.invalid' })).code, 'ORIGIN_REJECTED');
    // Node's fetch discards Host overrides; use actual HTTP wire headers here.
    const foreignHost = await new Promise<{status: number | undefined; body: {error: {code: string}}}>((resolve, reject) => { const req = http.request(f.base + '/api/rpc', { method: 'POST', headers: { Host: 'evil.invalid', authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, response => { let raw = ''; response.on('data', bytes => raw += bytes); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(raw) })); }); req.on('error', reject); req.end(JSON.stringify({ operation: 'project.list', input: {} })); });
    assert.equal(foreignHost.status, 403); assert.equal(foreignHost.body.error.code, 'ORIGIN_REJECTED'); records.http.push({ operation: 'project.list', transport: 'node:http', sentHost: 'evil.invalid', ...foreignHost });
    assert.equal((await fetch(f.base + image.url)).status, 401);
    const login = await fetch(f.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }); assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie')!, /HttpOnly/); assert.match(login.headers.get('set-cookie')!, /SameSite=Strict/);
    const baseImport = { projectId: project.id, name: 'bad', mimeType: 'image/png', dataBase64: imageBytes.toString('base64') };
    assert.equal((await rpc('asset.import', { ...baseImport, path: '/etc/passwd' }, 400)).code, 'VALIDATION_ERROR');
    assert.equal((await rpc('asset.import', { ...baseImport, url: 'http://169.254.169.254/latest/meta-data/' }, 400)).code, 'VALIDATION_ERROR');
    assert.equal((await rpc('asset.import', { ...baseImport, mimeType: 'video/mp4' }, 400)).code, 'INVALID_MEDIA');
    assert.equal((await rpc('asset.import', { ...baseImport, dataBase64: Buffer.from('not media').toString('base64') }, 400)).code, 'INVALID_MEDIA');
    assert.equal((await rpc('shot.create', { projectId: scenarioProject.id, title: 'cross project', referenceAssetIds: [image.id] }, 400)).code, 'CROSS_PROJECT_REFERENCE');
    assert.equal((await rpc('node.create', { projectId: scenarioProject.id, type: 'image', assetId: image.id, position: { x: 0, y: 0 } }, 400)).code, 'CROSS_PROJECT_REFERENCE');
    assert.equal((await rpc('edge.create', { projectId: scenarioProject.id, source: text.id, target: shots[0].id }, 400)).code, 'INVALID_EDGE');
    const otherShot = (await rpc('project.get', { projectId: scenarioProject.id })).shots[0];
    assert.equal((await rpc('version.select', { shotId: otherShot.id, expectedRevision: otherShot.revision, versionId: secondVersion.id }, 400)).code, 'INVALID_VERSION');
    const publicState = JSON.stringify(await rpc('project.get', { projectId: project.id })); assert.ok(!publicState.includes(f.root)); assert.ok(!publicState.includes('relativePath')); assert.ok(!publicState.includes('requestHash')); assert.ok(!publicState.includes(token));
    const capabilities = await rpc('provider.list'); assert.equal((capabilities.find((p: { id: string; }) => p.id === 'runway'))!.enabled, false);
    const s = (await rpc('project.get', { projectId: project.id })).shots[0]; assert.equal((await rpc('generation.submit', { shotId: s.id, expectedRevision: s.revision, requestId: randomUUID(), providerId: 'runway' }, 403)).code, 'PROVIDER_DISABLED');
    assert.equal((await rpc('unregistered.operation', {}, 404)).code, 'UNKNOWN_OPERATION');
    const unassigned = await scenario('unknown'); await f.until(unassigned.id, (j: { status: string; }) => j.status === 'submission_unknown');
    const sourceJob = await rpc('job.get', { jobId: firstJob.id });
    assert.equal((await rpc('job.reconcile', { jobId: unassigned.id, providerJobId: sourceJob.providerJobId }, 409)).code, 'TASK_ID_CONFLICT');
    const untouched = await rpc('job.get', { jobId: unassigned.id }); assert.equal(untouched.providerJobId, null); assert.equal(untouched.status, 'submission_unknown');
    assert.equal(f.ledger(unassigned.requestId).tasks.length, 0); await rpc('job.cancel', { jobId: unassigned.id });
    records.assertions.push({ id: 'security', result: 'passed', guards: ['authentication', 'media auth', 'Host', 'Origin', 'HttpOnly SameSite cookie', 'strict schema path and URL denial', 'MIME bytes', 'project association', 'cross-job provider task ownership', 'public serialization', 'live provider disabled', 'unknown operation denial'] });
  });

  await t.test('A8 export stitches three genuine clips into default native H264 1080x1920 MP4 with summed duration', async () => {
    for (const shot of (await rpc('project.get', { projectId: project.id })).shots) if (!shot.selectedVersionId) { const job = await rpc('generation.submit', { shotId: shot.id, expectedRevision: shot.revision, requestId: randomUUID(), providerId: 'mock' }); await f.until(job.id, (j: { status: string; }) => j.status === 'succeeded'); }
    const state = await rpc('project.get', { projectId: project.id }); const selected = state.shots.map(s => state.versions.find(v => v.id === s.selectedVersionId)); assert.equal(selected.length, 3);
    const expectedDuration = selected.reduce((sum, v) => sum + (state.assets.find(a => a.id === v!.assetId))!.duration, 0);
    const requestId = randomUUID(), exported = await rpc('export.create', { projectId: project.id, requestId }); assert.deepEqual(exported.orderedVersionIds, selected.map(v => (v)!.id)); assert.equal((await rpc('export.create', { projectId: project.id, requestId })).id, exported.id);
    let done; const deadline = Date.now() + 60_000; do { done = await rpc('export.get', { exportId: exported.id }); if (done.status === 'succeeded' || done.status === 'failed') break; await pause(150); } while (Date.now() < deadline); assert.equal(done.status, 'succeeded', JSON.stringify(done));
    const response = await fetch(f.base + done.url, { headers: { authorization: `Bearer ${token}` } }); assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer()); const file = path.join(evidence, 'three-shot-portrait.mp4'); await mkdir(evidence, { recursive: true }); await writeFile(file, bytes);
    const probed = JSON.parse(await command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])); const stream = probed.streams.find((s: { codec_type: string; }) => s.codec_type === 'video'); assert.equal(stream.codec_name, 'h264'); assert.equal(stream.width, 1080); assert.equal(stream.height, 1920); assert.ok(Math.abs(Number(probed.format.duration) - expectedDuration) < 0.15); assert.match(probed.format.format_name, /mp4/);
    await command('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
    await writeFile(path.join(evidence, 'export-probe.json'), JSON.stringify(probed, null, 2));
    const range = await fetch(f.base + done.url, { headers: { authorization: `Bearer ${token}`, range: 'bytes=0-31' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
    records.assertions.push({ id: 'A8-export', result: 'passed', exportId: exported.id, orderedVersionIds: exported.orderedVersionIds, clipCount: 3, expectedDuration, actualDuration: Number(probed.format.duration), sha256: sha(bytes), bytes: bytes.length, codec: stream.codec_name, width: stream.width, height: stream.height, fullDecodeExitCode: 0 });
  });
});
