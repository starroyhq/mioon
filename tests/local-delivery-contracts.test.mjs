import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {schemas as operations,TIMELINE_RENDER_RESPONSE_BYTES,isTimelineMutationResponse,resolveTimelineExportDelivery} from '@mioon/contracts';
import {
  LOCAL_DELIVERY_LIMITS,createLocalDeliverySchemas,localDeliveryDraftRawSchema,localDeliveryDraftPutSchema,
  localDeliveryDraftDeleteSchema,localDeliveryExecuteSchema,localDeliveryOutcomeSchema,
} from '@mioon/contracts/local-delivery';

const schemas=createLocalDeliverySchemas(value=>operations['timeline.render'].safeParse(value).success);
const stamp='2026-10-12T00:00:00.000Z';
const copy=value=>structuredClone(value);
function fixture(title='Saved title'){
  const projectId=randomUUID(),timelineId=randomUUID(),draftId=randomUUID(),intentId=randomUUID();
  const authority={workspaceScope:'a'.repeat(64),instanceId:randomUUID()};
  const input={requestId:randomUUID(),purpose:'export',projectId,expectedRevision:4,...(title===''?{}:{deliveryName:title})};
  const raw={deliveryName:title},draft={draftId,revision:1,raw};
  const prepare={...authority,projectId,expectedIntentRevision:0,expectedIntentId:null,intentId,timelineId,baseRevision:4,draft,input};
  const intent={intentId,timelineId,baseRevision:4,draft,input,createdAt:stamp,outcome:{status:'pending'}};
  const slot={projectId,draftRevision:1,draft:{draftId,timelineId,baseRevision:4,raw,updatedAt:stamp},intentRevision:1,intent};
  const envelope={supported:true,...authority,...slot,draftTargetStatus:'matching',intentTargetStatus:'matching'};
  return {projectId,timelineId,draftId,intentId,authority,input,raw,draft,prepare,intent,slot,envelope};
}
function receipt(f){
  const trackId=randomUUID(),assetId=randomUUID();
  const timeline={id:f.timelineId,projectId:f.projectId,revision:4,fps:30,width:720,height:1280,durationFrames:30,
    tracks:[{id:trackId,kind:'video',name:'Video',orderIndex:0,hidden:false,muted:false}],
    clips:[{id:randomUUID(),trackId,assetId,name:'Image',startFrame:0,durationFrames:30,sourceInFrame:0,gain:1,rect:{x:0,y:0,width:720,height:1280}}],createdAt:stamp,updatedAt:stamp};
  return {id:randomUUID(),projectId:f.projectId,requestId:f.input.requestId,mode:'timeline',purpose:'export',timelineRevision:4,
    snapshot:{timeline,assets:[{id:assetId,sha256:'b'.repeat(64),mimeType:'image/png',duration:0,width:1,height:1}],
      ...(Object.hasOwn(f.input,'deliveryName')?{deliveryName:f.input.deliveryName}:{}),
      ...(Object.hasOwn(f.input,'exportSettings')?{delivery:resolveTimelineExportDelivery(timeline,f.input.exportSettings)}:{})},
    status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};
}
const rejects=(schema,value)=>assert.equal(schema.safeParse(value).success,false);

test('local title stores invalid-but-bounded raw Unicode exactly without becoming a render schema',()=>{
  for(const deliveryName of ['', ' ', '\t\n\0', 'x'.repeat(121), 'x'.repeat(512), '🎬'.repeat(256), '  e\u0301  ']){
    const raw={deliveryName};assert.deepEqual(localDeliveryDraftRawSchema.parse(raw),raw);
    const f=fixture(''),put={...f.authority,projectId:f.projectId,expectedDraftRevision:0,draftId:f.draftId,timelineId:f.timelineId,baseRevision:4,raw};
    assert.deepEqual(localDeliveryDraftPutSchema.parse(put),put);
  }
  for(const deliveryName of [undefined,null,3,'x'.repeat(513),'🎬'.repeat(257),'\ud800','\udfff'])rejects(localDeliveryDraftRawSchema,{deliveryName});
  rejects(localDeliveryDraftRawSchema,{deliveryName:'Title',exportSettings:{}});
  const f=fixture('x'.repeat(121));rejects(schemas.prepare,f.prepare);
});

test('prepare preserves original input property order, omission, raw title and exact schema authority',()=>{
  const f=fixture('  Film 🎬  '),before=JSON.stringify(f.input),parsed=schemas.prepare.parse(f.prepare);
  assert.equal(JSON.stringify(parsed.input),before);assert.equal(parsed.input,f.input);
  assert.deepEqual(parsed,f.prepare);assert.equal(parsed.input.deliveryName,'  Film 🎬  ');
  for(const field of ['exportSettings','preflightSnapshotHash'])assert.equal(Object.hasOwn(parsed.input,field),false);
  for(const key of ['deliveryName','exportSettings','preflightSnapshotHash'])rejects(schemas.prepare,{...f.prepare,input:{...f.input,[key]:undefined}});
  for(const input of [{...f.input,purpose:'preview'},{...f.input,exportId:randomUUID()},{...f.input,providerId:'mock'},
    {...f.input,projectId:randomUUID()},{...f.input,expectedRevision:5},{...f.input,deliveryName:'Film 🎬'},
    {...f.input,preflightSnapshotHash:'not-a-hash'},{...f.input,exportSettings:{profileId:'invented'}}])rejects(schemas.prepare,{...f.prepare,input});
  rejects(createLocalDeliverySchemas(()=>false).prepare,f.prepare);
  rejects(createLocalDeliverySchemas(()=>{throw Error('unavailable');}).prepare,f.prepare);
  assert.throws(()=>createLocalDeliverySchemas(undefined),TypeError);
});

test('blank title means exact legacy omission; no draft only authorizes unnamed input',()=>{
  const f=fixture('');assert.deepEqual(schemas.prepare.parse(f.prepare).input,f.input);
  assert.equal(Object.hasOwn(f.input,'deliveryName'),false);
  assert.ok(schemas.prepare.safeParse({...f.prepare,draft:null}).success);
  for(const deliveryName of ['',undefined,' '])rejects(schemas.prepare,{...f.prepare,input:{...f.input,deliveryName}});
  const named=fixture();rejects(schemas.prepare,{...named.prepare,draft:null});
  const invalid=fixture(' ');rejects(schemas.prepare,invalid.prepare);
});

test('profile types follow every existing closed profile branch without introducing defaults',()=>{
  for(const resolution of ['native','short_360','short_1080']){
    const rates=[...['compact','standard','high'].map(quality=>({mode:'crf',quality})),...[2000,4000,8000].map(targetKbps=>({mode:'bitrate',targetKbps}))];
    for(const rateControl of rates){
      const f=fixture();f.input.exportSettings={profileId:'mp4_h264_v1',resolution,rateControl};f.input.preflightSnapshotHash='c'.repeat(64);
      assert.ok(operations['timeline.render'].safeParse(f.input).success);
      const before=JSON.stringify(f.input);assert.equal(JSON.stringify(schemas.prepare.parse(f.prepare).input),before);
    }
  }
  const f=fixture();for(const exportSettings of [null,{}, {profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'crf',quality:'standard',extra:1}},
    {profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'bitrate',targetKbps:3000}}])rejects(schemas.prepare,{...f.prepare,input:{...f.input,exportSettings}});
});

test('independent draft CAS retains newer title while older intent and exact captured draft remain frozen',()=>{
  const f=fixture(),slot=copy(f.slot);slot.draftRevision=9;slot.draft={...slot.draft,draftId:randomUUID(),baseRevision:7,raw:{deliveryName:'New title'}};
  assert.deepEqual(schemas.slot.parse(slot),slot);assert.equal(slot.intent.draft.revision,1);assert.equal(slot.intent.input.deliveryName,'Saved title');
  const envelope={...f.envelope,...slot,draftTargetStatus:'matching',intentTargetStatus:'changed'};
  assert.ok(schemas.envelope.safeParse(envelope).success);
  assert.ok(schemas.slot.safeParse({...slot,draftRevision:10,draft:null}).success);
  rejects(schemas.slot,{...slot,draftRevision:0});
  rejects(localDeliveryDraftDeleteSchema,{...f.authority,projectId:f.projectId,draftId:f.draftId,expectedDraftRevision:0});
  rejects(localDeliveryDraftDeleteSchema,{...f.authority,projectId:f.projectId,draftId:f.draftId,expectedDraftRevision:1,intentId:f.intentId});
});

test('latest intent identity and monotonic CAS cannot be erased, substituted or confused with draft revision',()=>{
  const f=fixture();assert.ok(schemas.prepare.safeParse({...f.prepare,expectedIntentRevision:2,expectedIntentId:randomUUID()}).success);
  rejects(schemas.prepare,{...f.prepare,expectedIntentRevision:2});
  rejects(schemas.prepare,{...f.prepare,expectedIntentId:randomUUID()});
  rejects(schemas.prepare,{...f.prepare,expectedIntentRevision:2,expectedIntentId:f.intentId});
  for(const value of [{...f.slot,intentRevision:0},{...f.slot,intent:null},{...f.slot,intentRevision:Number.MAX_SAFE_INTEGER+1},
    {...f.slot,intent:{...f.intent,input:{...f.input,projectId:randomUUID()}}}])rejects(schemas.slot,value);
  const execute={...f.authority,projectId:f.projectId,intentId:f.intentId,expectedIntentRevision:1};
  assert.deepEqual(localDeliveryExecuteSchema.parse(execute),execute);
  for(const patch of [{expectedIntentRevision:0},{expectedIntentRevision:1.5},{input:f.input},{requestId:f.input.requestId},{draftRevision:1},{exportId:randomUUID()}])rejects(localDeliveryExecuteSchema,{...execute,...patch});
});

test('bounded disk keeps project tombstones, one latest intent, no journal or receipt snapshots',()=>{
  const f=fixture(),disk={version:1,workspaceScope:f.authority.workspaceScope,entries:[f.slot]};
  assert.deepEqual(schemas.disk.parse(disk),disk);
  const tombstone={projectId:f.projectId,draftRevision:3,draft:null,intentRevision:0,intent:null};
  assert.ok(schemas.disk.safeParse({...disk,entries:[tombstone]}).success);
  rejects(schemas.disk,{...disk,entries:[{...tombstone,draftRevision:0}]});
  rejects(schemas.disk,{...disk,entries:[f.slot,copy(f.slot)]});
  rejects(schemas.disk,{...disk,version:2});
  rejects(schemas.disk,{...disk,journal:[]});
  rejects(schemas.slot,{...f.slot,intent:{...f.intent,snapshot:{}}});
  rejects(schemas.slot,{...f.slot,intent:{...f.intent,outcome:{status:'accepted',exportId:randomUUID(),responseSha256:'d'.repeat(64),resolvedAt:stamp,response:{}}}});
  const entries=Array.from({length:LOCAL_DELIVERY_LIMITS.slots},()=>({...tombstone,projectId:randomUUID()}));
  assert.ok(schemas.disk.safeParse({...disk,entries}).success);
  rejects(schemas.disk,{...disk,entries:[...entries,{...tombstone,projectId:randomUUID()}]});
});

test('outcomes carry only bounded authoritative receipt references or proof codes',()=>{
  for(const outcome of [{status:'pending'},{status:'accepted',exportId:randomUUID(),responseSha256:'e'.repeat(64),resolvedAt:stamp},
    {status:'not_applied',code:'REVISION_CONFLICT',resolvedAt:stamp}])assert.deepEqual(localDeliveryOutcomeSchema.parse(outcome),outcome);
  for(const outcome of [{status:'reserved'},{status:'pending',dispatched:false},{status:'accepted',exportId:randomUUID(),resolvedAt:stamp},
    {status:'not_applied',code:'x'.repeat(101),resolvedAt:stamp},{status:'not_applied',code:'INVALID ERROR',resolvedAt:stamp},
    {status:'not_applied',code:'REVISION_CONFLICT',resolvedAt:stamp,message:'unbounded private text'}])rejects(localDeliveryOutcomeSchema,outcome);
});

test('old render and original receipt bytes remain unchanged; execute is separately bounded and still needs shared ACK validation',()=>{
  assert.equal(LOCAL_DELIVERY_LIMITS.renderResponseBytes,TIMELINE_RENDER_RESPONSE_BYTES);
  assert.equal(LOCAL_DELIVERY_LIMITS.executeResponseBytes,TIMELINE_RENDER_RESPONSE_BYTES+LOCAL_DELIVERY_LIMITS.httpBytes);
  for(const title of ['', '  Named export  ']){
    const f=fixture(title),response=receipt(f),bytes=JSON.stringify(response);
    assert.ok(isTimelineMutationResponse('timeline.render',f.input,response));
    const outcome={status:'accepted',exportId:response.id,responseSha256:createHash('sha256').update(bytes).digest('hex'),resolvedAt:stamp};
    const envelope={...f.envelope,intentRevision:2,intent:{...f.intent,outcome}},execution={envelope,response};
    assert.equal(JSON.stringify(schemas.execution.parse(execution).response),bytes);assert.equal(JSON.stringify(response),bytes);
    assert.equal(Object.hasOwn(response.snapshot,'deliveryName'),title!=='');assert.equal(Object.hasOwn(response.snapshot,'delivery'),false);
    // Structural envelope validation cannot manufacture an authoritative ACK.
    const forged={...response,requestId:randomUUID()};assert.equal(isTimelineMutationResponse('timeline.render',f.input,forged),false);
    rejects(schemas.execution,{...execution,response:{oversized:'x'.repeat(TIMELINE_RENDER_RESPONSE_BYTES)}});
    rejects(schemas.execution,{envelope:f.envelope,response});
  }
  const f=fixture();assert.ok(schemas.execution.safeParse({envelope:f.envelope,response:null}).success);
  rejects(schemas.execution,{envelope:f.envelope});rejects(schemas.execution,{envelope:f.envelope,response:undefined});
});

test('unsupported restored workspace is explicit and contains no inferred authority or hidden sidecar data',()=>{
  const unsupported={supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'};
  assert.deepEqual(schemas.envelope.parse(unsupported),unsupported);
  assert.deepEqual(schemas.execution.parse({envelope:unsupported,response:null}),{envelope:unsupported,response:null});
  rejects(schemas.envelope,{...unsupported,workspaceScope:'a'.repeat(64)});
  const f=fixture();rejects(schemas.envelope,{...f.envelope,draftTargetStatus:'unset'});
  rejects(schemas.envelope,{...f.envelope,intentTargetStatus:'unset'});
  const empty={...f.envelope,draftRevision:0,draft:null,intentRevision:0,intent:null,draftTargetStatus:'unset',intentTargetStatus:'unset'};
  assert.deepEqual(schemas.envelope.parse(empty),empty);
});
