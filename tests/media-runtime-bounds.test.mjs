import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaEnvironment, mediaExecutable } from '../packages/business/src/media-environment.mjs';
import { run, MEDIA_RUNTIME_LIMITS } from '../packages/business/src/media-runtime.mjs';
import { spawnMedia, onMediaProcess, terminateMediaProcess, terminateMediaProcesses, waitForMediaProcesses, hasUnconfirmedMediaProcesses, MEDIA_TERMINATION_POLICY } from '../packages/business/src/media-processes.mjs';

const fixture = fileURLToPath(new URL('./helpers/media-child-fixture.mjs', import.meta.url));
const exec = promisify(execFile), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const forbidden = ['RUNWAYML_API_SECRET', 'MIOON_AGENT_API_KEY', 'MIOON_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FFREPORT', 'MIOON_FFMPEG_PATH', 'UNRELATED_SECRET'];
async function sandbox(t) { const root = await mkdtemp(path.join(tmpdir(), 'media-bounds-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function ready(file) { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (await stat(file).catch(() => null)) return; await pause(10); } throw Error('Synthetic child did not become ready'); }
const rejected = code => error => error.code === code && !error.message.includes('synthetic-private') && !error.message.includes('fixture') && !Object.hasOwn(error, 'cause');

test('explicit environment policy only copies platform/locale keys from synthetic dictionaries', () => {
  const source = { PATH: '/synthetic/bin', HOME: '/synthetic/home', TMPDIR: '/synthetic/tmp', LANG: 'C.UTF-8', LC_ALL: 'C', LC_CTYPE: 'C', SystemRoot: 'C:\\SyntheticWindows', USERPROFILE: 'C:\\SyntheticHome', ...Object.fromEntries(forbidden.map(key => [key, 'sentinel-never-forward'])) };
  const linux = mediaEnvironment(source, { platform: 'linux' });
  assert.deepEqual(Object.keys(linux).sort(), ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TMPDIR']);
  for (const key of forbidden) assert.equal(Object.hasOwn(linux, key), false);
  assert.equal(linux.PATH, source.PATH);
  const windows = mediaEnvironment({ Path: 'C:\\SyntheticTools', systemroot: 'C:\\SyntheticWindows', USERPROFILE: 'C:\\SyntheticHome', NODE_OPTIONS: 'sentinel' }, { platform: 'win32' });
  assert.deepEqual({ ...windows }, { PATH: 'C:\\SyntheticTools', SystemRoot: 'C:\\SyntheticWindows', USERPROFILE: 'C:\\SyntheticHome' });
});

test('child environment omits synthetic credentials/injection settings and cannot be expanded by options.env', async t => {
  const root = await sandbox(t);
  const runtime = new URL('../packages/business/src/media-runtime.mjs', import.meta.url).href;
  const processes = new URL('../packages/business/src/media-processes.mjs', import.meta.url).href;
  // The outer helper starts with a synthetic dictionary only. Forbidden loader
  // values are inserted after Node starts, and are never used by a child.
  const script = `import {run} from ${JSON.stringify(runtime)}; import {spawnMedia} from ${JSON.stringify(processes)};
    const keys=${JSON.stringify(forbidden)}; for(const key of keys)process.env[key]='synthetic-sentinel';
    process.env.MIOON_FFMPEG_PATH='';
    const first=JSON.parse(await run(process.execPath,[${JSON.stringify(fixture)},'keys',...keys],{env:{UNRELATED_SECRET:'override-sentinel'}}));
    const child=spawnMedia(process.execPath,[${JSON.stringify(fixture)},'keys',...keys],{env:{UNRELATED_SECRET:'override-sentinel'},stdio:['ignore','pipe','pipe'],shell:true,windowsHide:false});
    let text='';child.stdout.on('data',b=>text+=b);child.stderr.resume();await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
    console.log(JSON.stringify({first,second:JSON.parse(text)}));`;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: path.dirname(process.execPath), HOME: root, TMPDIR: root, LANG: 'C' }, timeout: 10000 });
  const result = JSON.parse(stdout);
  for (const dictionary of Object.values(result)) for (const key of forbidden) assert.equal(dictionary[key], false, key);
});

test('absolute configured paths preserve spaces and Unicode; shell metacharacters stay literal', async t => {
  const root = await sandbox(t), binary = path.join(root, '媒体 tool with spaces');
  if (process.platform === 'win32') { t.skip('Symlink execution fixture is POSIX; native Windows verification is separate'); return; }
  await symlink(process.execPath, binary);
  assert.equal(mediaExecutable('ffmpeg', { MIOON_FFMPEG_PATH: binary }), binary);
  assert.throws(() => mediaExecutable('ffmpeg', { MIOON_FFMPEG_PATH: 'relative path' }), { code: 'MEDIA_INVALID_CONFIGURATION' });
  const args = ['two words', '非 ASCII', '$(echo should-not-run)', ';touch ignored', 'quote"literal'];
  assert.deepEqual(JSON.parse(await run(binary, [fixture, 'argv', ...args])), args);
});

test('stdout preserves multibyte bytes at the exact budget and rejects one byte over', async () => {
  assert.equal(await run(process.execPath, [fixture, 'stdout', '😀é'], { maxStdoutBytes: 6 }), '😀é');
  await assert.rejects(run(process.execPath, [fixture, 'stdout', '😀é'], { maxStdoutBytes: 5 }), rejected('MEDIA_OUTPUT_LIMIT'));
  await assert.rejects(run(process.execPath, [fixture, 'stdout', 'x'], { maxStdoutBytes: MEDIA_RUNTIME_LIMITS.stdoutBytes + 1 }), { code: 'MEDIA_INVALID_CONFIGURATION' });
});

for (const stream of ['stdout', 'stderr']) test(`${stream} flood stops the child under a byte budget`, async () => {
  const events = [], off = onMediaProcess(event => events.push(event));
  try {
    await assert.rejects(run(process.execPath, [fixture, 'flood', stream, '131072'], { maxStdoutBytes: 4096, maxStderrBytes: 4096 }), rejected('MEDIA_OUTPUT_LIMIT'));
    assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
    assert.equal(events[0].pid, events[1].pid);
  } finally { off(); }
});

test('spawn and exit errors are safe and leave no active records', async () => {
  const events = [], off = onMediaProcess(event => events.push(event));
  try {
    await assert.rejects(run(path.join(tmpdir(), 'synthetic-private-missing-command'), []), rejected('MEDIA_SPAWN_FAILED'));
    assert.deepEqual(events, []);
    await assert.rejects(run(process.execPath, [fixture, 'fail']), rejected('MEDIA_EXIT_FAILED'));
    assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
    assert.deepEqual(await terminateMediaProcesses(), []);
  } finally { off(); }
});

test('already-aborted operations never spawn; observer errors do not affect a run', async () => {
  const events = [], controller = new AbortController(); controller.abort(new Error('synthetic-private-reason'));
  const off = onMediaProcess(event => { events.push(event); throw Error('observer-only'); });
  try {
    await assert.rejects(run(process.execPath, [fixture, 'stdout', 'never'], { signal: controller.signal }), error => rejected('MEDIA_CANCELLED')(error) && error.name === 'AbortError');
    assert.deepEqual(events, []);
    assert.equal(await run(process.execPath, [fixture, 'stdout', 'ok']), 'ok');
    assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
  } finally { off(); }
});

test('timeout and abort reap owned children with one start/exit pair', async t => {
  const root = await sandbox(t);
  for (const reason of ['timeout', 'abort']) {
    const events = [], off = onMediaProcess(event => events.push(event)), controller = new AbortController();
    try {
      const runResult = run(process.execPath, [fixture, 'wait', path.join(root, reason)], { timeout: reason === 'timeout' ? 100 : 5000, signal: controller.signal });
      const check = assert.rejects(runResult, rejected(reason === 'timeout' ? 'MEDIA_TIMEOUT' : 'MEDIA_CANCELLED'));
      if (reason === 'abort') { await ready(path.join(root, reason)); controller.abort(); }
      await check;
      assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
      assert.throws(() => process.kill(events[0].pid, 0), { code: 'ESRCH' });
    } finally { controller.abort(); off(); }
  }
});

test('scoped termination leaves other owners running and repeated stop is idempotent', async t => {
  const root = await sandbox(t), owner = new AbortController(), other = new AbortController();
  const a = spawnMedia(process.execPath, [fixture, 'wait', path.join(root, 'a')], { stdio: 'ignore' }, { kind: 'fixture-a', signal: owner.signal });
  const b = spawnMedia(process.execPath, [fixture, 'wait', path.join(root, 'b')], { stdio: 'ignore' }, { kind: 'fixture-b', signal: other.signal });
  t.after(async () => { await Promise.all([terminateMediaProcess(a), terminateMediaProcess(b)]); });
  await Promise.all([ready(path.join(root, 'a')), ready(path.join(root, 'b'))]);
  const first = terminateMediaProcesses({ signal: owner.signal }), second = terminateMediaProcesses({ signal: owner.signal });
  assert.deepEqual(await first, [{ status: 'exited', forced: false }]);
  assert.deepEqual(await second, [{ status: 'exited', forced: false }]);
  assert.equal(b.exitCode, null); assert.equal(b.signalCode, null);
  assert.equal(process.kill(b.pid, 0), true);
  assert.deepEqual(await terminateMediaProcesses(), [{ status: 'exited', forced: false }]);
  let attempted = false;
  assert.deepEqual(await terminateMediaProcess({ kill() { attempted = true; } }), { status: 'unowned', forced: false });
  assert.equal(attempted, false);
});

test('an owned child that ignores TERM is hard-stopped within the bounded reap window', async t => {
  if (process.platform === 'win32') { t.skip('POSIX signal-handler fixture is not native Windows validation'); return; }
  const root = await sandbox(t), marker = path.join(root, 'hard-stop');
  const child = spawnMedia(process.execPath, [fixture, 'wait', marker, 'ignore-term'], { stdio: 'ignore' }, { kind: 'hard-stop-fixture' });
  t.after(() => terminateMediaProcess(child)); await ready(marker);
  const started = Date.now(), outcome = await terminateMediaProcess(child);
  assert.deepEqual(outcome, { status: 'exited', forced: true });
  assert.ok(Date.now() - started < 3500);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

test('unconfirmed reap is bounded and never emits a false exited event', async t => {
  const root = await sandbox(t), marker = path.join(root, 'unconfirmed');
  const events = [], off = onMediaProcess(event => events.push(event));
  const child = spawnMedia(process.execPath, [fixture, 'wait', marker], { stdio: 'ignore' }, { kind: 'unconfirmed-fixture' });
  const originalKill = child.kill.bind(child), attempts = [];
  try {
    await ready(marker);
    // Failure injection affects this exact test-owned child object only.
    child.kill = signal => { attempts.push(signal); return false; };
    const started = Date.now(), outcome = await terminateMediaProcess(child);
    assert.deepEqual(outcome, { status: 'unconfirmed', forced: true });
    assert.ok(Date.now() - started < 3500);
    assert.deepEqual(attempts, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(events.map(event => event.type), ['started']);
    assert.equal(hasUnconfirmedMediaProcesses(), true);
    await assert.rejects(run(process.execPath, [fixture, 'stdout', 'must-not-spawn']), { code: 'MEDIA_TERMINATION_UNCONFIRMED', terminationUnconfirmed: true });
    assert.deepEqual(events.map(event => event.type), ['started']);
    let confirmed = false;
    const waiting = waitForMediaProcesses().then(result => { confirmed = true; return result; });
    await pause(10); assert.equal(confirmed, false);
    const exited = once(child, 'exit'); originalKill('SIGKILL'); await exited;
    assert.deepEqual(await waiting, [{ status: 'exited' }]);
    assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
    assert.equal(hasUnconfirmedMediaProcesses(), false);
    assert.equal(await run(process.execPath, [fixture, 'stdout', 'reopened']), 'reopened');
  } finally { child.kill = originalKill; if (child.exitCode === null && child.signalCode === null) originalKill('SIGKILL'); off(); }
});

test('legacy global shutdown reports unconfirmed reap to a running caller without an AbortSignal', async t => {
  const root = await sandbox(t), marker = path.join(root, 'runner-unconfirmed');
  const originalKill = ChildProcess.prototype.kill;
  let owned;
  const events = [], off = onMediaProcess(event => events.push(event));
  const intercept = t.mock.method(ChildProcess.prototype, 'kill', function () { owned = this; return false; });
  try {
    const result = run(process.execPath, [fixture, 'wait', marker]);
    const rejected = assert.rejects(result, error => error.code === 'MEDIA_CANCELLED' && error.terminationUnconfirmed === true);
    await ready(marker);
    assert.deepEqual(await terminateMediaProcesses(), [{ status: 'unconfirmed', forced: true }]);
    await rejected;
    assert.deepEqual(events.map(event => event.type), ['started']);
    intercept.mock.restore();
    const closed = once(owned, 'close'); originalKill.call(owned, 'SIGKILL'); await closed;
    assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
  } finally { intercept.mock.restore(); if (owned?.exitCode === null && owned?.signalCode === null) originalKill.call(owned, 'SIGKILL'); off(); }
});

test('observed exit does not release an unconfirmed close gate or signal that child again', async t => {
  const root = await sandbox(t), marker = path.join(root, 'delayed-close'), otherMarker = path.join(root, 'other-owner');
  const owner = new AbortController(), otherOwner = new AbortController();
  const child = spawnMedia(process.execPath, [fixture, 'wait', marker], { stdio: 'ignore' }, { signal: owner.signal });
  const other = spawnMedia(process.execPath, [fixture, 'wait', otherMarker], { stdio: 'ignore' }, { signal: otherOwner.signal });
  const originalEmit = child.emit.bind(child), originalKill = child.kill.bind(child);
  const calls = []; let deferredClose;
  child.emit = (event, ...args) => { if (event === 'close') { deferredClose = args; return true; } return originalEmit(event, ...args); };
  child.kill = signal => { calls.push(signal); return originalKill(signal); };
  try {
    await Promise.all([ready(marker), ready(otherMarker)]);
    const outcome = await terminateMediaProcess(child);
    assert.notEqual(child.signalCode, null);
    assert.deepEqual(outcome, { status: 'unconfirmed', forced: false });
    assert.deepEqual(calls, ['SIGTERM'], 'exit was observed, so the hard-stop timer must not signal again');
    assert.ok(deferredClose, 'the real close event was intercepted on this exact owned child');
    assert.equal(hasUnconfirmedMediaProcesses({ signal: owner.signal }), true);
    assert.equal(hasUnconfirmedMediaProcesses({ signal: otherOwner.signal }), false);
    assert.equal(other.exitCode, null); assert.equal(other.signalCode, null);
    await assert.rejects(run(process.execPath, [fixture, 'stdout', 'blocked']), { code: 'MEDIA_TERMINATION_UNCONFIRMED', terminationUnconfirmed: true });
    let complete = false;
    const waiting = waitForMediaProcesses({ signal: owner.signal }).then(() => { complete = true; });
    await pause(10); assert.equal(complete, false);
    child.emit = originalEmit; originalEmit('close', ...deferredClose); await waiting;
    assert.equal(hasUnconfirmedMediaProcesses(), false);
    assert.equal(other.exitCode, null); assert.equal(other.signalCode, null);
    // Replaying the old close callback cannot delete another owner's record.
    originalEmit('close', ...deferredClose);
    assert.deepEqual(await terminateMediaProcesses({ signal: otherOwner.signal }), [{ status: 'exited', forced: false }]);
    assert.equal(await run(process.execPath, [fixture, 'stdout', 'reopened']), 'reopened');
  } finally {
    child.emit = originalEmit; child.kill = originalKill;
    if (deferredClose) originalEmit('close', ...deferredClose);
    await Promise.all([terminateMediaProcess(child), terminateMediaProcess(other)]);
  }
});

test('final reap deadline is scheduled from stop start even if the grace callback is delayed', async t => {
  const root = await sandbox(t), marker = path.join(root, 'absolute-deadline');
  const child = spawnMedia(process.execPath, [fixture, 'wait', marker], { stdio: 'ignore' });
  const originalKill = child.kill.bind(child), attempts = [];
  await ready(marker);
  child.kill = signal => { attempts.push(signal); return false; };
  const scheduled = [];
  const timerMock = t.mock.method(globalThis, 'setTimeout', (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; });
  const clearMock = t.mock.method(globalThis, 'clearTimeout', timer => { if (timer) timer.cleared = true; });
  try {
    const stopping = terminateMediaProcess(child);
    assert.deepEqual(scheduled.map(timer => timer.delay), [MEDIA_TERMINATION_POLICY.graceMs, MEDIA_TERMINATION_POLICY.graceMs + MEDIA_TERMINATION_POLICY.reapMs]);
    // Both callbacks become runnable after a hypothetical delayed event-loop
    // turn. Running the grace callback must not schedule a new reap interval.
    scheduled[0].callback(); assert.equal(scheduled.length, 2);
    scheduled[1].callback();
    assert.deepEqual(await stopping, { status: 'unconfirmed', forced: true });
    assert.deepEqual(attempts, ['SIGTERM', 'SIGKILL']);
  } finally {
    timerMock.mock.restore(); clearMock.mock.restore(); child.kill = originalKill;
    const closed = once(child, 'close'); originalKill('SIGKILL'); await closed;
  }
});
