import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {callObservedRpc} from '../apps/server/src/rpc-observation.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; };
async function fixture(t, operation) {
  const entered = deferred(), settled = deferred(), release = deferred();
  const observations = []; let calls = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') return res.end('healthy');
    for await (const _ of req) { /* consume the synthetic request */ }
    const baseline = {request: req.listenerCount('aborted'), response: res.listenerCount('close')};
    try {
      await callObservedRpc(req, res, {call: async (op, input, options) => {
        calls++;
        observations.push({op, input, signal: options?.signal});
        entered.resolve();
        if (options?.signal) await new Promise(resolve => options.signal.addEventListener('abort', resolve, {once: true}));
        else await release.promise;
        return {observed: true};
      }}, operation, {synthetic: true});
      if (!res.destroyed) res.end('complete');
    } finally {
      settled.resolve({baseline, remaining: {request: req.listenerCount('aborted'), response: res.listenerCount('close')}});
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {release.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return {url: `http://127.0.0.1:${server.address().port}`, entered, settled, release, observations, calls: () => calls};
}

test('real HTTP preflight disconnect aborts only observation, detaches listeners and leaves a new connection healthy', {timeout: 10000}, async t => {
  const f = await fixture(t, 'timeline.export.preflight');
  const request = http.request(f.url, {method: 'POST'});
  request.on('error', () => {}); request.end('{}');
  await f.entered.promise;
  assert.equal(f.observations[0].signal.aborted, false);
  request.destroy();
  const result = await f.settled.promise;
  assert.equal(f.observations[0].signal.aborted, true);
  assert.deepEqual(result.remaining, result.baseline);
  assert.equal(f.calls(), 1, 'disconnect never retries a POST');
  assert.equal(await (await fetch(f.url + '/health')).text(), 'healthy');
});

test('real HTTP render disconnect does not cancel or retry its business operation', {timeout: 10000}, async t => {
  const f = await fixture(t, 'timeline.render');
  const request = http.request(f.url, {method: 'POST'});
  request.on('error', () => {}); request.end('{}');
  await f.entered.promise;
  request.destroy();
  assert.equal(f.observations[0].signal, undefined);
  f.release.resolve();
  const result = await f.settled.promise;
  assert.deepEqual(result.remaining, result.baseline);
  assert.equal(f.calls(), 1);
  assert.equal(await (await fetch(f.url + '/health')).text(), 'healthy');
});

test('actual CLI Ctrl+C revokes only its preflight observer and never resubmits', {timeout: 10000}, async t => {
  const f = await fixture(t, 'timeline.export.preflight');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../apps/cli/src/index.mjs', import.meta.url)),
    'timeline', 'export', 'preflight', '--input', JSON.stringify({projectId: '11111111-1111-4111-8111-111111111111', expectedRevision: 1})], {
    stdio: ['ignore', 'pipe', 'pipe'], env: {PATH: process.env.PATH || '', MIOON_BASE_URL: f.url,
      MIOON_TOKEN: 'preflight-cli-public-synthetic-only-token', MIOON_ENABLE_LIVE_PROVIDER: '0'},
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', bytes => {stdout += bytes;}); child.stderr.setEncoding('utf8').on('data', bytes => {stderr += bytes;});
  const done = new Promise((resolve, reject) => {child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal}));});
  t.after(async () => {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done.catch(() => {});});
  await f.entered.promise;
  child.kill('SIGINT'); // Exact owned test handle, never a recovered numeric PID.
  const outcome = await done;
  assert.equal(outcome.code, 130, stderr); assert.equal(outcome.signal, null);
  assert.equal(JSON.parse(stdout).error.code, 'INTERRUPTED');
  await f.settled.promise;
  assert.equal(f.observations[0].signal.aborted, true); assert.equal(f.calls(), 1);
  assert.equal(await (await fetch(f.url + '/health')).text(), 'healthy');
});

test('already disconnected preflight enters with revoked observer and cleans up on rejection', async () => {
  const req = new EventEmitter(), res = new EventEmitter(); res.destroyed = true;
  await assert.rejects(callObservedRpc(req, res, {call: async (_, __, {signal}) => {
    assert.equal(signal.aborted, true); throw Error('synthetic abort');
  }}, 'timeline.export.preflight', {}), /synthetic abort/);
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
});

test('finished response and later close cannot revoke a settled preflight or retain listeners', async () => {
  const req = new EventEmitter(), res = new EventEmitter(); let signal;
  const result = await callObservedRpc(req, res, {call: async (_, __, options) => {
    signal = options.signal; res.writableFinished = true; res.emit('close'); return {ready: true};
  }}, 'timeline.export.preflight', {});
  assert.deepEqual(result, {ready: true}); assert.equal(signal.aborted, false);
  res.writableFinished = false; res.emit('close'); req.emit('aborted');
  assert.equal(signal.aborted, false);
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
});
