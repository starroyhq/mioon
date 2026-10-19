import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createClient} from '@mioon/client';
import {parse,resolveTimelineExportDelivery,isTimelineExportCapabilitiesResponse,isTimelineMutationResponse} from '@mioon/contracts';

type RequestInitLike = {body?: string | null; signal?: AbortSignal} & Record<string, unknown>;
interface JsonResponse {ok: boolean; status: number; json: () => Promise<{ok: boolean; data: unknown}>}
const fetchMock = (handler: (url: string, options?: RequestInitLike) => Promise<JsonResponse>): typeof globalThis.fetch => handler as unknown as typeof globalThis.fetch;
const jsonBody = (options?: RequestInitLike): Record<string, unknown> => JSON.parse(String(options?.body)) as Record<string, unknown>;
interface CapabilityReportData {projectId: string; expectedRevision: number; timelineRevision: number; exportSettings: {rateControl: {quality: string}; command?: string}; delivery: {effective: {rateControl: {crf: number}; videoCodec: string; width: number; extraArgs: string[]}}; path?: string; checkedAt: string; status: string; issues: Array<{code: string; message: string}>}
interface RenderValue {snapshot: {delivery?: {effective: {rateControl: {crf: number}}; exportSettings: {resolution: string}}}}
const operation='timeline.export.capabilities';
const env={MIOON_TOKEN:'synthetic-export-settings-client-token'};
const settings={profileId:'mp4_h264_v1',resolution:'short_360',rateControl:{mode:'crf',quality:'standard'}};
const input={projectId:randomUUID(),expectedRevision:4,exportSettings:settings};
const now='2026-10-10T00:00:00.000Z';
const success=(data: unknown): JsonResponse => ({ok:true,status:200,json:async()=>({ok:true,data})});
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
 const deadlines: number[]=[];t.mock.method(AbortSignal,'timeout',(ms: number): AbortSignal=>{deadlines.push(ms);return new AbortController().signal;});
  const overrideCases: Array<[{requestTimeoutMs?: number}, {timeoutMs?: number}|undefined, number]> = [[{},undefined,30000],[{requestTimeoutMs:8000},undefined,8000],[{},{timeoutMs:7000},7000],[{requestTimeoutMs:8000},{timeoutMs:7000},7000]];
 for(const custom of [true,false]){
  const {request,value}=renderFixture(custom);assert.equal(isTimelineMutationResponse('timeline.render',request,value),true);
  for(const [clientOptions,options,expected] of overrideCases){
   const seen: Record<string, unknown>[]=[],client=createClient({env,...clientOptions,fetchImpl:fetchMock(async(_url,requestOptions)=>{seen.push(jsonBody(requestOptions));return success(value);})});
   assert.deepEqual(await client.rpc('timeline.render',request,options),value);assert.equal(deadlines.at(-1),expected);
   assert.deepEqual(seen,[{operation:'timeline.render',input:request}]);
   if(!custom)assert.equal(Object.hasOwn((seen[0] as {input: Record<string, unknown>}).input,'exportSettings'),false,'legacy wire bytes get no profile defaults');
  }
 }
 for(const [clientOptions,options,expected] of overrideCases){
  const report=ready(),seen: Record<string, unknown>[]=[],client=createClient({env,...clientOptions,fetchImpl:fetchMock(async(_url,requestOptions)=>{seen.push(jsonBody(requestOptions));return success(report);})});
  assert.deepEqual(await client.rpc(operation,input,options),report);assert.equal(deadlines.at(-1),expected);
  assert.deepEqual(seen,[{operation,input}]);
 }
 // Existing preflight grace is independent of capability compute.
 const report={projectId:input.projectId,expectedRevision:4,timelineId:null,timelineRevision:null,snapshotHash:null,checkedAt:now,status:'blocked',summary:null,
  checks:{totalAssets:0,checkedAssets:0,bytesHashed:0,fullDecode:false},issues:[{code:'TIMELINE_MISSING',severity:'error',message:'No saved timeline.'}]};
 const client=createClient({env,fetchImpl:fetchMock(async()=>success(report))});
 assert.deepEqual(await client.rpc('timeline.export.preflight',{projectId:input.projectId,expectedRevision:4}),report);
 assert.equal(deadlines.at(-1),35000);
});

test('export capability successes must bind strict identity, profile and effective settings without retries',async()=>{
 const report=ready();assert.equal(isTimelineExportCapabilitiesResponse(report,input),true);
 const edits: Array<(value: CapabilityReportData)=>void>=[value=>{value.projectId=randomUUID();},value=>{value.expectedRevision++;},value=>{value.timelineRevision++;},
  value=>{value.exportSettings.rateControl.quality='high';},value=>{value.delivery.effective.rateControl.crf=18;},
  value=>{value.delivery.effective.videoCodec='h264_nvenc';},value=>{value.delivery.effective.width=1920;},
  value=>{value.path='/untrusted/private/source';},value=>{value.exportSettings.command='ffmpeg';},
  value=>{value.delivery.effective.extraArgs=['-i','https://untrusted.invalid'];},value=>{value.checkedAt='yesterday';},
  value=>{value.status='unavailable';},value=>{value.issues=[{code:'EXPORT_CAPABILITY_AVAILABLE',message:'Unexpected availability issue'}];}];
 for(const data of [null,{},[],...edits.map(edit=>{const copy=structuredClone(report) as unknown as CapabilityReportData;edit(copy);return copy;})] as unknown[]){
  let calls=0;const client=createClient({env,fetchImpl:fetchMock(async()=>{calls++;return success(data);})});
  await assert.rejects(client.rpc(operation,input),(error: unknown)=>{const failure=error as {code?: string; details?: unknown};assert.equal(failure.code,'BACKEND_PROTOCOL_ERROR');assert.deepEqual(failure.details,{});return true;});
  assert.equal(calls,1,'malformed observational result never automatically retries');
 }
 for(const [status,code] of [['unavailable','EXPORT_CAPABILITY_UNSUPPORTED'],['incomplete','EXPORT_CAPABILITY_TIMEOUT'],['incomplete','EXPORT_CAPABILITY_BUSY']]){
  const data={...report,status,issues:[{code,message:'Synthetic bounded outcome.'}]};
  assert.deepEqual(await createClient({env,fetchImpl:fetchMock(async()=>success(data))}).rpc(operation,input),data);
 }
});

test('invalid export settings fail before transport and omitted legacy render input remains byte-identical',async()=>{
 let calls=0;const client=createClient({env,fetchImpl:fetchMock(async()=>{calls++;throw Error('No dispatch permitted');})});
 const {request}=renderFixture(false);assert.equal(JSON.stringify(parse('timeline.render',request)),JSON.stringify(request));
 for(const exportSettings of [null,{}, {...settings,profileId:'webm_vp9'}, {...settings,fps:60}, {...settings,resolution:'4k'},
  {...settings,rateControl:{mode:'crf',quality:'standard',targetKbps:4000}}, {...settings,rateControl:{mode:'bitrate',targetKbps:4001}},
  {...settings,rateControl:{mode:'crf',quality:'ultra'}}, {...settings,command:'ffmpeg'}, {...settings,outputPath:'/tmp/output.mp4'}]){
  for(const [op,base] of [[operation,input],['timeline.render',request]] as Array<[string, Record<string, unknown>]>)await assert.rejects(client.rpc(op,{...base,exportSettings}),{code:'VALIDATION_ERROR'});
 }
 await assert.rejects(client.rpc('timeline.render',{...request,purpose:'preview',exportSettings:settings}),{code:'VALIDATION_ERROR'});
 assert.equal(calls,0);
});

test('lost responses, explicit short deadlines and malformed render delivery never trigger automatic retry or erase mutation uncertainty',async()=>{
 const {request,value}=renderFixture();
 for(const [op,body] of [[operation,input],['timeline.render',request]] as Array<[string, Record<string, unknown>]>){
  let calls=0;
  await assert.rejects(createClient({env,fetchImpl:fetchMock(async()=>{calls++;throw Error('Synthetic transport loss');})}).rpc(op,body),(error: unknown)=>{const failure=error as {code?: string; details: Record<string, unknown>};return failure.code==='BACKEND_UNAVAILABLE'&&(op==='timeline.render'?failure.details.submissionMayHaveSucceeded===true:!Object.hasOwn(failure.details,'submissionMayHaveSucceeded'));});
  assert.equal(calls,1);
  calls=0;const client=createClient({env,requestTimeoutMs:1,fetchImpl:fetchMock(async(_url,requestOptions)=>{const signal=requestOptions?.signal as AbortSignal;calls++;await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(resolve,200);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
   if(signal.aborted){clearTimeout(timer);reject(signal.reason);}
  });throw Error('Expected explicit deadline');})});
  await assert.rejects(client.rpc(op,body),(error: unknown)=>{const failure=error as {code?: string; details: Record<string, unknown>};return failure.code==='TIMEOUT'&&(op==='timeline.render'?failure.details.submissionMayHaveSucceeded===true:!Object.hasOwn(failure.details,'submissionMayHaveSucceeded'));});
  assert.equal(calls,1);
 }
 for(const mutate of [candidate=>{delete candidate.snapshot.delivery;},candidate=>{(candidate.snapshot.delivery as {effective: {rateControl: {crf: number}}}).effective.rateControl.crf=28;},candidate=>{(candidate.snapshot.delivery as {exportSettings: {resolution: string}}).exportSettings.resolution='native';}] as Array<(candidate: RenderValue)=>void>){
  const invalid=structuredClone(value) as unknown as RenderValue;mutate(invalid);let calls=0;
  await assert.rejects(createClient({env,fetchImpl:fetchMock(async()=>{calls++;return success(invalid);})}).rpc('timeline.render',request),(error: unknown)=>{const failure=error as {code?: string; details: Record<string, unknown>};return failure.code==='BACKEND_PROTOCOL_ERROR'&&failure.details.requestId===request.requestId&&failure.details.submissionMayHaveSucceeded===true;});
  assert.equal(calls,1);
 }
});
