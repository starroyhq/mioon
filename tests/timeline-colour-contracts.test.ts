type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {hasTimelineDeliveryIdentity,TIMELINE_DELIVERY_RECEIPT_SQL,timelineRenderDeliveryFields} from '@mioon/contracts/timeline-delivery';
import {parse,schemas,operationEffect,isTimelineRecord,isTimelineMutationResponse,isTimelineRenderRecord,isTimelineReplacementResponse,
  clipColourSchema,timelineClipColourSchema,timelineColourPlanSchema,createTimelineColourPlan,projectTimelineColourPlan,
  isTimelineColourPlanSnapshot,isTimelineExportSnapshot,resolveTimelineExportDelivery,TIMELINE_EXPORT_DEFAULT_SETTINGS,isTimelineColourSourceInspection,timelineColourSourceInspectResponseSchema,
  TIMELINE_COLOUR_PREFLIGHT_CODES,TIMELINE_COLOUR_PREFLIGHT_MESSAGES,lutRestorePolicy,timelineColourPixelBitDepth,timelineColourSourceEvidenceStatus,hasRequestNotAppliedProof} from '@mioon/contracts';
const stamp='2026-10-14T00:00:00.000Z';
const clone=structuredClone;
function fixture(){
 const projectId=randomUUID(),trackId=randomUUID(),assetId=randomUUID(),clipId=randomUUID();
 const colour={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:'a'.repeat(64),streamIndex:1,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},
  look:{resourceId:randomUUID(),resourceSha256:'b'.repeat(64),resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:.5}};
 const timeline={id:randomUUID(),projectId,revision:2,fps:30,width:1280,height:720,tracks:[{id:trackId,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
  clips:[{id:clipId,trackId,assetId,name:'Video',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:1280,height:720},gain:1,colour}],
  durationFrames:30,createdAt:stamp,updatedAt:stamp};
 const assets=[{id:assetId,sha256:'a'.repeat(64),mimeType:'video/mp4',duration:2,width:1280,height:720,hasAudio:false}];
 const input={projectId,expectedRevision:1,requestId:randomUUID(),clipId,patch:{colour:clone(colour)}};
 return {projectId,trackId,assetId,clipId,colour,timeline,assets,input};
}

test('clip colour is strict and nullable, with no silent conversion or unknown controls',()=>{
 const f=fixture();assert.deepEqual(clipColourSchema.parse(f.colour),f.colour);assert.equal((clipColourSchema.parse(null) as unknown),null);assert.equal(timelineClipColourSchema.safeParse(null).success,false);
 assert.deepEqual(parse('timeline.clip.update',f.input),f.input);
 const legacy={...f.input,patch:{gain:.5}},bytes=JSON.stringify(legacy);assert.equal(JSON.stringify(parse('timeline.clip.update',legacy)),bytes);
 assert.deepEqual(parse('timeline.clip.update',{...f.input,patch:{colour:null}}).patch,{colour:null});
 assert.deepEqual(clipColourSchema.parse({...f.colour,source:null}),{...f.colour,source:null});
 for(const mutate of ([(c: { extra: boolean; })=>{c.extra=true;},(c: { profileId: string; })=>{c.profileId='hdr';},(c: { source: { range: string; }; })=>{c.source.range='auto';},(c: { source: { profileId: string; }; })=>{c.source.profileId='log';},(c: { source: { streamIndex: number; }; })=>{c.source.streamIndex=-1;},(c: { source: { assetSha256: string; }; })=>{c.source.assetSha256='x';},(c: { source: { declaredBy: string; }; })=>{c.source.declaredBy='probe';},(c: { source: { metadata: {}; }; })=>{c.source.metadata={};},(c: { source: { declaredAt: string; }; })=>{c.source.declaredAt='yesterday';},(c: { look: { purpose: string; }; })=>{c.look.purpose='technical-log';},(c: { look: { resourceProfile: string; }; })=>{c.look.resourceProfile='any';},(c: { look: { strength: number; }; })=>{c.look.strength=1.1;},(c: { look: { strength: number; }; })=>{c.look.strength=NaN;},(c: { look: { algorithm: string; }; })=>{c.look.algorithm='trilinear';},(c: { look: { enabled: unknown; }; })=>{delete c.look.enabled;},(c: { source: unknown; })=>{delete c.source;},(c: { look: unknown; })=>{delete c.look;}] as const)){
  const colour=clone(f.colour);mutate(((((colour) as unknown as Parameters<typeof mutate>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>));assert.equal(clipColourSchema.safeParse(colour).success,false);assert.throws(()=>parse('timeline.clip.update',{...f.input,patch:{colour}}));
 }
 for(const extra of ([{colourPlan:{}},{sourceEvidence:{}},{argv:[]}] as const))assert.throws(()=>parse('timeline.clip.update',{...f.input,patch:{...f.input.patch,...extra}}));
});

test('projection is deterministic and side-effect-free; frozen plan binds every identity and LUT parameter',()=>{
 const f=fixture(),snapshot={timeline:f.timeline,assets:f.assets},before=JSON.stringify(snapshot),plan=createTimelineColourPlan(f.timeline,f.assets);
 assert.deepEqual(plan,projectTimelineColourPlan(snapshot));assert.equal(JSON.stringify(snapshot),before);
 assert.deepEqual((plan)!.clips,[{clipId:f.clipId,assetId:f.assetId,assetSha256:'a'.repeat(64),streamIndex:1,range:'limited',look:f.colour.look}]);
 (snapshot as typeof snapshot & {colourPlan:(undefined)}).colourPlan=(plan as unknown as (typeof snapshot & {colourPlan:(undefined)})["colourPlan"]);assert.equal(isTimelineColourPlanSnapshot(snapshot),true);
 for(const mutate of ([(s: { colourPlan: { clips: { assetId: string; }[]; }; })=>{s.colourPlan.clips[0].assetId=randomUUID();},(s: { colourPlan: { clips: { clipId: string; }[]; }; })=>{s.colourPlan.clips[0].clipId=randomUUID();},(s: { colourPlan: { clips: { assetSha256: string; }[]; }; })=>{s.colourPlan.clips[0].assetSha256='c'.repeat(64);},(s: { colourPlan: { clips: { streamIndex: number; }[]; }; })=>{s.colourPlan.clips[0].streamIndex=0;},(s: { colourPlan: { clips: { range: string; }[]; }; })=>{s.colourPlan.clips[0].range='full';},(s: { colourPlan: { clips: { look: { strength: number; }; }[]; }; })=>{s.colourPlan.clips[0].look.strength=1;},(s: { colourPlan: { clips: { look: { enabled: boolean; }; }[]; }; })=>{s.colourPlan.clips[0].look.enabled=false;},(s: { colourPlan: { clips: { look: { resourceId: string; }; }[]; }; })=>{s.colourPlan.clips[0].look.resourceId=randomUUID();},(s: { colourPlan: { clips: { look: { resourceSha256: string; }; }[]; }; })=>{s.colourPlan.clips[0].look.resourceSha256='d'.repeat(64);},(s: { colourPlan: { clips: never[]; }; })=>{s.colourPlan.clips=[];},(s: { colourPlan: { working: string; }; })=>{s.colourPlan.working='linear';},(s: { colourPlan: { extra: boolean; }; })=>{s.colourPlan.extra=true;},(s: { colourPlan: unknown; })=>{delete s.colourPlan;},(s: { colourPlan: undefined; })=>{s.colourPlan=undefined;}] as const)){const bad=clone(snapshot);mutate(((((bad) as unknown as Parameters<typeof mutate>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>));assert.equal(isTimelineColourPlanSnapshot(bad),false);}
 assert.equal(timelineColourPlanSchema.safeParse({...plan,clips:[(plan)!.clips[0],(plan)!.clips[0]]}).success,false);
});

test('legacy omission/null never acquire a plan or defaults, while unsupported opt-in fails closed',()=>{
 const geometry={fps:30,width:1280,height:720};assert.equal(isTimelineExportSnapshot({timeline:geometry,delivery:resolveTimelineExportDelivery(geometry,TIMELINE_EXPORT_DEFAULT_SETTINGS)}),true);
 assert.equal(isTimelineExportSnapshot({}),true);
 for(const mode of (['absent','null'] as const)){
  const f=fixture();if(mode==='absent')delete (f.timeline.clips[0] as {colour?: unknown}).colour;else f.timeline.clips[0].colour=(null as unknown as ((((typeof f)["timeline"])["clips"])[number])["colour"]);
  const snapshot={timeline:f.timeline,assets:f.assets},bytes=JSON.stringify(snapshot);
  assert.equal(projectTimelineColourPlan(snapshot),undefined);assert.equal(isTimelineColourPlanSnapshot(snapshot),true);assert.equal(JSON.stringify(snapshot),bytes);
  assert.equal(isTimelineColourPlanSnapshot({...snapshot,colourPlan:null}),false);assert.equal(isTimelineColourPlanSnapshot({...snapshot,colourPlan:undefined}),false);
 }
 for(const mutate of ([(f: Awaited<ReturnType<typeof fixture>>)=>{f.colour.source=(null as unknown as ((typeof f)["colour"])["source"]);},(f: Awaited<ReturnType<typeof fixture>>)=>{f.assets[0].sha256='c'.repeat(64);},(f: Awaited<ReturnType<typeof fixture>>)=>{f.assets[0].mimeType='image/png';},(f: Awaited<ReturnType<typeof fixture>>)=>{f.timeline.tracks[0].kind='audio';},(f: Awaited<ReturnType<typeof fixture>>)=>{f.timeline.clips[0].colour=(undefined as unknown as ((((typeof f)["timeline"])["clips"])[number])["colour"]);},(f: Awaited<ReturnType<typeof fixture>>)=>{f.timeline.clips.push({...f.timeline.clips[0],id:randomUUID(),colour:((null) as unknown as { profileId: string; source: { assetSha256: string; streamIndex: number; profileId: string; range: string; declaredBy: string; declaredAt: string; }; look: { resourceId: `${string}-${string}-${string}-${string}-${string}`; resourceSha256: string; resourceProfile: string; purpose: string; declaredBy: string; enabled: boolean; strength: number; }; }),startFrame:30});}] as const)){
  const f=fixture();mutate(f);assert.throws(()=>createTimelineColourPlan(f.timeline,f.assets),{code:'INVALID_TIMELINE_COLOUR'});
 }
 const hidden=fixture();hidden.timeline.tracks[0].hidden=true;hidden.colour.source=(null as unknown as ((typeof hidden)["colour"])["source"]);assert.deepEqual(((createTimelineColourPlan(hidden.timeline,hidden.assets))!.clips as unknown),[]);
 const mixed=fixture(),audioTrack=randomUUID(),audioAsset=randomUUID();mixed.timeline.tracks.push({id:audioTrack,name:'Sound',kind:'audio',orderIndex:1,hidden:false,muted:false});
 mixed.timeline.clips.push({...mixed.timeline.clips[0],id:randomUUID(),trackId:audioTrack,assetId:audioAsset,colour:((null) as unknown as { profileId: string; source: { assetSha256: string; streamIndex: number; profileId: string; range: string; declaredBy: string; declaredAt: string; }; look: { resourceId: `${string}-${string}-${string}-${string}-${string}`; resourceSha256: string; resourceProfile: string; purpose: string; declaredBy: string; enabled: boolean; strength: number; }; })});mixed.assets.push((({id:audioAsset,sha256:'c'.repeat(64),mimeType:'audio/wav'}) as unknown as Parameters<typeof mixed.assets.push>[0]));
 assert.equal((createTimelineColourPlan(mixed.timeline,mixed.assets))!.clips.length,1);
});

test('timeline, clip update/add, split and replacement acknowledgements preserve exact colour intent',()=>{
 const f=fixture();assert.equal(isTimelineRecord(f.timeline),true);assert.equal(isTimelineMutationResponse('timeline.clip.update',f.input,f.timeline),true);
 const audio=clone(f.timeline);audio.tracks[0].kind='audio';assert.equal(isTimelineRecord(audio),false);audio.clips[0].colour=(null as unknown as (((typeof audio)["clips"])[number])["colour"]);assert.equal(isTimelineRecord(audio),true);
 const bad=clone(f.timeline);bad.clips[0].colour.look.strength=.7;assert.equal(isTimelineMutationResponse('timeline.clip.update',f.input,bad),false);
 const add={projectId:f.projectId,expectedRevision:1,requestId:randomUUID(),assetId:f.assetId,trackId:f.trackId,startFrame:0,durationFrames:30,name:'Video',colour:clone(f.colour)};
 assert.equal(isTimelineMutationResponse('timeline.clip.add',add,f.timeline),true);const old=clone(add);delete (old as {colour?: unknown}).colour;assert.equal(isTimelineMutationResponse('timeline.clip.add',old,f.timeline),false);
 const replacement={projectId:f.projectId,expectedRevision:1,requestId:randomUUID(),clipId:f.clipId,assetId:f.assetId};
 assert.equal(isTimelineReplacementResponse(f.timeline,replacement),false);const changed=clone(f.timeline);changed.clips[0].colour.source=(null as unknown as ((((typeof changed)["clips"])[number])["colour"])["source"]);assert.equal(isTimelineReplacementResponse(changed,replacement),true);
 const split=clone(f.timeline);split.clips[0].durationFrames=15;split.clips.push({...clone(split.clips[0]),id:randomUUID(),startFrame:15,sourceInFrame:15});
 const splitInput={projectId:f.projectId,expectedRevision:1,requestId:randomUUID(),clipId:f.clipId,atFrame:15};assert.equal(isTimelineMutationResponse('timeline.clip.split',splitInput,split),true);
 split.clips[1].colour.look.strength=.3;assert.equal(isTimelineMutationResponse('timeline.clip.split',splitInput,split),false);
 for(const value of ([undefined,{}, {...f.colour,extra:true}] as const)){const bad=clone(f.timeline);bad.clips[0].colour=(value as unknown as (((typeof bad)["clips"])[number])["colour"]);assert.equal(isTimelineRecord(bad),false);}
});

test('render acknowledgements require the exact non-null managed colour plan',()=>{
 const f=fixture(),input={projectId:f.projectId,expectedRevision:2,requestId:randomUUID(),purpose:'export'};
 const snapshot={timeline:f.timeline,assets:f.assets,colourPlan:createTimelineColourPlan(f.timeline,f.assets)};
 const response={id:randomUUID(),projectId:f.projectId,requestId:input.requestId,mode:'timeline',purpose:'export',timelineRevision:2,snapshot,status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};
 assert.equal(isTimelineRenderRecord(response,input),true);for(const mutate of ([(r: { snapshot: { colourPlan: unknown; }; })=>{delete r.snapshot.colourPlan;},(r: { snapshot: { colourPlan: { clips: { look: { enabled: boolean; }; }[]; }; }; })=>{r.snapshot.colourPlan.clips[0].look.enabled=false;},(r: { snapshot: { colourPlan: { outOfDomain: string; }; }; })=>{r.snapshot.colourPlan.outOfDomain='extrapolate';},(r: { snapshot: { colourPlan: { clips: { lutPath: string; }[]; }; }; })=>{r.snapshot.colourPlan.clips[0].lutPath='/tmp/a.cube';}] as const)){const bad=clone(response);mutate(((((bad) as unknown as Parameters<typeof mutate>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>));assert.equal(isTimelineRenderRecord(bad,input),false);}
});

test('source inspection is bounded, read-only local compute and exactly request-bound',()=>{
 const f=fixture(),input={projectId:f.projectId,assetId:f.assetId};assert.deepEqual(parse('timeline.colour.source.inspect',input),input);
 const response={...input,assetSha256:'a'.repeat(64),streamIndex:1,evidence:{primaries:'bt709',transfer:'bt709',matrix:'bt709',range:'limited',pixelFormat:'yuv420p',bitDepth:8,hdrMetadata:false},status:'compatible',reason:null};
 assert.equal(isTimelineColourSourceInspection(response,input),true);assert.equal(isTimelineColourSourceInspection(response,{...input,assetId:randomUUID()}),false);
 assert.equal(isTimelineColourSourceInspection({...response,projectId:randomUUID()},input),false);
 for(const patch of ([{path:'/private/file'},{evidence:{...response.evidence,decoder:'automatic'}},{streamIndex:null},{assetSha256:'x'},{reason:'a'.repeat(241)},{evidence:{...response.evidence,bitDepth:Infinity}}] as const))assert.equal(timelineColourSourceInspectResponseSchema.safeParse({...response,...patch}).success,false);
 for(const evidence of ([{...response.evidence,hdrMetadata:true},{...response.evidence,transfer:'smpte2084'},{...response.evidence,primaries:'bt2020'},{...response.evidence,matrix:'gbr'},{...response.evidence,pixelFormat:'rgba'},{...response.evidence,bitDepth:10},{...response.evidence,transfer:null},{...response.evidence,pixelFormat:'yuvj420p'}] as const))assert.equal(isTimelineColourSourceInspection({...response,evidence},input),false);
 const missing={...response,evidence:{...response.evidence,primaries:null},status:'needs_interpretation',reason:'Missing tags.'};assert.equal(isTimelineColourSourceInspection(missing,input),true);
 assert.equal(timelineColourPixelBitDepth('yuv422p12le'),12);assert.equal(timelineColourSourceEvidenceStatus({...response.evidence,pixelFormat:'yuv422p12le',bitDepth:12}),'unsupported');assert.equal(timelineColourPixelBitDepth('yuv422p10le'),10);assert.equal((timelineColourPixelBitDepth('yuva420p') as unknown),null);assert.equal(timelineColourSourceEvidenceStatus(missing.evidence),'needs_interpretation');
 const unsupported={...response,streamIndex:null,status:'unsupported',reason:'No selected video stream.'};assert.equal(isTimelineColourSourceInspection(unsupported,input),true);
 for(const patch of ([{path:'/tmp/source.mp4'},{ffmpegArgs:[]},{expectedRevision:1}] as const))assert.equal(schemas['timeline.colour.source.inspect'].safeParse({...input,...patch}).success,false);
 const effects=operationEffect('timeline.colour.source.inspect');assert.equal(effects.readOnly,true);assert.equal(effects.localProcess,true);for(const key of (['databaseWrite','fileWrite','externalIO','paidGeneration','destructive','openWorld'] as const))assert.equal(effects[key],false);
});

test('purposeful preflight blockers are explicit and restored LUT reading stays pair-bound',()=>{
 assert.equal(TIMELINE_COLOUR_PREFLIGHT_CODES.length,6);for(const code of TIMELINE_COLOUR_PREFLIGHT_CODES)assert.ok(TIMELINE_COLOUR_PREFLIGHT_MESSAGES[code].length<=240);
 for(const version of ([25,27,29,31,33] as const))for(const op of (['lut.list','lut.inspect','lut.import'] as const))assert.equal(lutRestorePolicy(op,version).available,[29,31,33].includes(version)&&op!=='lut.import');
});

test('definitive colour edit rejection proofs bind the exact request and do not admit read-only inspection failures',()=>{
 const f=fixture();for(const code of (['TIMELINE_COLOUR_SOURCE_MISMATCH','TIMELINE_COLOUR_LOOK_UNAVAILABLE'] as const)){const error={code,status:409,details:{mutationOutcome:'not_applied',operation:'timeline.clip.update',projectId:f.projectId,requestId:f.input.requestId}};assert.equal(hasRequestNotAppliedProof(error,f.input,{operation:'timeline.clip.update'}),true);assert.equal(hasRequestNotAppliedProof({...error,details:{...error.details,requestId:randomUUID()}},f.input,{operation:'timeline.clip.update'}),false);assert.equal(hasRequestNotAppliedProof({...error,details:{}},f.input,{operation:'timeline.clip.update'}),false);assert.equal(hasRequestNotAppliedProof({...error,details:{...error.details,operation:undefined}},f.input,{operation:'timeline.clip.update'}),false);assert.equal(hasRequestNotAppliedProof(error,{...f.input,patch:{colour:{}}},{operation:'timeline.clip.update'}),false);}
 for(const code of (['TIMELINE_COLOUR_SOURCE_UNSUPPORTED','TIMELINE_COLOUR_SOURCE_UNAVAILABLE'] as const))assert.equal(hasRequestNotAppliedProof({code,status:409,details:{mutationOutcome:'not_applied',requestId:f.input.requestId}},f.input,{operation:'timeline.clip.update'}),false);
});

test('colour-only render receipt identity prevents removal from selecting the legacy path',()=>{
 const f=fixture(),snapshot={timeline:f.timeline,assets:f.assets,colourPlan:createTimelineColourPlan(f.timeline,f.assets)},record={snapshot};
 assert.equal(hasTimelineDeliveryIdentity(record),true);assert.deepEqual(timelineRenderDeliveryFields(snapshot),{},'saved colour is not a render RPC parameter');
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE receipts(response TEXT)');db.prepare('INSERT INTO receipts VALUES(?)').run(JSON.stringify(record));
  const stripped=clone(record);delete stripped.snapshot.colourPlan;
  assert.equal(hasTimelineDeliveryIdentity(stripped),false);
  assert.notEqual((db.prepare(`SELECT ${TIMELINE_DELIVERY_RECEIPT_SQL} AS present FROM receipts`).get())!.present,null,'original receipt keeps the identity gate engaged after current row is stripped');
  assert.equal(isTimelineColourPlanSnapshot(stripped.snapshot),false,'managed clips cannot silently fall back to legacy rendering');
  for(const value of ([null,{},false,0,'invalid'] as const)){
   const corrupt={snapshot:{colourPlan:value}};assert.equal(hasTimelineDeliveryIdentity(corrupt),true);
   db.prepare('UPDATE receipts SET response=?').run(JSON.stringify(corrupt));assert.notEqual((db.prepare(`SELECT ${TIMELINE_DELIVERY_RECEIPT_SQL} AS present FROM receipts`).get())!.present,null);
  }
  db.prepare('UPDATE receipts SET response=?').run(JSON.stringify({snapshot:{}}));assert.equal(((db.prepare(`SELECT ${TIMELINE_DELIVERY_RECEIPT_SQL} AS present FROM receipts`).get())!.present as unknown),null);
 }finally{db.close();}
});
