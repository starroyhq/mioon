import test from 'node:test';
import assert from 'node:assert/strict';
import {schemas,parse,INPUT_PROFILE_VERSION,FRAME_PAIR_PROFILE_VERSION,GENERATION_INPUT_PROFILES,ARCHIVED_CAPABILITY_PROFILES,getCapabilityProfile,getLegacyCapabilityProfile,validateGenerationInput,buildAdapterPlan,getGenerationProfileIssue,getGenerationIssue,findModelCapabilities,isReferenceShotRecord,isReferenceMutationResponse,isLocalMutationResponse,getShotGenerationReferenceSelection} from '../packages/contracts/src/index.mjs';
const ids=Array.from({length:8},(_,index)=>`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`);
const asOf='2026-10-11';
const asset=(id=ids[0],patch={})=>({id,mimeType:'image/png',sizeBytes:1024,sha256:(id===ids[0]?'a':'b').repeat(64),width:720,height:1280,...patch});
const ref=(role='first_frame',id=ids[0],patch={})=>{const {id:assetId,...metadata}=asset(id);return {role,assetId,...metadata,...patch};};
const profileFor=id=>GENERATION_INPUT_PROFILES.find(profile=>profile.providerId===id);
const input=(providerId='ark',patch={})=>{const p=profileFor(providerId);return {providerId,model:p.model,region:p.regions[0],prompt:'A quiet scene',aspectRatio:'9:16',duration:4,parameters:{},references:[ref()],...patch};};
const pin=profile=>({profileId:profile.profileId,profileVersion:profile.profileVersion});
const codes=result=>result.issues.map(issue=>issue.code);
const capabilities=providerId=>{const p=profileFor(providerId);return {id:providerId,models:[p.model],providerRegion:p.regions[0],inputProfileVersion:INPUT_PROFILE_VERSION,inputProfiles:[p],profileEvaluationDate:asOf,modelCapabilities:[{id:p.model,inputModes:p.inputModes,aspectRatios:p.aspectRatios,durations:p.durationsSeconds,referenceImages:{min:p.inputs.minReferences,max:p.inputs.maxReferences}}]};};
const snapshot=(providerId='ark',pair=true)=>{const p=profileFor(providerId),assets=pair?[asset(ids[0],{role:'first_frame'}),asset(ids[1],{role:'last_frame'})]:[asset()];return {model:p.model,prompt:'A quiet scene',aspectRatio:'9:16',duration:4,parameters:{},referenceAssetIds:assets.map(a=>a.id),referenceAssets:assets,...(pair?{lastFrameAssetId:ids[1],referenceBindings:assets.map(a=>({assetId:a.id,role:a.role,sha256:a.sha256}))}:{})};};
const shot=()=>({id:ids[2],projectId:ids[3],title:'Shot',prompt:'',referenceAssetIds:[ids[0]],aspectRatio:'9:16',duration:4,parameters:{},position:{x:0,y:0},orderIndex:0,revision:2,selectedVersionId:null,createdAt:'2026-10-10T00:00:00.000Z',updatedAt:'2026-10-10T00:00:00.000Z'});

test('optional last frame preserves omitted shape and explicitly records null without changing first-edge DTOs',()=>{
 const create={projectId:ids[3],title:'Shot'},update={shotId:ids[2],expectedRevision:1,patch:{title:'Changed'}};
 assert.deepEqual(parse('shot.create',create),create);
 assert.deepEqual(parse('shot.update',update),update);
 for(const lastFrameAssetId of [null,ids[1]]){
  assert.deepEqual(parse('shot.create',{...create,lastFrameAssetId}),{...create,lastFrameAssetId});
  assert.deepEqual(parse('shot.update',{...update,patch:{lastFrameAssetId}}).patch,{lastFrameAssetId});
 }
 for(const value of ['',1,false,{},'not-a-uuid'])assert.equal(schemas['shot.create'].safeParse({...create,lastFrameAssetId:value}).success,false);
 const attach={projectId:ids[3],sourceNodeId:ids[4],targetShotId:ids[2],expectedSourceRevision:1,expectedShotRevision:1,requestId:'reference-request',role:'first_frame'};
 assert.equal(schemas['reference.attach'].safeParse(attach).success,true);
 assert.equal(schemas['reference.attach'].safeParse({...attach,role:'last_frame'}).success,false);
 assert.equal(schemas['reference.attach'].safeParse({...attach,lastFrameAssetId:ids[1]}).success,false);
});

test('strict historical acknowledgements accept only the optional tail and preserve every old byte',()=>{
 const old=shot(),before=JSON.stringify(old);
 assert.equal(isReferenceShotRecord(old),true);assert.equal(JSON.stringify(old),before);assert.equal(Object.hasOwn(old,'lastFrameAssetId'),false);
 for(const lastFrameAssetId of [null,ids[1]])assert.equal(isReferenceShotRecord({...old,lastFrameAssetId}),true);
 for(const patch of [{lastFrameAssetId:undefined},{lastFrameAssetId:'wrong'},{lastFrameAssetId:ids[1],other:true}])assert.equal(isReferenceShotRecord({...old,...patch}),false);
 const edge={id:ids[5],projectId:ids[3],source:ids[4],target:ids[2],kind:'reference',role:'first_frame',sourceAssetId:ids[0],createdAt:old.createdAt};
 const attach={projectId:ids[3],sourceNodeId:ids[4],targetShotId:ids[2],expectedSourceRevision:1,expectedShotRevision:1,requestId:'reference-request',role:'first_frame'};
 assert.equal(isReferenceMutationResponse('reference.attach',attach,{edge,shot:{...old,lastFrameAssetId:ids[1]}}),true);
 const detach={projectId:ids[3],edgeId:ids[5],expectedShotRevision:2,requestId:'reference-detach'};
 assert.equal(isReferenceMutationResponse('reference.detach',detach,{edge,shot:{...old,revision:3,referenceAssetIds:[],lastFrameAssetId:ids[1]},detached:true}),true);
});

test('new-shot selection appends an explicit tail without reinterpreting historical first-only arrays',()=>{
 const old={referenceAssetIds:[ids[0]]};
 assert.deepEqual(getShotGenerationReferenceSelection(old).references,[{role:'first_frame',assetId:ids[0]}]);
 assert.deepEqual(getShotGenerationReferenceSelection({...old,lastFrameAssetId:null}).references,[{role:'first_frame',assetId:ids[0]}]);
 const result=getShotGenerationReferenceSelection({...old,lastFrameAssetId:ids[1]});
 assert.equal(result.ok,true);assert.deepEqual(result.references,[{role:'first_frame',assetId:ids[0]},{role:'last_frame',assetId:ids[1]}]);assert.ok(Object.isFrozen(result.references[1]));
 const historical=getShotGenerationReferenceSelection({referenceAssetIds:[ids[0],ids[1]]});
 assert.equal(historical.ok,true);assert.deepEqual(historical.references.map(ref=>ref.role),['first_frame','first_frame']);
 assert.equal(getShotGenerationReferenceSelection({referenceAssetIds:[],lastFrameAssetId:ids[1]}).ok,false);
 assert.equal(getShotGenerationReferenceSelection({...old,lastFrameAssetId:ids[0]}).issues[0].code,'DUPLICATE_REFERENCE');
 assert.equal(getShotGenerationReferenceSelection({...old,lastFrameAssetId:undefined}).ok,false);
 assert.equal(getShotGenerationReferenceSelection({referenceAssetIds:null}).ok,false);
});

test('active discovery is unique, exact archived v1 profiles remain immutable, and pin misses never fall back',()=>{
 assert.equal(GENERATION_INPUT_PROFILES.length,6);assert.equal(ARCHIVED_CAPABILITY_PROFILES.length,2);
 for(const p of GENERATION_INPUT_PROFILES){
  assert.equal(GENERATION_INPUT_PROFILES.filter(other=>other.providerId===p.providerId&&other.model===p.model).length,1);
  const old=getLegacyCapabilityProfile(p.providerId,p.model,p.regions[0]);
  assert.equal(old.profileVersion,'mioon-input-profiles/1');assert.equal(old.inputs.maxReferences,1);assert.equal(old.inputs.roles.last_frame.implemented,false);
  assert.equal(getCapabilityProfile(p.providerId,p.model,p.regions[0],pin(old)),old);
  assert.equal(getCapabilityProfile(p.providerId,p.model,p.regions[0],{profileId:p.profileId}),null);
  assert.equal(getCapabilityProfile(p.providerId,p.model,p.regions[0],{...pin(p),extra:true}),null);
  assert.equal(getCapabilityProfile(p.providerId,p.model,p.regions[0],{profileId:p.profileId,profileVersion:'future'}),null);
  assert.equal(p.profileVersion,['ark','mock'].includes(p.providerId)?FRAME_PAIR_PROFILE_VERSION:INPUT_PROFILE_VERSION);
  assert.equal(p.liveVerified,false);assert.ok(Object.isFrozen(p.inputs.combinations));
 }
});

test('legacy no-pin frozen selection and exact pinned v1 plan preserve historical adapter bytes',()=>{
 for(const providerId of ['ark','mock']){
  const request=input(providerId),legacy=getLegacyCapabilityProfile(providerId,request.model,request.region);
  const result=buildAdapterPlan(request,{asOf,...pin(legacy)});
  assert.equal(result.ok,true);assert.equal(result.profileVersion,INPUT_PROFILE_VERSION);
  const {role,assetId,...metadata}=request.references[0];
  assert.equal(JSON.stringify(result.adapterSnapshot),JSON.stringify({model:request.model,prompt:request.prompt,aspectRatio:request.aspectRatio,duration:request.duration,parameters:{},referenceAssets:[{id:assetId,...metadata}]}));
  assert.equal(Object.hasOwn(result.adapterSnapshot.referenceAssets[0],'role'),false);
  assert.equal(buildAdapterPlan({...request,references:[ref(),ref('last_frame',ids[1])]}, {asOf,...pin(legacy)}).ok,false);
  const s=snapshot(providerId,false),caps=capabilities(providerId);
  assert.equal(getGenerationProfileIssue(s,caps),null);
  assert.equal(getGenerationProfileIssue({...s,inputProfileId:legacy.profileId,inputProfileVersion:legacy.profileVersion,providerRegion:request.region,referenceBindings:[{role:'first_frame',assetId:ids[0],sha256:'a'.repeat(64)}]},caps),null);
 }
});

test('only exact active Ark and Mock permit the three complete combinations with explicit canonical roles',()=>{
 for(const p of GENERATION_INPUT_PROFILES){
  const pair=[ref(),ref('last_frame',ids[1])];
  const result=buildAdapterPlan(input(p.providerId,{references:pair}),{asOf});
  assert.equal(result.ok,['ark','mock'].includes(p.providerId));
  if(result.ok){
   assert.equal(result.profileVersion,FRAME_PAIR_PROFILE_VERSION);
   assert.deepEqual(result.referenceBindings.map(r=>r.role),['first_frame','last_frame']);
   assert.deepEqual(result.adapterSnapshot.referenceAssets.map(r=>r.role),['first_frame','last_frame']);
   for(const references of [[],[ref()]])assert.equal(validateGenerationInput(input(p.providerId,{references}),{asOf}).ok,true);
  }
  for(const references of [[ref('last_frame',ids[1])],[ref(),ref('subject_reference',ids[1])],[ref(),ref('style_reference',ids[1])],[ref(),ref('first_frame',ids[1])],[ref(),ref('last_frame',ids[0])]])assert.equal(buildAdapterPlan(input(p.providerId,{references}),{asOf}).ok,false);
 }
 const reversed=buildAdapterPlan(input('ark',{references:[ref('last_frame',ids[1]),ref()]}),{asOf});
 assert.ok(codes(reversed).includes('INVALID_REFERENCE_ORDER'));assert.equal(reversed.adapterSnapshot,undefined);
});

test('each Ark role independently enforces PNG/JPEG, 10 MiB, dimensions and selected exact ratio',()=>{
 const good=[ref(),ref('last_frame',ids[1],{width:900,height:1600})];
 assert.equal(validateGenerationInput(input('ark',{references:good}),{asOf}).ok,true);
 for(const index of [0,1]){
  for(const patch of [{mimeType:'image/webp'},{sizeBytes:10*1024*1024+1},{width:299},{height:6001},{width:721},{sizeBytes:undefined},{sha256:''},{extra:'never silently discarded'}]){
   const references=good.map((reference,i)=>i===index?{...reference,...patch}:reference);
   assert.equal(buildAdapterPlan(input('ark',{references}),{asOf}).ok,false,JSON.stringify({index,patch}));
  }
 }
 const p=profileFor('ark');assert.deepEqual(p.aspectRatios,['9:16','16:9']);assert.deepEqual(p.durationsSeconds,[4,8]);assert.deepEqual(p.output,{resolution:'720p',audio:'disabled'});
});

test('Mock preserves the complete v1 single-input limits, scenarios and simulation flags in v2',()=>{
 const p=profileFor('mock'),old=getLegacyCapabilityProfile('mock',p.model,'local');
 assert.deepEqual(p.inputs.roles.first_frame,old.inputs.roles.first_frame);assert.deepEqual(p.parameters,old.parameters);assert.deepEqual(p.aspectRatios,old.aspectRatios);assert.deepEqual(p.durationsSeconds,old.durationsSeconds);assert.deepEqual(p.output,old.output);
 assert.equal(p.liveVerified,false);assert.equal(p.simulationOnly,true);assert.equal(p.output.depictsPromptOrReferences,false);
 for(const scenario of p.parameters.scenario.values)assert.equal(validateGenerationInput(input('mock',{references:[ref('first_frame',ids[0],{mimeType:'image/webp',sizeBytes:30*1024*1024})],parameters:{scenario}})).ok,true);
});

test('snapshot bridge keeps the full typed pair and first-edge provenance, rejecting malformed pins and unknown role metadata',()=>{
 const s=snapshot(),caps=capabilities('ark'),p=profileFor('ark');
 assert.equal(findModelCapabilities(caps,p.model).referenceImages.max,2);
 assert.equal(getGenerationProfileIssue(s,caps),null);
 assert.equal(getGenerationProfileIssue({...s,referenceConnections:[{role:'first_frame',sourceAssetId:ids[0]}]},caps),null);
 for(const patch of [
  {referenceAssetIds:[ids[0]]},{referenceAssets:[s.referenceAssets[0]]},{referenceBindings:undefined},
  {referenceBindings:s.referenceBindings.map(r=>({...r,extra:true}))},
  {referenceAssets:s.referenceAssets.map(r=>({...r,role:'first_frame'}))},
  {lastFrameAssetId:null},{lastFrameAssetId:ids[5]},
  {inputProfileId:p.profileId},{inputProfileVersion:p.profileVersion},
  {inputProfileId:p.profileId,inputProfileVersion:'future',providerRegion:'cn-beijing'},
  {referenceConnections:[{role:'last_frame',sourceAssetId:ids[1]}]},
  {referenceConnections:[{role:'first_frame',sourceAssetId:ids[1]}]},
 ])assert.ok(getGenerationProfileIssue({...s,...patch},caps),JSON.stringify(patch));
 const full={...s,inputProfileId:p.profileId,inputProfileVersion:p.profileVersion,providerRegion:'cn-beijing'};
 assert.equal(getGenerationProfileIssue(full,caps),null);
 for(const inputProfiles of [[p,p],[p,getLegacyCapabilityProfile('ark',p.model,'cn-beijing')]]){
  assert.ok(getGenerationProfileIssue(s,{...caps,inputProfiles}));
  assert.equal(findModelCapabilities({...caps,inputProfiles},p.model),null);
 }
 for(const options of [{profileId:p.profileId},{profileVersion:p.profileVersion},{...pin(p),extra:true}])assert.equal(validateGenerationInput(input(),options).ok,false);
});

test('selection and canonical validation reject accessors without evaluating them',()=>{
 let reads=0;const first=[];Object.defineProperty(first,'0',{enumerable:true,get(){reads++;throw Error('accessor evaluated');}});
 assert.equal(getShotGenerationReferenceSelection({referenceAssetIds:first}).ok,false);
 const s={referenceAssetIds:[ids[0]]};Object.defineProperty(s,'lastFrameAssetId',{enumerable:true,get(){reads++;throw Error('accessor evaluated');}});
 assert.equal(getShotGenerationReferenceSelection(s).ok,false);
 const r=ref();Object.defineProperty(r,'role',{enumerable:true,get(){reads++;throw Error('accessor evaluated');}});
 assert.equal(validateGenerationInput(input('ark',{references:[r,ref('last_frame',ids[1])]})).ok,false);
 assert.equal(reads,0);
});


test('old first-only calls retain count failure before prompt or advanced-parameter errors',()=>{
 for(const providerId of ['ark','mock']){
  const caps=capabilities(providerId),s=snapshot(providerId,false);
  const old={...s,prompt:'',parameters:{unsupported:true},referenceAssetIds:[ids[0],ids[1]],referenceAssets:[asset(),asset(ids[1])]};
  assert.deepEqual(getGenerationIssue(old,caps),{code:'UNSUPPORTED_INPUT',message:'此模型支持 0–1 张参考图片'});
  const canonical=validateGenerationInput(input(providerId,{references:[ref(),ref('first_frame',ids[1])]}),{asOf});
  assert.equal(canonical.issues[0].code,'INVALID_REFERENCE_COUNT');
 }
});


test('explicit tail mutations require exact owned acknowledgements while legacy callers retain minimum guards',()=>{
 const legacy=shot(),create={projectId:legacy.projectId,title:legacy.title},update={shotId:legacy.id,expectedRevision:1,patch:{title:'Changed'}};
 for(const operation of ['shot.create','shot.update']){
  const base=operation==='shot.create'?create:update;
  for(const lastFrameAssetId of [ids[1],null]){
   const input=operation==='shot.create'?{...base,lastFrameAssetId}:{...base,patch:{lastFrameAssetId}};
   const result={...legacy,lastFrameAssetId};
   assert.equal(isLocalMutationResponse(operation,input,result),true);
   assert.equal(isLocalMutationResponse(operation,input,legacy),false);
   assert.equal(isLocalMutationResponse(operation,input,{...legacy,lastFrameAssetId:undefined}),false);
   assert.equal(isLocalMutationResponse(operation,input,{...legacy,lastFrameAssetId:lastFrameAssetId===null?ids[1]:null}),false);
   assert.equal(isLocalMutationResponse(operation,input,{...legacy,lastFrameAssetId:ids[5]}),false);
   const inherited=Object.assign(Object.create({lastFrameAssetId}),legacy);
   assert.equal(isLocalMutationResponse(operation,input,inherited),false);
   const original=JSON.stringify(result);
   // The current shot may already be at revision 99 with another tail. Neither
   // that state nor the retry time changes the original saved acknowledgement.
   assert.equal(isLocalMutationResponse(operation,input,result,{projectId:legacy.projectId}),true);
   assert.equal(JSON.stringify(result),original);
   assert.equal(isLocalMutationResponse(operation,input,result,{projectId:ids[6]}),false);
  }
  for(const result of [legacy,{...legacy,lastFrameAssetId:null},{...legacy,lastFrameAssetId:ids[5]}])assert.equal(isLocalMutationResponse(operation,base,result),true);
  const badInput=operation==='shot.create'?{...base,lastFrameAssetId:'wrong'}:{...base,patch:{lastFrameAssetId:'wrong'}};
  assert.equal(isLocalMutationResponse(operation,badInput,{...legacy,lastFrameAssetId:'wrong'}),false);
 }
 assert.equal(isLocalMutationResponse('node.update',{nodeId:legacy.id,patch:{lastFrameAssetId:ids[1]}},legacy),true,'new acknowledgement scope is limited to shot operations');
});
