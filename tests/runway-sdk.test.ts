import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunwaySdkClient} from '../packages/business/src/video/runway-sdk.ts';
import {createJsonRequest,providerError} from '../packages/business/src/providers/live-common.ts';
import type {ProviderContext} from '../packages/business/src/providers/live-common.ts';
import type {VideoAdapterInput} from '../packages/business/src/video/adapters.ts';

const API='https://api.dev.runwayml.com';
const ID='12345678-1234-4123-8123-123456789abc';
const SECRET='runway-private-test-key';
const input:VideoAdapterInput={prompt:'A synthetic shape moves',aspectRatio:'9:16',duration:5,parameters:{seed:123,resolution:'720P'},images:[{mimeType:'image/png',base64:'c3ludGhldGlj',role:'first_frame'}],subjectReference:false};
type ResponseItem=Response|Error|((init:RequestInit)=>Promise<Response>);
function fixture(responses:ResponseItem[],{model='gen4_turbo',ensureEnabled=()=>{}}:{model?:string;ensureEnabled?:()=>void}={}) {
  const calls:Array<{url:string;init:RequestInit}>=[];
  const fetchImpl:typeof fetch=async(url,init={})=>{
    calls.push({url:String(url),init});const next=responses.shift();
    if(next instanceof Error)throw next;
    if(typeof next==='function')return next(init);
    assert.ok(next,'Only injected responses may be used');return next;
  };
  const sdk=createRunwaySdkClient({api:API,model,send:(endpoint,options)=>createJsonRequest({api:API,headers:{...options.headers,Authorization:`Bearer ${SECRET}`},fetchImpl,ensureEnabled,name:'Runway'})(endpoint,options)});
  return {sdk,calls};
}
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const bodyOf=(init:RequestInit)=>JSON.parse(typeof init.body==='string'?init.body:Buffer.from(init.body as Uint8Array).toString('utf8')) as Record<string,unknown>;

test('Runway official SDK builds the create request before the bounded application transport',async()=>{
  const f=fixture([json({id:ID})]);
  assert.deepEqual(await f.sdk.submit(input),{id:ID});assert.equal(f.calls.length,1);
  const {url,init}=f.calls[0]!;assert.equal(url,`${API}/v1/image_to_video`);assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
  const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),`Bearer ${SECRET}`);assert.equal(headers.get('x-runway-version'),'2024-11-06');assert.equal(headers.get('idempotency-key'),null);assert.equal(headers.get('x-stainless-retry-count'),null);
  assert.deepEqual(bodyOf(init),{model:'gen4_turbo',promptImage:'data:image/png;base64,c3ludGhldGlj',promptText:input.prompt,ratio:'720:1280',duration:5,seed:123});
});

test('Runway official SDK preserves a custom template model ID and omits an absent seed',async()=>{
  const f=fixture([json({id:ID})],{model:'custom-reviewed-model'});
  await f.sdk.submit({...input,parameters:{resolution:'720P'}});
  assert.deepEqual(bodyOf(f.calls[0]!.init),{model:'custom-reviewed-model',promptImage:'data:image/png;base64,c3ludGhldGlj',promptText:input.prompt,ratio:'720:1280',duration:5});
});

test('Runway historical task retrieval keeps its ID and raw task response',async()=>{
  const task={id:ID,status:'CANCELLED',createdAt:'2026-01-01T00:00:00Z',historical:true},f=fixture([json(task)]);
  assert.deepEqual(await f.sdk.retrieve(ID),task);assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.url,`${API}/v1/tasks/${ID}`);assert.equal(f.calls[0]!.init.method,'GET');assert.equal(f.calls[0]!.init.body,undefined);
  for(const id of ['../other','not-a-uuid',ID.replace('-4123-','-3123-')])await assert.rejects(f.sdk.retrieve(id),{code:'INVALID_PROVIDER_TASK_ID'});
  assert.equal(f.calls.length,1);
});

for(const status of [408,409,429,500])test(`Runway official SDK never retries a POST HTTP ${status}`,async()=>{
  const f=fixture([json({secret:SECRET},status)]);
  await assert.rejects(f.sdk.submit(input),(error:unknown)=>{
    const failure=error as {code:string;message:string;uncertain:boolean};assert.equal(failure.code,status===429?'PROVIDER_HTTP_429':'SUBMISSION_UNKNOWN');assert.equal(failure.uncertain,status!==429);assert.doesNotMatch(failure.message,/private-test-key/);return true;
  });assert.equal(f.calls.length,1);
});

for(const response of [new Error(`failed ${SECRET}`),new DOMException(SECRET,'TimeoutError'),new Response('invalid'),json({id:ID},500)])test(`Runway official SDK keeps transport failure semantics: ${response instanceof Error?response.name:response.status}`,async()=>{
  const f=fixture([response]);await assert.rejects(f.sdk.submit(input),{code:'SUBMISSION_UNKNOWN',uncertain:true});assert.equal(f.calls.length,1);
});

test('Runway official SDK preserves dispatch fences and cancellation without a hidden POST',async()=>{
  const f=fixture([json({id:ID})]);
  const controller=new AbortController();controller.abort();await assert.rejects(f.sdk.submit(input,{signal:controller.signal}),{code:'OPERATION_CANCELLED'});assert.equal(f.calls.length,0);
  const denied=providerError('VIDEO_CREDENTIAL_UNAVAILABLE','The bound credential was revoked.',{beforeDispatch:true});
  await assert.rejects(f.sdk.submit(input,{beforeSubmit(){throw denied;}}),error=>error===denied);assert.equal(f.calls.length,0);
});

test('Runway official SDK keeps concurrent operation contexts separate',async()=>{
  const first=new AbortController(),second=new AbortController(),seen=new Map<string,AbortSignal>(),f=fixture([
    async init=>{seen.set(init.method!,init.signal!);assert.equal(init.signal?.aborted,false);return json({id:ID});},
    async init=>{seen.set(init.method!,init.signal!);assert.equal(init.signal?.aborted,false);return json({id:ID,status:'PENDING'});},
  ]);
  const contexts:ProviderContext[]=[{signal:first.signal},{signal:second.signal}];
  await Promise.all([f.sdk.submit(input,contexts[0]),f.sdk.retrieve(ID,contexts[1])]);assert.equal(seen.size,2);assert.notEqual(seen.get('POST'),seen.get('GET'));
  first.abort();assert.equal(seen.get('POST')?.aborted,true);assert.equal(seen.get('GET')?.aborted,false);
});

test('Runway ambient SDK environment cannot replace bound origin, credential, version or add headers',async t=>{
  const keys=['RUNWAYML_API_SECRET','RUNWAYML_BASE_URL','RUNWAYML_CUSTOM_HEADERS','RUNWAYML_LOG'] as const,original=keys.map(key=>process.env[key]);
  t.after(()=>keys.forEach((key,index)=>{if(original[index]===undefined)delete process.env[key];else process.env[key]=original[index];}));
  Object.assign(process.env,{RUNWAYML_API_SECRET:'ambient-secret',RUNWAYML_BASE_URL:'https://wrong-origin.example',RUNWAYML_CUSTOM_HEADERS:'X-Runway-Version: 2000-01-01\nAuthorization: Bearer ambient-secret\nX-Ambient-Secret: should-not-leave',RUNWAYML_LOG:'debug'});
  const f=fixture([json({id:ID})]);await f.sdk.submit(input);assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.url,`${API}/v1/image_to_video`);
  const headers=new Headers(f.calls[0]!.init.headers);assert.equal(headers.get('authorization'),`Bearer ${SECRET}`);assert.equal(headers.get('x-runway-version'),'2024-11-06');assert.equal(headers.get('x-ambient-secret'),null);
});

test('Runway SDK rejects unsupported inputs before invoking its transport',async()=>{
  const f=fixture([]);
  for(const patch of [{images:[]},{images:[...input.images,...input.images]},{images:[{...input.images[0]!,role:'last_frame'}]},{subjectReference:true},{aspectRatio:'adaptive'},{parameters:{watermark:false}}])await assert.rejects(f.sdk.submit({...input,...patch}));
  assert.equal(f.calls.length,0);
});
