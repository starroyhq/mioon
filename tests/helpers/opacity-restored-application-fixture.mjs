import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable, Writable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {opacityBackupFixture} from './opacity-backup-fixture.mjs';
import {reopenOpacityCandidateApplicationStore} from '../../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateApplicationServices} from '../../packages/business/src/opacity-candidate-services.ts';
import {createOpacityCandidateWorkspaceBackup, restoreOpacityCandidateWorkspaceBackup} from '../../packages/business/src/opacity-candidate-backup.ts';
import {createRestoredOpacityCandidateLaunch} from '../../apps/server/src/opacity-candidate-launch.ts';
import {createOpacityCandidateRequestApplication} from '../../apps/server/src/index.mjs';

export const restoredApplicationToken = 'synthetic-restored-opacity-application-token';

/** Invoke the real shared handler without a listener or native worker. Optional
 * disconnected requests exercise its actual observation boundary. */
export async function request(app, pathname, {method = 'GET', input, headers: extra = {}, authenticate = true,
  aborted = false, beforeHandle} = {}) {
  const data = input === undefined ? null : Buffer.from(JSON.stringify(input));
  const req = Readable.from(data ? [data] : []);
  Object.assign(req, {method, url: pathname, aborted, headers: {host: '127.0.0.1:4319',
    ...(authenticate ? {authorization: `Bearer ${restoredApplicationToken}`} : {}),
    ...(data ? {'content-type': 'application/json', 'content-length': String(data.length)} : {}), ...extra}});
  const chunks = [], res = new Writable({write(chunk, _encoding, callback) {chunks.push(Buffer.from(chunk)); callback();}});
  res.status = 0; res.headers = {}; res.headersSent = false;
  res.setHeader = (name, value) => {res.headers[name.toLowerCase()] = value;};
  res.writeHead = (status, headers = {}) => {
    res.status = status;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.headersSent = true; return res;
  };
  beforeHandle?.(req, res);
  await app.handleRequest(req, res);
  const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
  return {status: res.status, text, bytes, headers: res.headers,
    data: /^application\/json/u.test(res.headers['content-type'] ?? '') ? JSON.parse(text) : null, req, res};
}
export const rpc = (app, operation, input = {}, context = {}) => request(app, '/api/rpc', {
  method: 'POST', input: {operation, input, ...context},
});
export async function prepareTask(f, operation, input) {
  const prepared = await request(f.app, '/api/tasks/prepare', {method: 'POST', input: {
    projectId: f.projectId, operation, input, origin: 'new', expectedWorkspaceOrigin: f.restored.workspaceOrigin,
  }});
  assert.equal(prepared.data.ok, true, prepared.text);
  return prepared.data.data;
}
export async function applyTask(f, operation, input) {
  const prepared = await prepareTask(f, operation, input), authority = {
    projectId: f.projectId, digest: prepared.task.digest, expectedWorkspaceOrigin: f.restored.workspaceOrigin,
  };
  const executed = await request(f.app, `/api/tasks/${prepared.task.id}/execute`, {method: 'POST', input: {
    ...authority, instanceId: prepared.instanceId,
  }});
  assert.equal(executed.data.ok, true, executed.text);
  assert.equal(executed.data.data.task.status, 'applied', executed.text);
  const acknowledged = await request(f.app, `/api/tasks/${prepared.task.id}/acknowledge`, {method: 'POST', input: {
    ...authority, expectedRevision: executed.data.data.task.revision, status: 'applied',
  }});
  assert.equal(acknowledged.data.ok, true, acknowledged.text);
  return {prepared, executed: executed.data.data, acknowledged: acknowledged.data.data, result: executed.data.data.result};
}

/** Real cold42 archive -> distinct43 publication -> fixed one-shot application
 * launch. Every path and opaque source byte is owned by this test. */
export async function restoredApplicationFixture(t) {
  const f = await opacityBackupFixture(t), source = reopenOpacityCandidateApplicationStore(f.source);
  const services = createOpacityCandidateApplicationServices(source);
  let captured;
  try {
    captured = await services.call('timeline.render', {projectId: f.projectId, requestId: randomUUID(), expectedRevision: 3, purpose: 'preview'});
  } finally {await services.drain(); source.close();}
  await createOpacityCandidateWorkspaceBackup({source: f.source, destination: f.backup});
  const restored = await restoreOpacityCandidateWorkspaceBackup({directory: f.backup, destination: f.destination});
  const dist = path.join(f.base, 'candidate-dist'); fs.mkdirSync(dist, {mode: 0o700});
  fs.writeFileSync(path.join(dist, 'mioon-opacity-candidate-entry.json'), JSON.stringify({schemaVersion: 1, profileId: 'mioon-workspace-v42', entry: 'opacity-candidate.html'}));
  fs.writeFileSync(path.join(dist, 'opacity-candidate.html'), '<html>isolated restored opacity43 entry</html>');
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>ordinary entry</html>');
  let app;
  const close = async () => {await app?.close();};
  const reopen = async () => {
    await close();
    app = await createOpacityCandidateRequestApplication({opacityCandidateLaunch: createRestoredOpacityCandidateLaunch(f.destination),
      port: 4319, distDir: dist, token: restoredApplicationToken});
    return app;
  };
  f.manage(close); await reopen();
  return {...f, restored, captured, dist, get app() {return app;}, close, reopen,
    readDb(callback) {
      const db = new DatabaseSync(path.join(f.destination, 'workbench.sqlite'), {readOnly: true});
      try {return callback(db);} finally {db.close();}
    },
  };
}
