



import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {lstatSync, readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from './helpers/test-server.ts';



const run = promisify(execFile), repo = fileURLToPath(new URL('../', import.meta.url));
type WireBody = {ok: boolean; data?: unknown; error?: {code: string; message: string; details: unknown; retryable: boolean}};
// Call only after the owner has closed. A second descriptor of a held SQLite
// file would itself release the owner's POSIX locks.
function closedFiles(root: string, relative = ''): unknown[] {
  return readdirSync(path.join(root, relative)).sort().flatMap(name => {
    const file = path.join(relative, name), info = lstatSync(path.join(root, file));
    return info.isDirectory() ? [{file, mode: info.mode & 0o777}, ...closedFiles(root, file)] :
      [{file, mode: info.mode & 0o777, bytes: info.size, sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')}];
  });
}

test('workspace settings agree across public transports; retired workspace entries return unknown-operation without writes', {timeout: 90000}, async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-workspace-wire-'))), root = path.join(base, 'workspace'), token = 'synthetic-workspace-configuration-token';
  let server = await startServer({dataDir: root, port: 0, token});
  let client = new Client({name: 'workspace-configuration-wire-test', version: '1'}, {capabilities: {}});
  t.after(async () => {await client.close(); await server.close(); await rm(base, {recursive: true, force: true});});
  const environment = () => ({PATH: process.env.PATH || '', MIOON_BASE_URL: server.url, MIOON_TOKEN: token, });
  const connect = async () => {
    const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')], cwd: repo, env: environment(), stderr: 'pipe'});
    transport.stderr?.on('data',()=>{}); await client.connect(transport);
  };
  await connect();
  const request = (suffix: string, options: RequestInit = {}) => fetch(server.url + suffix, {...options, headers: {authorization: `Bearer ${token}`, ...options.headers}});
  const http = async (operation: string, input = {}) => {
    const response = await request('/api/rpc', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({operation, input})});
    return {status: response.status, body: await response.json() as WireBody};
  };
  const rpc = async (operation: string, input = {}) => {
    const {status, body} = await http(operation, input); assert.equal(status, 200, JSON.stringify(body)); assert.equal(body.ok, true, JSON.stringify(body)); return body.data;
  };
  const cli = async (operation: string, input = {}, expectedExit = 0) => {
    let code = 0, stdout = '';
    try {stdout = (await run(process.execPath, [path.join(repo, 'apps/cli/src/index.ts'), ...operation.split('.'), '--input', JSON.stringify(input)], {cwd: repo, env: environment(), timeout: 20000})).stdout;}
    catch (error) {const failure = error as {code: number; stdout: string}; code = failure.code; stdout = failure.stdout;}
    assert.equal(code, expectedExit); return JSON.parse(stdout) as WireBody;
  };
  const mcp = async (operation: string, input = {}, error = false) => {
    const result = await client.callTool({name: operation.replaceAll('.', '_'), arguments: input});
    assert.equal(result.isError, error, JSON.stringify(result));
    const body = result.structuredContent as WireBody;
    const content:unknown=result.content;assert.ok(Array.isArray(content));
    const text=content.find((block:unknown):block is {type:'text';text:string}=>block!==null&&typeof block==='object'&&'type' in block&&block.type==='text'&&'text' in block&&typeof block.text==='string');assert.ok(text);
    assert.deepEqual(JSON.parse(text.text), body); return body;
  };
  const initial = await rpc('workspace.settings.get') as {revision: number};
  assert.deepEqual((await cli('workspace.settings.get')).data, initial); assert.deepEqual((await mcp('workspace.settings.get')).data, initial);
  const enabled = (await cli('workspace.settings.set', {expectedRevision: initial.revision, liveGeneration: true})).data as {revision: number; liveGeneration: boolean};
  assert.equal(enabled.liveGeneration, true);
  const disabled = (await mcp('workspace.settings.set', {expectedRevision: enabled.revision, liveGeneration: false})).data as {liveGeneration: boolean};
  assert.equal(disabled.liveGeneration, true, 'an old client cannot turn generation off');
  const project = await rpc('project.create', {name: 'Backup transport project'}) as {id: string};
  assert.equal((await rpc('project.list') as {id: string}[])[0]!.id, project.id);
  await client.close(); await server.close();
  const before = closedFiles(base);
  // Reopen without acquiring a project. Rejected maintenance must not create
  // an alternate DB, activation pointer or backup directory.
  server = await startServer({dataDir: root, port: 0, token});
  client = new Client({name: 'workspace-configuration-rejections', version: '1'}, {capabilities: {}}); await connect();
  const key = randomUUID(), backupId = randomUUID();
  for (const [operation, input] of [
    ['workspace.backup.status', {}], ['workspace.backup.list', {}], ['workspace.backup.inspect', {backupId}], ['workspace.restore.inspect', {}],
    ['workspace.backup.create', {requestId: key}],
    ['workspace.backup.restore.stage', {requestId: randomUUID(), backupId, confirmation: 'RESTORE_BACKUP'}],
  ] as const) {
    const failure = await http(operation, input);
    assert.equal(failure.status, 404); assert.equal(failure.body.ok, false); assert.equal(failure.body.error?.code, 'UNKNOWN_OPERATION');
    const cliFailure = await cli(operation, input, 2), mcpFailure = await mcp(operation, input, true);
    assert.equal(cliFailure.ok, false); assert.equal(cliFailure.error?.code, 'UNKNOWN_OPERATION');
    assert.equal(mcpFailure.ok, false); assert.equal(mcpFailure.error?.code, 'UNKNOWN_OPERATION');
  }
  const tools = await client.listTools();
  assert.equal(tools.tools.some(tool => tool.name.startsWith('workspace_backup_') || tool.name === 'workspace_restore_inspect'), false);
  const bad = await http('workspace.backup.restore.stage', {requestId: randomUUID(), backupId});
  assert.equal(bad.status, 404); assert.equal(bad.body.error?.code, 'UNKNOWN_OPERATION');
  const download = await request(`/api/workspace-backups/${backupId}/download`);
  assert.equal(download.status, 404); assert.equal((await download.json()).error.code, 'NOT_FOUND');
  const imported = await request(`/api/workspace-backups/import?requestId=${randomUUID()}`, {method: 'POST', headers: {'Content-Type': 'application/vnd.mioon.workspace-backup'}, body: new Uint8Array([1, 2, 3])});
  assert.equal(imported.status, 404); assert.equal((await imported.json()).error.code, 'NOT_FOUND');
  assert.deepEqual(await rpc('workspace.settings.get'), disabled); assert.equal((await rpc('project.list') as {id: string}[])[0]!.id, project.id);
  await client.close(); await server.close();
  assert.deepEqual(closedFiles(base), before, 'rejected maintenance leaves every application/project database byte, companion and file unchanged');
});
