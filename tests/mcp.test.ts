import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
interface TrafficRecord {at: string; direction: 'client-to-server' | 'server-to-client'; message: {method?: string; params?: {name?: string}; [key: string]: unknown}}
interface BackendRecord {command: string; args: string[]; port: number; dataDirectory: string; liveProviderEnabled: boolean; stdout?: string; stderr?: string}
interface Report {
  startedAt: string; runtime: string; invocation: {executable: string; arguments: string[]}; implementation: string; protocolCapture: string;
  backend: BackendRecord; calls: unknown[]; commands: unknown[]; finishedAt?: string; mcpStderr?: string; protocolMessages?: number;
  server?: {name?: string; version?: string}; toolNames?: string[]; strictInputRejection?: unknown; projectId?: string; result?: string;
  sharedStateVerifiedByHttp?: boolean; shotIds?: string[]; versionIds?: string[]; exportId?: string; persistedForBrowser?: boolean;
}
const exec = promisify(execFile), repo = fileURLToPath(new URL('..', import.meta.url));
const evidence = path.join(repo, 'evidence/mcp'), token = 'mcp-acceptance-token-minimum-twenty-characters';
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function freePort(): Promise<number> { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw Error('Expected a bound TCP address'); const port = address.port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }

test('A3 official MCP SDK stdio initialize/list/call controls durable HTTP project, jobs and versions', { timeout: 120_000 }, async (t: TestContext) => {
  await mkdir(evidence, { recursive: true });
  const persist = process.env.MIOON_MCP_PERSIST_DIR ? path.resolve(process.env.MIOON_MCP_PERSIST_DIR) : null;
  const root = persist || await mkdtemp(path.join(tmpdir(), 'mioon-mcp-'));
  await mkdir(root, { recursive: true }); const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const traffic: TrafficRecord[] = [], report: Report = { startedAt: new Date().toISOString(), runtime: process.version, invocation: { executable: process.execPath, arguments: ['--test', 'tests/mcp.test.ts'] }, implementation: 'Official @modelcontextprotocol/sdk Client and StdioClientTransport', protocolCapture: 'Transport.send and Transport.onmessage wrapper captures actual JSON-RPC handshake and tool calls', backend: { command: process.execPath, args: ['server/index.ts'], port, dataDirectory: root, liveProviderEnabled: false }, calls: [], commands: [] };
  let stdout = '', stderr = '', mcpStderr = '';
  let client: Client | undefined, transport: StdioClientTransport | undefined;
  const backend = spawn(process.execPath, ['server/index.ts'], { cwd: repo, env: { ...process.env, PORT: String(port), MIOON_DATA_DIR: root, MIOON_TOKEN: token, MIOON_ENABLE_LIVE_PROVIDER: '0', RUNWAYML_API_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stdout?.setEncoding('utf8').on('data', (bytes: string) => stdout += bytes); backend.stderr?.setEncoding('utf8').on('data', (bytes: string) => stderr += bytes);
  t.after(async () => {
    if (client) await client.close().catch(() => {}); else if (transport) await transport.close().catch(() => {});
    if (backend.exitCode === null && !backend.signalCode) { const done = once(backend, 'exit'); backend.kill('SIGTERM'); await done; }
    report.finishedAt = new Date().toISOString(); report.backend.stdout = stdout; report.backend.stderr = stderr; report.mcpStderr = mcpStderr; report.protocolMessages = traffic.length;
    await writeFile(path.join(evidence, 'protocol-traffic.jsonl'), traffic.map(record => JSON.stringify(record)).join('\n') + '\n');
    await writeFile(path.join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2));
    if (!persist) await rm(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 20_000;
  while (true) { if (backend.exitCode !== null) throw Error(`Backend exit ${backend.exitCode}: ${stderr}`); try { if ((await fetch(base + '/health')).ok) break; } catch {} if (Date.now() > deadline) throw Error(`Backend start timed out: ${stderr}`); await pause(40); }
  transport = new StdioClientTransport({ command: process.execPath, args: ['server/mcp.ts'], cwd: repo, env: { ...process.env, MIOON_BASE_URL: base, MIOON_TOKEN: token }, stderr: 'pipe' });
  (transport.stderr as unknown as {setEncoding(encoding: string): {on(event: string, listener: (chunk: string) => void): void}} | null)?.setEncoding('utf8').on('data', (bytes: string) => mcpStderr += bytes);
  // Preserve the official SDK transport as the wire implementation. This wrapper
  // records its real JSON-RPC messages, rather than calling the service directly.
  const wire: Transport = {
    onmessage: undefined, onerror: undefined, onclose: undefined,
    async start() {
      transport!.onmessage = (message: unknown) => { traffic.push({ at: new Date().toISOString(), direction: 'server-to-client', message: message as TrafficRecord['message'] }); wire.onmessage?.(message as never); };
      transport!.onerror = (error: unknown) => wire.onerror?.(error as never); transport!.onclose = () => wire.onclose?.();
      await transport!.start();
    },
    async send(message: never, options?: never) { traffic.push({ at: new Date().toISOString(), direction: 'client-to-server', message: message as unknown as TrafficRecord['message'] }); await (transport!.send as (message: never, options?: never) => Promise<void>)(message, options); },
    close() { return transport!.close(); },
    get sessionId() { return (transport as unknown as {sessionId?: string}).sessionId; },
  };
  client = new Client({ name: 'mioon-acceptance-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(wire);
  report.server = client.getServerVersion() as Report['server']; assert.equal(report.server?.name, 'mioon');
  const listing = await client.listTools(); report.toolNames = listing.tools.map(tool => tool.name);
  for (const name of ['project_create', 'project_get', 'shot_create', 'shot_update', 'generation_submit', 'job_get', 'version_list', 'version_select', 'export_create', 'job_reconcile']) assert.ok(report.toolNames?.includes(name), `Missing MCP tool ${name}`);
  async function call<T = unknown>(name: string, args: Record<string, unknown> = {}, expectError = false): Promise<T> {
    const result = await client!.callTool({ name, arguments: args }); const content = result.content as Array<{type: string; text: string}>; const text = content.find(item => item.type === 'text'); assert.ok(text, name);
    const body = JSON.parse(text.text) as {ok?: boolean; data?: unknown; error?: unknown};
    report.calls.push({ at: new Date().toISOString(), name, args: args.dataBase64 ? { ...args, dataBase64: `[${(args.dataBase64 as string).length} base64 characters]` } : args, result: body });
    assert.equal(Boolean(result.isError), expectError, JSON.stringify(body)); assert.equal(body.ok, !expectError, JSON.stringify(body)); return (body.ok ? body.data : body.error) as T;
  }
  async function until(jobId: string): Promise<{status?: string; [key: string]: unknown}> { const end = Date.now() + 45_000; let job: {status?: string; [key: string]: unknown} = {}; do { job = await call('job_get', { jobId }); if (job.status === 'succeeded' || job.status === 'failed') break; await pause(150); } while (Date.now() < end); assert.equal(job.status, 'succeeded', JSON.stringify(job)); return job; }
  const beforeInvalid = await call('project_list');
  const invalidInput = { name: 'Unexpected fields must not create a project', unexpectedField: 'rejected-by-shared-strict-schema' };
  let invalidResult: unknown;
  try { const toolError = await client.callTool({ name: 'project_create', arguments: invalidInput }); assert.equal(toolError.isError, true, 'MCP must reject unknown fields instead of silently stripping them'); invalidResult = toolError; }
  catch (error) { const failure = error as {code?: number; message?: string}; if (failure.code !== -32602) throw error; invalidResult = { code: failure.code, message: failure.message }; }
  report.strictInputRejection = invalidResult;
  assert.deepEqual(await call('project_list'), beforeInvalid, 'Malformed MCP tool call must not mutate state');
  const invalidHttp = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ operation: 'project.create', input: invalidInput }) });
  assert.equal(invalidHttp.status, 400); assert.equal(((await invalidHttp.json()) as {error?: {code?: string}}).error?.code, 'VALIDATION_ERROR');
  assert.deepEqual(await call('project_list'), beforeInvalid, 'Malformed HTTP call must also preserve state');
  const imagePath = path.join(root, 'mcp-reference.png'), videoPath = path.join(root, 'mcp-reference.mp4');
  for (const [args, file] of [
    [['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=480x640:rate=1', '-frames:v', '1', '-threads', '1'], imagePath],
    [['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24', '-t', '0.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-threads', '1'], videoPath],
  ] as Array<[string[], string]>) { const result = await exec('ffmpeg', [...args, file]); report.commands.push({ file: 'ffmpeg', args: [...args, file], exitCode: 0, stdout: result.stdout, stderr: result.stderr }); }
  const project = await call<{id: string}>('project_create', { name: 'MCP 竖屏短片 · 持久化验收', description: '通过官方 MCP SDK 实际创建，所有视频均为模拟素材。无真实生成费用。' }); report.projectId = project.id;
  const image = await call<{id: string}>('asset_import', { projectId: project.id, name: 'MCP reference.png', mimeType: 'image/png', dataBase64: (await readFile(imagePath)).toString('base64') });
  const video = await call<{id: string}>('asset_import', { projectId: project.id, name: 'MCP reference.mp4', mimeType: 'video/mp4', dataBase64: (await readFile(videoPath)).toString('base64') });
  const note = await call<{id: string}>('node_create', { projectId: project.id, type: 'text', label: '创意简报', text: '三镜头竖屏短片。先编辑提示词，再生成、对比版本并拼接导出。', position: { x: 30, y: 50 } });
  const imageNode = await call<{id: string}>('node_create', { projectId: project.id, type: 'image', label: '参考图片', assetId: image.id, position: { x: 30, y: 310 } });
  await call('node_create', { projectId: project.id, type: 'video', label: '导入视频', assetId: video.id, position: { x: 30, y: 620 } });
  const shots: Array<{id: string; revision: number}> = [];
  for (const [index, title] of ['01 · 开场', '02 · 主体', '03 · 收尾'].entries()) shots.push(await call<{id: string; revision: number}>('shot_create', { projectId: project.id, title, prompt: `平稳推进镜头，抽象几何色块，第 ${index + 1} 个分镜。`, referenceAssetIds: [image.id], aspectRatio: '9:16', duration: 2, position: { x: 410 + index * 350, y: 170 } }));
  await call('edge_create', { projectId: project.id, source: note.id, target: shots[0].id });
  await call('edge_create', { projectId: project.id, source: imageNode.id, target: shots[0].id });
  await call('edge_create', { projectId: project.id, source: shots[0].id, target: shots[1].id });
  await call('edge_create', { projectId: project.id, source: shots[1].id, target: shots[2].id });
  const updated = await call<{id: string; revision: number; prompt: string}>('shot_update', { shotId: shots[0].id, expectedRevision: shots[0].revision, patch: { prompt: '缓慢向前推进，柔和电影光线，色彩清晰。', position: { x: 410, y: 190 } } });
  const firstInput = { shotId: updated.id, expectedRevision: updated.revision, requestId: randomUUID(), providerId: 'mock' };
  const first = await call<{id: string}>('generation_submit', firstInput); assert.equal((await call<{id: string}>('generation_submit', firstInput)).id, first.id); await until(first.id);
  let state = await call<{shots: Array<{id: string; revision: number; prompt?: string; selectedVersionId?: string}>; versions: Array<{id: string; snapshot: {prompt: string}}>}>('project_get', { projectId: project.id }); const s1 = state.shots.find(shot => shot.id === updated.id)!;
  const editedAgain = await call<{id: string; revision: number; prompt: string}>('shot_update', { shotId: s1.id, expectedRevision: s1.revision, patch: { prompt: '缓慢向前推进，暖色调光线，结尾停留。' } });
  assert.equal((await call<{code?: string}>('shot_update', { shotId: s1.id, expectedRevision: s1.revision, patch: { prompt: 'stale must not overwrite' } }, true)).code, 'REVISION_CONFLICT');
  const second = await call<{id: string}>('generation_submit', { shotId: s1.id, expectedRevision: editedAgain.revision, requestId: randomUUID(), providerId: 'mock' }); await until(second.id);
  const versions = await call<Array<{id: string; snapshot: {prompt: string}}>>('version_list', { shotId: s1.id }); assert.equal(versions.length, 2); assert.equal(versions[0].snapshot.prompt, updated.prompt); assert.equal(versions[1].snapshot.prompt, editedAgain.prompt);
  assert.equal((await call<{id: string}>('generation_submit', firstInput)).id, first.id);
  await call('version_select', { shotId: s1.id, versionId: versions[1].id, expectedRevision: editedAgain.revision });
  for (const shot of shots.slice(1)) { const job = await call<{id: string}>('generation_submit', { shotId: shot.id, expectedRevision: shot.revision, requestId: randomUUID(), providerId: 'mock' }); await until(job.id); }
  state = await call('project_get', { projectId: project.id }); assert.equal(state.shots.length, 3); assert.equal(state.versions.length, 4); assert.equal(state.shots.find(shot => shot.id === s1.id)?.selectedVersionId, versions[1].id); assert.equal(state.shots.find(shot => shot.id === s1.id)?.prompt, editedAgain.prompt);
  const exported = await call<{id: string}>('export_create', { projectId: project.id, requestId: randomUUID() });
  const end = Date.now() + 50_000; let finalExport: {status?: string; [key: string]: unknown} = {}; do { finalExport = await call('export_get', { exportId: exported.id }); if (['succeeded', 'failed'].includes(finalExport.status as string)) break; await pause(200); } while (Date.now() < end); assert.equal(finalExport.status, 'succeeded', JSON.stringify(finalExport));
  const http = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ operation: 'project.get', input: { projectId: project.id } }) }); const httpBody = await http.json() as {ok?: boolean; data?: unknown}; assert.equal(httpBody.ok, true); const mcpState = await call('project_get', { projectId: project.id }); assert.deepEqual(httpBody.data, mcpState);
  assert.ok(traffic.some(record => record.direction === 'client-to-server' && record.message.method === 'initialize'));
  assert.ok(traffic.some(record => record.direction === 'client-to-server' && record.message.method === 'notifications/initialized'));
  assert.ok(traffic.some(record => record.direction === 'client-to-server' && record.message.method === 'tools/list'));
  assert.ok(traffic.some(record => record.direction === 'client-to-server' && record.message.method === 'tools/call' && record.message.params?.name === 'generation_submit'));
  report.result = 'passed'; report.sharedStateVerifiedByHttp = true; report.shotIds = state.shots.map(shot => shot.id); report.versionIds = state.versions.map(version => version.id); report.exportId = exported.id; report.persistedForBrowser = Boolean(persist);
  await writeFile(path.join(evidence, 'project-state.json'), JSON.stringify(mcpState, null, 2));
  if (persist) await writeFile(path.join(evidence, 'demo-project.json'), JSON.stringify({ projectId: project.id, dataDirectory: root, shotIds: report.shotIds, versionIds: report.versionIds, exportId: exported.id, browserInstructions: 'Start backend with MIOON_DATA_DIR set to dataDirectory and any own local MIOON_TOKEN. The SDK backend has been stopped.' }, null, 2));
  t.diagnostic(`Official MCP wire verified; ${traffic.length} messages; project ${project.id}; ${persist ? `persisted in ${root}` : 'isolated temporary fixture'}`);
});
