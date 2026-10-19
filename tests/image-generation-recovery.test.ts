import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync,
  symlinkSync, lstatSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore, ownsStoreLock} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS} from '../packages/contracts/src/images.ts';
import {errorView} from './helpers/test-error.ts';

interface RecoveryInput {projectId: string; name: string; providerId: string; model: string; prompt: string;
  options: Record<string, unknown>; requestId: string; [key: string]: unknown}
interface RecoveryTaskView {id: string; state: string; revision: number; [key: string]: unknown}
interface Acknowledge {id: string; groupId: string; requestId: string; revision: number; state: string;
  response?: Acknowledge; items?: Acknowledge[]; taskId?: string; cancelled?: boolean; [key: string]: unknown}
interface RecoveryFixture {readonly root: string; readonly project: {id: string}; readonly other: {id: string};
  readonly store: ReturnType<typeof openStore>; readonly services: ReturnType<typeof createServices>; readonly calls: number;
  setFault(fault: (label: string, context: unknown) => void): void;
  input(patch?: Record<string, unknown>): RecoveryInput;
  call<T = Acknowledge>(operation: string, input: unknown, context?: unknown): Promise<T>;
  row(id: string): Record<string, unknown> | undefined;
  restart(): Promise<void>;
  get(id: string): Promise<RecoveryTaskView>;
  recovery(task: {id: string; revision: number}, patch?: Record<string, unknown>): Record<string, unknown>}
type Deferred = {promise: Promise<unknown>; resolve: (value?: unknown) => void; reject: (error?: unknown) => void};
interface FixtureOptions {autoRun?: boolean; generate?: (input: RecoveryInput, options: {beforeDispatch: () => void}) => Promise<unknown>}

const repo = fileURLToPath(new URL('..', import.meta.url));
const code = (expected: string) => (error: unknown) => {const failure = errorView(error); return failure.code === expected && !JSON.stringify(error).includes('PRIVATE_SENTINEL');};
const inputFor = (projectId: string, patch: Record<string, unknown> = {}): RecoveryInput => ({projectId, name: 'Recovery image', providerId: 'mock',
  model: IMAGE_MODELS.mock, prompt: 'Synthetic restart and fencing acceptance.', options: {...IMAGE_FIXED_OPTIONS},
  requestId: randomUUID(), ...patch});
let pngPromise: Promise<Buffer> | undefined;
const png = () => pngPromise ??= renderMockImagePng();
const deferred = (): Deferred => {let resolve: Deferred['resolve'] = () => {}, reject: Deferred['reject'] = () => {}; const promise = new Promise<unknown>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const snapshot = (db: DatabaseSync): string => JSON.stringify(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
  .map(({name}) => [name as string, db.prepare(`SELECT * FROM "${name as string}" ORDER BY rowid`).all()]));
const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n: number}).n;
async function until<T>(check: () => T | false | Promise<T | false>, label: string): Promise<T> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {const value = await check(); if (value) return value; await pause(5);}
  assert.fail(`Timed out waiting for ${label}`);
}
async function fixture(t: import('node:test').TestContext, {autoRun = true, generate}: FixtureOptions = {}): Promise<RecoveryFixture> {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-image-recovery-'));
  let store: ReturnType<typeof openStore> | undefined, services: ReturnType<typeof createServices> | undefined, calls = 0, fault: (label: string, context: unknown) => void = () => {};
  const generator = async (input: RecoveryInput, options: {beforeDispatch: () => void}) => {
    calls++;
    if (generate) return generate(input, options);
    options.beforeDispatch(); return {bytes: await png()};
  };
  function start() {
    store = openStore(root);
    services = createServices(store!, new Map(), {env: {}, imageOptions: {autoRun, generate: generator, fault: (label: string, context: unknown) => fault(label, context)}} as never);
  }
  start();
  t.after(async () => {try {await services!.drain();} finally {store!.close(); rmSync(root, {recursive: true, force: true});}});
  const project = await services!.call('project.create', {name: 'Image recovery project'}) as {id: string};
  const other = await services!.call('project.create', {name: 'Foreign project'}) as {id: string};
  const f: RecoveryFixture = {root, project, other, get store() {return store!;}, get services() {return services!;}, get calls() {return calls;},
    setFault(fn) {fault = fn;}, input: patch => inputFor(project.id, patch), call: (op, input) => services.call(op, input),
    row: (id: string) => store!.db.prepare('SELECT * FROM image_tasks WHERE id=?').get(id) as Record<string, unknown> | undefined,
    async restart() {await services!.drain(); store!.close(); start();},
    get: (id: string) => services!.call('image.task.get', {projectId: project.id, taskId: id}) as Promise<RecoveryTaskView>,
    recovery: (task, patch = {}) => ({projectId: project.id, taskId: task.id, expectedRevision: task.revision, requestId: randomUUID(), ...patch}),
  };
  return f;
}
const state = (f: RecoveryFixture, id: string, expected: string) => until(async () => {const value = await f.get(id); return value.state === expected && value;}, `${id} -> ${expected}`);

test('synthetic exception before request receipt rolls back all admission rows and dispatch remains zero', async t => {
  const f = await fixture(t), before = snapshot(f.store.db), input = f.input();
  f.setFault(label => {if (label === 'before_request_receipt') throw Error('synthetic pre-commit fault');});
  await assert.rejects(f.call('image.generate', input), /synthetic pre-commit fault/);
  await pause(0);
  assert.equal(snapshot(f.store.db), before); assert.equal(f.calls, 0);
  assert.equal(await f.call('image.request.get', {projectId: f.project.id, requestId: input.requestId}), null);
  assert.deepEqual(readdirSync(path.join(f.root, 'media')), []);
  f.setFault(() => {}); await f.restart();
  assert.equal((await f.call('image.task.list', {projectId: f.project.id})).items.length, 0); assert.equal(f.calls, 0);
});

test('unknown acceptance ACK is recovered by request lookup; exact replay never enqueues and restart requires explicit cancellation', async t => {
  const f = await fixture(t), input = f.input();
  f.setFault(label => {if (label === 'after_acceptance') throw Error('synthetic lost ACK');});
  await assert.rejects(f.call('image.generate', input), /synthetic lost ACK/);
  f.setFault(() => {});
  const before = snapshot(f.store.db), changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const receipt = await f.call('image.request.get', {projectId: f.project.id, requestId: input.requestId});
  assert.equal(receipt.response.state, 'queued'); assert.equal(f.calls, 0);
  assert.deepEqual(await f.call('image.generate', input), receipt.response); await pause(0);
  assert.equal(snapshot(f.store.db), before); assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.equal(f.calls, 0);
  await f.restart();
  // No renderer instance or original browser session is needed for discovery.
  const discovered = (await f.call('image.task.list', {projectId: f.project.id})).items;
  assert.equal(discovered.length, 1); assert.equal(discovered[0].state, 'interrupted_before_dispatch');
  assert.deepEqual((await f.call('image.request.get', {projectId: f.project.id, requestId: input.requestId})).response, receipt.response);
  assert.deepEqual(await f.call('image.generate', input), receipt.response); assert.equal(f.calls, 0);
  const cancelled = await f.call('image.task.cancelQueued', f.recovery(discovered[0]));
  assert.equal(cancelled.state, 'cancelled_before_dispatch'); assert.equal(f.calls, 0);
});

for (const phase of ['after_dispatch_fence', 'after_result_manifest', 'after_result_receipt', 'after_media_publication', 'before_result_commit'])
  test(`synthetic exception at ${phase} preserves ambiguity or local output, and recovery never regenerates`, async t => {
    const f = await fixture(t), input = f.input();
    f.setFault(label => {if (label === phase) throw Error('PRIVATE_SENTINEL synthetic checkpoint fault');});
    const ack = await f.call('image.generate', input), expected = phase === 'after_dispatch_fence' ? 'outcome_unknown' : 'local_result_error';
    const failed = await state(f, ack.id, expected);
    assert.equal(f.calls, 1); assert.equal(failed.versionId, null); assert.equal(failed.dispatched, true);
    assert.ok(!JSON.stringify(failed).includes('PRIVATE_SENTINEL')); assert.equal(count(f.store.db, 'assets'), 0); assert.equal(count(f.store.db, 'image_versions'), 0);
    const before = snapshot(f.store.db);
    assert.deepEqual((await f.call('image.request.get', {projectId: f.project.id, requestId: input.requestId})).response, ack);
    assert.deepEqual(await f.call('image.generate', input), ack); assert.equal(snapshot(f.store.db), before);
    f.setFault(() => {}); await f.restart();
    const current = await f.get(ack.id); assert.equal(current.state, expected); assert.equal(f.calls, 1);
    if (phase === 'after_dispatch_fence') {
      await assert.rejects(f.call('image.task.recoverResult', f.recovery(current)), code('IMAGE_RESULT_INVALID'));
      await assert.rejects(f.call('image.task.cancelQueued', f.recovery(current)), code('IMAGE_STATE_CONFLICT'));
      assert.equal(f.calls, 1); return;
    }
    const recoveryInput = f.recovery(current), recoveryAck = await f.call('image.task.recoverResult', recoveryInput);
    assert.equal(recoveryAck.state, 'persisting');
    assert.deepEqual(await f.call('image.task.recoverResult', recoveryInput), recoveryAck);
    await assert.rejects(f.call('image.task.cancelQueued', {...recoveryInput, requestId: randomUUID()}), code('IMAGE_REVISION_CONFLICT'));
    await assert.rejects(f.call('image.task.recoverResult', {...recoveryInput, requestId: randomUUID()}), code('IMAGE_REVISION_CONFLICT'));
    const result = await state(f, ack.id, 'succeeded');
    assert.equal(f.calls, 1); assert.equal(count(f.store.db, 'assets'), 1); assert.equal(count(f.store.db, 'image_versions'), 1);
    assert.deepEqual(await f.call('image.task.recoverResult', recoveryInput), recoveryAck, 'historical local-recovery response retained');
    const version = (await f.call('image.version.list', {projectId: f.project.id, groupId: ack.groupId})).items[0];
    assert.equal(version.id, result.versionId); assert.equal(version.number, 1);
    assert.deepEqual(readFileSync(path.join(f.root, 'media', `${version.assetId}.png`)), await png());
    await f.restart(); assert.equal((await f.get(ack.id)).versionId, result.versionId); assert.equal(f.calls, 1);
    assert.equal(count(f.store.db, 'image_versions'), 1);
  });

for (const variant of ['lock-deleted', 'lock-replaced', 'task-deleted', 'task-reassigned', 'group-reassigned', 'input-changed', 'revision-advanced'])
  test(`await boundary fences ${variant} and prevents foreign writes or late private file publication`, async t => {
    const gate = deferred(), entered = deferred();
    const f = await fixture(t, {generate: async (_input, {beforeDispatch}) => {beforeDispatch(); entered.resolve(); return gate.promise;}});
    const ack = await f.call('image.generate', f.input()); await entered.promise;
    const db = f.store.db;
    if (variant === 'lock-deleted') unlinkSync(path.join(f.root, 'server.lock'));
    if (variant === 'lock-replaced') {unlinkSync(path.join(f.root, 'server.lock')); writeFileSync(path.join(f.root, 'server.lock'), '2147483000', {mode: 0o600});}
    if (!variant.startsWith('lock-')) {
      db.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON; DROP TRIGGER immutable_image_task_identity; DROP TRIGGER image_task_state_transitions; DROP TRIGGER immutable_image_group_identity; DROP TRIGGER retain_image_tasks;');
      if (variant === 'task-deleted') db.prepare('DELETE FROM image_tasks WHERE id=?').run(ack.id);
      if (variant === 'task-reassigned') db.prepare('UPDATE image_tasks SET projectId=? WHERE id=?').run(f.other.id, ack.id);
      if (variant === 'group-reassigned') db.prepare('UPDATE image_groups SET projectId=? WHERE id=?').run(f.other.id, ack.groupId);
      if (variant === 'input-changed') db.prepare('UPDATE image_tasks SET input=? WHERE id=?').run(JSON.stringify({...JSON.parse(f.row(ack.id).input), prompt: 'Foreign replacement'}), ack.id);
      if (variant === 'revision-advanced') db.prepare('UPDATE image_tasks SET revision=revision+1 WHERE id=?').run(ack.id);
    }
    const before = snapshot(db), changes = db.prepare('SELECT total_changes() AS n').get()!.n;
    gate.resolve({bytes: await png()});
    // Give the live worker its normal continuation before Stop, so shutdown is
    // not the reason an ownership/revision defect appears to be fenced.
    await pause(100);
    assert.equal(snapshot(db), before);
    // Joining the owned worker also rules out a later publication after return.
    await f.services.drain();
    assert.equal(snapshot(db), before); assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, changes);
    assert.equal(f.calls, 1); assert.deepEqual(readdirSync(path.join(f.root, 'media')), []);
    assert.equal(existsSync(path.join(f.root, 'image-staging')), false);
    if (variant.startsWith('lock-')) assert.equal(ownsStoreLock(f.store), false);
    if (variant === 'lock-replaced') assert.equal(readFileSync(path.join(f.root, 'server.lock'), 'utf8'), '2147483000');
  });

for (const dispatched of [false, true]) test(`bounded Stop joins a noncooperative generator and fences late callbacks (${dispatched ? 'after' : 'before'} dispatch)`, async t => {
  const gate = deferred(), entered = deferred(); let callback;
  const f = await fixture(t, {generate: async (_input, {beforeDispatch}) => {
    callback = beforeDispatch; if (dispatched) beforeDispatch(); entered.resolve(); return gate.promise;
  }});
  const ack = await f.call('image.generate', f.input()); await entered.promise;
  const queued = await f.call('image.generate', f.input({name: 'Still queued'}));
  const started = Date.now(); await f.services.drain();
  assert.ok(Date.now() - started < 2500, 'noncooperative adapter must not consume the five-second shutdown deadline');
  const current = await f.get(ack.id);
  assert.equal(current.state, dispatched ? 'outcome_unknown' : 'interrupted_before_dispatch');
  assert.equal((await f.get(queued.id)).state, 'queued'); assert.equal(f.calls, 1);
  const before = snapshot(f.store.db);
  assert.throws(() => callback(), code('IMAGE_SERVICE_STOPPED'));
  gate.resolve({bytes: await png()}); await pause(20);
  assert.equal(snapshot(f.store.db), before); assert.equal(f.calls, 1);
  assert.equal(count(f.store.db, 'assets'), 0); assert.deepEqual(readdirSync(path.join(f.root, 'media')), []);
  await assert.rejects(f.call('image.generate', f.input()), code('IMAGE_SERVICE_STOPPED'));
  await f.restart(); assert.equal((await f.get(queued.id)).state, 'interrupted_before_dispatch'); assert.equal(f.calls, 1);
});

test('cancellation while another task owns the worker removes only the undispatched task and never calls its generator', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, {generate: async (_input, {beforeDispatch}) => {beforeDispatch(); entered.resolve(); return gate.promise;}});
  const first = await f.call('image.generate', f.input()); await entered.promise;
  const second = await f.call('image.generate', f.input({name: 'Cancel queued only'}));
  const cancelled = await f.call('image.task.cancelQueued', f.recovery(second));
  assert.equal(cancelled.state, 'cancelled_before_dispatch'); assert.equal(cancelled.dispatched, false);
  gate.resolve({bytes: await png()}); await state(f, first.id, 'succeeded'); await pause(10);
  assert.equal((await f.get(second.id)).state, 'cancelled_before_dispatch'); assert.equal(f.calls, 1); assert.equal(count(f.store.db, 'assets'), 1);
});

for (const variant of ['staged-symlink', 'directory-symlink', 'final-conflict', 'receipt-identity', 'receipt-path', 'oversized-receipt'])
  test(`local recovery rejects ${variant}, retains evidence and does not delete foreign bytes`, async t => {
    const f = await fixture(t);
    f.setFault(label => {if (label === 'after_result_receipt') throw Error('synthetic result pause');});
    const ack = await f.call('image.generate', f.input()), local = await state(f, ack.id, 'local_result_error'); f.setFault(() => {});
    const row = f.row(ack.id), receipt = JSON.parse(row.stagedReceipt), directory = path.join(f.root, 'image-staging');
    const external = mkdtempSync(path.join(tmpdir(), 'mioon-image-foreign-')); t.after(() => rmSync(external, {recursive: true, force: true}));
    const foreign = path.join(external, `${ack.id}.png`), foreignBytes = Buffer.from('PRIVATE_SENTINEL retained foreign file');
    writeFileSync(foreign, foreignBytes, {mode: 0o600});
    if (variant === 'staged-symlink') {unlinkSync(path.join(directory, `${ack.id}.png`)); symlinkSync(foreign, path.join(directory, `${ack.id}.png`));}
    if (variant === 'directory-symlink') {renameSync(directory, path.join(f.root, 'original-image-staging')); symlinkSync(external, directory);}
    if (variant === 'final-conflict') writeFileSync(path.join(f.root, 'media', `${receipt.assetId}.png`), foreignBytes, {mode: 0o600});
    if (variant.startsWith('receipt-') || variant === 'oversized-receipt') {
      f.store.db.exec('PRAGMA ignore_check_constraints=ON; DROP TRIGGER immutable_image_task_identity; DROP TRIGGER image_task_state_transitions;');
      const bad = variant === 'receipt-identity' ? {...receipt, projectId: f.other.id} : variant === 'receipt-path' ? {...receipt, assetId: '../foreign'} : {...receipt, private: 'PRIVATE_SENTINEL'.repeat(400)};
      f.store.db.prepare('UPDATE image_tasks SET stagedReceipt=? WHERE id=?').run(JSON.stringify(bad), ack.id);
      const before = snapshot(f.store.db);
      await assert.rejects(f.call('image.task.recoverResult', f.recovery(local)), code('IMAGE_RECORD_INVALID'));
      await assert.rejects(f.get(ack.id), code('IMAGE_RECORD_INVALID')); assert.equal(snapshot(f.store.db), before);
    } else {
      const input = f.recovery(local), accepted = await f.call('image.task.recoverResult', input);
      assert.equal(accepted.state, 'persisting'); await state(f, ack.id, 'local_result_error');
    }
    assert.deepEqual(readFileSync(foreign), foreignBytes); assert.equal(f.calls, 1);
    assert.equal(count(f.store.db, 'assets'), 0); assert.equal(count(f.store.db, 'image_versions'), 0);
    if (variant === 'staged-symlink') assert.equal(lstatSync(path.join(directory, `${ack.id}.png`)).isSymbolicLink(), true);
    if (variant === 'directory-symlink') assert.equal(lstatSync(directory).isSymbolicLink(), true);
    if (variant === 'final-conflict') assert.deepEqual(readFileSync(path.join(f.root, 'media', `${receipt.assetId}.png`)), foreignBytes);
  });

function childEnvironment() {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(?:MIOON_|RUNWAY|ARK_|VEO_|GEMINI_|GOOGLE_|MINIMAX_|VIDU_|OPENAI_|ANTHROPIC_|AZURE_|AWS_|NODE_OPTIONS$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key)) delete env[key];
  return {...env, MIOON_ENABLE_LIVE_PROVIDER: '0'};
}
async function child(script, args, expectedCode = 0) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script, ...args],
    {cwd: repo, env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  process.stdout.setEncoding('utf8').on('data', bytes => {stdout += bytes;}); process.stderr.setEncoding('utf8').on('data', bytes => {stderr = (stderr + bytes).slice(-10_000);});
  const timer = setTimeout(() => process.kill('SIGKILL'), 20_000);
  try {
    const [exitCode, signal] = await new Promise((resolve, reject) => {process.once('error', reject); process.once('close', (...result) => resolve(result));});
    assert.equal(signal, null, stderr); assert.equal(exitCode, expectedCode, stdout + stderr); return stdout;
  } finally {clearTimeout(timer);}
}
const childImports = `
  import {openStore} from './packages/business/src/db.ts';
  import {createServices} from './packages/business/src/services.ts';
  import {renderMockImagePng} from './packages/business/src/images/png.ts';
  import {appendFileSync,readFileSync,existsSync} from 'node:fs';
  import path from 'node:path';
  import {randomUUID} from 'node:crypto';
  const [root,encoded,phase]=process.argv.slice(1), input=JSON.parse(encoded), counter=path.join(root,'synthetic-adapter-calls');
  const store=openStore(root);
`;

for (const phase of ['after_dispatch_fence', 'after_result_manifest']) test(`actual process exit at ${phase} restarts without automatic generation or invented result`, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-image-crash-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  const store = openStore(root), services = createServices(store, new Map(), {env: {}, imageOptions: {autoRun: false}});
  const project = await services.call('project.create', {name: 'Actual process crash'}), input = inputFor(project.id);
  await services.drain(); store.close();
  const crash = childImports + `
    const services=createServices(store,new Map(),{env:{},imageOptions:{generate:async(_input,{beforeDispatch})=>{
      appendFileSync(counter,'call\\n',{mode:0o600});beforeDispatch();return {bytes:await renderMockImagePng()};
    },fault:label=>{if(label===phase)process.exit(73);}}});
    await services.call('image.generate',input);
    await new Promise(()=>{});
  `;
  await child(crash, [root, JSON.stringify(input), phase], 73);
  assert.equal(readFileSync(path.join(root, 'synthetic-adapter-calls'), 'utf8'), 'call\n');
  const evidence = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  try {
    const raw = evidence.prepare('SELECT * FROM image_tasks WHERE requestId=?').get(input.requestId);
    assert.equal(raw.state, 'dispatching'); assert.equal(raw.dispatched, 1); assert.equal(raw.stagedReceipt, null);
    assert.equal(count(evidence, 'assets'), 0); assert.equal(count(evidence, 'image_versions'), 0);
    assert.equal(existsSync(path.join(root, 'image-staging', `${raw.id}.json`)), phase === 'after_result_manifest');
  } finally {evidence.close();}
  // This is a new OS process and exclusive owner, not the original worker's catch path.
  const recover = childImports + `
    const services=createServices(store,new Map(),{env:{},imageOptions:{generate:async()=>{
      appendFileSync(counter,'unexpected-call\\n',{mode:0o600});throw Error('recovery invoked provider');
    }}});
    const receipt=await services.call('image.request.get',{projectId:input.projectId,requestId:input.requestId});
    const listing=await services.call('image.task.list',{projectId:input.projectId});
    const task=listing.items[0], raw=store.db.prepare('SELECT * FROM image_tasks WHERE id=?').get(task.id);
    const initial={state:task.state,stagedReceipt:raw.stagedReceipt!==null,assets:store.db.prepare('SELECT count(*) n FROM assets').get().n};
    let outcome,errorCode=null;
    try{
      outcome=await services.call('image.task.recoverResult',{projectId:input.projectId,taskId:task.id,expectedRevision:task.revision,requestId:randomUUID()});
      const deadline=Date.now()+10000;
      while(Date.now()<deadline){const current=await services.call('image.task.get',{projectId:input.projectId,taskId:task.id});if(current.state==='succeeded'){outcome=current;break;}await new Promise(r=>setTimeout(r,5));}
    }catch(error){errorCode=error.code;}
    const final=await services.call('image.task.get',{projectId:input.projectId,taskId:task.id});
    const result={receipt,listing,initial,final,errorCode,calls:readFileSync(counter,'utf8'),versions:store.db.prepare('SELECT count(*) n FROM image_versions').get().n};
    await services.drain();store.close();process.stdout.write(JSON.stringify(result));
  `;
  const result = JSON.parse(await child(recover, [root, JSON.stringify(input), phase]));
  assert.equal(result.receipt.response.state, 'queued'); assert.equal(result.receipt.response.revision, 1);
  assert.equal(result.listing.items.length, 1); assert.equal(result.calls, 'call\n'); assert.equal(result.initial.assets, 0);
  if (phase === 'after_dispatch_fence') {
    assert.equal(result.initial.state, 'outcome_unknown'); assert.equal(result.initial.stagedReceipt, false);
    assert.equal(result.errorCode, 'IMAGE_RESULT_INVALID'); assert.equal(result.final.state, 'outcome_unknown'); assert.equal(result.versions, 0);
  } else {
    assert.equal(result.initial.state, 'local_result_error'); assert.equal(result.initial.stagedReceipt, true);
    assert.equal(result.errorCode, null); assert.equal(result.final.state, 'succeeded'); assert.equal(result.versions, 1);
    assert.ok(existsSync(path.join(root, 'image-staging', `${result.final.id}.json`)), 'durable manifest is retained after recovery');
  }
});
