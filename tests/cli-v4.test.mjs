import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, writeFile, readFile, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import http from 'node:http';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '@mioon/server';
import {schemas} from '@mioon/contracts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const cliPath = path.join(repo, 'apps/cli/src/index.mjs');
const exec = promisify(execFile);
const token = 'synthetic-v4-cli-token-never-live';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function environment(extra = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(MIOON_|RUNWAY|ARK_|VEO_|GOOGLE_|MIOON_)/.test(key)) delete env[key];
  return {...env, MIOON_ENABLE_LIVE_PROVIDER:'0', RUNWAY_MAX_GENERATIONS:'0', ...extra};
}
function startCli(args, env = {}, stdin = '') {
  const child = spawn(process.execPath, [cliPath, ...args], {cwd:repo, env:environment(env), stdio:['pipe','pipe','pipe']});
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', bytes => stdout += bytes);
  child.stderr.setEncoding('utf8').on('data', bytes => stderr += bytes);
  child.stdin.on('error', () => {});
  child.stdin.end(stdin);
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(Error(`CLI did not exit: ${args.slice(0, 3).join(' ')}`)); }, 90_000);
    child.once('error', error => {clearTimeout(timeout); reject(error);});
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      try {
        const lines = stdout.trim().split('\n');
        assert.equal(lines.length, 1, 'stdout contains exactly one JSON result and no logging');
        resolve({code, signal, stdout, stderr, body:JSON.parse(stdout)});
      } catch (error) { reject(Error(`${error.message}; CLI stdout=${stdout}; stderr=${stderr}`)); }
    });
  });
  return {child, result};
}
const cli = (args, env, stdin) => startCli(args, env, stdin).result;
function succeeded(result) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.body.ok, true, result.stdout);
  assert.ok(Object.hasOwn(result.body, 'data'));
  return result.body.data;
}
function failed(result, exit, errorCode) {
  assert.equal(result.code, exit, result.stdout + result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.body.ok, false);
  assert.equal(typeof result.body.error?.code, 'string');
  assert.equal(typeof result.body.error?.message, 'string');
  if (errorCode) assert.equal(result.body.error.code, errorCode);
  assert.ok(result.stderr.trim(), 'a failed command gives a brief stderr explanation');
  assert.ok(!result.stdout.includes(token));
  assert.ok(!result.stderr.includes(token));
  return result.body.error;
}
async function rpc(service, operation, input = {}) {
  const response = await fetch(service.url + '/api/rpc', {method:'POST', headers:{authorization:`Bearer ${service.token}`, 'content-type':'application/json'}, body:JSON.stringify({operation,input})});
  const body = await response.json();
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.data;
}
async function until(read, predicate, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, `${message}: ${JSON.stringify(value)}`);
    await pause(30);
  }
}
async function proxyTo(service) {
  const requests = [];
  let dropRequestId;
  const proxy = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const bytes of req) chunks.push(bytes);
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : null;
      if (body) requests.push(body);
      const upstream = await fetch(service.url + req.url, {method:req.method, headers:{'content-type':'application/json', authorization:req.headers.authorization || ''}, ...(raw ? {body:raw} : {})});
      const response = Buffer.from(await upstream.arrayBuffer());
      if (dropRequestId !== undefined && body?.input?.requestId === dropRequestId) {dropRequestId = undefined; res.destroy(); return;}
      res.writeHead(upstream.status, {'content-type':upstream.headers.get('content-type') || 'application/octet-stream'}); res.end(response);
    } catch {res.destroy();}
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return {url:`http://127.0.0.1:${proxy.address().port}`, requests, drop(id) {dropRequestId = id;}, close:() => new Promise(resolve => proxy.close(resolve))};
}
async function connectMcp(t, env) {
  const client = new Client({name:'cli-v4-cross-transport-tests', version:'1.0.0'}, {capabilities:{}});
  const transport = new StdioClientTransport({command:process.execPath, args:[path.join(repo, 'apps/mcp/src/index.mjs')], cwd:repo, env:environment(env), stderr:'pipe'});
  transport.stderr?.resume();
  t.after(() => client.close());
  await client.connect(transport);
  return async (name, input = {}) => {
    const result = await client.callTool({name, arguments:input});
    const text = result.content.find(item => item.type === 'text');
    assert.ok(text, name);
    const body = JSON.parse(text.text);
    assert.deepEqual(result.structuredContent, body, 'MCP text and structuredContent must agree');
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(Boolean(result.isError), false);
    return body.data;
  };
}

// These tests never configure live providers. All HTTP servers bind loopback and
// every durable write is confined to a disposable test directory.
test('CLI offline discovery is JSON and invalid input fails before connection resolution', {timeout:30_000}, async () => {
  for (const args of [['--help'], ['--version'], ['schema'], ['schema','generation.submit']]) succeeded(await cli(args));
  const catalog = succeeded(await cli(['schema']));
  const serialized = JSON.stringify(catalog);
  for (const operation of Object.keys(schemas)) assert.ok(serialized.includes(operation), `schema catalog misses ${operation}`);
  for (const args of [
    ['project','create','--input','{'],
    ['project','create','--input','[]'],
    ['project','create','--input','{"name":"strict","surprise":true}'],
    ['generation','submit','--input',JSON.stringify({shotId:randomUUID(), expectedRevision:1, providerId:'mock'})],
    ['rpc','does.not.exist','--input','{}'],
    ['schema','does.not.exist'],
    ['project','list','--unknown-option'],
    ['project','list','--token',token],
    ['generation','submit','--input',JSON.stringify({shotId:randomUUID(), expectedRevision:1, providerId:'mock', requestId:'original-key'}),'--request-id','different-key'],
    ['job','watch','--input',JSON.stringify({jobId:randomUUID()}),'--timeout-ms','-1'],
  ]) failed(await cli(args), 2);
  for (const command of [['project','list'], ['capabilities'], ['doctor']]) failed(await cli(command), 4);
});

test('CLI inputs, MCP crossvisibility, stable replay, watches and real mock export share one backend', {timeout:120_000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-cli-v4-'));
  const dataDir = path.join(root, 'data');
  const service = await startServer({dataDir, port:0, token});
  const proxy = await proxyTo(service);
  const tokenFile = path.join(root, 'cli-token');
  await writeFile(tokenFile, token, {mode:0o600});
  const env = {MIOON_BASE_URL:proxy.url, MIOON_TOKEN_FILE:tokenFile};
  t.after(async () => {await proxy.close(); await service.close(); await rm(root, {recursive:true, force:true});});
  const command = async (operation, input = {}, flags = []) => succeeded(await cli([...operation.split('.'), '--input', JSON.stringify(input), ...flags], env));
  const callMcp = await connectMcp(t, env);
  assert.deepEqual(succeeded(await cli(['schema'], env)), await callMcp('mioon_schema'), 'CLI and MCP discovery share exact schema metadata');
  assert.deepEqual(succeeded(await cli(['capabilities'], env)), await rpc(service, 'provider.list'));
  const doctor = succeeded(await cli(['doctor'], env));
  assert.equal(doctor.ready, true); assert.equal(doctor.connection.source, 'private-token-file');
  assert.equal(doctor.connection.credentialsReloadedPerRequest, true);
  assert.ok(!JSON.stringify(doctor).includes(token)); assert.ok(!JSON.stringify(doctor).includes(root));
  const project = await command('project.create', {name:'CLI + MCP isolated mock workflow'});
  assert.equal((await callMcp('project_get', {projectId:project.id})).project.id, project.id);
  const mcpProject = await callMcp('project_create', {name:'Created by MCP; read by CLI'});
  const listed = succeeded(await cli(['rpc','project.list','--input','{}'], env));
  assert.ok(listed.some(item => item.id === mcpProject.id));

  await t.test('stdin, JSON files and explicit media files preserve one strict API contract', async () => {
    const inputFile = path.join(root, 'project-input.json');
    await writeFile(inputFile, JSON.stringify({projectId:project.id}));
    assert.equal(succeeded(await cli(['project','get','--input-file',inputFile], env)).project.id, project.id);
    assert.equal(succeeded(await cli(['project','get','--input','-'], env, JSON.stringify({projectId:project.id}))).project.id, project.id);
    const before = proxy.requests.length;
    failed(await cli(['project','get','--input','{}','--input-file',inputFile], env), 2);
    assert.equal(proxy.requests.length, before, 'conflicting input sources must never dispatch');
  });

  const imagePath = path.join(root, 'reference.png');
  await exec(process.env.MIOON_FFMPEG_PATH || 'ffmpeg', ['-v','error','-y','-f','lavfi','-i','color=c=0x3566ab:s=16x16','-frames:v','1','-threads','1',imagePath]);
  const image = await command('asset.import', {projectId:project.id}, ['--file',imagePath]);
  assert.equal(image.name, 'reference.png');
  assert.equal(image.mimeType, 'image/png');
  const importRequest = proxy.requests.find(item => item.operation === 'asset.import');
  assert.equal(typeof importRequest.input.dataBase64, 'string');
  assert.ok(!JSON.stringify(importRequest).includes(imagePath), 'explicit file import sends bytes, never local paths');
  assert.equal((await callMcp('asset_list', {projectId:project.id}))[0].id, image.id);
  const shot = await command('shot.create', {projectId:project.id, title:'Only a simulated shot', prompt:'Offline fixture', duration:2, referenceAssetIds:[image.id]});
  let finished;

  await t.test('stable request IDs replay exactly across CLI and MCP and never duplicate provider submits', async () => {
    const requestId = randomUUID();
    const input = {shotId:shot.id, expectedRevision:shot.revision, providerId:'mock'};
    const before = proxy.requests.length;
    failed(await cli(['generation','submit','--input',JSON.stringify(input)], env), 2, 'VALIDATION_ERROR');
    assert.equal(proxy.requests.length, before, 'the CLI must never invent an idempotency key');
    const first = await command('generation.submit', input, ['--request-id',requestId]);
    assert.equal(first.requestId, requestId);
    assert.equal((await command('generation.submit', input, ['--request-id',requestId])).id, first.id);
    assert.equal((await callMcp('generation_submit', {...input, requestId})).id, first.id);
    finished = await command('job.watch', {jobId:first.id}, ['--timeout-ms','45000','--interval-ms','40']);
    assert.equal(finished.status, 'succeeded');
    const db = new DatabaseSync(path.join(dataDir, 'workbench.sqlite'), {readOnly:true});
    try {assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mock_provider_submissions WHERE request_id=?').get(requestId).n, 1);}
    finally {db.close();}
    const payloads = proxy.requests.filter(item => item.operation === 'generation.submit' && item.input.requestId === requestId);
    assert.equal(payloads.length, 3);
    for (const body of payloads) assert.deepEqual(body.input, {...input, requestId});
    const changed = await cli(['generation','submit','--input',JSON.stringify({...input, parameters:{seed:123}}),'--request-id',requestId], env);
    failed(changed, 3, 'IDEMPOTENCY_CONFLICT');
  });

  await t.test('version selection, timeline editing and export watch use actual durable media', async () => {
    const versions = await command('version.list', {shotId:shot.id});
    assert.equal(versions.length, 1); assert.equal(versions[0].id, finished.versionId);
    const state = await command('project.get', {projectId:project.id});
    const current = state.shots.find(item => item.id === shot.id);
    const selected = await command('version.select', {shotId:shot.id, versionId:versions[0].id, expectedRevision:current.revision});
    assert.equal(selected.selectedVersionId, versions[0].id);
    const timeline = await command('timeline.get', {projectId:project.id});
    const seeded = await command('timeline.seed', {projectId:project.id, expectedRevision:timeline.revision}, ['--request-id',randomUUID()]);
    assert.equal(seeded.clips.length, 1);
    const short = await command('timeline.clip.update', {projectId:project.id, expectedRevision:seeded.revision, clipId:seeded.clips[0].id, patch:{durationFrames:6}}, ['--request-id',randomUUID()]);
    assert.equal((await callMcp('timeline_get', {projectId:project.id})).clips[0].durationFrames, 6);
    const exportRequest = {projectId:project.id, expectedRevision:short.revision, purpose:'export', requestId:randomUUID()};
    const queued = await command('timeline.render', exportRequest);
    assert.equal((await callMcp('timeline_render', exportRequest)).id, queued.id);
    const rendered = await command('export.watch', {exportId:queued.id}, ['--timeout-ms','45000','--interval-ms','50']);
    assert.equal(rendered.status, 'succeeded');
    assert.equal((await callMcp('export_get', {exportId:queued.id})).assetId, rendered.assetId);
    const media = await fetch(service.url + rendered.url, {headers:{authorization:`Bearer ${token}`}});
    assert.equal(media.status, 200); assert.equal(media.headers.get('content-type'), 'video/mp4');
    const file = path.join(root, 'verified-export.mp4'); await writeFile(file, Buffer.from(await media.arrayBuffer()));
    const probe = JSON.parse((await exec(process.env.MIOON_FFPROBE_PATH || 'ffprobe', ['-v','error','-show_streams','-show_format','-of','json',file])).stdout);
    const downloadPath = path.join(root, 'cli-export.mp4');
    succeeded(await cli(['export','download','--input',JSON.stringify({exportId:queued.id}),'--output',downloadPath], env));
    const exportedBytes = await readFile(file);
    assert.deepEqual(await readFile(downloadPath), exportedBytes, 'CLI downloads the exact managed export bytes');
    const existing = await cli(['export','download','--input',JSON.stringify({exportId:queued.id}),'--output',downloadPath], env);
    failed(existing, 3, 'OUTPUT_EXISTS');
    assert.deepEqual(await readFile(downloadPath), exportedBytes, 'existing output is never overwritten');
    const assetDownload = path.join(root, 'cli-asset.mp4');
    succeeded(await cli(['asset','download','--input',JSON.stringify({assetId:rendered.assetId}),'--output',assetDownload], env));
    assert.deepEqual(await readFile(assetDownload), exportedBytes);
    const limitedPath = path.join(root, 'too-small-download.mp4');
    failed(await cli(['asset','download','--input',JSON.stringify({assetId:rendered.assetId}),'--output',limitedPath,'--max-bytes','1'], env), 2, 'FILE_TOO_LARGE');
    await assert.rejects(readFile(limitedPath), {code:'ENOENT'}, 'size-limit errors remove any partial local file');
    const video = probe.streams.find(item => item.codec_type === 'video');
    assert.equal(video.width, 720); assert.equal(video.height, 1280);
    assert.equal(video.codec_name, 'h264'); assert.ok(Number(probe.format.duration) > 0);
  });

  await t.test('HTTP response loss is recoverable by exact replay without a second provider submit', async () => {
    const state = await command('project.get', {projectId:project.id});
    const input = {shotId:shot.id, expectedRevision:state.shots[0].revision, providerId:'mock', requestId:randomUUID(), parameters:{scenario:'delay',delayMs:60_000}};
    proxy.drop(input.requestId);
    const lost = failed(await cli(['generation','submit','--input',JSON.stringify(input)], env), 4);
    assert.equal(lost.details.requestId, input.requestId);
    assert.equal(lost.details.submissionMayHaveSucceeded, true);
    const replay = await command('generation.submit', input);
    const existing = (await callMcp('job_list', {projectId:project.id})).filter(item => item.requestId === input.requestId);
    assert.equal(existing.length, 1); assert.equal(replay.id, existing[0].id);
    await until(() => rpc(service, 'job.get', {jobId:replay.id}), value => value.submissionCount === 1, 'provider submit did not start');
    const db = new DatabaseSync(path.join(dataDir, 'workbench.sqlite'), {readOnly:true});
    try {assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mock_provider_submissions WHERE request_id=?').get(input.requestId).n, 1);}
    finally {db.close();}
    const payloads = proxy.requests.filter(item => item.operation === 'generation.submit' && item.input.requestId === input.requestId);
    assert.equal(payloads.length, 2, 'a lost response must not cause a hidden HTTP resubmission');
    assert.deepEqual(payloads[0], payloads[1]);

    const watchStart = proxy.requests.length;
    failed(await cli(['job','watch','--input',JSON.stringify({jobId:replay.id}),'--timeout-ms','140','--interval-ms','20'], env), 5);
    const observer = startCli(['job','watch','--input',JSON.stringify({jobId:replay.id}),'--timeout-ms','60000','--interval-ms','40'], env);
    t.after(() => {if (observer.child.exitCode === null && !observer.child.signalCode) observer.child.kill('SIGTERM');});
    const beforePoll = proxy.requests.filter(item => item.operation === 'job.get').length;
    await until(() => proxy.requests.filter(item => item.operation === 'job.get').length, n => n > beforePoll, 'watch never reached HTTP');
    observer.child.kill('SIGINT');
    failed(await observer.result, 130);
    assert.ok(proxy.requests.slice(watchStart).every(item => item.operation !== 'job.cancel'), 'stopping a watch never cancels a durable job');
    const pending = await rpc(service, 'job.get', {jobId:replay.id});
    assert.equal(pending.status, 'running'); assert.equal(pending.cancelScope, null);
  });

  await t.test('watch reports terminal failure and strict revision conflicts without mutating existing work', async () => {
    const state = await command('project.get', {projectId:project.id});
    const current = state.shots[0];
    const failedJob = await command('generation.submit', {shotId:shot.id, expectedRevision:current.revision, providerId:'mock', parameters:{scenario:'terminal_failure', delayMs:0}}, ['--request-id',randomUUID()]);
    failed(await cli(['job','watch','--input',JSON.stringify({jobId:failedJob.id}),'--timeout-ms','15000','--interval-ms','40'], env), 6);
    const stale = await cli(['shot','update','--input',JSON.stringify({shotId:shot.id, expectedRevision:1, patch:{title:'must not overwrite'}})], env);
    const conflict = failed(stale, 3, 'REVISION_CONFLICT');
    assert.equal(conflict.details.currentRevision, current.revision);
    assert.equal((await rpc(service, 'project.get', {projectId:project.id})).shots[0].title, current.title);
    const invalid = await cli(['project','create','--input','{"name":"no mutation","hidden":true}'], env);
    failed(invalid, 2, 'VALIDATION_ERROR');
    assert.equal((await rpc(service, 'project.list')).length, 2);
  });

  await t.test('token-file permissions and authentication failures are safely classified', async () => {
    const wrongFile = path.join(root, 'wrong-token');
    await writeFile(wrongFile, 'another-synthetic-token-never-live', {mode:0o600});
    failed(await cli(['project','list'], {MIOON_BASE_URL:service.url, MIOON_TOKEN_FILE:wrongFile}), 4, 'UNAUTHORIZED');
    if (process.platform !== 'win32') {
      await chmod(wrongFile, 0o644);
      const output = await cli(['project','list'], {MIOON_BASE_URL:service.url, MIOON_TOKEN_FILE:wrongFile});
      failed(output, 4);
      assert.ok(!output.stdout.includes(wrongFile)); assert.ok(!output.stderr.includes(wrongFile));
    }
  });
});


test('CLI unexpected backend errors and unreadable responses keep structured, redacted failure exits', {timeout:15_000}, async t => {
  let malformed = false;
  const fixture = http.createServer(async (req, res) => {
    for await (const _ of req) { /* Drain the local fixture request. */ }
    res.writeHead(malformed ? 200 : 500, {'content-type':'application/json'});
    res.end(malformed ? `unreadable response with ${token}` : JSON.stringify({ok:false,error:{code:'INTERNAL_ERROR',message:`Internal failure ${token}`,details:{authorization:token,retained:true}}}));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const env = {MIOON_BASE_URL:`http://127.0.0.1:${fixture.address().port}`, MIOON_TOKEN:token};
  const error = failed(await cli(['project','list'], env), 1, 'INTERNAL_ERROR');
  assert.equal(error.details.retained, true); assert.ok(!Object.hasOwn(error.details, 'authorization'));
  malformed = true;
  failed(await cli(['project','list'], env), 4, 'BACKEND_PROTOCOL_ERROR');
});
