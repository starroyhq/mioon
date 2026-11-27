import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {projectLocation, serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {createProjectBackup, openProjectBackup} from '../packages/business/src/project-file/backup.ts';
import {inspectProjectFormatReadOnly} from '../packages/business/src/project-file/connection.ts';
import {copyProjectToNewFile} from '../packages/business/src/project-file/copy.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT5_PROJECT_SCHEMA_VERSION, FORMAT6_PROJECT_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import type {SequenceEditHistoryView, SequenceEditReceipt} from '../packages/contracts/src/sequence-edit.ts';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {PROJECT_READER_UPDATE_REQUIRED, TIMELINE_FPS_READER_FEATURE} from '../packages/contracts/src/project-reader-requirements.ts';
import {isTimelineFormatReadResponse} from '../packages/contracts/src/timeline-format.ts';
import {TIMELINE_FPS} from '../packages/contracts/src/timeline-fps.ts';
import {testEnv} from './helpers/test-env.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {startServer} from './helpers/test-server.ts';

const token = 'synthetic-format-six-fps-token';
const format6 = {allowFormat6: true} as const;
const fpsGate = 'MIOON_FORMAT6_DEV';

function fixture(t: test.TestContext, enabled: boolean) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-project-fps-'));
  const prior = process.env[fpsGate];
  if (enabled) process.env[fpsGate] = '1';
  else delete process.env[fpsGate];
  t.after(() => {
    if (prior === undefined) delete process.env[fpsGate];
    else process.env[fpsGate] = prior;
    rmSync(root, {recursive: true, force: true});
  });
  const rpc = async (url: string, operation: string, input: unknown, route = '/api/rpc') => {
    const response = await fetch(url + route, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      body: JSON.stringify({operation, input})});
    return {status: response.status, result: await response.json()};
  };
  return {root, rpc};
}

function transportEnv(url: string): Record<string, string> {
  const env: Record<string, string> = {...testEnv(), MIOON_BASE_URL: url, MIOON_TOKEN: token};
  delete env.MIOON_CONNECTION_FILE;
  delete env.MIOON_TOKEN_FILE;
  return env;
}

async function runCli(env: Record<string, string>, operation: string[], input: unknown) {
  const result = await promisify(execFile)(process.execPath,
    ['apps/cli/src/index.ts', ...operation, '--input', JSON.stringify(input)], {env, encoding: 'utf8'});
  return JSON.parse(result.stdout);
}

test('the development server creates and reads all four clocks, and copied and restored projects keep them', async t => {
  const {root, rpc} = fixture(t, true);
  const options = {dataDir: root, port: 0, token, localDraftChannel: 'development' as const, projectFormatForTest: undefined};
  const server = await startServer(options);
  const created = [];
  try {
    for (const fps of TIMELINE_FPS) {
      const input = {name: `Synthetic ${fps}`, timelineFps: fps};
      const entry = await server.projectEntries.create(fps === 24 ? input : {...input, timelinePresetId: 'landscape_1080'});
      created.push({fps, entry});
      const formatRead = await rpc(server.url, 'timeline.format.get', {projectId: entry.projectId}, projectRpcPath(entry.projectId));
      assert.equal(formatRead.status, 200, JSON.stringify(formatRead.result));
      assert.ok(isTimelineFormatReadResponse(formatRead.result.data, {projectId: entry.projectId}));
      assert.equal(formatRead.result.data.fps, fps);
      assert.equal(formatRead.result.data.presetId, fps === 24 ? 'portrait_1080' : 'landscape_1080');
    }
    const appCreate = await rpc(server.url, 'project.create', {name: 'Application RPC', timelineFps: 25});
    assert.equal(appCreate.status, 200, JSON.stringify(appCreate.result));
    const projectId = appCreate.result.data.id;
    const rpcTimeline = await rpc(server.url, 'timeline.format.get', {projectId}, projectRpcPath(projectId));
    assert.equal(rpcTimeline.status, 200, JSON.stringify(rpcTimeline.result));
    assert.equal(rpcTimeline.result.data.fps, 25);
    const env = transportEnv(server.url);
    const cliCreate = await runCli(env, ['project', 'create'], {name: 'CLI', timelineFps: 60});
    assert.equal(cliCreate.ok, true);
    const cliRead = await runCli(env, ['timeline', 'format', 'get'], {projectId: cliCreate.data.id});
    assert.equal(cliRead.ok, true);
    assert.equal(cliRead.data.fps, 60);
    const unsupported = await rpc(server.url, 'project.create', {name: 'Fractional', timelineFps: 29.97});
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.result.error.code, 'VALIDATION_ERROR');
  } finally {await server.close();}
  const locate = (id: string) => projectLocation(serverAppDirectories(root), id);
  for (const {fps, entry} of created) {
    assert.equal(inspectProjectFormatReadOnly(entry.projectFile, format6).formatVersion, FORMAT6_PROJECT_SCHEMA_VERSION);
    const store = openProjectStore({...format6, projectFile: entry.projectFile, locate});
    const verify = (project: typeof store) => {
      const record = readFormat5TimelineRecord(project.db, 'project');
      assert.ok(record);
      assert.equal(record.fps, fps);
      assert.deepEqual((project.get('projects', project.projectId) as {requiredReaderFeatures?: string[]}).requiredReaderFeatures,
        fps === 30 ? undefined : [TIMELINE_FPS_READER_FEATURE]);
      return record;
    };
    try {
      const timeline = verify(store);
      assert.equal(timeline.clips.length, 0);
      const anotherFps = fps === 30 ? 24 : 30;
      assert.throws(() => store.tx(() => {
        if (fps === 30) store.db.prepare("UPDATE project.projects SET data=json_set(data,'$.requiredReaderFeatures',json_array(?))").run(TIMELINE_FPS_READER_FEATURE);
        store.db.prepare("UPDATE project.timelines SET data=json_set(data,'$.fps',?)").run(anotherFps);
      }), {code: 'TIMELINE_FORMAT_LOCKED'});
      assert.deepEqual(verify(store), timeline);
      const versions = createProjectVersions(store, {assertMutationAllowed() {}});
      const saved = versions.save({projectId: store.projectId, requestId: randomUUID()});
      const service = createFormat5SequenceEditService(store);
      const presetId = fps === 24 ? 'landscape_1080' : 'portrait_1080';
      const preview = service.preview({projectId: store.projectId, requestId: randomUUID(),
        formatIntent: {side: 'timeline', operation: {kind: 'timeline-format', presetId}}});
      assert.ok('envelope' in preview, JSON.stringify(preview));
      const edit = {projectId: store.projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest};
      const committed = service.commit(edit) as SequenceEditReceipt;
      assert.equal(committed.status, 'applied', JSON.stringify(committed));
      assert.notEqual(verify(store).width, timeline.width);
      assert.deepEqual(service.commit(edit), committed);
      const after = service.history({projectId: store.projectId}) as SequenceEditHistoryView;
      assert.ok(after.undo);
      service.undo({projectId: store.projectId, requestId: randomUUID(), actionId: after.undo.actionId,
        expected: {position: after.position, revision: after.revision}});
      assert.equal(verify(store).width, timeline.width);
      const undone = service.history({projectId: store.projectId}) as SequenceEditHistoryView;
      assert.ok(undone.redo);
      service.redo({projectId: store.projectId, requestId: randomUUID(), actionId: undone.redo.actionId,
        expected: {position: undone.position, revision: undone.revision}});
      assert.notEqual(verify(store).width, timeline.width);
      const confirmation = versions.preview({projectId: store.projectId, versionId: saved.version.id});
      const restore = {projectId: store.projectId, versionId: saved.version.id, requestId: randomUUID(),
        previewDigest: confirmation.previewDigest, expectedContentSequence: confirmation.contentSequence, expectedContentToken: confirmation.contentToken};
      const restoredVersion = versions.restore(restore);
      assert.equal(verify(store).width, timeline.width);
      assert.deepEqual(versions.restore(restore), restoredVersion);
      const copied = await copyProjectToNewFile(store, {projectFile: path.join(store.projectDir, 'copy.mioon'), sourceProjectDir: store.projectDir});
      const copiedStore = openProjectStore({...format6, projectFile: copied.projectFile, locate});
      try {verify(copiedStore);} finally {copiedStore.close();}
      const backupFile = path.join(store.localDir, 'clock-backup.mioon');
      await createProjectBackup(store, backupFile);
      const backup = openProjectBackup(backupFile);
      try {
        const restored = await copyProjectToNewFile(backup, {projectFile: path.join(store.projectDir, 'restored.mioon'), sourceProjectDir: store.projectDir});
        const restoredStore = openProjectStore({...format6, projectFile: restored.projectFile, locate});
        try {verify(restoredStore);} finally {restoredStore.close();}
      } finally {backup.close();}
    } finally {store.close();}
    if (fps !== 30) {
      delete process.env[fpsGate];
      try {assert.throws(() => inspectProjectFormatReadOnly(entry.projectFile, format6), {code: PROJECT_READER_UPDATE_REQUIRED});}
      finally {process.env[fpsGate] = '1';}
    }
  }
});

test('with the flag off and in older project formats, the create path stays at 30 fps', async t => {
  const {root, rpc} = fixture(t, false);
  for (const projectFormatForTest of [undefined, PROJECT_FILE_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT5_PROJECT_SCHEMA_VERSION] as const) {
    const server = await startServer({dataDir: root, port: 0, token, localDraftChannel: 'development', projectFormatForTest});
    try {
      const input = {name: 'Gated project', timelineFps: 24} as const;
      const rejected = await rpc(server.url, 'project.create', input);
      assert.equal(rejected.status, 400);
      assert.equal(rejected.result.error.code, 'VALIDATION_ERROR');
      await assert.rejects(server.projectEntries.create(input), {code: 'VALIDATION_ERROR'});
      const entry = await server.projectEntries.create({name: 'Existing 30 fps behavior', timelinePresetId: 'landscape_1080'});
      const format = await rpc(server.url, 'timeline.format.get', {projectId: entry.projectId}, projectRpcPath(entry.projectId));
      assert.equal(format.status, 200, JSON.stringify(format.result));
      assert.equal(format.result.data.fps, 30);
    } finally {await server.close();}
    process.env[fpsGate] = '1';
  }
});


test('CLI and MCP can confirm and reread a format-6 export while project metadata reads its exact receipt', async t => {
  const {root, rpc} = fixture(t, true);
  const server = await startServer({dataDir: root, port: 0, token, localDraftChannel: 'development', projectFormatForTest: undefined});
  const mcp = new Client({name: 'project-fps-export', version: '1.0.0'});
  try {
    const fps = 25;
    const {projectId} = await server.projectEntries.create({name: 'Export clock', timelineFps: fps, timelinePresetId: 'square_1080'});
    const route = projectRpcPath(projectId);
    const call = async (operation: string, input: Record<string, unknown> = {}) => {
      const response = await rpc(server.url, operation, {projectId, ...input}, route);
      assert.equal(response.status, 200, JSON.stringify(response.result));
      return response.result.data;
    };
    const asset = await call('asset.import', {name: 'Synthetic.png', mimeType: 'image/png', dataBase64: png().toString('base64')});
    const preview = await call('sequence.preview', {requestId: randomUUID(), intents: [{side: 'timeline',
      operation: {kind: 'track', edit: {kind: 'insert-asset', assetId: asset.id, trackId: null, startFrame: 0}}}]});
    await call('sequence.commit', {envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
    const before = await call('timeline.format.get');
    const exportSettings = {profileId: 'mp4_h264_float_checked_v2', resolution: 'short_360', rateControl: {mode: 'crf', quality: 'standard'}};
    const exportRange = {startFrame: 0, endFrame: 4};
    const preflight = await call('timeline.export.preflight', {expectedRevision: before.timelineRevision, exportRange, exportSettings});
    assert.equal(preflight.status, 'ready', JSON.stringify(preflight));
    const input = {projectId, requestId: randomUUID(), expectedRevision: before.timelineRevision, purpose: 'export',
      preflightSnapshotHash: preflight.snapshotHash, exportRange, exportSettings};
    const env = transportEnv(server.url);
    const ack = await runCli(env, ['timeline', 'render'], input);
    assert.equal(ack.ok, true);
    assert.equal(ack.data.snapshot.timeline.fps, fps);
    assert.equal(ack.data.snapshot.delivery.effective.fps, fps);
    assert.deepEqual(ack.data.snapshot.exportRange, exportRange);
    const replay = await runCli(env, ['timeline', 'render'], input);
    assert.deepEqual(replay, ack);
    const format = await call('timeline.format.get');
    assert.equal(format.fps, fps);
    assert.equal(format.timelineRevision, before.timelineRevision);

    await mcp.connect(new StdioClientTransport({command: process.execPath, args: ['apps/mcp/src/index.ts'], env, stderr: 'pipe'}));
    const replayTool = await mcp.callTool({name: 'timeline_render', arguments: input});
    const replayResult = replayTool.structuredContent as {ok?: unknown; data?: unknown} | undefined;
    assert.equal(replayResult?.ok, true, JSON.stringify(replayResult));
    assert.deepEqual(replayResult?.data, ack.data);
    const read = await runCli(env, ['export', 'get'], {projectId, exportId: ack.data.id});
    assert.equal(read.ok, true);
    assert.equal(read.data.id, ack.data.id);
    assert.equal(read.data.snapshot.timeline.fps, fps);
    const readTool = await mcp.callTool({name: 'export_get', arguments: {projectId, exportId: ack.data.id}});
    const readResult = readTool.structuredContent as {ok?: unknown; data?: {id?: unknown}} | undefined;
    assert.equal(readResult?.ok, true, JSON.stringify(readResult));
    assert.equal(readResult?.data?.id, ack.data.id);
  } finally {await mcp.close(); await server.close();}
});
