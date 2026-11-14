import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdtemp,realpath,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDesktopVideoSecretCodec} from '../apps/desktop/src/video-secret-store.ts';
import {createDesktopImageSecretCodec} from '../apps/desktop/src/image-secret-store.ts';
import {createDesktopSecretCodec} from '../apps/desktop/src/secret-store.ts';
import {createVideoSecretBroker} from '../apps/desktop/src/video-secret-broker.ts';
import {createVideoSecretClient} from '../apps/desktop/src/video-secret-client.ts';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {VIDEO_SECRET_NAMESPACE,defaultVideoModels} from '../packages/contracts/src/video-providers.ts';
import desktopIdentity from '../apps/desktop/identity.ts';
import type {DesktopSafeStorage} from '../apps/desktop/src/secret-store.ts';
const SENTINEL='synthetic-desktop-video-key',connectionId=randomUUID(),credentialRef=randomUUID();
const plaintext=JSON.stringify({version:1,namespace:VIDEO_SECRET_NAMESPACE,credentialRef,connectionId,providerId:'minimax',region:'global',workspaceId:'',endpoint:'https://api.minimax.io',value:SENTINEL});
function vault(){const key=randomBytes(32);const encrypt=(value:string)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]);};const decrypt=(value:Buffer)=>{const decipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(-16));return Buffer.concat([decipher.update(value.subarray(12,-16)),decipher.final()]).toString();};return {isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'gnome_libsecret',encryptString:encrypt,decryptString:decrypt,isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async(value:string)=>encrypt(value),decryptStringAsync:async(value:Buffer)=>({result:decrypt(value),shouldReEncrypt:false})} satisfies DesktopSafeStorage;}
const codec=(platform:NodeJS.Platform='darwin')=>createDesktopVideoSecretCodec({safeStorage:vault(),appId:desktopIdentity.identityForChannel('development').appId,platform});
class Port extends EventEmitter {sent:unknown[]=[];postMessage(value:unknown){this.sent.push(value);}}
function connected(main=codec()){const port=new Port(),replies:unknown[]=[],broker=createVideoSecretBroker({videoSecretCodec:main,send:data=>{replies.push(data);port.emit('message',{data});}});port.postMessage=value=>{port.sent.push(value);broker.handle(value);};const client=createVideoSecretClient({port});return {main,broker,client,port,replies,close(){client.close();broker.close();}};}
for(const platform of ['darwin','linux'] as const)test('video OS codec accepts only its recipient-bound namespace ('+platform+')',async()=>{const main=codec(platform),encrypted=await main.encrypt(plaintext);assert.equal(await main.decrypt(encrypted),plaintext);assert.deepEqual(await main.storage(),{persistentAvailable:true,sessionScope:'server',reasonCode:null});for(const input of [SENTINEL,JSON.stringify({version:1,value:SENTINEL}),plaintext.replace(VIDEO_SECRET_NAMESPACE,'mioon.images.openai.v1'),plaintext.replace('https://api.minimax.io','https://attacker.example')])await assert.rejects(main.encrypt(input),{code:'VIDEO_SETTINGS_VALIDATION'});});

test('weak Linux storage cannot silently become plaintext persistence',async()=>{const safeStorage=vault();safeStorage.getSelectedStorageBackend=()=> 'basic_text';const main=createDesktopVideoSecretCodec({safeStorage,appId:desktopIdentity.identityForChannel('development').appId,platform:'linux'});assert.equal((await main.storage()).reasonCode,'LINUX_BASIC_TEXT');await assert.rejects(main.encrypt(plaintext),{code:'VIDEO_SETTINGS_STORAGE_UNAVAILABLE'});});

test('private video channel rejects wrong namespace, arbitrary operations and decrypt replay',async()=>{const replies:Record<string,unknown>[]=[],main=codec(),broker=createVideoSecretBroker({videoSecretCodec:main,send:data=>replies.push(data as Record<string,unknown>)});const request=(operation:string,more:Record<string,unknown>={})=>({type:'video-secret-codec-request',version:1,namespace:'video-providers',requestId:randomUUID(),operation,...more});for(const message of [request('status',{namespace:'images'}),request('readFile',{input:'/private/key'}),request('encrypt',{input:JSON.stringify({namespace:'images',value:SENTINEL})})]){assert.equal(broker.handle(message),true);const output=replies.pop()!;assert.equal(output.ok,false);assert.equal(JSON.stringify(output).includes(SENTINEL),false);}assert.equal(broker.handle({type:'image-secret-codec-request'}),false);const encrypted=await main.encrypt(plaintext),message=request('decrypt',{input:encrypted});broker.handle(message);await new Promise(resolve=>setImmediate(resolve));assert.equal(replies.at(-1)!.ok,true);const before=replies.length;broker.handle(message);assert.equal(replies.length,before+1);assert.equal(replies.at(-1)!.ok,false);assert.equal(JSON.stringify(replies.at(-1)).includes(SENTINEL),false);broker.close();});

test('utility client round trips the private codec and closes outstanding capabilities',async()=>{const f=connected();const availability=await f.client.refreshStorage();assert.equal(availability.persistentAvailable,true);const encrypted=await f.client.encrypt(plaintext);assert.equal(await f.client.decrypt(encrypted),plaintext);assert.equal(f.client.storage().sessionScope,'server');f.close();await assert.rejects(f.client.encrypt(plaintext));});

for (const platform of ['darwin', 'linux'] as const) test('Video status polling stops when vault unavailability is confirmed (' + platform + ')', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const safeStorage: DesktopSafeStorage = vault();
  safeStorage.isAsyncEncryptionAvailable = async () => false;
  safeStorage.getSelectedStorageBackend = () => 'basic_text';
  const f = connected(createDesktopVideoSecretCodec({safeStorage, appId: desktopIdentity.identityForChannel('development').appId, platform}));
  t.after(() => f.close());
  let wakes = 0;
  f.client.subscribeStorageAvailable(() => { wakes++; });
  t.mock.timers.tick(500);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.client.storage().reasonCode, platform === 'darwin' ? 'OS_SECRET_STORE_UNAVAILABLE' : 'LINUX_BASIC_TEXT');
  assert.equal(f.port.sent.length, 1);
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(500);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(f.port.sent.length, 1);
  assert.equal(wakes, 0);
});

test('a Video subscriber learns cached ready storage before starting its worker without another IPC', async t => {
  const f = connected();
  t.after(() => f.close());
  assert.equal((await f.client.refreshStorage()).persistentAvailable, true);
  let active = 0;
  const unsubscribe = f.client.subscribeStorageAvailable(() => { active++; });
  assert.equal(active, 1);
  unsubscribe();
  assert.equal(f.port.sent.length, 1);
});

test('Agent, Images and Video share one pending Keychain request; a late grant notifies Video once', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const gate = Promise.withResolvers<void>(), safeStorage = vault(), calls: string[] = [];
  const encrypt = safeStorage.encryptStringAsync, decrypt = safeStorage.decryptStringAsync;
  safeStorage.isAsyncEncryptionAvailable = async () => { calls.push('status'); await gate.promise; return true; };
  safeStorage.encryptStringAsync = async value => { calls.push('encrypt'); return encrypt(value); };
  safeStorage.decryptStringAsync = async value => { calls.push('decrypt'); return decrypt(value); };
  const options = {safeStorage, appId: desktopIdentity.identityForChannel('development').appId, platform: 'darwin' as const};
  const agent = createDesktopSecretCodec(options), images = createDesktopImageSecretCodec(options);
  const port = new Port(), broker = createVideoSecretBroker({videoSecretCodec: createDesktopVideoSecretCodec(options),
    send: data => port.emit('message', {data})});
  port.postMessage = value => { port.sent.push(value); broker.handle(value); };
  const video = createVideoSecretClient({port}), turn = () => new Promise<void>(resolve => setImmediate(resolve));
  let wakes = 0;
  const observe = () => { wakes++; };
  let unsubscribe = video.subscribeStorageAvailable(observe);
  t.after(() => { gate.resolve(); unsubscribe(); video.close(); broker.close(); agent.close(); });
  const first = await Promise.all([agent.refreshStorage(), images.storage(), video.refreshStorage()]);
  assert.deepEqual(first.map(state => state.reasonCode), Array(3).fill('OS_SECRET_STORE_PENDING'));
  assert.ok(first.every(state => !state.persistentAvailable));
  assert.deepEqual(calls, ['status']);
  assert.ok(port.sent.every(value => !JSON.stringify(value).includes(SENTINEL)));
  t.mock.timers.tick(500);
  await video.refreshStorage();
  assert.equal(wakes, 0);
  assert.deepEqual(calls, ['status']);
  unsubscribe();
  const pendingRequests = port.sent.length;
  t.mock.timers.tick(5000);
  await turn();
  assert.equal(port.sent.length, pendingRequests);
  unsubscribe = video.subscribeStorageAvailable(observe);
  gate.resolve();
  await turn();
  t.mock.timers.tick(500);
  await turn();
  assert.equal(wakes, 1);
  assert.deepEqual(calls, ['status', 'encrypt', 'decrypt']);
  assert.equal(video.storage().persistentAvailable, true);
  assert.equal((await images.storage()).persistentAvailable, true);
  assert.equal((await agent.refreshStorage()).persistentAvailable, true);
  const sent = port.sent.length;
  t.mock.timers.tick(5000);
  await turn();
  assert.equal(port.sent.length, sent);
  await video.refreshStorage();
  assert.equal(wakes, 1);
});

test('Video crypto joins the held Keychain slot while redacted settings status remains available', async t => {
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), safeStorage = vault();
  const decrypt = safeStorage.decryptStringAsync;
  let nativeDecrypts = 0, hold = false;
  safeStorage.decryptStringAsync = async value => {
    if (hold && ++nativeDecrypts === 1) { entered.resolve(); await gate.promise; }
    return decrypt(value);
  };
  const options = {safeStorage, appId: desktopIdentity.identityForChannel('development').appId, platform: 'darwin' as const};
  const agent = createDesktopSecretCodec(options), main = createDesktopVideoSecretCodec(options);
  const port = new Port(), broker = createVideoSecretBroker({videoSecretCodec: main, send: data => port.emit('message', {data})});
  port.postMessage = value => { port.sent.push(value); broker.handle(value); };
  const video = createVideoSecretClient({port});
  t.after(() => { gate.resolve(); video.close(); broker.close(); agent.close(); });
  const encryptedAgent = await agent.encrypt('synthetic-agent-key'), encryptedVideo = await main.encrypt(plaintext);
  hold = true;
  const first = agent.decrypt(encryptedAgent);
  await entered.promise;
  const second = video.decrypt(encryptedVideo);
  const status = await video.refreshStorage();
  assert.equal(status.reasonCode, 'OS_SECRET_STORE_PENDING');
  assert.equal(nativeDecrypts, 1);
  assert.ok(port.sent.some(value => (value as {operation?: string}).operation === 'decrypt'));
  gate.resolve();
  assert.equal(await first, 'synthetic-agent-key');
  assert.equal(await second, plaintext);
  assert.equal(nativeDecrypts, 2);
});

test('Video polls again after a warm native deadline and observes the held slot settling', async t => {
  const safeStorage = vault(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const decrypt = safeStorage.decryptStringAsync;
  let heldDecrypts = 0, hold = false;
  safeStorage.decryptStringAsync = async value => {
    if (hold) { heldDecrypts++; entered.resolve(); await gate.promise; }
    return decrypt(value);
  };
  const main = createDesktopVideoSecretCodec({safeStorage, appId: desktopIdentity.identityForChannel('development').appId,
    platform: 'darwin', timeout: 30});
  const f = connected(main), turn = () => new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.enable({apis: ['setTimeout']});
  t.after(() => { gate.resolve(); f.close(); });
  const encrypted = await main.encrypt(plaintext);
  await f.client.refreshStorage();
  let wakes = 0;
  f.client.subscribeStorageAvailable(() => { wakes++; });
  await Promise.resolve();
  assert.equal(wakes, 1);
  hold = true;
  const failure = assert.rejects(f.client.decrypt(encrypted), {code: 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE'});
  await entered.promise;
  t.mock.timers.tick(30);
  await failure;
  assert.equal(heldDecrypts, 1);
  assert.equal(wakes, 1);
  assert.equal(f.client.storage().reasonCode, 'OS_SECRET_STORE_UNAVAILABLE');
  const sent = f.port.sent.length;
  t.mock.timers.tick(500);
  assert.equal(f.port.sent.length, sent + 1);
  assert.equal((await f.client.refreshStorage()).reasonCode, 'OS_SECRET_STORE_PENDING');
  gate.resolve();
  await turn();
  t.mock.timers.tick(500);
  await turn();
  assert.equal(f.client.storage().persistentAvailable, true);
  assert.equal(wakes, 2);
  assert.equal(heldDecrypts, 1);
});

test('owned-child closure suppresses late decrypt completion and never replays plaintext',async()=>{let release:(value:string)=>void=()=>{};const pending=new Promise<string>(resolve=>{release=resolve;}),replies:unknown[]=[],main=codec(),encrypted=await main.encrypt(plaintext),broker=createVideoSecretBroker({videoSecretCodec:{storage:()=>main.storage(),encrypt:value=>main.encrypt(value),decrypt:()=>pending},send:value=>replies.push(value)});broker.handle({type:'video-secret-codec-request',version:1,namespace:'video-providers',requestId:randomUUID(),operation:'decrypt',input:encrypted});await new Promise(resolve=>setImmediate(resolve));broker.close();release(plaintext);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(replies,[]);});

test('desktop settings persist encrypted credentials through the private broker without entering GET',async t=>{const f=connected(),root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-desktop-video-')));await f.client.refreshStorage();const options={directory:path.join(root,'video-settings'),privateRoot:root,secretCodec:f.client,storage:()=>f.client.storage()},settings=await createVideoSettings(options);t.after(async()=>{await settings.close();f.close();await rm(root,{recursive:true,force:true});});const configuration={id:randomUUID(),providerId:'minimax' as const,name:'Desktop account',region:'global',workspaceId:'',enabled:true,archived:false,outputHosts:[],models:defaultVideoModels('minimax')};const saved=await settings.put({action:'save',expectedRevision:0,configuration,secret:{action:'replace',storage:'persistent',value:SENTINEL}});assert.equal(saved.connections[0]!.secret.storage,'persistent');assert.equal(JSON.stringify(saved).includes(SENTINEL),false);assert.equal((await readFile(path.join(options.directory,'settings.json'),'utf8')).includes(SENTINEL),false);const binding=settings.select(configuration.id,1,configuration.models[0]!.id);assert.equal(await settings.acquire(binding),SENTINEL);await settings.close();const reopened=await createVideoSettings(options);t.after(()=>reopened.close());assert.equal(await reopened.acquire(binding),SENTINEL);});
