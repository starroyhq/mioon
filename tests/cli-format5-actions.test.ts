import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startServer} from './helpers/test-server.ts';
import {testEnv} from './helpers/test-env.ts';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';

const run = promisify(execFile);
const TOKEN = 'synthetic-cli-format5-actions-token';
type Row = Record<string, any>;
const data = (result: string): Row => {
  const body = JSON.parse(result) as {ok?: boolean; data?: Row};
  assert.equal(body.ok, true, result.slice(0, 300));
  return body.data as Row;
};
async function cli(env: NodeJS.ProcessEnv, ...words: string[]): Promise<Row> {
  const result = await run(process.execPath, ['apps/cli/src/index.ts', ...words], {
    cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  return data(result.stdout);
}
async function preview(cliEnv: NodeJS.ProcessEnv, operation: string[], action: Row): Promise<Row> {
  return cli(cliEnv, ...operation, '--input', JSON.stringify(action));
}
async function commit(cliEnv: NodeJS.ProcessEnv, projectId: string, plan: Row): Promise<Row> {
  return cli(cliEnv, 'sequence', 'action', 'commit', '--input', JSON.stringify({projectId,
    envelope: plan.envelope, expectedPlanDigest: plan.planDigest}));
}
test('actual CLI and MCP catalog use the shared format-5 preview -> plan -> commit -> history flow', async (t: TestContext) => {
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
  const subtitleReceipt = await commit(env, projectId, subtitlePlan);
  assert.equal(subtitleReceipt.status, 'applied');
  const history = await cli(env, 'sequence', 'history', 'get', '--input', JSON.stringify({projectId}));
  assert.equal(typeof history.position, 'number');
  const undone = await cli(env, 'sequence', 'undo-action', '--input', JSON.stringify({projectId,
    requestId: `cli-undo-${randomUUID()}`, actionId: subtitleReceipt.actionId}));
  assert.equal(undone.status, 'applied');
  const inspected = await cli(env, 'sequence', 'inspect', '--input', JSON.stringify({projectId}));
  assert.equal(typeof inspected.total, 'number');
});
