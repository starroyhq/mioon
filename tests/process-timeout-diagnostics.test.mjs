import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EventEmitter, once} from 'node:events';
import {PassThrough} from 'node:stream';

const wire = readFileSync(new URL('./asset-disposition-transports.test.mjs', import.meta.url), 'utf8');
const guard = readFileSync(new URL('./helpers/inspection-wire-fixture.ts', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./helpers/asset-disposition-wire-fixture.ts', import.meta.url), 'utf8');
function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `actual fixture boundary: ${start}`);
  return source.slice(from, to);
}
const boundedCode = section(wire, 'async function bounded(', '// Only owned ChildProcess');
const stopCode = section(wire, 'async function stopOwned(', '// Test-only observation');
const finishCode = section(wire, 'async function finishOwned(', 'function launch(');
const launchCode = section(wire, 'function launch(', 'async function fixture(');
const create = (names, code, name, values) => new Function(...names, `${code}; return ${name};`)(...values);

function child() {
  const value = new EventEmitter();
  Object.assign(value, {pid: 123, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), signals: []});
  value.kill = signal => { value.signals.push(signal); return true; };
  return value;
}

test('actual CLI deadline remains15s and clears its timer on either settlement', async () => {
  const timers = [], cleared = [];
  const bounded = create(['setTimeout', 'clearTimeout'], boundedCode, 'bounded', [
    (fn, ms) => { const timer = {fn, ms}; timers.push(timer); return timer; }, timer => cleared.push(timer),
  ]);
  const pending = bounded(new Promise(() => {}), 'CLI response');
  assert.equal(timers[0].ms, 15_000); timers[0].fn();
  await assert.rejects(pending, {message: 'CLI response timed out'}); assert.equal(cleared[0], timers[0]);
  assert.equal(await bounded(Promise.resolve('exact'), 'CLI response'), 'exact');
  assert.equal(cleared[1], timers[1]);
});

test('actual owned cleanup uses only its child handle and never signals after observed exit', async () => {
  const timers = [], cleared = [], limits = [];
  const stop = create(['once', 'setTimeout', 'clearTimeout', 'bounded'], stopCode, 'stopOwned', [once,
    (fn, ms) => { const timer = {fn, ms}; timers.push(timer); return timer; }, timer => cleared.push(timer),
    (promise, label, ms) => { limits.push({label, ms}); return promise; },
  ]);
  await stop(null); const exited = child(); exited.exitCode = 0; await stop(exited);
  assert.deepEqual(exited.signals, []); assert.equal(timers.length, 0);
  const owned = child(), pending = stop(owned); assert.deepEqual(owned.signals, ['SIGTERM']);
  assert.equal(timers[0].ms, 3_000); assert.equal(limits[0].ms, 6_000);
  owned.exitCode = 0; timers[0].fn(); assert.deepEqual(owned.signals, ['SIGTERM']);
  owned.emit('close', 0, null); await pending; assert.equal(cleared[0], timers[0]);
  const running = child(), killed = stop(running); timers[1].fn();
  assert.deepEqual(running.signals, ['SIGTERM', 'SIGKILL']); running.signalCode = 'SIGKILL';
  running.emit('close', null, 'SIGKILL'); await killed;
});

test('CLI timeout captures diagnostics and waits for exact-child cleanup before returning original failure', async () => {
  const error = Error('CLI response timed out'), cleanup = Promise.withResolvers(), events = [], owned = child();
  const finish = create(['bounded', 'stopOwned'], finishCode, 'finishOwned', [
    async (_promise, label) => { assert.equal(label, 'CLI response'); throw error; },
    value => { assert.equal(value, owned); events.push('cleanup'); return cleanup.promise; },
  ]);
  let settled = false;
  const pending = finish(new Promise(() => {}), owned, () => ({stage: 'timeout'}), value => events.push(value)).catch(value => { settled = true; throw value; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false);
  assert.deepEqual(events, [{stage: 'timeout'}, 'cleanup']); cleanup.resolve();
  await assert.rejects(pending, value => value === error);
});

test('unconfirmed cleanup preserves the original deadline failure and emits no false confirmed release', async () => {
  const error = Error('CLI response timed out'), observations = [];
  const finish = create(['bounded', 'stopOwned'], finishCode, 'finishOwned', [async () => { throw error; }, async () => { throw Error('cleanup timeout'); }]);
  await assert.rejects(finish(new Promise(() => {}), child(), () => ({phase: 'before cleanup'}), value => observations.push(value)), value => value === error);
  assert.deepEqual(observations, [{phase: 'before cleanup'}, {cleanup: 'unconfirmed owned-child close'}]);
});

test('actual CLI snapshot bounds and allowlists phase data without args, raw output, paths or credentials', async () => {
  const owned = child(); let captured;
  const launch = create(['spawn', 'repo', 'environment', 'stopOwned', 'finishOwned', 'bounded', 'pause', 'noPrivate', 'assert'], launchCode, 'launch', [
    () => owned, '/synthetic-only', value => value, async () => {},
    async (_promise, _child, snapshot) => { captured = snapshot(); return {code: 0, signal: null}; },
    () => {}, () => {}, () => {}, assert,
  ]);
  const run = launch({after() {}}, ['secret-argument'], {}, 'shot.update'); owned.emit('spawn');
  for (let i = 0; i < 40; i++) owned.stderr.write('MIOON_WIRE_PHASE ' + JSON.stringify({stage: 'fetch-start', uptimeMs: i, maxRSS: 123, secret: 'never expose', path: '/private', systemCPUTime: -1}) + '\n');
  owned.stderr.write('MIOON_WIRE_PHASE {"stage":"unknown","secret":"never expose"}\n');
  owned.stdout.write('{"ok":true,"data":{"secret":"never expose"}}');
  owned.exitCode = 0; owned.emit('exit', 0, null); owned.emit('close', 0, null); await run.finish();
  assert.equal(captured.label, 'shot.update'); assert.equal(captured.envelopeObserved, true); assert.equal(captured.phases.length, 16);
  assert.equal(captured.phases[0].uptimeMs, 24); assert.ok(captured.closeMs >= captured.spawnMs);
  assert.doesNotMatch(JSON.stringify(captured), /never expose|private|secret-argument|systemCPUTime/);
  assert.ok(captured.stdoutBytes > 0 && captured.stderrBytes > 0);
});

const fetchCode = section(guard, '  const nativeFetch = globalThis.fetch;', "  for (const name of ['request', 'get'])");
function guardedFetch(nativeFetch, onFetchStage, checkURL = () => {}) {
  const target = {fetch: nativeFetch};
  new Function('globalThis', 'onFetchStage', 'checkURL', fetchCode)(target, onFetchStage, checkURL);
  return target.fetch;
}
test('optional fetch phases preserve exact responses/rejections, guard order and default promise identity', async () => {
  const response = {}, options = {}, events = []; let calls = 0;
  const fetch = guardedFetch((url, value) => { calls++; assert.equal(url, 'synthetic'); assert.equal(value, options); return Promise.resolve(response); }, phase => events.push(phase));
  assert.equal(await fetch('synthetic', options), response); assert.equal(calls, 1); assert.deepEqual(events, ['fetch-start', 'fetch-headers']);
  const rejected = Error('same rejected object'); events.length = 0;
  await assert.rejects(guardedFetch(() => Promise.reject(rejected), phase => events.push(phase))('synthetic'), value => value === rejected);
  assert.deepEqual(events, ['fetch-start', 'fetch-rejected']);
  const denied = Error('denied'); calls = 0; events.length = 0;
  assert.throws(() => guardedFetch(() => { calls++; }, phase => events.push(phase), () => { throw denied; })('synthetic'), value => value === denied);
  assert.equal(calls, 0); assert.deepEqual(events, []);
  const exact = Promise.resolve(response); assert.equal(guardedFetch(() => exact)('synthetic'), exact);
  assert.equal(await guardedFetch(() => Promise.resolve(response), () => { throw Error('observer only'); })('synthetic'), response);
});

test('fixture phases are opt-in, constant-only, capped16 and use no process lifecycle hook', () => {
  const phaseCode = section(fixture, 'let phaseCount = 0;', "if (process.env.MIOON_DISPOSITION_WIRE_GUARD");
  const writes = [], fakeProcess = {env: {MIOON_DISPOSITION_PHASE_TRACE: '1'}, resourceUsage: () => ({userCPUTime: 1, systemCPUTime: 2, maxRSS: 3, extra: 'private'}), uptime: () => 1, stderr: {write: text => writes.push(text)}};
  const trace = new Function('process', phaseCode + ';return phaseTrace;')(fakeProcess);
  for (let i = 0; i < 30; i++) trace('fetch-start');
  assert.equal(writes.length, 16); assert.doesNotMatch(writes.join(''), /private|extra/);
  assert.deepEqual(Object.keys(JSON.parse(writes[0].slice('MIOON_WIRE_PHASE '.length))), ['stage', 'uptimeMs', 'userCPUTime', 'systemCPUTime', 'maxRSS']);
  assert.equal(new Function('process', phaseCode + ';return phaseTrace;')({env: {}}), undefined);
});

const recovery = readFileSync(new URL('./edit-task-process-recovery.test.mjs', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('./helpers/edit-task-process-worker.ts', import.meta.url), 'utf8');
test('actual worker readiness deadline stays10s with its original failure and timer cleanup', async () => {
  const code = section(recovery, 'function deadline(', 'function startWorker('), timers = [], cleared = [];
  const deadline = create(['setTimeout', 'clearTimeout'], code, 'deadline', [
    (fn, ms) => { const timer = {fn, ms}; timers.push(timer); return timer; }, timer => cleared.push(timer),
  ]);
  const pending = deadline(new Promise(() => {}), 'worker ready');
  assert.equal(timers[0].ms, 10_000); timers[0].fn();
  await assert.rejects(pending, {message: 'Timed out: worker ready'}); assert.equal(cleared[0], timers[0]);
  assert.match(recovery, /try \{ ready = await deadline\(worker\.ready, 'worker ready'\); \}/);
  assert.match(recovery, /throw error; \/\/ The fixture's existing owned-worker cleanup/);
});

test('actual worker observations are capped and omit raw output, unknown phases and nonnumeric resource fields', async () => {
  const declarations = section(recovery, 'const startupPhases', 'function deadline(');
  const workerCode = section(recovery, 'function startWorker(', 'async function fixture(');
  const owned = child(); owned.connected = true; owned.send = () => {};
  let tick = 0n;
  const fakeProcess = {execPath: '/synthetic-node', env: {}, hrtime: {bigint: () => (tick += 1000000n)},
    resourceUsage: () => ({userCPUTime: 1, systemCPUTime: -1, maxRSS: 100, secret: 'private'})};
  const start = create(['spawn', 'process', 'workerPath', 'repo', 'deadline', 'randomUUID'], declarations + workerCode, 'startWorker', [
    () => owned, fakeProcess, '/owned-fixture', '/synthetic-repo', promise => promise, () => 'fixed-synthetic-request',
  ]);
  const worker = start('/private-fixture-root'); worker.ready.catch(() => {}); owned.emit('spawn');
  owned.stdout.write('private stdout'); owned.stderr.write('private stderr');
  owned.emit('message', {type: 'startup-phase', phase: 'unknown-secret', elapsedMs: 1});
  owned.emit('message', {type: 'startup-phase', phase: 'open-store-start', elapsedMs: NaN});
  for (let i = 0; i < 30; i++) owned.emit('message', {type: 'startup-phase', phase: 'open-store-start', elapsedMs: i,
    resourceUsage: {userCPUTime: 1, maxRSS: 100, systemCPUTime: -1, fsRead: Infinity, secret: 'private'}});
  const result = worker.startupDiagnostic();
  assert.equal(result.observations.length, 16); assert.ok(result.stdoutBytes > 0 && result.stderrBytes > 0);
  assert.doesNotMatch(JSON.stringify(result), /private|unknown-secret|systemCPUTime|fsRead/);
  assert.deepEqual(result.parentResourceUsage, {userCPUTime: 1, maxRSS: 100});
  assert.ok(result.observations.every(value => Number.isFinite(value.elapsedMs)));
  owned.exitCode = 0; owned.emit('exit', 0, null); owned.emit('close', 0, null); await worker.exited;
});

test('worker fixture milestones contain fixed labels and numeric resource counters only', () => {
  const phaseCode = section(workerSource, 'const startupEntered', 'const crashAt'), observations = [];
  const fakeProcess = {hrtime: {bigint: () => 1000000n}, resourceUsage: () => ({userCPUTime: 1, fsRead: 0, maxRSS: 10, secret: 'private', systemCPUTime: -1})};
  const phase = new Function('process', 'report', phaseCode + ';return startupPhase;')(fakeProcess, value => observations.push(value));
  phase('open-store-start');
  assert.equal(observations[0].phase, 'entry-after-imports');
  assert.deepEqual(observations[1].resourceUsage, {userCPUTime: 1, maxRSS: 10, fsRead: 0});
  assert.doesNotMatch(JSON.stringify(observations), /private|systemCPUTime/);
  assert.deepEqual([...workerSource.matchAll(/startupPhase\('([^']+)'\)/g)].map(match => match[1]),
    ['entry-after-imports', 'open-store-start', 'open-store-end', 'services-start', 'services-end', 'tasks-start', 'tasks-end', 'reconcile-start', 'reconcile-end']);
});
