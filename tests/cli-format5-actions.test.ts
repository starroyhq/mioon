import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from './helpers/test-server.ts';
import {testEnv} from './helpers/test-env.ts';
import {BOARD_IDS, createBoardUiWireFixture} from './helpers/board-ui-wire-fixture.ts';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {sequenceHistoryViewResponseSchema} from '../packages/contracts/src/sequence-editing.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {Format5EditSession, format5UserUndoBlocked} from '../apps/web/src/edit-ui/session.ts';

const run = promisify(execFile);
const TOKEN = 'synthetic-cli-format5-actions-token';
type Row = Record<string, any>;
const data = (result: string): Row => {
  const body = JSON.parse(result) as {ok?: boolean; data?: Row};
  assert.equal(body.ok, true, result.slice(0, 300));
  return body.data as Row;
};
function cliProcess(env: NodeJS.ProcessEnv, ...words: string[]) {
  return run(process.execPath, ['apps/cli/src/index.ts', ...words], {
    cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
}
async function cli(env: NodeJS.ProcessEnv, ...words: string[]): Promise<Row> {
  const result = await cliProcess(env, ...words);
  return data(result.stdout);
}
async function preview(cliEnv: NodeJS.ProcessEnv, operation: string[], action: Row): Promise<Row> {
  return cli(cliEnv, ...operation, '--input', JSON.stringify(action));
}
async function commit(cliEnv: NodeJS.ProcessEnv, projectId: string, plan: Row): Promise<Row> {
  return cli(cliEnv, 'sequence', 'action', 'commit', '--input', JSON.stringify({projectId,
    envelope: plan.envelope, expectedPlanDigest: plan.planDigest}));
}
async function connectMcp(t: TestContext, env: Record<string, string>) {
  const client = new Client({name: 'format5-actions-test', version: '1.0.0'});
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({command: process.execPath, args: ['apps/mcp/src/index.ts'],
    cwd: path.resolve(import.meta.dirname, '..'), env, stderr: 'ignore'}));
  return client;
}
async function mcpAction(client: Client, name: string, input: Record<string, unknown>): Promise<Row> {
  const result = await client.callTool({name, arguments: input}, undefined, {timeout: 15_000});
  return data(JSON.stringify(result.structuredContent));
}
test('actual CLI and MCP format-5 actions share the editor undo and redo history', async (t: TestContext) => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-cli-format5-'));
  const server = await startServer({dataDir: root, port: 0, token: TOKEN, projectFormatForTest: 5});
  t.after(async () => { await server.close(); rmSync(root, {recursive: true, force: true}); });
  const env = {...testEnv(), MIOON_BASE_URL: server.url, MIOON_TOKEN: TOKEN};
  const created = await cli(env, 'rpc', 'project.create', '--input', JSON.stringify({name: 'CLI format 5'}));
  const projectId = String(created.id);
  assert.ok(projectId);
  const rootPlan = await preview(env, ['sequence', 'board', 'edit'], {projectId, kind: 'board-root-create', name: 'Film', position: {x: 0, y: 0}});
  const rootReceipt = await commit(env, projectId, rootPlan);
  assert.equal(rootReceipt.status, 'applied');
  for (const name of ['Shot A', 'Shot B']) {
    const plan = await preview(env, ['sequence', 'board', 'edit'], {projectId, kind: 'board-shot-append', name});
    assert.equal((await commit(env, projectId, plan)).status, 'applied');
  }
  const board = await cli(env, 'sequence', 'board', 'get', '--input', JSON.stringify({projectId}));
  assert.equal(typeof board.timelineRevision, 'number');
  const cue = {text: 'CLI 字幕', startFrame: 0, durationFrames: 30};
  const subtitlePlan = await preview(env, ['sequence', 'timeline', 'edit'], {projectId, kind: 'subtitles', edits: [{kind: 'add', cue}]});
  assert.equal(subtitlePlan.envelope.origin, 'user');
  const subtitleReceipt = await commit(env, projectId, subtitlePlan);
  assert.equal(subtitleReceipt.status, 'applied');
  const session = new Format5EditSession(async (operation, input) => {
    const response = await fetch(server.url + projectRpcPath(projectId), {method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${TOKEN}`},
      body: JSON.stringify({operation, input})});
    return data(await response.text());
  }, () => projectId);
  const history = await session.history();
  assert.ok(history?.undo);
  assert.equal(history.undo.actionId, subtitleReceipt.actionId);
  assert.equal(history.undoAvailable, true, 'the external action is at the top of user history');
  assert.equal(format5UserUndoBlocked(history), false);
  assert.equal((await session.undo(history)).ok, true);

  const afterUndo = await session.history();
  assert.ok(afterUndo?.redo);
  assert.equal(afterUndo.position, history.position - 1);
  assert.equal(afterUndo.redo.actionId, subtitleReceipt.actionId);
  const redoInput = JSON.stringify({projectId, origin: 'user', requestId: `cli-redo-${randomUUID()}`,
    actionId: afterUndo.redo.actionId, expected: {position: afterUndo.position, revision: afterUndo.revision}});
  const redone = await cli(env, 'sequence', 'redo', '--input', redoInput);
  assert.equal(redone.status, 'applied');
  const afterRedo = await session.history();
  assert.equal(afterRedo?.position, history.position);
  const replay = await cli(env, 'sequence', 'redo', '--input', redoInput);
  assert.equal(replay.actionId, redone.actionId);
  assert.deepEqual(await session.history(), afterRedo);

  const mcp = await connectMcp(t, env);
  const {tools} = await mcp.listTools();
  assert.ok(tools.some(tool => tool.name === 'sequence_undo'));
  assert.ok(!tools.some(tool => tool.name === 'sequence_undo_action'));
  const call = (name: string, input: Record<string, unknown>) => mcpAction(mcp, name, input);
  const mcpCue = {text: 'MCP 字幕', startFrame: 30, durationFrames: 30};
  const mcpPlan = await call('sequence_timeline_edit', {projectId, kind: 'subtitles', edits: [{kind: 'add', cue: mcpCue}]});
  assert.equal(mcpPlan.envelope.origin, 'user');
  const mcpReceipt = await call('sequence_action_commit', {projectId, envelope: mcpPlan.envelope, expectedPlanDigest: mcpPlan.planDigest});
  assert.equal(mcpReceipt.status, 'applied');
  const beforeMcpUndo = await session.history();
  assert.ok(beforeMcpUndo?.undo);
  assert.equal(beforeMcpUndo.undoAvailable, true);
  assert.equal(beforeMcpUndo.undo.actionId, mcpReceipt.actionId);
  assert.equal(format5UserUndoBlocked(beforeMcpUndo), false);
  const mcpUndo = await call('sequence_undo', {projectId, origin: 'user', requestId: `mcp-undo-${randomUUID()}`,
    actionId: beforeMcpUndo.undo.actionId, expected: {position: beforeMcpUndo.position, revision: beforeMcpUndo.revision}});
  assert.equal(mcpUndo.status, 'applied');
  assert.equal((await session.history())?.position, beforeMcpUndo.position - 1);
  const inspected = await cli(env, 'sequence', 'inspect', '--input', JSON.stringify({projectId}));
  assert.equal(typeof inspected.total, 'number');
});

test('actual CLI and MCP copy a main-track clip as a new shot through the same preview and commit', {timeout: 60_000}, async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-cli-copy-shot-'));
  const server = await startServer({dataDir: root, port: 0, token: TOKEN,
    localDraftChannel: 'development', projectFormatForTest: FORMAT5_PROJECT_SCHEMA_VERSION});
  t.after(async () => { await server.close(); rmSync(root, {recursive: true, force: true}); });
  const env = {...testEnv(), MIOON_BASE_URL: server.url, MIOON_TOKEN: TOKEN};
  const {id: projectId} = await cli(env, 'rpc', 'project.create', '--input', JSON.stringify({name: 'Copy shot fixture'}));
  const rpc = async (operation: string, fields: Row = {}): Promise<Row> => {
    const response = await fetch(server.url + projectRpcPath(projectId), {method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${TOKEN}`},
      body: JSON.stringify({operation, input: {projectId, ...fields}})});
    return data(await response.text());
  };
  for (const action of [
    {kind: 'board-root-create', name: 'Film', position: {x: 0, y: 0}},
    {kind: 'board-shot-append', name: 'Shot A'},
    {kind: 'board-shot-append', name: 'Shot B'},
  ]) {
    const plan = await rpc('sequence.board.edit', action);
    await rpc('sequence.action.commit', {envelope: plan.envelope, expectedPlanDigest: plan.planDigest});
  }
  const mcp = await connectMcp(t, env);
  const {tools} = await mcp.listTools();
  const schema = tools.find(tool => tool.name === 'sequence_clip_edit')?.inputSchema;
  assert.ok(schema && JSON.stringify(schema).includes('"copy-as-new-shot"'));
  const history = async () => sequenceHistoryViewResponseSchema.parse(await rpc('sequence.history.get'));
  const before = await rpc('project.get');
  const clips = before.timeline.clips as Row[];
  const [original, follower] = clips.filter(clip => clip.trackId === before.timeline.mainTrack.trackId)
    .sort((left, right) => left.startFrame - right.startFrame);
  assert.ok(original && follower);
  const input = {projectId, kind: 'copy-as-new-shot', clipId: original.id};
  const snapshots: Row[] = [];
  for (const surface of [
    {plan: () => preview(env, ['sequence', 'clip', 'edit'], input),
      apply: (plan: Row) => commit(env, projectId, plan)},
    {plan: () => mcpAction(mcp, 'sequence_clip_edit', input),
      apply: (plan: Row) => mcpAction(mcp, 'sequence_action_commit',
        {projectId, envelope: plan.envelope, expectedPlanDigest: plan.planDigest})},
  ]) {
    const prior = await rpc('project.get');
    const cursor = await history();
    const plan = await surface.plan();
    assert.equal(plan.envelope.origin, 'user');
    const edit = plan.envelope.intents[0].operation.edit;
    assert.equal(edit.kind, input.kind);
    assert.equal(edit.clipId, original.id);
    assert.deepEqual(await rpc('project.get'), prior);
    assert.deepEqual(await history(), cursor);
    const receipt = await surface.apply(plan);
    assert.equal(receipt.status, 'applied');
    assert.equal(receipt.operation, 'timeline.clip.copy-as-new-shot');
    assert.deepEqual(await surface.apply(plan), receipt);
    const after = await rpc('project.get');
    const copiedShot = (after.shots as Row[]).find(shot => shot.id === edit.copyNodeId);
    const copiedClip = (after.timeline.clips as Row[]).find(clip => clip.id === edit.newClipId);
    const shifted = (after.timeline.clips as Row[]).find(clip => clip.id === follower.id);
    assert.ok(copiedShot && copiedClip && shifted);
    assert.equal(copiedClip.sequenceSource.nodeId, copiedShot.id);
    assert.equal(copiedClip.startFrame, original.startFrame + original.durationFrames);
    assert.equal(shifted.startFrame, follower.startFrame + original.durationFrames);
    assert.equal(copiedShot.title, 'Shot A 副本');
    snapshots.push({title: copiedShot.title, position: copiedShot.position, startFrame: copiedClip.startFrame,
      durationFrames: copiedClip.durationFrames, sourceInFrame: copiedClip.sourceInFrame, sourceState: copiedClip.sourceState});
    const latest = await history();
    assert.equal(latest.position, cursor.position + 1);
    assert.equal(latest.undo?.actionId, receipt.actionId);
    const undone = await rpc('sequence.undo', {requestId: randomUUID(), actionId: receipt.actionId,
      expected: {position: latest.position, revision: latest.revision}});
    assert.equal(undone.status, 'applied');
    const restored = await rpc('project.get');
    assert.deepEqual(restored.timeline.clips, before.timeline.clips);
    assert.deepEqual(restored.shots, before.shots);
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
});

test('actual CLI and MCP replace format-5 main-track and overlay media while preserving clip edits', {timeout: 90_000}, async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-cli-replace-source-'));
  const server = await startServer({dataDir: path.join(root, 'app'), port: 0, token: TOKEN,
    localDraftChannel: 'development', projectFormatForTest: FORMAT5_PROJECT_SCHEMA_VERSION});
  t.after(async () => { await server.close(); rmSync(root, {recursive: true, force: true}); });
  const mediaEnv = testEnv(), env = {...mediaEnv, MIOON_BASE_URL: server.url, MIOON_TOKEN: TOKEN};
  const created = await cli(env, 'rpc', 'project.create', '--input', JSON.stringify({name: 'Synthetic clip replacement'}));
  const projectId = String(created.id);
  const read = async (operation: string): Promise<Row> => {
    const response = await fetch(server.url + projectRpcPath(projectId), {method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${TOKEN}`},
      body: JSON.stringify({operation, input: {projectId}})});
    return data(await response.text());
  };
  const history = async () => sequenceHistoryViewResponseSchema.parse(await read('sequence.history.get'));
  const snapshot = async () => {
    const {timeline, nodes} = await read('project.get');
    return {timeline, nodes, history: await history()};
  };
  const actions = (group: string, action: Row) => preview(env, ['sequence', group, 'edit'], {projectId, ...action});
  const apply = async (group: string, action: Row) => {
    const receipt = await commit(env, projectId, await actions(group, action));
    assert.equal(receipt.status, 'applied');
    return receipt;
  };
  async function importVideo(name: string, colour: string, frames: number): Promise<string> {
    const file = path.join(root, name);
    await run(mediaEnv.MIOON_FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', `color=c=${colour}:size=64x64:rate=30`, '-frames:v', String(frames),
      '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', file], {env: mediaEnv, timeout: 15_000});
    const asset = await cli(env, 'asset', 'import', '--input', JSON.stringify({projectId, name, mimeType: 'video/mp4',
      dataBase64: readFileSync(file).toString('base64')}));
    assert.equal(asset.duration, frames / 30);
    return String(asset.id);
  }
  const original = await importVideo('original.mp4', 'red', 90);
  const replacement = await importVideo('replacement.mp4', 'blue', 120);
  const shorter = await importVideo('shorter.mp4', 'green', 30);
  await apply('board', {kind: 'board-root-create', name: 'Film', position: {x: 0, y: 0}});
  await apply('timeline', {kind: 'insert-asset', assetId: original, trackId: null, startFrame: 0});
  await apply('timeline', {kind: 'track-add', trackKind: 'video', name: 'Overlay'});
  const overlayTrack = (await read('project.get')).timeline.tracks.find((track: Row) => track.name === 'Overlay');
  assert.ok(overlayTrack);
  await apply('timeline', {kind: 'insert-asset', assetId: shorter, trackId: overlayTrack.id, startFrame: 15});
  const inserted = (await read('project.get')).timeline;
  const mainClip = inserted.clips.find((clip: Row) => clip.trackId === inserted.mainTrack.trackId);
  const overlayClip = inserted.clips.find((clip: Row) => clip.trackId === overlayTrack.id);
  assert.ok(mainClip?.sequenceSource?.nodeId);
  assert.ok(overlayClip?.anchor);
  assert.equal(mainClip.durationFrames, 90);
  assert.equal(overlayClip.durationFrames, 30);
  assert.deepEqual(overlayClip.anchor, {clipId: mainClip.id, offsetFrames: 15});
  await apply('clip', {kind: 'clip-properties', edits: [
    {clipId: mainClip.id, patch: {name: 'Fixed main edit', gain: 0.75}},
    {clipId: overlayClip.id, patch: {name: 'Fixed overlay edit', gain: 0.5}},
  ]});

  const before = await snapshot();
  await assert.rejects(cliProcess(env, 'timeline', 'clip', 'replaceSource', '--input', JSON.stringify({
    projectId, requestId: `legacy-${randomUUID()}`, expectedRevision: before.timeline.revision,
    clipId: mainClip.id, assetId: replacement,
  })), error => {
    assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string');
    const result = JSON.parse(error.stdout) as {ok: boolean; error: {code: string; details: {command: string}}};
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'UNSUPPORTED_OPERATION');
    assert.match(result.error.details.command, /sequence clip edit.*replace-source/u);
    return true;
  });
  await assert.rejects(actions('clip', {kind: 'replace-source', clipId: mainClip.id, assetId: shorter}), error => {
    assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string');
    const result = JSON.parse(error.stdout) as {ok: boolean; error: {code: string}};
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SEQUENCE_EDIT_CLIP_PROPERTIES_INVALID');
    return true;
  });
  assert.deepEqual(await snapshot(), before);

  const mcp = await connectMcp(t, env);
  for (const {clipId, previewSource, commitSource} of [
    {clipId: mainClip.id, previewSource: (input: Row) => actions('clip', input),
      commitSource: (plan: Row) => commit(env, projectId, plan)},
    {clipId: overlayClip.id, previewSource: (input: Row) => mcpAction(mcp, 'sequence_clip_edit', {projectId, ...input}),
      commitSource: (plan: Row) => mcpAction(mcp, 'sequence_action_commit',
        {projectId, envelope: plan.envelope, expectedPlanDigest: plan.planDigest})},
  ]) {
    const current = await snapshot();
    const plan = await previewSource({kind: 'replace-source', clipId, assetId: replacement});
    assert.equal(plan.envelope.origin, 'user');
    assert.deepEqual(await snapshot(), current, 'preview leaves the clip, board and cursor intact');
    const receipt = await commitSource(plan);
    assert.equal(receipt.status, 'applied');
    const after = await snapshot();
    assert.deepEqual(after.timeline.clips, (current.timeline.clips as Row[]).map(clip =>
      clip.id === clipId ? {...clip, assetId: replacement} : clip));
    assert.equal(after.history.position, current.history.position + 1);
    assert.equal(after.history.undoAvailable, true);
    assert.equal(after.history.undo?.actionId, receipt.actionId);
    const beforeNode = (current.nodes as Row[]).find(node => node.id === mainClip.sequenceSource.nodeId);
    const afterNode = (after.nodes as Row[]).find(node => node.id === mainClip.sequenceSource.nodeId);
    assert.ok(beforeNode && afterNode);
    assert.equal(afterNode.assetId, clipId === mainClip.id ? replacement : original);
    assert.equal(afterNode.label, beforeNode.label);
    assert.deepEqual(await commitSource(plan), receipt);
    assert.deepEqual(await snapshot(), after, 'replay leaves the new cursor and source intact');
    const undone = await cli(env, 'sequence', 'undo', '--input', JSON.stringify({projectId,
      requestId: `undo-source-${randomUUID()}`, actionId: receipt.actionId,
      expected: {position: after.history.position, revision: after.history.revision}}));
    assert.equal(undone.status, 'applied');
    const restored = await snapshot();
    assert.deepEqual(restored.timeline.clips, current.timeline.clips);
    assert.deepEqual(restored.nodes, current.nodes);
    assert.equal(restored.history.position, current.history.position);
  }
});

test('replace-source pins a main-track shot to a matching version of that shot', async t => {
  const f = await createBoardUiWireFixture();
  t.after(async () => {
    await f.services.drain();
    await f.settings.close();
    f.store.close();
    f.library.close();
    rmSync(f.root, {recursive: true, force: true});
  });
  const {projectId} = f;
  const read = () => f.services.call('project.get', {projectId}) as Promise<Row>;
  const plan = (assetId: string, versionId: string) => f.services.call('sequence.clip.edit',
    {projectId, kind: 'replace-source', clipId: BOARD_IDS.clipA, assetId, versionId}) as Promise<Row>;
  const before = await read();
  await assert.rejects(plan(BOARD_IDS.assetV2, BOARD_IDS.versionA), {code: 'INVALID_MEDIA'});
  await assert.rejects(plan(BOARD_IDS.assetB, BOARD_IDS.versionB), {
    code: 'INVALID_MEDIA', message: '这个版本不属于该镜头，也没有被采纳。',
    details: {ids: [BOARD_IDS.shotA], reason: 'VERSION_NOT_OWNED_OR_ADOPTED'},
  });
  await assert.rejects(f.services.call('sequence.timeline.edit', {projectId, kind: 'format-set', presetId: 'portrait_720'}),
    {code: 'SEQUENCE_EDIT_NOOP', message: '时间线已使用此输出规格。'});
  const versionAsset = f.store.get('assets', BOARD_IDS.assetV2);
  assert.ok(versionAsset);
  f.store.put('assets', {...versionAsset, duration: 1});
  try {
    await assert.rejects(plan(BOARD_IDS.assetV2, BOARD_IDS.versionA2), {code: 'SEQUENCE_EDIT_CLIP_PROPERTIES_INVALID'});
    const followup = await f.services.call('sequence.action.edit', {projectId, kind: 'set-mode',
      clipId: BOARD_IDS.clipA, mode: 'locked', versionId: BOARD_IDS.versionA2}) as Row;
    assert.equal(followup.summary.warnings, 1);
  } finally {
    f.store.put('assets', versionAsset);
  }
  const preview = await plan(BOARD_IDS.assetV2, BOARD_IDS.versionA2);
  assert.equal(preview.envelope.origin, 'user');
  assert.deepEqual((await read()).timeline, before.timeline);
  const receipt = await f.services.call('sequence.action.commit', {projectId, envelope: preview.envelope,
    expectedPlanDigest: preview.planDigest}) as Row;
  assert.equal(receipt.status, 'applied');
  const after = await read();
  const originalClip = (before.timeline.clips as Row[]).find(clip => clip.id === BOARD_IDS.clipA);
  const replacedClip = (after.timeline.clips as Row[]).find(clip => clip.id === BOARD_IDS.clipA);
  assert.ok(originalClip && replacedClip);
  assert.deepEqual(replacedClip, {...originalClip, assetId: BOARD_IDS.assetV2, versionId: BOARD_IDS.versionA2,
    jobId: BOARD_IDS.jobV2, sequenceSource: {...originalClip.sequenceSource, versionMode: 'locked'}});
  assert.deepEqual(after.shots, before.shots, 'a clip-only version replacement keeps the board selection');
});
