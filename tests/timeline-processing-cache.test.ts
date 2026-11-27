import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, createHmac, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {createProcessingCache, processingReceiptDigest} from '../packages/business/src/timeline-processing/cache.ts';
import type {ProcessingCache} from '../packages/business/src/timeline-processing/cache.ts';
import {PROCESSING_PREVIEW_PROXY_PROFILE as previewProfile, PROCESSING_REVERSE_PROXY_PROFILE as reverseProfile,
  processingProxyResultSchema} from '../packages/contracts/src/timeline-processing-storage.ts';
import type {ProcessingCacheReceipt} from '../packages/contracts/src/timeline-processing-storage.ts';
import {testEnv} from './helpers/test-env.ts';

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
  return {parent, root, open, cache: open(), projectId: randomUUID()};
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

test('optical segments and their playlist count against the quota after reopening the cache', t => {
  const limitBytes = 128;
  const {cache, open, projectId} = fixture(t, {limitBytes});
  const stage = cache.stage(projectId, digest('optical reservation'), limitBytes, allowEffect,
    {taskId: randomUUID(), requestId: randomUUID()});
  for (let block = 0; block < 16; block++) {
    const file = `optical-${String(block).padStart(5, '0')}.mkv`;
    writeFileSync(path.join(stage.directory, file), Buffer.alloc(4), {mode: 0o600});
  }
  writeFileSync(path.join(stage.directory, 'optical.ffconcat'), Buffer.alloc(4), {mode: 0o600});
  stage.retain();

  const reopened = open(), remaining = limitBytes - 68, key = digest('competing reservation');
  assert.deepEqual(reopened.stats(projectId), {usedBytes: 68, limitBytes});
  assert.throws(() => reopened.stage(projectId, key, limitBytes, allowEffect), {code: 'CACHE_LIMIT'});
  assert.throws(() => reopened.stage(projectId, key, remaining + 1, allowEffect), {code: 'CACHE_LIMIT'});
  const competing = reopened.stage(projectId, key, remaining, allowEffect);
  competing.discard();
  assert.deepEqual(reopened.stats(projectId), {usedBytes: 68, limitBytes});
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

test('preview MP4 receipts and lossless reverse receipts cannot cross profiles', async t => {
  const {cache, projectId} = fixture(t, {limitBytes: quota});
  const lossless = publish(cache, projectId, 'lossless');
  const stage = cache.stage(projectId, digest('preview'), reservedBytes, allowEffect);
  try {
    const payload = writeProxy(stage.directory);
    const files = payload.files.map(file => file.fileName === 'proxy.mkv' ? {...file, fileName: 'preview.mp4'} : file);
    const preview = {...payload, profileId: previewProfile, files};
    assert.equal(processingProxyResultSchema.safeParse({...payload, profileId: previewProfile}).success, false);
    assert.equal(processingProxyResultSchema.safeParse({...preview, profileId: reverseProfile}).success, false);
    assert.equal(processingProxyResultSchema.safeParse({...preview, sampleCount: 1}).success, false);
    renameSync(path.join(stage.directory, 'proxy.mkv'), path.join(stage.directory, 'preview.mp4'));
    const output = stage.publish(preview);

    const proof = cache.lookupWithClock(projectId, output.cacheKey, previewProfile);
    assert.ok(proof);
    assert.equal(proof.clock.toString('utf8'), '{}');
    assert.equal(proof.digest, processingReceiptDigest({...output, usedBytes: 0, directory: stage.directory}));
    assert.equal(cache.lookupWithClock(projectId, lossless.cacheKey, previewProfile), null);
    assert.equal(await cache.acquire(projectId, output.cacheKey, reverseProfile), null);
    assert.equal(await cache.acquire(randomUUID(), output.cacheKey, previewProfile), null);
    assert.equal(await cache.acquire(projectId, output.cacheKey, previewProfile, {expectedDigest: '0'.repeat(64)}), null);

    const lease = await cache.acquire(projectId, output.cacheKey, previewProfile, {expectedDigest: proof.digest});
    assert.ok(lease);
    try {
      lease.verify();
      assert.equal(lease.digest, proof.digest);
      assert.equal(lease.entry.result.profileId, previewProfile);
      assert.deepEqual(cache.clear(projectId, allowEffect), {freedBytes: lossless.usedBytes});
    } finally {lease.release();}
    lease.release();
    assert.throws(lease.verify, {code: 'PROCESSING_FAILED'});
    assert.deepEqual(cache.clear(projectId, allowEffect), {freedBytes: output.usedBytes});
  } finally {stage.discard();}
});

test('a cached clock and media must match their recorded SHA before consumption', async t => {
  const {cache, projectId} = fixture(t, {limitBytes: quota});
  const output = publish(cache, projectId, 'corrupted media');
  writeFileSync(path.join(output.directory, 'proxy.mkv'), Buffer.alloc(1024, 43));
  assert.ok(cache.lookupWithClock(projectId, output.cacheKey, reverseProfile), 'clock evidence is still valid');
  assert.equal(await cache.acquire(projectId, output.cacheKey, reverseProfile), null);
  writeFileSync(path.join(output.directory, 'clock.json'), '[]');
  assert.equal(cache.lookupWithClock(projectId, output.cacheKey, reverseProfile), null);
  assert.deepEqual(cache.clear(projectId, allowEffect), {freedBytes: output.usedBytes});
});

test('a verified lease detects an inode replacement with identical bytes and then releases its pin', async t => {
  const {cache, root, projectId} = fixture(t, {limitBytes: quota});
  const output = publish(cache, projectId, 'inode replacement');
  const lease = await cache.acquire(projectId, output.cacheKey, reverseProfile);
  assert.ok(lease);
  try {
    lease.verify();
    const file = path.join(output.directory, 'proxy.mkv');
    const moved = path.join(root, 'original-proxy');
    renameSync(file, moved);
    writeFileSync(file, readFileSync(moved), {flag: 'wx', mode: 0o600});
    assert.throws(lease.verify, {code: 'PROCESSING_FAILED'});
    assert.deepEqual(cache.clear(projectId, allowEffect), {freedBytes: 0});
  } finally {lease.release();}
  assert.deepEqual(cache.clear(projectId, allowEffect), {freedBytes: output.usedBytes});
});

test('the lease pins media during descriptor validation and releases it on cancellation', async t => {
  const {cache, projectId} = fixture(t, {limitBytes: quota});
  const output = publish(cache, projectId, 'pending lease');
  const controller = new AbortController();
  const interruption = new Error('Project lease ended');
  const acquisition = cache.acquire(projectId, output.cacheKey, reverseProfile, {signal: controller.signal});
  assert.deepEqual(cache.clear(projectId, allowEffect), {freedBytes: 0});
  controller.abort(interruption);
  await assert.rejects(acquisition, error => error === interruption);
  assert.deepEqual(cache.clear(projectId, allowEffect), {freedBytes: output.usedBytes});
});

test('an attempt can grow its reservation on demand without counting written bytes twice', t => {
  let available = freeBytes();
  const {cache, projectId} = fixture(t, {limitBytes: quota, freeBytes: () => available});
  const shared = publish(cache, projectId, 'existing proxy');
  const release = cache.pin(shared.cacheKey);
  const stage = cache.stage(projectId, digest('streaming proxy'), 1100, allowEffect,
    {taskId: randomUUID(), requestId: randomUUID()});
  try {
    const rendered = writeProxy(stage.directory);
    available = BigInt(1700 - rendered.files.reduce((sum, file) => sum + file.bytes, 0));
    stage.grow(1700);
    assert.throws(() => stage.grow(1701), {code: 'DISK_FULL'});
    assert.throws(() => stage.grow(quota + 1), {code: 'CACHE_LIMIT'});
    const result = stage.publish(rendered);
    assert.equal(cache.lookup(projectId, result.cacheKey)?.usedBytes, result.usedBytes);
    assert.equal(cache.lookup(projectId, shared.cacheKey)?.directory, shared.directory);
  } finally {stage.discard(); release();}
});

function processGone(pid: number): boolean {
  try {process.kill(pid, 0); return false;}
  catch (error) {return (error as NodeJS.ErrnoException).code === 'ESRCH';}
}

test('a killed stage owner is reaped only after its recorded writer exits', {timeout: 20000}, async t => {
  const {parent, root, open, projectId} = fixture(t), otherProjectId = randomUUID();
  const cacheModule = new URL('../packages/business/src/timeline-processing/cache.ts', import.meta.url).href;
  const stop = path.join(parent, 'finish-writer'), pidFile = path.join(parent, 'writer-ready');
  const writerScript = `import {closeSync,existsSync,writeFileSync,writeSync} from 'node:fs';
    writeSync(3, 'writer payload');
    writeFileSync(process.argv[2], 'ready', {mode: 0o600});
    const timer = setInterval(() => {
      if (existsSync(process.argv[1])) {closeSync(3); clearInterval(timer);}
    }, 20);`;
  const hostScript = `import {spawn} from 'node:child_process';
    import {closeSync,openSync} from 'node:fs';
    import path from 'node:path';
    import {createProcessingCache} from ${JSON.stringify(cacheModule)};
    const [parent, projectId, cacheKey, taskId, requestId, stop, ready] = process.argv.slice(1);
    const stage = createProcessingCache(parent).stage(projectId, cacheKey, 1024, () => {}, {taskId,requestId});
    const writer = stage.writer.begin();
    const fd = openSync(path.join(stage.directory,'proxy.mkv'), 'wx', 0o600);
    const child = spawn(process.execPath, ['--input-type=module','-e',${JSON.stringify(writerScript)},stop,ready],
      {stdio:['ignore','ignore','ignore',fd]});
    closeSync(fd);
    writer.started(child.pid);
    process.send({directory:stage.directory, pid: child.pid});`;
  const taskId = randomUUID(), requestId = randomUUID(), cacheKey = digest('killed owner');
  const host = spawn(process.execPath, ['--input-type=module', '-e', hostScript, parent, projectId, cacheKey, taskId, requestId, stop, pidFile],
    {env: testEnv(), stdio: ['ignore', 'ignore', 'inherit', 'ipc']});
  let writerPid: number | undefined;
  try {
    const [message] = await once(host, 'message', {signal: AbortSignal.timeout(5000)}) as [{directory: string; pid: number}];
    writerPid = message.pid;
    for (let attempt = 0; !existsSync(pidFile) && attempt < 100; attempt++) await sleep(20);
    assert.equal(existsSync(pidFile), true);
    const exiting = once(host, 'exit');
    host.kill('SIGKILL');
    const [, signal] = await exiting;
    assert.equal(signal, 'SIGKILL');
    assert.equal(processGone(writerPid), false);

    const cache = open();
    const payloadBytes = Buffer.byteLength('writer payload');
    assert.deepEqual(cache.stats(projectId), {usedBytes: payloadBytes, limitBytes: 10 * 1024 ** 3});
    assert.equal(cache.stats(otherProjectId).usedBytes, 0);
    assert.deepEqual(cache.reap(projectId, allowEffect), {freedBytes: 0});
    assert.deepEqual(cache.clear(projectId, allowEffect), {freedBytes: 0});
    assert.equal(existsSync(message.directory), true);

    writeFileSync(stop, '', {mode: 0o600});
    for (let attempt = 0; !processGone(writerPid) && attempt < 200; attempt++) await sleep(20);
    assert.equal(processGone(writerPid), true);
    assert.deepEqual(cache.clear(otherProjectId, allowEffect), {freedBytes: 0});
    assert.equal(existsSync(message.directory), true);

    const marker = `${message.directory}.owner.json`;
    const forged = mkdtempSync(path.join(root, `stage-${randomUUID()}-`));
    const originalMarker = readFileSync(marker, 'utf8');
    const copied = JSON.parse(originalMarker);
    assert.equal(copied.ownership.taskId, taskId);
    assert.equal(copied.ownership.requestId, requestId);
    assert.equal(copied.ownership.cacheKey, cacheKey);
    copied.ownership.stage = path.basename(forged);
    writeFileSync(`${forged}.owner.json`, JSON.stringify(copied), {mode: 0o600});
    writeFileSync(path.join(forged, 'proxy.mkv'), 'forged', {mode: 0o600});
    const legacy = mkdtempSync(path.join(root, `stage-${randomUUID()}-`));
    writeFileSync(path.join(legacy, 'proxy.mkv'), 'unproven', {mode: 0o600});
    // Simulate dev:ino reuse with a properly signed mark from the earlier
    // creation. The signature and inode match, while the creation time does not.
    const earlier = JSON.parse(originalMarker);
    earlier.ownership.directoryBirthtime -= 10_000;
    earlier.mac = createHmac('sha256', readFileSync(path.join(root, '.stage-ownership.key')))
      .update(JSON.stringify(earlier.ownership)).digest('hex');
    writeFileSync(marker, JSON.stringify(earlier));
    assert.deepEqual(cache.reap(projectId, allowEffect), {freedBytes: 0});
    assert.equal(existsSync(message.directory), true);
    writeFileSync(marker, originalMarker);
    if (process.platform !== 'win32') {
      const link = path.join(message.directory, 'clock.json');
      symlinkSync(path.join(forged, 'proxy.mkv'), link);
      assert.deepEqual(cache.reap(projectId, allowEffect), {freedBytes: 0});
      rmSync(link);
    }
    const unrelated = path.join(message.directory, 'optical-00000.mkv.bak');
    writeFileSync(unrelated, 'unrecognized', {mode: 0o600});
    assert.deepEqual(cache.reap(projectId, allowEffect), {freedBytes: 0});
    assert.equal(readFileSync(unrelated, 'utf8'), 'unrecognized');
    rmSync(unrelated);
    assert.deepEqual(cache.reap(projectId, allowEffect), {freedBytes: payloadBytes});
    assert.equal(cache.stats(projectId).usedBytes, 0);
    assert.equal(existsSync(message.directory), false);
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(path.join(forged, 'proxy.mkv'), 'utf8'), 'forged');
    assert.equal(readFileSync(path.join(legacy, 'proxy.mkv'), 'utf8'), 'unproven');
  } finally {
    if (!existsSync(stop)) writeFileSync(stop, '', {mode: 0o600});
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
  }
});

test('a killed owner with an unresolved spawn slot leaves its bytes and issued proof intact', {timeout: 10000}, async t => {
  const {parent, root, open, projectId} = fixture(t);
  const cacheModule = new URL('../packages/business/src/timeline-processing/cache.ts', import.meta.url).href;
  const script = `import {randomUUID} from 'node:crypto';
    import {writeFileSync} from 'node:fs';
    import path from 'node:path';
    import {createProcessingCache} from ${JSON.stringify(cacheModule)};
    const stage = createProcessingCache(process.argv[1]).stage(process.argv[2], 'a'.repeat(64), 1024, () => {},
      {taskId: randomUUID(), requestId: randomUUID()});
    writeFileSync(path.join(stage.directory, 'proxy.mkv'), 'unconfirmed', {mode: 0o600});
    stage.writer.begin();
    process.kill(process.pid,'SIGKILL');`;
  const host = spawn(process.execPath, ['--input-type=module', '-e', script, parent, projectId], {env: testEnv(), stdio: 'inherit'});
  const [, signal] = await once(host, 'exit');
  assert.equal(signal, 'SIGKILL');
  const before = readdirSync(root), cache = open();
  assert.equal(cache.stats(projectId).usedBytes, Buffer.byteLength('unconfirmed'));
  assert.deepEqual(cache.clear(projectId, allowEffect), {freedBytes: 0});
  assert.deepEqual(readdirSync(root), before);
});
