import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {run} from '../packages/business/src/media-runtime.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createClient} from '../packages/client/src/index.ts';
import {exportPreflightResponseSchema} from '../packages/contracts/src/export-preflight.ts';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';
import type {SequenceEditEnvelope} from '../packages/contracts/src/sequence-edit.ts';
import {TIMELINE_EXPORT_DEFAULT_SETTINGS} from '../packages/contracts/src/timeline-export-profile.ts';
import {startServer, type InspectProject} from './helpers/test-server.ts';

const execute = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..');
type RenderEnvelope = {ok: true; data: unknown} | {ok: false; error: {code: string; details: unknown}};

const cases = [
  {route: 'direct sequence insertion', prepared: false, endFrame: 30, issue: null},
  {route: 'library placement with source preparation', prepared: true, endFrame: 30, issue: null},
  {route: 'direct sequence insertion with an invalid export range', prepared: false, endFrame: 61, issue: 'EXPORT_RANGE_BOUNDS'},
] as const;

for (const {route, prepared, endFrame, issue} of cases) {
  test(`first and repeated preflight agree after ${route}`, async t => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-preflight-cold-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    t.after(async () => {
      try {await server?.close();}
      finally {await rm(root, {recursive: true, force: true});}
    });
    const file = path.join(root, 'source.mp4');
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=30:d=2',
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads:v', '1', '-pix_fmt', 'yuv420p', file],
    {timeout: 30_000, maxStdoutBytes: 0, maxStderrBytes: 65_536});
    const bytes = await readFile(file);
    let inspect!: InspectProject;
    server = await startServer({dataDir: path.join(root, 'app'), port: 0, comfyModule: 'skip',
      localDraftChannel: 'development', projectFormatForTest: FORMAT5_PROJECT_SCHEMA_VERSION,
      inspectProject: read => {inspect = read;}});
    const {rpc} = createClient({env: {MIOON_BASE_URL: server.url, MIOON_TOKEN: server.token}});
    const {id: projectId} = await rpc<{id: string}>('project.create', {name: 'Cold preflight'});
    const {id: assetId} = await rpc<{id: string}>('asset.import', {projectId, name: 'Source.mp4',
      mimeType: 'video/mp4', dataBase64: bytes.toString('base64')});
    const reference = () => inspect(projectId, db => db.prepare(`SELECT
      json_extract(data, '$.sha256') AS sha256, json_extract(data, '$.referenceRevision') AS revision,
      contentSequence, contentToken FROM project.assets CROSS JOIN project.project_file WHERE id=?`).get(assetId));
    const imported = reference();
    assert.ok(imported);
    assert.equal(imported.sha256, null, 'ordinary MP4 import leaves a sampled reference');
    if (prepared) {
      await rpc('asset.media.prepare', {projectId, purpose: 'timeline',
        assets: [{assetId, referenceRevision: imported.revision}]});
    }
    async function apply(operation: string, intent: Record<string, unknown>) {
      const plan = await rpc<{envelope: SequenceEditEnvelope; planDigest: string}>(operation, {projectId, ...intent});
      const receipt = await rpc<{status: string}>('sequence.action.commit', {
        projectId, envelope: plan.envelope, expectedPlanDigest: plan.planDigest,
      });
      assert.equal(receipt.status, 'applied');
    }
    await apply('sequence.board.edit', {kind: 'board-root-create', name: 'Synthetic sequence', position: {x: 0, y: 0}});
    await apply('sequence.timeline.edit', {kind: 'insert-asset', assetId, trackId: null, startFrame: 0});
    const {projectFormatVersion, timeline} = await rpc<{projectFormatVersion: number;
      timeline: {id: string; revision: number; clips: {assetId: string}[]}}>('project.get', {projectId});
    assert.equal(projectFormatVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
    assert.deepEqual(timeline.clips.map(clip => clip.assetId), [assetId]);
    const before = reference();
    assert.ok(before);
    if (prepared) assert.match(String(before.sha256), /^[a-f0-9]{64}$/u);
    else assert.equal(before.sha256, null);
    const input = {projectId, expectedRevision: timeline.revision, exportSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS,
      exportRange: {startFrame: 2, endFrame}};
    const preflight = async () => exportPreflightResponseSchema.parse(await rpc('timeline.export.preflight', input));
    const first = await preflight();
    const afterFirst = reference();
    const repeated = await preflight();
    assert.equal(first.status, issue ? 'blocked' : 'ready', JSON.stringify({before, afterFirst, first, repeated}));
    assert.equal(repeated.status, first.status);
    assert.deepEqual(first.issues.map(value => value.code), issue ? [issue] : [], JSON.stringify({before, afterFirst, first, repeated}));
    assert.deepEqual(repeated.issues, first.issues);
    assert.equal(first.timelineId, timeline.id);
    assert.equal(first.timelineRevision, timeline.revision);
    assert.equal(repeated.snapshotHash, first.snapshotHash);
    assert.deepEqual(repeated.summary, first.summary);
    if (issue) assert.equal(first.snapshotHash, null);
    else assert.match(String(first.snapshotHash), /^[a-f0-9]{64}$/u);
    assert.equal(first.checks.checkedAssets, issue ? 0 : 1);
    assert.equal(repeated.checks.checkedAssets, first.checks.checkedAssets);
    assert.ok(afterFirst);
    assert.equal(afterFirst.revision, before.revision);
    if (!issue) {
      assert.match(String(afterFirst.sha256), /^[a-f0-9]{64}$/u);
      if (prepared) assert.deepEqual(afterFirst, before);
      else {
        assert.equal(afterFirst.contentSequence, Number(before.contentSequence) + 1);
        assert.notEqual(afterFirst.contentToken, before.contentToken);
      }
    }
    assert.deepEqual(reference(), afterFirst);

    if (prepared) await t.test('format 5 render replay and revision rejection agree across HTTP, CLI, and MCP', {timeout: 45_000}, async () => {
      assert.ok(server);
      assert.ok(first.snapshotHash);
      const {url, token} = server;
      const env = {...mediaEnvironment(), MIOON_BASE_URL: url, MIOON_TOKEN: token};
      const request = {...input, purpose: 'export', requestId: randomUUID(), preflightSnapshotHash: first.snapshotHash};
      const callHttp = async (body: typeof request) => {
        const response = await fetch(url + projectRpcPath(projectId), {
          method: 'POST', redirect: 'error', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
          body: JSON.stringify({operation: 'timeline.render', input: body}), signal: AbortSignal.timeout(15_000),
        });
        return {status: response.status, envelope: await response.json() as RenderEnvelope};
      };
      const callCli = async (body: typeof request) => {
        const runCli = execute(process.execPath, ['apps/cli/src/index.ts', 'timeline', 'render', '--input', JSON.stringify(body)],
          {cwd: repo, env, timeout: 15_000});
        return runCli.then(({stdout}) => ({code: 0, envelope: JSON.parse(stdout) as unknown}), (error: unknown) => {
          if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number' ||
            !('stdout' in error) || typeof error.stdout !== 'string' || !error.stdout) throw error;
          return {code: error.code, envelope: JSON.parse(error.stdout) as unknown};
        });
      };
      const client = new Client({name: 'format5-render-preflight-test', version: '1.0.0'});
      const transport = new StdioClientTransport({command: process.execPath, args: ['apps/mcp/src/index.ts'], cwd: repo, env});
      const callMcp = async (body: typeof request) => {
        const result = await client.callTool({name: 'timeline_render', arguments: body}, undefined, {timeout: 15_000});
        assert.ok(Array.isArray(result.content));
        const block = result.content[0];
        assert.ok(block?.type === 'text');
        assert.deepEqual(JSON.parse(block.text), result.structuredContent);
        return {isError: Boolean(result.isError), envelope: result.structuredContent};
      };
      const exportRows = () => inspect(projectId, db => db.prepare('SELECT id FROM main.exports ORDER BY id').all());
      const receipt = (requestId: string) => inspect(projectId, db => db.prepare('SELECT response FROM main.timeline_requests WHERE requestId=?').get(requestId));
      try {
        await client.connect(transport);
        const accepted = await callHttp(request);
        assert.equal(accepted.status, 200);
        assert.equal(accepted.envelope.ok, true);
        const originalReceipt = receipt(request.requestId);
        assert.ok(originalReceipt);
        assert.deepEqual(await callCli(request), {code: 0, envelope: accepted.envelope});
        assert.deepEqual(await callMcp(request), {isError: false, envelope: accepted.envelope});
        assert.deepEqual(await callHttp(request), accepted);
        assert.deepEqual(receipt(request.requestId), originalReceipt);
        const exportsBeforeRejection = exportRows();
        assert.equal(exportsBeforeRejection.length, 1);
        const stale = {...request, requestId: randomUUID(), expectedRevision: request.expectedRevision + 1};
        const http = await callHttp(stale);
        const cli = await callCli(stale);
        const mcp = await callMcp(stale);
        assert.equal(http.status, 409);
        assert.ok(!http.envelope.ok);
        assert.equal(http.envelope.error.code, 'REVISION_CONFLICT');
        assert.deepEqual(http.envelope.error.details, {expectedRevision: stale.expectedRevision, currentRevision: request.expectedRevision});
        assert.equal(receipt(stale.requestId), undefined);
        assert.deepEqual(exportRows(), exportsBeforeRejection);
        assert.deepEqual({cli, mcp}, {
          cli: {code: 3, envelope: http.envelope},
          mcp: {isError: true, envelope: http.envelope},
        });
      } finally {
        await client.close();
      }
    });
  });
}
