import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {schemas as operations,isLocalMutationResponse} from '@mioon/contracts';
import {
  LOCAL_SHOT_TEXT_LIMITS,createLocalShotTextSchemas,isLocalShotTextMutationResponse,
  localShotTextKeySchema,localShotTextDraftRawSchema,localShotTextBaseTextSchema,
  localShotTextDraftPutSchema,localShotTextDraftDeleteSchema,localShotTextExecuteSchema,localShotTextOutcomeSchema,
} from '@mioon/contracts/local-shot-text';

const schemas=createLocalShotTextSchemas(value=>operations['shot.update'].safeParse(value).success);
const stamp='2026-10-12T00:00:00.000Z';
const copy=<T>(value: T): T=>structuredClone(value);
const bytes=(value: unknown)=>Buffer.byteLength(JSON.stringify(value));
const rejects=(schema: {safeParse(value: unknown): {success: boolean}}, value: unknown)=>assert.equal(schema.safeParse(value).success,false);
interface ShotTextValue {title?: unknown; prompt?: unknown; [key: string]: unknown}
interface ShotTextDraft {draftId: string; revision: number; raw: ShotTextValue; [key: string]: unknown}
interface ShotTextSlot {projectId: string; shotId: string; draftRevision: number; draft: {draftId: string; baseRevision: number; baseText: ShotTextValue; raw: ShotTextValue; updatedAt: string; [key: string]: unknown}; intentRevision: number; intent: {outcome: Record<string, unknown>; draft: {revision: number; [key: string]: unknown}; input: {shotId: string; patch: ShotTextValue; [key: string]: unknown}; [key: string]: unknown}; [key: string]: unknown}
interface ShotTextFixture {projectId: string; shotId: string; draftId: string; intentId: string; authority: {workspaceScope: string; instanceId: string};
  input: {requestId: string; shotId: string; expectedRevision: number; patch: ShotTextValue; [key: string]: unknown}; raw: ShotTextValue;
  baseText: ShotTextValue; draft: ShotTextDraft; prepare: Record<string, unknown>; intent: Record<string, unknown>;
  slot: ShotTextSlot; envelope: Record<string, unknown>; put: Record<string, unknown>}
function fixture({baseText={title:'Saved title',prompt:'Saved prompt'},raw={title:'Edited title',prompt:'Saved prompt'},patch={title:raw.title}}: {baseText?: ShotTextValue; raw?: ShotTextValue; patch?: ShotTextValue}={}): ShotTextFixture {
  const projectId=randomUUID(),shotId=randomUUID(),draftId=randomUUID(),intentId=randomUUID();
  const authority={workspaceScope:'a'.repeat(64),instanceId:randomUUID()};
  const input={requestId:randomUUID(),shotId,expectedRevision:4,patch};
  const draft={draftId,revision:1,raw};
  const prepare={...authority,projectId,shotId,expectedIntentRevision:0,expectedIntentId:null,intentId,baseRevision:4,baseText,draft,input};
  const intent={intentId,baseRevision:4,baseText,draft,input,createdAt:stamp,outcome:{status:'pending'}};
  const slot={projectId,shotId,draftRevision:1,draft:{draftId,baseRevision:4,baseText,raw,updatedAt:stamp},intentRevision:1,intent};
  const envelope={supported:true,...authority,...slot,draftTargetStatus:'matching',intentTargetStatus:'matching',projectPendingIntent:{shotId,intentId}};
  const put={...authority,projectId,shotId,expectedDraftRevision:0,draftId,baseRevision:4,baseText,raw};
  return {projectId,shotId,draftId,intentId,authority,input,raw,baseText,draft,prepare,intent,slot,envelope,put};
}
function receipt(f: ShotTextFixture){
  return {id:f.shotId,projectId:f.projectId,title:Object.hasOwn(f.input.patch,'title')?f.input.patch.title:f.baseText.title,
    prompt:Object.hasOwn(f.input.patch,'prompt')?f.input.patch.prompt:f.baseText.prompt,
    referenceAssetIds:[],aspectRatio:'9:16',duration:2,parameters:{},position:{x:0,y:0},orderIndex:0,revision:5,
    selectedVersionId:null,createdAt:stamp,updatedAt:stamp};
}
function appliedEnvelope(f: ShotTextFixture,response: ReturnType<typeof receipt>=receipt(f)){
  return {...f.envelope,intentRevision:2,projectPendingIntent:null,intent:{...f.intent,outcome:{status:'applied',shotRevision:5,
    responseSha256:createHash('sha256').update(JSON.stringify(response)).digest('hex'),resolvedAt:stamp}}};
}

test('raw text preserves bounded invalid business edits and valid Unicode without trimming or normalization',()=>{
  const f=fixture();
  for(const raw of [{title:'',prompt:''},{title:' \t\n\0 ',prompt:'\r\n\0'},
    {title:'x'.repeat(512),prompt:'x'.repeat(6000)},{title:'🎬'.repeat(256),prompt:'🎬'.repeat(3000)},
    {title:'  e\u0301  ',prompt:'  untouched\ntext  '}]){
    assert.deepEqual(localShotTextDraftRawSchema.parse(raw),raw);
    assert.deepEqual(localShotTextDraftPutSchema.parse({...f.put,raw}),{...f.put,raw});
  }
  for(const raw of [{title:'x'.repeat(513),prompt:''},{title:'🎬'.repeat(257),prompt:''},{title:'T',prompt:'x'.repeat(6001)},
    {title:'T',prompt:'🎬'.repeat(3001)},{title:'\ud800',prompt:''},{title:'T',prompt:'\udfff'},
    {title:null,prompt:''},{title:'T',prompt:undefined},{title:'T',prompt:'',position:{x:1,y:1}}])rejects(localShotTextDraftRawSchema,raw);
  for(const baseText of [{title:'',prompt:''},{title:'x'.repeat(151),prompt:''},{title:'T',prompt:'x'.repeat(5001)},
    {title:'T',prompt:null},{title:'\ud800',prompt:''},{title:'T'}])rejects(localShotTextBaseTextSchema,baseText);
  for(const raw of [{title:'',prompt:f.baseText.prompt},{title:'x'.repeat(151),prompt:f.baseText.prompt},
    {title:'T',prompt:'x'.repeat(5001)}]){
    const invalid=fixture({raw,patch:{...raw}});assert.ok(localShotTextDraftPutSchema.safeParse(invalid.put).success);rejects(schemas.prepare,invalid.prepare);
  }
});

test('explicit project and shot key contains no arbitrary path or inferred target',()=>{
  const f=fixture(),key={projectId:f.projectId,shotId:f.shotId};assert.deepEqual(schemas.key.parse(key),key);
  for(const value of [{projectId:f.projectId},{shotId:f.shotId},{...key,path:'../other.sqlite'},
    {...key,projectId:'../project'},{...key,shotId:null}])rejects(localShotTextKeySchema,value);
  for(const value of [{...f.put,input:f.input},{...f.put,intentId:f.intentId},{...f.put,baseRevision:0},
    {...f.put,expectedDraftRevision:-1},{...f.put,expectedDraftRevision:Number.MAX_SAFE_INTEGER+1}])rejects(localShotTextDraftPutSchema,value);
});

test('prepare freezes exact caller input, key order, omission and canonical validator authority',()=>{
  const f=fixture({raw:{title:'  Edited e\u0301 🎬  ',prompt:'Saved prompt'}});
  f.input.patch={title:f.raw.title as string};f.input={patch:f.input.patch,expectedRevision:4,shotId:f.shotId,requestId:f.input.requestId};
  f.prepare.input=f.input;const before=JSON.stringify(f.input),parsed=schemas.prepare.parse(f.prepare);
  assert.equal(parsed.input,f.input);assert.equal(parsed.input.patch,f.input.patch);assert.equal(JSON.stringify(parsed.input),before);
  assert.equal(Object.hasOwn(parsed.input.patch,'prompt'),false);assert.equal(parsed.input.patch.title,f.raw.title);
  for(const input of [{...f.input,projectId:f.projectId},{...f.input,operation:'shot.update'},
    {...f.input,shotId:randomUUID()},{...f.input,expectedRevision:5},{...f.input,requestId:undefined},
    {...f.input,requestId:'short'},{...f.input,patch:{title:f.raw.title as string,prompt:undefined}},
    {...f.input,patch:{title:null}},{...f.input,patch:{title:undefined}},{...f.input,patch:{}},
    {...f.input,patch:{title:f.raw.title as string,position:{x:0,y:0}}},{...f.input,patch:{title:f.raw.title as string,lastFrameAssetId:null}},
    {...f.input,patch:{title:f.raw.title as string,referenceAssetIds:[]}},{...f.input,patch:{title:(f.raw.title as string).trim()}}])rejects(schemas.prepare,{...f.prepare,input});
  rejects(createLocalShotTextSchemas(()=>false).prepare,f.prepare);
  rejects(createLocalShotTextSchemas(()=>{throw Error('validator unavailable');}).prepare,f.prepare);
  assert.throws(()=>createLocalShotTextSchemas(undefined as never),TypeError);
  // A permissive adapter cannot widen this fixed intent to another shot field.
  rejects(createLocalShotTextSchemas(()=>true).prepare,{...f.prepare,input:{...f.input,patch:{position:{x:0,y:0}}}});
});

test('omission retains baseline, empty prompt clears, null is never a write, and no-op intents are rejected',()=>{
  const f=fixture();assert.ok(schemas.prepare.safeParse(f.prepare).success);
  const clear=fixture({raw:{title:'Saved title',prompt:''},patch:{prompt:''}});
  assert.ok(schemas.prepare.safeParse(clear.prepare).success);assert.equal(Object.hasOwn(clear.input.patch,'title'),false);
  const both=fixture({raw:{title:'Edited title',prompt:''},patch:{title:'Edited title',prompt:''}});
  assert.ok(schemas.prepare.safeParse(both.prepare).success);
  const unchangedIncluded=fixture({patch:{title:'Edited title',prompt:'Saved prompt'}});
  assert.ok(schemas.prepare.safeParse(unchangedIncluded.prepare).success);
  for(const invalid of [fixture({raw:{title:'Saved title',prompt:'Saved prompt'},patch:{title:'Saved title'}}),
    fixture({raw:{title:'Saved title',prompt:'Saved prompt'},patch:{title:'Saved title',prompt:'Saved prompt'}}),
    fixture({raw:{title:'Edited title',prompt:'Unsaved other edit'},patch:{title:'Edited title'}}),
    fixture({raw:{title:'Different captured title',prompt:'Saved prompt'},patch:{title:'Edited title'}})])rejects(schemas.prepare,invalid.prepare);
  rejects(schemas.prepare,{...f.prepare,draft:null});
  rejects(schemas.prepare,{...clear.prepare,input:{...clear.input,patch:{prompt:null}}});
});

test('draft and intent revisions are independent and old immutable intent survives newer draft or tombstone',()=>{
  const f=fixture(),slot=copy(f.slot);slot.draftRevision=9;
  slot.draft={...slot.draft,draftId:randomUUID(),baseRevision:7,baseText:{title:'New saved title',prompt:'New baseline'},raw:{title:'New invalid draft',prompt:'x'.repeat(6000)}};
  assert.deepEqual(schemas.slot.parse(slot),slot);assert.equal(slot.intent.draft.revision,1);assert.equal(slot.intent.input.patch.title,'Edited title');
  assert.ok(schemas.envelope.safeParse({...f.envelope,...slot,draftTargetStatus:'matching',intentTargetStatus:'changed'}).success);
  assert.ok(schemas.slot.safeParse({...slot,draftRevision:10,draft:null}).success);
  rejects(schemas.slot,{...f.slot,draftRevision:0});
  rejects(schemas.slot,{...f.slot,intent:{...f.intent,draft:{...f.draft,revision:2}}});
  const discard={...f.authority,projectId:f.projectId,shotId:f.shotId,draftId:f.draftId,expectedDraftRevision:1};
  assert.deepEqual(localShotTextDraftDeleteSchema.parse(discard),discard);
  rejects(localShotTextDraftDeleteSchema,{...discard,expectedDraftRevision:0});
  rejects(localShotTextDraftDeleteSchema,{...discard,intentId:f.intentId});
});

test('intent CAS retains latest identity and execute/recovery cannot rewrite the original frozen input',()=>{
  const f=fixture();assert.ok(schemas.prepare.safeParse({...f.prepare,expectedIntentRevision:2,expectedIntentId:randomUUID()}).success);
  for(const patch of [{expectedIntentRevision:2},{expectedIntentId:randomUUID()},
    {expectedIntentRevision:2,expectedIntentId:f.intentId},{baseRevision:5}])rejects(schemas.prepare,{...f.prepare,...patch});
  for(const slot of [{...f.slot,intentRevision:0},{...f.slot,intent:null},{...f.slot,intentRevision:Number.MAX_SAFE_INTEGER+1},
    {...f.slot,shotId:randomUUID()},{...f.slot,intent:{...f.intent,input:{...f.input,requestId:undefined}}}])rejects(schemas.slot,slot);
  const execute={...f.authority,projectId:f.projectId,shotId:f.shotId,intentId:f.intentId,expectedIntentRevision:1};
  assert.deepEqual(localShotTextExecuteSchema.parse(execute),execute);
  for(const patch of [{expectedIntentRevision:0},{expectedIntentRevision:1.5},{input:f.input},{patch:f.input.patch},
    {requestId:f.input.requestId},{draftRevision:1},{baseText:f.baseText},{shotId:undefined}])rejects(localShotTextExecuteSchema,{...execute,...patch});
});

test('disk retains bounded no-eviction shot tombstones and forbids duplicate owners or concurrent project intents',()=>{
  const f=fixture(),disk={version:1,workspaceScope:f.authority.workspaceScope,entries:[f.slot]};assert.deepEqual(schemas.disk.parse(disk),disk);
  const tombstone={projectId:f.projectId,shotId:f.shotId,draftRevision:3,draft:null,intentRevision:0,intent:null};
  assert.ok(schemas.disk.safeParse({...disk,entries:[tombstone]}).success);
  rejects(schemas.disk,{...disk,entries:[{...tombstone,draftRevision:0}]});
  rejects(schemas.disk,{...disk,entries:[f.slot,copy(f.slot)]});
  rejects(schemas.disk,{...disk,entries:[f.slot,{...tombstone,projectId:randomUUID()}]});
  const sibling=fixture();sibling.slot.projectId=f.projectId;
  rejects(schemas.disk,{...disk,entries:[f.slot,sibling.slot]});
  sibling.slot.intent.outcome={status:'not_applied',code:'REVISION_CONFLICT',resolvedAt:stamp};
  assert.ok(schemas.disk.safeParse({...disk,entries:[f.slot,sibling.slot]}).success);
  rejects(schemas.disk,{...disk,version:2});rejects(schemas.disk,{...disk,journal:[]});
  rejects(schemas.slot,{...f.slot,intent:{...f.intent,response:receipt(f)}});
  const entries=Array.from({length:LOCAL_SHOT_TEXT_LIMITS.slots},()=>({...tombstone,shotId:randomUUID()}));
  assert.ok(schemas.disk.safeParse({...disk,entries}).success);
  rejects(schemas.disk,{...disk,entries:[...entries,{...tombstone,shotId:randomUUID()}]});
});

test('readonly project pending reference blocks sibling ambiguity without exposing sibling text',()=>{
  const f=fixture();assert.deepEqual(schemas.envelope.parse(f.envelope),f.envelope);
  for(const projectPendingIntent of [null,{shotId:randomUUID(),intentId:f.intentId},{shotId:f.shotId,intentId:randomUUID()},
    {...(f.envelope.projectPendingIntent as Record<string, unknown>),raw:f.raw}])rejects(schemas.envelope,{...f.envelope,projectPendingIntent});
  const sibling={...f.envelope,shotId:randomUUID(),draftRevision:0,draft:null,intentRevision:0,intent:null,draftTargetStatus:'unset',intentTargetStatus:'unset'} as {projectPendingIntent?: unknown; [key: string]: unknown};
  assert.deepEqual(schemas.envelope.parse(sibling),sibling);
  rejects(schemas.envelope,{...sibling,projectPendingIntent:{shotId:(sibling as {shotId: string}).shotId,intentId:f.intentId}});
  const {projectPendingIntent:ignored,...missing}=sibling as {projectPendingIntent?: unknown; [key: string]: unknown};void ignored;rejects(schemas.envelope,missing);
});

test('outcomes carry only bounded authoritative references and applied revision is exact',()=>{
  const f=fixture();
  for(const outcome of [{status:'pending'},{status:'applied',shotRevision:5,responseSha256:'b'.repeat(64),resolvedAt:stamp},
    {status:'not_applied',code:'REVISION_CONFLICT',resolvedAt:stamp}])assert.deepEqual(localShotTextOutcomeSchema.parse(outcome),outcome);
  for(const outcome of [{status:'accepted'},{status:'pending',dispatched:false},
    {status:'applied',shotRevision:5,resolvedAt:stamp},{status:'applied',shotRevision:0,responseSha256:'c'.repeat(64),resolvedAt:stamp},
    {status:'not_applied',code:'x'.repeat(101),resolvedAt:stamp},{status:'not_applied',code:'INVALID ERROR',resolvedAt:stamp},
    {status:'not_applied',code:'REVISION_CONFLICT',resolvedAt:stamp,message:'private text'}])rejects(localShotTextOutcomeSchema,outcome);
  for(const shotRevision of [4,6])rejects(schemas.slot,{...f.slot,intent:{...f.intent,outcome:{status:'applied',shotRevision,responseSha256:'d'.repeat(64),resolvedAt:stamp}}});
});

test('worst escaped legal text and newer maximum raw fit the derived 256 KiB slot and HTTP budgets',()=>{
  const maxSaved={title:'\0'.repeat(150),prompt:'\0'.repeat(5000)},maxEdited={title:'\x01'.repeat(150),prompt:'\x01'.repeat(5000)};
  // Controls are legal existing shot.update strings and cost six escaped bytes.
  assert.equal(bytes(maxSaved.prompt),5000*6+2);assert.equal(bytes(maxSaved.title),150*6+2);
  const f=fixture({baseText:maxSaved,raw:maxEdited,patch:{...maxEdited}});f.input.requestId='\0'.repeat(200);
  assert.ok(operations['shot.update'].safeParse(f.input).success);
  assert.ok(bytes(f.input)>8192);assert.ok(schemas.prepare.safeParse(f.prepare).success);
  f.slot.draftRevision=2;f.slot.draft.raw={title:'\0'.repeat(512),prompt:'\0'.repeat(6000)};
  const maximumTextBytes=6*(512+6000+4*(150+5000));assert.equal(maximumTextBytes,162672);
  const metadataBytes=bytes(f.slot)-maximumTextBytes;
  assert.ok(metadataBytes>0&&metadataBytes<8192);assert.ok(bytes(f.slot)<LOCAL_SHOT_TEXT_LIMITS.rowBytes);
  assert.ok(schemas.slot.safeParse(f.slot).success);
  const envelope={...f.envelope,...f.slot};assert.ok(schemas.envelope.safeParse(envelope).success);
  assert.equal(LOCAL_SHOT_TEXT_LIMITS.rowBytes,256*1024);assert.equal(LOCAL_SHOT_TEXT_LIMITS.httpBytes,256*1024);
  assert.equal(LOCAL_SHOT_TEXT_LIMITS.envelopeBytes,16*1024*1024);
  // Aggregate bytes, not merely slot count, are independently enforced. This is
  // intentionally full, so no existing slot may be silently evicted to admit it.
  const entries=Array.from({length:128},()=>{const slot=copy(f.slot);slot.projectId=randomUUID();slot.shotId=randomUUID();slot.intent.input.shotId=slot.shotId;return slot;});
  const disk={version:1,workspaceScope:f.authority.workspaceScope,entries};
  assert.ok(bytes(disk)>LOCAL_SHOT_TEXT_LIMITS.envelopeBytes);rejects(schemas.disk,disk);
  assert.ok(schemas.disk.safeParse({...disk,entries:entries.slice(0,96)}).success);
});

test('narrow original receipt guard binds project, shot, exact next revision and both aftertexts',()=>{
  for(const f of [fixture(),fixture({raw:{title:'Saved title',prompt:''},patch:{prompt:''}})]){
    const response=receipt(f),original=JSON.stringify(response),envelope=appliedEnvelope(f,response);
    assert.ok(isLocalMutationResponse('shot.update',f.input,response,{projectId:f.projectId}));
    assert.ok(isLocalShotTextMutationResponse(f.projectId,f.intent as never,response));
    const parsed=schemas.execution.parse({envelope,response});assert.equal(parsed.response,response);assert.equal(JSON.stringify(parsed.response),original);
    for(const patch of [{id:randomUUID()},{projectId:randomUUID()},{revision:4},{revision:6},{title:'Unrelated title'},
      {prompt:'Unrelated prompt'},{prompt:undefined},{title:undefined}]){
      const forged: Record<string, unknown>={...response,...patch};assert.equal(isLocalShotTextMutationResponse(f.projectId,f.intent as never,forged),false);
      rejects(schemas.execution,{envelope,response:forged});
    }
    assert.equal(isLocalShotTextMutationResponse(randomUUID(),f.intent as never,response),false);
    const inherited=Object.create(response);assert.equal(isLocalShotTextMutationResponse(f.projectId,f.intent as never,inherited),false);
    const {prompt:ignored,...missing}=response;void ignored;assert.equal(isLocalShotTextMutationResponse(f.projectId,f.intent as never,missing),false);
    rejects(schemas.execution,{envelope:f.envelope,response});
    assert.equal(JSON.stringify(response),original);
  }
});

test('response and execution bounds are independent, explicit unknown/null, with historical receipt bytes unchanged',()=>{
  const f=fixture(),response={...receipt(f),padding:''};
  response.padding='x'.repeat(LOCAL_SHOT_TEXT_LIMITS.shotResponseBytes-bytes(response));
  assert.equal(bytes(response),1024*1024);assert.ok(isLocalShotTextMutationResponse(f.projectId,f.intent as never,response));
  const envelope=appliedEnvelope(f,response);assert.ok(schemas.execution.safeParse({envelope,response}).success);
  const tooLarge={...response,padding:response.padding+'x'};assert.equal(isLocalShotTextMutationResponse(f.projectId,f.intent as never,tooLarge),false);
  rejects(schemas.execution,{envelope,response:tooLarge});
  assert.equal(LOCAL_SHOT_TEXT_LIMITS.executeResponseBytes,LOCAL_SHOT_TEXT_LIMITS.shotResponseBytes+LOCAL_SHOT_TEXT_LIMITS.httpBytes);
  assert.ok(schemas.execution.safeParse({envelope:f.envelope,response:null}).success);
  assert.ok(schemas.execution.safeParse({envelope,response:null}).success);
  rejects(schemas.execution,{envelope:f.envelope});rejects(schemas.execution,{envelope:f.envelope,response:undefined});
  rejects(schemas.execution,{envelope:f.envelope,response:null,operation:'shot.update'});
});

test('restored workspace unsupported is explicit and cannot expose inferred authority or companion contents',()=>{
  const unsupported={supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'};
  assert.deepEqual(schemas.envelope.parse(unsupported),unsupported);
  assert.deepEqual(schemas.execution.parse({envelope:unsupported,response:null}),{envelope:unsupported,response:null});
  rejects(schemas.envelope,{...unsupported,workspaceScope:'a'.repeat(64)});
  rejects(schemas.execution,{envelope:unsupported,response:{}});
  const f=fixture();rejects(schemas.envelope,{...f.envelope,draftTargetStatus:'unset'});rejects(schemas.envelope,{...f.envelope,intentTargetStatus:'unset'});
  const empty={...f.envelope,draftRevision:0,draft:null,intentRevision:0,intent:null,draftTargetStatus:'unset',intentTargetStatus:'unset',projectPendingIntent:null};
  assert.deepEqual(schemas.envelope.parse(empty),empty);
});
