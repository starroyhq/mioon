import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createLiveImageGateway} from '../packages/business/src/images/gateway.ts';
import {createImageSettings,IMAGE_CREDENTIAL_ACQUIRE,IMAGE_SETTINGS_ASSERT_CURRENT} from '../packages/business/src/images/settings.ts';
import {DEFAULT_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import {IMAGE_MODELS,IMAGE_FIXED_OPTIONS} from '../packages/contracts/src/images.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
const key='synthetic-images-gateway-sentinel';
const snapshot={providerId:'openai',model:IMAGE_MODELS.openai,prompt:'Original exact prompt: 蓝色 sky, no silent rewrite.',options:IMAGE_FIXED_OPTIONS};
const answers=[{address:'8.8.8.8',family:4}];
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function settingsFixture(t){let stored=null;const settings=await createImageSettings({persistence:{load:async()=>stored,save:async v=>{stored=structuredClone(v);}}});t.after(()=>settings.close());await settings.put({expectedRevision:0,configuration:{...DEFAULT_IMAGE_CONFIGURATION,enabled:true},secret:{action:'replace',storage:'session',value:key}});return {settings,read:()=>stored};}
function fakeNetwork({body=Buffer.from('{}'),onEnd,onConnect}={}){const state={created:0,posts:0};return Object.assign(state,{lookup:async()=>answers,httpsRequest(options,cb){state.created++;state.options=options;const req=new EventEmitter();req.destroy=()=>{};req.end=payload=>{state.posts++;state.payload=payload;onEnd?.();const res=Readable.from([body]);Object.assign(res,{statusCode:200,headers:{'content-type':'application/json'},complete:true});cb(res);};queueMicrotask(()=>{const socket=new EventEmitter();Object.assign(socket,{remoteAddress:'8.8.8.8',remotePort:443,authorized:true,destroy(){}});req.emit('socket',socket);onConnect?.();socket.emit('secureConnect');});return req;}});}

test('gateway uses dedicated credential, exact visible request and synchronous settings→durable fence→POST ordering',async t=>{
 const {settings,read}=await settingsFixture(t),order=[];
 const png=await renderMockImagePng(),network=fakeNetwork({body:Buffer.from(JSON.stringify({data:[{b64_json:png.toString('base64')}]})),onEnd:()=>order.push('post')});
 const original=settings[IMAGE_SETTINGS_ASSERT_CURRENT];const bound={...settings,[IMAGE_CREDENTIAL_ACQUIRE]:settings[IMAGE_CREDENTIAL_ACQUIRE],[IMAGE_SETTINGS_ASSERT_CURRENT]:e=>{order.push('settings');return original(e);}};
 const result=await createLiveImageGateway({settings:bound,...network}).generate(snapshot,{settingsRevision:1,beforeDispatch:()=>order.push('durable')});
 assert.deepEqual(order,['settings','durable','post']);assert.equal(network.posts,1);assert.equal(network.options.headers.Authorization,`Bearer ${key}`);assert.equal(JSON.parse(network.payload).prompt,snapshot.prompt);assert.equal(JSON.parse(network.payload).model,IMAGE_MODELS.openai);assert.equal(result.metadata.isMock,false);assert.deepEqual(result.bytes,png);assert.equal(JSON.stringify(read()).includes(key),false);
});

test('settings changed during DNS wait are rejected at actual POST fence, with no durable dispatch or POST',async t=>{
 const {settings}=await settingsFixture(t),entered=deferred(),release=deferred(),network=fakeNetwork();let fences=0;
 const pending=createLiveImageGateway({settings,...network,lookup:()=>{entered.resolve();return release.promise;}}).generate(snapshot,{settingsRevision:1,beforeDispatch:()=>fences++});
 await entered.promise;await settings.put({expectedRevision:1,configuration:{...DEFAULT_IMAGE_CONFIGURATION,enabled:false},secret:{action:'keep'}});release.resolve(answers);
 await assert.rejects(pending,{code:'IMAGE_DISPATCH_BLOCKED',dispatched:false,outcomeUnknown:false});assert.equal(fences,0);assert.equal(network.posts,0);
});

test('pending settings persistence blocks dispatch before its revision is committed',async t=>{
 let value=null,hold=false;const entered=deferred(),save=deferred(),dns=deferred(),lookupEntered=deferred();
 const settings=await createImageSettings({persistence:{load:async()=>value,save:async v=>{if(hold){entered.resolve();await save.promise;}value=v;}}});t.after(()=>settings.close());
 await settings.put({expectedRevision:0,configuration:{...DEFAULT_IMAGE_CONFIGURATION,enabled:true},secret:{action:'replace',storage:'session',value:key}});
 const network=fakeNetwork();let fences=0;const pending=createLiveImageGateway({settings,...network,lookup:()=>{lookupEntered.resolve();return dns.promise;}}).generate(snapshot,{settingsRevision:1,beforeDispatch:()=>fences++});await lookupEntered.promise;
 hold=true;const write=settings.put({expectedRevision:1,configuration:{...DEFAULT_IMAGE_CONFIGURATION,enabled:false},secret:{action:'keep'}});await entered.promise;dns.resolve(answers);
 await assert.rejects(pending,{code:'IMAGE_DISPATCH_BLOCKED',dispatched:false});assert.equal(network.posts,0);assert.equal(fences,0);save.resolve();await write;
});

for(const phase of ['before-acquire','during-dns','after-post'])test(`gateway abort ${phase} preserves dispatch uncertainty and never retries`,async t=>{
 const {settings}=await settingsFixture(t),controller=new AbortController(),entered=deferred(),release=deferred();let fences=0;
 const network=fakeNetwork({onEnd:phase==='after-post'?()=>controller.abort():undefined});
 if(phase==='before-acquire')controller.abort();
 const pending=createLiveImageGateway({settings,...network,...(phase==='during-dns'?{lookup:()=>{entered.resolve();return release.promise;}}:{})}).generate(snapshot,{settingsRevision:1,signal:controller.signal,beforeDispatch:()=>fences++});
 if(phase==='during-dns'){await entered.promise;controller.abort();release.resolve(answers);}
 await assert.rejects(pending,e=>{if(phase==='after-post'){assert.equal(e.dispatched,true);assert.equal(e.outcomeUnknown,true);}else assert.notEqual(e.dispatched,true);return true;});
 assert.equal(network.posts,phase==='after-post'?1:0);assert.equal(fences,phase==='after-post'?1:0);
});

test('async or false injected assertions and async durable fence cannot be hidden by gateway wrapper',async t=>{
 const {settings}=await settingsFixture(t);
 for(const assertion of [()=>false,()=>undefined,()=>1,async()=>true,()=>Promise.reject(Error('synthetic reject'))]){
  const network=fakeNetwork();let fences=0;const untrusted={...settings,[IMAGE_CREDENTIAL_ACQUIRE]:settings[IMAGE_CREDENTIAL_ACQUIRE],[IMAGE_SETTINGS_ASSERT_CURRENT]:assertion};
  await assert.rejects(createLiveImageGateway({settings:untrusted,...network}).generate(snapshot,{settingsRevision:1,beforeDispatch:()=>fences++}),{code:'IMAGE_DISPATCH_BLOCKED',dispatched:false});assert.equal(network.posts,0);assert.equal(fences,0);
 }
 const network=fakeNetwork();await assert.rejects(createLiveImageGateway({settings,...network}).generate(snapshot,{settingsRevision:1,beforeDispatch:async()=>{}}),{code:'IMAGE_DISPATCH_BLOCKED',dispatched:false});assert.equal(network.posts,0);
});

test('closed or missing dedicated credentials cannot initiate DNS or reuse Agent/video secrets',async t=>{
 const {settings}=await settingsFixture(t);await settings.close();let reads=0;
 const network={lookup:()=>{reads++;assert.fail('No DNS');},httpsRequest:()=>assert.fail('No HTTPS')};
 for(const source of [settings,undefined])await assert.rejects(createLiveImageGateway({settings:source,...network}).generate(snapshot,{settingsRevision:1,beforeDispatch:()=>assert.fail('No dispatch')}));assert.equal(reads,0);
});
