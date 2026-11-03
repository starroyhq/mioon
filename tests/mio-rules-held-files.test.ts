import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, linkSync, lstatSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {isProjectFileHeld, openStore} from '../packages/business/src/project-file/index.ts';
import {isAppLibraryHeld, openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {publishRulesFile, readRulesFile} from '../packages/business/src/agent/mio-rules-file.ts';
import type {RulesFileEffect} from '../packages/business/src/agent/mio-rules-file.ts';

const heldKinds = ['project', 'history', 'cache', 'application'] as const;
type HeldKind = typeof heldKinds[number];
const locked = {ok: false, message: 'database is locked', errcode: 5};

/** The probe owns a different process: opening or closing an alias here would
 * itself drop the SQLite owner's POSIX locks and invalidate the assertion. */
function tryWriteInChild(file: string): unknown {
  const script = `
    import {DatabaseSync} from 'node:sqlite';
    let db;
    try {
      db = new DatabaseSync(process.argv[1], {timeout: 0});
      db.exec('BEGIN IMMEDIATE; ROLLBACK');
      process.stdout.write(JSON.stringify({ok: true}) + '\\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ok: false, message: error.message, errcode: error.errcode}) + '\\n');
    } finally { db?.close(); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, file], {
    encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function nodeIdentity(file: string): {dev: string; ino: string} {
  const info = lstatSync(file, {bigint: true});
  return {dev: String(info.dev), ino: String(info.ino)};
}

function fixture(t: TestContext, kind: HeldKind) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mio-rules-held-'));
  const store = openStore(path.join(root, 'source'));
  const library = openAppLibrary({dataDir: path.join(root, 'application')});
  t.after(() => {store.close(); library.close(); rmSync(root, {recursive: true, force: true});});
  store.put('projects', {id: store.projectId, name: 'Held project'});
  const files = {
    project: store.projectFile,
    history: path.join(store.localDir, 'history.db'),
    cache: path.join(store.cacheDir, 'cache.db'),
    application: library.databaseFile,
  };
  const file = files[kind], projectDir = store.projectDir;
  const target = path.join(projectDir, 'AGENTS.md');
  linkSync(file, target);
  const identity = nodeIdentity(target);
  assert.deepEqual(identity, nodeIdentity(file));
  assert.equal(kind === 'application' ? isAppLibraryHeld(identity) : isProjectFileHeld(identity), true,
    'The alias belongs to a real live kernel or application connection');
  assert.deepEqual(tryWriteInChild(file), locked, 'The owner already excludes another process before the operation');
  return {file, projectDir, target, identity};
}

for (const kind of heldKinds) {
  test(`reading AGENTS.md aliased to a held ${kind} database refuses before opening it and keeps its write lock`, t => {
    const f = fixture(t, kind);
    const result = readRulesFile(f.projectDir);
    assert.deepEqual(tryWriteInChild(f.file), locked, 'Refusing the alias must not release the existing SQLite lock');
    assert.deepEqual(nodeIdentity(f.target), f.identity);
    assert.deepEqual(result, {status: 'error', code: 'unsafe_file'});
  });

  test(`publishing over AGENTS.md aliased to a held ${kind} database refuses before renaming it and keeps its write lock`, t => {
    const f = fixture(t, kind), token = randomUUID(), effects: RulesFileEffect[] = [];
    const backupName = `.mioon-rules-${token}.backup`;
    const result = publishRulesFile(f.projectDir, {
      expectedExists: true,
      // No fs descriptor may be opened on the held database, even to hash it.
      expectedHash: 'a'.repeat(64),
      text: 'Proposed rules\n',
      candidateName: `.mioon-rules-${token}.candidate`,
      backupName,
      checkpoint: () => {},
      afterEffect: effect => {effects.push(effect);},
    });
    assert.deepEqual(tryWriteInChild(f.file), locked, 'Refusing publication must not release the existing SQLite lock');
    assert.equal(effects.includes('original_renamed'), false, 'The database alias must be refused before rename');
    assert.deepEqual(nodeIdentity(f.target), f.identity);
    assert.equal(existsSync(path.join(f.projectDir, backupName)), false);
    assert.notEqual(result.status, 'published');
    if (result.status === 'published') return;
    assert.equal(result.code, 'unsafe_file');
  });
}
