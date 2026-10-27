import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, copyFile, rm, truncate, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {finished} from 'node:stream/promises';
import type {Writable} from 'node:stream';
import {hashPackageFile, verifyArchiveMember, PACKAGE_FILE_LIMIT} from '../apps/desktop/archive-member.ts';

const exec = promisify(execFile), base = 'mioon-0.1.0-linux-x64', member = `${base}/resources/app.asar`;
const require = createRequire(import.meta.url), builder = createRequire(require.resolve('electron-builder'));
const libraries = createRequire(builder.resolve('app-builder-lib'));
const asar = libraries('@electron/asar') as {createPackage(source: string, destination: string): Promise<Writable>; listPackage(file: string): string[]};
async function fixture(t: test.TestContext, realLargeAsar = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-archive-member-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const input = path.join(directory, 'input'), native = path.join(directory, 'native.asar'), entry = path.join(input, member), tarball = path.join(directory, 'delivered.tar.gz');
  await mkdir(path.dirname(entry), {recursive:true});
  if (realLargeAsar) {
    const source = path.join(directory, 'asar-source'); await mkdir(source);
    await writeFile(path.join(source, 'backend.cjs'), Buffer.alloc(12*1024*1024, 0x61));
    const output = await asar.createPackage(source, native); await finished(output);
    assert.deepEqual(asar.listPackage(native), ['/backend.cjs']);
  } else await writeFile(native, Buffer.from('reviewed native member bytes'));
  await copyFile(native, entry);
  const pack = async (members = [member]): Promise<void> => {await exec('tar', ['-czf', tarball, '-C', input, ...members], {timeout:30000,maxBuffer:64*1024});};
  await pack(); return {directory,input,native,entry,tarball,pack};
}
test('real ASAR over 10MiB is streamed completely and matches independently computed bytes and SHA256', async t => {
  const f = await fixture(t, true), native = await readFile(f.native);
  assert.ok(native.length > 10*1024*1024);
  assert.deepEqual(await verifyArchiveMember(f.tarball, member, f.native), {bytes:native.length,sha256:createHash('sha256').update(native).digest('hex')});
});
test('same-sized changed member, shorter member and longer member remain rejected', async t => {
  const f = await fixture(t), native = await readFile(f.native);
  const changed = Buffer.from(native); changed[changed.length-1] ^= 1;
  await writeFile(f.entry, changed); await f.pack();
  await assert.rejects(verifyArchiveMember(f.tarball, member, f.native), /ARCHIVE_MEMBER_SHA256_MISMATCH/);
  await writeFile(f.entry, native.subarray(1)); await f.pack();
  await assert.rejects(verifyArchiveMember(f.tarball, member, f.native), /ARCHIVE_MEMBER_SIZE_MISMATCH/);
  await writeFile(f.entry, Buffer.concat([native, Buffer.from('extra')])); await f.pack();
  await assert.rejects(verifyArchiveMember(f.tarball, member, f.native), /ARCHIVE_MEMBER_LIMIT_EXCEEDED/);
});
test('corrupted gzip, missing member and duplicate member never validate as the delivered file', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyArchiveMember(f.tarball, `${base}/missing.asar`, f.native), /ARCHIVE_EXTRACTION_FAILED/);
  await f.pack([member, member]);
  await assert.rejects(verifyArchiveMember(f.tarball, member, f.native), /ARCHIVE_MEMBER_LIMIT_EXCEEDED/);
  await writeFile(f.tarball, Buffer.from('not a gzip archive'));
  await assert.rejects(verifyArchiveMember(f.tarball, member, f.native), /ARCHIVE_EXTRACTION_FAILED/);
  await f.pack(); const gzip = await readFile(f.tarball);
  await writeFile(f.tarball, gzip.subarray(0, gzip.length-8));
  await assert.rejects(verifyArchiveMember(f.tarball, member, f.native), /ARCHIVE_EXTRACTION_FAILED/);
});
test('a nonzero extractor exit rejects even after every expected byte has been produced', async t => {
  const f = await fixture(t), bytes = await readFile(f.native);
  await assert.rejects(verifyArchiveMember(f.tarball, member, f.native, {extract:() => spawn(process.execPath, ['-e', `process.stdout.write(Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64'));process.exitCode=2;`], {stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'})}), /ARCHIVE_EXTRACTION_FAILED/);
});
test('a stalled extractor is terminated within its bounded deadline', async t => {
  const f = await fixture(t); let child: ReturnType<typeof spawn> | undefined;
  await assert.rejects(verifyArchiveMember(f.tarball, member, f.native, {timeoutMs:50,extract:() => {
    const producer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);'], {stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'}); child=producer; return producer;
  }}), /ARCHIVE_EXTRACTION_TIMEOUT/);
  const pid = child?.pid; assert.ok(pid); assert.throws(() => process.kill(pid, 0), {code:'ESRCH'});
});
test('file hard limits, unsafe paths and symlinks reject before an extractor can run', async t => {
  const f = await fixture(t); let calls = 0;
  const extract = () => {calls++; return spawn(process.execPath, ['-e', ''], {stdio:['ignore','pipe','pipe']});};
  await assert.rejects(verifyArchiveMember(f.tarball, member, f.native, {maxBytes:1,extract}), /PACKAGE_FILE_LIMIT_EXCEEDED/);
  for (const entry of ['../app.asar', '/app.asar', 'base/../app.asar', 'base//app.asar', 'base\\app.asar'])
    await assert.rejects(verifyArchiveMember(f.tarball, entry, f.native, {extract}), /ARCHIVE_MEMBER_PATH_INVALID/);
  const link = path.join(f.directory, 'linked.asar'); await symlink(f.native, link);
  await assert.rejects(verifyArchiveMember(f.tarball, member, link, {extract}), /PACKAGE_FILE_UNSAFE/);
  await truncate(f.tarball, PACKAGE_FILE_LIMIT+1);
  await assert.rejects(verifyArchiveMember(f.tarball, member, f.native, {extract}), /PACKAGE_FILE_LIMIT_EXCEEDED/);
  assert.equal(calls,0);
  await assert.rejects(hashPackageFile(link), /PACKAGE_FILE_UNSAFE/);
});
