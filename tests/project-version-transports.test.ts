import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client as McpClient} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {createClient, operationDefinition, schemas, descriptions} from '@mioon/client';
import {schemas as registeredSchemas, descriptions as registeredDescriptions, operationEffect} from '@mioon/contracts';
import {projectBackupSchemas} from '../packages/contracts/src/project-backups.ts';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {rpcPathFor} from '../packages/contracts/src/project-addressing.ts';
import {projectVersionSchemas, projectVersionEffects, isProjectVersionResponse} from '../packages/contracts/src/project-version-operations.ts';
import type {ProjectVersionOperation, ProjectVersionListResponse, ProjectVersionSaveResponse, ProjectVersionPreviewResponse} from '../packages/contracts/src/project-version-operations.ts';
import type {ProjectVersionSummary} from '../packages/contracts/src/project-versions.ts';
import {readProjectState, changeMarks} from './helpers/project-state.ts';
import type {InspectProject} from '../apps/server/src/index.ts';

const run = promisify(execFile), repo = fileURLToPath(new URL('../', import.meta.url));
const token = 'synthetic-v1-version-transport-token';
const projectId = '11111111-aaaa-4111-8111-111111111111', versionId = randomUUID(), requestId = randomUUID();
const summary: ProjectVersionSummary = {id: versionId, projectId, trigger: 'manual', name: null, mioRunId: null,
  contentSequence: 7, createdAt: '2026-11-03T00:00:00.000Z'};
const preview: ProjectVersionPreviewResponse = {projectId, version: summary, contentSequence: 8, previewDigest: 'a'.repeat(64),
  totalChanges: 1, keptCurrentCount: 0, changes: [{table: 'projects', key: projectId, action: 'change', source: 'user-or-other', fields: ['data'], reason: null}],
  nextCursor: null, restoreAvailable: false};

test('version contracts expose only strict manual save and bounded read-only preview data', () => {
  assert.equal(schemas, registeredSchemas, 'client discovery uses the authoritative contracts registry without a private composition');
  assert.equal(descriptions, registeredDescriptions);
  for (const [operation, schema] of Object.entries({...projectBackupSchemas, ...projectVersionSchemas})) {
    assert.equal((registeredSchemas as Record<string, unknown>)[operation], schema);
    assert.equal(operationDefinition(operation).effects, operationEffect(operation));
  }
  for (const operation of Object.keys(projectVersionSchemas) as ProjectVersionOperation[]) {
    assert.equal(rpcPathFor(operation, {projectId}), projectRpcPath(projectId));
    assert.equal(projectVersionEffects[operation].readOnly, operation !== 'project.version.save');
    assert.equal(projectVersionEffects[operation].paidGeneration, false);
    assert.equal(projectVersionEffects[operation].externalIO, false);
    assert.equal(projectVersionEffects[operation].localProcess, false);
  }
  assert.equal(projectVersionSchemas['project.version.save'].safeParse({projectId, requestId}).success, true);
  for (const extra of [{trigger: 'daily-open'}, {mioRunId: randomUUID()}, {snapshot: {}}, {name: ''}, {name: 'x'.repeat(151)}])
    assert.equal(projectVersionSchemas['project.version.save'].safeParse({projectId, requestId, ...extra}).success, false);
  for (const limit of [0, 101, 1.5, '1'])
    assert.equal(projectVersionSchemas['project.version.list'].safeParse({projectId, limit}).success, false);
  assert.equal(projectVersionSchemas['project.version.preview'].safeParse({projectId, versionId, requestId}).success, false);
  assert.equal(projectVersionSchemas['project.version.preview'].safeParse({projectId, versionId, cursor: 'x'.repeat(4097)}).success, false);
  assert.equal(isProjectVersionResponse('project.version.list', {projectId}, {projectId, versions: [summary], nextCursor: null}), true);
  assert.equal(isProjectVersionResponse('project.version.list', {projectId}, {projectId, versions: [summary, summary], nextCursor: null}), false);
  assert.equal(isProjectVersionResponse('project.version.list', {projectId}, {projectId, versions: [{...summary, projectId: randomUUID()}], nextCursor: null}), false);
  assert.equal(isProjectVersionResponse('project.version.save', {projectId, requestId}, {projectId, requestId, version: summary}), true);
  assert.equal(isProjectVersionResponse('project.version.save', {projectId, requestId}, {projectId, requestId: randomUUID(), version: summary}), false);
  assert.equal(isProjectVersionResponse('project.version.save', {projectId, requestId, name: 'Named'}, {projectId, requestId, version: summary}), false);
  assert.equal(isProjectVersionResponse('project.version.save', {projectId, requestId}, {projectId, requestId, version: {...summary, trigger: 'daily-open'}}), false);
  assert.equal(isProjectVersionResponse('project.version.preview', {projectId, versionId}, preview), true);
  for (const patch of [{restoreAvailable: true}, {totalChanges: 0}, {version: {...summary, id: randomUUID()}},
    {changes: [{...preview.changes[0], table: 'mio_entries'}]}, {changes: [{...preview.changes[0], action: 'keep-current'}]},
    {changes: [{...preview.changes[0]}, {...preview.changes[0]}], totalChanges: 2}])
    assert.equal(isProjectVersionResponse('project.version.preview', {projectId, versionId}, {...preview, ...patch}), false);
});

test('client binds version replies and retains save identity after an uncertain acknowledgement', async () => {
  for (const operation of Object.keys(projectVersionSchemas) as ProjectVersionOperation[]) {
    assert.equal(Object.hasOwn(schemas, operation), true);
    const definition = operationDefinition(operation);
    assert.equal(definition.command, operation.replaceAll('.', ' '));
    assert.equal(definition.toolName, operation.replaceAll('.', '_'));
    assert.equal(definition.requiresRequestId, operation === 'project.version.save');
  }
  const requests: string[] = [];
  const client = createClient({env: {MIOON_BASE_URL: 'http://127.0.0.1:4318', MIOON_TOKEN: token}, fetchImpl: async (url) => {
    requests.push(String(url)); return Response.json({ok: true, data: {projectId, requestId, version: summary}});
  }});
  assert.deepEqual(await client.rpc('project.version.save', {projectId, requestId}), {projectId, requestId, version: summary});
  assert.equal(requests[0], 'http://127.0.0.1:4318' + projectRpcPath(projectId));
  await assert.rejects(client.rpc('project.version.save', {projectId, requestId, trigger: 'mio-turn'}), {code: 'VALIDATION_ERROR'});
  assert.equal(requests.length, 1);
  const wrong = createClient({env: {MIOON_BASE_URL: 'http://127.0.0.1:4318', MIOON_TOKEN: token}, fetchImpl: async () => Response.json({ok: true, data: {...preview, version: {...summary, projectId: randomUUID()}}})});
  await assert.rejects(wrong.rpc('project.version.preview', {projectId, versionId}), {code: 'BACKEND_PROTOCOL_ERROR'});
  let sends = 0;
  const disconnected = createClient({env: {MIOON_BASE_URL: 'http://127.0.0.1:4318', MIOON_TOKEN: token}, fetchImpl: async () => {sends++; throw Error('lost acknowledgement');}});
  await assert.rejects(disconnected.rpc('project.version.save', {projectId, requestId}), (error: unknown) => {
    const failure = error as {code: string; details: {requestId: string; submissionMayHaveSucceeded: boolean}};
    assert.equal(failure.code, 'BACKEND_UNAVAILABLE'); assert.equal(failure.details.requestId, requestId);
    assert.equal(failure.details.submissionMayHaveSucceeded, true); return true;
  });
  assert.equal(sends, 1);
});

test('HTTP CLI and official MCP agree on local version save/list/preview without restoration or automatic capture', {timeout: 120_000}, async t => {
  const {startServer} = await import('../apps/server/src/index.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'project-version-wire-'));
  let inspect!: InspectProject;
  let server = await startServer({dataDir: root, port: 0, token, inspectProject: received => {inspect = received;}});
  const mcp = new McpClient({name: 'project-version-test', version: '1.0.0'}, {capabilities: {}});
  t.after(async () => {await mcp.close(); await server.close(); await rm(root, {recursive: true, force: true});});
  const raw = async (operation: string, input: unknown, project: string | null) => {
    const response = await fetch(server.url + (project === null ? '/api/rpc' : projectRpcPath(project)), {method: 'POST',
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({operation, input})});
    return {response, body: await response.json() as {ok: boolean; data: unknown; error: {code: string}}};
  };
  const rpc = async <T>(operation: string, input: unknown, project: string | null): Promise<T> => {
    const result = await raw(operation, input, project);
    assert.equal(result.response.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true); return result.body.data as T;
  };
  const created = await rpc<{id: string; revision: number}>('project.create', {name: 'Versions 🎬'}, null);
  const other = await rpc<{id: string}>('project.create', {name: 'Other'}, null);
  const id = created.id;
  const env = {...process.env, MIOON_BASE_URL: server.url, MIOON_TOKEN: token, MIOON_ENABLE_LIVE_PROVIDER: '0'} as Record<string, string>;
  delete env.MIOON_CONNECTION_FILE; delete env.MIOON_TOKEN_FILE;
  const cli = async (operation: string, input: unknown): Promise<unknown> => {
    const result = await run(process.execPath, [path.join(repo, 'apps/cli/src/index.ts'), ...operation.split('.'), '--input', JSON.stringify(input)],
      {cwd: repo, env, timeout: 20_000, encoding: 'utf8'});
    const body = JSON.parse(result.stdout) as {ok: boolean; data: unknown}; assert.equal(body.ok, true, result.stderr); return body.data;
  };
  await mcp.connect(new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')], cwd: repo, env, stderr: 'ignore'}));
  const tool = async (operation: string, input: Record<string, unknown>): Promise<unknown> => {
    const result = await mcp.callTool({name: operation.replaceAll('.', '_'), arguments: input}) as CallToolResult;
    const text = result.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text');
    const envelope = JSON.parse(text.text) as {ok: boolean; data: unknown}; assert.deepEqual(result.structuredContent, envelope);
    assert.equal(result.isError, false, text.text); assert.equal(envelope.ok, true); return envelope.data;
  };
  const initial = await rpc<ProjectVersionListResponse>('project.version.list', {projectId: id}, id);
  assert.deepEqual(initial.versions, [], 'V1-A does not activate daily-open capture');
  const contentSequence = inspect(id, db => Number(db.prepare('SELECT contentSequence FROM project.project_file').get()?.contentSequence));
  const saving = {projectId: id, requestId: randomUUID(), name: 'Before notes 🎬'};
  const saved = await rpc<ProjectVersionSaveResponse>('project.version.save', saving, id);
  assert.equal(saved.version.trigger, 'manual'); assert.equal(saved.version.contentSequence, contentSequence);
  assert.deepEqual(await cli('project.version.save', saving), saved); assert.deepEqual(await tool('project.version.save', saving), saved);
  const again = await rpc<ProjectVersionSaveResponse>('project.version.save', {...saving, requestId: randomUUID()}, id);
  assert.notEqual(again.version.id, saved.version.id, 'a new manual request creates another version of the same content');
  assert.equal(again.version.contentSequence, saved.version.contentSequence);
  assert.equal(inspect(id, db => Number(db.prepare('SELECT contentSequence FROM project.project_file').get()?.contentSequence)), contentSequence);
  const latest = await rpc<ProjectVersionListResponse>('project.version.list', {projectId: id, limit: 1}, id);
  assert.equal(latest.versions.length, 1); assert.ok(latest.nextCursor);
  const rest = await rpc<ProjectVersionListResponse>('project.version.list', {projectId: id, limit: 1, cursor: latest.nextCursor}, id);
  assert.equal(rest.versions.length, 1); assert.equal(rest.nextCursor, null);
  assert.equal(new Set([...latest.versions, ...rest.versions].map(version => version.id)).size, 2);
  const changed = await raw('project.version.save', {...saving, name: 'Different'}, id);
  assert.equal(changed.response.status, 409); assert.equal(changed.body.error.code, 'REQUEST_ID_REUSED');
  const foreign = await raw('project.version.preview', {projectId: other.id, versionId: saved.version.id}, other.id);
  assert.equal(foreign.response.status, 404);
  const mismatch = await raw('project.version.list', {projectId: other.id}, id);
  assert.equal(mismatch.response.status, 400); assert.equal(mismatch.body.error.code, 'PROJECT_ID_MISMATCH');
  const app = await raw('project.version.list', {projectId: id}, null);
  assert.equal(app.response.status, 400); assert.equal(app.body.error.code, 'VALIDATION_ERROR');

  await rpc('project.notes.set', {projectId: id, requestId: randomUUID(), expectedRevision: created.revision, notes: 'Changed after snapshot'}, id);
  const before = inspect(id, db => ({state: readProjectState(db), marks: changeMarks(db)}));
  const selection = {projectId: id, versionId: saved.version.id};
  const diff = await rpc<ProjectVersionPreviewResponse>('project.version.preview', selection, id);
  assert.equal(diff.restoreAvailable, false); assert.ok(diff.totalChanges > 0);
  assert.ok(diff.changes.some(change => change.table === 'projects' && change.source === 'user-or-other'));
  assert.deepEqual(await cli('project.version.preview', selection), diff); assert.deepEqual(await tool('project.version.preview', selection), diff);
  const listed = await rpc<ProjectVersionListResponse>('project.version.list', {projectId: id}, id);
  assert.deepEqual(await cli('project.version.list', {projectId: id}), listed); assert.deepEqual(await tool('project.version.list', {projectId: id}), listed);
  assert.deepEqual(inspect(id, db => ({state: readProjectState(db), marks: changeMarks(db)})), before, 'list and preview across all transports leave every row and change mark identical');
  assert.equal(listed.versions.length, 2);
  await mcp.close(); await server.close();
  server = await startServer({dataDir: root, port: 0, token, inspectProject: received => {inspect = received;}});
  assert.deepEqual(await rpc('project.version.list', {projectId: id}, id), listed, 'saved versions persist without adding an automatic version on restart');
  assert.equal((await rpc<ProjectVersionPreviewResponse>('project.version.preview', selection, id)).previewDigest, diff.previewDigest);
});
