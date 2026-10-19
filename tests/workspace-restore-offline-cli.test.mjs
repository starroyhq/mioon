import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseBackupArguments} from '../apps/cli/src/backup.ts';
import {restoreFixture,tree,secret,runRestoreChild} from './helpers/workspace-restore-offline-fixture.ts';
const envelope=result=>{const lines=result.stdout.trim().split('\n');assert.equal(lines.length,1);return JSON.parse(lines[0]);};
const statusArgs=(destination,data)=>['restore-status','--destination',destination,'--restoration-id',data.restorationId,'--backup-id',data.sourceBackupId,'--manifest-hash',data.manifestHash,'--source-db-hash',data.sourceDbHash];

test('strict restore parser exposes only documented local commands and explicit status binding',()=>{
 assert.deepEqual(parseBackupArguments(['restore','--directory','/backup','--destination','/new']),{command:'restore',directory:'/backup',destination:'/new'});
 assert.deepEqual(parseBackupArguments(['restore-status','--directory','/backup','--destination','/new']),{command:'restore-status',directory:'/backup',destination:'/new'});
 assert.throws(()=>parseBackupArguments(['restore-status','--directory','/backup','--destination','/new','--restoration-id','11111111-1111-1111-1111-111111111111']),{code:'VALIDATION_ERROR'});
 for(const args of [['restore'],['restore','--directory','/backup'],['restore','--directory','/backup','--destination','/new','--force'],['restore','--directory','/backup','--destination','/new','--destination','/other'],['restore-status','--destination','/new']])assert.throws(()=>parseBackupArguments(args),{code:'VALIDATION_ERROR'});
});

test('real offline CLI restores and observes exact origin without network, credentials, subprocess, provider or service construction',async t=>{
 const f=await restoreFixture(t),sourceBefore=tree(f.source),backupBefore=tree(f.backup),guard=path.join(f.base,'offline-guard.mjs');
 fs.writeFileSync(guard,`import {registerHooks,syncBuiltinESMExports} from 'node:module';import fs from 'node:fs';import cp from 'node:child_process';import path from 'node:path';import {fileURLToPath} from 'node:url';
registerHooks({resolve(specifier,ctx,next){const out=next(specifier,ctx);if(/^(?:node:)?(?:http|https|http2|net|tls|dns)(?:\\/|$)/.test(out.url)||/\\/packages\\/business\\/src\\/(?:services|jobs|frames|images|waveforms)\\.mjs$/.test(out.url)||/\\/apps\\/(?:server|mcp)\\//.test(out.url))throw Error('FORBIDDEN_SERVICE');return out;}});
globalThis.fetch=()=>{throw Error('FORBIDDEN_NETWORK')};for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[key]=()=>{throw Error('FORBIDDEN_CHILD')};
process.env=new Proxy(process.env,{get(t,k){if(typeof k==='string'&&/^(MIOON_|OPENAI_API|RUNWAY|ARK_|VEO_|GOOGLE_API)/.test(k))throw Error('FORBIDDEN_CREDENTIAL');return Reflect.get(t,k);}});
for(const key of ['openSync','readFileSync']){const original=fs[key];fs[key]=function(value,...args){const name=value instanceof URL?fileURLToPath(value):value;if(typeof name==='string'&&/^(access-token|settings\\.json|mcp-connection\\.json)$/.test(path.basename(name)))throw Error('FORBIDDEN_CREDENTIAL');return original.call(this,value,...args);};}syncBuiltinESMExports();`,{mode:0o600});
 const result=await runRestoreChild(t,['restore','--directory',f.backup,'--destination',f.destination],{preload:guard}),body=envelope(result);
 assert.equal(result.code,0,result.stdout+result.stderr);assert.equal(body.ok,true);assert.equal(body.data.publication,'confirmed');assert.ok(!result.stdout.includes(secret));assert.ok(!result.stderr.includes(secret));assert.ok(!result.stdout.includes(f.base));
 const status=await runRestoreChild(t,statusArgs(f.destination,body.data),{preload:guard});assert.equal(status.code,0,status.stderr);assert.equal(envelope(status).data.publication,'observed_guarded');
 const discovered=await runRestoreChild(t,['restore-status','--directory',f.backup,'--destination',f.destination],{preload:guard});assert.equal(discovered.code,0,discovered.stderr);assert.deepEqual(envelope(discovered).data,envelope(status).data);
 assert.deepEqual(tree(f.source),sourceBefore);assert.deepEqual(tree(f.backup),backupBefore);
 const duplicate=await runRestoreChild(t,['restore','--directory',f.backup,'--destination',f.destination],{preload:guard});assert.equal(duplicate.code,1);assert.equal(envelope(duplicate).error.code,'WORKSPACE_RESTORE_DESTINATION_EXISTS');assert.ok(!duplicate.stdout.includes(f.base));
 const help=envelope(await runRestoreChild(t,['restore','--help'],{preload:guard}));const text=JSON.stringify(help);for(const word of ['schema24','schema25','captured','private plaintext','may contain secrets','Backup creation of restored branches is unavailable','MIOON_DESKTOP_USER_DATA'])assert.ok(text.toLowerCase().includes(word.toLowerCase()),word);
});
