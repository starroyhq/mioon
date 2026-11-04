import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {startServer, type ServerOptions} from '../apps/server/src/index.ts';
import {copyIdentity} from '../apps/server/src/project-host/copy-records.ts';
import {inspectCopiedProjectFile} from '../packages/business/src/project-file/backup.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';

const token = 'synthetic-copy-startup-token';
type Family = 'duplicate' | 'copy-to';
async function fixture(t: TestContext, family: Family, phase: 'captured' | 'ready' = 'captured') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'copy-startup-'));
  const dataDir = path.join(root, 'app'), targetDir = path.join(root, 'targets'); fs.mkdirSync(targetDir);
  const options: ServerOptions = {dataDir, port: 0, token};
  const stop = (point: string) => {if (point === phase) throw Error('stop before startup recovery');};
  let server: Awaited<ReturnType<typeof startServer>> | undefined = await startServer({...options,
    projectCopyBoundaryForTest: stop, projectCopyActionBoundaryForTest: stop});
  t.after(async () => {await server?.close(); fs.rmSync(root, {recursive: true, force: true});});
  const source = await server.projectEntries.create({name: 'Original'});
  const original = fs.readFileSync(source.projectFile), stamp = inspectCopiedProjectFile(source.projectFile);
  const requestId = randomUUID(), projectFile = path.join(targetDir, 'Copy.mioon');
  if (family === 'duplicate') {
    assert.ok(server.projectEntries.duplicate);
    await assert.rejects(server.projectEntries.duplicate({projectId: source.projectId, requestId, projectFile}), /stop before startup recovery/u);
  } else {
    assert.ok(server.projectEntries.copyTo);
    await assert.rejects(server.projectEntries.copyTo({sourceProjectId: source.projectId, sourceFile: source.projectFile,
      sourceIdentity: source.fileIdentity, sourceStamp: {contentSequence: stamp.contentSequence, contentToken: stamp.contentToken}, requestId, projectFile}), /stop before startup recovery/u);
  }
  const operation = family === 'duplicate' ? 'project.duplicate' : 'project.copy-to';
  const record = path.join(dataDir, family === 'duplicate' ? 'project-copies' : 'project-copy-actions', `${operation}-${requestId}.json`);
  let intent = JSON.parse(fs.readFileSync(record, 'utf8'));
  if (phase === 'captured') {
    const stage = fs.mkdtempSync(path.join(targetDir, '.project-copy-'));
    fs.writeFileSync(path.join(stage, 'project.mioon'), 'owned incomplete stage');
    intent = {...intent, stageDirectory: stage, stageDirectoryIdentity: copyIdentity(stage)};
    fs.writeFileSync(record, JSON.stringify(intent));
  }
  await server.close(); server = undefined;
  return {options, source, original, record, intent, projectFile, operation, requestId,
    read: () => JSON.parse(fs.readFileSync(record, 'utf8')),
    async restart() {assert.equal(server, undefined); server = await startServer(options); return server;},
    async close() {await server?.close(); server = undefined;},
    unchanged() {assert.deepEqual(fs.readFileSync(source.projectFile), original); assert.equal(fs.existsSync(projectFile), false);},
  };
}
async function listening(server: Awaited<ReturnType<typeof startServer>>): Promise<void> {
  const response = await fetch(server.url + '/api/rpc', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    body: JSON.stringify({operation: 'project.list', input: {}})});
  assert.equal(response.status, 200); const result = await response.json() as {ok: boolean}; assert.equal(result.ok, true);
}

for (const family of ['duplicate', 'copy-to'] as const) {
  for (const code of ['EROFS', 'EACCES', 'EPERM'] as const) {
    test(`${family} captured cleanup ${code} does not block startup and retries its abandoned stage`, async t => {
      const f = await fixture(t, family), stage = f.intent.stageDirectory as string, remove = fs.rmSync;
      let attempts = 0;
      t.mock.method(fs, 'rmSync', (...args: Parameters<typeof fs.rmSync>) => {
        if (String(args[0]) === stage) {attempts++; throw Object.assign(Error('synthetic unavailable staging directory'), {code});}
        return remove(...args);
      });
      syncBuiltinESMExports();
      try {
        await listening(await f.restart()); assert.equal(attempts, 1);
        assert.equal(f.read().phase, 'abandoned'); assert.equal(f.read().projectId, f.intent.projectId);
        assert.equal(fs.existsSync(stage), true); f.unchanged(); await f.close();
      } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
      await listening(await f.restart()); assert.equal(f.read().phase, 'abandoned'); assert.equal(fs.existsSync(stage), false);
      assert.equal(f.read().contentToken, f.intent.contentToken); f.unchanged();
    });
  }

  test(`${family} failed tombstone write is skipped at startup and retried without changing its identity`, async t => {
    const f = await fixture(t, family), rename = fs.renameSync; let attempts = 0;
    t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === f.record) {attempts++; throw Object.assign(Error('synthetic denied intent write'), {code: 'EPERM'});}
      return rename(...args);
    });
    syncBuiltinESMExports();
    try {
      await listening(await f.restart()); assert.equal(attempts, 1);
      assert.equal(f.read().phase, 'captured'); assert.equal(f.read().projectId, f.intent.projectId);
      assert.equal(fs.existsSync(f.intent.stageDirectory), true); f.unchanged(); await f.close();
    } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
    await listening(await f.restart()); assert.equal(f.read().phase, 'abandoned');
    assert.equal(fs.existsSync(f.intent.stageDirectory), false); assert.equal(f.read().projectId, f.intent.projectId); f.unchanged();
  });

  test(`${family} receipt mismatch remains a startup error instead of being treated as cleanup failure`, async t => {
    const f = await fixture(t, family, 'ready'), library = openAppLibrary({dataDir: f.options.dataDir!});
    try {library.receipts.write({operation: f.operation, requestId: f.requestId, digest: 'f'.repeat(64), response: f.intent.response, createdAt: new Date().toISOString()});}
    finally {library.close();}
    await assert.rejects(f.restart(), {code: 'PROJECT_COPY_INTENT_INVALID'});
    assert.equal(f.read().phase, 'ready'); assert.equal(f.read().projectId, f.intent.projectId); f.unchanged();
  });
}
