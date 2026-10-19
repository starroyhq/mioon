import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {discoverSchema} from '../packages/client/src/index.ts';
import {optionalRequestIdOperations} from './helpers/catalog-input-branches.mjs';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.ts';
import {IDS, TOKEN, snapshot} from './helpers/mutation-wire-fixture.mjs';
import {PRIVATE, DISPOSITION_IDS, BATCH_IDS, ORIGINAL_BYTES} from './helpers/asset-disposition-wire-fixture.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const helper = path.join(repo, 'tests/helpers/asset-disposition-wire-fixture.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const target = {projectId: IDS.project, assetId: IDS.asset};
const operations = ['asset.disposition.list', 'asset.disposition.set'];
const oldMutations = ['shot.create', 'shot.update', 'shot.reorder', 'node.create', 'node.update', 'version.select'];
const dispositionTables = new Set(['asset_dispositions', 'asset_disposition_requests']);
const toolName = operation => operation.replaceAll('.', '_');
const environment = extra => ({...mediaEnvironment(), MIOON_ENABLE_LIVE_PROVIDER: '0',
  MIOON_DISPOSITION_WIRE_GUARD: '1', ...extra});
const noPrivate = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [TOKEN, PRIVATE, 'Bearer ']) assert.ok(!text.includes(secret), 'wire output omits fixture-private fields and credentials');
};

async function bounded(promise, label, milliseconds = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`${label} timed out`)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

// Only owned ChildProcess handles are signalled. SDK transport.close similarly
// owns its child and has bounded TERM/KILL escalation in the official SDK.
async function stopOwned(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const ended = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }, 3_000);
  try { await bounded(ended, 'Owned child cleanup', 6_000); } finally { clearTimeout(timer); }
}

// Test-only observation: a timeout remains a failure. Reap this exact handle
// before later subtests, retaining the original deadline error if cleanup fails.
async function finishOwned(finished, child, snapshot, diagnostic) {
  try { return await bounded(finished, 'CLI response'); }
  catch (error) {
    diagnostic(snapshot());
    try { await stopOwned(child); }
    catch { diagnostic({cleanup: 'unconfirmed owned-child close'}); }
    throw error;
  }
}

function launch(t, args, env, label = 'fixture') {
  const started = performance.now(), milestones = {};
  const elapsed = () => Math.round((performance.now() - started) * 1000) / 1000;
  const child = spawn(process.execPath, args, {cwd: repo, env: environment(env), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '', failure;
  child.once('spawn', () => { milestones.spawnMs = elapsed(); });
  child.once('exit', (code, signal) => { milestones.exitMs = elapsed(); milestones.exitCode = code; milestones.exitSignal = signal; });
  const snapshot = () => {
    const phases = [];
    for (const line of stderr.split('\n')) {
      if (!line.startsWith('MIOON_WIRE_PHASE ')) continue;
      try {
        const row = JSON.parse(line.slice('MIOON_WIRE_PHASE '.length));
        if (!['preload-ready', 'fetch-start', 'fetch-headers', 'fetch-rejected'].includes(row.stage)) continue;
        const safe = {stage: row.stage};
        for (const key of ['uptimeMs', 'userCPUTime', 'systemCPUTime', 'maxRSS'])
          if (Number.isFinite(row[key]) && row[key] >= 0) safe[key] = row[key];
        phases.push(safe);
      } catch {}
    }
    let envelopeObserved = false;
    try { envelopeObserved = typeof JSON.parse(stdout.trim()).ok === 'boolean'; } catch {}
    return {label, pid: child.pid ?? null, elapsedMs: elapsed(), ...milestones,
      exitCode: child.exitCode, signalCode: child.signalCode,
      stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
      envelopeObserved, phases: phases.slice(-16)};
  };
  // JSON descriptions may cross pipe chunks inside a UTF-8 character.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.setEncoding('utf8').on('data', chunk => {
    milestones.firstOutputMs ??= elapsed(); milestones.lastOutputMs = elapsed();
    if (name === 'stdout') stdout += chunk; else stderr += chunk;
    if (stdout.length + stderr.length > 512 * 1024) { failure = Error('Owned child exceeded bounded output'); child.kill('SIGKILL'); }
  });
  child.on('error', error => { failure = error; });
  const finished = new Promise(resolve => child.once('close', (code, signal) => { milestones.closeMs = elapsed(); resolve({code, signal}); }));
  t.after(() => stopOwned(child));
  return {child, get stdout() { return stdout; }, get stderr() { return stderr; },
    lines: () => stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    async ready() {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        for (const line of stdout.split('\n').slice(0, -1)) {
          const value = JSON.parse(line); if (value.ready) return value;
        }
        noPrivate(stderr);
        assert.equal(child.exitCode, null, `Backend exited before readiness: ${stderr}`);
        assert.equal(child.signalCode, null, 'Backend stopped before readiness');
        await pause(10);
      }
      throw Error('Owned backend startup timed out');
    },
    async finish() { const result = await finishOwned(finished, child, snapshot, value => t.diagnostic(JSON.stringify(value))); if (failure) throw failure; return result; },
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-disposition-wire-'));
  const auditPath = path.join(root, 'forbidden-side-effects.jsonl');
  await writeFile(auditPath, '');
  let run, db, url, port = 0;
  const cleanups = [];
  t.after(async () => {
    const failures = [];
    for (const cleanup of [...cleanups.reverse(), () => stopOwned(run?.child), () => db?.close(),
      () => rm(root, {recursive: true, force: true})]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned disposition-wire fixture cleanup failed');
  });
  async function start() {
    run = launch(t, [helper, 'server'], {MIOON_DATA_DIR: root, PORT: String(port), MIOON_DISPOSITION_WIRE_AUDIT: auditPath});
    const ready = await run.ready(); url = ready.url; port = Number(new URL(url).port);
    assert.equal(new URL(url).hostname, '127.0.0.1');
    assert.equal((await fetch(url + '/health', {signal: AbortSignal.timeout(5_000)})).status, 200);
    return ready.pid;
  }
  await start();
  db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  const storage = () => snapshot(db);
  const version = () => db.prepare('PRAGMA data_version').get().data_version;
  const checkpoint = () => ({rows: storage(), version: version()});
  const unchanged = (before, label) => {
    assert.deepEqual(storage(), before.rows, `${label}: all persisted rows stay identical`);
    assert.equal(version(), before.version, `${label}: no extra commit, including equal-value writes`);
  };
  const env = () => ({MIOON_BASE_URL: url, MIOON_TOKEN: TOKEN, MIOON_DISPOSITION_WIRE_ALLOWED_ORIGIN: url, MIOON_DISPOSITION_WIRE_AUDIT: auditPath});
  async function request(operation, input, expectedError, base = url, authorization = `Bearer ${TOKEN}`) {
    const response = await fetch(base + '/api/rpc', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: {'content-type': 'application/json', ...(authorization ? {authorization} : {})}, body: JSON.stringify({operation, input})});
    const raw = await response.text(), envelope = JSON.parse(raw); noPrivate(raw);
    assert.equal(envelope.ok, !expectedError, raw);
    if (expectedError) {
      assert.equal(envelope.error.code, expectedError, raw);
      const status = expectedError === 'UNAUTHORIZED' ? 401 : expectedError === 'NOT_FOUND' ? 404 :
        ['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'INVALID_ASSET_DISPOSITION_RECORD'].includes(expectedError) ? 409 : 400;
      assert.equal(response.status, status, raw);
    } else assert.equal(response.status, 200, raw);
    return {raw, envelope};
  }
  async function cliArgs(args, expectedError) {
    const label = args.slice(0, args.indexOf('--input') < 0 ? args.length : args.indexOf('--input'))
      .filter(value => /^[a-z][a-z0-9.-]{0,80}$/.test(value)).slice(0, 4).join('.') || 'cli';
    const child = launch(t, ['--import', helper, path.join(repo, 'apps/cli/src/index.ts'), ...args],
      {...env(), MIOON_DISPOSITION_PHASE_TRACE: '1'}, label);
    const {code, signal} = await child.finish(); noPrivate(child.stdout); noPrivate(child.stderr);
    assert.equal(signal, null, child.stderr);
    const lines = child.lines(); assert.equal(lines.length, 1, 'real CLI returns one JSON envelope');
    const result = lines[0]; assert.equal(result.ok, !expectedError, child.stdout + child.stderr);
    if (expectedError) { assert.notEqual(code, 0); assert.equal(result.error.code, expectedError); assert.match(child.stderr, new RegExp(expectedError)); }
    else assert.equal(code, 0, child.stderr);
    return result;
  }
  const cli = (operation, input, error) => cliArgs([...operation.split('.'), '--input', JSON.stringify(input)], error);
  const client = new Client({name: 'asset-disposition-wire-acceptance', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, cwd: repo, env: environment(env()), stderr: 'pipe',
    args: ['--import', helper, path.join(repo, 'apps/mcp/src/index.ts')]});
  let stderr = '';
  transport.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
  cleanups.push(() => bounded(client.close(), 'Official MCP cleanup', 7_000));
  await bounded(client.connect(transport), 'Official MCP initialization');
  assert.equal(client.getServerVersion().name, 'mioon');
  assert.ok(client.getServerCapabilities().tools);
  async function mcp(operation, input = {}, expectedError) {
    const result = await client.callTool({name: operation === 'mioon_schema' ? operation : toolName(operation), arguments: input}, undefined, {timeout: 5_000});
    noPrivate(result); noPrivate(stderr);
    const blocks = result.content.filter(block => block.type === 'text');
    assert.equal(blocks.length, 1, 'official SDK receives one text JSON envelope');
    const envelope = JSON.parse(blocks[0].text);
    assert.deepEqual(result.structuredContent, envelope);
    assert.equal(Boolean(result.isError), Boolean(expectedError), blocks[0].text);
    assert.equal(envelope.ok, !expectedError, blocks[0].text);
    if (expectedError) assert.equal(envelope.error.code, expectedError);
    return envelope;
  }
  return {root, storage, checkpoint, unchanged, request, cli, cliArgs, client, mcp,
    http: async (...args) => (await request(...args)).envelope,
    get url() { return url; }, get pid() { return run.child.pid; },
    stop: () => stopOwned(run.child),
    moveAsset: async () => {
      await stopOwned(run.child);
      const child = launch(t, [helper, 'move-asset'], {MIOON_DATA_DIR: root, MIOON_DISPOSITION_WIRE_AUDIT: auditPath});
      assert.equal((await child.finish()).code, 0, child.stderr);
      assert.deepEqual(child.lines(), [{moved: 1}]);
      return start();
    },
    restart: async () => { await stopOwned(run.child); return start(); },
    audit: async () => (await readFile(auditPath, 'utf8')).trim(),
  };
}

test('annotations share authenticated HTTP, CLI and official MCP, with replay after restart and no external work', {timeout:120_000}, async t=>{
 const backend=await fixture(t),read={projectId:IDS.project,assetIds:[IDS.asset]};
 const before=backend.storage();
 await backend.http('asset.annotation.list',read,'UNAUTHORIZED',backend.url,'');
 const initial=await backend.http('asset.annotation.list',read);assert.equal(initial.data.items[0].revision,0);
 assert.deepEqual(await backend.cli('asset.annotation.list',read),initial);
 assert.deepEqual(await backend.mcp('asset.annotation.list',read),initial);
 const tools=await backend.client.listTools();assert.ok(tools.tools.some(tool=>tool.name==='asset_annotation_set'));assert.ok(tools.tools.some(tool=>tool.name==='asset_annotation_list'));
 const input={projectId:IDS.project,assetId:IDS.asset,expectedRevision:0,requestId:'annotation-wire-original',tags:['ラベル'],note:'literal <tag>\nnotes'};
 const saved=await backend.http('asset.annotation.set',input);assert.equal(saved.data.revision,1);
 assert.deepEqual(await backend.cli('asset.annotation.set',input),saved);assert.deepEqual(await backend.mcp('asset.annotation.set',input),saved);
 const cleared=await backend.mcp('asset.annotation.set',{...input,expectedRevision:1,requestId:'annotation-wire-clear',tags:[],note:''});assert.equal(cleared.data.revision,2);
 await backend.restart();const stable=backend.checkpoint();assert.deepEqual(await backend.cli('asset.annotation.set',input),saved);backend.unchanged(stable,'historical annotation replay');
 await backend.http('asset.annotation.set',{...input,note:'changed'},'IDEMPOTENCY_CONFLICT');
 const after=backend.storage();for(const [table,rows] of Object.entries(before))if(!['asset_annotations','asset_annotation_requests'].includes(table))assert.deepEqual(after[table],rows,table);
 assert.equal(await backend.audit(),'');
});
