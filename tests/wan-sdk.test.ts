import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {crc32,deflateSync} from 'node:zlib';
import {build} from 'esbuild';
import {createWanSdkClient,validateWanImageBytes} from '../packages/business/src/video/wan-sdk.ts';
import {defaultVideoModels,resolveVideoEndpoint} from '../packages/contracts/src/video-providers.ts';
import type {VideoExecutionBinding} from '../packages/contracts/src/video-providers.ts';
import type {VideoAdapterInput} from '../packages/business/src/video/adapters.ts';

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const object=(value:unknown)=>value as Record<string,unknown>;
function bindingFor(modelId='wan2.7-t2v',region='cn-beijing',workspaceId=''): VideoExecutionBinding {
  const model=defaultVideoModels('wan').find(model=>model.modelId===modelId);
  assert.ok(model,`Missing test model ${modelId}`);
  return {version:1,connectionId:randomUUID(),configurationRevision:1,providerId:'wan',region,workspaceId,endpoint:resolveVideoEndpoint('wan',region,workspaceId),credentialRef:randomUUID(),model,outputHosts:['result.example']};
}
const inputFor=(parameters:Record<string,unknown>={}): VideoAdapterInput=>({prompt:'图1向图2缓慢移动',aspectRatio:'16:9',duration:5,parameters:{resolution:'720P',...parameters},images:[],subjectReference:false});
const image=(role:string,base64='aW1hZ2U=')=>({role,mimeType:'image/png',base64});
function fixture(binding=bindingFor()) {
  const calls:Array<{url:string;init:RequestInit}>=[],queue:Array<Response|Error>=[];
  let secret='PRIVATE-KEY',acquisitions=0;
  const client=createWanSdkClient({binding,acquireCredential:async()=>{acquisitions++;return secret;},fetchImpl:async(url,init)=>{calls.push({url:String(url),init:init??{}});const response=queue.shift();if(response instanceof Error)throw response;if(!response)throw Error('Real network is forbidden');return response;}});
  return {client,calls,queue,binding,key:(value:string)=>{secret=value;},acquisitions:()=>acquisitions};
}

test('Wan 2.7 submission uses the real SDK envelope and preserves existing parameters',async()=>{
  const f=fixture();assert.equal(f.acquisitions(),0);assert.equal(f.calls.length,0);
  f.queue.push(json({output:{task_id:'task-123'}}));let fences=0;
  assert.equal(await f.client.submit(inputFor({seed:42}),{requestId:'not-a-provider-parameter',jobId:'private-local-job',beforeSubmit:()=>{fences++;}}),'task-123');
  const call=f.calls[0]!,body=object(JSON.parse(String(call.init.body))),headers=new Headers(call.init.headers);
  assert.equal(fences,1);assert.equal(f.acquisitions(),1);assert.equal(call.url,'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis');assert.equal(call.init.method,'POST');assert.equal(call.init.redirect,'error');assert.ok(call.init.signal);
  assert.equal(headers.get('Authorization'),'Bearer PRIVATE-KEY');assert.equal(headers.get('X-DashScope-Async'),'enable');
  assert.deepEqual(body,{model:'wan2.7-t2v',input:{prompt:'图1向图2缓慢移动',extend_prompt:false},parameters:{duration:5,resolution:'720P',prompt_extend:false,watermark:false,ratio:'16:9',seed:42}});
  assert.doesNotMatch(String(call.init.body),/requestId|signal|jobId|PRIVATE-KEY|private-local-job/);
});

test('Wan 2.7 first frame remains a data URI and does not gain Wan 3.0 audio or ratio options',async()=>{
  const f=fixture(bindingFor('wan2.7-i2v'));f.queue.push(json({output:{task_id:'legacy-123'}}));
  const input=inputFor();input.images=[image('first_frame')];await f.client.submit(input);
  const body=object(JSON.parse(String(f.calls[0]!.init.body)));
  assert.deepEqual(object(body.input).media,[{type:'first_frame',url:'data:image/png;base64,aW1hZ2U='}]);
  assert.equal(object(body.parameters).audio,undefined);assert.equal(object(body.parameters).ratio,undefined);
});

test('custom model names cannot select an SDK-inferred task protocol',async()=>{
  const binding=bindingFor();binding.model.modelId='custom-kf2v-model';
  const f=fixture(binding);f.queue.push(json({output:{task_id:'custom-task'}}));
  await f.client.submit(inputFor());
  assert.equal(f.calls[0]!.url,binding.endpoint+'/services/aigc/video-generation/video-synthesis');
  const body=object(JSON.parse(String(f.calls[0]!.init.body)));
  assert.equal(body.model,'custom-kf2v-model');assert.equal(object(body.parameters).task,undefined);
});

for(const model of ['wan3.0-video','wan3.0-video-prime'])test(`${model} defaults and all supported media modes are built by SDK asyncCall`,async()=>{
  const f=fixture(bindingFor(model));
  const inputs=[[],[image('first_frame')],[image('first_frame','Zmlyc3Q='),image('last_frame','bGFzdA==')],Array.from({length:10},(_,index)=>image('reference_image',Buffer.from(`image-${index}`).toString('base64')))];
  for(const images of inputs){
    f.queue.push(json({output:{task_id:`task-${f.calls.length}`}}));await f.client.submit({...inputFor(),images});
    const body=object(JSON.parse(String(f.calls.at(-1)!.init.body)));
    assert.equal(body.model,model);assert.equal(object(body.input).extend_prompt,false);
    assert.deepEqual(object(body.parameters),{duration:5,resolution:'720P',prompt_extend:true,watermark:false,ratio:'16:9',audio:true});
    assert.deepEqual(object(body.input).media,images.length?images.map(item=>({type:item.role,url:`data:${item.mimeType};base64,${item.base64}`})):undefined);
  }
});

test('Wan 3.0 automatic output and switches are isolated to SDK parameters',async()=>{
  const f=fixture(bindingFor('wan3.0-video'));f.queue.push(json({output:{task_id:'smart-123'}}));
  await f.client.submit(inputFor({durationSeconds:-1,aspectRatio:'adaptive',generateAudio:false,promptExtend:false,watermark:true,seed:-1,resolution:'480P'}));
  const body=object(JSON.parse(String(f.calls[0]!.init.body)));
  assert.deepEqual(body.parameters,{duration:-1,resolution:'480P',prompt_extend:false,watermark:true,ratio:'adaptive',audio:false,seed:-1});
  assert.equal(object(body.input).extend_prompt,false);
});

test('a model name cannot upgrade a Wan 2.7 template to Wan 3.0 defaults',async()=>{
  const binding=bindingFor();binding.model.modelId='wan3.0-video';
  const f=fixture(binding);f.queue.push(json({output:{task_id:'custom-123'}}));await f.client.submit(inputFor());
  const params=object(object(JSON.parse(String(f.calls[0]!.init.body))).parameters);
  assert.equal(params.prompt_extend,false);assert.equal(params.audio,undefined);
});

for(const region of ['cn-beijing','ap-southeast-1'])test(`Wan SDK fetch is pinned to frozen ${region} workspace and refreshes credentials`,async()=>{
  const f=fixture(bindingFor('wan3.0-video',region,'workspace-123'));
  f.queue.push(json({output:{task_id:'known-123',task_status:'RUNNING'}}),json({output:{task_id:'known-123',task_status:'SUCCEEDED',video_url:'https://result.example/result.mp4'}}));
  assert.deepEqual(await f.client.retrieve('known-123'),{id:'known-123',status:'running'});f.key('ROTATED-KEY');
  assert.equal((await f.client.retrieve('known-123')).status,'succeeded');assert.equal(f.acquisitions(),2);
  assert.ok(f.calls.every(call=>call.url===`https://workspace-123.${region}.maas.aliyuncs.com/api/v1/tasks/known-123`&&call.init.method==='GET'&&call.init.redirect==='error'));
  assert.equal(new Headers(f.calls[0]!.init.headers).get('X-DashScope-WorkSpace'),'workspace-123');assert.equal(new Headers(f.calls[1]!.init.headers).get('Authorization'),'Bearer ROTATED-KEY');
  f.key('');await assert.rejects(f.client.retrieve('known-123'),{code:'VIDEO_CREDENTIAL_UNAVAILABLE'});assert.equal(f.calls.length,2);
});

test('Wan ignores ambient DashScope account, endpoint and workspace configuration',async()=>{
  const names=['DASHSCOPE_API_KEY','DASHSCOPE_HTTP_BASE_URL','DASHSCOPE_API_REGION','DASHSCOPE_WORKSPACE_ID','DASHSCOPE_WEBSOCKET_BASE_URL'] as const;
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  try{
    for(const name of names)process.env[name]='INVALID-AMBIENT-CONFIGURATION';
    const f=fixture();f.queue.push(json({output:{task_id:'task-123'}}));await f.client.submit(inputFor());
    assert.equal(new Headers(f.calls[0]!.init.headers).get('Authorization'),'Bearer PRIVATE-KEY');assert.equal(new Headers(f.calls[0]!.init.headers).get('X-DashScope-WorkSpace'),null);assert.match(f.calls[0]!.url,/^https:\/\/dashscope\.aliyuncs\.com\//);
  }finally{for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}}
});

test('Wan unsupported local fields and mixed image modes never enter SDK rest parameters',async()=>{
  const f=fixture(bindingFor('wan3.0-video'));
  for(const parameters of [{signal:{}},{requestId:'private'},{wait_timeout:30},{extra_input:{media:[]}}])await assert.rejects(f.client.submit(inputFor(parameters)),{code:'UNSUPPORTED_PARAMETER'});
  for(const images of [[image('last_frame')],[image('first_frame'),image('reference_image')],Array.from({length:11},()=>image('reference_image'))])await assert.rejects(f.client.submit({...inputFor(),images}),{code:'UNSUPPORTED_INPUT_ROLE'});
  await assert.rejects(f.client.submit({...inputFor(),subjectReference:true}),{code:'UNSUPPORTED_INPUT_ROLE'});assert.equal(f.calls.length,0);assert.equal(f.acquisitions(),0);
});

test('Wan before-submit fences and cancellation prevent dispatch',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(f.client.submit(inputFor(),{signal:controller.signal}),{code:'OPERATION_CANCELLED',beforeDispatch:true});assert.equal(f.acquisitions(),0);
  const fence=Object.assign(new Error('paused'),{code:'FENCE_CLOSED'});
  await assert.rejects(f.client.submit(inputFor(),{beforeSubmit:()=>{throw fence;}}),error=>error===fence);assert.equal(f.calls.length,0);
});

test('Wan lost or inconclusive submission never performs an automatic retry or exposes provider errors',async()=>{
  for(const response of [new Error('PRIVATE-KEY provider stack'),json({secret:'PRIVATE-KEY'},500),json({secret:'PRIVATE-KEY'},302),new Response('{PRIVATE-KEY'),json({output:{task_id:'bad/task'}})]){
    const f=fixture();f.queue.push(response);await assert.rejects(f.client.submit(inputFor()),error=>{assert.equal(object(error).code,'SUBMISSION_UNKNOWN');assert.equal(object(error).uncertain,true);assert.doesNotMatch(String(error),/PRIVATE-KEY/);return true;});assert.equal(f.calls.length,1);
  }
});

test('Wan transport timeout and cancellation after dispatch keep the submission uncertain',async t=>{
  for(const timedOut of [false,true]){
    const controller=new AbortController(),timeout=new AbortController();let dispatches=0,timeoutMs=0;
    const mock=timedOut?t.mock.method(AbortSignal,'timeout',(milliseconds:number)=>{timeoutMs=milliseconds;return timeout.signal;}):undefined;
    try{
      const client=createWanSdkClient({binding:bindingFor(),acquireCredential:async()=> 'PRIVATE-KEY',fetchImpl:async(_url,init)=>{
        dispatches++;const signal=init?.signal;assert.ok(signal);
        return new Promise<Response>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('PRIVATE-KEY aborted')),{once:true});queueMicrotask(()=>{if(timedOut)timeout.abort();else controller.abort();});});
      }});
      await assert.rejects(client.submit(inputFor(),{signal:controller.signal}),{code:'SUBMISSION_UNKNOWN',uncertain:true});assert.equal(dispatches,1);
      if(timedOut)assert.equal(timeoutMs,30000);
    }finally{mock?.mock.restore();}
  }
});

test('Wan explicit authentication rejection is sanitized and safe to report',async()=>{
  const f=fixture();f.queue.push(json({code:'InvalidApiKey',message:'PRIVATE-KEY'},401));
  await assert.rejects(f.client.submit(inputFor()),error=>{assert.equal(object(error).code,'PROVIDER_HTTP_401');assert.equal(object(error).uncertain,false);assert.doesNotMatch(String(error),/PRIVATE-KEY/);return true;});assert.equal(f.calls.length,1);
});

test('Wan UNKNOWN and mismatched observations do not mark an accepted task failed',async()=>{
  const f=fixture();
  for(const output of [{task_id:'known-123',task_status:'UNKNOWN'},{task_id:'other-123',task_status:'FAILED'}]){f.queue.push(json({output}));await assert.rejects(f.client.retrieve('known-123'),{code:'INVALID_PROVIDER_RESPONSE',retryable:true});}
  await assert.rejects(f.client.retrieve('../task'),{code:'INVALID_PROVIDER_TASK_ID'});assert.equal(f.calls.length,2);
});

test('concurrent Wan operations keep their own cancellation and dispatch contexts',async()=>{
  const one=new AbortController(),two=new AbortController();let fences=0;
  const contexts:Array<AbortSignal|undefined>=[];
  const client=createWanSdkClient({binding:bindingFor(),acquireCredential:async()=> 'PRIVATE-KEY',fetchImpl:async(_url,init)=>{contexts.push(init?.signal??undefined);return json(init?.method==='POST'?{output:{task_id:'new-123'}}:{output:{task_id:'existing-123',task_status:'RUNNING'}});}});
  await Promise.all([client.submit(inputFor(),{signal:one.signal,beforeSubmit:()=>{fences++;}}),client.retrieve('existing-123',{signal:two.signal})]);
  assert.equal(fences,1);assert.equal(contexts.length,2);assert.notEqual(contexts[0],contexts[1]);one.abort();assert.equal(contexts.filter(signal=>signal?.aborted).length,1);
});

function png(colour=2,extra?:{type:string;bytes:Buffer}):Buffer {
  const chunk=(type:string,bytes:Buffer)=>{const data=Buffer.concat([Buffer.from(type),bytes]),header=Buffer.alloc(4),crc=Buffer.alloc(4);header.writeUInt32BE(bytes.length);crc.writeUInt32BE(crc32(data));return Buffer.concat([header,data,crc]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(240);ihdr.writeUInt32BE(240,4);ihdr[8]=8;ihdr[9]=colour;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),...(extra?[chunk(extra.type,extra.bytes)]:[]),chunk('IDAT',deflateSync(Buffer.alloc(240*(240*4+1)))),chunk('IEND',Buffer.alloc(0))]);
}
function webp(alpha=false,transparentChunk=false):Buffer {
  const chunk=(type:string,bytes:Buffer)=>{const header=Buffer.alloc(8);header.write(type);header.writeUInt32LE(bytes.length,4);return Buffer.concat([header,bytes,Buffer.alloc(bytes.length&1)]);};
  const vp8x=Buffer.alloc(10);if(alpha)vp8x[0]=0x10;
  const vp8=Buffer.alloc(10);vp8[3]=0x9d;vp8[4]=1;vp8[5]=0x2a;
  const content=Buffer.concat([Buffer.from('WEBP'),chunk('VP8X',vp8x),...(transparentChunk?[chunk('ALPH',Buffer.from([0]))]:[]),chunk('VP8 ',vp8)]),header=Buffer.alloc(8);header.write('RIFF');header.writeUInt32LE(content.length,4);return Buffer.concat([header,content]);
}
test('Wan image validation uses actual PNG alpha channels and tRNS chunks',()=>{
  assert.doesNotThrow(()=>validateWanImageBytes(png(),'image/png'));
  for(const bytes of [png(4),png(6),png(2,{type:'tRNS',bytes:Buffer.alloc(6)})])assert.throws(()=>validateWanImageBytes(bytes,'image/png'),{code:'UNSUPPORTED_IMAGE_TRANSPARENCY'});
  assert.throws(()=>validateWanImageBytes(png().subarray(0,30),'image/png'),{code:'INVALID_REFERENCE_TYPE'});assert.throws(()=>validateWanImageBytes(png(),'image/jpeg'),{code:'INVALID_REFERENCE_TYPE'});
});
test('Wan image validation checks WebP transparency flags, ALPH chunks and real image chunks',()=>{
  assert.doesNotThrow(()=>validateWanImageBytes(webp(),'image/webp'));
  for(const bytes of [webp(true),webp(false,true)])assert.throws(()=>validateWanImageBytes(bytes,'image/webp'),{code:'UNSUPPORTED_IMAGE_TRANSPARENCY'});
  const lossless=Buffer.from('RIFF\x12\0\0\0WEBPVP8L\x05\0\0\0\x2f\0\0\0\x10\0','binary');assert.throws(()=>validateWanImageBytes(lossless,'image/webp'),{code:'UNSUPPORTED_IMAGE_TRANSPARENCY'});
  assert.throws(()=>validateWanImageBytes(webp().subarray(0,20),'image/webp'),{code:'INVALID_REFERENCE_TYPE'});assert.throws(()=>validateWanImageBytes(Buffer.from('not an image'),'image/webp'),{code:'INVALID_REFERENCE_TYPE'});
});

test('Wan SDK works in a desktop-style static bundle without package metadata discovery',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'mioon-wan-sdk-bundle-'));t.after(()=>rm(root,{recursive:true,force:true}));const outfile=path.join(root,'backend.cjs');
  await build({entryPoints:[fileURLToPath(new URL('../packages/business/src/video/wan-sdk.ts',import.meta.url))],outfile,bundle:true,platform:'node',format:'cjs',target:'node24',define:{'import.meta.url':'__mioon_import_meta_url'},banner:{js:'const __mioon_import_meta_url = require("node:url").pathToFileURL(__filename).href;'},logLevel:'silent'});
  const bundled=createRequire(import.meta.url)(outfile) as {createWanSdkClient:typeof createWanSdkClient};let calls=0;
  const client=bundled.createWanSdkClient({binding:bindingFor(),acquireCredential:async()=> 'PRIVATE-KEY',fetchImpl:async()=>{calls++;return json({output:{task_id:'bundle-123'}});}});
  assert.equal(await client.submit(inputFor()),'bundle-123');assert.equal(calls,1);
});
