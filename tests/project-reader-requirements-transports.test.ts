import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {projectLocation, serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {projectEntryOpenFailure} from '../packages/contracts/src/project-entry-open-failure.ts';
import {PROJECT_READER_UPDATE_REQUIRED} from '../packages/contracts/src/project-reader-requirements.ts';
import {testEnv} from './helpers/test-env.ts';
import {startServer, type InspectApplication} from './helpers/test-server.ts';

const futureFeature = 'future-timeline-reader-v1';

function fileTree(root: string): unknown {
  const info = lstatSync(root, {throwIfNoEntry: false});
  if (!info) return null;
  if (!info.isDirectory()) return createHash('sha256').update(readFileSync(root)).digest('hex');
  return readdirSync(root).sort().map(name => [name, fileTree(path.join(root, name))]);
}

test('a future format-6 project is rejected before open, import, copy, history and Mio touch storage', {timeout: 120_000}, async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'reader-admission-'));
  const token = 'synthetic-project-reader-token', dataDir = path.join(root, 'app');
  const selection = path.join(root, 'selected'), destination = path.join(root, 'destination');
  mkdirSync(selection); mkdirSync(destination);
  const previous = process.env.MIOON_FORMAT6_DEV;
  process.env.MIOON_FORMAT6_DEV = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.MIOON_FORMAT6_DEV;
    else process.env.MIOON_FORMAT6_DEV = previous;
  });
  let inspect!: InspectApplication, backupAttempts = 0;
  const server = await startServer({dataDir, port: 0, token, localDraftChannel: 'development', projectFormatForTest: undefined,
    inspectApplication: observer => {inspect = observer;},
    projectBackupCopyForTest: async () => {backupAttempts++; throw Error('An unavailable reader cannot capture a backup');}});
  const mcp = new Client({name: 'project-reader-requirements', version: '1.0.0'}, {capabilities: {}});
  t.after(async () => {await mcp.close(); await server.close(); rmSync(root, {recursive: true, force: true});});

  const {projectId, projectFile} = await server.projectEntries.create({name: 'Future', timelinePresetId: 'landscape_1080'});
  const raw = new DatabaseSync(projectFile);
  let sourceStamp: {contentSequence: number; contentToken: string};
  try {
    assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, FORMAT6_PROJECT_SCHEMA_VERSION);
    assert.equal(raw.prepare("UPDATE projects SET data=json_set(data,'$.requiredReaderFeatures',json_array(?))").run(futureFeature).changes, 1);
    assert.equal(raw.prepare("UPDATE timelines SET data=json_set(data,'$.fps',24)").run().changes, 1);
    const stamp = raw.prepare('SELECT contentSequence,contentToken FROM project_file WHERE singleton=1').get();
    assert.ok(typeof stamp?.contentSequence === 'number' && typeof stamp.contentToken === 'string');
    sourceStamp = {contentSequence: stamp.contentSequence, contentToken: stamp.contentToken};
  } finally {raw.close();}
  const sourceFile = path.join(selection, 'Imported.mioon');
  copyFileSync(projectFile, sourceFile);
  const selectedIdentity = lstatSync(sourceFile, {bigint: true});
  const sourceIdentity = {dev: String(selectedIdentity.dev), ino: String(selectedIdentity.ino)};
  const {localDir, cacheDir, tempDir} = projectLocation(serverAppDirectories(dataDir), projectId);
  const files = () => [path.dirname(projectFile), selection, destination, localDir, cacheDir, tempDir,
    path.join(dataDir, 'project-copies'), path.join(dataDir, 'project-copy-actions')].map(fileTree);
  const records = () => inspect(db => ({
    registry: db.prepare('SELECT * FROM recent_projects ORDER BY position').all(),
    receipts: db.prepare('SELECT * FROM app_operation_receipts ORDER BY operation, requestId').all(),
  }));
  const beforeFiles = files(), beforeRecords = records();
  const details = {database: 'project', formatVersion: FORMAT6_PROJECT_SCHEMA_VERSION, unsupportedFeatures: [futureFeature]};
  const entries = server.projectEntries;
  for (const file of [projectFile, sourceFile]) {
    await assert.rejects(entries.openPath({projectFile: file, windowId: randomUUID()}), {code: PROJECT_READER_UPDATE_REQUIRED, details});
  }
  await assert.rejects(entries.observeSource!({projectFile: sourceFile}), error => {
    assert.deepEqual(projectEntryOpenFailure(error), {code: PROJECT_READER_UPDATE_REQUIRED});
    return true;
  });
  await assert.rejects(entries.inspectSelectedCopy!({projectFile: sourceFile}), {code: PROJECT_READER_UPDATE_REQUIRED, details});
  const catalog = await entries.listRecent();
  assert.equal(catalog.newProjectFormatVersion, FORMAT6_PROJECT_SCHEMA_VERSION);
  assert.deepEqual(catalog.registered.find(entry => entry.project.projectId === projectId)?.availability, {state: 'update-required'});

  const request = async (suffix: string, input?: unknown) => {
    const response = await fetch(`${server.url}/api/${suffix}`, {headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      ...(input === undefined ? {} : {method: 'POST', body: JSON.stringify(input)})});
    assert.equal(response.status, 409, suffix);
    const result = await response.json() as {ok: boolean; error: {code: string; details: unknown}};
    assert.equal(result.ok, false);
    assert.equal(result.error.code, PROJECT_READER_UPDATE_REQUIRED, suffix);
    assert.deepEqual(result.error.details, details, suffix);
  };
  const projectPath = `projects/${projectId}`;
  await request('rpc', {operation: 'project.duplicate', input: {projectId, requestId: randomUUID(), projectFile: path.join(destination, 'Duplicate.mioon')}});
  await request('rpc', {operation: 'project.copy-to', input: {sourceProjectId: projectId, sourceFile, sourceIdentity, sourceStamp,
    requestId: randomUUID(), projectFile: path.join(destination, 'Import.mioon')}});
  await request(`${projectPath}/history/status`);
  await request(`${projectPath}/agent/tasks/v2`);
  await request(`${projectPath}/rpc`, {operation: 'project.version.list', input: {projectId}});

  const env: Record<string, string> = {...testEnv(), MIOON_BASE_URL: server.url, MIOON_TOKEN: token};
  delete env.MIOON_CONNECTION_FILE; delete env.MIOON_TOKEN_FILE;
  const code = new RegExp(`\\b${PROJECT_READER_UPDATE_REQUIRED}\\b`, 'u');
  for (const args of [['project', 'version', 'list'], ['agent', 'task', 'list']]) {
    await assert.rejects(promisify(execFile)(process.execPath, ['apps/cli/src/index.ts', ...args, '--input', JSON.stringify({projectId})], {env, encoding: 'utf8'}),
      (error: {stdout?: string; stderr?: string}) => {
        assert.match((error.stdout ?? '') + (error.stderr ?? ''), code);
        return true;
      });
  }
  await mcp.connect(new StdioClientTransport({command: process.execPath, args: ['apps/mcp/src/index.ts'], env, stderr: 'ignore'}));
  const denied = await mcp.callTool({name: 'project_version_list', arguments: {projectId}});
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), code);
  assert.equal(backupAttempts, 0);
  assert.deepEqual(records(), beforeRecords, 'no recent-project or receipt changes');
  assert.deepEqual(files(), beforeFiles, 'original and selected .mioon files, local records, and copy destinations are unchanged');
});
