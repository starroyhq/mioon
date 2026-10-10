import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createMockImageAdapter, createOpenAIImageAdapter, decodeImageBase64, decodeImageJsonResponse} from '../packages/business/src/images/adapter.mjs';
import {createImageJsonTransport, resolveImageDestination} from '../packages/business/src/images/network.mjs';
import {IMAGE_GENERATION_ENDPOINT, IMAGE_NETWORK_LIMITS, IMAGE_PROFILES, createImageGenerationBody, imageAdapterError} from '../packages/business/src/images/profiles.mjs';
import {renderMockImagePng} from '../packages/business/src/images/png.mjs';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS} from '../packages/contracts/src/images.mjs';

const snapshot = (providerId='openai',prompt='Synthetic offline adapter test') => ({providerId,model:IMAGE_MODELS[providerId],prompt,options:{...IMAGE_FIXED_OPTIONS}});
const answers = async () => [{address:'8.8.8.8',family:4}];
const key = 'offline-test-sentinel';
const requestArgs = {body:'{}',beforeDispatch:()=>{}};
function injectedRequest({body=Buffer.from('{}'),status=200,headers={'content-type':'application/json'},peer='8.8.8.8',port=443,authorized=true,complete=true,beforeConnect,beforeResponse,noConnect=false,noResponse=false,chunks}={}) {
  const state={calls:0,ends:0,destroyed:0};
  state.request=(options,callback)=>{
    state.calls++;state.options=options;
    const request=new EventEmitter();
    request.destroy=()=>{state.destroyed++;};
    request.end=payload=>{
      state.ends++;state.payload=payload;beforeResponse?.(state);
      if(noResponse)return;
      const response=Readable.from(chunks??[body]);Object.assign(response,{statusCode:status,headers,complete});state.response=response;callback(response);
    };
    queueMicrotask(()=>{
      const socket=new EventEmitter();Object.assign(socket,{remoteAddress:peer,remotePort:port,authorized,destroy(){state.destroyed++;}});
      request.emit('socket',socket);beforeConnect?.(state);if(!noConnect)socket.emit('secureConnect');
    });
    return request;
  };
  return state;
}
const transportFor=(fixture,options={})=>createImageJsonTransport({lookup:answers,httpsRequest:fixture.request,apiKey:key,...options});
let generated;
async function png() { return generated ??= await renderMockImagePng(); }
async function goodBody(extra={}) {return Buffer.from(JSON.stringify({created:1,data:[{b64_json:(await png()).toString('base64')}],...extra}));}

test('production construction has no live fallback and fixed profile has no endpoint/settings activation',async()=>{
  const snapshotProxy=new Proxy({},{get(){assert.fail('disabled adapter must not inspect snapshot');}});
  await assert.rejects(createOpenAIImageAdapter().generate(snapshotProxy),{code:'IMAGE_LIVE_DISABLED',dispatched:false,outcomeUnknown:false});
  for(const deps of [{},{lookup:answers},{httpsRequest:()=>assert.fail('no request')},{apiKey:key}]) assert.throws(()=>createImageJsonTransport(deps),{code:'IMAGE_LIVE_DISABLED'});
  assert.equal(IMAGE_PROFILES.find(v=>v.providerId==='openai').enabled,false);
  assert.equal(IMAGE_GENERATION_ENDPOINT,'https://api.openai.com/v1/images/generations');
});

test('wire body is exactly the verified pinned model/allowlist with no response_format or fallback',()=>{
  assert.deepEqual(JSON.parse(createImageGenerationBody(snapshot())),{model:'gpt-image-2.5-flare-2026-09-08',prompt:'Synthetic offline adapter test',n:1,quality:'low',size:'1024x1024',output_format:'png',background:'opaque',moderation:'auto'});
  for(const input of [{...snapshot(),model:'gpt-image-2.5-flare'},{...snapshot(),baseUrl:'https://other.example/v1'},{...snapshot(),options:{...IMAGE_FIXED_OPTIONS,size:'512x512'}},{...snapshot(),prompt:'x'.repeat(2001)},{...snapshot(),prompt:'\u0000'},{...snapshot(),apiKey:key}]) assert.throws(()=>createImageGenerationBody(input),{code:'IMAGE_INVALID_REQUEST'});
});

test('all DNS answers must be public and well-formed; no fallback around rejected answers',async()=>{
  for(const result of [[],[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],[{address:'168.63.129.16',family:4}],[{address:'::ffff:8.8.8.8',family:6}],[{address:'8.8.8.8',family:6}],Array(65).fill({address:'8.8.8.8',family:4})]) await assert.rejects(resolveImageDestination({lookup:async()=>result}),{code:'IMAGE_NETWORK_DENIED'});
  let count=0;
  assert.deepEqual(await resolveImageDestination({lookup:async(host,options)=>{count++;assert.equal(host,'api.openai.com');assert.deepEqual(options,{all:true,verbatim:true});return answers();}}),{hostname:'api.openai.com',port:443,secure:true,address:'8.8.8.8',family:4,path:'/v1/images/generations'});
  assert.equal(count,1);
});

test('fixed HTTPS peer and certificate verified before synchronous fence and first possible POST',async()=>{
  let fences=0,lookups=0;
  const fixture=injectedRequest({headers:{'content-type':'application/json; charset=utf-8','x-request-id':'req_offline-1'},beforeConnect:state=>{assert.equal(state.ends,0);assert.equal(fences,0);}});
  const result=await transportFor(fixture,{lookup:async()=>{lookups++;return answers();}})({...requestArgs,beforeDispatch:()=>{fences++;assert.equal(fixture.ends,0);}});
  assert.equal(lookups,1);assert.equal(fences,1);assert.equal(fixture.calls,1);assert.equal(fixture.ends,1);assert.equal(result.providerRequestId,'req_offline-1');assert.equal(result.dispatched,true);
  const o=fixture.options;assert.equal(o.path,'/v1/images/generations');assert.equal(o.hostname,'api.openai.com');assert.equal(o.servername,'api.openai.com');assert.equal(o.port,443);assert.equal(o.agent,false);assert.equal(o.autoSelectFamily,false);assert.equal(o.rejectUnauthorized,true);assert.equal(o.headers.Authorization,`Bearer ${key}`);assert.equal(o.headers['Accept-Encoding'],'identity');assert.equal(o.headers.Cookie,undefined);
  assert.ok(o.checkServerIdentity('ignored',{subjectaltname:'DNS:wrong.example',subject:{CN:'wrong.example'}}) instanceof Error);
  assert.deepEqual(await new Promise((resolve,reject)=>o.lookup('rebind.invalid',{all:true},(error,value)=>error?reject(error):resolve(value))),[{address:'8.8.8.8',family:4}]);
});

test('peer mismatch, bad port/TLS, DNS failure and fence failure cannot transmit',async()=>{
  for(const options of [{peer:'1.1.1.1'},{peer:'127.0.0.1'},{port:80},{authorized:false}]) {
    const f=injectedRequest(options);await assert.rejects(transportFor(f)(requestArgs),{code:'IMAGE_NETWORK_DENIED',dispatched:false});assert.equal(f.ends,0);
  }
  for(const beforeDispatch of [()=>{throw Error('private fence error');},async()=>{}]) {
    const f=injectedRequest();await assert.rejects(transportFor(f)({...requestArgs,beforeDispatch}),{code:'IMAGE_DISPATCH_BLOCKED',dispatched:false});assert.equal(f.ends,0);
  }
  const f=injectedRequest();await assert.rejects(transportFor(f,{lookup:async()=>{throw Error('private DNS details');}})(requestArgs),{code:'IMAGE_CONNECTION_FAILED',dispatched:false});assert.equal(f.calls,0);
});

test('redirects, compressed/non-JSON responses and incomplete/mismatched bodies fail without any retry',async()=>{
  for(const options of [{status:302},{status:429},{status:500},{headers:{'content-type':'text/html'}},{headers:{'content-type':'application/json','content-encoding':'gzip'}},{headers:{'content-type':'application/json','content-length':'3'}},{complete:false}]) {
    const f=injectedRequest(options);await assert.rejects(transportFor(f)(requestArgs),error=>{assert.equal(error.dispatched,true);assert.equal(error.outcomeUnknown,true);return true;});assert.equal(f.calls,1);assert.equal(f.ends,1);
  }
});

test('JSON stream byte bound is enforced before Buffer.concat or JSON.parse, including dishonest lengths',async()=>{
  for(const options of [{headers:{'content-type':'application/json','content-length':'101'}},{chunks:[Buffer.alloc(60),Buffer.alloc(41)]},{headers:{'content-type':'application/json','content-length':'2'},chunks:[Buffer.alloc(60),Buffer.alloc(41)]}]) {
    const f=injectedRequest(options);await assert.rejects(transportFor(f,{limits:{maxResponseBytes:100}})(requestArgs),{code:'IMAGE_RESPONSE_TOO_LARGE',dispatched:true});assert.equal(f.ends,1);
  }
  for(const value of [0,-1,Infinity,NaN,IMAGE_NETWORK_LIMITS.maxResponseBytes+1]) assert.throws(()=>transportFor(injectedRequest(),{limits:{maxResponseBytes:value}}),{code:'IMAGE_INVALID_REQUEST'});
});

test('pre/post-transmission cancellation and connect/total timeout retain distinct uncertainty',async()=>{
  const pre=new AbortController();pre.abort();const f=injectedRequest();await assert.rejects(transportFor(f)({...requestArgs,signal:pre.signal}),{code:'IMAGE_CANCELLED',dispatched:false,outcomeUnknown:false});assert.equal(f.calls,0);
  const mid=new AbortController(),g=injectedRequest({beforeConnect:()=>mid.abort()});await assert.rejects(transportFor(g)({...requestArgs,signal:mid.signal}),{code:'IMAGE_CANCELLED',dispatched:false});assert.equal(g.ends,0);
  const post=new AbortController(),h=injectedRequest({beforeResponse:()=>post.abort()});await assert.rejects(transportFor(h)({...requestArgs,signal:post.signal}),{code:'IMAGE_CANCELLED',dispatched:true,outcomeUnknown:true});assert.equal(h.ends,1);
  const unconnected=injectedRequest({noConnect:true});await assert.rejects(transportFor(unconnected,{limits:{connectTimeoutMs:5}})(requestArgs),{code:'IMAGE_TIMEOUT',dispatched:false});assert.equal(unconnected.ends,0);
  const stalled=injectedRequest({noResponse:true});await assert.rejects(transportFor(stalled,{limits:{totalTimeoutMs:10}})(requestArgs),{code:'IMAGE_TIMEOUT',dispatched:true});assert.equal(stalled.ends,1);
  const dns=injectedRequest();await assert.rejects(transportFor(dns,{lookup:()=>new Promise(()=>{}),limits:{connectTimeoutMs:5}})(requestArgs),{code:'IMAGE_TIMEOUT',dispatched:false});assert.equal(dns.calls,0);
});

test('strict canonical base64 rejects empty, data URI, whitespace, alphabet/padding errors and noncanonical pad bits',()=>{
  assert.deepEqual(decodeImageBase64('AQID'),Buffer.from([1,2,3]));
  for(const value of ['',null,'data:image/png;base64,AQID','AQID\n','AQI','AQID-___','A===','AA=A','AB==','AAB=']) assert.throws(()=>decodeImageBase64(value),{code:'IMAGE_RESPONSE_INVALID'});
  assert.throws(()=>decodeImageBase64('A'.repeat(Math.ceil(IMAGE_NETWORK_LIMITS.maxDecodedBytes/3)*4+4)),{code:'IMAGE_RESPONSE_INVALID'});
});

test('valid offline response preserves only bounded metadata and verified PNG bytes',async()=>{
  const usage={input_tokens:12,output_tokens:20,total_tokens:32,input_tokens_details:{text_tokens:12,image_tokens:0}};
  const result=await decodeImageJsonResponse(await goodBody({background:'opaque',output_format:'png',quality:'low',size:'1024x1024',usage}),{providerRequestId:'req_test'});
  assert.deepEqual(result.bytes,await png());assert.equal(result.metadata.width,1024);assert.equal(result.metadata.isMock,false);assert.deepEqual(result.metadata.usage,usage);assert.equal(result.metadata.providerRequestId,'req_test');
  const malformedId=await decodeImageJsonResponse(await goodBody(),{providerRequestId:'unsafe\nprivate'});assert.equal(malformedId.metadata.providerRequestId,null);
});

test('JSON rejects URL/multiple/empty results, duplicate escaped keys, unknown metadata, malformed UTF8 and unsafe numbers',async()=>{
  const b64=(await png()).toString('base64');
  const cases=[{data:[]},{data:[{url:'https://example.invalid/image.png'}]},{data:[{b64_json:b64,url:'https://example.invalid/image.png'}]},{data:[{b64_json:b64},{b64_json:b64}]},{data:[{b64_json:b64}],created:Infinity},{data:[{b64_json:b64}],usage:{total_tokens:-1}},{data:[{b64_json:b64}],usage:{input_tokens:1e100}},{data:[{b64_json:b64}],usage:{private:'secret'}},{data:[{b64_json:b64}],background:'transparent'},{data:[{b64_json:b64}],unknown:'ignored?'}];
  for(const value of cases) await assert.rejects(decodeImageJsonResponse(Buffer.from(JSON.stringify(value))),{code:'IMAGE_RESPONSE_INVALID'});
  for(const body of [Buffer.from('{"data":[],"d\\u0061ta":[]}'),Buffer.from('{"data":[],"created":1e999}'),Buffer.from('{"data":[],"usage":'+ '['.repeat(10)+'0'+']'.repeat(10)+'}'),Buffer.from([0xff,0xfe]),Buffer.from('\ufeff{}')]) await assert.rejects(decodeImageJsonResponse(body),{code:'IMAGE_RESPONSE_INVALID'});
});

test('OpenAI adapter fences once and preserves post-dispatch invalid PNG/transport uncertainty without retry',async()=>{
  let fences=0;
  const f=injectedRequest({body:await goodBody()});const adapter=createOpenAIImageAdapter({transport:transportFor(f)});
  const result=await adapter.generate(snapshot(),{beforeDispatch:()=>{fences++;}});assert.equal(fences,1);assert.equal(f.ends,1);assert.equal(result.metadata.isMock,false);
  const g=injectedRequest({body:Buffer.from(JSON.stringify({data:[{b64_json:Buffer.from('not PNG').toString('base64')}]}))});
  await assert.rejects(createOpenAIImageAdapter({transport:transportFor(g)}).generate(snapshot(),{beforeDispatch:()=>{}}),{code:'IMAGE_PNG_INVALID',dispatched:true,outcomeUnknown:true});assert.equal(g.ends,1);
  const h=injectedRequest({noConnect:true});await assert.rejects(createOpenAIImageAdapter({transport:transportFor(h,{limits:{connectTimeoutMs:5}})}).generate(snapshot(),{beforeDispatch:()=>{}}),{code:'IMAGE_TIMEOUT',dispatched:false});assert.equal(h.ends,0);
  let attempts=0;const broken=createOpenAIImageAdapter({transport:async({beforeDispatch})=>{attempts++;beforeDispatch();throw Error('private upstream fault');}});
  await assert.rejects(broken.generate(snapshot(),{beforeDispatch:()=>{}}),{code:'IMAGE_RESPONSE_INVALID',dispatched:true});assert.equal(attempts,1);
});

test('Mock adapter is prompt-independent, truthfully labeled and validates input before local fence',async()=>{
  let fences=0;const a=createMockImageAdapter(),opts={beforeDispatch:()=>{fences++;}};
  const first=await a.generate(snapshot('mock','A red car'),opts),second=await a.generate(snapshot('mock','A blue boat'),opts);
  assert.deepEqual(first.bytes,second.bytes);assert.equal(first.metadata.isMock,true);assert.equal(first.metadata.providerRequestId,null);assert.equal(fences,2);
  await assert.rejects(a.generate(snapshot('openai'),opts),{code:'IMAGE_INVALID_REQUEST'});assert.equal(fences,2);
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(a.generate(snapshot('mock'),{...opts,signal:cancelled.signal}),{code:'IMAGE_CANCELLED'});assert.equal(fences,2);
});

test('errors do not echo arbitrary upstream messages, response headers, bodies or credential sentinel',()=>{
  for(const code of ['IMAGE_TIMEOUT','private_key='+key,undefined]) {const error=imageAdapterError(code,{dispatched:true});assert.equal(error.message.includes(key),false);assert.equal(error.message.includes('private_key'),false);assert.equal(error.cause,undefined);}
});


test('Mock errors after the host fence preserve dispatched state without remote uncertainty',async()=>{
  const controller=new AbortController();
  await assert.rejects(createMockImageAdapter().generate(snapshot('mock'),{signal:controller.signal,beforeDispatch:()=>controller.abort()}),{code:'IMAGE_CANCELLED',dispatched:true,outcomeUnknown:false});
});

test('OpenAI malformed transport return after its fence stays conservatively dispatched',async()=>{
  const transport=async({beforeDispatch})=>{beforeDispatch();return {};};
  await assert.rejects(createOpenAIImageAdapter({transport}).generate(snapshot(),{beforeDispatch:()=>{}}),{code:'IMAGE_RESPONSE_INVALID',dispatched:true,outcomeUnknown:true});
});
