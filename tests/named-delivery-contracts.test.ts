import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parse,schemas,isTimelineRenderRecord,isTimelineMutationResponse,isTimelineExportSnapshot,isExportPreflightResponse,TIMELINE_EXPORT_DEFAULT_SETTINGS,resolveTimelineExportDelivery} from '@mioon/contracts';
import {timelineDeliveryNameSchema,timelineDeliveryNameFields,isTimelineDeliveryNameSnapshot,timelineRenderDeliveryFields,timelineDeliveryBasename,timelineDeliveryContentDisposition,parseTimelineDeliveryContentDisposition} from '@mioon/contracts/timeline-delivery';

const clone=<T>(value: T): T=>structuredClone(value);
const input=()=>({projectId:randomUUID(),expectedRevision:1,requestId:randomUUID(),purpose:'export'});
function record(i: ReturnType<typeof input> & {exportSettings?: typeof TIMELINE_EXPORT_DEFAULT_SETTINGS; deliveryName?: unknown}){
 const trackId=randomUUID(),assetId=randomUUID(),stamp='2026-10-12T00:00:00.000Z';
 const timeline={id:randomUUID(),projectId:i.projectId,revision:1,fps:30,width:720,height:1280,durationFrames:30,tracks:[{id:trackId,kind:'video',name:'Video',orderIndex:0,hidden:false,muted:false}],clips:[{id:randomUUID(),trackId,assetId,name:'Image',startFrame:0,durationFrames:30,sourceInFrame:0,gain:1,rect:{x:0,y:0,width:720,height:1280}}],createdAt:stamp,updatedAt:stamp};
 return {id:randomUUID(),projectId:i.projectId,requestId:i.requestId,mode:'timeline',purpose:i.purpose,timelineRevision:1,snapshot:{timeline,...timelineDeliveryNameFields(i),...(i.exportSettings?{delivery:resolveTimelineExportDelivery(timeline,i.exportSettings)}:{}),assets:[{id:assetId,sha256:'a'.repeat(64),mimeType:'image/png',duration:0,width:1,height:1}]},status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};
}

test('name schema is exact, bounded, non-transforming, export-only and rejects explicit undefined',()=>{
 const legacy=input();assert.equal(JSON.stringify(parse('timeline.render',legacy)),JSON.stringify(legacy));
 for(const name of ['影片 初稿 🎬','  preserve spaces  ','x'.repeat(120),'🎬'.repeat(60),'CON','../injected.exe','a"; filename="b','e\u0301 / 标题!? 🧑‍🎨']){
  const i={...legacy,deliveryName:name};assert.deepEqual(parse('timeline.render',i),i);assert.equal(timelineDeliveryNameSchema.parse(name),name);
  assert.deepEqual(parse('timeline.export.preflight',{projectId:i.projectId,expectedRevision:1,deliveryName:name}),{projectId:i.projectId,expectedRevision:1,deliveryName:name});
 }
 for(const deliveryName of [undefined,null,12,'',' ','\t','\n','a\r\nb','a\n','a\r','A\n','A\r','A\r\n','A\u2028','A\u2029','\ud800\n','\udfff\r\n','A\ud800','A\udfff','a\0b','a\x7fb','a\x85b','a\u2028b','a\u2029b','x'.repeat(121),'🎬'.repeat(61),'\ud800','\udfff']){
  assert.throws(()=>parse('timeline.render',{...legacy,deliveryName}));assert.throws(()=>timelineDeliveryNameFields({deliveryName}));
  assert.throws(()=>parse('timeline.export.preflight',{projectId:legacy.projectId,expectedRevision:1,deliveryName}));
 }
 assert.throws(()=>parse('timeline.render',{...legacy,purpose:'preview',deliveryName:'Named'}));
 assert.throws(()=>parse('export.create',{projectId:legacy.projectId,requestId:legacy.requestId,deliveryName:'Named'}));
 assert.throws(()=>parse('timeline.export.capabilities',{projectId:legacy.projectId,expectedRevision:1,exportSettings:clone(TIMELINE_EXPORT_DEFAULT_SETTINGS),deliveryName:'Named'}));
 assert.throws(()=>parse('timeline.clip.update',{projectId:legacy.projectId,requestId:legacy.requestId,expectedRevision:1,clipId:randomUUID(),patch:{deliveryName:'Named'}}));
});

test('ACK guards bind exact own name independently from encoding; historical omissions stay absent',()=>{
 const old=input(),historic=record(old);assert.ok(isTimelineMutationResponse('timeline.render',old,historic));
 assert.equal(Object.hasOwn(historic.snapshot,'deliveryName'),false);assert.equal(Object.hasOwn(historic.snapshot,'delivery'),false);
 for(const settings of [undefined,clone(TIMELINE_EXPORT_DEFAULT_SETTINGS)]){
  const i={...old,deliveryName:'  原片 🎬  ',...(settings?{exportSettings:settings}:{})},r=record(i),before=JSON.stringify(r);
  assert.ok(isTimelineMutationResponse('timeline.render',i,r));assert.ok(isTimelineRenderRecord(r,i));assert.equal(JSON.stringify(r),before);
  assert.deepEqual(timelineRenderDeliveryFields(r.snapshot),{deliveryName:i.deliveryName,...(settings?{exportSettings:settings}:{})});
  for(const mutate of [(v: { snapshot: { deliveryName: unknown; }; })=>{delete v.snapshot.deliveryName;},(v: { snapshot: { deliveryName: string; }; })=>{v.snapshot.deliveryName='Other';},(v: { snapshot: { deliveryName: undefined; }; })=>{v.snapshot.deliveryName=undefined;},(v: { snapshot: { deliveryName: null; }; })=>{v.snapshot.deliveryName=null;},(v: { snapshot: { deliveryName: string; }; })=>{v.snapshot.deliveryName='a\nb';}]){const bad=clone(r);(mutate as (value: unknown) => void)(bad);assert.equal(isTimelineRenderRecord(bad,i),false);}
  assert.equal(isTimelineRenderRecord(r,old),false);assert.equal(isTimelineRenderRecord(historic,i),false);assert.equal(isTimelineRenderRecord(r,{...i,deliveryName:'原片 🎬'}),false);
  assert.equal(isTimelineExportSnapshot(r.snapshot,{purpose:'preview'}),false);assert.equal(isTimelineExportSnapshot(r.snapshot,{purpose:undefined}),false);
 }
 assert.deepEqual(timelineRenderDeliveryFields(historic.snapshot),{});assert.equal(isTimelineDeliveryNameSnapshot(historic.snapshot,{input:{deliveryName:undefined}}),false);
 assert.equal(isTimelineRenderRecord(historic,{...old,deliveryName:undefined}),false);
});

test('preflight reports bind name presence and exact text',()=>{
 const i={...input(),deliveryName:'Final'},r=record(i),report={projectId:i.projectId,timelineId:r.snapshot.timeline.id,timelineRevision:1,expectedRevision:1,snapshotHash:'b'.repeat(64),checkedAt:r.createdAt,status:'ready',summary:{deliveryName:'Final',fps:30,width:720,height:1280,durationFrames:30,trackCount:1,clipCount:1,assetCount:1,visualClipCount:1,audibleClipCount:0,mutedTrackCount:0,hiddenVideoTrackCount:0},checks:{totalAssets:1,checkedAssets:1,bytesHashed:1,fullDecode:false},issues:[]};
 const request={projectId:i.projectId,expectedRevision:1,deliveryName:i.deliveryName};
 assert.ok(isExportPreflightResponse(report,request));assert.equal(isExportPreflightResponse(report,{projectId:i.projectId,expectedRevision:1}),false);assert.equal(isExportPreflightResponse(report,{...request,deliveryName:'final'}),false);
 const missing=clone(report);delete (missing.summary as Partial<typeof missing.summary>).deliveryName;assert.equal(isExportPreflightResponse(missing,request),false);assert.ok(isExportPreflightResponse(missing,{projectId:i.projectId,expectedRevision:1}));
});

test('safe filenames preserve display names and canonical headers reject ambiguity',()=>{
 const id='12345678-1234-4234-8234-123456789abc';
 for(const name of ['CON','nul.txt','LPT1','COM¹','../bad\\path.mp4','hello\u202eworld.exe','🧑‍🎨'.repeat(20),'汉'.repeat(120),'  title. ','a"; filename="evil','!!!','中'.repeat(53)+'.abcdefghijklmnopq','CON.'+'a'.repeat(116)]){
  const filename=timelineDeliveryBasename(name,id),header=timelineDeliveryContentDisposition(name,id);
  assert.equal(name,timelineDeliveryNameSchema.parse(name));assert.ok(filename.endsWith('-123456789abc.mp4'));assert.ok(filename.length<=160);assert.ok(Buffer.byteLength(filename)<=180);
  assert.equal(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(filename),false);
  assert.equal(parseTimelineDeliveryContentDisposition(header,id),filename);
  for(const bad of [header+'; attachment',header+'\r\nX: y',header.replace('attachment;','inline;'),header.replace('filename="','filename="evil'),header.replace("UTF-8''","utf-8''")])assert.equal(parseTimelineDeliveryContentDisposition(bad,id),null);
  assert.equal(parseTimelineDeliveryContentDisposition(header,'87654321-1234-4234-8234-cba987654321'),null);
 }
 assert.throws(()=>timelineDeliveryBasename('Title','../evil'));assert.throws(()=>timelineDeliveryBasename('Title',id+'\n'));assert.equal(parseTimelineDeliveryContentDisposition(timelineDeliveryContentDisposition('Title',id),id+'\n'),null);assert.equal(parseTimelineDeliveryContentDisposition('x'.repeat(1501),id),null);
 assert.equal(timelineDeliveryBasename('CON',id),'_CON-123456789abc.mp4');
});
