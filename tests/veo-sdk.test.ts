import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {createVeoSdkClient} from '../packages/business/src/video/veo-sdk.ts';
import {createVeoProvider} from '../packages/business/src/providers/veo.ts';
import {createJsonRequest} from '../packages/business/src/providers/live-common.ts';
import type {VideoAdapterInput} from '../packages/business/src/video/adapters.ts';

const API='https://generativelanguage.googleapis.com/v1beta',MODEL='veo-3.1-generate-preview',ID=`models/${MODEL}/operations/existing-123`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const object=(value:unknown)=>value as Record<string,unknown>;
const input=(parameters:Record<string,unknown>={}):VideoAdapterInput=>({prompt:'Synthetic shapes move.',aspectRatio:'9:16',duration:4,parameters:{resolution:'720p',...parameters},images:[],subjectReference:false});
const completed={name:ID,done:true,metadata:{retained:'historical'},response:{generateVideoResponse:{generatedSamples:[{video:{uri:'https://result.example/output.mp4'}}],raiMediaFilteredCount:0}}};
function fixture() {
  const calls:Array<{url:string;init:RequestInit}>=[],queue:Array<Response|Error>=[];
  const send=createJsonRequest({api:API,headers:{'x-goog-api-key':'PRIVATE-KEY'},ensureEnabled:()=>{},name:'Veo',fetchImpl:async(url,init)=>{
    calls.push({url:String(url),init:init??{}});const response=queue.shift();if(response instanceof Error)throw response;if(!response)throw Error('Real HTTP forbidden');return response;
  }});
  return {client:createVeoSdkClient({api:API,model:MODEL,send}),calls,queue};
}

test('Veo submission uses the real official SDK parameter assembly and bound project transport',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);f.queue.push(json({name:ID}));let fences=0;
  assert.deepEqual(await f.client.submit(input(),{requestId:'private-request',jobId:'private-job',beforeSubmit:()=>{fences++;}}),{name:ID});
  assert.equal(f.calls.length,1);assert.equal(fences,1);
  const call=f.calls[0]!,headers=new Headers(call.init.headers);
  assert.equal(call.url,`${API}/models/${MODEL}:predictLongRunning`);assert.equal(call.init.method,'POST');assert.equal(call.init.redirect,'error');assert.ok(call.init.signal);
  assert.equal(headers.get('x-goog-api-key'),'PRIVATE-KEY');
  assert.deepEqual(JSON.parse(String(call.init.body)),{instances:[{prompt:'Synthetic shapes move.'}],parameters:{sampleCount:1,durationSeconds:4,aspectRatio:'9:16',resolution:'720p'}});
  assert.doesNotMatch(String(call.init.body),/private-|requestId|jobId|signal|PRIVATE-KEY/);
});

test('Veo imageBytes are encoded to the wire by the SDK without public uploads',async()=>{
  const f=fixture();f.queue.push(json({name:ID}));const value=input();value.images=[{role:'first_frame',mimeType:'image/png',base64:'aW1hZ2U='}];await f.client.submit(value);
  const body=object(JSON.parse(String(f.calls[0]!.init.body)));
  assert.deepEqual(body.instances,[{prompt:value.prompt,image:{bytesBase64Encoded:'aW1hZ2U=',mimeType:'image/png'}}]);assert.equal(f.calls.length,1);
});

test('Veo existing operation queries preserve raw nested responses and never submit',async()=>{
  const f=fixture();f.queue.push(json(completed));assert.deepEqual(await f.client.retrieve(ID),completed);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.url,`${API}/${ID}`);assert.equal(f.calls[0]!.init.method,'GET');assert.equal(f.calls[0]!.init.body,undefined);
});

test('Veo query keeps running, error and content-filtered raw operation shapes for legacy parsers',async()=>{
  const f=fixture();
  for(const response of [{name:ID},{name:ID,done:false},{name:ID,done:true,error:{code:7,message:'provider rejection'}},{name:ID,done:true,response:{generateVideoResponse:{generatedSamples:[],raiMediaFilteredCount:1}}}]){
    f.queue.push(json(response));assert.deepEqual(await f.client.retrieve(ID),response);
  }
  assert.ok(f.calls.every(call=>call.init.method==='GET'));
});

test('Veo model/operation identities and unsupported media cannot select a different protocol',async()=>{
  const f=fixture();
  assert.throws(()=>createVeoSdkClient({api:'https://proxy.example/v1beta',model:MODEL,send:async()=>{throw Error('forbidden');}}),{code:'VIDEO_BINDING_INVALID'});
  assert.throws(()=>createVeoSdkClient({api:API,model:'../new-model',send:async()=>{throw Error('forbidden');}}),{code:'UNSUPPORTED_MODEL'});
  for(const id of ['../operations/a','https://evil.example/operations/a',`models/another-model/operations/a`,`${ID}?key=private`])await assert.rejects(f.client.retrieve(id),{code:'INVALID_PROVIDER_TASK_ID'});
  for(const images of [[{role:'last_frame',mimeType:'image/png',base64:'YQ=='}],Array.from({length:2},()=>({role:'first_frame',mimeType:'image/png',base64:'YQ=='}))])await assert.rejects(f.client.submit({...input(),images}),{code:'UNSUPPORTED_INPUT_ROLE'});
  await assert.rejects(f.client.submit({...input(),subjectReference:true}),{code:'UNSUPPORTED_INPUT_ROLE'});
  for(const parameters of [{signal:{}},{requestId:'private'},{extraBody:{sampleCount:10}},{seed:5}])await assert.rejects(f.client.submit(input(parameters)),{code:'UNSUPPORTED_PARAMETER'});
  assert.equal(f.calls.length,0);
});

test('Veo explicit client options ignore ambient API keys, base URLs and Vertex flags',async()=>{
  const names=['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GENAI_USE_VERTEXAI','GOOGLE_GENAI_USE_ENTERPRISE','GOOGLE_GEMINI_BASE_URL','GOOGLE_VERTEX_BASE_URL','GOOGLE_CLOUD_PROJECT','GOOGLE_CLOUD_LOCATION'] as const;
  const original=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  try{
    for(const name of names)process.env[name]=name.includes('USE_')?'true':'AMBIENT-PRIVATE-IGNORED';
    const f=fixture();f.queue.push(json({name:ID}));await f.client.submit(input());
    assert.equal(f.calls[0]!.url,`${API}/models/${MODEL}:predictLongRunning`);assert.equal(new Headers(f.calls[0]!.init.headers).get('x-goog-api-key'),'PRIVATE-KEY');assert.doesNotMatch(String(f.calls[0]!.init.body),/AMBIENT/);
  }finally{for(const name of names){if(original[name]===undefined)delete process.env[name];else process.env[name]=original[name];}}
});

for(const response of [new Error('PRIVATE-KEY network stack'),json({private:'PRIVATE-KEY'},503),json({private:'PRIVATE-KEY'},302),new Response('{PRIVATE-KEY')])test('Veo lost/inconclusive submission is sanitized and dispatches exactly once',async()=>{
  const f=fixture();f.queue.push(response);
  await assert.rejects(f.client.submit(input()),error=>{assert.equal(object(error).code,'SUBMISSION_UNKNOWN');assert.equal(object(error).uncertain,true);assert.doesNotMatch(String(error),/PRIVATE-KEY/);return true;});assert.equal(f.calls.length,1);
});

test('Veo explicit rejection stays certain without SDK retries',async()=>{
  const f=fixture();f.queue.push(json({message:'PRIVATE-KEY'},429));await assert.rejects(f.client.submit(input()),{code:'PROVIDER_HTTP_429',uncertain:false});assert.equal(f.calls.length,1);
});

test('Veo preserves before-dispatch fences and aborted callers without SDK wrapping',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();await assert.rejects(f.client.submit(input(),{signal:controller.signal}),{code:'OPERATION_CANCELLED',beforeDispatch:true});
  const fence=Object.assign(new Error('claim closed'),{code:'CLAIM_CLOSED'});await assert.rejects(f.client.submit(input(),{beforeSubmit:()=>{throw fence;}}),error=>error===fence);assert.equal(f.calls.length,0);
});

test('Veo cancellation and timeout after dispatch do not hide a duplicate submission',async t=>{
  for(const timedOut of [false,true]){
    const controller=new AbortController(),timeout=new AbortController();let calls=0,timeoutMs=0;
    const mock=timedOut?t.mock.method(AbortSignal,'timeout',(ms:number)=>{timeoutMs=ms;return timeout.signal;}):undefined;
    try{
      const send=createJsonRequest({api:API,headers:{},ensureEnabled:()=>{},name:'Veo',fetchImpl:async(_url,init)=>{calls++;return new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(Error('PRIVATE-KEY aborted')),{once:true});queueMicrotask(()=>{if(timedOut)timeout.abort();else controller.abort();});});}});
      const client=createVeoSdkClient({api:API,model:MODEL,send});await assert.rejects(client.submit(input(),{signal:controller.signal}),{code:'SUBMISSION_UNKNOWN',uncertain:true});assert.equal(calls,1);if(timedOut)assert.equal(timeoutMs,30000);
    }finally{mock?.mock.restore();}
  }
});

test('legacy Veo submit, cached poll and download use the SDK while retaining historical task IDs',async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-veo-legacy-sdk-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const calls:Array<{url:string;init:RequestInit}>=[],mp4=Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109]);
  const queue=[json({name:ID}),json(completed),new Response(mp4)];
  const provider=createVeoProvider({root,env:{MIOON_ENABLE_LIVE_PROVIDER:'1',GEMINI_API_KEY:'PRIVATE-KEY',VEO_OUTPUT_HOSTS:'result.example'},fetchImpl:async(url,init)=>{calls.push({url:String(url),init:init??{}});const response=queue.shift();if(!response)throw Error('Real HTTP forbidden');return response;}});
  assert.deepEqual(await provider.submit({model:MODEL,prompt:'Synthetic shapes.',duration:4,aspectRatio:'9:16',referenceAssets:[],parameters:{}}),{providerJobId:ID});
  const polls=await Promise.all([provider.poll(ID),provider.poll(ID)]);assert.ok(polls.every(poll=>poll.status==='succeeded'));await provider.download(ID,path.join(root,'result.mp4'));
  assert.equal(calls.length,3);assert.deepEqual(calls.map(call=>call.init.method),['POST','GET','GET']);assert.equal(calls[1]!.url,`${API}/${ID}`);assert.equal(calls[2]!.url,'https://result.example/output.mp4');
});

for(const prefix of ['_','-'])test(`legacy Veo restores ${prefix}-prefixed operation IDs by query and download only`,async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-veo-legacy-operation-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const id=`models/${MODEL}/operations/${prefix}historical-123`,calls:Array<{url:string;init:RequestInit}>=[];
  const mp4=Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109]);
  const queue=[json({...completed,name:id}),new Response(mp4)];
  const provider=createVeoProvider({root,env:{MIOON_ENABLE_LIVE_PROVIDER:'1',GEMINI_API_KEY:'PRIVATE-KEY',VEO_OUTPUT_HOSTS:'result.example'},fetchImpl:async(url,init)=>{calls.push({url:String(url),init:init??{}});const response=queue.shift();if(!response)throw Error('Real HTTP forbidden');return response;}});
  assert.deepEqual(await provider.poll(id),{status:'succeeded',progress:1});
  assert.deepEqual(await provider.download(id,path.join(root,'restored.mp4')),{mimeType:'video/mp4',sizeBytes:mp4.length,isMock:false});
  assert.deepEqual(calls.map(call=>[call.url,call.init.method]),[[`${API}/${id}`,'GET'],['https://result.example/output.mp4','GET']]);
});

test('legacy Veo SDK path retains managed local image checks and frozen bytes',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'mioon-veo-sdk-image-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bytes=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.write('IHDR',12);bytes.writeUInt32BE(360,16);bytes.writeUInt32BE(640,20);
  const file=path.join(root,'frame.png');await writeFile(file,bytes);const sha256=createHash('sha256').update(bytes).digest('hex');let calls=0;
  const provider=createVeoProvider({root,env:{MIOON_ENABLE_LIVE_PROVIDER:'1',GEMINI_API_KEY:'PRIVATE-KEY',VEO_APPROVED_ASSET_SHA256:sha256},fetchImpl:async(_url,init)=>{calls++;const body=object(JSON.parse(String(init?.body)));assert.deepEqual((body.instances as Array<Record<string,unknown>>)[0]!.image,{bytesBase64Encoded:bytes.toString('base64'),mimeType:'image/png'});return json({name:ID});}});
  const snapshot={model:MODEL,prompt:'Synthetic shapes.',duration:4,aspectRatio:'9:16',referenceAssets:[{path:file,sha256,mimeType:'image/png'}],parameters:{}};
  await provider.submit(snapshot);assert.equal(calls,1);await writeFile(file,Buffer.alloc(24));await assert.rejects(provider.submit(snapshot),{code:'INVALID_REFERENCE_TYPE'});assert.equal(calls,1);
});

test('Veo official SDK runs in the desktop-style static bundle without dependency files',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'mioon-veo-sdk-bundle-'));t.after(()=>rm(root,{recursive:true,force:true}));const outfile=path.join(root,'backend.cjs');
  await build({entryPoints:[fileURLToPath(new URL('../packages/business/src/video/veo-sdk.ts',import.meta.url))],outfile,bundle:true,platform:'node',format:'cjs',target:'node24',define:{'import.meta.url':'__mioon_import_meta_url'},banner:{js:'const __mioon_import_meta_url = require("node:url").pathToFileURL(__filename).href;'},logLevel:'silent'});
  const bundled=createRequire(import.meta.url)(outfile) as {createVeoSdkClient:typeof createVeoSdkClient};let calls=0;
  const client=bundled.createVeoSdkClient({api:API,model:MODEL,send:async(_path,options)=>{calls++;assert.equal(options.method,'POST');return {name:ID};}});
  assert.deepEqual(await client.submit(input()),{name:ID});assert.equal(calls,1);
});
