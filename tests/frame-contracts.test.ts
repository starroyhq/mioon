import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {FRAME_PROFILE_ID,FRAME_SELECTION_RULE,FRAME_PROFILE,FRAME_LIMITS,FRAME_STATES,FRAME_MUTATION_OPERATIONS,frameSchemas,frameSnapshotSchema,frameReceiptSchema,frameTaskResponseSchema,isFrameTaskResponse,isFrameRequestResponse,isFrameMutationResponse,isFrameListResponse,canonicalFrameInput} from '../packages/contracts/src/frame-extraction.ts';
const projectId=randomUUID(),taskId=randomUUID(),sourceAssetId=randomUUID(),assetId=randomUUID(),requestId='frame-request-one',sourceHash='a'.repeat(64),at='2026-10-11T00:00:00.000Z';
const input={projectId,sourceAssetId,sourceHash,sourceFrame:56,requestId};
const snapshot={schemaVersion:1,projectId,taskId,source:{assetId:sourceAssetId,sha256:sourceHash,mimeType:'video/mp4',sizeBytes:12345,relativePath:`media/${sourceAssetId}.mp4`,duration:3,width:1920,height:1080},requested:{sourceFrame:56,fps:30},profile:FRAME_PROFILE};
const task={id:taskId,projectId,requestId,sourceAssetId,sourceHash,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,state:'queued',revision:1,started:false,result:null,errorCode:null,createdAt:at,updatedAt:at};
const receipt={schemaVersion:1,projectId,taskId,inputHash:'b'.repeat(64),sourceAssetId,sourceHash,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,assetId,sha256:'c'.repeat(64),mimeType:'image/png',width:1024,height:576,byteLength:100,
 probe:{streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:1920,height:1080,rotation:0,sarNumerator:1,sarDenominator:1}};

test('frame surface is exactly six strict local operations with stable bounded replay keys',()=>{
 assert.deepEqual(Object.keys(frameSchemas).sort(),['frame.extract','frame.request.get','frame.task.get','frame.task.list','frame.task.cancelQueued','frame.task.recoverResult'].sort());
 assert.deepEqual(frameSchemas['frame.extract'].parse(input),input);
 for(const extra of [{path:'/tmp/video'},{providerId:'mock'},{prompt:'text'},{role:'first_frame'},{outputPath:'a.png'},{profileId:FRAME_PROFILE_ID},{fps:24},{sourceRangeRevision:2},{sourceFrame:-1},{sourceFrame:0.5},{sourceFrame:Number.MAX_SAFE_INTEGER+1},{sourceHash:'A'.repeat(64)},{sourceAssetId:'not-uuid'},{requestId:'short'},{requestId:'x'.repeat(201)}])assert.equal(frameSchemas['frame.extract'].safeParse({...input,...extra}).success,false,JSON.stringify(extra));
 assert.ok(frameSchemas['frame.extract'].safeParse({...input,sourceFrame:0,requestId:randomUUID()}).success);
 for(const operation of FRAME_MUTATION_OPERATIONS.slice(1)){
  assert.ok(frameSchemas[operation].safeParse({projectId,taskId,expectedRevision:1,requestId}).success);
  for(const extra of [{expectedRevision:0},{expectedRevision:1.5},{confirm:true},{retry:true}])assert.equal(frameSchemas[operation].safeParse({projectId,taskId,expectedRevision:1,requestId,...extra}).success,false);
 }
 for(const extra of [{limit:51},{limit:0},{cursor:'x'.repeat(769)},{cursor:'白'.repeat(257)},{groupId:randomUUID()}])assert.equal(frameSchemas['frame.task.list'].safeParse({projectId,...extra}).success,false);
 assert.equal(canonicalFrameInput(input),canonicalFrameInput(Object.fromEntries(Object.entries(input).reverse())));
});

test('snapshot freezes acceptance metadata, managed relative path, requested clock and profile only',()=>{
 assert.ok(frameSnapshotSchema.safeParse(snapshot).success);
 for(const relativePath of ['/tmp/a.mp4','../a.mp4','media/../a.mp4','media//a.mp4','media/./a.mp4','C:\\a.mp4','file:a.mp4','media/a\0.mp4','x'.repeat(1025)])assert.equal(frameSnapshotSchema.safeParse({...snapshot,source:{...snapshot.source,relativePath}}).success,false,relativePath);
 for(const source of [{duration:0},{duration:601},{duration:1/60},{sizeBytes:FRAME_LIMITS.sourceBytes+1},{width:4097},{width:4096,height:4096},{mimeType:'image/png'}])assert.equal(frameSnapshotSchema.safeParse({...snapshot,source:{...snapshot.source,...source}}).success,false);
 assert.equal(frameSnapshotSchema.safeParse({...snapshot,requested:{sourceFrame:90,fps:30}}).success,false);
 assert.equal(frameSnapshotSchema.safeParse({...snapshot,requested:{sourceFrame:56,fps:24}}).success,false);
 assert.equal(frameSnapshotSchema.safeParse({...snapshot,probe:receipt.probe}).success,false);
 assert.equal(frameSnapshotSchema.safeParse({...snapshot,profile:{...FRAME_PROFILE,id:'future-profile'}}).success,false);
 // A later mutable asset.duration does not participate in parsing old snapshots.
 assert.equal(frameSnapshotSchema.parse(snapshot).source.duration,3);
});

test('receipt contains independent PNG identity and actual bounded probe evidence, never selected PTS',()=>{
 assert.ok(frameReceiptSchema.safeParse(receipt).success);
 for(const extra of [{path:'/tmp/out.png'},{dataBase64:'AAAA'},{selectedPts:100},{actualSelectedPts:null},{assetId:sourceAssetId},{width:1023},{height:575},{byteLength:FRAME_LIMITS.resultBytes+1},{profileId:'future-profile'},{selectionRule:'nearest'}])assert.equal(frameReceiptSchema.safeParse({...receipt,...extra}).success,false);
 for(const probe of [{rotation:90},{sarNumerator:2},{timeBaseNumerator:2},{timeBaseDenominator:0},{timeBaseDenominator:1_000_000_001},{streamIndex:256},{width:4097}])assert.equal(frameReceiptSchema.safeParse({...receipt,probe:{...receipt.probe,...probe}}).success,false);
 assert.ok(frameReceiptSchema.safeParse({...receipt,width:320,height:180,probe:{...receipt.probe,width:320,height:180}}).success);
 assert.equal(frameReceiptSchema.safeParse({...receipt,width:640,height:360,probe:{...receipt.probe,width:320,height:180}}).success,false);
});

test('safe task DTOs distinguish local start fence, historical ACKs and immutable output',()=>{
 assert.ok(isFrameTaskResponse(task));assert.ok(isFrameMutationResponse('frame.extract',input,task));
 assert.deepEqual(FRAME_STATES,['queued','running','persisting','succeeded','cancelled_before_start','interrupted','local_result_error','failed']);
 for(const extra of [{snapshot},{stagedReceipt:receipt},{relativePath:'media/a.png'},{state:'outcome_unknown'},{state:'cancelled'},{started:true},{revision:2},{errorCode:'REMOTE_OK'}])assert.equal(isFrameTaskResponse({...task,...extra}),false);
 for(const extra of [{sourceFrame:55},{requestId:'other-key'},{sourceHash:'d'.repeat(64)},{sourceAssetId:randomUUID()}])assert.equal(isFrameMutationResponse('frame.extract',input,{...task,...extra}),false);
 const result={assetId,sha256:receipt.sha256,mimeType:'image/png',width:1024,height:576,byteLength:100};
 assert.ok(isFrameTaskResponse({...task,state:'succeeded',revision:4,started:true,result}));
 assert.equal(isFrameTaskResponse({...task,state:'succeeded',revision:4,started:true}),false);
 assert.equal(isFrameTaskResponse({...task,state:'running',revision:2,started:true,result}),false);
 for(const started of [false,true])assert.ok(frameTaskResponseSchema.safeParse({...task,state:'interrupted',revision:2,started,errorCode:'FRAME_INTERRUPTED'}).success);
 const control={projectId,taskId,expectedRevision:2,requestId:'cancel-key'},cancelled={...task,state:'cancelled_before_start',revision:3};
 assert.ok(isFrameMutationResponse('frame.task.cancelQueued',control,cancelled));
 assert.ok(isFrameRequestResponse({projectId,requestId:control.requestId,operation:'frame.task.cancelQueued',response:cancelled}));
 assert.ok(isFrameRequestResponse({projectId,requestId,operation:'frame.extract',response:task}));
 assert.ok(isFrameRequestResponse(null));
 assert.equal(isFrameRequestResponse({projectId,requestId:'other-key',operation:'frame.extract',response:task}),false);
 assert.equal(isFrameRequestResponse({projectId,requestId,operation:'frame.extract',response:{...task,state:'running',revision:2,started:true}}),false);
 assert.ok(isFrameMutationResponse('frame.task.recoverResult',control,{...task,state:'persisting',revision:3,started:true}));
});

test('paged frame reads reject foreign, duplicate, oversized and unsafe payloads',()=>{
 const response={projectId,items:[task],nextCursor:null};
 assert.ok(isFrameListResponse('frame.task.list',{projectId},response));
 for(const extra of [{items:[task,task]},{items:[{...task,projectId:randomUUID()}]},{nextCursor:'白'.repeat(257)},{snapshot},{projectId:randomUUID()}])assert.equal(isFrameListResponse('frame.task.list',{projectId},{...response,...extra}),false);
 assert.equal(isFrameListResponse('frame.task.get',{projectId},response),false);
 assert.equal(FRAME_LIMITS.requestsPerTask,1+FRAME_LIMITS.reservedControlRequestsPerTask);
 assert.equal(FRAME_LIMITS.requestsGlobal,FRAME_LIMITS.tasksGlobal*FRAME_LIMITS.requestsPerTask);
 assert.equal(FRAME_LIMITS.requestsPerProject,FRAME_LIMITS.tasksPerProject*FRAME_LIMITS.requestsPerTask);
});
