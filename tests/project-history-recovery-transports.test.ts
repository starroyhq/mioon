import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.ts';
import {createServerProject} from './helpers/project-database.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import type {ProjectHistoryStatus, ProjectHistoryResolveResult} from '../packages/contracts/src/project-history-recovery.ts';
import type {ProjectVersionListResponse, ProjectVersionPreviewResponse} from '../packages/contracts/src/project-version-operations.ts';

test('real HTTP recovery gates CLI/MCP and daily/old tasks, then activates only a clean execution history', {timeout: 120_000}, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'history-recovery-http-')), token = 'synthetic-history-recovery-token';
  const created = createServerProject(root, {name: 'Original'}), {projectId, store} = created;
  const saved = createProjectVersions(store).save({projectId, requestId: randomUUID(), name: 'A preserved local version'}).version;
  const unknownId = randomUUID();
  store.put('jobs', {id: unknownId, projectId, status: 'submission_unknown', providerJobId: 'synthetic-submitted-job', createdAt: '2026-11-04T00:00:00.000Z'});
  store.close();
  const raw = new DatabaseSync(store.projectFile);
  try {raw.prepare("UPDATE projects SET data=json_set(data,'$.name','External','$.revision',2) WHERE id=?").run(projectId);} finally {raw.close();}
  let inspected!: import('../apps/server/src/index.ts').InspectProject;
  const server = await startServer({dataDir: root, port: 0, token, inspectProject: inspect => {inspected = inspect;}});
  const mcp = new Client({name: 'history-recovery-test', version: '1.0.0'}, {capabilities: {}});
  t.after(async () => {await mcp.close(); await server.close(); rmSync(root, {recursive: true, force: true});});
  const headers = {authorization: `Bearer ${token}`, 'content-type': 'application/json'};
  const request = async <T>(suffix: string, input?: unknown) => {
    const response = await fetch(`${server.url}/api/projects/${projectId}/${suffix}`, {headers, ...(input === undefined ? {} : {method: 'POST', body: JSON.stringify(input)})});
    const body = await response.json() as {ok: boolean; data: T; error: {code: string}};
    return {response, body};
  };
  const status = await request<ProjectHistoryStatus>('history/status');
  assert.equal(status.response.status, 200); assert.equal(status.body.data.state, 'diverged');
  assert.equal(status.body.data.reason, 'file-sequence-larger'); assert.equal(status.body.data.unknownProviderTasks, 1);
  assert.equal(status.body.data.versionCount, 1);
  const snapshot = () => inspected(projectId, db => ({versions: db.prepare('SELECT * FROM project_versions').all(), marks: db.prepare('SELECT * FROM project_version_capture_marks').all(),
    requests: db.prepare('SELECT * FROM project_version_requests').all(), jobs: db.prepare('SELECT * FROM jobs').all(), content: db.prepare('SELECT * FROM project.project_file').all()}));
  const before = snapshot();
  const blocked = await request('rpc', {operation: 'project.version.save', input: {projectId, requestId: randomUUID()}});
  assert.equal(blocked.response.status, 409); assert.equal(blocked.body.error.code, 'PROJECT_HISTORY_DIVERGED');
  const env = {...process.env, MIOON_BASE_URL: server.url, MIOON_TOKEN: token, MIOON_ENABLE_LIVE_PROVIDER: '0'} as Record<string, string>;
  delete env.MIOON_CONNECTION_FILE; delete env.MIOON_TOKEN_FILE;
  await assert.rejects(promisify(execFile)(process.execPath, ['apps/cli/src/index.ts', 'project', 'version', 'list', '--input', JSON.stringify({projectId})], {env, encoding: 'utf8'}), (error: unknown) => {
    assert.ok(error && typeof error === 'object');
    const output = error as {stdout?: string; stderr?: string};
    assert.match((output.stdout ?? '') + (output.stderr ?? ''), /PROJECT_HISTORY_DIVERGED/u); return true;
  });
  await mcp.connect(new StdioClientTransport({command: process.execPath, args: ['apps/mcp/src/index.ts'], env, stderr: 'ignore'}));
  const denied = await mcp.callTool({name: 'project_version_list', arguments: {projectId}});
  assert.equal(denied.isError, true); assert.match(JSON.stringify(denied), /PROJECT_HISTORY_DIVERGED/u);
  const listed = await request<ProjectVersionListResponse>('history/versions');
  assert.deepEqual(listed.body.data.versions, [saved]);
  const preview = await request<ProjectVersionPreviewResponse>(`history/preview?versionId=${saved.id}`);
  assert.equal(preview.response.status, 200); assert.equal(preview.body.data.restoreAvailable, true); assert.ok(preview.body.data.totalChanges > 0);
  assert.deepEqual(snapshot(), before, 'recovery reads and rejected transports do not capture daily versions, acknowledge jobs or erase mismatch');
  const input = {projectId, requestId: randomUUID(), action: 'continue', expected: status.body.data.file,
    historyIdentity: status.body.data.historyIdentity, confirmationDigest: status.body.data.confirmationDigest};
  const mismatch = await request('history/resolve', {...input, projectId: randomUUID()});
  assert.equal(mismatch.response.status, 400); assert.equal(mismatch.body.error.code, 'PROJECT_ID_MISMATCH');
  assert.deepEqual(snapshot(), before);
  const uppercase = await request('history/resolve', {...input, requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'});
  assert.equal(uppercase.response.status, 400); assert.equal(uppercase.body.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(snapshot(), before, 'noncanonical file-name identity is refused before any intent is written');
  const resolved = await request<ProjectHistoryResolveResult>('history/resolve', input);
  assert.equal(resolved.response.status, 200, JSON.stringify(resolved.body));
  const normal = await request<ProjectVersionListResponse>('rpc', {operation: 'project.version.list', input: {projectId}});
  assert.equal(normal.response.status, 200, JSON.stringify(normal.body));
  assert.equal(normal.body.data.versions.filter(version => version.trigger === 'daily-open').length, 1);
  assert.equal(normal.body.data.versions.filter(version => version.id === saved.id).length, 1);
  const after = snapshot(); assert.equal(after.jobs.length, 0); assert.equal(after.requests.length, 0); assert.equal(after.marks.length, 1);
  const replay = await request<ProjectHistoryResolveResult>('history/resolve', input);
  assert.equal(replay.response.status, 200); assert.deepEqual(replay.body.data, resolved.body.data); assert.deepEqual(snapshot(), after);
});
