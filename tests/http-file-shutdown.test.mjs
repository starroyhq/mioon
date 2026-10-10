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

test('actual HEAD/empty stalled headers release descriptors and remain owned by server socket shutdown', {timeout: 10000}, async t => {
  const result = await isolated(t, 'headers');
  assert.equal(result.beforeClose.intercepted, 2); assert.equal(result.beforeClose.endCalls, 2);
  assert.equal(result.beforeClose.opened, 2); assert.equal(result.beforeClose.closed, 2); assert.equal(result.beforeClose.streams, 0);
  assert.equal(result.outcome, 'closed');
  assert.ok(result.elapsedMs >= 2500 && result.elapsedMs < 5000, `ordinary three-second force-drain: ${result.elapsedMs}`);
  assert.equal(result.afterClose.closed, 2);
});
