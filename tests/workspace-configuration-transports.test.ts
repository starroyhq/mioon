import {CURRENT_RESTORED_SCHEMA} from './helpers/workspace-schema-current.ts';
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
import {startServer} from '../apps/server/src/index.ts';
import {resolveWorkspaceActivation} from '../packages/business/src/workspace-backup-runtime.ts';
import {openLegacyWorkspaceConfiguration} from './fixtures/legacy-workspace-configuration.ts';

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

test('workspace settings agree across public transports; project layout refuses backup/import/restore without writes', {timeout: 90000}, async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-workspace-wire-'))), root = path.join(base, 'workspace'), token = 'synthetic-workspace-configuration-token';
  let server = await startServer({dataDir: root, port: 0, token});
  let client = new Client({name: 'workspace-configuration-wire-test', version: '1'}, {capabilities: {}});
  t.after(async () => {await client.close(); await server.close(); await rm(base, {recursive: true, force: true});});
  const environment = () => ({PATH: process.env.PATH || '', MIOON_BASE_URL: server.url, MIOON_TOKEN: token, MIOON_ENABLE_LIVE_PROVIDER: '0'});
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
  assert.equal(disabled.liveGeneration, false);
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
    ['workspace.backup.status', {}], ['workspace.backup.list', {}],
    ['workspace.backup.create', {requestId: key}],
    ['workspace.backup.restore.stage', {requestId: randomUUID(), backupId, confirmation: 'RESTORE_BACKUP'}],
  ] as const) {
    const failure = await http(operation, input);
    assert.equal(failure.status, 409); assert.equal(failure.body.ok, false); assert.equal(failure.body.error?.code, 'RESTORE_OPERATION_UNAVAILABLE');
    // CLI/MCP retain their explicit invocation address in recovery details.
    const transported={...failure.body,error:{...failure.body.error!,details:{operation}}};
    assert.deepEqual(await cli(operation, input, 3), transported); assert.deepEqual(await mcp(operation, input, true), transported);
  }
  assert.deepEqual(await rpc('workspace.restore.inspect', {}), {restored: false});
  const bad = await http('workspace.backup.restore.stage', {requestId: randomUUID(), backupId});
  assert.equal(bad.status, 400); assert.equal(bad.body.error?.code, 'VALIDATION_ERROR');
  const download = await request(`/api/workspace-backups/${backupId}/download`);
  assert.equal(download.status, 409); assert.equal((await download.json()).error.code, 'RESTORE_OPERATION_UNAVAILABLE');
  const imported = await request(`/api/workspace-backups/import?requestId=${randomUUID()}`, {method: 'POST', headers: {'Content-Type': 'application/vnd.mioon.workspace-backup'}, body: new Uint8Array([1, 2, 3])});
  assert.equal(imported.status, 409); assert.equal((await imported.json()).error.code, 'RESTORE_OPERATION_UNAVAILABLE');
  assert.deepEqual(await rpc('workspace.settings.get'), disabled); assert.equal((await rpc('project.list') as {id: string}[])[0]!.id, project.id);
  await client.close(); await server.close();
  assert.deepEqual(closedFiles(base), before, 'rejected maintenance leaves every application/project database byte, companion and file unchanged');
});

test('explicit legacy fixture preserves online backup receipts, bundle import and guarded restart activation', {timeout: 90000}, async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-legacy-workspace-backup-'))), root = path.join(base, 'workspace');
  let quiescent=false;
  let legacy = openLegacyWorkspaceConfiguration(root,{backupQuiescent:()=>quiescent});
  t.after(async () => {await legacy.close(); await rm(base, {recursive: true, force: true});});
  const project = await legacy.services.call('project.create', {name: 'Backup transport project'}) as {id: string};
  // Preserve the legacy model/runtime admission fence separately from the
  // new host's unconditional S7 refusal, including success after settlement.
  const key = randomUUID();
  await assert.rejects(legacy.services.call('workspace.backup.create',{requestId:key}),error=>(error as {code?:string}).code==='WORKSPACE_BACKUP_BUSY');
  assert.deepEqual(await legacy.services.call('workspace.backup.list',{}),[]);
  quiescent=true;
  const backup = await legacy.services.call('workspace.backup.create', {requestId: key}) as {id: string};
  assert.deepEqual(await legacy.services.call('workspace.backup.create', {requestId: key}), backup);
  assert.deepEqual(await legacy.services.call('workspace.backup.list', {}), [backup]);
  const chunks: Uint8Array[] = [];
  for await (const chunk of legacy.services.backups.exportBundle(backup.id)) chunks.push(chunk);
  const bytes = Buffer.concat(chunks); assert.ok(bytes.length > 100); assert.match(bytes.toString('ascii', 0, 22), /^MIOON-BACKUP-BUNDLE-1\n/);
  async function* upload() {for(let offset=0;offset<bytes.length;offset+=64*1024)yield bytes.subarray(offset,offset+64*1024);}
  const importKey = {requestId: randomUUID()}, imported = await legacy.services.backups.importBundle(upload(), importKey);
  assert.equal(imported.trigger, 'import'); assert.deepEqual(await legacy.services.backups.importBundle(upload(), importKey), imported);
  await assert.rejects(legacy.services.call('workspace.backup.restore.stage', {requestId: randomUUID(), backupId: backup.id}), error => (error as {code?: string}).code === 'VALIDATION_ERROR');
  const intent = {requestId: randomUUID(), backupId: backup.id, confirmation: 'RESTORE_BACKUP'}, pending = await legacy.services.call('workspace.backup.restore.stage', intent) as {restartRequired: boolean};
  assert.equal(pending.restartRequired, true); assert.deepEqual(await legacy.services.call('workspace.backup.restore.stage', intent), pending);
  await legacy.close();
  const activation = await resolveWorkspaceActivation(root); assert.notEqual(activation.root, root); assert.equal(activation.restored, true);
  legacy = openLegacyWorkspaceConfiguration(activation.root);
  const restored = await legacy.services.call('workspace.restore.inspect', {}) as {restored: boolean; schemaVersion: number};
  assert.equal(restored.restored, true); assert.equal(restored.schemaVersion, CURRENT_RESTORED_SCHEMA);
  assert.equal((await legacy.services.call('project.list', {}) as {id: string}[])[0]!.id, project.id);
});
