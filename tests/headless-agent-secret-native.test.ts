import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fork} from 'node:child_process';
import {writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {initializeNodePrivateStorage} from '../packages/node-host/src/private-storage-bootstrap.ts';
import {createPrivateTemporaryDirectory,ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';

// Opt-in only: this creates/deletes one exact synthetic OS-vault entry. It never
// enumerates the vault, reads other items or changes keychain/session settings.
test('native headless settings survive a complete host-process restart using one dedicated synthetic DEK',{
  skip:process.env.MIOON_HEADLESS_VAULT_TEST!=='1',timeout:45000,
},async t=>{
  await initializeNodePrivateStorage();
  const root=createPrivateTemporaryDirectory(tmpdir(),'mioon-headless-native-'),directory=path.join(root,'agent-settings');
  ensurePrivateDirectory(directory,{create:true});
  const account=createHash('sha256').update(JSON.stringify(['mioon-headless-agent-secret',1,directory,'development'])).digest('hex');
  const file=path.join(root,'host.mjs');
  const source=`import {createRequire} from 'node:module';
import {initializeNodePrivateStorage} from ${JSON.stringify(new URL('../packages/node-host/src/private-storage-bootstrap.ts',import.meta.url).href)};
import {createHeadlessAgentSecretCodec} from ${JSON.stringify(new URL('../apps/server/src/headless-agent-secret-codec.ts',import.meta.url).href)};
import {createAgentSettings,AGENT_CREDENTIAL_ACQUIRE} from ${JSON.stringify(new URL('../packages/business/src/agent/settings.ts',import.meta.url).href)};
import {createAgentSettingsFile} from ${JSON.stringify(new URL('../packages/business/src/agent/settings-file.ts',import.meta.url).href)};
import {DEFAULT_AGENT_CONFIGURATION} from ${JSON.stringify(new URL('../packages/business/src/agent/presets.ts',import.meta.url).href)};
const synthetic='SYNTHETIC_HEADLESS_NATIVE_NO_PROVIDER';
await initializeNodePrivateStorage();
process.once('message',async input=>{
 let codec,settings;
 try{
  if(input.action==='present'||input.action==='delete'){
   const require=createRequire(${JSON.stringify(new URL('../apps/server/package.json',import.meta.url).href)});
   const {AsyncEntry}=require('@napi-rs/keyring');
   const entry=new AsyncEntry('app.starroy.mioon.headless.agent.v1.development',input.account,{linux:{store:'secret-service'}});
   const value=input.action==='delete'?await entry.deleteCredential():(await entry.getPassword())!==null;
   process.send({ok:true,value},()=>process.exit(0));return;
  }
  codec=await createHeadlessAgentSecretCodec({directory:input.directory,channel:'development'});
  if(input.action==='status'){process.send({ok:true,available:codec.storage().persistentAvailable},()=>process.exit(0));return;}
  if(!codec.storage().persistentAvailable){process.send({ok:false,available:false},()=>process.exit(0));return;}
  settings=await createAgentSettings({persistence:createAgentSettingsFile({directory:input.directory}),secretCodec:codec.secretCodec,storage:codec.storage});
  if(input.action==='save')await settings.put({expectedRevision:0,configuration:DEFAULT_AGENT_CONFIGURATION,secret:{action:'replace',storage:'persistent',value:synthetic}});
  const credential=await settings[AGENT_CREDENTIAL_ACQUIRE]({expectedRevision:1,configuration:DEFAULT_AGENT_CONFIGURATION});
  const matches=credential.apiKey===synthetic;await settings.close();
  process.send({ok:true,matches},()=>process.exit(0));
 }catch{try{await settings?.close();}catch{}codec?.close();process.send({ok:false},()=>process.exit(0));}
});`;
  await writeFile(file,source,{mode:0o600});
  async function call(action: string,{directoryOverride=directory,environment={}}={}){
    return new Promise<{ok: boolean; available?: boolean; matches?: boolean; value?: boolean}>((resolve,reject)=>{
      const child=fork(file,[],{execPath:process.execPath,execArgv:[],env:{...process.env,...environment},stdio:['ignore','ignore','ignore','ipc']});
      let result: unknown;const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Synthetic vault operation exceeded its deadline.'));},10000);
      child.on('error',()=>{clearTimeout(timer);reject(Error('Synthetic vault process failed.'));});
      child.on('message',value=>{result=value;});
      child.once('exit',(code,signal)=>{clearTimeout(timer);if(code===0&&signal===null&&result)resolve(result as {ok: boolean; available?: boolean; matches?: boolean; value?: boolean});else reject(Error('Synthetic vault process did not complete.'));});
      child.send({action,account,directory:directoryOverride});
    });
  }
  t.after(async()=>{try{const result=await call('delete');assert.equal(result.ok,true,'Dedicated synthetic vault cleanup must succeed.');assert.deepEqual(await call('present'),{ok:true,value:false});}finally{await rm(root,{recursive:true,force:true});}});
  assert.deepEqual(await call('present'),{ok:true,value:false});
  assert.deepEqual(await call('save'),{ok:true,matches:true});
  const bytes=await readFile(path.join(directory,'settings.json'));assert.equal(bytes.includes(Buffer.from('SYNTHETIC_HEADLESS_NATIVE_NO_PROVIDER')),false);
  assert.deepEqual(await call('read'),{ok:true,matches:true});
  if(process.platform==='linux'){
    await t.test('Linux missing session bus is unavailable without a kernel-keyring fallback or writes',async()=>{
      const fresh=path.join(root,'no-bus-settings');
      assert.deepEqual(await call('status',{directoryOverride:fresh,environment:{DBUS_SESSION_BUS_ADDRESS:`unix:path=${path.join(root,'absent-bus.sock')}`}}),{ok:true,available:false});
      await assert.rejects(readFile(path.join(fresh,'settings.json')),{code:'ENOENT'});
    });

  }
});
