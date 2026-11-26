import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startServer} from './helpers/test-server.ts';
import {testEnv} from './helpers/test-env.ts';
import {sequenceHistoryViewResponseSchema} from '../packages/contracts/src/sequence-editing.ts';

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
  const output = path.join(root, 'cli-format5-export.mp4');
  await cli(env, 'export', 'download', '--input', JSON.stringify({projectId, exportId: exported.id}), '--output', output);
  const bytes = readFileSync(output);
  assert.equal(bytes.subarray(4, 8).toString('latin1'), 'ftyp');
  assert.ok(exported.assetId);
});
