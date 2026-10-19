import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CLI_PROCESS_TIMEOUT_MS, InspectionProcessError, runInspectionProcess} from './helpers/inspection-wire-lifecycle.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const preload = path.join(repo, 'tests/helpers/inspection-wire-fixture.mjs');
const entry = path.join(repo, 'apps/cli/src/index.ts');
const sensitive = 'synthetic-diagnostic-private-value';
function environment(extra = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) {
    if (/^(?:MIOON_|RUNWAY_|ARK_|VEO_|GOOGLE_|MINIMAX_|VIDU_|OPENAI_|ANTHROPIC_|AZURE_|AWS_|NODE_OPTIONS$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key)) delete env[key];
  }
  return {...env, MIOON_ENABLE_LIVE_PROVIDER: '0', ...extra};
}
async function failed(script, options = {}) {
  let failure;
  try { await runInspectionProcess(['--input-type=module', '-e', script], {env: environment(), timeoutMs: 300, ...options}); }
  catch (error) { failure = error; }
  assert.ok(failure instanceof InspectionProcessError);
  assert.ok(!JSON.stringify(failure.diagnostics).includes(sensitive), 'diagnostics exclude raw output, input and credentials');
  assert.ok(!JSON.stringify(failure.diagnostics).includes(repo), 'diagnostics exclude private source paths');
  assert.equal(failure.diagnostics.cleanup.reaped, true, 'failure returns after the exact owned child is reaped');
  return failure.diagnostics;
}

test('inspection CLI keeps the original 10s process deadline and repeatedly exits after offline and RPC envelopes', {timeout: 15_000}, async t => {
  assert.equal(CLI_PROCESS_TIMEOUT_MS, 10_000);
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++; request.resume();
    request.on('end', () => {
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({ok: true, data: {synthetic: true, description: '准确🎬'}}));
    });
  });
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const scenario of ['offline-schema', 'synthetic-rpc']) for (let repeat = 1; repeat <= 3; repeat++) {
    const args = scenario === 'offline-schema' ? ['schema', 'project.inspect'] :
      ['project', 'inspect', '--input', '{"projectId":"00000000-0000-4000-8000-000000000001"}'];
    const result = await runInspectionProcess(['--import', preload, entry, ...args], {cwd: repo, signal: t.signal,
      env: environment({MIOON_INSPECTION_WIRE_GUARD: '1', MIOON_INSPECTION_WIRE_TRACE: '1',
        MIOON_INSPECTION_WIRE_ALLOWED_ORIGIN: origin, MIOON_BASE_URL: origin, MIOON_TOKEN: sensitive})});
    assert.equal(result.code, 0); assert.equal(result.signal, null);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.ok(!result.stdout.includes(sensitive) && !result.stderr.includes(sensitive));
    const envelope = JSON.parse(result.stdout); assert.equal(envelope.ok, true);
    if (scenario === 'offline-schema') assert.equal(envelope.data.operation, 'project.inspect');
    else assert.deepEqual(envelope.data, {synthetic: true, description: '准确🎬'});
    assert.equal(result.diagnostics.exit.code, 0); assert.equal(result.diagnostics.close.code, 0);
    assert.ok(result.diagnostics.envelopeAtMs !== null);
    const stages = result.diagnostics.observations.map(value => value.stage);
    assert.match(stages[1], /^compile-cache-(active|disabled)$/);
    assert.deepEqual(stages.filter(stage => !stage.startsWith('compile-cache-')),
      scenario === 'offline-schema' ? ['preloaded'] : ['preloaded', 'fetch-start', 'fetch-headers']);
    t.diagnostic(JSON.stringify({scenario, repeat, ...result.diagnostics}));
  }
  assert.equal(requests, 3, 'offline discovery makes no backend requests and RPC is never retried');
});

test('process deadline distinguishes startup, request, response body and an envelope waiting for exit', async t => {
  for (const [phase, trace, output] of [
    ['startup', '', ''], ['command', 'preloaded\n', ''],
    ['request', 'preloaded\nfetch-start\n', ''],
    ['response-body-or-envelope', 'preloaded\nfetch-start\nfetch-headers\n', ''],
    ['process-exit', 'preloaded\nfetch-start\nfetch-headers\n', JSON.stringify({ok: true, data: sensitive}) + '\n'],
  ]) await t.test(phase, async () => {
    const diagnostics = await failed(`import fs from 'node:fs'; fs.writeSync(3, ${JSON.stringify(trace)});
      process.stdout.write(${JSON.stringify(output)}); process.stderr.write(${JSON.stringify(sensitive)}); setInterval(() => {}, 1000);`);
    assert.equal(diagnostics.reason, 'process-deadline'); assert.equal(diagnostics.timeoutFired, true); assert.equal(diagnostics.phase, phase);
    assert.equal(diagnostics.deadlineMs, 300); assert.equal(diagnostics.exit, null); assert.equal(diagnostics.close, null);
    assert.equal(diagnostics.cleanup.killSent, true);
    assert.equal(diagnostics.envelopeAtMs !== null, phase === 'process-exit');
  });
});

test('outer test cancellation is distinct from the CLI process deadline and cleans the child', async () => {
  const controller = new AbortController();
  const cause = Error(sensitive), timer = setTimeout(() => controller.abort(cause), 300);
  try {
    await assert.rejects(runInspectionProcess(['-e', 'setInterval(() => {}, 1000);'],
      {env: environment(), signal: controller.signal}), error => {
      assert.ok(error instanceof InspectionProcessError); assert.equal(error.cause, cause);
      assert.ok(!error.message.includes(sensitive), 'original cause stays separate from safe diagnostics');
      const diagnostics = error.diagnostics;
      assert.equal(diagnostics.reason, 'outer-test-abort'); assert.equal(diagnostics.timeoutFired, false);
      assert.equal(diagnostics.deadlineMs, 10_000); assert.equal(diagnostics.cleanup.reaped, true);
      assert.equal(diagnostics.cleanup.killSent, true); assert.equal(diagnostics.exit, null);
      return true;
    });
  } finally { clearTimeout(timer); }
});

test('an exit with inherited stdout still open is diagnosed before owned pipes are closed', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-cli-pipes-'));
  const release = path.join(directory, 'release'), done = path.join(directory, 'released');
  t.after(async () => {
    await writeFile(release, 'release');
    const deadline = Date.now() + 6000;
    let released = false;
    while (Date.now() < deadline) {
      try { released = (await readFile(done, 'utf8')) === 'released'; if (released) break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(released, true, 'bounded descendant confirms its inherited stdout is released');
    await rm(directory, {recursive: true, force: true});
  });
  const descendantScript = `const fs = require('node:fs'), end = Date.now() + 5000;
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < end) return;
      clearInterval(timer); fs.closeSync(1); fs.writeFileSync(${JSON.stringify(done)}, 'released');
    }, 20);`;
  const diagnostics = await failed(`import {spawn} from 'node:child_process';
    const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], {stdio: ['ignore', 1, 'ignore']});
    descendant.unref();
    process.stdout.write('{"ok":true,"data":null}\\n');`);
  assert.equal(diagnostics.reason, 'process-deadline'); assert.equal(diagnostics.phase, 'stdio-close');
  assert.equal(diagnostics.exit.code, 0); assert.equal(diagnostics.exit.signal, null); assert.equal(diagnostics.close, null);
  assert.equal(diagnostics.cleanup.killSent, false, 'an already exited child is never blamed on a cleanup signal');
  assert.equal(diagnostics.cleanup.pipesDestroyed, true);
});

test('spawn failure reports a safe code without executable path or raw arguments', async () => {
  const diagnostics = await failed('', {executable: `/nonexistent/${sensitive}`});
  assert.equal(diagnostics.reason, 'spawn-error'); assert.equal(diagnostics.spawnErrorCode, 'ENOENT');
  assert.equal(diagnostics.cleanup.killSent, false);
});

test('a process signal before the deadline preserves its actual exit and close evidence', async () => {
  const diagnostics = await failed("process.kill(process.pid, 'SIGKILL');");
  assert.equal(diagnostics.reason, 'process-signal'); assert.equal(diagnostics.timeoutFired, false);
  assert.equal(diagnostics.exit.signal, 'SIGKILL'); assert.equal(diagnostics.close.signal, 'SIGKILL');
  assert.equal(diagnostics.cleanup.killSent, false);
});

test('dedicated trace accepts only bounded fixed phases and never includes child-controlled text', async () => {
  const trace = `${sensitive}\n${'fetch-start\n'.repeat(40)}`;
  const diagnostics = await failed(`import fs from 'node:fs'; fs.writeSync(3, ${JSON.stringify(trace)}); setInterval(() => {}, 1000);`);
  assert.equal(diagnostics.observations.length, 12);
  assert.ok(diagnostics.observations.every(value => value.stage === 'fetch-start' && Number.isFinite(value.elapsedMs)));
});
