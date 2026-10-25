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
import {createClient} from '../packages/client/src/index.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const token = 'timeline-fades-transports-synthetic-token';
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
  return {...env, MIOON_ENABLE_LIVE_PROVIDER: '0', ...extra};
}

async function cli(args, env = {}, expectedError) {
  const child = spawn(process.execPath, [path.join(repo, 'apps/cli/src/index.ts'), ...args], {cwd: repo, env: environment(env), stdio: ['ignore', 'pipe', 'pipe']});
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
  const client = new Client({name: 'timeline-fades-transport-tests', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')], cwd: repo, env: environment(env), stderr: 'pipe'});
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

test('fade CLI and official MCP schemas are optional, strict, offline and retain existing operation effects', {timeout: 60000}, async t => {
  const mcp = await mcpFixture(t), catalog = await cli(['schema']);
  assert.deepEqual(await mcp.call('mioon_schema', {}), catalog);
  const tools = (await mcp.client.listTools()).tools;
  const timelineOperations = ['timeline.audioPreview.continuousPlan', 'timeline.colour.source.inspect', 'timeline.colour.image.inspect', 'timeline.colour.jpeg.inspect', 'timeline.audioPreview.plan', 'timeline.subtitle.add', 'timeline.subtitle.update', 'timeline.subtitle.remove', 'timeline.format.get', 'timeline.format.set', 'timeline.get', 'timeline.inspect', 'timeline.history.get', 'timeline.export.preflight', 'timeline.export.capabilities', 'timeline.export.samplePeak', 'timeline.export.loudness', 'timeline.loudness.prepare', 'timeline.clip.loudness', 'timeline.loudness.apply', 'timeline.undo', 'timeline.redo', 'timeline.track.add', 'timeline.track.update', 'timeline.clip.add', 'timeline.clip.update', 'timeline.clip.remove', 'timeline.clip.rippleRemove', 'timeline.clip.split', 'timeline.clip.replaceSource', 'timeline.seed', 'timeline.render', 'timeline.clip.refreshSources', 'timeline.shots.append', 'timeline.clip.splitAtScenes'];
  assert.deepEqual(catalog.operations.filter(item => item.operation.startsWith('timeline.')).map(item => item.operation).sort(), timelineOperations.sort(), 'timeline discovery includes explicit source replacement and ripple removal alongside existing fade fields');
  // Public local inspection is broader than the explicitly consented Agent tool set.
  assert.deepEqual(catalog.operations.filter(item => item.operation.endsWith('.inspect')).map(item => item.operation).sort(), ['asset.inspect', 'lut.inspect', 'lut.look.inspect', 'project.inspect', 'shot.inspect', 'timeline.colour.image.inspect', 'timeline.colour.jpeg.inspect', 'timeline.colour.source.inspect', 'timeline.inspect', 'workspace.backup.inspect', 'workspace.restore.inspect']);
  assert.deepEqual(READ_TOOL_DEFINITIONS.map(tool => tool.name), ['mioon_project_inspect', 'mioon_asset_inspect', 'mioon_shot_inspect', 'mioon_timeline_inspect']);
  const restoreInspection = tools.find(tool => tool.name === 'workspace_restore_inspect');
  assert.ok(restoreInspection); assert.equal(restoreInspection.annotations.readOnlyHint, true);
  assert.deepEqual(Object.keys(restoreInspection.inputSchema.properties), ['includeAudioRoleCapability','includeVolumeEnvelopeCapability']); assert.equal(restoreInspection.inputSchema.properties.includeAudioRoleCapability.const, true); assert.equal(restoreInspection.inputSchema.required?.includes('includeAudioRoleCapability')??false, false); assert.equal(restoreInspection.inputSchema.additionalProperties, false);
  const restoreEffects = catalog.operations.find(item => item.operation === 'workspace.restore.inspect').effects;
  for (const field of ['databaseWrite', 'fileWrite', 'externalIO', 'localProcess', 'paidGeneration']) assert.equal(restoreEffects[field], false);
  const backupInspection = tools.find(tool => tool.name === 'workspace_backup_inspect');
  assert.ok(backupInspection); assert.equal(backupInspection.annotations.readOnlyHint, true);
  assert.deepEqual(backupInspection.inputSchema.properties, {}); assert.equal(backupInspection.inputSchema.additionalProperties, false);
  const backupEffects = catalog.operations.find(item => item.operation === 'workspace.backup.inspect').effects;
  for (const field of ['databaseWrite', 'fileWrite', 'externalIO', 'localProcess', 'paidGeneration']) assert.equal(backupEffects[field], false);
  for (const operation of ['timeline.clip.add', 'timeline.clip.update']) {
    const definition = await cli(['schema', operation]), tool = tools.find(item => item.name === toolName(operation));
    assert.ok(tool); assert.deepEqual(tool.inputSchema, definition.inputSchema);
    assert.deepEqual(await mcp.call('mioon_schema', {operation}), definition);
    assert.equal(definition.requiresRequestId, true);
    assert.deepEqual(tool.annotations, {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false});
    for (const field of ['fileWrite', 'externalIO', 'localProcess', 'paidGeneration']) assert.equal(definition.effects[field], false);
    assert.equal(definition.effects.databaseWrite, true);
    const fields = operation.endsWith('.add') ? tool.inputSchema : tool.inputSchema.properties.patch;
    assert.equal(fields.additionalProperties, false);
    for (const field of fadeFields) {
      const schema = resolveSchema(tool.inputSchema, fields.properties[field]);
      assert.equal(schema.type, 'integer');
      assert.equal(schema.minimum, 0); assert.equal(schema.maximum, 18000);
      assert.ok(!fields.required?.includes(field), `${field} remains optional`);
      assert.equal(Object.hasOwn(fields.properties[field], 'default'), false, 'schema cannot normalize absent legacy fields');
    }
    const base = {projectId: randomUUID(), expectedRevision: 1, requestId: randomUUID()};
    const inputWith = fields => operation.endsWith('.add')
      ? {...base, trackId: randomUUID(), assetId: randomUUID(), startFrame: 0, durationFrames: 60, ...fields}
      : {...base, clipId: randomUUID(), patch: fields};
    for (const field of fadeFields) for (const value of [-1, 18001, 0.5, '1', null, true]) {
      const input = inputWith({[field]: value});
      const error = await cli([...operation.split('.'), '--input', JSON.stringify(input)], {}, 'VALIDATION_ERROR');
      assert.deepEqual(await mcp.call(tool.name, input, 'VALIDATION_ERROR'), error);
    }
    const unknown = inputWith({fadeInFrames: 0, fadeCurve: 'linear'});
    assert.deepEqual(await mcp.call(tool.name, unknown, 'VALIDATION_ERROR'), await cli([...operation.split('.'), '--input', JSON.stringify(unknown)], {}, 'VALIDATION_ERROR'));
    const {requestId, ...missingKey} = inputWith({fadeInFrames: 0});
    assert.deepEqual(await mcp.call(tool.name, missingKey, 'VALIDATION_ERROR'), await cli([...operation.split('.'), '--input', JSON.stringify(missingKey)], {}, 'VALIDATION_ERROR'));
  }
  for (const name of ['project_get', 'timeline_get']) assert.equal(tools.find(item => item.name === name).annotations.readOnlyHint, false, 'legacy full reads retain lazy timeline creation');
  assert.equal(tools.find(item => item.name === 'timeline_inspect').annotations.readOnlyHint, true);
});

async function backendFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-fades-transports-'));
  // Synthetic metadata only: no source files, provider keys, FFmpeg or rendering.
  const store = openStore(root), services = createServices(store, new Map());
  const projectId = (await services.call('project.create', {name: 'Fade transport parity'})).id;
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
    backend = spawn(process.execPath, [path.join(repo, 'apps/server/src/cli.ts')], {cwd: repo, env: environment({MIOON_DATA_DIR: root, PORT: String(port), MIOON_TOKEN: token}), stdio: ['ignore', 'pipe', 'pipe']});
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

// Sequential processes: one backend, one official MCP bridge and at most one CLI.
test('fades agree across real HTTP, CLI and official MCP with atomic errors, split boundaries, exact recovery and restart', {timeout: 120000}, async t => {
  const backend = await backendFixture(t), {projectId, assets} = backend;
  const env = {MIOON_BASE_URL: backend.url, MIOON_TOKEN: token}, mcp = await mcpFixture(t, env);
  const command = (name, input, error, flags = []) => cli([...name.split('.'), '--input', JSON.stringify(input), ...flags], env, error);
  const transports = [{name: 'HTTP', call: backend.http}, {name: 'CLI', call: command}, {name: 'MCP', call: (name, input, error) => mcp.call(toolName(name), input, error)}];
  async function parity(operation, input, error) {
    const results = [];
    for (const {call} of transports) results.push(await call(operation, input, error));
    const comparable = result => {
      if (operation !== 'timeline.clip.add' || !error || !result.details?.clipId) return result;
      // Failed adds allocate an ID inside a rolled-back transaction. Compare
      // the stable error contract, not fresh IDs for clips that never exist.
      assert.match(result.details.clipId, /^[a-f0-9-]{36}$/);
      return {...result, details: {...result.details, clipId: '<uncommitted-clip-id>'}};
    };
    for (const result of results.slice(1)) {
      if (error) assertClientRecoveryError(comparable(result), comparable(results[0]), {operation, input});
      else assert.deepEqual(result, results[0], `${operation} result transport parity`);
    }
    return results[0];
  }
  const saved = [];
  const remember = (operation, input, response) => { saved.push({operation, input, response}); return response; };
  let timeline = await parity('timeline.get', {projectId});
  const videoTrack = timeline.tracks.find(track => track.kind === 'video').id, audioTrack = timeline.tracks.find(track => track.kind === 'audio').id;
  const legacyInput = request(projectId, timeline, {trackId: videoTrack, assetId: assets.video, startFrame: 0, durationFrames: 30});
  timeline = remember('timeline.clip.add', legacyInput, await parity('timeline.clip.add', legacyInput));
  const legacyId = timeline.clips[0].id;
  const legacyUpdate = request(projectId, timeline, {clipId: legacyId, patch: {gain: 0.5}});
  timeline = remember('timeline.clip.update', legacyUpdate, await command('timeline.clip.update', legacyUpdate));
  for (const field of fadeFields) assert.equal(Object.hasOwn(timeline.clips[0], field), false, 'unrelated legacy edits preserve absent fade keys');

  const add = request(projectId, timeline, {trackId: videoTrack, assetId: assets.video, startFrame: 60, sourceInFrame: 9, durationFrames: 120, fadeInFrames: 12, fadeOutFrames: 18, gain: 0.75});
  const concurrent = await Promise.all(transports.map(({call}) => call('timeline.clip.add', add)));
  concurrent.forEach(result => assert.deepEqual(result, concurrent[0]));
  timeline = remember('timeline.clip.add', add, concurrent[0]);
  const clipId = timeline.clips.find(clip => clip.startFrame === 60).id;
  assert.equal(timeline.revision, add.expectedRevision + 1);
  assert.equal(backend.storage().timeline_requests.filter(row => row.requestId === add.requestId).length, 1);

  const addAudio = request(projectId, timeline, {trackId: audioTrack, assetId: assets.audio, startFrame: 0, durationFrames: 120, fadeInFrames: 12});
  const {requestId: audioKey, ...audioWithoutKey} = addAudio;
  timeline = remember('timeline.clip.add', addAudio, await command('timeline.clip.add', audioWithoutKey, undefined, ['--request-id', audioKey]));
  const audioId = timeline.clips.find(clip => clip.assetId === assets.audio).id;
  const beforeUpdate = timeline, update = request(projectId, timeline, {clipId, patch: {fadeInFrames: 15, fadeOutFrames: 21, gain: 0.6}});
  timeline = remember('timeline.clip.update', update, await mcp.call('timeline_clip_update', update));
  assert.equal(timeline.clips.find(clip => clip.id === clipId).fadeOutFrames, 21);
  const afterUpdate = timeline;
  timeline = await command('timeline.undo', request(projectId, timeline));
  assert.deepEqual(editable(timeline), editable(beforeUpdate));
  timeline = await mcp.call('timeline_redo', request(projectId, timeline));
  assert.deepEqual(editable(timeline), editable(afterUpdate));

  const invalid = [
    ['timeline.clip.update', request(projectId, timeline, {clipId, patch: {fadeInFrames: 121}}), 'INVALID_FADE'],
    ['timeline.clip.update', request(projectId, timeline, {clipId, patch: {fadeInFrames: 100}}), 'INVALID_FADE'],
    ['timeline.clip.update', request(projectId, timeline, {clipId, patch: {durationFrames: 35}}), 'INVALID_FADE'],
    ...fadeFields.flatMap(field => [-1, 18001, 0.5, '3', null, true].map(value => ['timeline.clip.update', request(projectId, timeline, {clipId, patch: {[field]: value}}), 'VALIDATION_ERROR'])),
    ['timeline.clip.update', request(projectId, timeline, {clipId, patch: {fadeInFrames: 0, fadeCurve: 'linear'}}), 'VALIDATION_ERROR'],
    ...['image', 'silent', 'unknown'].map(name => ['timeline.clip.add', request(projectId, timeline, {trackId: videoTrack, assetId: assets[name], startFrame: 300, durationFrames: 30, fadeInFrames: 1}), 'FADE_AUDIO_UNSUPPORTED']),
    ['timeline.clip.add', request(projectId, timeline, {trackId: videoTrack, assetId: assets.video, startFrame: 300, durationFrames: 30, fadeInFrames: 20, fadeOutFrames: 11}), 'INVALID_FADE'],
    ['timeline.clip.split', request(projectId, timeline, {clipId, atFrame: 74}), 'SPLIT_FADE_BOUNDS'],
    ['timeline.clip.split', request(projectId, timeline, {clipId, atFrame: 160}), 'SPLIT_FADE_BOUNDS'],
    ['timeline.clip.add', {...add, fadeInFrames: 13}, 'IDEMPOTENCY_CONFLICT'],
    ['timeline.clip.update', {...update, patch: {...update.patch, fadeOutFrames: 22}}, 'IDEMPOTENCY_CONFLICT'],
    ['timeline.clip.update', {...update, requestId: randomUUID()}, 'REVISION_CONFLICT'],
  ];
  const beforeErrors = backend.storage(), beforeErrorsVersion = backend.version();
  for (const [operation, input, code] of invalid) {
    const error = await parity(operation, input, code);
    if (code === 'REVISION_CONFLICT') assert.deepEqual(error.details.current, timeline);
  }
  assert.deepEqual(backend.storage(), beforeErrors, 'rejected fade writes change no table or saved response bytes');
  assert.equal(backend.version(), beforeErrorsVersion, 'errors do not commit even equal-valued writes');
  const retryInvalid = invalid[0][1];
  const corrected = {...retryInvalid, patch: {fadeInFrames: 15}};
  timeline = remember('timeline.clip.update', corrected, await parity('timeline.clip.update', corrected));

  const beforeSplit = timeline, split = request(projectId, timeline, {clipId, atFrame: 75});
  timeline = remember('timeline.clip.split', split, await parity('timeline.clip.split', split));
  const left = timeline.clips.find(clip => clip.id === clipId), right = timeline.clips.find(clip => clip.startFrame === 75);
  assert.equal(left.fadeInFrames, 15); assert.equal(left.fadeOutFrames, 0); assert.equal(left.durationFrames, 15);
  assert.equal(right.fadeInFrames, 0); assert.equal(right.fadeOutFrames, 21); assert.equal(right.sourceInFrame, 24);
  assert.equal(left.gain, 0.6); assert.equal(right.gain, 0.6);
  const afterSplit = timeline;
  timeline = await command('timeline.undo', request(projectId, timeline));
  assert.deepEqual(editable(timeline), editable(beforeSplit));
  const redoBranch = backend.storage(), redoVersion = backend.version();
  await parity('timeline.clip.split', request(projectId, timeline, {clipId, atFrame: 74}), 'SPLIT_FADE_BOUNDS');
  assert.deepEqual(backend.storage(), redoBranch, 'rejection preserves the redo branch'); assert.equal(backend.version(), redoVersion);
  timeline = await mcp.call('timeline_redo', request(projectId, timeline));
  assert.deepEqual(editable(timeline), editable(afterSplit));
  const splitOut = request(projectId, timeline, {clipId: right.id, atFrame: 159});
  timeline = remember('timeline.clip.split', splitOut, await parity('timeline.clip.split', splitOut));
  assert.equal(timeline.clips.find(clip => clip.id === right.id).fadeOutFrames, 0);
  assert.equal(timeline.clips.find(clip => clip.startFrame === 159).fadeOutFrames, 21);
  assert.equal(timeline.durationFrames, beforeSplit.durationFrames);

  for (const [id, atFrame] of [[legacyId, 10], [audioId, 12]]) {
    const input = request(projectId, timeline, {clipId: id, atFrame});
    timeline = remember('timeline.clip.split', input, await parity('timeline.clip.split', input));
  }
  for (const clip of timeline.clips.filter(clip => clip.trackId === videoTrack && clip.startFrame < 30)) {
    for (const field of fadeFields) assert.equal(Object.hasOwn(clip, field), false, 'legacy split does not manufacture fade keys');
  }
  for (const clip of timeline.clips.filter(clip => clip.assetId === assets.audio)) {
    assert.equal(clip.fadeInFrames, clip.id === audioId ? 12 : 0);
    assert.equal(Object.hasOwn(clip, 'fadeOutFrames'), false, 'one-sided fade split preserves the absent other field');
  }

  const beforeInspect = backend.storage(), inspectVersion = backend.version();
  const inspected = await parity('timeline.inspect', {projectId});
  keys(inspected, ['id', 'revision', 'fps', 'width', 'height', 'durationFrames', 'tracks', 'clips']);
  for (const clip of inspected.clips) keys(clip, ['id', 'trackId', 'assetId', 'name', 'startFrame', 'durationFrames', 'sourceInFrame', 'rect', 'gain']);
  assert.deepEqual(backend.storage(), beforeInspect); assert.equal(backend.version(), inspectVersion);

  let dropResponse = true, sent = 0, committed;
  const client = createClient({env, fetchImpl: async (...args) => {
    sent++; const response = await fetch(...args);
    if (dropResponse) { dropResponse = false; committed = (await response.json()).data; throw Error('Synthetic response lost after fade commit'); }
    return response;
  }});
  const uncertain = request(projectId, timeline, {clipId, patch: {fadeInFrames: 0, fadeOutFrames: 0}});
  await assert.rejects(client.rpc('timeline.clip.update', uncertain), error => error.code === 'BACKEND_UNAVAILABLE' && error.details.requestId === uncertain.requestId && error.details.submissionMayHaveSucceeded === true);
  assert.equal(sent, 1, 'an uncertain mutation is never automatically retried');
  timeline = await backend.http('timeline.get', {projectId}); assert.deepEqual(timeline, committed);
  assert.deepEqual(await client.rpc('timeline.clip.update', uncertain), committed); assert.equal(sent, 2);
  remember('timeline.clip.update', uncertain, committed);
  assert.equal(timeline.clips.find(clip => clip.id === clipId).fadeInFrames, 0, 'explicit zero is persisted');
  const later = request(projectId, timeline, {clipId, patch: {name: 'Later edit after recovered fades'}});
  timeline = await command('timeline.clip.update', later);
  const persisted = backend.storage(), pid = backend.pid;
  await backend.restart(); assert.notEqual(backend.pid, pid);
  for (const {name, call} of transports) {
    assert.deepEqual(await call('timeline.get', {projectId}), timeline, `${name} sees the restarted current timeline`);
    for (const record of saved) assert.deepEqual(await call(record.operation, record.input), record.response, `${name} returns exact historical fade results after restart`);
    assert.deepEqual((await call('project.get', {projectId})).timeline, timeline);
  }
  assert.deepEqual(backend.storage(), persisted, 'restart and exact replay preserve all saved rows and legacy absence');
  assert.equal(persisted.jobs.length, 0); assert.equal(persisted.exports.length, 0, 'transport acceptance never starts providers or render workers');
});
