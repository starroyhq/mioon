import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, realpath, lstat, rm, readdir, rename, mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {withOwnedTestCompileCache} from '../../scripts/lib/test-compile-cache.ts';
const execute = promisify(execFile);
const env = {PATH: process.env.PATH || '', HOME: tmpdir(), TMPDIR: tmpdir(), LANG: 'C.UTF-8'};
const helper = new URL('../../scripts/lib/test-compile-cache.ts', import.meta.url).href;
const node = (source: string, environment: NodeJS.ProcessEnv) => execute(process.execPath, ['--input-type=module', '-e', source], {env: environment, timeout: 12000, killSignal: 'SIGKILL', encoding: 'utf8'});

test('opt-in cache is private, active in actual child, source-invalidating and removed', {timeout: 45000}, async t => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'mioon-cache-source-')); t.after(() => rm(sourceRoot, {recursive: true, force: true}));
  const source = path.join(sourceRoot, 'value.ts'), records: Array<Record<string, unknown>> = []; let ownedRoot = '';
  await withOwnedTestCompileCache(env, async childEnv => {
    ownedRoot = childEnv.NODE_COMPILE_CACHE!;
    const info = await lstat(ownedRoot); assert.equal(info.isDirectory(), true); assert.equal(info.mode & 0o077, 0);
    assert.equal(childEnv.NODE_OPTIONS, undefined); assert.equal(childEnv.HTTPS_PROXY, undefined);
    for (const value of [1, 2]) {
      await writeFile(source, `export const value: number = ${value};\n`);
      const {stdout} = await node(`import {value} from ${JSON.stringify(pathToFileURL(source).href)};import {inheritedTestCompileCache} from ${JSON.stringify(helper)};import {getCompileCacheDir} from 'node:module';console.log(JSON.stringify({value,active:getCompileCacheDir(),forward:inheritedTestCompileCache()}));`, childEnv);
      const result = JSON.parse(stdout); assert.equal(result.value, value, 'changed source must never replay cached old semantics');
      assert.equal(path.dirname(result.active), ownedRoot); assert.deepEqual(result.forward, {NODE_COMPILE_CACHE: ownedRoot, MIOON_TEST_COMPILE_CACHE_ROOT: ownedRoot});
    }
    assert.ok((await readdir(ownedRoot)).length > 0);
  }, {source: {NODE_COMPILE_CACHE: '/caller-cache-must-not-be-used', NODE_OPTIONS: '--require=untrusted'}, report: entry => records.push(entry)});
  await assert.rejects(lstat(ownedRoot), {code: 'ENOENT'});
  assert.deepEqual(records.map(entry => entry.status), ['preparing', 'active', 'removed']);
});
test('explicit nonempty disable remains authoritative and creates no cache', {timeout: 15000}, async () => {
  const records: Array<Record<string, unknown>> = [];
  await withOwnedTestCompileCache(env, async childEnv => {
    assert.equal(childEnv.NODE_COMPILE_CACHE, undefined); assert.equal(childEnv.NODE_DISABLE_COMPILE_CACHE, '1');
    const {stdout} = await node(`import {getCompileCacheDir} from 'node:module';console.log(getCompileCacheDir()??'disabled');`, childEnv);
    assert.equal(stdout, 'disabled\n');
  }, {source: {NODE_DISABLE_COMPILE_CACHE: '0'}, report: entry => records.push(entry)});
  assert.deepEqual(records.map(entry => entry.status), ['disabled-by-environment']);
});
test('owned cache cleanup preserves original callback failure', {timeout: 15000}, async () => {
  const failure = Error('original test command failure'); let root = '';
  await assert.rejects(withOwnedTestCompileCache(env, async childEnv => {root = childEnv.NODE_COMPILE_CACHE!; throw failure;}, {source: {}, report: () => {}}), error => error === failure);
  await assert.rejects(lstat(root), {code: 'ENOENT'});
});
for (const code of [1, 130, 143]) test(`owned cache cleanup retains terminal test outcome ${code}`, {timeout: 15000}, async () => {
  let root = '';
  const outcome = await withOwnedTestCompileCache(env, async childEnv => {root = childEnv.NODE_COMPILE_CACHE!; return {code};}, {source: {}, report: () => {}});
  assert.deepEqual(outcome, {code}); await assert.rejects(lstat(root), {code: 'ENOENT'});
});
test('cache propagation refuses arbitrary inherited cache without owned marker', {timeout: 15000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-cache-unmarked-')); t.after(() => rm(root, {recursive: true, force: true}));
  const {stdout} = await node(`import {inheritedTestCompileCache} from ${JSON.stringify(helper)};console.log(JSON.stringify(inheritedTestCompileCache()));`, {...env, NODE_COMPILE_CACHE: root});
  assert.equal(stdout, '{}\n');
});
test('cache cleanup refuses a replaced directory and preserves original failure', {timeout: 15000}, async t => {
  let root = '', relocated = ''; const failure = Error('original failed invocation');
  t.after(async () => {if (root) await rm(root, {recursive: true, force: true}); if (relocated) await rm(relocated, {recursive: true, force: true});});
  await assert.rejects(withOwnedTestCompileCache(env, async childEnv => {
    root = childEnv.NODE_COMPILE_CACHE!; relocated = `${root}-relocated`;
    await rename(root, relocated); await mkdir(root, {mode: 0o700}); await writeFile(path.join(root, 'untouched'), 'keep'); throw failure;
  }, {source: {}, report: () => {}}), error => error instanceof AggregateError && error.errors[0] === failure && /identity changed/u.test(String(error.errors[1])));
  assert.equal(await readFile(path.join(root, 'untouched'), 'utf8'), 'keep');
});

for (const signal of ['SIGINT', 'SIGTERM']) for (const phase of ['setup', 'cleanup']) {
  test(`real ${signal} during cache ${phase} removes owned cache and retains signal outcome`, {timeout: 30000}, async () => {
    const script = `import {withOwnedTestCompileCache} from ${JSON.stringify(helper)};
      const before=['SIGINT','SIGTERM'].map(x=>process.listenerCount(x));let sent=false;
      const report=x=>{console.log(JSON.stringify(x));if(${JSON.stringify(phase)}==='setup'&&x.status==='preparing'&&!sent){sent=true;process.kill(process.pid,${JSON.stringify(signal)});}};
      try{await withOwnedTestCompileCache({PATH:process.env.PATH||'',HOME:process.env.HOME},async()=>{if(${JSON.stringify(phase)}==='cleanup')process.kill(process.pid,${JSON.stringify(signal)});return {code:0};},{source:{},report});process.exitCode=0;}
      catch(error){console.log(JSON.stringify({outcome:error.code,cleanupFailed:Boolean(error.cacheCleanupFailed),before,after:['SIGINT','SIGTERM'].map(x=>process.listenerCount(x))}));process.exitCode=error.exitCode||1;}`;
    let failure: any;
    try {await node(script, env);} catch (error) {failure = error;}
    assert.ok(failure); assert.equal(failure.signal, null); assert.equal(failure.code, signal === 'SIGINT' ? 130 : 143);
    const records = failure.stdout.trim().split('\n').map((line: string) => JSON.parse(line));
    const prepared = records.find((entry: any) => entry.status === 'preparing'), removed = records.find((entry: any) => entry.status === 'removed');
    assert.ok(prepared); assert.equal(removed.cacheId, prepared.cacheId);
    const outcome = records.at(-1); assert.equal(outcome.outcome, 'TEST_COMPILE_CACHE_INTERRUPTED'); assert.equal(outcome.cleanupFailed, false); assert.deepEqual(outcome.after, outcome.before);
    await assert.rejects(lstat(path.join(await realpath(tmpdir()), prepared.cacheId)), {code: 'ENOENT'});
  });
}
test('real interruption retains a visible refused-cleanup diagnostic and restores listeners', {timeout: 30000}, async t => {
  const script = `import {withOwnedTestCompileCache} from ${JSON.stringify(helper)};import {rename,mkdir,writeFile} from 'node:fs/promises';
    const before=['SIGINT','SIGTERM'].map(x=>process.listenerCount(x));
    try{await withOwnedTestCompileCache({PATH:process.env.PATH||'',HOME:process.env.HOME},async env=>{const r=env.NODE_COMPILE_CACHE;await rename(r,r+'-relocated');await mkdir(r,{mode:0o700});await writeFile(r+'/untouched','keep');process.kill(process.pid,'SIGTERM');return {code:0};},{source:{},report:x=>console.log(JSON.stringify(x))});}
    catch(error){console.log(JSON.stringify({outcome:error.code,cleanupFailed:Boolean(error.cacheCleanupFailed),before,after:['SIGINT','SIGTERM'].map(x=>process.listenerCount(x))}));process.exitCode=error.exitCode||1;}`;
  let failure: any; try {await node(script, env);} catch (error) {failure = error;}
  assert.ok(failure); assert.equal(failure.signal, null); assert.equal(failure.code, 143);
  const records = failure.stdout.trim().split('\n').map((line: string) => JSON.parse(line));
  const root = path.join(await realpath(tmpdir()), records.find((entry: any) => entry.status === 'preparing').cacheId);
  t.after(async () => {await rm(root, {recursive: true, force: true}); await rm(`${root}-relocated`, {recursive: true, force: true});});
  assert.equal(await readFile(path.join(root, 'untouched'), 'utf8'), 'keep');
  const outcome = records.at(-1); assert.equal(outcome.outcome, 'TEST_COMPILE_CACHE_INTERRUPTED'); assert.equal(outcome.cleanupFailed, true); assert.deepEqual(outcome.after, outcome.before);
});
