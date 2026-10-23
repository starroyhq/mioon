import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createMinimaxSdkClient} from '../packages/business/src/video/minimax-sdk.ts';
import {createMinimaxProvider} from '../packages/business/src/providers/minimax.ts';
import {createJsonRequest,providerError} from '../packages/business/src/providers/live-common.ts';
import type {ProviderContext} from '../packages/business/src/providers/live-common.ts';
import type {VideoAdapterInput} from '../packages/business/src/video/adapters.ts';

const API='https://api.minimax.io';
const ID='historical-minimax-task';
const SECRET='minimax-private-test-key';
const input:VideoAdapterInput={prompt:'A synthetic shape moves',aspectRatio:'9:16',duration:4,parameters:{resolution:'2K'},images:[],subjectReference:false};
type ResponseItem=Response|Error|((init:RequestInit)=>Promise<Response>);
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const bodyOf=(init:RequestInit)=>JSON.parse(typeof init.body==='string'?init.body:Buffer.from(init.body as Uint8Array).toString('utf8')) as Record<string,unknown>;
function fixture(responses:ResponseItem[],{api=API,model='MiniMax-H3',ensureEnabled=()=>{}}:{api?:string;model?:string;ensureEnabled?:()=>void}={}) {
  const calls:Array<{url:string;init:RequestInit}>=[];
  const fetchImpl:typeof fetch=async(url,init={})=>{
    calls.push({url:String(url),init});const next=responses.shift();
    if(next instanceof Error)throw next;
    if(typeof next==='function')return next(init);
    assert.ok(next,'Only injected responses may be used');return next;
  };
  const sdk=createMinimaxSdkClient({api,model,send:(endpoint,options)=>createJsonRequest({api,headers:{...options.headers,Authorization:`Bearer ${SECRET}`},fetchImpl,ensureEnabled,name:'MiniMax'})(endpoint,options)});
  return {sdk,calls,fetchImpl};
}

for(const api of [API,'https://api.minimax.cn'])test(`MiniMax official SDK builds a 2K text task at bound ${api}`,async()=>{
  const receipt={task_id:ID,usage:{seconds:4}},f=fixture([json(receipt)],{api});
  assert.deepEqual(await f.sdk.submit(input),receipt);assert.equal(f.calls.length,1);
  const {url,init}=f.calls[0]!;assert.equal(url,`${api}/v2/video_generation`);assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
  const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),`Bearer ${SECRET}`);assert.equal(headers.get('idempotency-key'),null);
  assert.deepEqual(bodyOf(init),{model:'MiniMax-H3',content:[{type:'text',text:input.prompt}],duration:4,resolution:'2K',ratio:'9:16'});
  assert.equal(Object.hasOwn(bodyOf(init),'async'),false);assert.equal(Object.hasOwn(bodyOf(init),'seed'),false);
});

test('MiniMax official SDK preserves approved first-frame bytes and adaptive ratio',async()=>{
  const f=fixture([json({task_id:ID})]),image={role:'first_frame',mimeType:'image/jpeg',base64:'c3ludGhldGlj'};
  await f.sdk.submit({...input,duration:8,images:[image]});
  assert.deepEqual(bodyOf(f.calls[0]!.init),{model:'MiniMax-H3',content:[{type:'text',text:input.prompt},{type:'image_url',image_url:{url:'data:image/jpeg;base64,c3ludGhldGlj'},role:'first_frame'}],duration:8,resolution:'2K',ratio:'adaptive'});
});

test('MiniMax SDK rejects frozen 768P parameters before dispatch without upgrading them',async()=>{
  const f=fixture([]),historical={...input,parameters:{resolution:'768P'}},before=structuredClone(historical);
  await assert.rejects(f.sdk.submit(historical),{code:'UNSUPPORTED_PARAMETERS',beforeDispatch:true});
  assert.deepEqual(historical,before);assert.equal(f.calls.length,0);
});

test('MiniMax generate retains official model/duration/ratio/content validation',async()=>{
  const f=fixture([]);
  for(const patch of [{duration:3},{duration:16},{aspectRatio:'invalid-ratio'},{prompt:' '},{prompt:'x'.repeat(7001)}])await assert.rejects(f.sdk.submit({...input,...patch}),{code:'VIDEO_SDK_REQUEST_FAILED',beforeDispatch:true});
  const custom=fixture([],{model:'custom-h3-name'});await assert.rejects(custom.sdk.submit(input),{code:'VIDEO_SDK_REQUEST_FAILED',beforeDispatch:true});
  assert.equal(f.calls.length,0);assert.equal(custom.calls.length,0);
});

test('MiniMax historical task query keeps the raw V2 wrapper and performs no generation',async()=>{
  const task={task:{id:ID,status:'succeeded',resolution:'768P',duration:4,content:{url:'https://video-product.cdn.minimax.io/historical.mp4'}},legacy:true},f=fixture([json(task)]);
  assert.deepEqual(await f.sdk.retrieve(ID),task);assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.url,`${API}/v2/query/video_generation/${ID}`);assert.equal(f.calls[0]!.init.method,'GET');assert.equal(f.calls[0]!.init.body,undefined);
  for(const id of ['../task','a/b','https://other.invalid',''])await assert.rejects(f.sdk.retrieve(id),{code:'INVALID_PROVIDER_TASK_ID'});
  assert.equal(f.calls.length,1);
});

for(const status of [400,408,409,429,500])test(`MiniMax official SDK never retries POST HTTP ${status}`,async()=>{
  const f=fixture([json({error:{message:SECRET}},status)]);
  await assert.rejects(f.sdk.submit(input),(error:unknown)=>{
    const failure=error as {code:string;message:string;uncertain:boolean};assert.equal(failure.code,[400,429].includes(status)?`PROVIDER_HTTP_${status}`:'SUBMISSION_UNKNOWN');assert.equal(failure.uncertain,![400,429].includes(status));assert.doesNotMatch(failure.message,/private-test-key/);return true;
  });assert.equal(f.calls.length,1);
});

for(const response of [new Error(`lost ${SECRET}`),new DOMException(SECRET,'TimeoutError'),new Response('invalid')])test(`MiniMax official SDK preserves uncertain ${response instanceof Error?response.name:'invalid JSON'} submission without retry`,async()=>{
  const f=fixture([response]);await assert.rejects(f.sdk.submit(input),{code:'SUBMISSION_UNKNOWN',uncertain:true});assert.equal(f.calls.length,1);
});

test('MiniMax official SDK preserves cancellation and the final credential/submit fence',async()=>{
  const f=fixture([json({task_id:ID})]),controller=new AbortController();controller.abort();
  await assert.rejects(f.sdk.submit(input,{signal:controller.signal}),{code:'OPERATION_CANCELLED'});assert.equal(f.calls.length,0);
  const revoked=providerError('VIDEO_CREDENTIAL_UNAVAILABLE','The bound credential was revoked.',{beforeDispatch:true});
  await assert.rejects(f.sdk.submit(input,{beforeSubmit(){throw revoked;}}),error=>error===revoked);assert.equal(f.calls.length,0);
});

test('MiniMax official SDK keeps post-dispatch cancellation uncertain with one POST',async()=>{
  const controller=new AbortController(),f=fixture([async init=>{assert.equal(init.signal?.aborted,false);controller.abort();throw new DOMException('cancelled','AbortError');}]);
  await assert.rejects(f.sdk.submit(input,{signal:controller.signal}),{code:'SUBMISSION_UNKNOWN',uncertain:true});assert.equal(f.calls.length,1);
});

test('MiniMax SDK operations keep their individual signals and regional contexts',async()=>{
  const first=new AbortController(),second=new AbortController(),seen=new Map<string,AbortSignal>(),f=fixture([
    async init=>{seen.set(init.method!,init.signal!);return json({task_id:ID});},
    async init=>{seen.set(init.method!,init.signal!);return json({task:{id:ID,status:'running'}});},
  ]),contexts:ProviderContext[]=[{signal:first.signal},{signal:second.signal}];
  await Promise.all([f.sdk.submit(input,contexts[0]),f.sdk.retrieve(ID,contexts[1])]);assert.equal(seen.size,2);assert.notEqual(seen.get('POST'),seen.get('GET'));
  first.abort();assert.equal(seen.get('POST')?.aborted,true);assert.equal(seen.get('GET')?.aborted,false);
});

test('MiniMax SDK cannot take credentials, origin, model or verbosity from CLI config and environment',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mioon-minimax-cli-config-'));
  await writeFile(path.join(dir,'config.json'),JSON.stringify({api_key:'file-private-key',base_url:'https://file-origin.invalid',region:'cn',default_video_model:'other-model',timeout:1,verbose:true,oauth:{access_token:'file-private-token',resource_url:'https://oauth-origin.invalid'}}));
  const keys=['MMX_CONFIG_DIR','MINIMAX_API_KEY','MINIMAX_BASE_URL','MINIMAX_REGION','MINIMAX_VERBOSE','MINIMAX_TIMEOUT'] as const,original=keys.map(key=>process.env[key]);
  t.after(async()=>{keys.forEach((key,index)=>{if(original[index]===undefined)delete process.env[key];else process.env[key]=original[index];});await rm(dir,{recursive:true,force:true});});
  Object.assign(process.env,{MMX_CONFIG_DIR:dir,MINIMAX_API_KEY:'ambient-private-key',MINIMAX_BASE_URL:'https://ambient-origin.invalid',MINIMAX_REGION:'cn',MINIMAX_VERBOSE:'1',MINIMAX_TIMEOUT:'1'});
  const f=fixture([json({task_id:ID}),json({task:{id:ID,status:'running'}})]);
  await f.sdk.submit(input);await f.sdk.retrieve(ID);assert.equal(f.calls.length,2);
  for(const call of f.calls){assert.ok(call.url.startsWith(`${API}/`));assert.equal(new Headers(call.init.headers).get('authorization'),`Bearer ${SECRET}`);}
  assert.equal(bodyOf(f.calls[0]!.init).model,'MiniMax-H3');assert.doesNotMatch(JSON.stringify(f.calls),/file-private|ambient-private|mioon-bound-transport/);
  assert.equal(process.env.MINIMAX_BASE_URL,'https://ambient-origin.invalid');assert.equal(process.env.MMX_CONFIG_DIR,dir);
});

test('MiniMax SDK rejects unsupported template inputs and arbitrary endpoints before dispatch',async()=>{
  const f=fixture([]),image={role:'first_frame',mimeType:'image/png',base64:'c3ludGhldGlj'};
  for(const patch of [{parameters:{resolution:'2K',seed:1}},{images:[{...image,role:'last_frame'}]},{images:[image,image]},{subjectReference:true}])await assert.rejects(f.sdk.submit({...input,...patch}));
  for(const api of ['https://other.invalid','https://api.minimax.io/path','https://api.minimax.io/'])assert.throws(()=>createMinimaxSdkClient({api,model:'MiniMax-H3',send:async()=>({})}),{code:'VIDEO_BINDING_INVALID'});
  assert.equal(f.calls.length,0);
});

test('MiniMax legacy 768P task stays queryable while its frozen retry is rejected',async()=>{
  const f=fixture([json({task:{id:ID,status:'succeeded',resolution:'768P',content:{url:'https://video-product.cdn.minimax.io/historical.mp4'}}})]);
  const provider=createMinimaxProvider({root:'/unused-test-root',env:{MINIMAX_API_KEY:SECRET,MIOON_ENABLE_LIVE_PROVIDER:'1'},fetchImpl:f.fetchImpl});
  const snapshot={model:'MiniMax-H3',prompt:input.prompt,duration:4,aspectRatio:'9:16',parameters:{},referenceAssets:[],capabilities:{modelCapabilities:[{id:'MiniMax-H3',resolutions:['768P']}]}};
  const before=structuredClone(snapshot);assert.equal((await provider.poll(ID)).status,'succeeded');
  await assert.rejects(provider.submit(snapshot),{code:'UNSUPPORTED_PARAMETERS',beforeDispatch:true});assert.deepEqual(snapshot,before);assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.init.method,'GET');
  assert.deepEqual(provider.capabilities.modelCapabilities[0]?.resolutions,['2K']);
});
