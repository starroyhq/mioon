import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {activateSearchList,captureSearchList,main,parseSearchList,restoreSearchList,SECURITY_COMMAND_OPTIONS} from '../.github/scripts/apple-keychain.ts';
import type {SecurityExecute} from '../.github/scripts/apple-keychain.ts';

const original = ['/Users/runner/Library/Keychains/login.keychain-db','/Library/Keychains/System.keychain'];
async function fixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(),'mioon-apple-keychain-'))); await chmod(directory,0o700);
  t.after(() => rm(directory,{recursive:true,force:true}));
  const state = path.join(directory,'search list.json'), keychain = path.join(directory,'temporary signing.keychain-db');
  await writeFile(keychain,'synthetic keychain fixture, no certificate or secret');
  const calls: string[][] = []; let current = [...original], failure = false;
  const execute: SecurityExecute = async (file,args,options) => {
    assert.equal(file,'/usr/bin/security'); assert.deepEqual(options,{timeout:30000,maxBuffer:64*1024}); calls.push([...args]);
    if (failure) throw new Error('synthetic-private-error-must-not-escape');
    if (args.length === 3) return current.map(value=>`    ${JSON.stringify(value)}`).join('\n')+'\n';
    assert.deepEqual(args.slice(0,4),['list-keychains','-d','user','-s']); current=[...args.slice(4)]; return '';
  };
  return {directory,state,keychain,calls,execute,get current(){return current;},set current(value:string[]){current=value;},set failure(value:boolean){failure=value;}};
}
test('capture persists only absolute paths privately, activation preserves original entries and deduplicates the temporary identity', async t => {
  const f = await fixture(t); f.current=[...original,f.keychain,original[0]!];
  await captureSearchList(f.state,f.execute);
  assert.deepEqual(JSON.parse(await readFile(f.state,'utf8')),{keychains:[...original,f.keychain,original[0]]});
  if (process.platform!=='win32') assert.equal((await lstat(f.state)).mode&0o777,0o600);
  await activateSearchList(f.state,f.keychain,f.execute);
  assert.deepEqual(f.current,[f.keychain,...original]);
  assert.deepEqual(f.calls.map(args=>args[0]),['list-keychains','list-keychains']);
  assert.equal(f.calls.some(args=>args.includes('default-keychain')),false);
  await restoreSearchList(f.state,f.execute);
  assert.deepEqual(f.current,[...original,f.keychain,original[0]]);
});
test('successful restore removes its state and repeated or initially missing restoration makes no security call', async t => {
  const f = await fixture(t);
  await restoreSearchList(f.state,f.execute); assert.equal(f.calls.length,0);
  await captureSearchList(f.state,f.execute); await activateSearchList(f.state,f.keychain,f.execute);
  await restoreSearchList(f.state,f.execute); assert.deepEqual(f.current,original);
  const count=f.calls.length; await restoreSearchList(f.state,f.execute); assert.equal(f.calls.length,count);
  await assert.rejects(lstat(f.state),{code:'ENOENT'});
});
test('failed activation or restoration retains the original receipt and can restore without leaking raw command errors', async t => {
  const f = await fixture(t); await captureSearchList(f.state,f.execute); const saved=await readFile(f.state,'utf8');
  f.current=[f.keychain]; f.failure=true;
  await assert.rejects(activateSearchList(f.state,f.keychain,f.execute),{message:'APPLE_KEYCHAIN_ACTIVATE_FAILED'});
  await assert.rejects(restoreSearchList(f.state,f.execute),{message:'APPLE_KEYCHAIN_RESTORE_FAILED'});
  assert.equal(await readFile(f.state,'utf8'),saved);
  f.failure=false; await restoreSearchList(f.state,f.execute); assert.deepEqual(f.current,original);
});
test('an originally empty search list is restored exactly after temporary activation', async t => {
  const f = await fixture(t); f.current=[];
  await captureSearchList(f.state,f.execute); await activateSearchList(f.state,f.keychain,f.execute);
  assert.deepEqual(f.current,[f.keychain]); await restoreSearchList(f.state,f.execute); assert.deepEqual(f.current,[]);
});
test('search list parsing supports spaces and JSON-escaped paths but rejects anomalous lines and injection', () => {
  const spaced='/Users/runner/Library/Keychains/a signing keychain-db';
  assert.deepEqual(parseSearchList(`  ${JSON.stringify(spaced)}\n${JSON.stringify('/private/tmp/quote"name.keychain')}\n`),[spaced,'/private/tmp/quote"name.keychain']);
  assert.deepEqual(parseSearchList(''),[]);
  for (const value of ['relative.keychain','"relative.keychain"','"/valid" "another"','{"keychains":[]}','"/valid\\n-injected"','"/valid\\u0000bad"','"/valid"\ncommand -s','x'.repeat(65537)]) assert.throws(()=>parseSearchList(value));
});
test('invalid state JSON, paths, extra fields and insecure state files fail before mutating the search list', async t => {
  const f = await fixture(t);
  for (const value of ['{','null','[]','{}','{"keychains":["relative"]}','{"keychains":["/valid\\n-injected"]}','{"keychains":[],"unexpected":true}']) {
    await writeFile(f.state,value,{mode:0o600});
    await assert.rejects(restoreSearchList(f.state,f.execute)); assert.equal(f.calls.length,0);
  }
  if (process.platform!=='win32') {
    await writeFile(f.state,JSON.stringify({keychains:original})); await chmod(f.state,0o644);
    await assert.rejects(restoreSearchList(f.state,f.execute),{message:'APPLE_KEYCHAIN_STATE_INVALID'}); await chmod(f.state,0o600);
  }
  await rm(f.state); await symlink(f.keychain,f.state);
  await assert.rejects(restoreSearchList(f.state,f.execute),{message:'APPLE_KEYCHAIN_STATE_INVALID'}); assert.equal(f.calls.length,0);
});
test('capture refuses an existing receipt, invalid responses or relative state paths without replacing data', async t => {
  const f = await fixture(t); await writeFile(f.state,'keep original receipt',{mode:0o600});
  await assert.rejects(captureSearchList(f.state,f.execute),{message:'APPLE_KEYCHAIN_STATE_EXISTS'}); assert.equal(f.calls.length,0);
  assert.equal(await readFile(f.state,'utf8'),'keep original receipt'); await rm(f.state);
  await assert.rejects(captureSearchList(f.state,async()=> 'unexpected-output'),{message:'APPLE_KEYCHAIN_RESPONSE_INVALID'});
  await assert.rejects(lstat(f.state),{code:'ENOENT'});
  await assert.rejects(captureSearchList('relative.json',f.execute),{message:'APPLE_KEYCHAIN_PATH_INVALID'});
});
test('CLI rejects unknown or duplicate flags and executes the capture/activate/restore contract through argv only', async t => {
  const f = await fixture(t);
  for (const args of [[],['unknown',`--state=${f.state}`],['capture',`--state=${f.state}`,`--state=${f.state}`],['capture',`--state=${f.state}`,`--keychain=${f.keychain}`],['activate',`--state=${f.state}`],['restore','--state=relative']]) await assert.rejects(main(args,f.execute));
  assert.equal(f.calls.length,0);
  await main(['capture',`--state=${f.state}`],f.execute); await main(['activate',`--state=${f.state}`,`--keychain=${f.keychain}`],f.execute); await main(['restore',`--state=${f.state}`],f.execute);
  assert.deepEqual(f.current,original); assert.deepEqual(SECURITY_COMMAND_OPTIONS,{timeout:30000,maxBuffer:64*1024});
});
