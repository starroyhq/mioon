import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer, type InspectProject} from './helpers/test-server.ts';
import {testEnv} from './helpers/test-env.ts';
import {exportOutputSchema} from '../packages/contracts/src/export-controls.ts';
import {sequenceHistoryViewResponseSchema} from '../packages/contracts/src/sequence-editing.ts';
import {TIMELINE_LIMITS} from '@mioon/contracts/timeline-limits';
import {createClient} from '@mioon/client';
import {putFormat5TimelineInside, readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';

const exec = promisify(execFile);
const TOKEN = 'synthetic-cli-format5-e2e-token';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
type Row = Record<string, any>;
async function cli(env: NodeJS.ProcessEnv, ...args: string[]): Promise<Row> {
  const result = await exec(process.execPath, ['apps/cli/src/index.ts', ...args], {
    cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  const body = JSON.parse(result.stdout) as {ok?: boolean; data?: Row; error?: unknown};
  assert.equal(body.ok, true, JSON.stringify(body.error ?? body).slice(0, 500));
  return body.data as Row;
}
async function plan(env: NodeJS.ProcessEnv, words: string[], action: Row): Promise<Row> {
  return cli(env, ...words, '--input', JSON.stringify(action));
}
async function commit(env: NodeJS.ProcessEnv, projectId: string, preview: Row): Promise<Row> {
  return cli(env, 'sequence', 'action', 'commit', '--input', JSON.stringify({projectId,
    envelope: preview.envelope, expectedPlanDigest: preview.planDigest}));
}
test('real CLI format-5 flow: generate in editing, references, reorder, split, subtitles, undo and MP4 export', {
  timeout: 180_000,
}, async (t: TestContext) => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-cli-format5-e2e-'));
  const server = await startServer({dataDir: root, port: 0, token: TOKEN, projectFormatForTest: 5});
  t.after(async () => { await server.close(); rmSync(root, {recursive: true, force: true}); });
  const env = {...testEnv(), MIOON_BASE_URL: server.url, MIOON_TOKEN: TOKEN};
  const projectId = String((await cli(env, 'rpc', 'project.create', '--input', JSON.stringify({name: 'CLI E2E'}))).id);
  const request = async (operation: string, input: Row): Promise<Row> => {
    const response = await fetch(`${server.url}/api/projects/${projectId}/rpc`, {method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${TOKEN}`},
      body: JSON.stringify({operation, input})});
    const body = await response.json() as {ok?: boolean; data?: Row; error?: unknown};
    assert.equal(body.ok, true, JSON.stringify(body.error ?? body));
    return body.data as Row;
  };
  const read = () => request('project.get', {projectId});
  const asset = await cli(env, 'rpc', 'asset.import', '--input', JSON.stringify({projectId,
    name: 'reference.png', mimeType: 'image/png', dataBase64: PNG}));
  assert.ok(asset.id);
  const rootPlan = await plan(env, ['sequence', 'board', 'edit'], {projectId, kind: 'board-root-create', name: 'Film', position: {x: 0, y: 0}});
  await commit(env, projectId, rootPlan);
  const imagePlan = await plan(env, ['sequence', 'board', 'edit'], {projectId, kind: 'board-node-create',
    type: 'image', name: 'Reference', position: {x: 300, y: 0}, assetId: asset.id});
  await commit(env, projectId, imagePlan);
  const generate = async () => {
    const action = {projectId, kind: 'generate', placement: {kind: 'main', beforeClipId: null}, title: 'Generated shot',
      providerId: 'mock', model: 'mock-motion-v1', region: 'local', prompt: 'a test pattern', aspectRatio: '9:16',
      duration: 2, parameters: {scenario: 'success'}};
    const before = new Set(((await read()).jobs as Row[]).map(item => item.id));
    const preview = await plan(env, ['sequence', 'timeline', 'edit'], action);
    const requestId = preview.envelope.generateIntent.operation.settings.requestId;
    assert.match(requestId, /^cli-/u);
    const receipt = await commit(env, projectId, preview);
    assert.equal(receipt.status, 'applied');
    assert.deepEqual(await commit(env, projectId, preview), receipt);
    for (let attempt = 0; attempt < 240; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const state = await read();
      const job = (state.jobs as Row[]).find(item => !before.has(item.id));
      if (job?.status === 'succeeded') {
        assert.equal(job.requestId, requestId);
        assert.equal((state.jobs as Row[]).filter(item => !before.has(item.id)).length, 1);
        return state;
      }
      if (job?.status === 'failed') assert.fail(JSON.stringify(job.error));
    }
    assert.fail('mock generation did not finish');
  };
  const first = await generate();
  const firstShot = first.shots.at(-1) as Row, firstClip = first.timeline.clips.find((item: Row) => item.sourceState === 'ready') as Row;
  assert.ok(firstShot.id); assert.ok(firstClip.id);
  const imageNode = first.nodes.find((item: Row) => item.type === 'image' && item.assetId === asset.id) as Row;
  const reference = await commit(env, projectId, await plan(env, ['sequence', 'reference', 'edit'],
    {projectId, kind: 'reference-attach', sourceNodeId: imageNode.id, shotId: firstShot.id}));
  assert.equal(reference.status, 'applied');
  const second = await generate();
  const clips = second.timeline.clips.filter((item: Row) => item.sourceState === 'ready') as Row[];
  assert.equal(clips.length >= 2, true);
  const otherClip = clips.find(clip => clip.id !== firstClip.id);
  assert.ok(otherClip?.versionId && otherClip.assetId && otherClip.assetId !== firstClip.assetId);
  const replace = {projectId, kind: 'replace-source', clipId: firstClip.id,
    assetId: otherClip.assetId, versionId: otherClip.versionId};
  const historyBeforeRejects = await request('sequence.history.get', {projectId, origin: 'user'});
  const ownershipError = {code: 'INVALID_MEDIA', message: '这个版本不属于该镜头，也没有被采纳。',
    reason: 'VERSION_NOT_OWNED_OR_ADOPTED'};
  const assertCliRejection = async (words: string[], input: Row, expected: {code: string; message: string; reason?: string}) => {
    await assert.rejects(plan(env, words, input), (error: unknown) => {
      assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && 'code' in error);
      assert.equal(error.code, 3);
      const {ok, error: rejection} = JSON.parse(error.stdout);
      assert.equal(ok, false);
      assert.equal(rejection.code, expected.code);
      assert.equal(rejection.message, expected.message);
      assert.equal(rejection.details?.reason, expected.reason);
      return true;
    });
  };
  await assertCliRejection(['sequence', 'clip', 'edit'], replace, ownershipError);
  const mcp = new Client({name: 'format5-replace-source-test', version: '1.0.0'});
  t.after(() => mcp.close());
  await mcp.connect(new StdioClientTransport({command: process.execPath, args: ['apps/mcp/src/index.ts'],
    cwd: path.resolve(import.meta.dirname, '..'), env, stderr: 'ignore'}));
  const mcpResult = await mcp.callTool({name: 'sequence_clip_edit', arguments: replace}, undefined, {timeout: 15_000});
  assert.equal(mcpResult.isError, true);
  const mcpBody = mcpResult.structuredContent as {ok: boolean; error: {code: string; message: string; details: {reason: string}}};
  assert.equal(mcpBody.ok, false);
  assert.deepEqual({code: mcpBody.error.code, message: mcpBody.error.message, reason: mcpBody.error.details.reason}, ownershipError);
  await assertCliRejection(['sequence', 'action', 'edit'], {projectId, kind: 'split', clipId: firstClip.id,
    offsetFrames: firstClip.durationFrames}, {code: 'INVALID_SPLIT', message: '格式 5 序列动作无法预览，请重新读取后再试。'});
  assert.deepEqual((await read()).timeline, second.timeline);
  assert.deepEqual(await request('sequence.history.get', {projectId, origin: 'user'}), historyBeforeRejects);
  const reorder = await commit(env, projectId, await plan(env, ['sequence', 'action', 'edit'],
    {projectId, kind: 'reorder', clipId: clips[1]!.id, beforeClipId: clips[0]!.id}));
  assert.equal(reorder.status, 'applied');
  const splitTarget = (await read()).timeline.clips.find((item: Row) => item.sourceState === 'ready') as Row;
  const split = await commit(env, projectId, await plan(env, ['sequence', 'action', 'edit'],
    {projectId, kind: 'split', clipId: splitTarget.id, offsetFrames: 15}));
  assert.equal(split.status, 'applied');
  const subtitle = await commit(env, projectId, await plan(env, ['sequence', 'timeline', 'edit'],
    {projectId, kind: 'subtitles', edits: [{kind: 'add', cue: {text: 'CLI 字幕', startFrame: 0, durationFrames: 30}}]}));
  assert.equal(subtitle.status, 'applied');
  const history = sequenceHistoryViewResponseSchema.parse(
    await cli(env, 'sequence', 'history', 'get', '--input', JSON.stringify({projectId, origin: 'user'})));
  assert.equal(history.undo?.actionId, subtitle.actionId);
  const undone = await cli(env, 'sequence', 'undo', '--input', JSON.stringify({projectId, origin: 'user',
    requestId: `cli-e2e-undo-${randomUUID()}`, actionId: subtitle.actionId,
    expected: {position: history.position, revision: history.revision}}));
  assert.equal(undone.status, 'applied');
  const state = await read();
  assert.equal(state.timeline.subtitles?.cues?.length ?? 0, 0);
  const exportRecord = await cli(env, 'timeline', 'render', '--input', JSON.stringify({projectId,
    expectedRevision: state.timeline.revision, requestId: `cli-e2e-export-${randomUUID()}`, purpose: 'export'}));
  let exported: Row | undefined;
  for (let attempt = 0; attempt < 240; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const current = await read();
    exported = current.exports.find((item: Row) => item.id === exportRecord.id);
    if (exported?.status === 'succeeded') break;
    if (exported && ['failed', 'cancelled'].includes(exported.status)) assert.fail(JSON.stringify(exported.error));
  }
  assert.equal(exported?.status, 'succeeded');
  assert.ok(exported?.assetId);
  const outputResult = await mcp.callTool({name: 'export_output_get', arguments: {projectId, exportId: exported.id}},
    undefined, {timeout: 15_000});
  assert.equal(outputResult.isError, false);
  const outputBody = outputResult.structuredContent as {ok?: unknown; data?: unknown} | undefined;
  assert.equal(outputBody?.ok, true);
  const proof = exportOutputSchema.parse(outputBody?.data);
  assert.equal(proof.assetId, exported.assetId);
  assert.equal(proof.publication?.projectRelativePath, '导出/CLI E2E.mp4');
  const output = path.join(root, 'cli-format5-export.mp4');
  await cli(env, 'export', 'download', '--input', JSON.stringify({projectId, exportId: exported.id}), '--output', output);
  const bytes = readFileSync(output);
  assert.equal(bytes.subarray(4, 8).toString('latin1'), 'ftyp');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), proof.sha256);
});

test('CLI and MCP acknowledge and read a native 30-minute export on the same project route', {
  timeout: 90_000,
}, async t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-cli-format5-limits-'));
  let inspect!: InspectProject;
  const server = await startServer({dataDir: directory, port: 0, token: TOKEN, projectFormatForTest: 5,
    inspectProject: reader => {inspect = reader;}});
  t.after(async () => {await server.close(); rmSync(directory, {recursive: true, force: true});});
  const env = {...testEnv(), MIOON_BASE_URL: server.url, MIOON_TOKEN: TOKEN};
  const {id: projectId} = await cli(env, 'project', 'create', '--input', JSON.stringify({name: 'Timeline limits'}));
  await commit(env, projectId, await plan(env, ['sequence', 'board', 'edit'],
    {projectId, kind: 'board-root-create', name: 'Film', position: {x: 0, y: 0}}));
  const {id: assetId} = await cli(env, 'asset', 'import', '--input', JSON.stringify({projectId,
    name: 'source.png', mimeType: 'image/png', dataBase64: PNG}));
  const {maxClips, maxFrames} = TIMELINE_LIMITS;
  const revision = inspect(projectId, db => {
    const timeline = readFormat5TimelineRecord(db, 'project');
    assert.ok(timeline);
    const trackId = randomUUID();
    const durationFrames = maxFrames / maxClips;
    const clips = Array.from({length: maxClips}, (_, index) => ({
      id: randomUUID(), assetId, trackId, name: `Frame source ${index}`, sourceState: 'ready', anchor: null,
      startFrame: durationFrames * index, durationFrames, sourceInFrame: 0, gain: 1,
      rect: {x: 0, y: 0, width: timeline.width, height: timeline.height},
    }));
    const tracks = [...timeline.tracks, {id: trackId, kind: 'video', name: 'V2', orderIndex: timeline.tracks.length,
      hidden: false, muted: false}];
    db.exec('BEGIN IMMEDIATE');
    try {
      putFormat5TimelineInside(db, 'project', {...timeline, clips, tracks, durationFrames: maxFrames,
        revision: timeline.revision + 1}, projectId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return timeline.revision + 1;
  });
  const render = {projectId, expectedRevision: revision, requestId: randomUUID(), purpose: 'export',
    exportRange: {startFrame: maxFrames - 1, endFrame: maxFrames},
    exportSettings: {profileId: 'mp4_h264_float_checked_v2', resolution: 'short_360',
      rateControl: {mode: 'crf', quality: 'standard'}}};
  const queued = await cli(env, 'timeline', 'render', '--input', JSON.stringify(render));
  assert.equal(queued.snapshot.timeline.clips.length, maxClips);
  assert.equal(queued.snapshot.timeline.durationFrames, maxFrames);
  assert.equal(queued.status, 'queued');
  const read = {projectId, exportId: queued.id};
  const saved = await cli(env, 'export', 'get', '--input', JSON.stringify(read));
  assert.equal(saved.id, queued.id);
  assert.deepEqual(saved.snapshot, queued.snapshot);

  const mcp = new Client({name: 'format5-limits-test', version: '1.0.0'});
  t.after(() => mcp.close());
  await mcp.connect(new StdioClientTransport({command: process.execPath, args: ['apps/mcp/src/index.ts'],
    cwd: path.resolve(import.meta.dirname, '..'), env, stderr: 'ignore'}));
  const call = async (name: string, input: Record<string, unknown>): Promise<Row> => {
    const result = await mcp.callTool({name, arguments: input}, undefined, {timeout: 15_000});
    const reply = result.structuredContent as {ok?: boolean; data?: Row; error?: unknown};
    assert.equal(Boolean(result.isError), false, JSON.stringify(reply.error));
    assert.equal(reply.ok, true);
    assert.ok(reply.data);
    return reply.data;
  };
  assert.deepEqual(await call('timeline_render', render), queued, 'MCP replays the exact CLI receipt');
  const later = await call('export_get', read);
  assert.equal(later.id, queued.id);
  assert.deepEqual(later.snapshot, queued.snapshot);
  const finished = await cli(env, 'export', 'watch', '--input', JSON.stringify(read), '--timeout-ms', '30000');
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.audioCheck.outputFrames, 1);
  assert.equal((await call('export_get', read)).audioCheck.outputFrames, 1);
  assert.equal(inspect(projectId, db => db.prepare('SELECT count(*) AS total FROM exports').get()?.total), 1);

  let calls = 0;
  const currentProject = createClient({env, fetchImpl: async (...args) => {
    calls++;
    const response = await fetch(...args);
    assert.equal(response.headers.get('X-Mioon-Project-Format'), '5');
    const headers = new Headers(response.headers);
    headers.delete('X-Mioon-Project-Format');
    return new Response(response.body, {status: response.status, headers});
  }});
  await assert.rejects(currentProject.rpc('timeline.render', render),
    {code: 'BACKEND_PROTOCOL_ERROR', details: {operation: 'timeline.render', requestId: render.requestId,
      submissionMayHaveSucceeded: true, recovery: 'Replay the exact original input with the same requestId; do not invent a replacement ID.'}});
  assert.equal(calls, 1, 'unlabelled render responses keep the strict contract without a second request');
  await assert.rejects(currentProject.rpc('export.get', {exportId: queued.id}, {projectId}), {code: 'BACKEND_PROTOCOL_ERROR'});
  assert.equal(calls, 2, 'unlabelled export reads also keep the strict contract');

  const wrongOwner = createClient({env, fetchImpl: async () => new Response(JSON.stringify({ok: true, data: finished}),
    {headers: {'X-Mioon-Project-Format': '5'}})});
  await assert.rejects(wrongOwner.rpc('export.get', {exportId: queued.id}, {projectId: randomUUID()}),
    {code: 'BACKEND_PROTOCOL_ERROR'});
});
