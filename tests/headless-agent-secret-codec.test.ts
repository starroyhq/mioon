import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createHeadlessAgentSecretCodec} from '../apps/server/src/headless-agent-secret-codec.ts';
import type {HeadlessSecretHelper} from '../apps/server/src/headless-agent-secret-client.ts';
import {createAgentSettings,AGENT_CREDENTIAL_ACQUIRE} from '../packages/business/src/agent/settings.ts';
import {createAgentSettingsFile} from '../packages/business/src/agent/settings-file.ts';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import {defaultServices,serviceBinding,emptyEnvelope} from '../packages/business/src/agent/settings-envelope.ts';
import {putTestAgentConfiguration,testAgentExecution,testAgentCredential} from './helpers/agent-settings-fixture.ts';

async function directory(t:TestContext){const root=await mkdtemp(path.join(tmpdir(),'mioon-headless-secret-'));t.after(()=>rm(root,{recursive:true,force:true}));return path.join(root,'agent-settings');}
function syntheticVault(){
  const entries=new Map<string,string>(),actions:string[]=[];
  let denied=false,createFailure:'before'|'after'|null=null,held:Promise<void>|null=null;
  const helper:HeadlessSecretHelper={async request(input){
    actions.push(input.operation);const id=randomUUID();if(held)await held;
    if(denied)return {version:1,id,ok:false,beforeWrite:true};
    const identity=input.service+'|'+input.account;
    if(input.operation==='create'&&!entries.has(identity)){
      if(createFailure==='before')return {version:1,id,ok:false,beforeWrite:true};
      if(createFailure==='after')return {version:1,id,ok:false,beforeWrite:false};
      entries.set(identity,Buffer.alloc(32,17).toString('base64'));
    }
    return {version:1,id,ok:true,key:entries.get(identity)??null};
  },close(){}};
  return {helper,entries,actions,deny(value:boolean){denied=value;},failure(value:'before'|'after'|null){createFailure=value;},hold(value:Promise<void>|null){held=value;}};
}
const entry=defaultServices().find(service=>service.serviceKey==='openai');assert.ok(entry);
const plaintext=(value='SYNTHETIC_HEADLESS_ONLY')=>JSON.stringify({version:2,serviceKey:'openai',binding:serviceBinding(entry),value});
const encrypt=async(codec:Awaited<ReturnType<typeof createHeadlessAgentSecretCodec>>,value=plaintext(),options={})=>{const result=await codec.secretCodec.encrypt!(value,options);assert.equal(typeof result,'string');assert.ok(typeof result==='string');return result;};
const decrypt=async(codec:Awaited<ReturnType<typeof createHeadlessAgentSecretCodec>>,value:string)=>codec.secretCodec.decrypt!(value);

test('headless startup/status/read are read-only; explicit encrypt creates one 32B DEK and preserves 8192B keys across codec restart',async t=>{
  const dir=await directory(t),vault=syntheticVault();let codec=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper});t.after(()=>codec.close());
  assert.equal(codec.storage().persistentAvailable,true);await codec.secretCodec.refreshStorage!();assert.deepEqual(vault.actions,['read','read']);assert.equal(vault.entries.size,0);
  await assert.rejects(readFile(path.join(dir,'settings.json')),{code:'ENOENT'});
  const source=plaintext('x'.repeat(8192)),cipher=await encrypt(codec,source);assert.equal(vault.entries.size,1);assert.equal(vault.actions.filter(action=>action==='create').length,1);assert.equal(cipher.includes('SYNTHETIC'),false);
  assert.equal(await decrypt(codec,cipher),source);codec.close();
  codec=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper});assert.equal(await decrypt(codec,cipher),source);
  const second=await encrypt(codec,plaintext('replacement'));assert.notEqual(second,cipher);assert.equal(vault.actions.filter(action=>action==='create').length,1);assert.equal(await decrypt(codec,cipher),source);
});
test('headless ciphertext authenticates workspace/channel/credential binding and rejects malformed or modified envelopes',async t=>{
  const dir=await directory(t),vault=syntheticVault(),codec=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper});t.after(()=>codec.close());
  const cipher=await encrypt(codec),other=await createHeadlessAgentSecretCodec({directory:await directory(t),channel:'development',helper:vault.helper}),channel=await createHeadlessAgentSecretCodec({directory:dir,channel:'production',helper:vault.helper});t.after(()=>other.close());t.after(()=>channel.close());
  for(const target of [other,channel])await assert.rejects(decrypt(target,cipher));
  for(const field of ['namespace','binding','iv','tag','body']){
    const envelope:unknown=JSON.parse(Buffer.from(cipher,'base64').toString('utf8'));assert.ok(envelope&&typeof envelope==='object');
    const changed={...envelope,[field]:field==='namespace'||field==='binding'?'f'.repeat(64):Buffer.alloc(field==='iv'?12:16,0).toString('base64')};
    await assert.rejects(decrypt(codec,Buffer.from(JSON.stringify(changed)).toString('base64')));
  }
  for(const malformed of ['','not base64','e30=','A'.repeat(50000)])await assert.rejects(decrypt(codec,malformed));
  assert.equal(vault.actions.filter(action=>action==='create').length,1);
});
test('missing DEK with existing ciphertext or a durable creation fence never creates a replacement',async t=>{
  const dir=await directory(t),vault=syntheticVault(),codec=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper});t.after(()=>codec.close());
  const cipher=await encrypt(codec);vault.entries.clear();await assert.rejects(decrypt(codec,cipher));await assert.rejects(encrypt(codec));
  const restart=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper});t.after(()=>restart.close());assert.equal(restart.storage().persistentAvailable,false);await assert.rejects(encrypt(restart));
  assert.equal(vault.actions.filter(action=>action==='create').length,1);
  const freshDir=await directory(t),saved=emptyEnvelope(1),openai=saved.services.find(service=>service.serviceKey==='openai');assert.ok(openai);
  openai.secret={binding:serviceBinding(openai),encrypted:cipher};
  await mkdir(freshDir,{mode:0o700});await writeFile(path.join(freshDir,'settings.json'),JSON.stringify(saved),{mode:0o600});
  const fresh=await createHeadlessAgentSecretCodec({directory:freshDir,channel:'development',helper:vault.helper});t.after(()=>fresh.close());assert.equal(fresh.storage().persistentAvailable,false);await assert.rejects(encrypt(fresh));assert.equal(vault.actions.filter(action=>action==='create').length,1);
});
test('retired legacy ciphertext is never decrypted and permits explicit new-key initialization without an old fence',async t=>{
  const dir=await directory(t),vault=syntheticVault(),legacy={version:2,revision:7,configuration:DEFAULT_AGENT_CONFIGURATION,
    secret:{binding:JSON.stringify([DEFAULT_AGENT_CONFIGURATION.presetId,DEFAULT_AGENT_CONFIGURATION.platformId,DEFAULT_AGENT_CONFIGURATION.baseUrl]),encrypted:Buffer.from('SYNTHETIC_RETIRED_UNREADABLE_CIPHER').toString('base64')}};
  await mkdir(dir,{mode:0o700});const file=path.join(dir,'settings.json'),before=JSON.stringify(legacy)+'\n';await writeFile(file,before,{mode:0o600});
  const codec=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper});t.after(()=>codec.close());
  let decrypts=0;const decrypt=codec.secretCodec.decrypt;
  const settings=await createAgentSettings({persistence:createAgentSettingsFile({directory:dir}),secretCodec:{...codec.secretCodec,decrypt(value,options){decrypts++;return decrypt!(value,options);}},storage:codec.storage});t.after(()=>settings.close());
  const projected=await settings.get();assert.equal(projected.storage.persistentAvailable,true);assert.equal(testAgentExecution(projected).secret.configured,false);
  assert.equal(decrypts,0);assert.equal(vault.entries.size,0);assert.equal(await readFile(file,'utf8'),before);assert.equal(vault.actions.filter(action=>action==='create').length,0);
  const saved=await putTestAgentConfiguration(settings,{expectedRevision:7,configuration:DEFAULT_AGENT_CONFIGURATION,secret:{action:'replace',storage:'persistent',value:'SYNTHETIC_REENTERED_NEW_KEY'}});
  assert.equal(saved.revision,8);assert.equal(decrypts,0);assert.equal(vault.actions.filter(action=>action==='create').length,1);
  assert.equal((await settings[AGENT_CREDENTIAL_ACQUIRE](testAgentCredential(saved))).apiKey,'SYNTHETIC_REENTERED_NEW_KEY');assert.equal(decrypts,1);
});
test('headless plaintext admits only the exact v2 per-service namespace before any DEK creation',async t=>{
  const dir=await directory(t),vault=syntheticVault(),codec=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper});t.after(()=>codec.close());
  const valid=JSON.parse(plaintext());
  for(const changed of [{version:1,binding:valid.binding,value:valid.value},{...valid,extra:true},{...valid,serviceKey:'other'},
    {...valid,binding:JSON.stringify(['mioon.agent.credentials.v3','anthropic','receiver'])},{...valid,binding:'wrong'},
    {...valid,value:'bad\nkey'},{...valid,value:'é'.repeat(4097)}])await assert.rejects(encrypt(codec,JSON.stringify(changed)));
  assert.equal(vault.entries.size,0);assert.equal(vault.actions.filter(action=>action==='create').length,0);
});
test('retiring legacy material never bypasses an existing durable DEK creation fence',async t=>{
  const dir=await directory(t),vault=syntheticVault(),codec=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper});
  const encrypted=await encrypt(codec),legacy={version:2,revision:7,configuration:DEFAULT_AGENT_CONFIGURATION,
    secret:{binding:JSON.stringify([DEFAULT_AGENT_CONFIGURATION.presetId,DEFAULT_AGENT_CONFIGURATION.platformId,DEFAULT_AGENT_CONFIGURATION.baseUrl]),encrypted}};
  const file=path.join(dir,'settings.json'),bytes=JSON.stringify(legacy)+'\n';await writeFile(file,bytes,{mode:0o600});codec.close();vault.entries.clear();
  const restarted=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper});t.after(()=>restarted.close());
  assert.equal(restarted.storage().persistentAvailable,false);await assert.rejects(encrypt(restarted));
  assert.equal(vault.actions.filter(action=>action==='create').length,1);assert.equal(vault.entries.size,0);assert.equal(await readFile(file,'utf8'),bytes);
});
test('native denial is not missing and a proven pre-write failure may retry without replacing an existing DEK',async t=>{
  const dir=await directory(t),vault=syntheticVault();vault.deny(true);
  const codec=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper});t.after(()=>codec.close());assert.equal(codec.storage().persistentAvailable,false);assert.equal(vault.entries.size,0);
  await assert.rejects(encrypt(codec));vault.deny(false);vault.failure('before');await assert.rejects(encrypt(codec));vault.failure(null);
  const cipher=await encrypt(codec);assert.equal(await decrypt(codec,cipher),plaintext());assert.equal(vault.entries.size,1);
});
test('uncertain creation, timeout and late results never authorize a replacement or publish ciphertext',async t=>{
  const dir=await directory(t),vault=syntheticVault(),codec=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper,timeoutMs:25});t.after(()=>codec.close());
  vault.failure('after');await assert.rejects(encrypt(codec));vault.failure(null);await assert.rejects(encrypt(codec));assert.equal(vault.actions.filter(action=>action==='create').length,1);
  let release:()=>void=()=>{};vault.hold(new Promise<void>(resolve=>{release=resolve;}));assert.deepEqual(await codec.secretCodec.refreshStorage!(),{persistentAvailable:false,sessionScope:'server',reasonCode:'OS_SECRET_STORE_UNAVAILABLE'});release();await delay(5);assert.equal(codec.storage().persistentAvailable,false);
  vault.hold(null);const abort=new AbortController();abort.abort();await assert.rejects(encrypt(codec,plaintext(),{signal:abort.signal}));assert.equal(vault.entries.size,0);
});
test('atomic settings save failure retains the old key and ciphertext without a silent session fallback',async t=>{
  const dir=await directory(t),vault=syntheticVault(),codec=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper});
  const disk=createAgentSettingsFile({directory:dir});let fail=false;
  const settings=await createAgentSettings({persistence:{load:()=>disk.load(),save:async value=>{if(fail)throw Error('SYNTHETIC_SAVE_FAILURE');await disk.save(value);}},secretCodec:codec.secretCodec,storage:codec.storage});t.after(()=>settings.close());
  await putTestAgentConfiguration(settings,{expectedRevision:0,configuration:DEFAULT_AGENT_CONFIGURATION,secret:{action:'replace',storage:'persistent',value:'SYNTHETIC_ORIGINAL'}});
  const before=await readFile(path.join(dir,'settings.json'));fail=true;
  await assert.rejects(putTestAgentConfiguration(settings,{expectedRevision:1,configuration:DEFAULT_AGENT_CONFIGURATION,secret:{action:'replace',storage:'persistent',value:'SYNTHETIC_FAILED_REPLACEMENT'}}),{code:'AGENT_SETTINGS_SAVE_FAILED'});
  assert.deepEqual(await readFile(path.join(dir,'settings.json')),before);assert.equal(vault.actions.filter(action=>action==='create').length,1);
  const credential=await settings[AGENT_CREDENTIAL_ACQUIRE](testAgentCredential(await settings.get()));assert.equal(credential.apiKey,'SYNTHETIC_ORIGINAL');assert.equal(testAgentExecution(await settings.get()).secret.storage,'persistent');
  await settings.close();const restartCodec=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper});
  const restart=await createAgentSettings({persistence:disk,secretCodec:restartCodec.secretCodec,storage:restartCodec.storage});t.after(()=>restart.close());assert.equal((await restart[AGENT_CREDENTIAL_ACQUIRE](testAgentCredential(await restart.get()))).apiKey,'SYNTHETIC_ORIGINAL');
});
test('concurrent factories cannot initialize different DEKs for the same namespace',async t=>{
  const dir=await directory(t),vault=syntheticVault();const a=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper}),b=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper:vault.helper});t.after(()=>a.close());t.after(()=>b.close());
  const results=await Promise.allSettled([encrypt(a),encrypt(b)]);assert.ok(results.some(result=>result.status==='fulfilled'));assert.equal(vault.actions.filter(action=>action==='create').length,1);assert.equal(vault.entries.size,1);
  for(const result of results)if(result.status==='fulfilled')assert.equal(await decrypt(a,result.value),plaintext());
});
test('late native creation never publishes a timed-out encryption result or silently starts a second creation',async t=>{
  const dir=await directory(t),vault=syntheticVault();let release:()=>void=()=>{};
  const held=new Promise<void>(resolve=>{release=resolve;});
  const helper:HeadlessSecretHelper={async request(input,options){if(input.operation==='create')await held;return vault.helper.request(input,options);},close(){}};
  const codec=await createHeadlessAgentSecretCodec({directory:dir,channel:'development',helper,timeoutMs:25});t.after(()=>codec.close());
  const pending=encrypt(codec);await assert.rejects(pending);assert.equal(codec.storage().persistentAvailable,false);
  release();await delay(5);assert.equal(vault.entries.size,1);assert.equal(codec.storage().persistentAvailable,false);
  await assert.rejects(readFile(path.join(dir,'settings.json')),{code:'ENOENT'});const cipher=await encrypt(codec);assert.equal(await decrypt(codec,cipher),plaintext());
  assert.equal(vault.actions.filter(action=>action==='create').length,1);
});
