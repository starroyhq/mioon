import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startServer} from '../apps/server/src/index.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {projectCopyResponseSchema} from '../packages/contracts/src/project-copies.ts';
import type {ProjectCopyResponse} from '../packages/contracts/src/project-copies.ts';
import {createServerProject} from './helpers/project-database.ts';

const token = 'synthetic-s5b-entry-token';
interface Wire<T> {ok: boolean; data?: T; error?: {code: string}}
async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-copy-action-entry-'));
  const dataDir = path.join(root, 'app'), targets = path.join(root, 'targets'); mkdirSync(targets);
  const created = createServerProject(dataDir, {name: 'Original'});
  const sourceFile = created.store.projectFile, sourceStamp = readProjectContentStamp(created.store.db);
  const sourceProjectId = created.projectId;
  created.store.close();
  const sourceBefore = readFileSync(sourceFile);
  const selectedFile = path.join(root, 'Finder Copy.mioon'); copyFileSync(sourceFile, selectedFile);
  const selectedIdentity = lstatSync(selectedFile, {bigint: true});
  const input = {sourceProjectId, sourceFile: selectedFile, sourceIdentity: {dev: String(selectedIdentity.dev), ino: String(selectedIdentity.ino)},
    sourceStamp, requestId: randomUUID()};
  const server = await startServer({dataDir, token, port: 0});
  t.after(async () => {await server.close(); rmSync(root, {recursive: true, force: true});});
  const rpc = async (operation: string, raw: unknown, {project = false, authenticated = true} = {}) => {
    const response = await fetch(server.url + (project ? `/api/projects/${sourceProjectId}/rpc` : '/api/rpc'), {
      method: 'POST', headers: {'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${token}`} : {})},
      body: JSON.stringify({operation, input: raw})});
    return {status: response.status, body: await response.json() as Wire<ProjectCopyResponse>};
  };
  const native = server.projectEntries;
  assert.ok(native.adoptCopy); assert.ok(native.copyTo); assert.ok(native.instantiateTemplate);
  const registration = async () => (await native.listRecent()).registered.map(value => value.project);
  return {root, dataDir, sourceProjectId, sourceFile, sourceBefore, targets, input, server, native, rpc, registration};
}
function denied(result: {status: number; body: Wire<unknown>}, status: number, code: string): void {
  assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.ok, false); assert.equal(result.body.error?.code, code);
}

test('trusted adopt-copy replaces only the selected copy, opens its new identity and replays the same window', async t => {
  const f = await fixture(t), windowId = randomUUID();
  const sourceRegistration = (await f.registration()).find(value => value.projectId === f.sourceProjectId);
  const adopted = await f.native.adoptCopy!({...f.input, windowId});
  assert.deepEqual(projectCopyResponseSchema.parse(adopted.copy), adopted.copy);
  assert.notEqual(adopted.copy.project.projectId, f.sourceProjectId); assert.equal(adopted.copy.project.projectFile, f.input.sourceFile);
  assert.equal(adopted.copy.versions, 0); assert.equal(adopted.window.windowId, windowId);
  assert.equal(adopted.window.project.projectId, adopted.copy.project.projectId);
  assert.notDeepEqual(adopted.copy.project.fileIdentity, f.input.sourceIdentity);
  assert.deepEqual(readFileSync(f.sourceFile), f.sourceBefore, 'registered original is unchanged');
  assert.deepEqual((await f.registration()).find(value => value.projectId === f.sourceProjectId), sourceRegistration);
  assert.deepEqual(await f.native.adoptCopy!({...f.input, windowId}), adopted);
  const conflicting = {...f.input, sourceStamp: {...f.input.sourceStamp, contentSequence: f.input.sourceStamp.contentSequence + 1}, windowId};
  await assert.rejects(f.native.adoptCopy!(conflicting), {code: 'REQUEST_ID_REUSED'});
  f.native.release({windowId});
});

test('trusted adopt-copy refuses an occupied window before changing the selected file', async t => {
  const f = await fixture(t), windowId = randomUUID();
  await f.native.acquire({projectId: f.sourceProjectId, windowId});
  const selectedBefore = readFileSync(f.input.sourceFile), registered = await f.registration();
  await assert.rejects(f.native.adoptCopy!({...f.input, windowId}), {code: 'PROJECT_ENTRY_WINDOW_CONFLICT'});
  assert.deepEqual(readFileSync(f.input.sourceFile), selectedBefore);
  assert.deepEqual(await f.registration(), registered);
  assert.deepEqual(lstatSync(f.input.sourceFile, {bigint: true}).ino.toString(), f.input.sourceIdentity.ino);
  f.native.release({windowId});
});

test('HTTP copy-to is application addressed and leaves the selected source and original registration unchanged', async t => {
  const f = await fixture(t), projectFile = path.join(f.targets, 'Copied.mioon');
  const selectedBefore = readFileSync(f.input.sourceFile), registered = await f.registration();
  const input = {...f.input, projectFile, name: 'Copied'};
  const result = await f.rpc('project.copy-to', input);
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true);
  const copied = projectCopyResponseSchema.parse(result.body.data);
  assert.equal(copied.project.projectFile, projectFile); assert.notEqual(copied.project.projectId, f.sourceProjectId);
  assert.deepEqual(readFileSync(f.input.sourceFile), selectedBefore); assert.deepEqual(readFileSync(f.sourceFile), f.sourceBefore);
  assert.deepEqual((await f.registration()).find(value => value.projectId === f.sourceProjectId), registered[0]);
  assert.equal(existsSync(projectFile), true);
  assert.deepEqual((await f.rpc('project.copy-to', input)).body.data, copied);
  denied(await f.rpc('project.copy-to', {...input, windowId: randomUUID()}), 400, 'VALIDATION_ERROR');
});

test('S5-B HTTP rejects missing authentication and forged native or template inputs before writes', async t => {
  const f = await fixture(t), before = await f.registration(), selectedBefore = readFileSync(f.input.sourceFile);
  const copyTo = {...f.input, projectFile: path.join(f.targets, 'Never.mioon')};
  const template = {templateId: 'unknown-starter', templateVersion: 1, parentDir: f.targets, name: 'Never', requestId: randomUUID()};
  for (const [operation, input] of [['project.adopt-copy', f.input], ['project.copy-to', copyTo], ['project.template.instantiate', template]] as const) {
    denied(await f.rpc(operation, input, {authenticated: false}), 401, 'UNAUTHORIZED');
    denied(await f.rpc(operation, {...input, windowId: randomUUID()}), 400, 'VALIDATION_ERROR');
  }
  denied(await f.rpc('project.template.instantiate', {...template, templateId: '../outside'}), 400, 'VALIDATION_ERROR');
  denied(await f.rpc('project.template.instantiate', {...template, sourceFile: f.input.sourceFile}), 400, 'VALIDATION_ERROR');
  assert.deepEqual(await f.registration(), before); assert.deepEqual(readFileSync(f.input.sourceFile), selectedBefore);
  assert.deepEqual(readdirSync(f.targets), []);
});

test('project-addressed S5-B operations reject without replacing or copying the selected file', async t => {
  const f = await fixture(t), selectedBefore = readFileSync(f.input.sourceFile);
  const inputs = [['project.adopt-copy', f.input], ['project.copy-to', {...f.input, projectFile: path.join(f.targets, 'Never.mioon')}],
    ['project.template.instantiate', {templateId: 'unknown-starter', templateVersion: 1, parentDir: f.targets, name: 'Never', requestId: randomUUID()}]] as const;
  // The existing project router acquires the addressed host before decoding
  // RPC. Its successful-open metadata is separate from a lifecycle commit.
  for (const [operation, input] of inputs) denied(await f.rpc(operation, input, {project: true}), 400, 'VALIDATION_ERROR');
  assert.deepEqual(readFileSync(f.input.sourceFile), selectedBefore); assert.deepEqual(readFileSync(f.sourceFile), f.sourceBefore);
  assert.deepEqual(readdirSync(f.targets), []);
  assert.deepEqual((await f.registration()).map(value => value.projectId), [f.sourceProjectId]);
});
