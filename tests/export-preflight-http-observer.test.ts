import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {callObservedRpc} from '../apps/server/src/rpc-observation.ts';
import {schemas, operationEffect} from '@mioon/contracts';
import {readFile} from 'node:fs/promises';
import {evaluateModule} from './helpers/eval-source.ts';

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

for (const operation of ['timeline.export.preflight', 'timeline.export.capabilities']) test(`real HTTP ${operation} disconnect aborts only observation, detaches listeners and leaves a new connection healthy`, {timeout: 10000}, async t => {
  const f = await fixture(t, operation);
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

for (const operation of ['timeline.export.preflight', 'timeline.export.capabilities']) test(`actual CLI Ctrl+C revokes only its ${operation} observer and never resubmits`, {timeout: 10000}, async t => {
  const f = await fixture(t, operation);
  const input = {projectId: '11111111-1111-4111-8111-111111111111', expectedRevision: 1, ...(operation.endsWith('capabilities') ? {exportSettings: {profileId: 'mp4_h264_v1', resolution: 'native', rateControl: {mode: 'crf', quality: 'standard'}}} : {})};
  const child = spawn(process.execPath, [fileURLToPath(new URL('../apps/cli/src/index.ts', import.meta.url)),
    ...operation.split('.'), '--input', JSON.stringify(input)], {
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

for (const operation of ['timeline.export.preflight', 'timeline.export.capabilities']) test(`already disconnected ${operation} enters with revoked observer and cleans up on rejection`, async () => {
  const req = new EventEmitter(), res = new EventEmitter(); res.destroyed = true;
  await assert.rejects(callObservedRpc(req, res, {call: async (_, __, {signal}) => {
    assert.equal(signal.aborted, true); throw Error('synthetic abort');
  }}, operation, {}), /synthetic abort/);
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
});

for (const operation of ['timeline.export.preflight', 'timeline.export.capabilities']) test(`finished response and later close cannot revoke settled ${operation} or retain listeners`, async () => {
  const req = new EventEmitter(), res = new EventEmitter(); let signal;
  const result = await callObservedRpc(req, res, {call: async (_, __, options) => {
    signal = options.signal; res.writableFinished = true; res.emit('close'); return {ready: true};
  }}, operation, {});
  assert.deepEqual(result, {ready: true}); assert.equal(signal.aborted, false);
  res.writableFinished = false; res.emit('close'); req.emit('aborted');
  assert.equal(signal.aborted, false);
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
});


test('only six explicit advisory operations observe disconnect; private capability files do not become business cancellation', async () => {
  const observed = new Set(['timeline.export.preflight', 'timeline.export.capabilities', 'timeline.export.samplePeak', 'timeline.export.loudness', 'timeline.loudness.prepare', 'timeline.clip.loudness']);
  assert.equal(operationEffect('timeline.export.capabilities').fileWrite, true, 'the real temporary-file effect must remain disclosed');
  for (const operation of Object.keys(schemas)) {
    const req = new EventEmitter(), res = new EventEmitter(); let received;
    await callObservedRpc(req, res, {call: async (_, __, options) => {received = options.signal; return null;}}, operation, {});
    assert.equal(received instanceof AbortSignal, observed.has(operation), operation);
    assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
  }
});

test('observer policy rejects every other file writer and future business/network/paid capability effects', async () => {
  const source = await readFile(new URL('../apps/server/src/rpc-observation.ts', import.meta.url), 'utf8');
  const importLine = "import {operationEffect} from '@mioon/contracts';";
  assert.equal(source.split(importLine).length, 2, 'one exact metadata dependency, actual observer function remains intact');
  const cases = [
    ...['timeline.export.preflight', 'timeline.export.samplePeak', 'timeline.export.loudness', 'timeline.loudness.prepare', 'timeline.clip.loudness'].map(operation => ({operation, patch:{fileWrite:true}})),
    ...[{readOnly:false}, {databaseWrite:true}, {externalIO:true}, {paidGeneration:true}, {destructive:true}, {openWorld:true}]
      .map(patch => ({operation:'timeline.export.capabilities', patch})),
  ];
  for (const {operation, patch} of cases) {
    const effects = {...operationEffect(operation), ...patch};
    // rpc-observation.ts is typed source: execute the exact same observer function
    // through the reviewed eval-source helper, which erases only TypeScript syntax
    // with the pinned local esbuild and keeps the module's real CommonJS exports.
    const module = evaluateModule<{callObservedRpc: (...args: unknown[]) => Promise<unknown>}>(
      source.replace(importLine, `const operationEffect = () => (${JSON.stringify(effects)});`), {loader: 'ts'});
    const req = new EventEmitter(), res = new EventEmitter(); res.destroyed = true; let received;
    await module.callObservedRpc(req, res, {call:async (_, __, options) => {received=options.signal; return null;}}, operation, {});
    assert.equal(received, undefined, operation + JSON.stringify(patch));
    assert.equal(req.listenerCount('aborted'),0); assert.equal(res.listenerCount('close'),0);
  }
});
