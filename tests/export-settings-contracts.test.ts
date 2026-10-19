import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parse,schemas,TIMELINE_OUTPUT_PRESETS,TIMELINE_EXPORT_DEFAULT_SETTINGS,resolveTimelineExportDelivery,isTimelineExportDelivery,isTimelineExportSnapshot,isTimelineRenderRecord,isTimelineMutationResponse,isTimelineExportCapabilitiesResponse,operationEffect,DURABLE_EDIT_OPERATIONS,hasRequestNotAppliedProof,timelineExportCapabilityResultSchema} from '@mioon/contracts';

const clone=value=>JSON.parse(JSON.stringify(value));
const settings=()=>clone(TIMELINE_EXPORT_DEFAULT_SETTINGS);
const input=()=>({projectId:randomUUID(),expectedRevision:1,requestId:randomUUID(),purpose:'export'});
function record(i){
 const id=randomUUID(),trackId=randomUUID(),assetId=randomUUID(),stamp='2026-10-11T00:00:00.000Z';
 const timeline={id,projectId:i.projectId,revision:i.expectedRevision,fps:30,width:720,height:1280,tracks:[{id:trackId,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],clips:[{id:randomUUID(),trackId,assetId,name:'Image',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1}],durationFrames:30,createdAt:stamp,updatedAt:stamp};
 return {id:randomUUID(),projectId:i.projectId,requestId:i.requestId,mode:'timeline',purpose:i.purpose,timelineRevision:i.expectedRevision,snapshot:{timeline,assets:[{id:assetId,sha256:'a'.repeat(64),mimeType:'image/png',duration:0,width:720,height:1280,hasAudio:false}],...(i.exportSettings?{delivery:resolveTimelineExportDelivery(timeline,i.exportSettings)}:{})},status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};
}

test('export settings syntax is fully strict, required at every nested level, export-only and non-normalizing',()=>{
 const legacy=input();assert.equal(JSON.stringify(parse('timeline.render',legacy)),JSON.stringify(legacy));
 const good={...legacy,exportSettings:settings()};assert.deepEqual(parse('timeline.render',good),good);
 for(const exportSettings of [{},{profileId:'mp4_h264_v1'}, {...settings(),resolution:'short_1440'}, {...settings(),fps:60}, {...settings(),rateControl:{mode:'crf'}}, {...settings(),rateControl:{mode:'crf',quality:'high',crf:18}}, {...settings(),rateControl:{mode:'bitrate',targetKbps:3000}}, {...settings(),rateControl:{mode:'bitrate',targetKbps:2000,quality:'high'}}, {...settings(),profileId:'h265'}, {...settings(),executable:'/tmp/ffmpeg'}])assert.throws(()=>parse('timeline.render',{...legacy,exportSettings}));
 assert.throws(()=>parse('timeline.render',{...good,purpose:'preview'}));
 assert.throws(()=>parse('export.create',{projectId:legacy.projectId,requestId:legacy.requestId,exportSettings:settings()}));
 const cap={projectId:legacy.projectId,expectedRevision:1,exportSettings:settings()};assert.deepEqual(parse('timeline.export.capabilities',cap),cap);
 for(const patch of [{requestId:legacy.requestId},{argv:[]},{token:'secret'},{expectedRevision:0},{exportSettings:undefined}])assert.throws(()=>parse('timeline.export.capabilities',{...cap,...patch}));
 assert.ok(!DURABLE_EDIT_OPERATIONS.includes('timeline.render'));assert.ok(!DURABLE_EDIT_OPERATIONS.includes('timeline.export.capabilities'));
 const effects=operationEffect('timeline.export.capabilities');assert.equal(effects.localProcess,true);assert.equal(effects.fileWrite,true,'opt-in float proof uses owned temporary files');for(const field of ['databaseWrite','externalIO','paidGeneration'])assert.equal(effects[field],false);
});

test('every fixed output size, CRF mapping and bitrate resolves without mutating composition or input',()=>{
 const rates=[{mode:'crf',quality:'compact'},{mode:'crf',quality:'standard'},{mode:'crf',quality:'high'},...([2000,4000,8000].map(targetKbps=>({mode:'bitrate',targetKbps})))];
 for(const timeline of TIMELINE_OUTPUT_PRESETS)for(const resolution of ['native','short_360','short_720','short_1080'])for(const rateControl of rates){
  const s={profileId:'mp4_h264_v1',resolution,rateControl},before=JSON.stringify([timeline,s]),delivery=resolveTimelineExportDelivery(timeline,s);
  const factor=(resolution==='native'?Math.min(timeline.width,timeline.height):resolution==='short_360'?360:resolution==='short_720'?720:1080)/Math.min(timeline.width,timeline.height);
  assert.equal(delivery.effective.width,timeline.width*factor);assert.equal(delivery.effective.height,timeline.height*factor);assert.equal(delivery.effective.fps,30);
  assert.deepEqual(delivery.effective.rateControl,rateControl.mode==='crf'?{mode:'crf',crf:{compact:28,standard:23,high:18}[rateControl.quality]}:rateControl);
  assert.ok(isTimelineExportDelivery(delivery,timeline,s));assert.equal(JSON.stringify([timeline,s]),before);assert.notEqual(delivery.exportSettings,s);
  for(const field of ['width','fps','gopFrames','audioChannels']){const bad=clone(delivery);bad.effective[field]++;assert.equal(isTimelineExportDelivery(bad,timeline,s),false);}
 }
});

test('ACK guards bind exact settings and reject injected, removed or corrupted frozen delivery',()=>{
 const old=input(),oldRecord=record(old),fresh={...old,exportSettings:settings()},response=record(fresh);
 assert.ok(isTimelineMutationResponse('timeline.render',old,oldRecord));assert.ok(isTimelineMutationResponse('timeline.render',fresh,response));
 assert.equal(isTimelineMutationResponse('timeline.render',fresh,oldRecord),false);assert.equal(isTimelineMutationResponse('timeline.render',old,response),false);
 for(const mutate of [r=>{r.snapshot.delivery.effective.width=1080;},r=>{r.snapshot.delivery.effective.rateControl.crf=18;},r=>{r.snapshot.delivery.exportSettings.resolution='short_360';},r=>{r.snapshot.delivery.effective.argv=['-y'];},r=>{delete r.snapshot.delivery;},r=>{r.snapshot.delivery.exportSettings.extra=true;}]){const bad=clone(response);mutate(bad);assert.equal(isTimelineRenderRecord(bad,fresh),false);}
 assert.equal(isTimelineExportSnapshot(response.snapshot,{purpose:'preview'}),false);
 const changed={...fresh,exportSettings:{...settings(),rateControl:{mode:'bitrate',targetKbps:2000}}};assert.equal(isTimelineRenderRecord(response,changed),false);
 assert.ok(isTimelineExportSnapshot(oldRecord.snapshot,{purpose:'preview',exportSettings:undefined}));
});

test('capability reports and new not-applied proofs are exact project, request and settings-bound',()=>{
 const i={...input(),exportSettings:settings()},r=record(i),report={projectId:i.projectId,timelineId:r.snapshot.timeline.id,timelineRevision:1,expectedRevision:1,exportSettings:i.exportSettings,delivery:r.snapshot.delivery,checkedAt:r.createdAt,status:'available',issues:[]};
 assert.ok(isTimelineExportCapabilitiesResponse(report,i));assert.equal(isTimelineExportCapabilitiesResponse(report,{...i,projectId:randomUUID()}),false);
 assert.equal(isTimelineExportCapabilitiesResponse(report,{...i,exportSettings:{...settings(),resolution:'short_360'}}),false);
 for(const patch of [{status:'available',issues:[{code:'EXPORT_CAPABILITY_FAILED',message:'Failed'}]},{timelineRevision:2},{delivery:null},{path:'/secret'}])assert.equal(isTimelineExportCapabilitiesResponse({...report,...patch},i),false);
 assert.equal(timelineExportCapabilityResultSchema.safeParse({status:'available',code:'EXPORT_CAPABILITY_FAILED'}).success,false);
 const error={code:'EXPORT_CAPABILITY_UNSUPPORTED',status:409,details:{mutationOutcome:'not_applied',operation:'timeline.render',projectId:i.projectId,requestId:i.requestId}};
 assert.ok(hasRequestNotAppliedProof(error,i,{operation:'timeline.render'}));
 for(const patch of [{operation:undefined},{projectId:randomUUID()},{requestId:randomUUID()}])assert.equal(hasRequestNotAppliedProof({...error,details:{...error.details,...patch}},i,{operation:'timeline.render'}),false);
 assert.equal(hasRequestNotAppliedProof(error,i),false);assert.equal(hasRequestNotAppliedProof(error,{...i,purpose:'preview'},{operation:'timeline.render'}),false);assert.equal(hasRequestNotAppliedProof(error,{...i,exportSettings:undefined},{operation:'timeline.render'}),false);
 assert.equal(hasRequestNotAppliedProof({...error,code:'EXPORT_CAPABILITY_TERMINATION_UNCONFIRMED'},i,{operation:'timeline.render'}),false);
 assert.ok(schemas['timeline.export.preflight'].safeParse({projectId:i.projectId,expectedRevision:1,exportSettings:i.exportSettings}).success);
});
