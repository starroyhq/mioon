import {testEnv} from './helpers/test-env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('the shared store contract loads without a runtime dependency or legacy initialization', () => {
  const entry = pathToFileURL(path.join(ROOT, 'packages/business/src/store-contract.ts')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {registerHooks} from 'node:module';
    const entry = ${JSON.stringify(entry)}, dependencies = [];
    registerHooks({resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (context.parentURL === entry) {dependencies.push(resolved.url); throw new Error('A pure type contract must not load runtime dependencies');}
      return resolved;
    }});
    const contract = await import(entry);
    console.log(JSON.stringify({exports: Object.keys(contract), dependencies}));
  `], {env: testEnv(), cwd: ROOT, encoding: 'utf8', timeout: 60_000});
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {exports: [], dependencies: []});
});

test('a real kernel store opens and commits without resolving the legacy workspace implementation', t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-store-contract-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const entry = pathToFileURL(path.join(ROOT, 'packages/business/src/project-file/store.ts')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';
    import path from 'node:path';
    const forbidden = [];
    registerHooks({resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const name = resolved.url.split('/').at(-1);
      if (resolved.url.includes('/packages/business/src/') && (['db.ts', 'workspace-envelope-startup.ts', 'workspace-fixed-schema.ts', 'workspace-restore-schema.ts'].includes(name) || name.startsWith('workspace-schema'))) {
        forbidden.push(resolved.url); throw new Error('Kernel store loaded a legacy workspace initializer');
      }
      return resolved;
    }});
    const {createProjectStore, isProjectStore} = await import(${JSON.stringify(entry)});
    const root = ${JSON.stringify(directory)};
    const store = createProjectStore({projectFile: path.join(root, 'Project.mioon'), locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp')})});
    try {
      const project = {id: store.projectId, name: 'Pure kernel'};
      store.tx(() => store.put('projects', project));
      assert.deepEqual(store.get('projects', store.projectId), project);
      assert.equal(isProjectStore(store), true);
      assert.equal(isProjectStore({...store}), false);
      assert.throws(() => store.tx(async () => 1), /synchronous callback/u);
      assert.equal(store.db.isTransaction, false);
    } finally {store.close();}
    assert.equal(isProjectStore(store), false);
    console.log(JSON.stringify({forbidden, closed: !store.db.isOpen}));
  `], {env: testEnv(), cwd: ROOT, encoding: 'utf8', timeout: 60_000});
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {forbidden: [], closed: true});
});
