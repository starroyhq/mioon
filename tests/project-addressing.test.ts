import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {schemas} from '@mioon/client';
import {APP_LEVEL_OPERATIONS, ENTITY_ADDRESSED_OPERATIONS, inputProjectId, isAppLevelOperation, isEntityAddressedOperation, rpcPathFor} from '../packages/contracts/src/project-addressing.ts';
import {parseProjectApiPath, projectApiPath, projectMediaPath, projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {jsonSchema, operationDefinition, splitProjectAddress} from '../packages/client/src/index.ts';
import {assertProjectRpc, projectHandlerTarget} from '../apps/server/src/project-host/request.ts';
import {startServer} from '../apps/server/src/index.ts';
import {localRecordSchemas, localRecordEffects, localRecordsListResponseSchema, localRecordsDeleteResponseSchema, isLocalRecordResponse} from '../packages/contracts/src/local-record-operations.ts';
import {schemas as modelSchemas} from '../packages/contracts/src/index.ts';

const TOKEN = 'synthetic-project-addressing-token';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PREVIS_OUTPUT_OPERATIONS = ['previs.output.publish', 'previs.output.lookup'] as const;
type Json = Record<string, unknown>;
const sharedSchema = (operation: string): Parameters<typeof jsonSchema>[0] =>
  (schemas as unknown as Record<string, Parameters<typeof jsonSchema>[0]>)[operation];
interface Reply {status: number; body: Json & {ok?: boolean; data?: unknown; error?: {code?: string; details?: unknown}}}
const requires = (schema: unknown, field: string): boolean => {
  if (!schema || typeof schema !== 'object') return false;
  const node = schema as Json;
  if (Array.isArray(node.required) && node.required.includes(field)) return true;
  const branches = node.anyOf ?? node.oneOf;
  return Array.isArray(branches) && branches.length > 0 && branches.every(branch => requires(branch, field));
};

test('every operation has exactly one address: app-level, entity-addressed, or the project its input names', () => {
  const operations = Object.keys(schemas);
  assert.equal(operations.length, 154); // Retire only public project.notes.set.
  assert.equal(operations.includes('project.notes.set'), false);
  for (const operation of PREVIS_OUTPUT_OPERATIONS) {
    assert.ok(Object.hasOwn(schemas, operation), operation);
    assert.equal(isAppLevelOperation(operation), false, operation);
    assert.equal(isEntityAddressedOperation(operation), false, operation);
  }
  for (const operation of [...APP_LEVEL_OPERATIONS, ...ENTITY_ADDRESSED_OPERATIONS]) assert.ok(Object.hasOwn(schemas, operation), operation);
  assert.equal(APP_LEVEL_OPERATIONS.length, 17);
  assert.equal(ENTITY_ADDRESSED_OPERATIONS.length, 11);
  for (const operation of operations) {
    const shared = jsonSchema(sharedSchema(operation)) as Json & {properties?: Json};
    const own = operation === 'image.review.prepare' ? requires((shared.properties ?? {}).input, 'projectId') : requires(shared, 'projectId');
    const classes = [isAppLevelOperation(operation), isEntityAddressedOperation(operation), !isAppLevelOperation(operation) && !isEntityAddressedOperation(operation)];
    assert.equal(classes.filter(Boolean).length, 1, operation);
    if (isEntityAddressedOperation(operation)) assert.equal(Object.hasOwn(shared.properties ?? {}, 'projectId'), false, operation);
    else if (!isAppLevelOperation(operation)) assert.ok(own, `${operation} must name its project in its input`);
  }
  // Renaming and deleting change the registry, so they stay app-level.
  for (const operation of ['project.delete', 'project.rename', 'project.list', 'project.create']) assert.equal(rpcPathFor(operation, {projectId: randomUUID()}), '/api/rpc');
});

test('rpcPathFor and the CLI/MCP project address', () => {
  const projectId = randomUUID(), other = randomUUID();
  assert.equal(rpcPathFor('project.get', {projectId}), projectRpcPath(projectId));
  assert.equal(rpcPathFor('project.get', {projectId}, other), projectRpcPath(projectId), 'only entity-addressed operations take the extra project');
  assert.equal(rpcPathFor('image.review.prepare', {input: {projectId}, settingsRevision: 1}), projectRpcPath(projectId));
  assert.equal(inputProjectId('image.review.prepare', {input: {projectId}}), projectId);
  assert.equal(rpcPathFor('job.get', {jobId: randomUUID()}, projectId), `/api/projects/${projectId}/rpc`);
  assert.throws(() => rpcPathFor('job.get', {jobId: randomUUID()}), TypeError);
  assert.throws(() => rpcPathFor('job.get', {jobId: randomUUID()}, projectId.toUpperCase()), TypeError);
  assert.throws(() => rpcPathFor('project.get', {projectId: 'not-a-project'}), TypeError);
  assert.throws(() => rpcPathFor('project.get', {}), TypeError);
  for (const operation of ENTITY_ADDRESSED_OPERATIONS) {
    const schema = operationDefinition(operation).inputSchema as Json & {properties: Json; required: string[]};
    assert.equal(schema.required[0], 'projectId', operation);
    assert.deepEqual(Object.keys(schema.properties).filter(key => key !== 'projectId'), Object.keys((jsonSchema(sharedSchema(operation)) as {properties: Json}).properties), operation);
  }
  assert.equal(Object.hasOwn((operationDefinition('project.get').inputSchema as {properties: Json}).properties, 'projectId'), true);
  const jobId = randomUUID();
  assert.deepEqual(splitProjectAddress('job.get', {projectId, jobId}), {input: {jobId}, projectId});
  assert.deepEqual(splitProjectAddress('job.get', {jobId}), {input: {jobId}});
  assert.deepEqual(splitProjectAddress('project.get', {projectId}), {input: {projectId}}, 'an input that names its project is left whole');
  for (const operation of PREVIS_OUTPUT_OPERATIONS) {
    const input = {projectId};
    assert.equal(inputProjectId(operation, input), projectId, operation);
    assert.equal(rpcPathFor(operation, input, other), projectRpcPath(projectId), operation);
    assert.deepEqual(splitProjectAddress(operation, input), {input}, operation);
    assert.throws(() => rpcPathFor(operation, {}), TypeError, operation);
  }
  assert.throws(() => splitProjectAddress('job.get', {projectId: 'x', jobId}), {code: 'VALIDATION_ERROR'});
});

test('local records have strict application-only contracts and truthful file effects without public/model discovery', () => {
  const projectId = randomUUID(), appLibraryScope = 'a'.repeat(64), instanceId = randomUUID();
  const input = {projectId, expectedAppLibraryScope: appLibraryScope, expectedInstanceId: instanceId};
  for (const operation of Object.keys(localRecordSchemas) as (keyof typeof localRecordSchemas)[]) {
    assert.equal(isAppLevelOperation(operation), true); assert.equal(rpcPathFor(operation, input), '/api/rpc');
    assert.equal(inputProjectId(operation, input), undefined);
    assert.equal(Object.hasOwn(schemas, operation), false); assert.equal(Object.hasOwn(modelSchemas, operation), false);
    assert.equal(localRecordEffects[operation].fileWrite, true); assert.equal(localRecordEffects[operation].databaseWrite, false);
    assert.equal(localRecordEffects[operation].paidGeneration, false); assert.equal(localRecordEffects[operation].readOnly, false);
  }
  assert.equal(localRecordEffects['local.records.list'].idempotent, true);
  assert.equal(localRecordEffects['local.records.delete'].idempotent, false);
  for (const invalid of [null, false, [], {path: '/private/records'}, {projectId}]) assert.equal(localRecordSchemas['local.records.list'].safeParse(invalid).success, false);
  for (const invalid of [{projectId}, {...input, path: '/private/records'}, {...input, expectedInstanceId: 'old'}, {...input, expectedAppLibraryScope: 'A'.repeat(64)}, {...input, projectId: projectId.toUpperCase()}]) {
    assert.equal(localRecordSchemas['local.records.delete'].safeParse(invalid).success, false);
  }
  const record = {projectId, name: null, projectFile: null, sizeBytes: 0, hasSuperJournal: true, hasUnfinishedTasks: true,automaticBackups:{count:0,sizeBytes:0}};
  const list = {version: 1, appLibraryScope, instanceId, records: [record]};
  assert.equal(localRecordsListResponseSchema.safeParse(list).success, true);
  assert.equal(localRecordsListResponseSchema.safeParse({...list, records: [record, record]}).success, false);
  assert.equal(localRecordsListResponseSchema.safeParse({...list, records: [{...record, hasUnfinishedTasks: undefined}]}).success, false);
  for(const automaticBackups of [undefined,null,{count:-1,sizeBytes:0},{count:1.5,sizeBytes:0},{count:1,sizeBytes:-1},
    {count:1,sizeBytes:Number.MAX_SAFE_INTEGER+1},{count:Number.MAX_SAFE_INTEGER+1,sizeBytes:1},{count:1,sizeBytes:0,path:'/private/backup'}]) {
    assert.equal(localRecordsListResponseSchema.safeParse({...list,records:[{...record,automaticBackups}]}).success,false);
  }
  const result = {projectId, deleted: true, appLibraryScope, instanceId};
  assert.equal(localRecordsDeleteResponseSchema.safeParse(result).success, true);
  assert.equal(isLocalRecordResponse('local.records.delete', input, result), true);
  assert.equal(isLocalRecordResponse('local.records.delete', input, {...result, instanceId: randomUUID()}), false);
  assert.equal(isLocalRecordResponse('local.records.delete', input, {...result, projectId: randomUUID()}), false);
});

test('project routes map to the paths they replace; app-level and unknown routes do not', () => {
  const id = randomUUID(), run = randomUUID(), task = randomUUID(), asset = randomUUID();
  const at = (...route: [string, ...string[]]) => projectApiPath(id, ...route);
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    [projectRpcPath(id), '/api/rpc'],
    [projectMediaPath(id, asset), `/media/${asset}`],
    [at('version-comparison', 'media'), '/api/version-comparison/media'],
    [at('timeline-audio-preview', 'pcm'), '/api/timeline-audio-preview/pcm'],
    [at('timeline-audio-preview', 'continuous'), '/api/timeline-audio-preview/continuous'],
    [at('export-files'), '/api/export-files'],
    [at('images', 'reviews', 'approve'), '/api/images/reviews/approve'],
    [at('images', 'reviews', 'reject'), '/api/images/reviews/reject'],
    [at('local-drafts'), '/api/local-drafts'],
    [at('local-drafts', 'clip'), '/api/local-drafts/clip'],
    [at('local-delivery', 'prepare'), '/api/local-delivery/prepare'],
    [at('local-shot-text', 'draft'), '/api/local-shot-text/draft'],
    [at('tasks'), '/api/tasks'],
    [at('tasks', task, 'execute'), `/api/tasks/${task}/execute`],
    [at('agent', 'tasks', 'v2'), `/api/agent/tasks/v2/${id}`],
    [at('agent', 'tasks', 'v2', run, 'events'), `/api/agent/tasks/v2/${id}/${run}/events`],
    [at('agent', 'tasks', 'v2', 'editing'), '/api/agent/tasks/v2/editing'],
    [at('agent', 'tasks', 'v2', 'conversation one', 'policy'), `/api/agent/tasks/v2/${id}/conversation%20one/policy`],
    [at('agent', 'tasks', 'v2', 'policy'), null],
    [at('agent', 'tasks', 'v2', 'policy', 'requests', task), null],
    [at('agent', 'tasks', 'v2', 'diagnostics', 'latest'), null],
    [at('agent', 'tasks', 'v2', 'editing', 'x'), null],
    [at('images', 'settings'), null],
    [at('export-files', 'x'), null],
    [at('package-preview'), null],
    [at('workspace-info'), null],
    [`/api/projects/${id}/tasks%2Fprepare`, null],
    [`/api/projects/${id}/..`, null],
    [`/api/projects/${id.toUpperCase()}/rpc`, null],
    [`/api/projects/${id}/rpc/x`, null],
    [`/api/projects/${id}/media/not-an-asset`, null],
    ['/api/rpc', null],
    [`/media/${asset}`, null],
  ];
  for (const [pathname, expected] of cases) {
    const route = parseProjectApiPath(pathname), target = route ? projectHandlerTarget(route) : null;
    assert.deepEqual(target, expected === null ? null : {projectId: id, pathname: expected}, pathname);
  }
});

test('each entity-addressed RPC rejects a foreign owner without changing its record', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const projectId = randomUUID(), other = randomUUID(), id = randomUUID();
  for (const table of ['edges', 'exports', 'shots', 'jobs', 'nodes']) {
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, projectId TEXT NOT NULL)`);
    db.prepare(`INSERT INTO ${table} (id, projectId) VALUES (?, ?)`).run(id, projectId);
  }
  const input = {edgeId: id, exportId: id, shotId: id, jobId: id, nodeId: id};
  for (const operation of ENTITY_ADDRESSED_OPERATIONS) {
    assert.doesNotThrow(() => assertProjectRpc(db, {projectId}, operation, input), operation);
    assert.throws(() => assertProjectRpc(db, {projectId: other}, operation, input),
      {code: 'NOT_FOUND', status: 404, message: '找不到记录', details: {id}}, operation);
  }
  for (const table of ['edges', 'exports', 'shots', 'jobs', 'nodes']) {
    assert.equal(db.prepare(`SELECT projectId FROM ${table} WHERE id=?`).get(id)?.projectId, projectId);
  }
});

test('project addresses on the workspace server: registration, project checks, entity ownership and legacy paths', {timeout: 60_000}, async t => {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'mioon-project-addressing-')));
  t.after(() => rmSync(dataDir, {recursive: true, force: true}));
  const server = await startServer({dataDir, port: 0, token: TOKEN});
  t.after(() => server.close());
  const send = async (route: string, init: {method?: string; body?: unknown; auth?: boolean; headers?: Record<string,string>} = {}): Promise<Reply> => {
    const response = await fetch(server.url + route, {method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {...(init.auth === false ? {} : {authorization: `Bearer ${TOKEN}`}), ...(init.body === undefined ? {} : {'content-type': 'application/json'}), ...init.headers},
      ...(init.body === undefined ? {} : {body: JSON.stringify(init.body)})});
    const text = await response.text();
    let body: Reply['body'];
    try { body = JSON.parse(text) as Reply['body']; } catch { body = {raw: text}; }
    return {status: response.status, body};
  };
  const rpc = (route: string, operation: string, input: unknown) => send(route, {body: {operation, input}});
  const data = <T>(reply: Reply): T => { assert.equal(reply.body.ok, true, JSON.stringify(reply.body)); return reply.body.data as T; };
  const failure = (reply: Reply, status: number, code: string, details?: unknown) => {
    assert.equal(reply.status, status, JSON.stringify(reply.body)); assert.equal(reply.body.ok, false); assert.equal(reply.body.error?.code, code);
    if (details !== undefined) assert.deepEqual(reply.body.error?.details, details);
  };
  const first = data<{id: string}>(await rpc('/api/rpc', 'project.create', {name: 'K2 first'})).id;
  const second = data<{id: string}>(await rpc('/api/rpc', 'project.create', {name: 'K2 second'})).id;
  const shot = data<{id: string; revision: number}>(await rpc(projectRpcPath(first), 'shot.create', {projectId: first, title: 'K2 shot'}));
  const asset = data<{id: string}>(await rpc(projectRpcPath(first), 'asset.import', {projectId: first, name: 'k2.png', mimeType: 'image/png', dataBase64: PNG}));
  const unknown = randomUUID();
  const exportInput = {projectId:first,requestId:randomUUID()};
  const exportRequest = {operation:'export.create',input:exportInput};
  failure(await send(projectRpcPath(first),{body:exportRequest,headers:{'X-Mioon-Output-Locale':'en-US'}}),400,'VALIDATION_ERROR');
  failure(await send(projectRpcPath(first),{body:exportRequest,headers:{'X-Mioon-Output-Locale':'ja'}}),400,'MISSING_SELECTION');
  failure(await rpc(projectRpcPath(first),'export.create',{...exportInput,outputLocale:'ja'}),400,'VALIDATION_ERROR');

  // Authentication comes before the registry; an unknown project is PROJECT_NOT_FOUND.
  failure(await send(projectRpcPath(unknown), {body: {operation: 'project.get', input: {projectId: unknown}}, auth: false}), 401, 'UNAUTHORIZED');
  failure(await rpc(projectRpcPath(unknown), 'project.get', {projectId: unknown}), 404, 'PROJECT_NOT_FOUND', {projectId: unknown});
  failure(await send(projectMediaPath(unknown, asset.id)), 404, 'PROJECT_NOT_FOUND', {projectId: unknown});

  // RPC at a project's address.
  assert.equal(data<{project: {id: string}}>(await rpc(projectRpcPath(first), 'project.get', {projectId: first})).project.id, first);
  failure(await rpc(projectRpcPath(first), 'project.get', {projectId: second}), 400, 'PROJECT_ID_MISMATCH', {projectId: first});
  failure(await rpc(projectRpcPath(first), 'image.review.prepare', {input: {projectId: second}}), 400, 'PROJECT_ID_MISMATCH', {projectId: first});
  for (const operation of PREVIS_OUTPUT_OPERATIONS) {
    failure(await rpc(projectRpcPath(first), operation, {projectId: second}), 400, 'PROJECT_ID_MISMATCH', {projectId: first});
    failure(await rpc('/api/rpc', operation, {projectId: first}), 404, 'UNKNOWN_OPERATION');
  }
  failure(await rpc(projectRpcPath(first), 'provider.list', {}), 400, 'VALIDATION_ERROR');
  failure(await rpc(projectRpcPath(first), 'project.rename', {projectId: first, name: 'renamed'}), 400, 'VALIDATION_ERROR');
  failure(await rpc(projectRpcPath(second), 'shot.update', {shotId: shot.id, expectedRevision: shot.revision, patch: {title: 'moved'}}), 404, 'NOT_FOUND', {id: shot.id});
  failure(await rpc(projectRpcPath(second), 'version.list', {shotId: shot.id}), 404, 'NOT_FOUND', {id: shot.id});
  failure(await rpc(projectRpcPath(first), 'job.get', {jobId: unknown}), 404, 'NOT_FOUND', {id: unknown});
  assert.deepEqual(data(await rpc(projectRpcPath(first), 'version.list', {shotId: shot.id})), []);
  failure(await rpc('/api/rpc', 'version.list', {shotId: shot.id}), 400, 'VALIDATION_ERROR');
  const snapshot = data<{shots: {id: string; revision: number; title: string}[]}>(await rpc(projectRpcPath(first), 'project.get', {projectId: first}));
  assert.deepEqual(snapshot.shots.map(item => [item.id, item.revision, item.title]), [[shot.id, shot.revision, 'K2 shot']], 'the refused update left the shot unchanged');
  const updated = data<{revision: number}>(await rpc(projectRpcPath(first), 'shot.update', {shotId: shot.id, expectedRevision: shot.revision, patch: {title: 'K2 renamed'}}));
  assert.equal(updated.revision, shot.revision + 1);

  // Media answers another project's asset exactly as a missing one.
  const media = await fetch(server.url + projectMediaPath(first, asset.id), {headers: {authorization: `Bearer ${TOKEN}`}});
  assert.equal(media.status, 200); assert.equal(media.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), Buffer.from(PNG, 'base64'));
  failure(await send(projectMediaPath(second, asset.id)), 404, 'NOT_FOUND');
  failure(await send(projectMediaPath(first, unknown)), 404, 'NOT_FOUND');
  failure(await send(`/media/${asset.id}`), 404, 'NOT_FOUND');

  // A projectId in the query or body must name the address's project.
  failure(await send(`${projectApiPath(first, 'tasks')}?projectId=${second}`), 400, 'PROJECT_ID_MISMATCH', {projectId: first});
  failure(await send(`${projectApiPath(first, 'tasks')}?projectId=${first}&projectId=${second}`), 400, 'PROJECT_ID_MISMATCH', {projectId: first});
  failure(await send(`${projectApiPath(first, 'local-drafts')}?projectId=${second}`), 400, 'PROJECT_ID_MISMATCH', {projectId: first});
  for (const [route, method] of [[projectApiPath(first, 'local-drafts', 'clip'), 'PUT'], [projectApiPath(first, 'local-delivery', 'draft'), 'PUT'],
    [projectApiPath(first, 'local-drafts', 'clip'), 'DELETE'], [projectApiPath(first, 'local-delivery', 'draft'), 'DELETE'],
    [projectApiPath(first, 'local-shot-text', 'draft'), 'PUT'], [projectApiPath(first, 'local-shot-text', 'draft'), 'DELETE'],
    [projectApiPath(first, 'local-shot-text', 'prepare'), 'POST'], [projectApiPath(first, 'local-shot-text', 'execute'), 'POST'],
    [projectApiPath(first, 'local-shot-text', 'recover'), 'POST'], [projectApiPath(first, 'tasks', 'prepare'), 'POST'],
    [projectApiPath(first, 'tasks', unknown, 'execute'), 'POST'], [projectApiPath(first, 'tasks', unknown, 'reconcile'), 'POST'],
    [projectApiPath(first, 'tasks', unknown, 'acknowledge'), 'POST'],
    [projectApiPath(first, 'images', 'reviews', 'approve'), 'POST'], [projectApiPath(first, 'images', 'reviews', 'reject'), 'POST'],
    [projectApiPath(first, 'agent', 'tasks', 'v2', 'editing'), 'POST']] as const) {
    failure(await send(route, {method, body: {projectId: second}}), 400, 'PROJECT_ID_MISMATCH', {projectId: first});
  }
  failure(await send(projectApiPath(first, 'images', 'reviews', 'reject'), {body: {projectId: first, reviewId: unknown, expectedRevision: 1}}), 404, 'IMAGE_REVIEW_NOT_FOUND');
  const legacy = (route: string) => route.replace(`/api/projects/${first}/`, '/api/');
  for (const route of [`${projectApiPath(first, 'tasks')}?projectId=${first}`, `${projectApiPath(first, 'local-drafts')}?projectId=${first}`,
    `${projectApiPath(first, 'local-delivery')}?projectId=${first}`, `${projectApiPath(first, 'local-shot-text')}?projectId=${first}&shotId=${shot.id}`,
    `${projectApiPath(first, 'agent', 'tasks', 'v2', 'editing')}?projectId=${first}`]) {
    const current = await send(route);
    assert.equal(current.status, 200, route); assert.equal(current.body.ok, true, route);
    failure(await send(legacy(route)), 404, 'NOT_FOUND');
  }

  // Mio's project routes move under the address; its app-level routes do not.
  const currentTask = await send(projectApiPath(first, 'agent', 'tasks', 'v2'));
  assert.equal(currentTask.status, 200); assert.equal(currentTask.body.ok, true);
  failure(await send(`/api/agent/tasks/v2/${first}`), 404, 'NOT_FOUND');
  failure(await send(projectApiPath(first, 'agent', 'tasks', 'v2', 'policy')), 404, 'NOT_FOUND');
  failure(await send(projectApiPath(first, 'images', 'settings')), 404, 'NOT_FOUND');
  failure(await send(`/api/projects/${first}/tasks%2Fprepare`, {body: {projectId: first}}), 404, 'NOT_FOUND');
  failure(await rpc('/api/rpc', 'project.get', {projectId: first}), 400, 'VALIDATION_ERROR');
});
