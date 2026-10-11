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

const repo = fileURLToPath(new URL('..', import.meta.url));
const token = 'timeline-replacement-transports-synthetic-token';
const operation = 'timeline.clip.replaceSource', toolName = 'timeline_clip_replaceSource';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const editable = timeline => ({tracks: timeline.tracks, clips: timeline.clips, durationFrames: timeline.durationFrames});
const request = (projectId, timeline, fields = {}) => ({projectId, expectedRevision: timeline.revision, requestId: randomUUID(), ...fields});

function environment(extra = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(?:MIOON_|RUNWAY|ARK_|VEO_|GOOGLE_|MINIMAX_|VIDU_|OPENAI_|ANTHROPIC_|AZURE_|AWS_|NODE_OPTIONS$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key)) delete env[key];
  return {...env, MIOON_ENABLE_LIVE_PROVIDER: '0', RUNWAY_MAX_GENERATIONS: '0', ...extra};
}

async function cli(args, env = {}, expectedError) {
  const child = spawn(process.execPath, [path.join(repo, 'apps/cli/src/index.mjs'), ...args], {cwd: repo, env: environment(env), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', bytes => stdout += bytes); child.stderr.setEncoding('utf8').on('data', bytes => stderr += bytes);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  let code, signal;
  try { [code, signal] = await once(child, 'close'); } finally { clearTimeout(timeout); }
  assert.equal(signal, null, stderr);
  assert.equal(stdout.trim().split('\n').length, 1, 'CLI returns exactly one JSON envelope');
  const body = JSON.parse(stdout);
  assert.equal(body.ok, !expectedError, stdout + stderr);
  assert.ok(!stdout.includes(token)); assert.ok(!stderr.includes(token));
  if (expectedError) {
    assert.equal(body.error.code, expectedError, stdout);
    assert.equal(code, expectedError === 'VALIDATION_ERROR' ? 2 : errorStatus(expectedError) === 409 ? 3 : 6, stdout);
    assert.ok(stderr.trim()); return body.error;
  }
  assert.equal(code, 0, stdout + stderr); return body.data;
}

async function mcpFixture(t, env = {}) {
  const client = new Client({name: 'timeline-replacement-tests', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.mjs')], cwd: repo, env: environment(env), stderr: 'pipe'});
  transport.stderr?.resume();
  t.after(() => client.close()); await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'mioon');
  return {client, async call(name, input, expectedError) {
    const response = await client.callTool({name, arguments: input}, undefined, {timeout: 10000});
    const block = response.content.find(item => item.type === 'text'); assert.ok(block);
    const body = JSON.parse(block.text);
    assert.deepEqual(response.structuredContent, body);
    assert.equal(Boolean(response.isError), Boolean(expectedError), block.text);
    assert.equal(body.ok, !expectedError, block.text);
    if (expectedError) { assert.equal(body.error.code, expectedError); return body.error; }
    return body.data;
  }};
}

const errorStatus = code => ['SOURCE_UNCHANGED', 'INVALID_TIMELINE_SNAPSHOT'].includes(code) || code?.includes('CONFLICT') ? 409 : ['TIMELINE_SOURCE_UNAVAILABLE', 'CLIP_NOT_FOUND', 'NOT_FOUND'].includes(code) ? 404 : 400;
const resolveSchema = (root, value) => value.$ref ? resolveSchema(root, value.$ref.slice(2).split('/').reduce((node, key) => node[key], root)) : value;
const outsideTables = ['projects', 'assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports'];

// Discovery and malformed-input checks use the actual CLI and official SDK
// bridge, but no backend, provider, media bytes, probe or encoder.
test('replacement CLI and official MCP discover one strict schema with a required key and optional explicit version', {timeout: 60000}, async t => {
  const mcp = await mcpFixture(t), definition = await cli(['schema', operation]);
  const tool = (await mcp.client.listTools()).tools.find(item => item.name === toolName);
  assert.ok(tool); assert.equal(definition.operation, operation); assert.equal(definition.toolName, toolName);
  assert.equal(definition.command, 'timeline clip replaceSource'); assert.equal(definition.requiresRequestId, true);
  assert.deepEqual(tool.inputSchema, definition.inputSchema);
  assert.deepEqual(await mcp.call('mioon_schema', {operation}), definition);
  const schema = tool.inputSchema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), ['assetId', 'clipId', 'expectedRevision', 'projectId', 'requestId']);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...schema.required, 'versionId'].sort());
  for (const key of ['projectId', 'clipId', 'assetId', 'versionId']) {
    const field = resolveSchema(schema, schema.properties[key]);
    assert.equal(field.type, 'string'); assert.equal(field.format, 'uuid');
  }
  const key = resolveSchema(schema, schema.properties.requestId);
  assert.equal(key.minLength, 8); assert.equal(key.maxLength, 200);
  assert.equal(schema.properties.expectedRevision.type, 'integer'); assert.equal(schema.properties.expectedRevision.exclusiveMinimum, 0);
  assert.deepEqual(tool.annotations, {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false});
  for (const [effect, value] of Object.entries({readOnly: false, idempotent: true, destructive: true, openWorld: false, databaseWrite: true, fileWrite: false, externalIO: false, localProcess: false, paidGeneration: false})) assert.equal(definition.effects[effect], value, effect);
  const valid = {projectId: randomUUID(), clipId: randomUUID(), assetId: randomUUID(), expectedRevision: 1, requestId: randomUUID()};
  const invalid = [
    ...Object.keys(valid).map(field => Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field))),
    ...[0, -1, 1.5, '1'].map(expectedRevision => ({...valid, expectedRevision})),
    ...['', 'short', 'x'.repeat(201), 12345678].map(requestId => ({...valid, requestId})),
    ...['projectId', 'clipId', 'assetId', 'versionId'].map(field => ({...valid, [field]: 'not-a-uuid'})),
    {...valid, versionId: null}, {...valid, shotId: randomUUID()}, {...valid, patch: {assetId: randomUUID()}},
  ];
  for (const input of invalid) {
    const fromCli = await cli(['timeline', 'clip', 'replaceSource', '--input', JSON.stringify(input)], {}, 'VALIDATION_ERROR');
    assert.deepEqual(await mcp.call(toolName, input, 'VALIDATION_ERROR'), fromCli);
  }
  await cli(['timeline', 'clip', 'replaceSource', '--input', JSON.stringify(valid), '--request-id', 'different-request'], {}, 'VALIDATION_ERROR');
  const update = await cli(['schema', 'timeline.clip.update']);
  assert.equal(update.inputSchema.properties.patch.additionalProperties, false);
  for (const field of ['assetId', 'versionId', 'shotId', 'jobId']) {
    assert.ok(!Object.hasOwn(update.inputSchema.properties.patch.properties, field));
    const {assetId, ...fields} = valid, input = {...fields, patch: {[field]: randomUUID()}};
    const fromCli = await cli(['timeline', 'clip', 'update', '--input', JSON.stringify(input)], {}, 'VALIDATION_ERROR');
    assert.deepEqual(await mcp.call('timeline_clip_update', input, 'VALIDATION_ERROR'), fromCli);
  }
});

async function backendFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-replacement-transports-'));
  const store = openStore(root), services = createServices(store, new Map());
  const projectId = (await services.call('project.create', {name: 'Replacement transport parity'})).id;
  const foreignProjectId = (await services.call('project.create', {name: 'Foreign synthetic scope'})).id;
  function asset(mimeType, extra = {}) {
    const id = randomUUID();
    return store.put('assets', {id, projectId, name: `Synthetic ${mimeType}`, mimeType, duration: mimeType.startsWith('image/') ? 0 : 8, width: 720, height: 1280, hasVideo: !mimeType.startsWith('audio/'), hasAudio: !mimeType.startsWith('image/'), provenance: 'user-import', sizeBytes: 128, sha256: 'a'.repeat(64), relativePath: `media/${id}.fixture`, url: `/media/${id}`, createdAt: '2026-10-10T00:00:00.000Z', ...extra});
  }
  const assets = {
    video: asset('video/mp4'), replacement: asset('video/webm'), generated: asset('video/mp4', {provenance: 'synthetic-mock'}),
    laterGenerated: asset('video/mp4', {provenance: 'synthetic-mock'}), short: asset('video/mp4', {duration: 2}),
    silent: asset('video/mp4', {hasAudio: false}), audio: asset('audio/wav'), otherAudio: asset('audio/mpeg'),
    image: asset('image/png'), otherImage: asset('image/jpeg'), foreign: asset('video/mp4', {projectId: foreignProjectId}),
  };
  const shot = await services.call('shot.create', {projectId, title: 'Synthetic immutable versions'});
  const foreignShot = await services.call('shot.create', {projectId: foreignProjectId, title: 'Foreign versions'});
  function version(shot, asset, number) {
    const jobId = randomUUID(), id = randomUUID();
    store.put('jobs', {id: jobId, projectId: shot.projectId, shotId: shot.id, status: 'succeeded', providerId: 'mock', requestId: randomUUID(), revision: 1, submissionCount: 1, versionId: id});
    return store.put('versions', {id, projectId: shot.projectId, shotId: shot.id, jobId, number, providerId: 'mock', assetId: asset.id, sha256: asset.sha256, url: asset.url});
  }
  const versions = {generated: version(shot, assets.generated, 1), later: version(shot, assets.laterGenerated, 2), foreign: version(foreignShot, assets.foreign, 1)};
  // Synthetic metadata only; every timeline mutation below uses real transports.
  // Succeeded jobs cannot trigger provider work and no media files are needed.
  store.close();
  let backend, url, port = 0;
  async function stop() {
    if (!backend || backend.exitCode !== null || backend.signalCode) return;
    const child = backend, ended = once(child, 'exit'); child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { await ended; } finally { clearTimeout(timeout); }
  }
  t.after(async () => { await stop(); await rm(root, {recursive: true, force: true}); });
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
  return {root, url, projectId, foreignProjectId, assets, shot, versions, get pid() { return backend.pid; }, restart: async (editFixture) => {
      await stop();
      if (editFixture) {
        const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
        try { editFixture(db); } finally { db.close(); }
      }
      await start();
    },
    async http(name, input, expectedError) {
      const response = await fetch(url + '/api/rpc', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({operation: name, input})});
      const body = await response.json();
      assert.equal(response.status, expectedError ? errorStatus(expectedError) : 200, JSON.stringify(body));
      assert.equal(body.ok, !expectedError, JSON.stringify(body));
      if (expectedError) { assert.equal(body.error.code, expectedError); return body.error; } return body.data;
    },
    storage(tables = ['timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests']) {
      const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
      try { return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
      finally { db.close(); }
    },
  };
}

function assertReplacement(before, after, clipId, assetId, version) {
  const original = before.clips.find(clip => clip.id === clipId), expected = {...original, assetId};
  for (const field of ['versionId', 'shotId', 'jobId']) delete expected[field];
  if (version) Object.assign(expected, {versionId: version.id, shotId: version.shotId});
  assert.deepEqual(after.clips.find(clip => clip.id === clipId), expected, 'every editable field and its exact presence are preserved');
  assert.deepEqual(after.clips.filter(clip => clip.id !== clipId), before.clips.filter(clip => clip.id !== clipId), 'neighbors and gaps never move');
  assert.deepEqual(after.tracks, before.tracks); assert.equal(after.durationFrames, before.durationFrames);
  assert.equal(after.revision, before.revision + 1); assert.equal(after.id, before.id);
}

test('replacement HTTP, CLI and official MCP preserve fixed sources, exact replay, history, errors and restart', {timeout: 120000}, async t => {
  const backend = await backendFixture(t), {projectId, assets, shot, versions} = backend;
  const env = {MIOON_BASE_URL: backend.url, MIOON_TOKEN: token}, mcp = await mcpFixture(t, env);
  const command = (name, input, error, flags = []) => cli([...name.split('.'), '--input', JSON.stringify(input), ...flags], env, error);
  const transports = [
    {name: 'HTTP', call: backend.http},
    {name: 'CLI', call: command},
    {name: 'MCP', call: (name, input, error) => mcp.call(name.replaceAll('.', '_'), input, error)},
  ];
  let timeline = await backend.http('timeline.get', {projectId});
  timeline = await backend.http('timeline.clip.add', request(projectId, timeline, {trackId: timeline.tracks[0].id, assetId: assets.video.id, startFrame: 20, sourceInFrame: 17, durationFrames: 80, gain: 0.5, rect: {x: 100, y: 200, width: 400, height: 600}, name: 'Trimmed fixed clip', fadeInFrames: 10, fadeOutFrames: 15}));
  const clipId = timeline.clips[0].id;
  timeline = await command('timeline.clip.add', request(projectId, timeline, {trackId: timeline.tracks[0].id, assetId: assets.image.id, startFrame: 120, durationFrames: 45, name: 'Unmoved image with omitted fades'}));
  const imageClipId = timeline.clips[1].id;
  timeline = await mcp.call('timeline_clip_add', request(projectId, timeline, {trackId: timeline.tracks[2].id, assetId: assets.audio.id, startFrame: 10, sourceInFrame: 20, durationFrames: 100, fadeInFrames: 0, gain: 0.75}));
  const audioClipId = timeline.clips[2].id, initial = timeline, saved = [];
  const firstInput = request(projectId, timeline, {clipId, assetId: assets.replacement.id});
  let outside = backend.storage(outsideTables);
  const concurrent = await Promise.all(transports.map(({call}) => call(operation, firstInput)));
  concurrent.forEach(result => assert.deepEqual(result, concurrent[0]));
  timeline = concurrent[0]; saved.push({input: firstInput, response: timeline});
  assertReplacement(initial, timeline, clipId, assets.replacement.id);
  assert.deepEqual(backend.storage(outsideTables), outside);
  assert.equal((await backend.http('timeline.history.get', {projectId})).length, 4, 'three adds and one replacement; repeated calls add no history');
  const undo = await command('timeline.undo', request(projectId, timeline));
  assert.deepEqual(editable(undo), editable(initial));
  timeline = await mcp.call('timeline_redo', request(projectId, undo));
  assert.deepEqual(editable(timeline), editable(saved[0].response));

  // Exercise a distinct accepted replacement from each real transport.
  let before = timeline;
  const explicitInput = request(projectId, timeline, {clipId, assetId: assets.generated.id, versionId: versions.generated.id});
  const {requestId, ...withoutRequestId} = explicitInput;
  timeline = await command(operation, withoutRequestId, undefined, ['--request-id', requestId]);
  assertReplacement(before, timeline, clipId, assets.generated.id, versions.generated);
  saved.push({input: explicitInput, response: timeline});
  assert.deepEqual(backend.storage(outsideTables), outside);

  // Local canvas replay keys and timeline replay keys are separate namespaces.
  // Reusing this string for selection is allowed, but never repoints the clip.
  let selected = await command('version.select', {shotId: shot.id, versionId: versions.later.id, expectedRevision: shot.revision, requestId: firstInput.requestId});
  assert.deepEqual(await backend.http('timeline.get', {projectId}), timeline);
  assert.equal(timeline.clips.find(clip => clip.id === clipId).versionId, versions.generated.id);
  outside = backend.storage(outsideTables); before = timeline;
  const assetOnlyInput = request(projectId, timeline, {clipId, assetId: assets.laterGenerated.id});
  timeline = await mcp.call(toolName, assetOnlyInput);
  assertReplacement(before, timeline, clipId, assets.laterGenerated.id);
  saved.push({input: assetOnlyInput, response: timeline});
  assert.deepEqual(backend.storage(outsideTables), outside);
  selected = await mcp.call('version_select', {shotId: shot.id, versionId: versions.generated.id, expectedRevision: selected.revision, requestId: randomUUID()});
  assert.deepEqual(await backend.http('timeline.get', {projectId}), timeline, 'later selection cannot move asset-only generated clips either');
  outside = backend.storage(outsideTables);

  for (const [call, id, asset] of [[backend.http, imageClipId, assets.otherImage], [command, audioClipId, assets.otherAudio]]) {
    before = timeline;
    const input = request(projectId, timeline, {clipId: id, assetId: asset.id});
    timeline = await call(operation, input); assertReplacement(before, timeline, id, asset.id);
    saved.push({input, response: timeline});
  }
  assert.deepEqual(backend.storage(outsideTables), outside);
  const cases = [
    [request(projectId, timeline, {clipId, assetId: assets.laterGenerated.id}), 'SOURCE_UNCHANGED'],
    [request(projectId, timeline, {clipId, assetId: assets.laterGenerated.id, versionId: versions.later.id}), 'SOURCE_UNCHANGED'],
    [request(projectId, timeline, {clipId, assetId: assets.short.id}), 'SOURCE_BOUNDS'],
    [request(projectId, timeline, {clipId, assetId: assets.image.id}), 'INVALID_CLIP_TYPE'],
    [request(projectId, timeline, {clipId: imageClipId, assetId: assets.video.id}), 'INVALID_CLIP_TYPE'],
    [request(projectId, timeline, {clipId: audioClipId, assetId: assets.video.id}), 'INVALID_CLIP_TYPE'],
    [request(projectId, timeline, {clipId, assetId: assets.silent.id}), 'FADE_AUDIO_UNSUPPORTED'],
    [request(projectId, timeline, {clipId, assetId: assets.foreign.id}), 'TIMELINE_SOURCE_UNAVAILABLE'],
    [request(projectId, timeline, {clipId, assetId: randomUUID()}), 'TIMELINE_SOURCE_UNAVAILABLE'],
    [request(projectId, timeline, {clipId, assetId: assets.generated.id, versionId: versions.later.id}), 'TIMELINE_SOURCE_UNAVAILABLE'],
    [request(projectId, timeline, {clipId, assetId: assets.generated.id, versionId: versions.foreign.id}), 'TIMELINE_SOURCE_UNAVAILABLE'],
    [request(projectId, timeline, {clipId: randomUUID(), assetId: assets.video.id}), 'CLIP_NOT_FOUND'],
    [request(projectId, timeline, {clipId, assetId: assets.video.id, extra: true}), 'VALIDATION_ERROR'],
    [{...firstInput, assetId: assets.generated.id}, 'IDEMPOTENCY_CONFLICT'],
    [{...explicitInput, versionId: undefined}, 'IDEMPOTENCY_CONFLICT'],
    [{...firstInput, projectId: backend.foreignProjectId}, 'IDEMPOTENCY_CONFLICT'],
    [{...firstInput, requestId: randomUUID()}, 'REVISION_CONFLICT'],
  ];
  const beforeErrors = backend.storage(), outsideErrors = backend.storage(outsideTables);
  for (const [input, code] of cases) {
    const errors = [];
    for (const {call} of transports) errors.push(await call(operation, input, code));
    errors.slice(1).forEach(error => assertClientRecoveryError(error, errors[0], {operation, input}));
    if (code === 'REVISION_CONFLICT') assert.deepEqual(errors[0].details.current, timeline);
    if (code === 'TIMELINE_SOURCE_UNAVAILABLE') assert.deepEqual(errors[0].details, {});
    if (['SOURCE_UNCHANGED', 'SOURCE_BOUNDS', 'INVALID_CLIP_TYPE', 'FADE_AUDIO_UNSUPPORTED', 'REVISION_CONFLICT'].includes(code)) {
      assert.equal(errors[0].details.mutationOutcome, 'not_applied');
      assert.equal(errors[0].details.requestId, input.requestId, 'fresh rejection proof is bound to the exact attempted key');
    }
    if (['TIMELINE_SOURCE_UNAVAILABLE', 'CLIP_NOT_FOUND', 'IDEMPOTENCY_CONFLICT', 'VALIDATION_ERROR'].includes(code)) assert.ok(!Object.hasOwn(errors[0].details, 'mutationOutcome'), 'scope/receipt/schema errors are never fresh-key rollback proof');
  }
  for (const {call} of transports) {
    await call('timeline.clip.update', request(projectId, timeline, {clipId, patch: {assetId: assets.video.id}}), 'VALIDATION_ERROR');
    await call('timeline.undo', {...firstInput, clipId: undefined, assetId: undefined}, 'IDEMPOTENCY_CONFLICT');
  }
  assert.deepEqual(backend.storage(), beforeErrors);
  assert.deepEqual(backend.storage(outsideTables), outsideErrors);

  let dropResponse = true, sent = 0, committed;
  const client = createClient({env, fetchImpl: async (...args) => {
    sent++; const response = await fetch(...args);
    if (dropResponse) { dropResponse = false; committed = (await response.json()).data; throw Error('Synthetic replacement response lost after commit'); }
    return response;
  }});
  const uncertainInput = request(projectId, timeline, {clipId, assetId: assets.generated.id, versionId: versions.generated.id});
  before = timeline;
  await assert.rejects(client.rpc(operation, uncertainInput), error => error.code === 'BACKEND_UNAVAILABLE' && error.details.requestId === uncertainInput.requestId && error.details.submissionMayHaveSucceeded === true);
  assert.equal(sent, 1, 'uncertain replacement is never automatically reissued');
  timeline = await backend.http('timeline.get', {projectId}); assert.deepEqual(timeline, committed);
  assertReplacement(before, timeline, clipId, assets.generated.id, versions.generated);
  assert.deepEqual(await client.rpc(operation, uncertainInput), committed); assert.equal(sent, 2);
  saved.push({input: uncertainInput, response: committed});
  for (const {call} of transports) assert.deepEqual(await call(operation, uncertainInput), committed);
  const persisted = backend.storage(), persistedOutside = backend.storage(outsideTables), pid = backend.pid;
  await backend.restart(); assert.notEqual(backend.pid, pid);
  for (const {name, call} of transports) {
    assert.deepEqual(await call('timeline.get', {projectId}), timeline, `${name} observes the same restarted timeline`);
    for (const record of saved) assert.deepEqual(await call(operation, record.input), record.response, `${name} replays each historical replacement exactly`);
    assert.deepEqual((await call('project.get', {projectId})).timeline, timeline);
  }
  assert.deepEqual(backend.storage(), persisted, 'restart/replay never rewrites timeline, history, cursor or immutable response bytes');
  assert.deepEqual(backend.storage(outsideTables), persistedOutside, 'restart/replay cannot alter generation, versions, source assets or exports');
  for (const {input} of saved) assert.equal(persisted.timeline_requests.filter(row => row.requestId === input.requestId).length, 1);

  // A later definite 4xx is not proof that an earlier lost-ack mutation failed.
  // Corrupt only this disposable stopped fixture, never an active backend DB.
  const receipt = persisted.timeline_requests.find(row => row.requestId === uncertainInput.requestId);
  const installReceipt = (db, text) => {
    db.prepare('DELETE FROM timeline_requests WHERE requestId=?').run(receipt.requestId);
    db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run(receipt.requestId, receipt.requestHash, text);
  };
  await backend.restart(db => {
    const malformed = JSON.parse(receipt.response);
    malformed.clips.find(clip => clip.id === clipId).assetId = assets.video.id;
    installReceipt(db, JSON.stringify(malformed));
  });
  let deniedState = backend.storage();
  let deniedBackendError;
  for (const {name, call} of transports) {
    const error = await call(operation, uncertainInput, 'INVALID_TIMELINE_SNAPSHOT');
    assert.ok(!Object.hasOwn(error.details, 'mutationOutcome'), 'corrupt prior receipt cannot produce not-applied proof');
    if (name === 'HTTP') deniedBackendError = error;
    else assertClientRecoveryError(error, deniedBackendError, {operation, input: uncertainInput});
  }
  assert.deepEqual(backend.storage(), deniedState);
  await backend.restart(db => {
    installReceipt(db, receipt.response);
    db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(backend.foreignProjectId, assets.generated.id);
  });
  deniedState = backend.storage();
  const deniedOutside = backend.storage(outsideTables);
  for (const {name, call} of transports) {
    const error = await call(operation, uncertainInput, 'TIMELINE_SOURCE_UNAVAILABLE');
    if (name === 'HTTP') {
      assert.deepEqual(error.details, {}, 'ownership failure after a committed lost response cannot release its original request');
      deniedBackendError = error;
    } else assertClientRecoveryError(error, deniedBackendError, {operation, input: uncertainInput});
  }
  assert.deepEqual(backend.storage(), deniedState);
  assert.deepEqual(backend.storage(outsideTables), deniedOutside);
});
