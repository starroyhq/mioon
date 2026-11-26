import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {captureSmokeShutdownDiagnostics} from '../.github/scripts/desktop-smoke.ts';
import {launcherSmokeEnvironment, summarizeLaunchPolicyLog} from '../.github/scripts/release-cli-smoke.ts';
import {EXIT_DIAGNOSTIC_LIMITS} from '../apps/desktop/src/exit-diagnostics.ts';

const secret='synthetic-private-token-url-path-message-must-not-appear';
async function fixture(t: test.TestContext) {
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-ci-native-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const userData=path.join(root,'user-data'),workspace=path.join(userData,'data'),directory=path.join(workspace,'diagnostics');
  await mkdir(directory,{recursive:true,mode:0o700});
  for (const folder of [root,userData,workspace,directory]) await chmod(folder,0o700);
  const backend=path.join(directory,'backend-exit.jsonl'),renderer=path.join(directory,'renderer-health.jsonl');
  return {root,userData,workspace,directory,backend,renderer};
}
test('shutdown snapshot retains only fixed lifecycle fields and recomputes safe renderer classification',async t=>{
  const f=await fixture(t);
  await writeFile(f.backend,JSON.stringify({event:'stop-requested',classification:'normal',reason:'stop-requested',state:'stopping',expected:true,forced:false,
    exitConfirmed:false,shutdownFailed:false,mediaExitConfirmed:true,code:0,termination:null,runId:secret,time:secret,appVersion:secret,
    runtime:{node:secret},path:secret,message:secret,stack:secret,token:secret})+'\n',{mode:0o600});
  await writeFile(f.renderer,JSON.stringify({event:'render-process-gone',reason:'oom',exitCode:137,classification:secret,url:secret,title:secret,appVersion:secret})+'\n',{mode:0o600});
  const snapshot=await captureSmokeShutdownDiagnostics(f.root);
  assert.equal(snapshot.scope,'ok'); assert.equal(snapshot.backend.status,'ok'); assert.equal(snapshot.renderer.status,'ok');
  assert.deepEqual(snapshot.backend.records,[{event:'stop-requested',classification:'normal',reason:'stop-requested',state:'stopping',expected:true,forced:false,
    exitConfirmed:false,shutdownFailed:false,mediaExitConfirmed:true,code:0,termination:null}]);
  assert.deepEqual(snapshot.renderer.records,[{event:'render-process-gone',reason:'oom',exitCode:137,classification:'crashed'}]);
  const text=JSON.stringify(snapshot);assert.ok(!text.includes(secret));assert.ok(!text.includes(f.root));
});
test('transient-file snapshot reports presence without reading token, discovery or database content',async t=>{
  const f=await fixture(t);
  for (const file of ['mcp-connection.json','mcp-token']) await writeFile(path.join(f.userData,file),secret);
  await writeFile(path.join(f.workspace,'server.lock'),secret);await writeFile(path.join(f.workspace,'workbench.sqlite'),secret);
  const snapshot=await captureSmokeShutdownDiagnostics(f.root);
  assert.deepEqual(snapshot.transientFiles,{connectionPresent:true,tokenPresent:true,workspaceLockPresent:true});
  assert.equal(snapshot.backend.status,'missing');assert.equal(snapshot.renderer.status,'missing');assert.ok(!JSON.stringify(snapshot).includes(secret));
  assert.equal(await readFile(path.join(f.workspace,'workbench.sqlite'),'utf8'),secret,'observation never changes the synthetic database');
});
test('missing diagnostic files, workspace or synthetic root produce bounded missing states',async t=>{
  const f=await fixture(t);let snapshot=await captureSmokeShutdownDiagnostics(f.root);
  assert.deepEqual(snapshot.transientFiles,{connectionPresent:false,tokenPresent:false,workspaceLockPresent:false});
  assert.deepEqual(snapshot.backend,{status:'missing',records:[]});assert.deepEqual(snapshot.renderer,{status:'missing',records:[]});
  await rm(f.workspace,{recursive:true});snapshot=await captureSmokeShutdownDiagnostics(f.root);
  assert.equal(snapshot.backend.status,'missing');assert.equal(snapshot.transientFiles.workspaceLockPresent,false);
  await rm(f.root,{recursive:true});snapshot=await captureSmokeShutdownDiagnostics(f.root);assert.equal(snapshot.scope,'missing');
});
test('malformed JSON, non-records, invalid UTF-8 and excessive records are rejected without exposing bytes',async t=>{
  const f=await fixture(t);
  for (const content of [Buffer.from('{'+secret),Buffer.from('null\n'),Buffer.from('[]\n'),Buffer.from([0xff,0xfe])]) {
    await writeFile(f.backend,content);const snapshot=await captureSmokeShutdownDiagnostics(f.root);
    assert.deepEqual(snapshot.backend,{status:'invalid',records:[]});assert.ok(!JSON.stringify(snapshot).includes(secret));
  }
  await writeFile(f.backend,'{}\n'.repeat(257));assert.deepEqual((await captureSmokeShutdownDiagnostics(f.root)).backend,{status:'oversized',records:[]});
});
test('oversized logs and unknown field values cannot enter the report',async t=>{
  const f=await fixture(t);await writeFile(f.backend,Buffer.alloc(EXIT_DIAGNOSTIC_LIMITS.maxBytes+1,0x61));
  await writeFile(f.renderer,JSON.stringify({event:secret,reason:secret,classification:secret,exitCode:secret})+'\n');
  const snapshot=await captureSmokeShutdownDiagnostics(f.root);
  assert.deepEqual(snapshot.backend,{status:'oversized',records:[]});
  assert.deepEqual(snapshot.renderer,{status:'ok',records:[{event:null,reason:null,classification:null,exitCode:null}]});
  assert.ok(!JSON.stringify(snapshot).includes(secret));
});
test('file and directory symlinks or paths outside this synthetic root are rejected without fallback reads',async t=>{
  const f=await fixture(t),target=path.join(f.root,'outside-secret');await writeFile(target,secret);
  await symlink(target,f.backend);let snapshot=await captureSmokeShutdownDiagnostics(f.root);assert.equal(snapshot.backend.status,'unsafe');
  await rm(f.backend);await rm(f.directory,{recursive:true});await symlink(f.root,f.directory,'dir');
  snapshot=await captureSmokeShutdownDiagnostics(f.root);assert.equal(snapshot.backend.status,'unsafe');assert.equal(snapshot.renderer.status,'unsafe');
  await rm(f.directory);await rm(f.workspace,{recursive:true});await symlink(f.root,f.workspace,'dir');
  snapshot=await captureSmokeShutdownDiagnostics(f.root);assert.equal(snapshot.backend.status,'unsafe');assert.equal(snapshot.transientFiles.workspaceLockPresent,null);
  snapshot=await captureSmokeShutdownDiagnostics(path.join(f.root,'nested','mioon-ci-native-ABC123'));assert.equal(snapshot.scope,'unsafe');
  snapshot=await captureSmokeShutdownDiagnostics('relative');assert.equal(snapshot.scope,'unsafe');
  assert.equal(await readFile(target,'utf8'),secret);
});

test('release CLI smoke uses only the owned profile, empty PATH and explicit stopped-message locale', () => {
  const root = '/private/tmp/mioon-cli-test';
  assert.deepEqual(launcherSmokeEnvironment(`${root}/home`, `${root}/tmp`, `${root}/empty`, `${root}/profile`), {
    HOME: `${root}/home`, CFFIXED_USER_HOME: `${root}/home`,
    TMPDIR: `${root}/tmp`, TMP: `${root}/tmp`, TEMP: `${root}/tmp`, PATH: `${root}/empty`,
    LC_ALL: 'zh_CN.UTF-8', MIOON_CLI_USER_DATA: `${root}/profile`,
  });
});

test('slow launch diagnostics count bounded launcher-specific policy events without exposing paths or messages', () => {
  const launcher = '/private/tmp/mioon-cli-test/Mioon.app/Contents/Helpers/mioon';
  const begin = Date.parse('2026-01-02T03:04:05.100Z'), end = begin + 2000;
  const row = (timestamp: string, processImagePath: string, eventMessage: string) => ({timestamp, processImagePath, eventMessage});
  const entries = [
    row('2026-01-02 03:04:05.100120+0000', '/usr/libexec/syspolicyd', `${launcher} notarization ticket ${secret}`),
    row('2026-01-02 03:04:06.543210+0000', '/usr/libexec/amfid', `app.starroy.mioon.cli-launcher cache ${secret}`),
    row('2026-01-02 03:04:05.099123+0000', '/usr/libexec/syspolicyd', `${launcher} unrelated preflight`),
    row('2026-01-02 03:04:07.101000+0000', '/usr/libexec/syspolicyd', `${launcher} unrelated later event`),
    row('2026-01-02 03:04:05.200000+0000', '/usr/libexec/syspolicyd', `other executable ticket ${secret}`),
    row('2026-01-02 03:04:05.200000+0000', '/unrelated-process', launcher),
  ];
  const summary = summarizeLaunchPolicyLog(JSON.stringify(entries), begin, end, launcher);
  assert.deepEqual(summary, {systemLog: 'matched', policyEvents: {syspolicyd: 1, amfid: 1},
    ticketOrNotarizationEvents: 1, cacheEvents: 1});
  assert.ok(!JSON.stringify(summary).includes(launcher)); assert.ok(!JSON.stringify(summary).includes(secret));
  assert.equal(summarizeLaunchPolicyLog('[]', begin, end, launcher).systemLog, 'no-launch-specific-events');
  assert.equal(summarizeLaunchPolicyLog('log unavailable', begin, end, launcher).systemLog, 'unavailable');
});
