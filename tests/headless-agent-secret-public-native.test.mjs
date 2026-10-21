import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fork,spawn} from 'node:child_process';
import {writeFile,readFile,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {initializeNodePrivateStorage} from '../packages/node-host/src/private-storage-bootstrap.ts';
import {createPrivateTemporaryDirectory,ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';

// All vault operations target this test's random private root. No enumeration,
// user-vault locking or provider requests are part of this opt-in validation.
test('native headless CLI publicly removes its synthetic key and refuses a lost DEK across host restarts',{
 skip:process.env.MIOON_HEADLESS_VAULT_TEST!=='1',timeout:180000,
},async t=>{
 await initializeNodePrivateStorage();
 const root=createPrivateTemporaryDirectory(tmpdir(),'mioon-headless-public-native-');
 const dataDir=path.join(root,'workspace'),directory=path.join(dataDir,'agent-settings');
 ensurePrivateDirectory(directory,{create:true});
 const account=createHash('sha256').update(JSON.stringify(['mioon-headless-agent-secret',1,realpathSync.native(directory),'web'])).digest('hex');
 const synthetic='SYNTHETIC_HEADLESS_PUBLIC_NATIVE_NO_PROVIDER';
 const file=path.join(root,'host.mjs'),cliEntry=fileURLToPath(new URL('../apps/cli/src/index.ts',import.meta.url));
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MIOON_')));
 env.MIOON_ENABLE_LIVE_PROVIDER='0';
 const source=`import {createRequire} from 'node:module';
import {initializeNodePrivateStorage} from ${JSON.stringify(new URL('../packages/node-host/src/private-storage-bootstrap.ts',import.meta.url).href)};
import {startServer} from ${JSON.stringify(new URL('../apps/server/src/index.ts',import.meta.url).href)};
import {createHeadlessAgentSecretCodec} from ${JSON.stringify(new URL('../apps/server/src/headless-agent-secret-codec.ts',import.meta.url).href)};
import {createAgentSettings,AGENT_CREDENTIAL_ACQUIRE} from ${JSON.stringify(new URL('../packages/business/src/agent/settings.ts',import.meta.url).href)};
import {createAgentSettingsFile} from ${JSON.stringify(new URL('../packages/business/src/agent/settings-file.ts',import.meta.url).href)};
await initializeNodePrivateStorage();
process.once('message',async input=>{
 let codec,settings,service,modelCalls=0;
 const finish=value=>process.send(value,()=>process.exit(0));
 try{
  if(input.action==='present'||input.action==='delete'){
   const require=createRequire(${JSON.stringify(new URL('../apps/server/package.json',import.meta.url).href)});
   const {AsyncEntry}=require('@napi-rs/keyring');
   const entry=new AsyncEntry('app.starroy.mioon.headless.agent.v1.web',input.account,{linux:{store:'secret-service'}});
   const present=(await entry.getPassword())!==null;
   if(input.action==='delete'&&present)await entry.deleteCredential();
   finish({ok:true,value:input.action==='delete'?true:present});return;
  }
  if(input.action==='serve'){
   const gateway=async function*(){modelCalls++;throw Error('Provider requests are prohibited in native Key validation.');};
   service=await startServer({dataDir:input.dataDir,port:0,localDraftChannel:'web',agentSecretCodecFactory:createHeadlessAgentSecretCodec,taskGatewayV2:gateway,chatGateway:gateway});
   process.once('message',async message=>{try{if(message.action!=='close')throw Error();await service.close();finish({ok:true,modelCalls});}catch{finish({ok:false});}});
   process.send({ok:true,url:service.url,tokenFile:service.tokenFile});return;
  }
  codec=await createHeadlessAgentSecretCodec({directory:input.directory,channel:'web'});
  settings=await createAgentSettings({persistence:createAgentSettingsFile({directory:input.directory}),secretCodec:codec.secretCodec,storage:codec.storage});
  const snapshot=await settings.get();
  const credential=await settings[AGENT_CREDENTIAL_ACQUIRE]({expectedRevision:snapshot.revision,configuration:snapshot.configuration});
  const matches=credential.apiKey===${JSON.stringify(synthetic)};await settings.close();finish({ok:true,matches});
 }catch{try{await settings?.close();await service?.close();}catch{}codec?.close();finish({ok:false});}
});`;
 await writeFile(file,source,{mode:0o600});
 let active;
 function operation(action){
  const child=fork(file,[],{execPath:process.execPath,execArgv:[],env,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  const messages=[];let pending;
  child.on('message',value=>{if(pending){const resolve=pending;pending=undefined;resolve(value);}else messages.push(value);});
  const next=()=>messages.length?Promise.resolve(messages.shift()):new Promise(resolve=>{pending=resolve;});
  const closed=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Synthetic host exceeded its deadline.'));},action==='serve'?90000:20000);
   child.once('error',()=>{clearTimeout(timer);reject(Error('Synthetic host launch failed.'));});
   child.once('exit',(code,signal)=>{clearTimeout(timer);if(code===0&&signal===null)resolve();else reject(Error('Synthetic host failed.'));});
  });
  void closed.catch(()=>{});
  child.send({action,account,directory,dataDir});
  return {child,closed,next:()=>Promise.race([next(),closed.then(()=>{if(messages.length)return messages.shift();throw Error('Synthetic host exited without a result.');})])};
 }
 async function call(action){const running=operation(action),result=await running.next();await running.closed;return result;}
 async function start(){active=operation('serve');const connection=await active.next();assert.equal(connection.ok,true,'Synthetic backend startup must succeed.');return connection;}
 async function stop(){const running=active;if(!running)return;active=undefined;running.child.send({action:'close'});assert.deepEqual(await running.next(),{ok:true,modelCalls:0});await running.closed;}
 async function cli(connection,words,input={},key){
  const environment={...env,MIOON_BASE_URL:connection.url,MIOON_TOKEN_FILE:connection.tokenFile};
  const args=[cliEntry,'agent','settings',...words,'--input',JSON.stringify(input),...(key===undefined?[]:['--key-stdin'])];
  const child=spawn(process.execPath,args,{env:environment,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8').on('data',bytes=>{stdout+=bytes;if(Buffer.byteLength(stdout)>512*1024)child.kill('SIGKILL');});
  child.stderr.setEncoding('utf8').on('data',bytes=>{stderr+=bytes;if(Buffer.byteLength(stderr)>8192)child.kill('SIGKILL');});
  child.stdin.on('error',()=>{});child.stdin.end(key??'');
  const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Synthetic CLI exceeded its deadline.'));},20000);child.once('error',()=>{clearTimeout(timer);reject(Error('Synthetic CLI launch failed.'));});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
  assert.equal(result.signal,null);assert.equal(stdout.includes(synthetic),false);assert.equal(stderr.includes(synthetic),false);
  const lines=stdout.trim().split('\n');assert.equal(lines.length,1);return {code:result.code,body:JSON.parse(lines[0])};
 }
 async function get(connection){const result=await cli(connection,['get']);assert.equal(result.code,0,JSON.stringify(result.body.error));assert.equal(result.body.ok,true);return result.body.data;}
 async function save(connection,current){const result=await cli(connection,['secret','set'],{expectedRevision:current.revision,configuration:current.configuration},synthetic);assert.equal(result.code,0,JSON.stringify(result.body.error));assert.equal(result.body.ok,true);return result.body.data;}
 t.after(async()=>{try{await stop();assert.equal((await call('delete')).ok,true);assert.deepEqual(await call('present'),{ok:true,value:false});}finally{await rm(root,{recursive:true,force:true});}});
 assert.deepEqual(await call('present'),{ok:true,value:false});
 const first=await start(),initial=await get(first);assert.deepEqual(initial.secret,{configured:false,storage:'none'});assert.equal(initial.storage.persistentAvailable,true);
 const saved=await save(first,initial);assert.deepEqual(saved.secret,{configured:true,storage:'persistent'});await stop();
 const bytes=await readFile(path.join(directory,'settings.json'));assert.equal(bytes.includes(Buffer.from(synthetic)),false);
 assert.deepEqual(await call('read'),{ok:true,matches:true});
 const second=await start(),reopened=await get(second);assert.equal(reopened.revision,saved.revision);assert.deepEqual(reopened.secret,saved.secret);
 const removed=await cli(second,['secret','remove'],{expectedRevision:reopened.revision,configuration:reopened.configuration});assert.equal(removed.code,0);assert.deepEqual(removed.body.data.secret,{configured:false,storage:'none'});await stop();
 const third=await start(),afterRemoval=await get(third);assert.equal(afterRemoval.revision,removed.body.data.revision);assert.deepEqual(afterRemoval.secret,{configured:false,storage:'none'});
 const savedAgain=await save(third,afterRemoval);await stop();
 const beforeUnavailable=await readFile(path.join(directory,'settings.json')),fenceBefore=await readFile(path.join(directory,'headless-dek-web-v1.json'));
 assert.deepEqual(await call('delete'),{ok:true,value:true});assert.deepEqual(await call('present'),{ok:true,value:false});
 const fourth=await start(),unavailable=await get(fourth);assert.equal(unavailable.revision,savedAgain.revision);assert.deepEqual(unavailable.secret,{configured:true,storage:'persistent'});assert.equal(unavailable.storage.persistentAvailable,false);assert.equal(unavailable.storage.reasonCode,'OS_SECRET_STORE_UNAVAILABLE');
 const refused=await cli(fourth,['secret','set'],{expectedRevision:unavailable.revision,configuration:unavailable.configuration},synthetic);assert.equal(refused.code,3);assert.equal(refused.body.error.code,'AGENT_SETTINGS_STORAGE_UNAVAILABLE');await stop();
 assert.deepEqual(await call('read'),{ok:false});assert.deepEqual(await call('present'),{ok:true,value:false});
 assert.deepEqual(await readFile(path.join(directory,'settings.json')),beforeUnavailable);assert.deepEqual(await readFile(path.join(directory,'headless-dek-web-v1.json')),fenceBefore);
 const sourceHashes={};
 for(const relative of ['tests/headless-agent-secret-public-native.test.mjs','apps/server/src/headless-agent-secret-client.ts','apps/server/src/headless-agent-secret-codec.ts','apps/server/src/headless-agent-secret-helper.ts','apps/cli/src/agent.ts'])sourceHashes[relative]=createHash('sha256').update(await readFile(new URL('../'+relative,import.meta.url))).digest('hex');
 t.diagnostic(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,publicDeleteAcrossRestart:true,dekUnavailableAcrossRestart:true,persistentSaveRefused:true,ciphertextUnchanged:true,fenceUnchanged:true,automaticDekRotation:false,providerCalls:0,sourceHashes}));
});
