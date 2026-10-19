import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import http from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const guard = path.join(repo, 'tests/helpers/inspection-wire-fixture.mjs');
// This existing owned fixture starts the real HTTP server and forbids outbound
// provider traffic, model calls, and all media/subprocess work in that server.
const backendFixture = path.join(repo, 'tests/fixtures/local-drafts-process.mjs');
const token = 'synthetic-lut-wire-token-not-a-real-credential';
const source = Buffer.from('# preserve exact CRLF and missing final newline\r\nTITLE "Wire resource"\r\nLUT_3D_SIZE 2\r\n0 0 0\r\n1 0 0\r\n0 1 0\r\n1 1 0\r\n0 0 1\r\n1 0 1\r\n0 1 1\r\n1 1 1');
const expectedHash = createHash('sha256').update(source).digest('hex');
const changedTables = new Set(['project_lut_resources', 'lut_import_requests']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function bounded(promise, label, ms = 15_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`${label} timed out after ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function environment(root, extra = {}) {
  // Do not inherit credentials, proxy variables, loaders or provider settings.
  return {PATH: process.env.PATH || '', HOME: root, TMPDIR: root, LANG: 'C.UTF-8',
    NODE_ENV: 'test', MIOON_ENABLE_LIVE_PROVIDER: '0', ...extra};
}

function ownedProcess(args, env, {ipc = false} = {}) {
  const child = spawn(process.execPath, args, {cwd: repo, env,
    stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])]});
  let stdout = '', stderr = '', failure;
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  child.once('error', error => { failure = error; });
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.setEncoding('utf8').on('data', chunk => {
      if (name === 'stdout') stdout += chunk; else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 512 * 1024) {
        failure = Error('Owned LUT wire child exceeded its output limit');
        child.kill('SIGKILL');
      }
    });
  }
  return {child, closed, get stdout() { return stdout; }, get stderr() { return stderr; },
    snapshot: () => ({pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode,
      stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr)}),
    async finish() {
      const result = await bounded(closed, 'Owned CLI response');
      if (failure) throw failure;
      return result;
    },
    async close() {
      if (child.exitCode !== null || child.signalCode) return closed;
      if (ipc && child.connected) child.send({type: 'close'}, () => {});
      else child.kill('SIGTERM');
      const kill = setTimeout(() => {
        if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
      }, 3_000);
      try { return await bounded(closed, 'Owned child cleanup', 6_000); }
      finally { clearTimeout(kill); }
    },
  };
}

function metadataOnly(value, root) {
  const wire = JSON.stringify(value);
  for (const privateValue of [token, root, source.toString('base64'), source.toString('utf8')])
    assert.equal(wire.includes(privateValue), false, 'public response omits credentials, local paths and original bytes');
  const inspect = node => {
    if (!node || typeof node !== 'object') return;
    for (const [key, nested] of Object.entries(node)) {
      assert.ok(!['content', 'dataBase64', 'bytes', 'path', 'relativePath', 'url', 'assetId'].includes(key),
        `public LUT response cannot contain ${key}`);
      inspect(nested);
    }
  };
  inspect(value);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-lut-wire-data-'));
  // Keep bounded child diagnostics separately from disposable application data.
  // The diagnostic names the directory even on failure; no logs are discarded.
  const logRoot = await mkdtemp(path.join(tmpdir(), 'mioon-lut-wire-logs-'));
  t.diagnostic(`Owned LUT transport logs: ${logRoot}`);
  const audit = path.join(logRoot, 'forbidden-effects.jsonl');
  await writeFile(audit, '');
  const children = [], mcpChildren = [], proxies = [], wire = [];
  let db;
  t.after(async () => {
    const failures = [];
    const cleanup = async task => { try { await task(); } catch (error) { failures.push(error); } };
    for (const child of mcpChildren) await cleanup(async () => {
      await bounded(child.client.close(), 'Official MCP child cleanup', 7_000);
      assert.equal(child.transport.pid, null, 'official SDK has closed its owned child');
    });
    for (const proxy of proxies) await cleanup(async () => {
      proxy.closeAllConnections();
      await bounded(new Promise(resolve => proxy.close(resolve)), 'Owned proxy cleanup', 5_000);
    });
    for (const child of [...children].reverse()) await cleanup(() => child.run.close());
    await cleanup(async () => {
      for (const {label, run} of children) {
        await writeFile(path.join(logRoot, `${label}.stdout.log`), run.stdout);
        await writeFile(path.join(logRoot, `${label}.stderr.log`), run.stderr);
      }
      for (const child of mcpChildren) await writeFile(path.join(logRoot, `${child.label}.stderr.log`), child.stderr);
      await writeFile(path.join(logRoot, 'mcp-wire.jsonl'), wire.map(row => JSON.stringify(row)).join('\n') + '\n');
      await writeFile(path.join(logRoot, 'children.json'), JSON.stringify(children.map(({label, run}) => ({label, ...run.snapshot()})), null, 2));
    });
    await cleanup(() => db?.close());
    await cleanup(() => rm(root, {recursive: true, force: true}));
    if (failures.length) throw new AggregateError(failures, 'Owned LUT transport cleanup failed');
  });

  const backend = ownedProcess([backendFixture, audit], environment(root), {ipc: true});
  children.push({label: 'backend', run: backend});
  const ready = new Promise((resolve, reject) => {
    backend.child.on('message', message => {
      if (message.type === 'ready') resolve(message);
      else if (message.type === 'fatal') reject(Error(message.message));
    });
    backend.child.once('error', reject);
    backend.closed.then(result => reject(Error(`Backend closed before readiness: ${JSON.stringify(result)}\n${backend.stderr}`)));
  });
  backend.child.send({type: 'start', root: path.join(root, 'data'), token});
  const started = await bounded(ready, 'Owned actual backend readiness');
  assert.equal(started.pid, backend.child.pid);
  assert.notEqual(started.pid, process.pid);
  assert.equal(new URL(started.url).hostname, '127.0.0.1');
  const url = started.url;
  db = new DatabaseSync(path.join(root, 'data/workbench.sqlite'), {readOnly: true});
  const snapshot = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({name}) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
  const checkpoint = () => ({rows: snapshot(), version: db.prepare('PRAGMA data_version').get().data_version});
  const unchanged = before => {
    assert.deepEqual(snapshot(), before.rows, 'read/replay/rejection does not change any persisted row');
    assert.equal(db.prepare('PRAGMA data_version').get().data_version, before.version,
      'read/replay/rejection does not perform an equal-value commit');
  };
  async function rpc(operation, input) {
    const response = await fetch(url + '/api/rpc', {method: 'POST', signal: AbortSignal.timeout(5_000),
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({operation, input})});
    const envelope = await response.json();
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    return envelope.data;
  }
  const connectionEnv = base => environment(root, {MIOON_BASE_URL: base, MIOON_TOKEN: token,
    MIOON_INSPECTION_WIRE_GUARD: '1', MIOON_INSPECTION_WIRE_ALLOWED_ORIGIN: base,
    MIOON_INSPECTION_WIRE_AUDIT: audit});
  async function cli(operation, input, expectedError, {file, base = url} = {}) {
    const args = ['--import', guard, path.join(repo, 'apps/cli/src/index.mjs'), ...operation.split('.'),
      '--input', JSON.stringify(input), ...(file ? ['--file', file] : [])];
    const run = ownedProcess(args, connectionEnv(base));
    children.push({label: `cli-${children.length}-${operation.replaceAll('.', '-')}`, run});
    let result;
    try { result = await run.finish(); }
    catch (error) { t.diagnostic(JSON.stringify(run.snapshot())); await run.close(); throw error; }
    assert.equal(result.signal, null, run.stderr);
    const lines = run.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'actual CLI emits exactly one JSON envelope');
    const envelope = JSON.parse(lines[0]);
    assert.equal(envelope.ok, !expectedError, run.stdout + run.stderr);
    if (expectedError) {
      assert.notEqual(result.code, 0, 'actual CLI reports failure through its exit status');
      assert.equal(envelope.error.code, expectedError, run.stdout);
      assert.match(run.stderr, new RegExp(expectedError));
    } else assert.equal(result.code, 0, run.stderr);
    return envelope;
  }
  async function mcpConnection(base = url) {
    const label = `mcp-${mcpChildren.length}`;
    const client = new Client({name: 'lut-resource-wire-acceptance', version: '1.0.0'}, {capabilities: {}});
    const transport = new StdioClientTransport({command: process.execPath, cwd: repo, stderr: 'pipe',
      args: ['--import', guard, path.join(repo, 'apps/mcp/src/index.mjs')], env: connectionEnv(base)});
    const child = {label, client, transport, stderr: ''};
    mcpChildren.push(child);
    transport.stderr.setEncoding('utf8').on('data', chunk => { child.stderr += chunk; });
    const send = transport.send.bind(transport);
    transport.send = message => { wire.push({label, direction: 'client-to-server', message}); return send(message); };
    const connecting = client.connect(transport);
    const receive = transport.onmessage;
    transport.onmessage = message => { wire.push({label, direction: 'server-to-client', message}); receive(message); };
    await bounded(connecting, 'Official MCP stdio initialization');
    assert.equal(client.getServerVersion().name, 'mioon');
    assert.ok(client.getServerCapabilities().tools);
    async function call(operation, input, expectedError) {
      const result = await client.callTool({name: operation.replaceAll('.', '_'), arguments: input}, undefined, {timeout: 5_000});
      const blocks = result.content.filter(block => block.type === 'text');
      assert.equal(blocks.length, 1);
      const envelope = JSON.parse(blocks[0].text);
      assert.deepEqual(result.structuredContent, envelope, 'MCP structured and text envelopes agree');
      assert.equal(Boolean(result.isError), Boolean(expectedError), blocks[0].text);
      assert.equal(envelope.ok, !expectedError, blocks[0].text);
      if (expectedError) assert.equal(envelope.error.code, expectedError);
      return envelope;
    }
    return {client, call};
  }
  async function responseProxy(mode) {
    const seen = [];
    let failure;
    const server = http.createServer(async (request, response) => {
      try {
        assert.equal(request.url, '/api/rpc');
        assert.equal(request.method, 'POST');
        const chunks = []; let length = 0;
        for await (const chunk of request) { length += chunk.length; assert.ok(length < 128 * 1024); chunks.push(chunk); }
        const bytes = Buffer.concat(chunks), submitted = JSON.parse(bytes);
        assert.equal(submitted.operation, 'lut.import', 'the failure proxy accepts only this LUT mutation');
        const upstream = await fetch(url + '/api/rpc', {method: 'POST', signal: AbortSignal.timeout(5_000),
          headers: {authorization: request.headers.authorization, 'content-type': 'application/json'}, body: bytes});
        const envelope = await upstream.json();
        assert.equal(upstream.status, 200, JSON.stringify(envelope));
        assert.equal(envelope.ok, true);
        const receipt = db.prepare('SELECT resourceId FROM lut_import_requests WHERE requestId=?').get(submitted.input.requestId);
        assert.equal(receipt.resourceId, envelope.data.resource.id, 'actual committed receipt exists before response loss/tampering');
        seen.push({submitted, envelope});
        if (mode === 'drop') { response.destroy(); return; }
        const changed = structuredClone(envelope);
        changed.data.resource.sha256 = changed.data.resource.sha256 === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
        response.writeHead(upstream.status, {'content-type': 'application/json'});
        response.end(JSON.stringify(changed));
      } catch (error) { failure = error; response.destroy(); }
    });
    proxies.push(server);
    await bounded(new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }), 'Owned proxy listen', 5_000);
    return {url: `http://127.0.0.1:${server.address().port}`, seen,
      assertHealthy() { if (failure) throw failure; }};
  }
  return {root, url, db, snapshot, checkpoint, unchanged, rpc, cli, mcpConnection, responseProxy,
    async noSideEffects() {
      assert.equal(await readFile(audit, 'utf8'), '', 'no network/provider/model/media subprocess was attempted');
      assert.deepEqual(await readdir(path.join(root, 'data/media')), [], 'no managed playable media was created');
    }};
}

test('actual CLI and official MCP stdio prove project-owned LUT import/replay and failure recovery', async t => {
  const f = await fixture(t);
  const project = await f.rpc('project.create', {name: 'LUT wire owner'});
  const other = await f.rpc('project.create', {name: 'Unrelated LUT wire project'});
  const before = f.snapshot();
  const file = path.join(f.root, 'local look 色调.cube');
  await writeFile(file, source);
  const input = {projectId: project.id, requestId: 'wire-cli-original-key', name: path.basename(file), dataBase64: source.toString('base64')};
  const saved = (await f.cli('lut.import', {projectId: project.id, requestId: input.requestId}, undefined, {file})).data;
  assert.equal(saved.requestId, input.requestId);
  assert.equal(saved.resource.name, path.basename(file), '--file uses only the basename');
  assert.equal(saved.resource.sha256, expectedHash);
  assert.equal(saved.resource.sizeBytes, source.length);
  assert.equal(saved.resource.kind, 'cube3d');
  assert.equal(saved.resource.metadata.size, 2);
  assert.equal(saved.resource.colourCompatibility, 'unverified');
  assert.equal(saved.resource.renderBinding, 'not_implemented');
  assert.deepEqual(Buffer.from(f.db.prepare('SELECT content FROM project_lut_resources WHERE id=?').get(saved.resource.id).content), source,
    'actual CLI --file preserves every original byte in real SQLite storage');
  metadataOnly(saved, f.root);

  const mcp = await f.mcpConnection();
  const tools = await mcp.client.listTools({}, {timeout: 5_000});
  for (const name of ['lut_import', 'lut_list', 'lut_inspect']) assert.ok(tools.tools.some(tool => tool.name === name), `${name} is discoverable on official stdio`);
  await t.test('same-key replay crosses transports and changed-key payload cannot alter the resource', async () => {
    const checkpoint = f.checkpoint();
    assert.deepEqual((await mcp.call('lut.import', input)).data, saved);
    assert.deepEqual((await f.cli('lut.import', input)).data, saved);
    for (const change of [{name: 'renamed.cube'}, {dataBase64: Buffer.concat([source, Buffer.from('\n')]).toString('base64')}, {projectId: other.id}])
      await mcp.call('lut.import', {...input, ...change}, 'IDEMPOTENCY_CONFLICT');
    await f.cli('lut.import', {...input, name: 'changed.cube'}, 'IDEMPOTENCY_CONFLICT');
    f.unchanged(checkpoint);
  });

  await t.test('both transports return only owned metadata and never register playable media', async () => {
    const checkpoint = f.checkpoint();
    for (const call of [f.cli, mcp.call]) {
      const list = (await call('lut.list', {projectId: project.id, limit: 1})).data;
      assert.deepEqual(list, {projectId: project.id, items: [saved.resource], nextAfter: null});
      const inspected = (await call('lut.inspect', {projectId: project.id, lutId: saved.resource.id})).data;
      assert.deepEqual(inspected, {resource: saved.resource, integrity: 'verified'});
      metadataOnly(list, f.root); metadataOnly(inspected, f.root);
      const empty = (await call('lut.list', {projectId: other.id})).data;
      assert.deepEqual(empty, {projectId: other.id, items: [], nextAfter: null});
      const denied = await call('lut.inspect', {projectId: other.id, lutId: saved.resource.id}, 'LUT_NOT_FOUND');
      assert.equal(JSON.stringify(denied).includes(saved.resource.name), false);
      assert.equal(JSON.stringify(denied).includes(saved.resource.sha256), false);
      assert.deepEqual((await call('asset.list', {projectId: project.id})).data, []);
    }
    const media = await fetch(f.url + '/media/' + saved.resource.id, {signal: AbortSignal.timeout(5_000), headers: {authorization: `Bearer ${token}`}});
    assert.equal(media.status, 404, 'LUT IDs are not exposed through the playable media route');
    await media.arrayBuffer();
    f.unchanged(checkpoint);
    await f.noSideEffects();
  });

  for (const mode of ['drop', 'tamper']) await t.test(`actual ${mode === 'drop' ? 'CLI lost' : 'MCP forged-hash'} acknowledgement is uncertain and explicitly recovered across transports`, async () => {
    const proxy = await f.responseProxy(mode);
    const original = {...input, requestId: `wire-${mode}-original-key`, name: `${mode}.cube`};
    const response = mode === 'drop'
      ? await f.cli('lut.import', original, 'BACKEND_UNAVAILABLE', {base: proxy.url})
      : await (await f.mcpConnection(proxy.url)).call('lut.import', original, 'BACKEND_PROTOCOL_ERROR');
    proxy.assertHealthy();
    assert.equal(response.error.details.operation, 'lut.import');
    assert.equal(response.error.details.requestId, original.requestId);
    assert.equal(response.error.details.submissionMayHaveSucceeded, true);
    assert.match(response.error.details.recovery, /exact original input.*same requestId/i);
    assert.equal(proxy.seen.length, 1, 'one actual request, not an automatic resubmission');
    assert.deepEqual(proxy.seen[0].submitted, {operation: 'lut.import', input: original});
    const committed = proxy.seen[0].envelope.data;
    const checkpoint = f.checkpoint();
    const recovered = mode === 'drop' ? await mcp.call('lut.import', original) : await f.cli('lut.import', original);
    assert.deepEqual(recovered.data, committed, 'explicit same-key cross-transport retry returns the original committed resource');
    await pause(50);
    assert.equal(proxy.seen.length, 1, 'no delayed automatic retry was scheduled');
    f.unchanged(checkpoint);
    metadataOnly(recovered, f.root);
  });

  const after = f.snapshot();
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const table of Object.keys(before)) if (!changedTables.has(table))
    assert.deepEqual(after[table], before[table], `${table} is untouched by LUT resource operations`);
  assert.equal(after.project_lut_resources.length, 3);
  assert.equal(after.lut_import_requests.length, 3);
  await f.noSideEffects();
});
