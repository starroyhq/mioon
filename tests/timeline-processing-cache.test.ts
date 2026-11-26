import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {createProcessingCache} from '../packages/business/src/timeline-processing/cache.ts';
import type {ProcessingCache} from '../packages/business/src/timeline-processing/cache.ts';
import type {ProcessingCacheReceipt} from '../packages/contracts/src/timeline-processing-storage.ts';

const quota = 4000;
const reservedBytes = 1700;
const freeBytes = () => 64n * 1024n ** 3n;
const allowEffect = () => {};
const digest = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex');

function fixture(t: TestContext, options: Parameters<typeof createProcessingCache>[1] = {}) {
  const parent = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-processing-cache-'));
  t.after(() => rmSync(parent, {recursive: true, force: true}));
  const root = path.join(parent, 'timeline-processing');
  const open = () => createProcessingCache(parent, {freeBytes, ...options});
  return {root, open, cache: open(), projectId: randomUUID()};
}

function writeProxy(directory: string, value = 42): ProcessingCacheReceipt['result'] {
  const payloads = [
    {fileName: 'proxy.mkv', contents: Buffer.alloc(1024, value)},
    {fileName: 'clock.json', contents: Buffer.from('{}')},
  ] as const;
  const files = payloads.map(({fileName, contents}) => {
    writeFileSync(path.join(directory, fileName), contents, {flag: 'wx', mode: 0o600});
    return {fileName, bytes: contents.length, sha256: digest(contents)};
  });
  return {profileId: 'timeline-reverse-source-v1', mapHash: 'a'.repeat(16), frameCount: 1, sampleCount: 0, files};
}

function publish(cache: ProcessingCache, projectId: string, name: string) {
  const stage = cache.stage(projectId, digest(name), reservedBytes, allowEffect);
  try {return stage.publish(writeProxy(stage.directory));} finally {stage.discard();}
}

test('the default cache limit is 10 GiB and a small custom quota refuses an oversized reservation', t => {
  const standard = fixture(t);
  assert.deepEqual(standard.cache.stats(standard.projectId), {usedBytes: 0, limitBytes: 10 * 1024 ** 3});
  assert.equal(existsSync(standard.root), false);
  const limited = fixture(t, {limitBytes: quota});
  assert.deepEqual(limited.cache.stats(limited.projectId), {usedBytes: 0, limitBytes: quota});
  assert.throws(() => limited.cache.stage(limited.projectId, digest('oversized'), quota + 1, allowEffect), {code: 'CACHE_LIMIT'});
  assert.deepEqual(readdirSync(limited.root), []);
});

test('LRU uses the last access and enforces one quota across projects', t => {
  const {cache, projectId} = fixture(t, {limitBytes: quota});
  const otherProjectId = randomUUID();
  const first = publish(cache, projectId, 'first');
  const second = publish(cache, otherProjectId, 'second');
  utimesSync(first.directory, new Date(2020, 0, 1), new Date(2020, 0, 1));
  utimesSync(second.directory, new Date(2020, 0, 2), new Date(2020, 0, 2));
  cache.touch(first, allowEffect);
  assert.ok(first.usedBytes + second.usedBytes + reservedBytes > quota);

  const newest = publish(cache, projectId, 'newest');
  assert.equal(cache.lookup(projectId, first.cacheKey)?.directory, first.directory);
  assert.equal(cache.lookup(otherProjectId, second.cacheKey), null);
  assert.deepEqual(cache.stats(projectId), {usedBytes: first.usedBytes + newest.usedBytes, limitBytes: quota});
  assert.deepEqual(cache.stats(otherProjectId), {usedBytes: 0, limitBytes: quota});
});

test('persisted clip references and active reference counts block eviction', t => {
  const {cache, open, projectId} = fixture(t, {limitBytes: quota});
  const clip = publish(cache, projectId, 'clip reference');
  const active = publish(cache, projectId, 'active reference');
  cache.setPins(projectId, [clip.cacheKey], allowEffect);

  const reopened = open();
  const release = reopened.pin(active.cacheKey);
  const releaseOther = reopened.pin(active.cacheKey);
  const reserveNew = () => reopened.stage(projectId, digest('new'), reservedBytes, allowEffect);
  assert.throws(reserveNew, {code: 'CACHE_LIMIT'});
  release();
  release();
  assert.throws(reserveNew, {code: 'CACHE_LIMIT'});
  assert.deepEqual(reopened.clear(projectId, allowEffect), {freedBytes: 0});
  releaseOther();
  const stage = reserveNew();
  stage.discard();
  assert.equal(reopened.lookup(projectId, active.cacheKey), null);
  assert.equal(reopened.lookup(projectId, clip.cacheKey)?.directory, clip.directory);
  reopened.setPins(projectId, [], allowEffect);
  assert.deepEqual(reopened.clear(projectId, allowEffect), {freedBytes: clip.usedBytes});
});

test('clearing a project frees its unpinned bytes and keeps every other project’s files', t => {
  const {cache, projectId} = fixture(t, {limitBytes: 4 * quota});
  const otherProjectId = randomUUID();
  const removable = publish(cache, projectId, 'removable');
  const protectedEntry = publish(cache, projectId, 'busy');
  const unrelated = publish(cache, otherProjectId, 'other project');
  const release = cache.pin(protectedEntry.cacheKey);

  assert.deepEqual(cache.clear(projectId, allowEffect), {freedBytes: removable.usedBytes});
  assert.equal(cache.lookup(projectId, removable.cacheKey), null);
  assert.equal(cache.lookup(projectId, protectedEntry.cacheKey)?.directory, protectedEntry.directory);
  assert.equal(cache.lookup(projectId, unrelated.cacheKey), null);
  assert.equal(cache.lookup(otherProjectId, unrelated.cacheKey)?.directory, unrelated.directory);
  assert.deepEqual(cache.stats(otherProjectId), {usedBytes: unrelated.usedBytes, limitBytes: 4 * quota});
  release();
  assert.deepEqual(cache.clear(projectId, allowEffect), {freedBytes: protectedEntry.usedBytes});
  assert.deepEqual(cache.clear(projectId, allowEffect), {freedBytes: 0});
});

test('insufficient disk space fails before eviction or creation of a staging directory', t => {
  let available = freeBytes();
  const {cache, root, projectId} = fixture(t, {limitBytes: 4 * quota, freeBytes: () => available});
  const old = publish(cache, projectId, 'existing');
  available = 0n;
  assert.ok(old.usedBytes < 2 * reservedBytes);
  assert.throws(() => cache.stage(projectId, digest('larger'), 2 * reservedBytes, allowEffect), {code: 'DISK_FULL'});
  assert.equal(cache.lookup(projectId, old.cacheKey)?.directory, old.directory);
  assert.deepEqual(readdirSync(root), [old.cacheKey]);
});

test('publication makes the complete private stage visible at once and preserves a winning same-key attempt', t => {
  const {cache, root, projectId} = fixture(t, {limitBytes: 4 * quota});
  const key = digest('same key');
  const target = path.join(root, key);
  let stagedReceipt = false;
  const first = cache.stage(projectId, key, reservedBytes, () => {
    if (existsSync(root) && readdirSync(root).some(name => name.startsWith('stage-') && existsSync(path.join(root, name, 'receipt.json')))) {
      assert.equal(existsSync(target), false);
      stagedReceipt = true;
    }
  });
  const competing = cache.stage(projectId, key, reservedBytes, allowEffect);
  try {
    assert.notEqual(first.directory, competing.directory);
    if (process.platform !== 'win32') assert.equal(statSync(first.directory).mode & 0o777, 0o700);
    const result = writeProxy(first.directory);
    const otherResult = writeProxy(competing.directory, 70);
    assert.equal(cache.lookup(projectId, key), null);
    assert.equal(existsSync(target), false);

    const published = first.publish(result);
    assert.equal(stagedReceipt, true);
    assert.equal(existsSync(first.directory), false);
    assert.equal(published.directory, target);
    assert.deepEqual(published.result, result);
    assert.deepEqual(readdirSync(target).sort(), ['clock.json', 'proxy.mkv', 'receipt.json']);
    assert.throws(() => competing.publish(otherResult), {code: 'CACHE_LIMIT'});
    competing.discard();
    assert.deepEqual(readdirSync(root), [key]);
    assert.deepEqual(cache.lookup(projectId, key)?.result, result);
    assert.equal(digest(readFileSync(path.join(target, 'proxy.mkv'))), result.files[0]!.sha256);
  } finally {first.discard(); competing.discard();}
});

test('discard removes only the stage whose filesystem identity it owns', t => {
  const {cache, root, projectId} = fixture(t, {limitBytes: quota});
  const stage = cache.stage(projectId, digest('stage'), reservedBytes, allowEffect);
  const detached = path.join(root, 'detached');
  renameSync(stage.directory, detached);
  mkdirSync(stage.directory, {mode: 0o700});
  const replacement = path.join(stage.directory, 'replacement');
  writeFileSync(replacement, 'retained', {mode: 0o600});

  assert.throws(() => stage.discard(), {code: 'CACHE_LIMIT'});
  assert.equal(readFileSync(replacement, 'utf8'), 'retained');
  assert.equal(existsSync(detached), true);
  assert.throws(() => cache.stage(projectId, digest('cannot evict a retained stage'), quota, allowEffect), {code: 'CACHE_LIMIT'});
  const next = cache.stage(projectId, digest('another stage'), quota - Buffer.byteLength('retained'), allowEffect);
  next.discard();
  assert.deepEqual(readdirSync(root).sort(), ['detached', path.basename(stage.directory)].sort());
});

test('an incomplete owned entry can be rebuilt under the same key', t => {
  const {cache, projectId} = fixture(t, {limitBytes: quota});
  const old = publish(cache, projectId, 'rebuild');
  rmSync(path.join(old.directory, 'proxy.mkv'));
  assert.equal(cache.lookup(projectId, old.cacheKey), null);
  cache.setPins(projectId, [old.cacheKey], allowEffect);
  const replacement = publish(cache, projectId, 'rebuild');
  assert.equal(replacement.cacheKey, old.cacheKey);
  assert.equal(cache.lookup(projectId, old.cacheKey)?.directory, old.directory);
});
