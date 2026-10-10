import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FILE_RESPONSE_LIMITS} from '../apps/server/src/file-response.mjs';

const fixture = fileURLToPath(new URL('./helpers/http-file-shutdown-process.mjs', import.meta.url));
async function isolated(t, mode) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-q4-fs-stall-'));
  const child = spawn(process.execPath, [fixture, mode, root], {stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH || '', HOME: root, TMPDIR: tmpdir(), LANG: 'C.UTF-8', MIOON_ENABLE_LIVE_PROVIDER: '0',
  }});
  let output = '', errors = '';
  child.stdout.on('data', chunk => {output = (output + chunk).slice(-16384);});
  child.stderr.on('data', chunk => {errors = (errors + chunk).slice(-16384);});
  const outcome = new Promise((resolve, reject) => {child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal}));});
  t.after(async () => {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await outcome.catch(() => {}); await rm(root, {recursive: true, force: true});});
  const result = await outcome;
  assert.equal(result.code, 0, errors); assert.equal(result.signal, null); return JSON.parse(output.trim());
}

test('actual server bounds nonsettling open/stat shutdown without claiming released slots or descriptors', {timeout: 20000}, async t => {
  for (const mode of ['open', 'stat']) {
    const result = await isolated(t, mode);
    assert.equal(result.busyStatus, 503);
    assert.equal(result.beforeClose.intercepted, FILE_RESPONSE_LIMITS.active, 'disconnect must not release a still-pending filesystem slot');
    assert.equal(result.beforeClose.closed, 0); assert.equal(result.beforeClose.streams, 0);
    assert.equal(result.outcome, 'SERVER_STOP_TIMEOUT');
    assert.ok(result.elapsedMs >= 4500 && result.elapsedMs < 6500, `actual five-second server budget: ${result.elapsedMs}`);
    assert.equal(result.afterTimeout.closed, 0, 'timeout does not claim descriptor release');
    assert.equal(result.afterTimeout.opened, mode === 'open' ? 0 : FILE_RESPONSE_LIMITS.active);
    assert.equal(result.afterRelease.closed, FILE_RESPONSE_LIMITS.active); assert.equal(result.afterRelease.streams, 0);
    assert.equal(result.stillSameRejectedClose, true, 'late cleanup cannot silently turn the original failed close into success');
  }
});

function assertHeaderDrain(result) {
  assert.equal(result.beforeClose.intercepted, 2); assert.equal(result.beforeClose.endCalls, 2);
  assert.equal(result.beforeClose.opened, 2); assert.equal(result.beforeClose.closed, 2); assert.equal(result.beforeClose.streams, 0);
  assert.equal(result.outcome, 'closed');
  assert.deepEqual(result.afterClose, result.beforeClose, 'header shutdown neither reopens a descriptor nor starts a stream');
  const forceTimers = result.timers.filter(timer => timer.delayMs === 3000);
  assert.equal(forceTimers.length, 1, 'one unchanged three-second force-drain timer');
  const timer = forceTimers[0], call = result.clock.forceCalls[0];
  assert.match(timer.callsite, /apps\/server\/src\/index\.mjs/);
  assert.equal(result.clock.forceCalls.length, 1, 'one force-drain invocation, no retry');
  assert.equal(call.timerId, timer.id, 'the production 3000ms callback caused socket destruction');
  assert.ok(timer.firedAt - timer.armedAt >= 2990, 'force-drain never fires early');
  assert.equal(call.liveBefore, 2, 'both deliberately stalled response sockets were still owned');
  assert.equal(call.closedDescriptors, 2, 'both descriptors stay released while socket drain is pending');
  assert.equal(call.destroyedAfter, 2); assert.equal(result.destroyedSockets, 2);
  assert.equal(result.sockets.length, 2);
  for (const socket of result.sockets) assert.ok(socket.closedAt >= call.at && socket.closedAt <= result.clock.socketsObservedAt, 'exact owned sockets emit close after the force-drain');
  assert.ok(result.clock.httpClosedAt >= call.at && result.clock.finished >= result.clock.httpClosedAt);
  assert.ok(timer.clearedAt >= timer.firedAt, 'force-drain timer is cleared after completion');
  const serverDeadline = result.timers.filter(timer => {
    const stack = timer.callsite.split('\n'), index = stack.findIndex(frame => /at boundedShutdown /.test(frame));
    const owner = index >= 0 ? stack[index + 1] || '' : '';
    return timer.delayMs === 5000 && /at file:.*apps\/server\/src\/index\.mjs/.test(owner);
  });
  assert.equal(serverDeadline.length, 1, 'the outer server deadline is distinct from service and worker deadlines');
  assert.equal(serverDeadline[0].firedAt, null, 'successful closure did not fire the server timeout');
  assert.ok(serverDeadline[0].clearedAt >= call.at, 'server deadline is cancelled after drain');
  for (const deadline of result.timers.filter(timer => timer.delayMs === 5000)) {
    assert.equal(deadline.firedAt, null, 'successful worker/service/server budgets did not expire');
    assert.ok(deadline.clearedAt >= deadline.armedAt, 'every cleanup deadline timer was cleared');
  }
  // Wall-clock elapsed includes work before timers arm, scheduler lateness and
  // synchronous database close. The finite test watchdog bounds this fixture;
  // causal timer/descriptor/socket assertions test ownership, not CPU speed.
}

test('actual HEAD/empty stalled headers release descriptors and remain owned by server socket shutdown', {timeout: 10000}, async t => {
  const result = await isolated(t, 'headers');
  t.diagnostic(JSON.stringify(result));
  assertHeaderDrain(result);
});

test('pre-arm scheduling delay can exceed five-second total elapsed without changing the force-drain or server deadline', {timeout: 12000}, async t => {
  const result = await isolated(t, 'headers-prearm-delay');
  t.diagnostic(JSON.stringify(result));
  assertHeaderDrain(result);
  const timer = result.timers.find(timer => timer.delayMs === 3000);
  assert.ok(result.clock.preArmDelayMs >= 2500);
  assert.ok(timer.armedAt - result.clock.started >= result.clock.preArmDelayMs);
  assert.ok(result.elapsedMs >= 5500, 'deterministically reproduces the old elapsed-only assertion failure');
});
