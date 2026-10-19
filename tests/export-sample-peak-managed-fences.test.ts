import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import type {TestContext} from 'node:test';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {verifiedManagedHash} from '../packages/business/src/managed-media.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-peak-hash-fences-'));
  await mkdir(path.join(root, 'media'), {mode: 0o700});
  const bytes = Buffer.alloc(96 * 1024, 3), relativePath = 'media/owned.mp4';
  await writeFile(path.join(root, relativePath), bytes, {mode: 0o600});
  t.after(() => rm(root, {recursive: true, force: true}));
  return {root, bytes, asset: {relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length}};
}

// The wrapper observes actual opened descriptors and real read/stat/close
// promises. It never fabricates bytes, inode identity, or successful cleanup.
type Counts = {open: number; stat: number; read: number; close: number};
function instrument(t: TestContext, hook: (stage: string, seen: Counts) => void): Counts {
  const original = fs.promises.open;
  const calls: Counts = {open: 0, stat: 0, read: 0, close: 0};
  fs.promises.open = (async (...args: Parameters<typeof original>) => {
    calls.open++;
    const handle = await original(...args);
    hook('open', calls);
    return {
      stat: async (...args: Parameters<typeof handle.stat>) => {calls.stat++; const value = await handle.stat(...args); hook('stat', calls); return value;},
      read: async (...args: Parameters<typeof handle.read>) => {calls.read++; const value = await handle.read(...args); hook('read', calls); return value;},
      close: async (...args: Parameters<typeof handle.close>) => {calls.close++; const value = await handle.close(...args); hook('close', calls); return value;},
    } as unknown as fs.promises.FileHandle;
  }) as unknown as typeof fs.promises.open;
  syncBuiltinESMExports();
  t.after(() => {fs.promises.open = original; syncBuiltinESMExports();});
  return calls;
}

for (const at of ['open', 'first-stat', 'first-read', 'final-stat', 'close']) {
  test(`managed hash fences revocation after actual awaited ${at}, closes once, and performs no later read`, async t => {
    const f = await fixture(t), original = Object.assign(Error('Owned export was revoked'), {code: 'EXPORT_SAMPLE_PEAK_UNAVAILABLE'});
    let revoked = false, counted = 0;
    const calls = instrument(t, (stage, seen) => {
      if (at === stage || at === 'first-stat' && stage === 'stat' && seen.stat === 1 ||
          at === 'first-read' && stage === 'read' && seen.read === 1 || at === 'final-stat' && stage === 'stat' && seen.stat === 2) revoked = true;
    });
    await assert.rejects(verifiedManagedHash(f.root, f.asset, {beforeEffect: () => {if (revoked) throw original;}, onBytes: bytes => {counted += bytes;}}), error => error === original);
    assert.equal(calls.open, 1); assert.equal(calls.close, 1);
    if (at === 'open') {assert.equal(calls.stat, 0); assert.equal(calls.read, 0);}
    if (at === 'first-stat') {assert.equal(calls.stat, 1); assert.equal(calls.read, 0);}
    if (at === 'first-read') {assert.equal(calls.read, 1); assert.equal(counted, 0, 'revoked bytes never enter accumulator or hash');}
    if (at === 'final-stat' || at === 'close') {assert.equal(calls.read, 3); assert.equal(counted, f.bytes.length);}
  });
}

test('ordinary managed hash remains an actual complete stream without the optional fence', async t => {
  const f = await fixture(t), calls = instrument(t, () => {}); let counted = 0;
  const result = await verifiedManagedHash(f.root, f.asset, {onBytes: bytes => {counted += bytes;}});
  assert.equal(result.sha256, f.asset.sha256); assert.equal(result.sizeBytes, f.bytes.length); assert.equal(counted, f.bytes.length);
  assert.deepEqual(calls, {open: 1, stat: 2, read: 3, close: 1});
});

test('Promise-returning beforeEffect is rejected before opening media', async t => {
  const f = await fixture(t), calls = instrument(t, () => {});
  await assert.rejects(verifiedManagedHash(f.root, f.asset, {beforeEffect: async () => {}}), {code: 'MEDIA_INVALID_CONFIGURATION'});
  assert.equal(calls.open, 0); assert.equal(calls.close, 0);
});


test('rejected descriptor close cannot erase first revocation or skip final fence', async t => {
  const f = await fixture(t), revokedError = Object.assign(Error('Original revocation'), {code: 'EXPORT_SAMPLE_PEAK_UNAVAILABLE'});
  let revoked = false, fences = 0;
  const closeError = Error('Private close diagnostic');
  const calls = instrument(t, stage => {if (stage === 'open') revoked = true; if (stage === 'close') throw closeError;});
  await assert.rejects(verifiedManagedHash(f.root, f.asset, {beforeEffect: () => {fences++; if (revoked) throw revokedError;}}), error => error === revokedError);
  assert.equal(calls.close, 1); assert.equal(calls.read, 0); assert.equal(fences, 4, 'before initial validation, before open, after open, after rejected close');
});

test('absent optional fence preserves legacy descriptor-close rejection', async t => {
  const f = await fixture(t), closeError = Error('Synthetic close rejection');
  const calls = instrument(t, stage => {if (stage === 'close') throw closeError;});
  await assert.rejects(verifiedManagedHash(f.root, f.asset), error => error === closeError);
  assert.equal(calls.close, 1); assert.equal(calls.read, 3);
});
