import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient, workspaceOriginOptions } from '@mioon/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const origin = '11111111-1111-4111-8111-111111111111';
const otherOrigin = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const entityId = '44444444-4444-4444-8444-444444444444';
const input = Object.freeze({ projectId, title: '恢复分支 · 固定来源编辑', requestId: 'original-pinned-edit' });
const result = { id: entityId, projectId, revision: 1 };
const env = { MIOON_TOKEN: 'synthetic-restored-client-test-token' };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const inspection = workspaceOrigin => ({ restored: true, schemaVersion: 25, profile: 'restored-local-v1', workspaceOrigin,
  restorationId: workspaceOrigin, createdAt: '2026-10-12T03:00:00.000Z', source: { backupId: entityId, schemaVersion: 24, manifestHash: 'a'.repeat(64), dbHash: 'b'.repeat(64) },
  heldCounts: [{ kind: 'edit_tasks', count: 1 }], operationPolicy: [{ operation: 'shot.create', available: true, reason: 'AVAILABLE' }],
  backupCreate: { available: false, reason: 'RESTORE_BACKUP_UNAVAILABLE' } });

test('SDK origin is explicit outer context, not a client default or domain field', async () => {
  const seen = [];
  const client = createClient({ env, expectedWorkspaceOrigin: otherOrigin, fetchImpl: async (_url, options) => { seen.push(JSON.parse(options.body)); return response({ ok: true, data: result }); } });
  await client.rpc('shot.create', input);
  const options = { expectedWorkspaceOrigin: origin };
  const pending = client.rpc('shot.create', input, options);
  options.expectedWorkspaceOrigin = otherOrigin;
  await pending;
  await client.rpc('shot.create', input);
  assert.deepEqual(seen, [{ operation: 'shot.create', input }, { operation: 'shot.create', input, expectedWorkspaceOrigin: origin }, { operation: 'shot.create', input }]);
  assert.deepEqual(input, { projectId, title: '恢复分支 · 固定来源编辑', requestId: 'original-pinned-edit' });
  await assert.rejects(client.rpc('shot.create', { ...input, expectedWorkspaceOrigin: origin }), { code: 'VALIDATION_ERROR' });
  assert.equal(seen.length, 3);
});

test('SDK rejects malformed context before fetching and never upgrades after inspect', async () => {
  let calls = 0, revealed = origin; const seen = [];
  const client = createClient({ env, fetchImpl: async (_url, options) => { calls++; const body = JSON.parse(options.body); seen.push(body); return response({ ok: true, data: body.operation === 'workspace.restore.inspect' ? inspection(revealed) : result }); } });
  for (const value of [null, {}, '', false, ` ${origin}`, origin + '\n']) {
    assert.throws(() => workspaceOriginOptions(value), { code: 'VALIDATION_ERROR' });
    await assert.rejects(client.rpc('shot.create', input, { expectedWorkspaceOrigin: value }), { code: 'VALIDATION_ERROR' });
  }
  assert.equal(calls, 0);
  await client.rpc('workspace.restore.inspect');
  await client.rpc('shot.create', input, { expectedWorkspaceOrigin: origin });
  revealed = otherOrigin;
  await client.rpc('workspace.restore.inspect');
  await client.rpc('shot.create', input, { expectedWorkspaceOrigin: origin });
  assert.deepEqual(seen.filter(value => value.operation === 'shot.create').map(value => value.expectedWorkspaceOrigin), [origin, origin]);
});

test('SDK validates restored inspection and retains original uncertainty on refusal', async () => {
  for (const invalid of [{ restored: true }, { ...inspection(origin), arbitraryAuthority: true }, { restored: false, workspaceOrigin: origin }])
    await assert.rejects(createClient({ env, fetchImpl: async () => response({ ok: true, data: invalid }) }).rpc('workspace.restore.inspect'), { code: 'BACKEND_PROTOCOL_ERROR' });
  for (const code of ['RESTORE_OPERATION_UNAVAILABLE', 'RESTORED_RECORD_HELD', 'RESTORE_WORKSPACE_ORIGIN_REQUIRED', 'RESTORE_WORKSPACE_ORIGIN_MISMATCH']) {
    let calls = 0;
    const client = createClient({ env, fetchImpl: async () => { calls++; return response({ ok: false, error: { code, message: 'Held', details: { mutationOutcome: 'not_applied', requestId: input.requestId } } }, 409); } });
    await assert.rejects(client.rpc('shot.create', input, { expectedWorkspaceOrigin: origin }), error => {
      assert.equal(error.code, code); assert.equal(error.details.expectedWorkspaceOrigin, origin);
      assert.equal(error.details.requestId, input.requestId); assert.equal(error.details.submissionMayHaveSucceeded, true);
      assert.equal(Object.hasOwn(error.details, 'mutationOutcome'), false); return true;
    });
    assert.equal(calls, 1);
  }
});

const root = fileURLToPath(new URL('..', import.meta.url));
async function fixture(t) {
  let revealed = origin; const requests = [], children = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/api/rpc'); assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, `Bearer ${env.MIOON_TOKEN}`);
      req.setEncoding('utf8');
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw Error('oversize test body'); }
      const body = JSON.parse(raw); requests.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: body.operation === 'workspace.restore.inspect' ? inspection(revealed) : result }));
    } catch { res.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const childEnv = { ...Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])), ...env, MIOON_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'close'); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  async function cli(args, entry = 'apps/cli/src/index.ts') {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    let stdout = '', stderr = ''; child.stdout.setEncoding('utf8').on('data', data => { stdout += data; }); child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    let code, signal; try { [code, signal] = await once(child, 'close'); } finally { clearTimeout(timer); }
    assert.equal(signal, null); return { code, stdout, stderr };
  }
  return { requests, childEnv, cli, reveal: value => { revealed = value; } };
}

test('real CLI keeps strict tool input and explicit invocation origin', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  for (const args of [[], ['--workspace-origin', origin], [`--workspace-origin=${origin}`]]) {
    const run = await f.cli(['shot', 'create', '--input', JSON.stringify(input), ...args]);
    assert.equal(run.code, 0, run.stderr); assert.deepEqual(JSON.parse(run.stdout), { ok: true, data: result });
  }
  assert.deepEqual(f.requests, [{ operation: 'shot.create', input }, ...Array.from({ length: 2 }, () => ({ operation: 'shot.create', input, expectedWorkspaceOrigin: origin }))]);
  for (const args of [['--workspace-origin', 'bad'], ['--workspace-origin', origin, '--workspace-origin', origin], ['--workspace-origin']]) {
    const run = await f.cli(['shot', 'create', '--input', JSON.stringify(input), ...args]);
    assert.equal(run.code, 2); assert.equal(JSON.parse(run.stdout).error.code, 'VALIDATION_ERROR');
  }
  assert.equal(f.requests.length, 3);
});

test('official MCP pins launch origin across real endpoint reload without adding tool authority', { timeout: 30000 }, async t => {
  const f = await fixture(t), next = await fixture(t);
  next.reveal(otherOrigin);
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-origin-rotation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, 'mcp-token'), connectionFile = path.join(directory, 'mcp-connection.json');
  await writeFile(tokenFile, env.MIOON_TOKEN, { mode: 0o600 });
  const connect = async url => writeFile(connectionFile, JSON.stringify({ version: 1, url, tokenFile, pid: process.pid }), { mode: 0o600 });
  await connect(f.childEnv.MIOON_BASE_URL);
  const childEnv = { ...f.childEnv, MIOON_CONNECTION_FILE: connectionFile };
  delete childEnv.MIOON_BASE_URL; delete childEnv.MIOON_TOKEN;
  const mcp = new Client({ name: 'origin-pin-test', version: '1.0' }, { capabilities: {} });
  const closed = new Promise(resolve => { mcp.onclose = resolve; });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['apps/mcp/src/index.ts', '--workspace-origin', origin], cwd: root, env: childEnv, stderr: 'pipe' });
  t.after(async () => { await mcp.close(); await closed; });
  await mcp.connect(transport);
  const catalog = await mcp.listTools();
  const create = catalog.tools.find(item => item.name === 'shot_create');
  assert.ok(create); assert.equal(create.inputSchema.additionalProperties, false);
  assert.equal(Object.hasOwn(create.inputSchema.properties, 'expectedWorkspaceOrigin'), false);
  assert.ok(catalog.tools.some(item => item.name === 'workspace_restore_inspect'));
  const call = async (name, args = {}) => { const value = await mcp.callTool({ name, arguments: args }); return JSON.parse(value.content.find(item => item.type === 'text').text); };
  assert.equal((await call('workspace_restore_inspect')).data.workspaceOrigin, origin);
  assert.equal((await call('shot_create', input)).ok, true);
  await connect(next.childEnv.MIOON_BASE_URL);
  assert.equal((await call('workspace_restore_inspect')).data.workspaceOrigin, otherOrigin);
  assert.equal((await call('shot_create', input)).ok, true);
  assert.deepEqual(f.requests.map(item => item.expectedWorkspaceOrigin), [origin, origin]);
  assert.deepEqual(next.requests.map(item => item.expectedWorkspaceOrigin), [origin, origin]);
  const bad = await call('shot_create', { ...input, expectedWorkspaceOrigin: otherOrigin });
  assert.equal(bad.ok, false); assert.equal(bad.error.code, 'VALIDATION_ERROR'); assert.equal(f.requests.length + next.requests.length, 4);
});
