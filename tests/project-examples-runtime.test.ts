import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {startServer} from './helpers/test-server.ts';

const token = 'synthetic-project-examples-runtime-token';
for (const condition of ['missing', 'invalid', 'symlink'] as const) test(`unavailable installation examples (${condition}) do not block normal editing or load checkout examples`, async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'example-runtime-')), examples = path.join(root, 'installed-examples');
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {try {await server?.close();} finally {rmSync(root, {recursive: true, force: true});}});
  if (condition === 'invalid') {mkdirSync(examples); mkdirSync(path.join(examples, 'timeline-basics')); writeFileSync(path.join(examples, 'timeline-basics', 'manifest.json'), '{invalid');}
  if (condition === 'symlink') {mkdirSync(path.join(root, 'other')); symlinkSync(path.join(root, 'other'), examples, process.platform === 'win32' ? 'junction' : 'dir');}
  server = await startServer({dataDir: path.join(root, 'data'), projectTemplatesDir: examples, token, port: 0});
  const request = {templateId: 'timeline-basics', templateVersion: 1, name: 'Example', parentDir: root, requestId: randomUUID()};
  const result = await fetch(server.url + '/api/rpc', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    body: JSON.stringify({operation: 'project.template.instantiate', input: request})});
  assert.equal(result.status, 404);
  assert.deepEqual((await result.json() as {error: {code: string}}).error.code, 'PROJECT_TEMPLATE_NOT_FOUND');
  assert.equal(existsSync(path.join(root, 'Example')), false);
  const original = await server.projectEntries.create({name: 'Independent editing'}), windowId = randomUUID();
  const opened = await server.projectEntries.acquire({projectId: original.projectId, windowId});
  assert.equal(opened.project.projectId, original.projectId); assert.equal(opened.project.name, 'Independent editing');
  server.projectEntries.release({windowId});
  if (condition === 'invalid') assert.equal(readFileSync(path.join(examples, 'timeline-basics', 'manifest.json'), 'utf8'), '{invalid');
});
