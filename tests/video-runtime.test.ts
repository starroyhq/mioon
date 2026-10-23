import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import {createConfiguredVideoProvider} from '../packages/business/src/video/runtime.ts';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {defaultVideoModels,resolveVideoEndpoint,VIDEO_REGIONS} from '../packages/contracts/src/video-providers.ts';
import type {VideoExecutionBinding,VideoProviderId,VideoTemplateId} from '../packages/contracts/src/video-providers.ts';

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const mp4=Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109]);
const view=(value:unknown)=>value as Record<string,unknown>;
const list=(value:unknown)=>value as Array<Record<string,unknown>>;
const RATIO='9:16';
function png(width=360,height=640):Buffer {
  const chunk=(type:string,data:Buffer)=>{const body=Buffer.concat([Buffer.from(type),data]),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(body));return Buffer.concat([size,body,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}
function bindingFor(providerId:VideoProviderId,templateId?:VideoTemplateId):VideoExecutionBinding {
  const model=defaultVideoModels(providerId).find(model=>!templateId||model.templateId===templateId)!;
  const region=VIDEO_REGIONS[providerId][0]!;
  return {version:1,connectionId:randomUUID(),configurationRevision:1,providerId,region,workspaceId:'',endpoint:resolveVideoEndpoint(providerId,region),credentialRef:randomUUID(),model,outputHosts:['result.example']};
}
function taskId(binding:VideoExecutionBinding):string{return binding.providerId==='runway'?'123e4567-e89b-42d3-a456-426614174000':binding.providerId==='veo'?`models/${binding.model.modelId}/operations/task-123`:'task-123';}
function receipt(binding:VideoExecutionBinding):unknown {
  const id=taskId(binding);switch(binding.providerId){case 'runway':case 'ark':return {id};case 'veo':return {name:id};case 'minimax':case 'vidu':return {task_id:id};case 'kling':return {code:0,data:{id,status:'submitted'}};case 'wan':return {output:{task_id:id,task_status:'PENDING'}};}
}
function completed(binding:VideoExecutionBinding,url='https://result.example/output.mp4?signature=PRIVATE-URL'):unknown {
  const id=taskId(binding);switch(binding.providerId){
    case 'runway':return {id,status:'SUCCEEDED',output:[url]};
    case 'ark':return {id,status:'succeeded',content:{video_url:url}};
    case 'veo':return {name:id,done:true,response:{generateVideoResponse:{generatedSamples:[{video:{uri:url}}]}}};
    case 'minimax':return {task:{id,status:'succeeded',content:{url}}};
    case 'vidu':return {id,state:'success',creations:[{url}]};
    case 'kling':return {code:0,data:[{id,status:'succeeded',outputs:[{type:'video',url}]}]};
    case 'wan':return {output:{task_id:id,task_status:'SUCCEEDED',video_url:url}};
  }
}
async function fixture(t:import('node:test').TestContext,providerId:VideoProviderId,templateId?:VideoTemplateId) {
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-video-runtime-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const binding=bindingFor(providerId,templateId),bytes=png(),file=path.join(root,'frame.png');await writeFile(file,bytes);
  const asset={id:randomUUID(),path:file,mimeType:'image/png',sizeBytes:bytes.length,width:360,height:640,sha256:createHash('sha256').update(bytes).digest('hex'),role:'first_frame'};
  const calls:Array<{url:string;init:RequestInit}> = [],queue:Array<Response|Error>=[];let key='PRIVATE-KEY',acquisitions=0,time=Date.UTC(2026,9,20);
  const provider=createConfiguredVideoProvider({root,binding,now:()=>time,acquireCredential:async()=>{acquisitions++;return key;},fetchImpl:async(input,init)=>{calls.push({url:String(input),init:init??{}});const response=queue.shift();if(response instanceof Error)throw response;if(!response)throw Error('Real HTTP forbidden');return response;}});
  const duration=binding.model.durationResolutionMap[0]!.duration[0]!,resolution=binding.model.durationResolutionMap[0]!.resolution[0]!;
  const snapshot={providerId,model:binding.model.modelId,prompt:'Synthetic shapes move slowly.',aspectRatio:RATIO,duration,parameters:{resolution} as Record<string,unknown>,referenceAssets:binding.model.inputModes.includes('text')?[]:[asset]};
  return {root,binding,provider,asset,bytes,snapshot,calls,queue,key:(value:string)=>{key=value;},acquisitions:()=>acquisitions,advance:()=>{time+=20000;}};
}

const entries:Array<[VideoProviderId,VideoTemplateId?]>=[['runway'],['ark'],['veo'],['minimax'],['vidu'],['kling'],['wan','wan27-t2v'],['wan','wan27-i2v']];
for(const [family,templateId]of entries){
  test(`${family}/${templateId??'default'} construction and validation do not acquire credentials or make HTTP requests`,async t=>{
    const f=await fixture(t,family,templateId);assert.equal(f.provider.validate!(f.snapshot),true);assert.equal(f.acquisitions(),0);assert.equal(f.calls.length,0);assert.equal(f.provider.capabilities.liveVerified,false);assert.doesNotMatch(JSON.stringify(f.provider.capabilities),/PRIVATE-KEY/);
    if(family!=='kling')assert.equal(await f.provider.reconcile('unknown',{}),null);assert.equal(f.calls.length,0);
  });

  test(`${family}/${templateId??'default'} uses the official submit, task and unauthenticated download protocol`,async t=>{
    const f=await fixture(t,family,templateId);f.queue.push(json(receipt(f.binding)),json(completed(f.binding)),new Response(mp4));
    let fences=0;const requestId='stable-request-123';assert.deepEqual(await f.provider.submit(f.snapshot,{requestId,beforeSubmit:()=>{fences++;}}),{providerJobId:taskId(f.binding)});assert.equal(fences,1);
    const submit=f.calls[0]!,body=view(JSON.parse(String(submit.init.body))),headers=view(submit.init.headers);
    assert.equal(submit.init.method,'POST');assert.equal(submit.init.redirect,'error');assert.equal(headers['Idempotency-Key'],undefined);
    if(family==='veo')assert.equal(headers['x-goog-api-key'],'PRIVATE-KEY');else assert.equal(headers.Authorization,`${family==='vidu'?'Token':'Bearer'} PRIVATE-KEY`);
    switch(family){
      case 'runway':assert.equal(submit.url,'https://api.dev.runwayml.com/v1/image_to_video');assert.equal(body.model,f.snapshot.model);assert.equal(body.ratio,'720:1280');assert.equal(headers['X-Runway-Version'],'2024-11-06');assert.equal(body.promptImage,`data:image/png;base64,${f.bytes.toString('base64')}`);break;
      case 'ark':assert.equal(submit.url,'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');assert.equal(body.model,f.snapshot.model);assert.equal(body.generate_audio,false);assert.equal(body.output_format,'mp4');break;
      case 'veo':assert.equal(submit.url,`https://generativelanguage.googleapis.com/v1beta/models/${f.snapshot.model}:predictLongRunning`);assert.deepEqual(body.instances,[{prompt:f.snapshot.prompt}]);assert.equal(view(body.parameters).sampleCount,1);break;
      case 'minimax':assert.equal(submit.url,'https://api.minimax.io/v2/video_generation');assert.equal(body.resolution,'2K');assert.equal(body.model,f.snapshot.model);break;
      case 'vidu':assert.equal(submit.url,'https://api.vidu.com/ent/v2/text2video');assert.equal(body.audio,false);assert.equal(body.off_peak,false);break;
      case 'kling':assert.equal(submit.url,'https://api-singapore.klingai.com/text-to-video/kling-3.0');assert.equal(view(body.options).external_task_id,requestId);assert.equal(view(body.settings).audio,'off');assert.equal(view(body.settings).multi_shot,false);assert.equal(body.model_name,undefined);break;
      case 'wan':assert.equal(submit.url,'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis');assert.equal(headers['X-DashScope-Async'],'enable');assert.equal(body.model,f.snapshot.model);assert.equal(view(body.parameters).prompt_extend,false);assert.equal(view(body.parameters).watermark,false);if(templateId==='wan27-i2v')assert.deepEqual(view(body.input).media,[{type:'first_frame',url:`data:image/png;base64,${f.bytes.toString('base64')}`}]);else assert.equal(view(body.parameters).ratio,RATIO);assert.equal(view(body.parameters).audio,undefined);break;
    }
    assert.equal((await f.provider.poll(taskId(f.binding),{})).status,'succeeded');
    const expectedTaskPaths:Record<VideoProviderId,string>={runway:`/v1/tasks/${taskId(f.binding)}`,ark:`/contents/generations/tasks/${taskId(f.binding)}`,veo:`/${taskId(f.binding)}`,minimax:`/v2/query/video_generation/${taskId(f.binding)}`,vidu:`/ent/v2/tasks/${taskId(f.binding)}/creations`,kling:`/tasks?task_ids=${taskId(f.binding)}`,wan:`/tasks/${taskId(f.binding)}`,compatible:`/videos/${taskId(f.binding)}`};
    assert.equal(f.calls[1]!.url,f.binding.endpoint+expectedTaskPaths[family]);assert.equal(f.calls[1]!.init.method,'GET');
    const destination=path.join(f.root,'result.mp4');await f.provider.download(taskId(f.binding),destination,{});assert.deepEqual(await readFile(destination),mp4);assert.equal(f.calls.length,3);
    const download=f.calls[2]!;assert.equal(new URL(download.url).hostname,'result.example');assert.equal(download.init.headers,undefined);
    f.key('');await assert.rejects(f.provider.poll(taskId(f.binding),{}),{code:'VIDEO_CREDENTIAL_UNAVAILABLE'});await assert.rejects(f.provider.download(taskId(f.binding),destination,{}),{code:'VIDEO_CREDENTIAL_UNAVAILABLE'});assert.equal(f.calls.length,3);
  });
}

for(const family of ['ark','veo','minimax','vidu','kling']as const)test(`${family} first-frame requests use only the captured managed bytes`,async t=>{
  const f=await fixture(t,family);f.snapshot.referenceAssets=[f.asset];f.queue.push(json(receipt(f.binding)));await f.provider.submit(f.snapshot,{requestId:'image-request-123'});assert.equal(f.calls.length,1);
  const body=view(JSON.parse(String(f.calls[0]!.init.body)));
  if(family==='ark'||family==='minimax')assert.equal(view(list(body.content)[1]!.image_url).url,`data:image/png;base64,${f.bytes.toString('base64')}`);
  if(family==='veo')assert.deepEqual(view(list(body.instances)[0]!.image),{bytesBase64Encoded:f.bytes.toString('base64'),mimeType:'image/png'});
  if(family==='vidu'){assert.deepEqual(body.images,[`data:image/png;base64,${f.bytes.toString('base64')}`]);assert.equal(body.aspect_ratio,undefined);assert.match(f.calls[0]!.url,/\/img2video$/);}
  if(family==='kling'){assert.deepEqual(body.contents,[{type:'prompt',text:f.snapshot.prompt},{type:'first_frame',url:f.bytes.toString('base64')}]);assert.equal(view(body.settings).aspect_ratio,undefined);assert.match(f.calls[0]!.url,/\/image-to-video\/kling-3\.0$/);}
});

test('Kling reconciliation queries its stable external ID and never creates a task',async t=>{
  const f=await fixture(t,'kling');const externalId='stable/request 123';
  f.queue.push(json({code:0,data:[]}));assert.equal(await f.provider.reconcile(externalId,{}),null);
  f.queue.push(json({code:0,data:[{id:'known-123',external_id:externalId,status:'processing'}]}));assert.deepEqual(await f.provider.reconcile(externalId,{}),{providerJobId:'known-123'});
  assert.deepEqual(f.calls.map(call=>call.url),Array(2).fill('https://api-singapore.klingai.com/tasks?external_task_ids=stable%2Frequest%20123'));assert.ok(f.calls.every(call=>call.init.method==='GET'));
  f.queue.push(json({code:0,data:[{id:'known-123',external_id:externalId,status:'processing'},{id:'other-123',external_id:externalId,status:'processing'}]}));await assert.rejects(f.provider.reconcile(externalId,{}),{code:'INVALID_PROVIDER_RESPONSE'});
});

test('Kling audio follows the frozen model policy and explicit optional switch',async t=>{
  const f=await fixture(t,'kling');f.binding.model.audio='optional';const provider=createConfiguredVideoProvider({root:f.root,binding:f.binding,acquireCredential:async()=> 'PRIVATE-KEY',fetchImpl:async(_url,init)=>{assert.equal(view(view(JSON.parse(String(init?.body))).settings).audio,'native');return json(receipt(f.binding));}});
  await provider.submit({...f.snapshot,parameters:{...f.snapshot.parameters,generateAudio:true}},{requestId:'audio-request-123'});
});

test('reference tampering, mismatched actual metadata and final dispatch fences prevent POST',async t=>{
  const f=await fixture(t,'ark');f.snapshot.referenceAssets=[f.asset];await writeFile(f.asset.path,'changed bytes');await assert.rejects(f.provider.submit(f.snapshot,{}),{code:'INVALID_REFERENCE_TYPE'});assert.equal(f.calls.length,0);
  await writeFile(f.asset.path,f.bytes);f.asset.sizeBytes++;await assert.rejects(f.provider.submit(f.snapshot,{}),{code:'REFERENCE_CHANGED'});f.asset.sizeBytes--;
  await assert.rejects(f.provider.submit(f.snapshot,{beforeSubmit:()=>{throw Object.assign(Error('Claim changed'),{code:'GENERATION_STATE_CHANGED'});}}),{code:'GENERATION_STATE_CHANGED'});assert.equal(f.calls.length,0);
});

for(const response of [new Error('PRIVATE network detail'),json({},503),new Response('unreadable'),json({})])test('ambiguous creation responses remain unknown without a hidden POST retry',async t=>{
  const f=await fixture(t,'ark');f.queue.push(response);await assert.rejects(f.provider.submit(f.snapshot,{}),(error:unknown)=>{assert.equal(view(error).uncertain,true);assert.doesNotMatch(String(view(error).message),/PRIVATE/);return true;});assert.equal(f.calls.length,1);
});

test('empty output hosts, nonofficial endpoints and replaced credentials cannot authorize generation',async t=>{
  const f=await fixture(t,'kling');f.binding.outputHosts=[];const disabled=createConfiguredVideoProvider({root:f.root,binding:f.binding,acquireCredential:async()=> 'PRIVATE-KEY'});await assert.rejects(disabled.submit(f.snapshot,{requestId:'missing-hosts'}),{code:'PROVIDER_CONFIGURATION'});
  f.binding.endpoint='https://proxy.example';assert.throws(()=>createConfiguredVideoProvider({root:f.root,binding:f.binding,acquireCredential:async()=> 'PRIVATE-KEY'}));
  f.key('');await assert.rejects(f.provider.submit(f.snapshot,{requestId:'removed-key'}),{code:'VIDEO_CREDENTIAL_UNAVAILABLE'});assert.equal(f.calls.length,0);
});

test('existing Wan task UNKNOWN observations do not become a definitive retryable generation failure',async t=>{
  const f=await fixture(t,'wan','wan27-t2v');f.queue.push(json({output:{task_id:taskId(f.binding),task_status:'UNKNOWN'}}));await assert.rejects(f.provider.poll(taskId(f.binding),{}),{code:'INVALID_PROVIDER_RESPONSE'});assert.equal(f.calls.length,1);
});

test('credential rotation and caller binding mutation do not change the frozen model or endpoint',async t=>{
  const f=await fixture(t,'ark'),originalModel=f.snapshot.model;f.binding.endpoint='https://proxy.example';f.binding.model.modelId='changed-model';f.key('ROTATED-KEY');f.queue.push(json({id:'task-123'}));
  await f.provider.submit(f.snapshot,{});assert.equal(f.calls[0]!.url,'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');assert.equal(view(JSON.parse(String(f.calls[0]!.init.body))).model,originalModel);assert.equal(view(f.calls[0]!.init.headers).Authorization,'Bearer ROTATED-KEY');
});

test('a failed download refreshes the existing task URL and never posts generation again',async t=>{
  const f=await fixture(t,'ark');f.queue.push(json(completed(f.binding)),new Response('not MP4'),json(completed(f.binding,'https://result.example/fresh.mp4')),new Response(mp4));
  const destination=path.join(f.root,'result.mp4');await assert.rejects(f.provider.download(taskId(f.binding),destination,{}),{code:'INVALID_OUTPUT_MEDIA'});await f.provider.download(taskId(f.binding),destination,{});
  assert.equal(f.calls.length,4);assert.ok(f.calls.every(call=>call.init.method==='GET'));assert.equal(f.calls[3]!.url,'https://result.example/fresh.mp4');assert.deepEqual(await readFile(destination),mp4);
});

test('an unapproved output host is rejected before sending credentials or downloading bytes',async t=>{
  const f=await fixture(t,'ark');f.queue.push(json(completed(f.binding,'https://unapproved.example/private.mp4')));await assert.rejects(f.provider.download(taskId(f.binding),path.join(f.root,'result.mp4'),{}),{code:'UNAPPROVED_OUTPUT_HOST'});assert.equal(f.calls.length,1);
});

test('Veo authenticates only its fixed file route and strips the key on approved redirects',async t=>{
  const f=await fixture(t,'veo'),url='https://generativelanguage.googleapis.com/v1beta/files/file-123:download?untrusted=1';
  f.queue.push(json(completed(f.binding,url)),new Response(null,{status:302,headers:{location:'https://result.example/final.mp4'}}),new Response(null,{status:302,headers:{location:'https://generativelanguage.googleapis.com/v1beta/files/final-file:download'}}),new Response(mp4));await f.provider.download(taskId(f.binding),path.join(f.root,'result.mp4'),{});
  assert.equal(f.calls[1]!.url,'https://generativelanguage.googleapis.com/v1beta/files/file-123:download?alt=media');assert.equal(view(f.calls[1]!.init.headers)['x-goog-api-key'],'PRIVATE-KEY');assert.equal(f.calls[2]!.init.headers,undefined);
  assert.equal(f.calls[3]!.url,'https://generativelanguage.googleapis.com/v1beta/files/final-file:download');assert.equal(f.calls[3]!.init.headers,undefined,'Returning to the official origin must not restore authentication');
});

for(const stage of ['task-response','redirect-response']as const)test(`credential removal during ${stage} stops the next download request on its original binding`,async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-video-download-credential-'))),settings=await createVideoSettings({directory:path.join(root,'video-settings'),privateRoot:root});
  t.after(async()=>{await settings.close();await rm(root,{recursive:true,force:true});});
  const original=bindingFor(stage==='task-response'?'minimax':'veo'),configuration={id:original.connectionId,providerId:original.providerId,name:'Original video connection',region:original.region,workspaceId:original.workspaceId,enabled:true,archived:false,outputHosts:original.outputHosts,models:[original.model]};
  await settings.put({action:'save',expectedRevision:0,configuration,secret:{action:'replace',storage:'session',value:'ORIGINAL-SYNTHETIC-KEY'}});
  const binding=settings.select(configuration.id,1,original.model.id),calls:Array<{url:string;init:RequestInit}>=[];
  const remove=()=>settings.put({action:'save',expectedRevision:1,configuration,secret:{action:'remove'}});
  const fileUrl='https://generativelanguage.googleapis.com/v1beta/files/file-123:download';
  const provider=createConfiguredVideoProvider({root,binding,now:()=>Date.UTC(2026,9,20),acquireCredential:()=>settings.acquire(binding),fetchImpl:async(input,init)=>{
    const url=String(input);calls.push({url,init:init??{}});
    if(url.startsWith(binding.endpoint)&&(stage==='task-response'||url.includes('/operations/'))){
      if(stage==='task-response')await remove();
      return json(completed(binding,stage==='task-response'?'https://result.example/output.mp4':fileUrl));
    }
    if(url===fileUrl+'?alt=media'){
      assert.equal(new Headers(init?.headers).get('x-goog-api-key'),'ORIGINAL-SYNTHETIC-KEY');
      await remove();return new Response(null,{status:302,headers:{location:'https://result.example/redirected.mp4'}});
    }
    return new Response(mp4);
  }});
  const destination=path.join(root,'result.mp4');
  await assert.rejects(provider.download(taskId(binding),destination,{}),{code:'VIDEO_CREDENTIAL_UNAVAILABLE'});
  assert.equal(calls.length,stage==='task-response'?1:2);
  assert.equal(calls.some(call=>new URL(call.url).hostname==='result.example'),false);
  assert.ok(calls.every(call=>call.init.method==='GET'));
  const saved=(await settings.get()).connections[0]!;
  assert.equal(saved.credentialRef,binding.credentialRef);assert.equal(saved.credentials.length,1);assert.equal(saved.secret.configured,false);
  await assert.rejects(settings.acquire(binding),{code:'VIDEO_SETTINGS_NOT_CONFIGURED'});
  await assert.rejects(readFile(destination),{code:'ENOENT'});
});

test('Runway WebP dimensions, checksum and 5 MiB encoded size use actual managed bytes',async t=>{
  const f=await fixture(t,'runway'),bytes=Buffer.alloc(30);bytes.write('RIFF');bytes.writeUInt32LE(22,4);bytes.write('WEBPVP8X',8);bytes.writeUInt32LE(10,16);bytes.writeUIntLE(359,24,3);bytes.writeUIntLE(639,27,3);await writeFile(f.asset.path,bytes);
  const reference={...f.asset,mimeType:'image/webp',sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};f.queue.push(json(receipt(f.binding)));await f.provider.submit({...f.snapshot,referenceAssets:[reference]},{});assert.equal(view(JSON.parse(String(f.calls[0]!.init.body))).promptImage,`data:image/webp;base64,${bytes.toString('base64')}`);
  await assert.rejects(f.provider.submit({...f.snapshot,referenceAssets:[{...reference,width:720,height:1280}]},{}),{code:'REFERENCE_CHANGED'});assert.equal(f.calls.length,1);
  const maximumRaw=Buffer.alloc(3932160);bytes.copy(maximumRaw);maximumRaw.writeUInt32LE(maximumRaw.length-8,4);await writeFile(f.asset.path,maximumRaw);
  await assert.rejects(f.provider.submit({...f.snapshot,referenceAssets:[{...reference,sizeBytes:maximumRaw.length,sha256:createHash('sha256').update(maximumRaw).digest('hex')}]},{}),{code:'REFERENCE_TOO_LARGE'});assert.equal(f.calls.length,1);
});

for(const [family,templateId]of entries)test(`${family}/${templateId??'default'} manual model IDs remain bounded by the selected native protocol and SDK`,async t=>{
  const f=await fixture(t,family,templateId);f.binding.model.modelId='official-model-snapshot-2026';if(family==='ark')f.binding.model.inputModes=['text','image'];
  const calls:Array<{url:string;body:Record<string,unknown>}> = [];
  const provider=createConfiguredVideoProvider({root:f.root,binding:f.binding,acquireCredential:async()=> 'PRIVATE-KEY',fetchImpl:async(url,init)=>{calls.push({url:String(url),body:view(JSON.parse(String(init?.body)))});return json(receipt(f.binding));}});
  if(family==='minimax'){
    await assert.rejects(provider.submit({...f.snapshot,model:f.binding.model.modelId},{requestId:'manual-model-request'}),{code:'UNSUPPORTED_MODEL'});
    assert.equal(calls.length,0,'Unsupported official SDK models never fall back to REST');return;
  }
  await provider.submit({...f.snapshot,model:f.binding.model.modelId},{requestId:'manual-model-request'});assert.equal(calls.length,1);
  if(family==='veo')assert.equal(calls[0]!.url,`${f.binding.endpoint}/models/official-model-snapshot-2026:predictLongRunning`);
  else if(family==='kling')assert.equal(calls[0]!.url,`${f.binding.endpoint}/text-to-video/official-model-snapshot-2026`);
  else assert.equal(calls[0]!.body.model,'official-model-snapshot-2026');
});
