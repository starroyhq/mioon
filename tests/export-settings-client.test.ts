import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createClient} from '@mioon/client';
import {parse,resolveTimelineExportDelivery,isTimelineExportCapabilitiesResponse,isTimelineMutationResponse} from '@mioon/contracts';

const operation='timeline.export.capabilities';
const env={MIOON_TOKEN:'synthetic-export-settings-client-token'};
const settings={profileId:'mp4_h264_v1',resolution:'short_360',rateControl:{mode:'crf',quality:'standard'}};
const input={projectId:randomUUID(),expectedRevision:4,exportSettings:settings};
const now='2026-10-10T00:00:00.000Z';
const success=data=>({ok:true,status:200,json:async()=>({ok:true,data})});
const ready=()=>({...input,timelineId:randomUUID(),timelineRevision:4,delivery:resolveTimelineExportDelivery({fps:30,width:720,height:1280},settings),checkedAt:now,status:'available',issues:[]});
function renderFixture(custom=true){
 const request={projectId:input.projectId,expectedRevision:4,requestId:randomUUID(),purpose:'export',...(custom?{exportSettings:settings}:{})};
 const trackId=randomUUID(),assetId=randomUUID();
 // A protocol-only DTO, never dispatched to an actual renderer or source read.
 const timeline={id:randomUUID(),projectId:request.projectId,revision:4,fps:30,width:720,height:1280,
  tracks:[{id:trackId,kind:'video',name:'Video',orderIndex:0,hidden:false,muted:false}],
  clips:[{id:randomUUID(),trackId,assetId,name:'Protocol-only source',startFrame:0,durationFrames:3,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1}],
  durationFrames:3,createdAt:now,updatedAt:now};
 return {request,value:{id:randomUUID(),projectId:request.projectId,requestId:request.requestId,mode:'timeline',purpose:'export',timelineRevision:4,
  snapshot:{timeline,assets:[{id:assetId,sha256:'a'.repeat(64),mimeType:'image/png',duration:0,width:16,height:16}],...(custom?{delivery:resolveTimelineExportDelivery(timeline,settings)}:{})},
  status:'queued',assetId:null,url:null,error:null,createdAt:now,updatedAt:now}};
}

test('export settings client retains the existing 30-second admission deadline and honors every explicit caller override',async t=>{
 const deadlines=[];t.mock.method(AbortSignal,'timeout',ms=>{deadlines.push(ms);return new AbortController().signal;});
 for(const custom of [true,false]){
  const {request,value}=renderFixture(custom);assert.equal(isTimelineMutationResponse('timeline.render',request,value),true);
  for(const [clientOptions,options,expected] of [[{},undefined,30000],[{requestTimeoutMs:8000},undefined,8000],[{},{timeoutMs:7000},7000],[{requestTimeoutMs:8000},{timeoutMs:7000},7000]]){
   const seen=[],client=createClient({env,...clientOptions,fetchImpl:async(_url,options)=>{seen.push(JSON.parse(options.body));return success(value);}});
   assert.deepEqual(await client.rpc('timeline.render',request,options),value);assert.equal(deadlines.at(-1),expected);
   assert.deepEqual(seen,[{operation:'timeline.render',input:request}]);
   if(!custom)assert.equal(Object.hasOwn(seen[0].input,'exportSettings'),false,'legacy wire bytes get no profile defaults');
  }
 }
 for(const [clientOptions,options,expected] of [[{},undefined,30000],[{requestTimeoutMs:8000},undefined,8000],[{},{timeoutMs:7000},7000],[{requestTimeoutMs:8000},{timeoutMs:7000},7000]]){
  const report=ready(),seen=[],client=createClient({env,...clientOptions,fetchImpl:async(_url,options)=>{seen.push(JSON.parse(options.body));return success(report);}});
  assert.deepEqual(await client.rpc(operation,input,options),report);assert.equal(deadlines.at(-1),expected);
  assert.deepEqual(seen,[{operation,input}]);
 }
 // Existing preflight grace is independent of capability compute.
 const report={projectId:input.projectId,expectedRevision:4,timelineId:null,timelineRevision:null,snapshotHash:null,checkedAt:now,status:'blocked',summary:null,
  checks:{totalAssets:0,checkedAssets:0,bytesHashed:0,fullDecode:false},issues:[{code:'TIMELINE_MISSING',severity:'error',message:'No saved timeline.'}]};
 const client=createClient({env,fetchImpl:async()=>success(report)});
 assert.deepEqual(await client.rpc('timeline.export.preflight',{projectId:input.projectId,expectedRevision:4}),report);
 assert.equal(deadlines.at(-1),35000);
});

test('export capability successes must bind strict identity, profile and effective settings without retries',async()=>{
 const report=ready();assert.equal(isTimelineExportCapabilitiesResponse(report,input),true);
 const edits=[value=>{value.projectId=randomUUID();},value=>{value.expectedRevision++;},value=>{value.timelineRevision++;},
  value=>{value.exportSettings.rateControl.quality='high';},value=>{value.delivery.effective.rateControl.crf=18;},
  value=>{value.delivery.effective.videoCodec='h264_nvenc';},value=>{value.delivery.effective.width=1920;},
  value=>{value.path='/untrusted/private/source';},value=>{value.exportSettings.command='ffmpeg';},
  value=>{value.delivery.effective.extraArgs=['-i','https://untrusted.invalid'];},value=>{value.checkedAt='yesterday';},
  value=>{value.status='unavailable';},value=>{value.issues=[{code:'EXPORT_CAPABILITY_AVAILABLE',message:'Unexpected availability issue'}];}];
 for(const data of [null,{},[],...edits.map(edit=>{const copy=structuredClone(report);edit(copy);return copy;})]){
  let calls=0;const client=createClient({env,fetchImpl:async()=>{calls++;return success(data);}});
  await assert.rejects(client.rpc(operation,input),error=>{assert.equal(error.code,'BACKEND_PROTOCOL_ERROR');assert.deepEqual(error.details,{});return true;});
  assert.equal(calls,1,'malformed observational result never automatically retries');
 }
 for(const [status,code] of [['unavailable','EXPORT_CAPABILITY_UNSUPPORTED'],['incomplete','EXPORT_CAPABILITY_TIMEOUT'],['incomplete','EXPORT_CAPABILITY_BUSY']]){
  const data={...report,status,issues:[{code,message:'Synthetic bounded outcome.'}]};
  assert.deepEqual(await createClient({env,fetchImpl:async()=>success(data)}).rpc(operation,input),data);
 }
});

test('invalid export settings fail before transport and omitted legacy render input remains byte-identical',async()=>{
 let calls=0;const client=createClient({env,fetchImpl:async()=>{calls++;throw Error('No dispatch permitted');}});
 const {request}=renderFixture(false);assert.equal(JSON.stringify(parse('timeline.render',request)),JSON.stringify(request));
 for(const exportSettings of [null,{}, {...settings,profileId:'webm_vp9'}, {...settings,fps:60}, {...settings,resolution:'4k'},
  {...settings,rateControl:{mode:'crf',quality:'standard',targetKbps:4000}}, {...settings,rateControl:{mode:'bitrate',targetKbps:4001}},
  {...settings,rateControl:{mode:'crf',quality:'ultra'}}, {...settings,command:'ffmpeg'}, {...settings,outputPath:'/tmp/output.mp4'}]){
  for(const [op,base] of [[operation,input],['timeline.render',request]])await assert.rejects(client.rpc(op,{...base,exportSettings}),{code:'VALIDATION_ERROR'});
 }
 await assert.rejects(client.rpc('timeline.render',{...request,purpose:'preview',exportSettings:settings}),{code:'VALIDATION_ERROR'});
 assert.equal(calls,0);
});

test('lost responses, explicit short deadlines and malformed render delivery never trigger automatic retry or erase mutation uncertainty',async()=>{
 const {request,value}=renderFixture();
 for(const [op,body] of [[operation,input],['timeline.render',request]]){
  let calls=0;
  await assert.rejects(createClient({env,fetchImpl:async()=>{calls++;throw Error('Synthetic transport loss');}}).rpc(op,body),error=>
   error.code==='BACKEND_UNAVAILABLE'&&(op==='timeline.render'?error.details.submissionMayHaveSucceeded===true:!Object.hasOwn(error.details,'submissionMayHaveSucceeded')));
  assert.equal(calls,1);
  calls=0;const client=createClient({env,requestTimeoutMs:1,fetchImpl:async(_url,{signal})=>{calls++;await new Promise((resolve,reject)=>{
   const timer=setTimeout(resolve,200);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
   if(signal.aborted){clearTimeout(timer);reject(signal.reason);}
  });throw Error('Expected explicit deadline');}});
  await assert.rejects(client.rpc(op,body),error=>error.code==='TIMEOUT'&&(op==='timeline.render'?error.details.submissionMayHaveSucceeded===true:!Object.hasOwn(error.details,'submissionMayHaveSucceeded')));
  assert.equal(calls,1);
 }
 for(const mutate of [candidate=>{delete candidate.snapshot.delivery;},candidate=>{candidate.snapshot.delivery.effective.rateControl.crf=28;},candidate=>{candidate.snapshot.delivery.exportSettings.resolution='native';}]){
  const invalid=structuredClone(value);mutate(invalid);let calls=0;
  await assert.rejects(createClient({env,fetchImpl:async()=>{calls++;return success(invalid);}}).rpc('timeline.render',request),error=>
   error.code==='BACKEND_PROTOCOL_ERROR'&&error.details.requestId===request.requestId&&error.details.submissionMayHaveSucceeded===true);
  assert.equal(calls,1);
 }
});
