import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs, {type BigIntStats} from 'node:fs';
import {open, type FileHandle} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createHash, randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {ensurePrivateDirectory, writePrivateFileAtomic, getWindowsManagedFileIO} from '../packages/contracts/src/private-storage.ts';
import {publishProjectOutput, inspectProjectOutput, readPublishedProjectOutput, assertPublishedProjectOutput, setProjectOutputPublicationTestHooks} from '../packages/business/src/project-output-publication.ts';
import type {ProjectOutputInput} from '../packages/business/src/project-output-publication.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const bytes = png({width: 64, height: 64, rgba: false});
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'mioon-output-durability-'))), store = openStore(root);
  store.put('projects', {id: store.projectId, name: 'Durable publication'});
  t.after(() => {store.close(); fs.rmSync(root, {recursive: true, force: true});});
  const directory = path.join(store.tempDir, 'durability-stage'); ensurePrivateDirectory(directory, {create: true});
  const stageFile = path.join(directory, `${randomUUID()}.png`); writePrivateFileAtomic(stageFile, bytes, {root: store.tempDir, maxBytes: bytes.length});
  const input: ProjectOutputInput = {owner: {kind: 'image', id: randomUUID(), requestId: randomUUID(), inputHash: 'a'.repeat(64)}, assetId: randomUUID(),
    targetKind: 'generated', stageFile, mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length};
  const count = (): unknown => store.db.prepare('SELECT total_changes() AS n').get()!.n;
  return {root, store, input, count};
}
type Fixture = ReturnType<typeof fixture>;

/** Leave a complete final inode before either its link name or its copied
 * bytes have been synced. No test code writes a publication receipt. */
async function interrupted(f: Fixture, copy: boolean): Promise<string> {
  assert.ok(bytes.length < 65536, 'one copy chunk completes this fixture');
  const stop = Error('creator stopped before final fsync'); let file = '', armed = true;
  const remove = setProjectOutputPublicationTestHooks(f.store, {forceCopy: copy, fault(point, proof) {
    if (point === 'after_intent') file = path.join(f.root, proof.relativePath);
    if (copy && point === 'after_copy_chunk' && armed) {armed = false; throw stop;}
  }});
  try {
    await assert.rejects(publishProjectOutput(f.store, f.input, {beforeEffect() {
      if (!copy && armed && file && fs.existsSync(file)) {armed = false; throw stop;}
    }}), error => error === stop);
  } finally {remove();}
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(f.store.get('assets', f.input.assetId), null);
  return file;
}

/** Spy on the actual final file handle and parent directory descriptor. The
 * native ESM binding is refreshed on install and restore, including failures. */
async function syncSpy(file: string, stage: string, failure?: 'file' | 'directory') {
  const sample = await open(stage, 'r'), prototype = Object.getPrototypeOf(sample) as {sync: FileHandle['sync']}; await sample.close();
  const originalHandleSync = prototype.sync, originalDirectorySync = fs.fsyncSync, stop = Error(`durability ${failure ?? 'spy'}`);
  const windows = process.platform === 'win32' ? getWindowsManagedFileIO() : undefined, originalWindowsSync = windows?.syncDirectory;
  const calls = {file: 0, directory: 0, all: 0}; let fail = failure;
  prototype.sync = async function(this: FileHandle): Promise<void> {
    calls.all++;
    if (same(fs.fstatSync(this.fd, {bigint: true}), fs.lstatSync(file, {bigint: true}))) {calls.file++; if (fail === 'file') throw stop;}
    return originalHandleSync.call(this);
  };
  fs.fsyncSync = (fd: number): void => {
    calls.all++;
    if (!windows && same(fs.fstatSync(fd, {bigint: true}), fs.lstatSync(path.dirname(file), {bigint: true}))) {calls.directory++; if (fail === 'directory') throw stop;}
    originalDirectorySync(fd);
  };
  if (windows && originalWindowsSync) windows.syncDirectory = (directory, options): void => {
    calls.all++;
    if (same(fs.lstatSync(directory, {bigint: true}), fs.lstatSync(path.dirname(file), {bigint: true}))) {calls.directory++; if (fail === 'directory') throw stop;}
    originalWindowsSync.call(windows, directory, options);
  };
  syncBuiltinESMExports();
  return {calls, stop, allow() {fail = undefined;}, reset() {calls.file = 0; calls.directory = 0; calls.all = 0;}, restore() {
    prototype.sync = originalHandleSync; fs.fsyncSync = originalDirectorySync;
    if (windows && originalWindowsSync) windows.syncDirectory = originalWindowsSync;
    syncBuiltinESMExports();
  }};
}

for (const copy of [false, true]) test(`complete ${copy ? 'copy' : 'link'} replay syncs final bytes and parent before registration while inspection stays read-only`, async t => {
  const f = fixture(t), file = await interrupted(f, copy), identity = fs.lstatSync(file, {bigint: true}), before = f.count(), spy = await syncSpy(file, f.input.stageFile);
  try {
    const output = await publishProjectOutput(f.store, f.input);
    assert.equal(spy.calls.file, 1); assert.equal(spy.calls.directory, 1); assert.equal(f.count(), before);
    assert.equal(path.join(f.root, output.relativePath), file); assert.ok(same(identity, fs.lstatSync(file, {bigint: true})));
    spy.reset();
    assert.deepEqual(await inspectProjectOutput(f.store, {owner: f.input.owner, assetId: f.input.assetId}), output);
    assert.deepEqual(await readPublishedProjectOutput(f.store, {owner: f.input.owner, assetId: f.input.assetId}, {maxBytes: bytes.length}), bytes);
    assert.equal(spy.calls.all, 0, 'inspection never repairs durability by adding sync effects'); assert.equal(f.count(), before);
    f.store.tx(() => {assertPublishedProjectOutput(f.store, output.publication); const {relativePath: _relative, ...fields} = output;
      f.store.put('assets', {id: f.input.assetId, projectId: f.store.projectId, name: 'Output.png', mimeType: 'image/png', provenance: 'generated', width: 64, height: 64, ...fields});});
    assert.ok(f.store.get('assets', f.input.assetId));
  } finally {spy.restore();}
});

for (const copy of [false, true]) for (const failure of ['file', 'directory'] as const)
  test(`${copy ? 'copy' : 'link'} replay ${failure} sync failure preserves the completed file and prevents DB registration`, async t => {
    const f = fixture(t), file = await interrupted(f, copy), identity = fs.lstatSync(file, {bigint: true}), before = f.count(), spy = await syncSpy(file, f.input.stageFile, failure);
    const register = async () => {
      const output = await publishProjectOutput(f.store, f.input);
      f.store.tx(() => {assertPublishedProjectOutput(f.store, output.publication); const {relativePath: _relative, ...fields} = output;
        f.store.put('assets', {id: f.input.assetId, projectId: f.store.projectId, name: 'Output.png', mimeType: 'image/png', provenance: 'generated', width: 64, height: 64, ...fields});});
      return output;
    };
    try {
      await assert.rejects(register(), error => error === spy.stop);
      assert.equal(spy.calls.file, 1); assert.equal(spy.calls.directory, failure === 'file' ? 0 : 1);
      assert.equal(f.count(), before); assert.equal(f.store.get('assets', f.input.assetId), null);
      assert.ok(same(identity, fs.lstatSync(file, {bigint: true}))); assert.deepEqual(fs.readFileSync(file), bytes); assert.deepEqual(fs.readFileSync(f.input.stageFile), bytes);
      spy.allow(); spy.reset(); const output = await register();
      assert.equal(path.join(f.root, output.relativePath), file); assert.equal(spy.calls.file, 1); assert.equal(spy.calls.directory, 1);
      assert.equal(fs.readdirSync(path.dirname(file)).length, 1); assert.ok(f.store.get('assets', f.input.assetId));
    } finally {spy.restore();}
  });
