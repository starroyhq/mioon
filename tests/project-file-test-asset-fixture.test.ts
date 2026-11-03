import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import fs, {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {sampleRanges} from '../packages/business/src/media-reference/fingerprint.ts';
import {mediaReferenceSchema} from '../packages/contracts/src/media-reference.ts';

test('explicit test fixture stores only a reference, samples the fixed ranges, and preserves a declared wrong full hash', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'reference-fixture-'));
  const store = openStore(root); t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  store.put('projects', {id: store.projectId});
  const bytes = Buffer.alloc(2 * 1024 * 1024, 43), id = randomUUID(), relativePath = `media/${id}.mp4`;
  writeFileSync(path.join(root, relativePath), bytes);
  const sha256 = 'a'.repeat(64), fixture = store.put('assets', {id, projectId: store.projectId, relativePath, sizeBytes: bytes.length, sha256});
  assert.equal(fixture.relativePath, relativePath);
  const record = store.get('assets', id) as Record<string, unknown>;
  assert.equal(record.relativePath, undefined); assert.equal(record.sha256, sha256);
  const reference = mediaReferenceSchema.parse(record.reference);
  const sample = createHash('sha256');for (const range of sampleRanges(bytes.length)) sample.update(bytes.subarray(range.start, range.start + range.length));
  assert.equal(reference.sampledSha256, sample.digest('hex')); assert.equal(reference.fullSha256, sha256);
  assert.notEqual(createHash('sha256').update(bytes).digest('hex'), sha256);
});

test('test fixture never opens a held project database and keeps missing fixtures unavailable', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'reference-fixture-held-'));
  const store = openStore(root); t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  store.put('projects', {id: store.projectId});
  const original = fs.openSync; let heldOpens = 0;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === store.projectFile) {heldOpens++; throw new Error('Held database opened');}
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const id = randomUUID(); store.put('assets', {id, projectId: store.projectId, relativePath: 'project.mioon', sha256: null});
    const missing = randomUUID(); store.put('assets', {id: missing, projectId: store.projectId, relativePath: `media/${missing}.wav`, sha256: null});
    assert.equal(heldOpens, 0);
    for (const key of [id, missing]) {
      const asset = store.get('assets', key) as Record<string, unknown>, reference = mediaReferenceSchema.parse(asset.reference);
      assert.equal(reference.sampledSha256, '0'.repeat(64)); assert.equal(reference.fullSha256, null); assert.equal(reference.mtimeMs, 0);
    }
  } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
});
