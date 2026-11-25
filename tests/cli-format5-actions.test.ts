import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from './helpers/test-server.ts';
import {testEnv} from './helpers/test-env.ts';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {Format5EditSession, format5UserUndoBlocked} from '../apps/web/src/edit-ui/session.ts';

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

  const mcp = new Client({name: 'format5-history-test', version: '1.0.0'});
  t.after(() => mcp.close());
  const cwd = path.resolve(import.meta.dirname, '..');
  await mcp.connect(new StdioClientTransport({command: process.execPath, args: ['apps/mcp/src/index.ts'], cwd, env, stderr: 'ignore'}));
  const {tools} = await mcp.listTools();
  assert.ok(tools.some(tool => tool.name === 'sequence_undo'));
  assert.ok(!tools.some(tool => tool.name === 'sequence_undo_action'));
  const call = async (name: string, input: Record<string, unknown>): Promise<Row> => {
    const result = await mcp.callTool({name, arguments: input}, undefined, {timeout: 15_000});
    return data(JSON.stringify(result.structuredContent));
  };
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
