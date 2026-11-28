import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {startServer, type ServerOptions} from './helpers/test-server.ts';
import {copyIdentity} from '../apps/server/src/project-host/copy-records.ts';
import {inspectCopiedProjectFile} from '../packages/business/src/project-file/backup.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {isProjectFileHeld} from '../packages/business/src/project-file/index.ts';
import {mountProjectVolumeFixture} from './helpers/project-volume-fixture.ts';
import {testEnv} from './helpers/test-env.ts';

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

for (const format of ['exFAT', 'FAT32'] as const) {
  test(`${format} project copies publish the complete allocated file and recover the original request`, {timeout: 90_000}, async t => {
    const volume = await mountProjectVolumeFixture(t, format);
    if (!volume) return;
    const {root, mount} = volume;
    const projectsDir = path.join(mount, 'projects'), targets = path.join(mount, 'copies');
    fs.mkdirSync(projectsDir); fs.mkdirSync(targets);
    const options: ServerOptions = {dataDir: path.join(root, 'app'), projectsDir, port: 0, token,
      localDraftChannel: 'development', projectFormatForTest: 5};
    let server: Awaited<ReturnType<typeof startServer>> | undefined, stopBeforePublish = true;
    let stopAtCapture = false;
    const close = async () => {await server?.close(); server = undefined;};
    const stop = (phase: string) => {
      if (phase === 'records-published' && stopBeforePublish) throw new Error('stop at legacy FAT intent boundary');
      if (phase === 'captured' && stopAtCapture) throw new Error('stop before the legacy FAT stage is created');
    };
    const launch = async () => {
      server = await startServer({...options, projectCopyBoundaryForTest: stop, projectCopyActionBoundaryForTest: stop});
      return server.projectEntries;
    };
    try {
      let native = await launch();
      const source = await native.create({projectFile: path.join(projectsDir, 'Source.mioon'), name: 'Portable source'});
      const input = {projectId: source.projectId, requestId: randomUUID(), projectFile: path.join(targets, 'Recovered.mioon')};
      await assert.rejects(native.duplicate!(input), /stop at legacy FAT intent boundary/u);
      const record = path.join(options.dataDir, 'project-copies', `project.duplicate-${input.requestId}.json`);
      const intent = JSON.parse(fs.readFileSync(record, 'utf8'));
      assert.equal(intent.phase, 'records-published'); assert.equal(intent.placeholderIdentity, null);
      assert.equal(fs.existsSync(input.projectFile), false);
      assert.equal(inspectCopiedProjectFile(path.join(intent.stageDirectory, 'project.mioon')).projectId, intent.projectId);

      stopBeforePublish = false;
      const rename = fs.renameSync;
      t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
        if (String(args[1]) === input.projectFile) throw Object.assign(Error('simulated full FAT volume'), {code: 'ENOSPC'});
        return rename(...args);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(native.duplicate!(input), {code: 'PROJECT_COPY_CAPACITY', status: 507});
        assert.equal(fs.existsSync(input.projectFile), false);
        assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).phase, 'records-published');
      } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
      fs.writeFileSync(input.projectFile, 'unrelated file');
      await close(); native = await launch();
      await assert.rejects(native.duplicate!(input), {code: 'PROJECT_COPY_TARGET_CHANGED'});
      assert.equal(fs.readFileSync(input.projectFile, 'utf8'), 'unrelated file');
      fs.unlinkSync(input.projectFile);
      await close(); native = await launch();
      const resumed = await native.duplicate!(input);
      assert.equal(resumed.project.projectId, intent.projectId); assert.equal(resumed.contentToken, intent.contentToken);
      assert.deepEqual(await native.duplicate!(input), resumed);
      assert.equal(fs.existsSync(intent.stageDirectory), false);

      assert.ok(native.observeSource);
      const {source: observedSource} = await native.observeSource({projectFile: source.projectFile});
      assert.ok(observedSource);
      const copyTo = {...observedSource, requestId: randomUUID(), projectFile: path.join(targets, 'Selected.mioon')};
      const selected = await native.copyTo!(copyTo);
      assert.deepEqual(await native.copyTo!(copyTo), selected);
      assert.equal(inspectCopiedProjectFile(copyTo.projectFile).projectId, selected.project.projectId);

      const windowId = randomUUID(); await native.acquire({projectId: source.projectId, windowId});
      const saveAs = {...input, windowId, requestId: randomUUID(), projectFile: path.join(targets, 'Saved as.mioon')};
      const saved = await native.saveAs!(saveAs);
      assert.deepEqual(await native.saveAs!(saveAs), saved);
      native.release({windowId});
      const limit = performance.now() + 10_000;
      while (isProjectFileHeld(saved.copy.project.fileIdentity)) {
        assert.ok(performance.now() < limit, 'close the copied project before continuing');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(inspectCopiedProjectFile(saveAs.projectFile).projectId, saved.copy.project.projectId);
      assert.deepEqual(fs.readdirSync(targets).filter(name => !name.startsWith('._')).sort(), ['Recovered.mioon', 'Saved as.mioon', 'Selected.mioon']);

      const diskFull = {...input, requestId: randomUUID(), projectFile: path.join(targets, 'Disk full.mioon')};
      const write = fs.writeSync;
      let writeFailure = false;
      t.mock.method(fs, 'writeSync', (...args: [number, string | NodeJS.ArrayBufferView, (number | null)?, (number | BufferEncoding | null)?, (number | null)?]) => {
        if (Buffer.isBuffer(args[1]) && args[3] === 64 * 1024 && args[4] === 64 * 1024) {
          writeFailure = true; throw Object.assign(Error('simulated full volume during FAT DB write'), {code: 'ENOSPC'});
        }
        return Reflect.apply(write, fs, args);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(native.duplicate!(diskFull), {code: 'PROJECT_COPY_CAPACITY', status: 507});
        assert.equal(writeFailure, true);
        assert.equal(fs.existsSync(diskFull.projectFile), false);
      } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
      const failed = JSON.parse(fs.readFileSync(path.join(options.dataDir, 'project-copies', `project.duplicate-${diskFull.requestId}.json`), 'utf8'));
      assert.equal(failed.phase, 'captured'); assert.ok(failed.fatStage.file);
      assert.equal(fs.existsSync(failed.stageDirectory), false, 'ordinary write failure cleans the proved partial immediately');
      await close(); native = await launch();
      assert.equal((await native.duplicate!(diskFull)).project.projectId, failed.projectId);

      await close();
      for (const family of ['duplicate', 'copy-to'] as const) {
        const request = {requestId: randomUUID(), projectFile: path.join(targets, `Half-${family}.mioon`)};
        const duplicateInput = {...request, projectId: source.projectId}, copyToInput = {...request, ...observedSource};
        const worker = new URL(family === 'duplicate' ? './fixtures/project-copy-worker.ts' : './fixtures/project-copy-action-worker.ts', import.meta.url);
        const child = spawnSync(process.execPath, [worker.pathname,
          JSON.stringify({root: options.dataDir, input: family === 'duplicate' ? duplicateInput : copyToInput, operation: family, point: 'copy-build-chunk'})], {
          env: testEnv(), encoding: 'utf8', timeout: 40_000,
        });
        assert.equal(child.error, undefined); assert.equal(child.signal, 'SIGKILL', child.stderr);
        const namespace = family === 'duplicate' ? 'project-copies' : 'project-copy-actions';
        const partial = JSON.parse(fs.readFileSync(path.join(options.dataDir, namespace, `project.${family}-${request.requestId}.json`), 'utf8'));
        assert.equal(partial.phase, 'captured'); assert.ok(partial.fatStage.file);
        assert.equal(fs.statSync(path.join(partial.stageDirectory, 'project.mioon')).size, 64 * 1024);
        assert.equal(fs.existsSync(request.projectFile), false);
        const displaced = source.projectFile + '.displaced';
        fs.renameSync(source.projectFile, displaced);
        try {
          native = await launch();
          const invoke = () => family === 'duplicate' ? native.duplicate!(duplicateInput) : native.copyTo!(copyToInput);
          const result = await invoke();
          assert.equal(result.project.projectId, partial.projectId); assert.equal(result.contentToken, partial.contentToken);
          assert.deepEqual(await invoke(), result);
          assert.equal(fs.existsSync(partial.stageDirectory), false, 'recovery clears only the exact half-written private stage');
          await close();
        } finally {fs.renameSync(displaced, source.projectFile);}
      }

      const crash = {...input, requestId: randomUUID(), projectFile: path.join(targets, 'Crashed.mioon')};
      await close();
      const worker = new URL('./fixtures/project-copy-worker.ts', import.meta.url);
      const child = spawnSync(process.execPath, [worker.pathname, JSON.stringify({root: options.dataDir, input: crash, point: 'records-published'})], {
        env: testEnv(), encoding: 'utf8', timeout: 40_000,
      });
      assert.equal(child.error, undefined); assert.equal(child.signal, 'SIGKILL', child.stderr);
      assert.equal(fs.existsSync(crash.projectFile), false);
      const interrupted = JSON.parse(fs.readFileSync(path.join(options.dataDir, 'project-copies', `project.duplicate-${crash.requestId}.json`), 'utf8'));
      native = await launch();
      const recovered = await native.duplicate!(crash);
      assert.equal(recovered.project.projectId, interrupted.projectId); assert.equal(recovered.contentToken, interrupted.contentToken);
      assert.deepEqual(await native.duplicate!(crash), recovered);
      assert.equal(fs.existsSync(interrupted.stageDirectory), false);

      stopAtCapture = true;
      const retainedStages: Array<{record: string; file: string; target: string; retry: () => Promise<unknown>}> = [];
      for (const family of ['duplicate', 'copy-to'] as const) {
        const request = {requestId: randomUUID(), projectFile: path.join(targets, `Old-${family}.mioon`)};
        const retry = () => family === 'duplicate' ? native.duplicate!({...request, projectId: source.projectId})
          : native.copyTo!({...request, ...observedSource});
        await assert.rejects(retry(), /stop before the legacy FAT stage is created/u);
        const namespace = family === 'duplicate' ? 'project-copies' : 'project-copy-actions';
        const record = path.join(options.dataDir, namespace, `project.${family}-${request.requestId}.json`);
        const old = JSON.parse(fs.readFileSync(record, 'utf8'));
        assert.equal(old.phase, 'captured'); assert.equal(old.fatStage, undefined);
        const stage = fs.mkdtempSync(path.join(targets, '.project-copy-')), file = path.join(stage, 'project.mioon');
        fs.writeFileSync(file, 'unrelated contents inside an old FAT stage');
        fs.writeFileSync(record, JSON.stringify({...old, stageDirectory: stage, stageDirectoryIdentity: copyIdentity(stage)}));
        retainedStages.push({record, file, target: request.projectFile, retry});
      }
      stopAtCapture = false;
      for (let restart = 0; restart < 2; restart++) {
        await close(); native = await launch();
        for (const stage of retainedStages) {
          const old = JSON.parse(fs.readFileSync(stage.record, 'utf8'));
          assert.equal(old.phase, 'abandoned'); assert.equal(old.retainedFatStage, true);
          await assert.rejects(stage.retry(), {code: 'PROJECT_COPY_INTERRUPTED'});
          assert.equal(fs.readFileSync(stage.file, 'utf8'), 'unrelated contents inside an old FAT stage');
          assert.equal(fs.existsSync(stage.target), false);
        }
      }
    } finally {await close();}
  });
}
