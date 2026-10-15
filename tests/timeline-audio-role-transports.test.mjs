import test from 'node:test';
import assert from 'node:assert/strict';
import {assertClientRecoveryError} from './recovery-transport-assertions.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createClient} from '../packages/client/src/index.mjs';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const token = 'timeline-audio-role-transports-synthetic-token';
const fadeFields = ['fadeInFrames', 'fadeOutFrames'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const toolName = operation => operation.replaceAll('.', '_');
const request = (projectId, timeline, fields = {}) => ({projectId, expectedRevision: timeline.revision, requestId: randomUUID(), ...fields});
const editable = timeline => ({tracks: timeline.tracks, clips: timeline.clips, durationFrames: timeline.durationFrames});
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const resolveSchema = (root, field) => field.$ref ? resolveSchema(root, field.$ref.slice(2).split('/').reduce((value, key) => value[key], root)) : field;

function environment(extra = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) {
    if (/^(?:MIOON_|RUNWAY|ARK_|VEO_|GOOGLE_|MINIMAX_|VIDU_|OPENAI_|ANTHROPIC_|AZURE_|AWS_|NODE_OPTIONS$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key)) delete env[key];
  }
  return {...env, MIOON_ENABLE_LIVE_PROVIDER: '0', RUNWAY_MAX_GENERATIONS: '0', ...extra};
}

async function cli(args, env = {}, expectedError) {
  const child = spawn(process.execPath, [path.join(repo, 'apps/cli/src/index.mjs'), ...args], {cwd: repo, env: environment(env), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  // JSON descriptions may cross pipe chunks inside a UTF-8 character.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8').on('data', bytes => stdout += bytes); child.stderr.setEncoding('utf8').on('data', bytes => stderr += bytes);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  let code, signal;
  try { [code, signal] = await once(child, 'close'); } finally { clearTimeout(timeout); }
  assert.equal(signal, null, stderr);
  assert.equal(stdout.trim().split('\n').length, 1, 'CLI returns one JSON envelope');
  const body = JSON.parse(stdout);
  assert.equal(body.ok, !expectedError, stdout + stderr);
  assert.ok(!stdout.includes(token) && !stderr.includes(token), 'CLI keeps the synthetic token private');
  if (expectedError) {
    assert.equal(body.error.code, expectedError, stdout);
    assert.equal(code, expectedError === 'VALIDATION_ERROR' ? 2 : expectedError.includes('CONFLICT') ? 3 : 6, stdout);
    assert.ok(stderr.trim()); return body.error;
  }
  assert.equal(code, 0, stdout + stderr); return body.data;
}

async function mcpFixture(t, env = {}) {
  const client = new Client({name: 'timeline-audio-role-transport-tests', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.mjs')], cwd: repo, env: environment(env), stderr: 'pipe'});
  let stderr = ''; transport.stderr?.setEncoding('utf8').on('data', bytes => stderr += bytes);
  t.after(() => client.close()); await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'mioon', 'official SDK initializes the actual MCP bridge');
  return {client, async call(name, input, expectedError) {
    const response = await client.callTool({name, arguments: input}, undefined, {timeout: 10000});
    const blocks = response.content.filter(item => item.type === 'text'); assert.equal(blocks.length, 1);
    const body = JSON.parse(blocks[0].text);
    assert.deepEqual(response.structuredContent, body);
    assert.equal(Boolean(response.isError), Boolean(expectedError), blocks[0].text);
    assert.equal(body.ok, !expectedError, blocks[0].text);
    assert.ok(!JSON.stringify(response).includes(token) && !stderr.includes(token));
    if (expectedError) { assert.equal(body.error.code, expectedError); return body.error; }
    return body.data;
  }};
}

async function backendFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-fades-transports-'));
  // Synthetic metadata only: no source files, provider keys, FFmpeg or rendering.
  const store = openStore(root), services = createServices(store, new Map());
  const projectId = (await services.call('project.create', {name: 'Role transport parity'})).id;
  const assets = {};
  for (const [name, mimeType, hasAudio] of [['video', 'video/mp4', true], ['audio', 'audio/wav', true], ['silent', 'video/mp4', false], ['unknown', 'video/mp4', undefined], ['image', 'image/png', true]]) {
    const id = randomUUID(); assets[name] = id;
    store.put('assets', {id, projectId, name: `Synthetic ${name}`, mimeType, duration: 30, width: 720, height: 1280, sha256: 'a'.repeat(64), relativePath: `media/${id}.fixture`, ...(hasAudio === undefined ? {} : {hasAudio})});
  }
  store.close();
  let backend, url, port = 0, readOnly;
  async function stop() {
    if (!backend || backend.exitCode !== null || backend.signalCode) return;
    const child = backend, ended = once(child, 'exit'); child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { await ended; } finally { clearTimeout(timeout); }
  }
  t.after(async () => { readOnly?.close(); await stop(); await rm(root, {recursive: true, force: true}); });
  async function start() {
    let stdout = '', stderr = '', spawnError;
    backend = spawn(process.execPath, [path.join(repo, 'apps/server/src/cli.mjs')], {cwd: repo, env: environment({MIOON_DATA_DIR: root, PORT: String(port), MIOON_TOKEN: token}), stdio: ['ignore', 'pipe', 'pipe']});
    backend.once('error', error => spawnError = error);
    backend.stdout.setEncoding('utf8').on('data', bytes => stdout += bytes); backend.stderr.setEncoding('utf8').on('data', bytes => stderr += bytes);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal(backend.exitCode, null, stderr); assert.equal(backend.signalCode, null, stderr);
      const ready = /Mioon ready at (http:\/\/127\.0\.0\.1:(\d+))/.exec(stdout);
      if (ready) { url = ready[1]; port = Number(ready[2]); assert.equal((await fetch(url + '/health')).status, 200); return; }
      await pause(25);
    }
    throw Error(`Backend did not start: ${stdout}\n${stderr}`);
  }
  await start();
  readOnly = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  const tables = readOnly.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name);
  return {projectId, assets, get url() { return url; }, get pid() { return backend.pid; }, restart: async () => { await stop(); await start(); },
    async http(operation, input, expectedError) {
      const response = await fetch(url + '/api/rpc', {method: 'POST', redirect: 'error', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({operation, input})});
      const body = await response.json();
      assert.equal(response.status, !expectedError ? 200 : expectedError.includes('CONFLICT') ? 409 : 400, JSON.stringify(body));
      assert.equal(body.ok, !expectedError, JSON.stringify(body));
      if (expectedError) { assert.equal(body.error.code, expectedError); return body.error; } return body.data;
    },
    storage: () => Object.fromEntries(tables.map(table => [table, readOnly.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all()])),
    version: () => readOnly.prepare('PRAGMA data_version').get().data_version,
  };
}


test('audio roles use the existing HTTP, CLI and official MCP timeline journal', {timeout:120000}, async t=>{
 const backend=await backendFixture(t),{projectId,assets}=backend,env={MIOON_BASE_URL:backend.url,MIOON_TOKEN:token},mcp=await mcpFixture(t,env);
 const command=(op,input,error)=>cli([...op.split('.'),'--input',JSON.stringify(input)],env,error);
 const tools=(await mcp.client.listTools()).tools;
 for(const op of ['timeline.clip.add','timeline.clip.update']){
  const tool=tools.find(t=>t.name===toolName(op)),fields=op.endsWith('.add')?tool.inputSchema:tool.inputSchema.properties.patch;
  assert.ok(fields.properties.audioRole);assert.equal(fields.required?.includes('audioRole')??false,false);assert.equal(Object.hasOwn(fields.properties.audioRole,'default'),false);
  assert.equal(tool.annotations.openWorldHint,false);
 }
 let timeline=await backend.http('timeline.get',{projectId});const lane=timeline.tracks.find(t=>t.kind==='video').id;
 const add=request(projectId,timeline,{trackId:lane,assetId:assets.silent,startFrame:0,durationFrames:60,audioRole:'human'});
 timeline=await backend.http('timeline.clip.add',add);const initial=timeline,clipId=timeline.clips[0].id;
 assert.deepEqual(await command('timeline.clip.add',add),initial);assert.deepEqual(await mcp.call('timeline_clip_add',add),initial);
 const update=request(projectId,timeline,{clipId,patch:{audioRole:'music'}});timeline=await command('timeline.clip.update',update);const labelled=timeline;
 assert.deepEqual(await backend.http('timeline.clip.update',update),labelled);assert.deepEqual(await mcp.call('timeline_clip_update',update),labelled);
 timeline=await mcp.call('timeline_undo',request(projectId,timeline));assert.equal(timeline.clips[0].audioRole,'human');
 timeline=await backend.http('timeline.redo',request(projectId,timeline));assert.equal(timeline.clips[0].audioRole,'music');
 const clear=request(projectId,timeline,{clipId,patch:{audioRole:null}});timeline=await mcp.call('timeline_clip_update',clear);assert.equal(timeline.clips[0].audioRole,null);
 const bad=request(projectId,timeline,{clipId,patch:{audioRole:'invalid'}});const before=backend.storage();
 await backend.http('timeline.clip.update',bad,'VALIDATION_ERROR');await command('timeline.clip.update',bad,'VALIDATION_ERROR');await mcp.call('timeline_clip_update',bad,'VALIDATION_ERROR');assert.deepEqual(backend.storage(),before);
 await backend.restart();const recovered=backend.storage();assert.deepEqual(await backend.http('timeline.clip.update',update),labelled);assert.deepEqual(await command('timeline.clip.add',add),initial);assert.deepEqual(backend.storage(),recovered);
 const image=request(projectId,timeline,{trackId:lane,assetId:assets.image,startFrame:60,durationFrames:30,audioRole:'sfx'});
 const rejection=await backend.http('timeline.clip.add',image,'AUDIO_ROLE_CLIP_UNSUPPORTED');assert.equal(rejection.details.operation,'timeline.clip.add');assert.equal(rejection.details.projectId,projectId);
 const cliError=await command('timeline.clip.add',image,'AUDIO_ROLE_CLIP_UNSUPPORTED');assert.equal(cliError.details.operation,rejection.details.operation);assert.equal(cliError.details.requestId,rejection.details.requestId);assert.equal(cliError.details.mutationOutcome,'not_applied');
});
