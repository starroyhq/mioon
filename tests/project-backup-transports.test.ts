import {testEnv} from './helpers/test-env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client as McpClient} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {createClient, operationDefinition, schemas} from '@mioon/client';
import {startServer} from './helpers/test-server.ts';
import {rpcPathFor} from '../packages/contracts/src/project-addressing.ts';
import {projectBackupSchemas, isProjectBackupResponse} from '../packages/contracts/src/project-backups.ts';
import type {ProjectBackupOperation, ProjectBackupSummary, ProjectBackupInspection, ProjectBackupStatus, ProjectBackupRestoreResponse} from '../packages/contracts/src/project-backups.ts';
import {callProjectBackupOperation} from '../apps/server/src/project-backup-operations.ts';
import type {ProjectBackupOperations} from '../apps/server/src/project-backup-operations.ts';

const run = promisify(execFile), repo = fileURLToPath(new URL('../', import.meta.url));
const token = 'synthetic-v2-backup-transport-token';
const projectId = '11111111-aaaa-4111-8111-111111111111', backupId = randomUUID(), now = '2026-11-03T00:00:00.000Z';
const summary: ProjectBackupSummary = {projectId, backupId, contentSequence: 7,contentToken:'0123456789abcdef0123456789abcdef', createdAt: now, reason: 'open', sizeBytes: 16384};
const status: ProjectBackupStatus = {projectId, state: 'idle', lastAttemptAt: now, lastCompletedAt: now, lastError: null};

test('backup contracts are explicit application operations, strict and separate from Mio tools', async () => {
  for (const operation of Object.keys(projectBackupSchemas) as ProjectBackupOperation[]) {
    assert.equal(rpcPathFor(operation, {projectId}), '/api/rpc');
    assert.equal(Object.hasOwn(schemas, operation), true);
    const definition = operationDefinition(operation);
    assert.equal(definition.toolName, operation.replaceAll('.', '_'));
    assert.equal(definition.command, operation.replaceAll('.', ' '));
    assert.equal(definition.requiresRequestId, operation === 'project.backup.restore');
    assert.equal(definition.effects.paidGeneration, false);
    assert.equal(definition.effects.externalIO, false);
    assert.equal(definition.effects.localProcess, false);
    assert.equal(definition.effects.readOnly, operation !== 'project.backup.restore');
    assert.equal(projectBackupSchemas[operation].safeParse({projectId, backupId, source: '/private/source.mioon'}).success, false);
  }
  const restore = {projectId, backupId, requestId: randomUUID(), projectFile: '/private/tmp/new.mioon'};
  assert.equal(projectBackupSchemas['project.backup.restore'].safeParse(restore).success, true);
  for (const projectFile of ['relative.mioon', '/private/../new.mioon', '/private/tmp/new.sqlite', '/private/tmp/new.mioon\0'])
    assert.equal(projectBackupSchemas['project.backup.restore'].safeParse({...restore, projectFile}).success, false);
  assert.equal(projectBackupSchemas['project.backup.restore'].safeParse({...restore, projectId: projectId.toUpperCase()}).success, false);
  assert.equal(projectBackupSchemas['project.backup.list'].safeParse({projectId}).success, true);
  assert.equal(isProjectBackupResponse('project.backup.list', {projectId}, {projectId, backups: [summary]}), true);
  for(const contentToken of [undefined,'0'.repeat(31),'A'.repeat(32),'g'.repeat(32)])assert.equal(isProjectBackupResponse('project.backup.list',{projectId},{projectId,backups:[{...summary,contentToken}]}),false);
  assert.equal(isProjectBackupResponse('project.backup.list', {projectId}, {projectId, backups: [summary, summary]}), false);
  assert.equal(isProjectBackupResponse('project.backup.inspect', {projectId, backupId}, {...summary, backupId: randomUUID(), projectName: 'Example', sourceProjectDir: '/private/tmp', tableCounts: {projects: 1}}), false);
  assert.equal(isProjectBackupResponse('project.backup.status', {projectId}, {...status, projectId: randomUUID()}), false);

  let calls = 0;
  const ports: ProjectBackupOperations = {
    list: () => { calls++; return {projectId, backups: [summary]}; },
    inspect: () => { throw Error('unexpected inspect'); },
    restore: async () => { throw Error('unexpected restore'); },
    status: () => status,
  };
  await assert.rejects(callProjectBackupOperation(ports, 'project.backup.list', {projectId, path: '/private/source'}), {code: 'VALIDATION_ERROR'});
  assert.equal(calls, 0);
  assert.deepEqual(await callProjectBackupOperation(ports, 'project.backup.list', {projectId}), {projectId, backups: [summary]});
  assert.equal(calls, 1);
  await assert.rejects(callProjectBackupOperation({...ports, list: () => ({projectId: randomUUID(), backups: []})}, 'project.backup.list', {projectId}), {code: 'INTERNAL_ERROR'});
});

test('client validates backup replies and preserves restore recovery identity without automatic replay', async () => {
  const requests: Array<{url: string; input: unknown}> = [];
  const client = createClient({env: {MIOON_BASE_URL: 'http://127.0.0.1:4318', MIOON_TOKEN: token}, fetchImpl: async (url, init) => {
    requests.push({url: String(url), input: JSON.parse(String(init?.body))});
    return Response.json({ok: true, data: {projectId, backups: [summary]}});
  }});
  assert.deepEqual(await client.rpc('project.backup.list', {projectId}), {projectId, backups: [summary]});
  assert.equal(requests[0]!.url, 'http://127.0.0.1:4318/api/rpc');
  await assert.rejects(client.rpc('project.backup.list', {projectId, file: '/private/source'}), {code: 'VALIDATION_ERROR'});
  assert.equal(requests.length, 1, 'invalid paths do not reach the backend');
  const wrong = createClient({env: {MIOON_BASE_URL: 'http://127.0.0.1:4318', MIOON_TOKEN: token}, fetchImpl: async () => Response.json({ok: true, data: {...status, projectId: randomUUID()}})});
  await assert.rejects(wrong.rpc('project.backup.status', {projectId}), {code: 'BACKEND_PROTOCOL_ERROR'});
  const requestId = randomUUID(); let sends = 0;
  const disconnected = createClient({env: {MIOON_BASE_URL: 'http://127.0.0.1:4318', MIOON_TOKEN: token}, fetchImpl: async () => { sends++; throw Error('lost acknowledgement'); }});
  await assert.rejects(disconnected.rpc('project.backup.restore', {projectId, backupId, requestId, projectFile: '/private/tmp/new.mioon'}), (error: unknown) => {
    const failure = error as {code: string; details: {requestId: string; submissionMayHaveSucceeded: boolean}};
    assert.equal(failure.code, 'BACKEND_UNAVAILABLE');
    assert.equal(failure.details.requestId, requestId);
    assert.equal(failure.details.submissionMayHaveSucceeded, true);
    return true;
  });
  assert.equal(sends, 1);
});

test('closed-project backup operations agree over HTTP CLI and MCP; recovery returns one new project', {timeout: 120_000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-v2-backup-wire-'));
  let server = await startServer({dataDir: root, port: 0, token});
  const mcp = new McpClient({name: 'v2-backup-wire', version: '1'}, {capabilities: {}});
  t.after(async () => { await mcp.close(); await server.close(); await rm(root, {recursive: true, force: true}); });
  const rpc = async <T>(operation: string, input: unknown): Promise<T> => {
    const response = await fetch(server.url + '/api/rpc', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({operation, input})});
    const body = await response.json() as {ok: boolean; data: T};
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    return body.data;
  };
  const original = await rpc<{id: string; revision: number}>('project.create', {name: 'Backup 🎬'});
  await server.close();
  server = await startServer({dataDir: root, port: 0, token});
  const env = {...testEnv(), MIOON_BASE_URL: server.url, MIOON_TOKEN: token, } as Record<string, string>;
  delete env.MIOON_CONNECTION_FILE; delete env.MIOON_TOKEN_FILE;
  const cli = async (operation: string, input: unknown): Promise<unknown> => {
    const result = await run(process.execPath, [path.join(repo, 'apps/cli/src/index.ts'), ...operation.split('.'), '--input', JSON.stringify(input)], {cwd: repo, env, timeout: 20_000, encoding: 'utf8'});
    const body = JSON.parse(result.stdout) as {ok: boolean; data: unknown};
    assert.equal(body.ok, true, result.stderr);
    return body.data;
  };
  await mcp.connect(new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')], cwd: repo, env, stderr: 'ignore'}));
  const tool = async (operation: string, input: Record<string, unknown>): Promise<unknown> => {
    const result = await mcp.callTool({name: operation.replaceAll('.', '_'), arguments: input}) as CallToolResult;
    const text = result.content.find(item => item.type === 'text');
    assert.ok(text && text.type === 'text');
    const envelope = JSON.parse(text.text) as {ok: boolean; data: unknown};
    assert.deepEqual(result.structuredContent, envelope);
    assert.equal(result.isError, false, text.text);
    assert.equal(envelope.ok, true);
    return envelope.data;
  };
  const input = {projectId: original.id};
  const list = await rpc<{projectId: string; backups: ProjectBackupSummary[]}>('project.backup.list', input);
  assert.ok(list.backups.length >= 1 && list.backups.length <= 3);
  assert.deepEqual(await cli('project.backup.list', input), list);
  assert.deepEqual(await tool('project.backup.list', input), list);
  const selection = {...input, backupId: list.backups[0]!.backupId};
  const inspection = await rpc<ProjectBackupInspection>('project.backup.inspect', selection);
  assert.equal(inspection.projectName, 'Backup 🎬');
  assert.equal(inspection.tableCounts.projects, 1);
  assert.deepEqual(await cli('project.backup.inspect', selection), inspection);
  assert.deepEqual(await tool('project.backup.inspect', selection), inspection);
  const savedStatus = await rpc<ProjectBackupStatus>('project.backup.status', input);
  assert.notEqual(savedStatus.state, 'failed');
  assert.deepEqual(await cli('project.backup.status', input), savedStatus);
  assert.deepEqual(await tool('project.backup.status', input), savedStatus);
  const target = path.join(root, 'projects', 'Recovered'); await mkdir(target, {mode: 0o755});
  const restoration = {...selection, requestId: randomUUID(), projectFile: path.join(target, 'Recovered.mioon')};
  const restored = await rpc<ProjectBackupRestoreResponse>('project.backup.restore', restoration);
  assert.notEqual(restored.project.projectId, original.id);
  assert.equal(restored.project.projectFile, restoration.projectFile);
  assert.deepEqual(await cli('project.backup.restore', restoration), restored);
  assert.deepEqual(await tool('project.backup.restore', restoration), restored);
  const recoveredId = restored.project.projectId, windowId = randomUUID();
  const opened = await server.projectEntries.acquire({projectId: recoveredId, windowId,
    expectedProjectFile: restoration.projectFile, deferRecent: true});
  try {
    assert.equal(opened.project.projectId, recoveredId);
    assert.equal(opened.project.projectFile, restoration.projectFile);
    const client = createClient({env});
    const data = await client.rpc<{project: {id: string; name: string}}>('project.get', {projectId: recoveredId});
    assert.equal(data.project.id, recoveredId);
    assert.equal(data.project.name, inspection.projectName);
  } finally {
    server.projectEntries.release({windowId});
  }
  await rpc('project.rename', {projectId: restored.project.projectId, requestId: randomUUID(), expectedRevision: original.revision, name: 'Renamed after recovery'});
  assert.deepEqual(await rpc('project.backup.restore', restoration), restored, 'later registry edits cannot change the original recovery receipt');
  const changed = await fetch(server.url + '/api/rpc', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({operation: 'project.backup.restore', input: {...restoration, projectFile: path.join(target, 'different.mioon')}})});
  assert.equal(changed.status, 409);
  assert.equal((await changed.json() as {error: {code: string}}).error.code, 'REQUEST_ID_REUSED');
  const projects = await rpc<Array<{id: string}>>('project.list', {});
  assert.equal(projects.filter(project => project.id === restored.project.projectId).length, 1);
  const existing = path.join(target, 'existing.mioon'); await writeFile(existing, 'preserve existing');
  const response = await fetch(server.url + '/api/rpc', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({operation: 'project.backup.restore', input: {...restoration, requestId: randomUUID(), projectFile: existing}})});
  assert.equal(response.status, 409);
  assert.equal((await response.json() as {error: {code: string}}).error.code, 'PROJECT_FILE_EXISTS');
  assert.equal(await readFile(existing, 'utf8'), 'preserve existing');
});
