import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
 schemas,parse,INPUT_PROFILE_VERSION,FRAME_PAIR_PROFILE_VERSION,SUBJECT_REFERENCE_PROFILE_VERSION,
 CAPABILITY_PROFILES,ARCHIVED_CAPABILITY_PROFILES,getCapabilityProfile,getLegacyCapabilityProfile,
 validateGenerationInput,buildAdapterPlan,getGenerationIssue,getGenerationProfileIssue,
 SUBJECT_GENERATION_KINDS,subjectReferenceSchema,isSubjectReference,getSubjectGenerationSnapshotIssue,isSubjectGenerationResponse,isSubjectGenerationRetryResponse,
 FRAME_PROFILE_ID,FRAME_SELECTION_RULE,
} from '../packages/contracts/src/index.mjs';

const id=()=>randomUUID(),hash='a'.repeat(64),date='2026-10-11T00:00:00Z';
const projectId=id(),shotId=id(),subjectId=id(),subjectVersionId=id(),assetId=id();
const reference=()=>({subjectVersionId,subjectName:'Selected character',subjectKind:'character',subjectVersion:{id:subjectVersionId,projectId,subjectId,number:1,assetId,sha256:hash,mimeType:'image/png',width:1024,height:1024,provenance:{kind:'user-import',versionId:null,shotId:null,jobId:null},createdAt:date}});
const profileFor=providerId=>CAPABILITY_PROFILES.find(profile=>profile.providerId===providerId);
const inputFor=(providerId='ark',patch={})=>{const p=profileFor(providerId);return {providerId,model:p.model,region:p.regions[0],prompt:'A character waves.',aspectRatio:'9:16',duration:4,parameters:{},references:[{role:'subject_reference',assetId,mimeType:'image/png',sizeBytes:1024,sha256:hash,width:1024,height:1024}],...patch};};
const capabilitiesFor=(providerId='ark')=>{const p=profileFor(providerId),first=p.inputs.roles.first_frame;return {id:providerId,models:[p.model],inputProfileVersion:INPUT_PROFILE_VERSION,profileEvaluationDate:'2026-10-11',providerRegion:p.regions[0],inputProfiles:[p],modelCapabilities:[{id:p.model,inputModes:p.inputModes,aspectRatios:p.aspectRatios,durations:p.durationsSeconds,promptRequired:p.prompt.required,maxPromptLength:p.prompt.maxCodeUnits,parameters:Object.keys(p.parameters),referenceImages:{min:p.inputs.minReferences,max:p.inputs.maxReferences,mimeTypes:first.mimeTypes,...(first.dimensions?{minDimension:first.dimensions.min,maxDimension:first.dimensions.max,matchAspectRatio:first.dimensions.matchAspectRatio}:{})}}]};};
const snapshotFor=(providerId='ark')=>{const p=profileFor(providerId),input=inputFor(providerId);return {shotId,shotRevision:3,title:'Subject test',prompt:input.prompt,referenceAssetIds:[assetId],referenceAssets:[{id:assetId,role:'subject_reference',mimeType:'image/png',sizeBytes:1024,sha256:hash,width:1024,height:1024}],referenceBindings:[{role:'subject_reference',assetId,sha256:hash}],referenceConnections:[],aspectRatio:input.aspectRatio,duration:input.duration,providerId,model:p.model,parameters:{},capabilities:capabilitiesFor(providerId),inputProfileId:p.profileId,inputProfileVersion:p.profileVersion,providerRegion:p.regions[0],subjectReference:reference()};};
const requestFor=(providerId='ark')=>({shotId,expectedRevision:3,requestId:'subject-video-request',providerId,model:profileFor(providerId).model,subjectVersionId});
const jobFor=(providerId='ark')=>({id:id(),projectId,shotId,requestId:'subject-video-request',providerId,model:profileFor(providerId).model,revision:1,status:'queued',phase:'waiting',progress:0,snapshot:snapshotFor(providerId),providerJobId:null,submissionCount:0,error:null,createdAt:date,updatedAt:date,versionId:null,cancelScope:null,retryOfJobId:null,allowedActions:['cancel']});
const clone=structuredClone;

test('generation.submit adds only a truly optional version UUID and preserves omitted input byte shape',()=>{
 const input=requestFor(),{subjectVersionId,...legacy}=input;
 assert.deepEqual(parse('generation.submit',legacy),legacy);assert.equal(Object.hasOwn(parse('generation.submit',legacy),'subjectVersionId'),false);
 assert.deepEqual(parse('generation.submit',input),input);
 for(const subjectVersionId of [null,'',assetId+'x',[],{}])assert.equal(schemas['generation.submit'].safeParse({...input,subjectVersionId}).success,false);
 for(const patch of [{subjectReference:reference()},{sha256:hash},{assetId},{referenceBindings:[]},{subjectKind:'character'},{subjectVersion:{}}])assert.equal(schemas['generation.submit'].safeParse({...input,...patch}).success,false);
});

test('the new immutable subject reference retains the entire strict version and typed provenance',()=>{
 assert.deepEqual(SUBJECT_GENERATION_KINDS,['character','product','location']);
 for(const subjectKind of SUBJECT_GENERATION_KINDS)assert.equal(isSubjectReference({...reference(),subjectKind}),true);
 for(const patch of [{subjectKind:'look'},{subjectKind:'style'},{subjectVersionId:id()},{subjectName:' '},{subjectName:'x'.repeat(121)},{extra:true}])assert.equal(isSubjectReference({...reference(),...patch}),false);
 for(const key of Object.keys(reference().subjectVersion)){const value=reference();delete value.subjectVersion[key];assert.equal(subjectReferenceSchema.safeParse(value).success,false,key);}
 const image=reference();image.subjectVersion.provenance={kind:'generated',versionId:null,shotId:null,jobId:null,imageSource:{imageGroupId:id(),imageTaskId:id(),imageVersionId:id()}};assert.equal(isSubjectReference(image),true);
 const frame=reference();frame.subjectVersion.provenance={kind:'extracted-frame',versionId:null,shotId:null,jobId:null,frameSource:{frameTaskId:id(),sourceAssetId:id(),sourceHash:hash,sourceFrame:25,fps:30,profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE}};assert.equal(isSubjectReference(frame),true);
 const invalid=clone(frame);delete invalid.subjectVersion.provenance.frameSource;assert.equal(isSubjectReference(invalid),false);
 invalid.subjectVersion.provenance={...image.subjectVersion.provenance,frameSource:frame.subjectVersion.provenance.frameSource};assert.equal(isSubjectReference(invalid),false);
});

test('v3 activates only Mock and Ark, keeps exact v1/v2 archived resolution, and never upgrades a pin',()=>{
 for(const providerId of ['ark','mock']){
  const active=profileFor(providerId);assert.equal(active.profileVersion,SUBJECT_REFERENCE_PROFILE_VERSION);assert.match(active.profileId,/:v3$/);assert.ok(Object.isFrozen(active.inputs.roles.subject_reference));
  assert.deepEqual(active.inputs.combinations,[[],['first_frame'],['first_frame','last_frame'],['subject_reference']]);
  assert.equal(active.liveVerified,false);
  for(const [number,version] of [[1,INPUT_PROFILE_VERSION],[2,FRAME_PAIR_PROFILE_VERSION]]){
   const old=getCapabilityProfile(providerId,active.model,active.regions[0],{profileId:`${providerId}:${active.model}:v${number}`,profileVersion:version});
   assert.ok(ARCHIVED_CAPABILITY_PROFILES.includes(old));assert.equal(old.inputs.roles.subject_reference.implemented,false);
   assert.equal(old.inputs.roles.last_frame.implemented,number===2);
   assert.equal(validateGenerationInput(inputFor(providerId),{profileId:old.profileId,profileVersion:old.profileVersion}).ok,false);
   if(number===1)assert.equal(getLegacyCapabilityProfile(providerId,active.model,active.regions[0]),old);
  }
  assert.equal(getCapabilityProfile(providerId,active.model,active.regions[0],{profileId:active.profileId,profileVersion:FRAME_PAIR_PROFILE_VERSION}),null);
 }
 for(const p of CAPABILITY_PROFILES.filter(p=>!['ark','mock'].includes(p.providerId))){assert.equal(p.profileVersion,INPUT_PROFILE_VERSION);assert.equal(p.inputs.roles.subject_reference.implemented,false);}
});

test('Ark subject input aspect is independent while PNG/JPEG bytes, sides and aspect envelope are exact',()=>{
 const input=inputFor(),ref=input.references[0],validate=(patch={},root={})=>validateGenerationInput({...input,...root,references:[{...ref,...patch}]}).ok;
 for(const aspectRatio of ['9:16','16:9'])for(const duration of [4,8])assert.equal(validate({}, {aspectRatio,duration}),true);
 for(const mimeType of ['image/png','image/jpeg'])assert.equal(validate({mimeType,sizeBytes:10*1024*1024}),true);
 for(const [width,height] of [[300,300],[6000,6000],[400,1000],[1000,400]])assert.equal(validate({width,height}),true);
 for(const patch of [{mimeType:'image/webp'},{sizeBytes:10*1024*1024+1},{width:299},{height:6001},{width:399,height:1000},{width:1001,height:400}])assert.equal(validate(patch),false,JSON.stringify(patch));
 for(const root of [{aspectRatio:'1:1'},{duration:2},{duration:6}])assert.equal(validate({},root),false);
});

test('Mock subject image restrictions are new and do not relax or tighten its existing first-frame route',()=>{
 const input=inputFor('mock'),ref=input.references[0];
 assert.equal(validateGenerationInput(input).ok,true);
 for(const patch of [{mimeType:'image/webp'},{sizeBytes:10*1024*1024+1}])assert.equal(validateGenerationInput({...input,references:[{...ref,...patch}]}).ok,false);
 assert.equal(validateGenerationInput({...input,references:[{...ref,role:'first_frame',mimeType:'image/webp',sizeBytes:30*1024*1024}]}).ok,true);
 assert.equal(profileFor('mock').output.depictsPromptOrReferences,false);
});

test('role combinations stay explicit, single-subject only, and the v3 bridge never loses first/last roles',()=>{
 for(const providerId of ['ark','mock']){
  const input=inputFor(providerId),subject=input.references[0],first={...subject,role:'first_frame',width:720,height:1280},last={...first,role:'last_frame',assetId:id()};
  for(const references of [[subject,first],[subject,last],[subject,{...subject,assetId:id()}],[last],[first,{...first,assetId:id()}],[last,first]])assert.equal(buildAdapterPlan({...input,references}).ok,false);
  for(const references of [[],[first],[first,last],[subject]]){
   const result=buildAdapterPlan({...input,references});assert.equal(result.ok,true);
   assert.deepEqual(result.adapterSnapshot.referenceAssets.map(asset=>asset.role),references.map(ref=>ref.role));
  }
  if(providerId==='ark')assert.equal(validateGenerationInput({...input,references:[{...subject,role:'first_frame'}]}).ok,false,'Square first-frame stays prohibited');
  const old=getLegacyCapabilityProfile(providerId,input.model,input.region),legacy=buildAdapterPlan({...input,references:[first]},{profileId:old.profileId,profileVersion:old.profileVersion});
  assert.equal(Object.hasOwn(legacy.adapterSnapshot.referenceAssets[0],'role'),false);
 }
});

test('strict frozen manifest rejects partial, mixed, mismatched and unpinned subject claims without fallback',()=>{
 const original=snapshotFor();assert.equal(getSubjectGenerationSnapshotIssue(original,{projectId,requireProfilePin:true}),null);
 const changes=[value=>delete value.subjectReference,value=>delete value.subjectReference.subjectVersion.provenance,value=>value.subjectReference.subjectKind='look',value=>value.subjectReference.subjectVersionId=id(),value=>value.referenceAssetIds=[],value=>value.referenceAssetIds.push(id()),value=>value.referenceAssets=[],value=>delete value.referenceAssets[0].role,value=>value.referenceAssets[0].sha256='b'.repeat(64),value=>value.referenceAssets[0].width=600,value=>delete value.referenceAssets[0].sizeBytes,value=>value.referenceBindings=[],value=>value.referenceBindings[0].role='first_frame',value=>value.referenceBindings[0].sha256='b'.repeat(64),value=>value.referenceBindings[0].extra=true,value=>value.referenceConnections=[{role:'first_frame',sourceAssetId:assetId}],value=>value.lastFrameAssetId=id(),value=>value.inputProfileVersion=FRAME_PAIR_PROFILE_VERSION,value=>delete value.providerRegion];
 for(const change of changes){const candidate=clone(original);change(candidate);assert.ok(getSubjectGenerationSnapshotIssue(candidate,{projectId,requireProfilePin:true}),String(change));}
 assert.ok(getSubjectGenerationSnapshotIssue(original,{projectId:id()}));
 const unpinned=clone(original);for(const key of ['inputProfileVersion','inputProfileId','providerRegion'])delete unpinned[key];
 assert.equal(getSubjectGenerationSnapshotIssue(unpinned,{projectId}),null);assert.ok(getSubjectGenerationSnapshotIssue(unpinned,{projectId,requireProfilePin:true}));
 const legacy={referenceAssetIds:[],referenceAssets:[]};assert.equal(getSubjectGenerationSnapshotIssue(legacy),null);assert.deepEqual(legacy,{referenceAssetIds:[],referenceAssets:[]});
});

test('shared snapshot checks permit square subject references and retain strict frame metadata and profile gates',()=>{
 const subject=snapshotFor(),caps=capabilitiesFor(),{inputProfiles,...legacyCaps}=caps;
 assert.equal(getGenerationIssue(subject,caps),null);assert.equal(getGenerationIssue(subject,legacyCaps),null);assert.equal(getGenerationProfileIssue(subject,caps),null);
 const frame=clone(subject);delete frame.subjectReference;frame.referenceBindings[0].role='first_frame';frame.referenceAssets[0].role='first_frame';
 assert.equal(getGenerationIssue(frame,caps).code,'UNSUPPORTED_INPUT');
 const missing=clone(frame);delete missing.referenceAssets[0].role;assert.ok(getGenerationProfileIssue(missing,caps));
 const planning=clone(subject);for(const key of ['inputProfileVersion','inputProfileId','providerRegion'])delete planning[key];assert.equal(getGenerationIssue(planning,legacyCaps),null);
});

test('subject ACK is operation-bound, strict and matches the full expected frozen reference on progressed records',()=>{
 for(const providerId of ['ark','mock']){
  const input=requestFor(providerId),job=jobFor(providerId),options={projectId,subjectReference:reference()};
  assert.equal(isSubjectGenerationResponse('generation.submit',input,job,options),true);
  assert.equal(isSubjectGenerationResponse('job.retry',input,job,options),false);
  const {subjectVersionId,...legacy}=input;assert.equal(isSubjectGenerationResponse('generation.submit',legacy,job,options),false);
  for(const status of ['queued','submitting','running','downloading','submission_unknown','failed','cancelled','succeeded']){
   const progressed={...job,status,revision:5,phase:'progressed',nextPollAt:0,allowedActions:status==='failed'?['retry']:status==='submission_unknown'?['reconcile','cancel']:status==='cancelled'?['reconcile']:status==='succeeded'?[]:['cancel']};
   assert.equal(isSubjectGenerationResponse('generation.submit',input,progressed,options),true,status);
  }
  for(const patch of [{requestId:'different-request'},{shotId:id()},{projectId:id()},{providerId:'veo'},{model:'other'},{retryOfJobId:id()},{status:'bogus'},{extra:true},{progress:NaN},{revision:0},{allowedActions:[]}])assert.equal(isSubjectGenerationResponse('generation.submit',input,{...job,...patch},options),false,JSON.stringify(patch));
  for(const change of [value=>value.snapshot.shotRevision++,value=>value.snapshot.subjectReference.subjectVersionId=id(),value=>value.snapshot.subjectReference.subjectName='Changed label',value=>value.snapshot.subjectReference.subjectVersion.number++,value=>value.snapshot.subjectReference.subjectVersion.sha256='b'.repeat(64),value=>value.snapshot.subjectReference.subjectVersion.provenance.kind='export']){
   const candidate=clone(job);change(candidate);assert.equal(isSubjectGenerationResponse('generation.submit',input,candidate,options),false,String(change));
  }
  assert.equal(isSubjectGenerationResponse('generation.submit',input,job,{projectId:id()}),false);
 }
});

test('ACK checks supplied parameter overrides without inferring omitted values or changing input',()=>{
 const job=jobFor('mock'),input={...requestFor('mock'),parameters:{scenario:'failure'}},before=clone(input);
 assert.equal(isSubjectGenerationResponse('generation.submit',input,job),false);
 job.snapshot.parameters={scenario:'failure',delayMs:100};assert.equal(isSubjectGenerationResponse('generation.submit',input,job),true);assert.deepEqual(input,before);
 const {model,...defaultModel}=requestFor('mock');assert.equal(isSubjectGenerationResponse('generation.submit',defaultModel,job),true);
});

test('subject ACK revalidates the exact Ark profile prompt without accepting blank or oversized text',()=>{
 const input=requestFor('ark');
 for(const prompt of ['', ' '.repeat(2), 'x'.repeat(1001)]){
  const job=jobFor('ark');job.snapshot.prompt=prompt;
  assert.equal(isSubjectGenerationResponse('generation.submit',input,job),false,`Ark prompt length ${prompt.length}`);
 }
});

test('subject ACK revalidates exact profile parameter keys, enum values and integer ranges',()=>{
 const input=requestFor('ark');
 for(const parameters of [{scenario:'success'},{delayMs:0},{seed:0},{seed:4294967295}]){
  const job=jobFor('ark');job.snapshot.parameters=parameters;
  assert.equal(isSubjectGenerationResponse('generation.submit',input,job),false,JSON.stringify(parameters));
 }
 const mockInput=requestFor('mock');
 for(const parameters of [{seed:Number.MIN_SAFE_INTEGER},{seed:Number.MAX_SAFE_INTEGER},{delayMs:0},{delayMs:120000},{scenario:'success'}]){
  const job=jobFor('mock');job.snapshot.parameters=parameters;job.snapshot.prompt='';
  assert.equal(isSubjectGenerationResponse('generation.submit',mockInput,job),true,JSON.stringify(parameters));
 }
 for(const parameters of [{seed:Number.MIN_SAFE_INTEGER-1},{seed:Number.MAX_SAFE_INTEGER+1},{seed:0.5},{delayMs:-1},{delayMs:120001},{scenario:'invented'},{unknown:true}]){
  const job=jobFor('mock');job.snapshot.parameters=parameters;
  assert.equal(isSubjectGenerationResponse('generation.submit',mockInput,job),false,JSON.stringify(parameters));
 }
});

test('frozen subject manifests require an explicit own empty connection array without changing legacy or planning',()=>{
 const missing=snapshotFor();delete missing.referenceConnections;
 assert.ok(getSubjectGenerationSnapshotIssue(missing,{projectId,requireProfilePin:true}));
 assert.equal(getSubjectGenerationSnapshotIssue(missing,{projectId}),null);
 for(const referenceConnections of [undefined,null,[{role:'first_frame',sourceAssetId:assetId}],new Array(1)])assert.ok(getSubjectGenerationSnapshotIssue({...snapshotFor(),referenceConnections},{projectId,requireProfilePin:true}));
 let reads=0;const getter=snapshotFor();Object.defineProperty(getter,'referenceConnections',{enumerable:true,get(){reads++;throw Error('must not read');}});
 assert.ok(getSubjectGenerationSnapshotIssue(getter,{projectId,requireProfilePin:true}));assert.equal(reads,0);
 assert.equal(getSubjectGenerationSnapshotIssue({referenceAssetIds:[],referenceAssets:[]},{requireProfilePin:true}),null);
});

test('subject retry ACK binds the original job and request without admitting a retry as a new submit',()=>{
 for(const providerId of ['ark','mock']){
  const old=jobFor(providerId),input={jobId:old.id,requestId:'new-subject-retry'},retry={...clone(old),id:id(),requestId:input.requestId,retryOfJobId:old.id};
  const options={projectId,snapshot:old.snapshot,subjectReference:old.snapshot.subjectReference},before=JSON.stringify({input,retry,options});
  assert.equal(isSubjectGenerationRetryResponse(input,retry,options),true);
  assert.equal(isSubjectGenerationRetryResponse(input,retry),true,'Context-free client can verify complete returned retry identity');
  assert.equal(isSubjectGenerationResponse('generation.submit',{...requestFor(providerId),requestId:input.requestId},retry),false);
  assert.equal(JSON.stringify({input,retry,options}),before);
  for(const status of ['queued','submitting','running','downloading','submission_unknown','failed','cancelled','succeeded']){
   const result={...retry,status,revision:5,allowedActions:status==='failed'?['retry']:status==='submission_unknown'?['reconcile','cancel']:status==='cancelled'?['reconcile']:status==='succeeded'?[]:['cancel']};
   assert.equal(isSubjectGenerationRetryResponse(input,result,options),true,status);
  }
  for(const badInput of [{...input,jobId:id()},{...input,requestId:'wrong-request'},{...input,subjectVersionId},{...input,snapshot:old.snapshot},{jobId:old.id},null])assert.equal(isSubjectGenerationRetryResponse(badInput,retry,options),false);
  for(const patch of [{id:old.id},{retryOfJobId:null},{retryOfJobId:id()},{requestId:'wrong-request'},{projectId:id()},{snapshot:null},{extra:true}])assert.equal(isSubjectGenerationRetryResponse(input,{...retry,...patch},options),false,JSON.stringify(patch));
  assert.equal(isSubjectGenerationRetryResponse(input,retry,{...options,projectId:id()}),false);
  assert.equal(isSubjectGenerationRetryResponse(input,retry,{...options,snapshot:undefined}),false);
 }
});

test('subject retry ACK cannot replace a pinned public snapshot with internally consistent new sources or options',()=>{
 const old=jobFor('mock'),input={jobId:old.id,requestId:'pinned-subject-retry'},retry={...clone(old),id:id(),requestId:input.requestId,retryOfJobId:old.id};
 const options={projectId,snapshot:old.snapshot,subjectReference:old.snapshot.subjectReference};
 const changes=[
  value=>{value.snapshot.prompt='Changed words';},
  value=>{value.snapshot.parameters={scenario:'failure'};},
  value=>{value.snapshot.shotRevision++;},
  value=>{value.shotId=id();value.snapshot.shotId=value.shotId;},
  value=>{value.snapshot.subjectReference.subjectName='Changed label';},
  value=>{const version=value.snapshot.subjectReference.subjectVersion;version.assetId=id();version.sha256='b'.repeat(64);value.snapshot.referenceAssetIds=[version.assetId];Object.assign(value.snapshot.referenceAssets[0],{id:version.assetId,sha256:version.sha256});Object.assign(value.snapshot.referenceBindings[0],{assetId:version.assetId,sha256:version.sha256});},
  value=>{const version=value.snapshot.subjectReference.subjectVersion;version.id=id();value.snapshot.subjectReference.subjectVersionId=version.id;},
 ];
 for(const change of changes){const result=clone(retry);change(result);assert.equal(isSubjectGenerationRetryResponse(input,result,options),false,String(change));}
 const reordered=Object.fromEntries(Object.entries(old.snapshot).reverse());assert.equal(isSubjectGenerationRetryResponse(input,retry,{...options,snapshot:reordered}),true,'Key ordering does not change frozen content');
});

test('subject retry ACK rejects missing markers, old profile promotion, partial manifests and hostile JSON',()=>{
 const old=jobFor(),input={jobId:old.id,requestId:'strict-subject-retry'},retry={...clone(old),id:id(),requestId:input.requestId,retryOfJobId:old.id},options={projectId,snapshot:old.snapshot};
 for(const change of [value=>delete value.snapshot.subjectReference,value=>{delete value.snapshot.subjectReference;value.snapshot.referenceAssets[0].role='first_frame';value.snapshot.referenceBindings[0].role='first_frame';},value=>delete value.snapshot.referenceAssets[0].role,value=>delete value.snapshot.referenceConnections,value=>{value.snapshot.inputProfileVersion=FRAME_PAIR_PROFILE_VERSION;value.snapshot.inputProfileId=value.snapshot.inputProfileId.replace(':v3',':v2');},value=>{value.snapshot.inputProfileVersion=INPUT_PROFILE_VERSION;value.snapshot.inputProfileId=value.snapshot.inputProfileId.replace(':v3',':v1');}]){
  const result=clone(retry);change(result);assert.equal(isSubjectGenerationRetryResponse(input,result,options),false);assert.equal(isSubjectGenerationRetryResponse(input,result),false);
 }
 let reads=0;const getter=clone(retry);Object.defineProperty(getter,'snapshot',{enumerable:true,get(){reads++;throw Error('accessor evaluated');}});assert.equal(isSubjectGenerationRetryResponse(input,getter,options),false);
 const cycle=clone(retry);cycle.snapshot.capabilities.cycle=cycle;assert.equal(isSubjectGenerationRetryResponse(input,cycle,options),false);
 for(const result of [null,'{}',[],{requestId:input.requestId,retryOfJobId:input.jobId}])assert.equal(isSubjectGenerationRetryResponse(input,result,options),false);
 assert.equal(reads,0);
});

test('subject guards reject hostile records and arrays without evaluating accessors',()=>{
 let reads=0;
 const getter=reference();Object.defineProperty(getter.subjectVersion,'sha256',{enumerable:true,get(){reads++;throw Error('accessor evaluated');}});
 assert.equal(isSubjectReference(getter),false);
 const snapshot=snapshotFor();snapshot.subjectReference=getter;assert.ok(getSubjectGenerationSnapshotIssue(snapshot));
 const job=jobFor();Object.defineProperty(job.snapshot.referenceAssets[0],'role',{enumerable:true,get(){reads++;throw Error('accessor evaluated');}});
 assert.equal(isSubjectGenerationResponse('generation.submit',requestFor(),job),false);
 const sparse=jobFor();sparse.snapshot.referenceAssets=new Array(1);assert.equal(isSubjectGenerationResponse('generation.submit',requestFor(),sparse),false);
 const cycle=jobFor();cycle.snapshot.capabilities.cycle=cycle;assert.equal(isSubjectGenerationResponse('generation.submit',requestFor(),cycle),false);
 assert.equal(reads,0);
});
