import type {GenerationInputProfile} from '../packages/contracts/src/generation-input-profiles.ts';
import type {AdapterPlanSuccess,AdapterPlanResult,GenerationValidationResult} from '../packages/contracts/src/generation-input-validation.ts';
import type {Provider} from '../packages/business/src/provider-registry.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INPUT_PROFILE_VERSION, GENERATION_INPUT_PROFILES, GENERATION_INPUT_ROLES, ARCHIVED_CAPABILITY_PROFILES, FRAME_PAIR_PROFILE_VERSION, SUBJECT_REFERENCE_PROFILE_VERSION,
  getCapabilityProfile, getGenerationProfileRegion, validateGenerationInput,
  buildAdapterPlan, encodedImageDataUriBytes, evaluateCapabilityLifecycle,
  getGenerationProfileIssue, getGenerationIssue, findModelCapabilities, schemas,
} from '../packages/contracts/src/index.ts';
import {createMockProvider} from '../packages/business/src/providers/mock.ts';
import {createRunwayProvider} from '../packages/business/src/providers/runway.ts';
import {createArkProvider} from '../packages/business/src/providers/ark.ts';
import {createVeoProvider} from '../packages/business/src/providers/veo.ts';
import {createMinimaxProvider} from '../packages/business/src/providers/minimax.ts';
import {createViduProvider} from '../packages/business/src/providers/vidu.ts';
import {normalizedCapabilities} from '../packages/business/src/provider-registry.ts';

const asOf='2026-10-10';
const reference=(patch={})=>({role:'first_frame',assetId:'managed-image-a',mimeType:'image/png',sizeBytes:1024,sha256:'a'.repeat(64),width:720,height:1280,...patch});
const inputFor=(profile:GenerationInputProfile,patch={})=>({providerId:profile.providerId,model:profile.model,region:profile.regions[0],prompt:'Synthetic shape moves slowly.',aspectRatio:'9:16',duration:profile.durationsSeconds[0],references:[reference()],parameters:{},...patch});
const profileFor=(id: string)=>GENERATION_INPUT_PROFILES.find(profile=>profile.providerId===id)!;
const validate=(input: unknown,options:Parameters<typeof validateGenerationInput>[1]={asOf})=>(validateGenerationInput(input,options) as GenerationValidationResult&Partial<AdapterPlanSuccess>);
const codes=(result:ReturnType<typeof validateGenerationInput>)=>result.issues.map((issue: { code: unknown; })=>issue.code);
const constructors={mock:createMockProvider,runway:createRunwayProvider,ark:createArkProvider,veo:createVeoProvider,minimax:createMinimaxProvider,vidu:createViduProvider};
const createProvider=(id: string)=>(constructors[(id as keyof typeof constructors)](({root:'/synthetic-managed-root',db:{exec(){},prepare(){throw Error('Database writes are forbidden in contract checks');}},env:{},fetchImpl(){throw Error('Network calls are forbidden in contract checks');}} as unknown as Parameters<typeof createMockProvider>[0])) as unknown as Provider&{validate:NonNullable<Provider["validate"]>;capabilities:Provider["capabilities"]&{inputModes:readonly string[]}});
const capabilitiesFor=(id: string,patch={})=>{
  const provider=createProvider(id);
  return {...normalizedCapabilities(provider,{},0,{asOf,requireInputProfiles:true}),...patch};
};
const snapshotFor=(profile:GenerationInputProfile,patch={})=>{
  const input=inputFor(profile);
  return {model:input.model,prompt:input.prompt,aspectRatio:input.aspectRatio,duration:input.duration,parameters:{},referenceAssetIds:['managed-image-a'],referenceAssets:[{id:'managed-image-a',mimeType:'image/png',sizeBytes:1024,sha256:'a'.repeat(64),width:720,height:1280}],...patch};
};

test('exact immutable profiles expose only implemented active routes and preserve archived v1/v2 routes',()=>{
  assert.equal(GENERATION_INPUT_PROFILES.length,6);
  for(const profile of GENERATION_INPUT_PROFILES){
    assert.ok(Object.isFrozen(profile.inputs.roles.first_frame));
    assert.deepEqual(Object.keys(profile.inputs.roles),GENERATION_INPUT_ROLES);
    const pair=['ark','mock'].includes(profile.providerId);
    for(const role of GENERATION_INPUT_ROLES.slice(1)){
      const implemented=pair&&['last_frame','subject_reference'].includes(role);
      assert.equal(profile.inputs.roles[role].implemented,implemented);
      assert.equal(profile.inputs.roles[role].max,implemented?1:0);
      if(!implemented)assert.match(profile.inputs.roles[role].reason!,/current Mioon adapter/);
    }
    assert.equal(profile.inputs.maxReferences,pair?2:1);
    assert.equal(profile.profileVersion,pair?SUBJECT_REFERENCE_PROFILE_VERSION:INPUT_PROFILE_VERSION);
    assert.equal(getCapabilityProfile(profile.providerId,profile.model,profile.regions[0]),profile);
    assert.equal(getCapabilityProfile(profile.providerId,profile.model+'-alias',profile.regions[0]),null);
    assert.equal(getCapabilityProfile(profile.providerId,profile.model,'not-a-region'),null);
    assert.equal((getCapabilityProfile as unknown as (providerId:string,model:string)=>ReturnType<typeof getCapabilityProfile>)(profile.providerId,profile.model),null);
  }
  assert.deepEqual(ARCHIVED_CAPABILITY_PROFILES.map(profile=>profile.providerId),['ark','mock','ark','mock']);
  for(const profile of ARCHIVED_CAPABILITY_PROFILES){
    const pair=profile.profileVersion===FRAME_PAIR_PROFILE_VERSION;
    assert.ok([INPUT_PROFILE_VERSION,FRAME_PAIR_PROFILE_VERSION].includes(profile.profileVersion));
    assert.equal(profile.inputs.maxReferences,pair?2:1);
    assert.equal(profile.inputs.roles.last_frame.implemented,pair);
    assert.equal(profile.inputs.roles.subject_reference.implemented,false);
    assert.ok(codes(validateGenerationInput(inputFor(profile,{references:[reference({role:'subject_reference'})]}),{asOf,profileId:profile.profileId,profileVersion:profile.profileVersion})).includes('UNSUPPORTED_INPUT_ROLE'));
    assert.ok(Object.isFrozen(profile.inputs.roles.first_frame));
    assert.equal(getCapabilityProfile(profile.providerId,profile.model,profile.regions[0],{profileId:profile.profileId,profileVersion:profile.profileVersion}),profile);
  }
});

test('fixed endpoints and regional providers never guess missing regions',()=>{
  assert.equal(getGenerationProfileRegion('mock'),'local');
  assert.equal(getGenerationProfileRegion('ark'),'cn-beijing');
  assert.equal(getGenerationProfileRegion('veo'),'global');
  assert.equal(getGenerationProfileRegion('runway'),'global');
  for(const id of ['minimax','vidu']){
    assert.equal(getGenerationProfileRegion(id),null);
    assert.equal(getGenerationProfileRegion(id,{region:'cn'}),'cn');
    assert.equal(getCapabilityProfile(id,profileFor(id)!.model,'CN'),null);
  }
});

for(const profile of GENERATION_INPUT_PROFILES){
  test(`${profile.providerId}: actual adapter model, ratio, duration and input policy parity without IO`,()=>{
    const provider=createProvider(profile.providerId);
    assert.deepEqual(provider.capabilities.models,[profile.model]);
    assert.deepEqual(provider.capabilities.aspectRatios,profile.aspectRatios);
    assert.deepEqual(provider.capabilities.durations,profile.durationsSeconds);
    assert.deepEqual([...provider.capabilities.inputModes].sort(),[...profile.inputModes].sort());
    for(const ratio of profile.aspectRatios)for(const duration of profile.durationsSeconds){
      const [w,h]=ratio.split(':').map(Number);
      const input=inputFor(profile,{aspectRatio:ratio,duration,references:[reference({width:w*80,height:h*80})]});
      const result=(buildAdapterPlan(input,{asOf}) as AdapterPlanResult&Partial<AdapterPlanSuccess>);
      assert.equal(result.ok,true,JSON.stringify(result.issues));
      assert.equal(provider.validate(result.adapterSnapshot),true);
      assert.equal(result.adapterSnapshot.referenceAssets.length,input.references.length);
    }
    const text=(buildAdapterPlan(inputFor(profile,{references:[]}),{asOf}) as AdapterPlanResult&Partial<AdapterPlanSuccess>);
    assert.equal(text.ok,profile.inputs.minReferences===0);
    if(text.ok)assert.equal(provider.validate(text.adapterSnapshot),true);
    const good=(buildAdapterPlan(inputFor(profile),{asOf}) as AdapterPlanResult&Partial<AdapterPlanSuccess>).adapterSnapshot;
    for(const patch of [{model:'different-model'},{aspectRatio:'unsupported'},{duration:19}]){
      assert.equal(validate(inputFor(profile,patch)).ok,false);
      assert.throws(()=>provider.validate({...good,...patch}));
    }
    if(profile.providerId!=='mock'){
      for(const patch of [{prompt:''},{prompt:'x'.repeat(1001)},{parameters:{unsupported:true}}]){
        assert.equal(validate(inputFor(profile,patch)).ok,false);
        assert.throws(()=>provider.validate({...good,...patch}));
      }
    }
    const unsupported=validate(inputFor(profile,{references:[reference({role:'style_reference'})]}));
    assert.ok(codes(unsupported).includes('UNSUPPORTED_INPUT_ROLE'));
  });
}

test('existing adapter-specific dimensional and MIME validators agree on advertised policy',()=>{
  for(const id of ['ark','minimax','vidu']){
    const profile=profileFor(id),provider=createProvider(id);
    for(const patch of [{width:0},{width:721},{height:undefined},{mimeType:'image/webp'}]){
      const result=validate(inputFor(profile,{references:[reference(patch)]}));
      assert.equal(result.ok,false);
      assert.throws(()=>provider.validate({...snapshotFor(profile),referenceAssets:[{...snapshotFor(profile).referenceAssets[0],...patch}]}));
    }
  }
  const runway=profileFor('runway');
  assert.equal(validate(inputFor(runway,{references:[reference({mimeType:'image/webp',width:undefined,height:undefined})]})).ok,false,'explicit undefined dimensions are not trusted metadata');
  const ref=reference({mimeType:'image/webp'});delete (ref as Partial<typeof ref>).width;delete (ref as Partial<typeof ref>).height;
  assert.equal(validate(inputFor(runway,{references:[ref]})).ok,true,'Runway does not require declared dimensions');
});

test('all unsupported roles, duplicates and complete multi-reference combinations fail closed',()=>{
  for(const profile of GENERATION_INPUT_PROFILES){
    for(const role of [...GENERATION_INPUT_ROLES.slice(1).filter(role=>role!=='subject_reference'||!profile.inputs.roles[role].implemented),'invented'])assert.equal(validate(inputFor(profile,{references:[reference({role})]})).ok,false);
    for(const references of [[reference(),reference({assetId:'managed-image-b'})],[reference(),reference()]]){
      const result=(buildAdapterPlan(inputFor(profile,{references}),{asOf}) as AdapterPlanResult&Partial<AdapterPlanSuccess>);
      assert.equal(result.ok,false);
      assert.equal(result.adapterSnapshot,undefined);
      assert.ok(codes(result).includes('INVALID_REFERENCE_COUNT'));
    }
  }
});

test('managed byte caps and exact Runway full-data-URI caps include the MIME prefix',()=>{
  for(const profile of GENERATION_INPUT_PROFILES){
    const limit=profile.inputs.roles.first_frame.maxBytes;
    assert.ok(codes(validate(inputFor(profile,{references:[reference({sizeBytes:limit!+1})]}))).includes('REFERENCE_TOO_LARGE'));
    if(profile.providerId!=='runway')assert.equal(validate(inputFor(profile,{references:[reference({sizeBytes:limit})]})).ok,true);
  }
  const profile=profileFor('runway'),limit=profile!.inputs.roles.first_frame.maxDataUriBytes;
  for(const mimeType of ['image/png','image/jpeg','image/webp']){
    const prefix=`data:${mimeType};base64,`.length,maxRaw=Math.floor((limit!-prefix)/4)*3;
    assert.equal(encodedImageDataUriBytes(mimeType,maxRaw),prefix+4*Math.ceil(maxRaw/3));
    assert.equal(validate(inputFor(profile,{references:[reference({mimeType,sizeBytes:maxRaw})]})).ok,true);
    assert.ok(codes(validate(inputFor(profile,{references:[reference({mimeType,sizeBytes:maxRaw+1})]}))).includes('REFERENCE_DATA_URI_TOO_LARGE'));
  }
  assert.equal(encodedImageDataUriBytes('image/png',Number.MAX_SAFE_INTEGER),null);
  assert.equal(encodedImageDataUriBytes('text/plain',1),null);
  assert.equal(encodedImageDataUriBytes('image/png',0),null);
});

test('missing or invalid metadata is explicit, never inferred from a URL, hash or old snapshot',()=>{
  const profile=profileFor('runway');
  for(const sizeBytes of [undefined,null])assert.ok(codes(validate(inputFor(profile,{references:[reference({sizeBytes})]}))).includes('REFERENCE_METADATA_UNAVAILABLE'));
  for(const sizeBytes of [0,-1,Infinity,NaN,1.5,Number.MAX_SAFE_INTEGER+1])assert.ok(codes(validate(inputFor(profile,{references:[reference({sizeBytes})]}))).includes('INVALID_REFERENCE_SIZE'));
  for(const patch of [{sha256:''},{mimeType:'image/svg+xml'},{assetId:''},{url:'https://untrusted.example/ref.png'},{path:'/private/image'},{durationSeconds:4}])assert.equal(validate(inputFor(profile,{references:[reference(patch)]})).ok,false);
});

test('hostile arrays, records, getters and oversized selections are rejected without invoking accessors',()=>{
  const profile=profileFor('mock');let reads=0;
  const sparse=new Array(1),getter: unknown[]=[];Object.defineProperty(getter,'0',{get(){reads++;throw Error('must not read');},enumerable:true});
  const extra=[reference()];(extra as typeof extra&{unexpected?:boolean}).unexpected=true;
  const symbolic=[reference()];(symbolic as unknown as Record<symbol,unknown>)[Symbol('unexpected')]=true;
  const inherited=[reference()];Object.setPrototypeOf(inherited,{0:reference()});
  for(const references of [sparse,getter,extra,symbolic,inherited,Array(9).fill(reference()),{},null]){
    assert.equal(validate(inputFor(profile,{references})).ok,false);
  }
  const refGetter={...reference()};Object.defineProperty(refGetter,'role',{get(){reads++;throw Error('must not read');},enumerable:true});
  assert.equal(validate(inputFor(profile,{references:[refGetter]})).ok,false);
  const inputGetter=inputFor(profile);Object.defineProperty(inputGetter,'prompt',{get(){reads++;throw Error('must not read');},enumerable:true});
  assert.equal(validate(inputGetter).ok,false);
  assert.equal(reads,0);
  assert.equal(validate(inputFor(profile,{parameters:[]})).ok,false);
  assert.equal(validate(inputFor(profile,{inputBindings:[]})).ok,false);
});

test('Veo uses an explicit current server date and never substitutes the retired preview',()=>{
  const profile=profileFor('veo'),input=inputFor(profile,{references:[]});
  assert.ok(codes(validate(input,{})).includes('AS_OF_DATE_REQUIRED'));
  for(const date of ['2026-02-30','yesterday','2026-10-21T23:59:59Z',null])assert.ok(codes(validate(input,{asOf:date})).includes('INVALID_AS_OF_DATE'));
  const before=(buildAdapterPlan(input,{asOf:'2026-10-21'}) as AdapterPlanResult&Partial<AdapterPlanSuccess>);
  assert.equal(before.ok,true);assert.equal(before.selection.model,'veo-3.1-generate-preview');
  assert.equal(before.warnings[0].code,'MODEL_LIFECYCLE_WARNING');
  assert.equal(before.warnings[0].checkedOn,'2026-10-10');
  for(const date of ['2026-10-22','2027-01-01']){
    const result=(buildAdapterPlan(input,{asOf:date}) as AdapterPlanResult&Partial<AdapterPlanSuccess>);
    assert.ok(codes(result).includes('MODEL_LIFECYCLE_REVALIDATION_REQUIRED'));
    assert.equal(result.adapterSnapshot,undefined);
  }
  const copied=structuredClone(profile);
  assert.equal(evaluateCapabilityLifecycle(copied,{asOf:'2026-10-21'}).ok,true);
  copied!.profileVersion='future-version';assert.equal(evaluateCapabilityLifecycle(copied,{asOf}).ok,false);
});

test('mock explicitly does not depict either prompt or references, including text-only simulation',()=>{
  const profile=profileFor('mock');assert.equal(profile!.output.depictsPromptOrReferences,false);
  for(const references of [[],[reference()]]){
    const result=validate(inputFor(profile,{references}));
    assert.equal(result.ok,true);
    assert.match(result.warnings.find(w=>w.code==='MOCK_REFERENCE_NOT_RENDERED')!.message,/does not depict the image or prompt/);
  }
  assert.equal(validate(inputFor(profile),{}).evaluatedAsOf,null);
});

test('adapter plan is immutable, preserves complete identity/hash metadata and omits paths',()=>{
  const input=inputFor(profileFor('ark')),before=structuredClone(input),result=(buildAdapterPlan(input,{asOf}) as AdapterPlanResult&Partial<AdapterPlanSuccess>);
  assert.deepEqual(input,before);
  assert.deepEqual(result.referenceBindings,[{role:'first_frame',assetId:'managed-image-a',sha256:'a'.repeat(64)}]);
  assert.equal(result.adapterSnapshot.referenceAssets[0].sizeBytes,1024);
  assert.equal(result.adapterSnapshot.referenceAssets[0].id,'managed-image-a');
  assert.equal(result.adapterSnapshot.referenceAssets[0].path,undefined);
  assert.ok(Object.isFrozen(result.adapterSnapshot.referenceAssets[0]));
  input.references[0].sizeBytes=99;
  assert.equal(result.adapterSnapshot.referenceAssets[0].sizeBytes,1024);
});

test('shot bridge preserves all IDs and pinned role/edge identity rather than filtering missing assets',()=>{
  const profile=profileFor('ark'),caps=capabilitiesFor('ark'),snapshot=snapshotFor(profile);
  assert.equal(getGenerationProfileIssue(snapshot,caps),null);
  for(const patch of [
    {referenceAssetIds:['managed-image-a','missing-image']},
    {referenceAssets:[]},
    {referenceAssetIds:['different-image']},
    {referenceBindings:[{role:'first_frame',assetId:'other',sha256:'a'.repeat(64)}]},
    {referenceBindings:[{role:'first_frame',assetId:'managed-image-a',sha256:'b'.repeat(64)}]},
    {referenceConnections:[{role:'subject_reference',sourceAssetId:'managed-image-a'}]},
    {referenceConnections:[{role:'first_frame',sourceAssetId:'other'}]},
  ])assert.ok(getGenerationProfileIssue({...snapshot,...patch},caps));
  const bindings=[{role:'style_reference',assetId:'managed-image-a',sha256:'a'.repeat(64)}];
  assert.equal(getGenerationProfileIssue({...snapshot,referenceBindings:bindings},caps)!.code,'UNSUPPORTED_INPUT_ROLE');
  const old=structuredClone(snapshot);delete (old.referenceAssets[0] as Partial<typeof old.referenceAssets[0]>).sizeBytes;
  assert.equal(getGenerationProfileIssue(old,caps)!.code,'REFERENCE_METADATA_UNAVAILABLE');
});

test('missing/unknown model-profile-region discovery fails closed without provider union fallback',()=>{
  const caps=capabilitiesFor('ark'),snapshot=snapshotFor(profileFor('ark'));
  assert.ok(findModelCapabilities(caps,snapshot.model));
  for(const patch of [{inputProfiles:[]},{inputProfileVersion:'future'},{providerRegion:'global'}])assert.equal(findModelCapabilities({...caps,...patch},snapshot.model),null);
  assert.equal(findModelCapabilities({...caps,models:[snapshot.model,'invented']},'invented'),null);
  assert.ok(getGenerationProfileIssue(snapshot,{...caps,profileEvaluationDate:undefined}));
  assert.equal(getGenerationProfileIssue({...snapshot,providerRegion:'global'},caps)!.code,'PROVIDER_REGION_CHANGED');
});

test('legacy capability API keeps old fixture identity, errors, messages and validation ordering',()=>{
  const model={id:'old-fixture',inputModes:['image'],aspectRatios:['9:16'],durations:[4],referenceImages:{min:1,max:1,mimeTypes:['image/png']},promptRequired:true,maxPromptLength:1000,parameters:['seed'],seed:{min:0,max:10}};
  const caps={id:'custom-fixture',models:[model.id],modelCapabilities:[model]},snapshot=snapshotFor(profileFor('ark'),{model:model.id});
  assert.equal(findModelCapabilities(caps,model.id),model);
  assert.equal(getGenerationIssue(snapshot,caps),null);
  const cases=[
    [{model:'missing',duration:20},'UNSUPPORTED_MODEL','此供应商不支持所选模型'],
    [{duration:20,referenceAssets:[],referenceAssetIds:[]},'UNSUPPORTED_PARAMETERS','此模型不支持所选画幅或时长'],
    [{referenceAssets:[],referenceAssetIds:[],prompt:''},'UNSUPPORTED_INPUT','此模型需要一张首帧参考图'],
    [{prompt:'',parameters:{unsupported:true}},'INVALID_PROMPT','请填写 1–1000 字符的画面描述'],
    [{parameters:{unsupported:true,seed:20}},'UNSUPPORTED_PARAMETER','此模型不支持所选高级参数'],
    [{parameters:{seed:20}},'INVALID_SEED','随机种子须为 0–10 之间的整数'],
  ];
  for(const [patch,code,message]of cases as [Record<string,unknown>,string,string][])assert.deepEqual(getGenerationIssue({...snapshot,...patch},caps),{code,message});
});

test('generation.submit public schema does not admit inputBindings or a browser region',()=>{
  const base={shotId:'00000000-0000-4000-8000-000000000001',expectedRevision:1,requestId:'test-request',providerId:'mock'};
  assert.equal(schemas['generation.submit'].safeParse(base).success,true);
  for(const patch of [{inputBindings:[]},{providerRegion:'cn'},{profileEvaluationDate:asOf}])assert.equal(schemas['generation.submit'].safeParse({...base,...patch}).success,false);
});


test('legacy wrapper also rejects sparse/accessor reference arrays without evaluating them',()=>{
  const profile=profileFor('runway'),caps=capabilitiesFor('runway'),snapshot=snapshotFor(profile);let reads=0;
  const references: unknown[]=[];Object.defineProperty(references,'0',{get(){reads++;throw Error('must not read');},enumerable:true});
  for(const referenceAssets of [references,new Array(1),Array(9).fill(snapshot.referenceAssets[0])])assert.ok(getGenerationIssue({...snapshot,referenceAssets},caps));
  const asset={...snapshot.referenceAssets[0]};Object.defineProperty(asset,'mimeType',{get(){reads++;throw Error('must not read');},enumerable:true});
  assert.ok(getGenerationIssue({...snapshot,referenceAssets:[asset]},caps));
  assert.equal(reads,0);
});


test('profiled wrapper matches the identical legacy-then-canonical first issue without stricter legacy reconstruction',()=>{
  for(const profile of GENERATION_INPUT_PROFILES){
    const caps=capabilitiesFor(profile.providerId),snapshot=snapshotFor(profile);
    const {inputProfiles,...legacyCaps}=caps;
    const cases=[
      {},
      {prompt:''},
      {duration:19,prompt:''},
      {parameters:{unsupported:true}},
      {referenceAssets:[{...snapshot.referenceAssets[0],mimeType:'image/gif'}]},
      {referenceAssets:[{...snapshot.referenceAssets[0],mimeType:'image/gif'}],prompt:''},
      {referenceAssets:[{...snapshot.referenceAssets[0],sizeBytes:0}]},
      {referenceAssets:[{...snapshot.referenceAssets[0],sizeBytes:undefined}]},
      {referenceAssets:[{...snapshot.referenceAssets[0],sizeBytes:40*1024*1024}]},
      {referenceAssets:[{...snapshot.referenceAssets[0],width:undefined}]},
      {referenceAssets:[{...snapshot.referenceAssets[0],role:'style_reference'}]},
      {referenceAssets:[{...snapshot.referenceAssets[0],durationSeconds:1}]},
    ];
    for(const patch of cases){
      const candidate={...snapshot,...patch};
      const legacy=getGenerationIssue(candidate,legacyCaps);
      const refs=candidate.referenceAssets.map(asset=>({role:(asset as typeof asset&{role?:string}).role??'first_frame',assetId:asset.id,mimeType:asset.mimeType,sha256:asset.sha256,
        ...(asset.sizeBytes===undefined?{}:{sizeBytes:asset.sizeBytes}),...(asset.width===undefined?{}:{width:asset.width}),...(asset.height===undefined?{}:{height:asset.height}),
        ...(Object.hasOwn(asset,'durationSeconds')?{durationSeconds:(asset as typeof asset&{durationSeconds?:number}).durationSeconds}:{})}));
      const canonical=(buildAdapterPlan({providerId:caps.id,model:candidate.model,region:caps.providerRegion,prompt:candidate.prompt,aspectRatio:candidate.aspectRatio,duration:candidate.duration,parameters:candidate.parameters,references:refs},{asOf}) as AdapterPlanResult&Partial<AdapterPlanSuccess>);
      const first=legacy||canonical.issues[0];
      assert.deepEqual(getGenerationIssue(candidate,caps),first?{code:first.code,message:first.message}:null,`${profile.providerId}: ${JSON.stringify(patch)}`);
    }
  }
  const mock=profileFor('mock'),caps=capabilitiesFor('mock'),snapshot=snapshotFor(mock);
  assert.deepEqual(getGenerationIssue({...snapshot,referenceAssets:[{...snapshot.referenceAssets[0],mimeType:'image/gif'}]},caps),{code:'UNSUPPORTED_REFERENCE_MIME',message:'Reference MIME type is not implemented for this role.'});
});

test('profile lookup retains exact model display metadata including output resolutions',()=>{
  for(const providerId of ['ark','veo','minimax','vidu']){
    const caps=capabilitiesFor(providerId),original=caps.modelCapabilities[0];
    const selected=findModelCapabilities(caps,original.id);
    assert.deepEqual(selected!.resolutions,original.resolutions);
    assert.equal(selected!.name,original.name);
    const extended={...caps,modelCapabilities:[{...original,description:'Specific model metadata',outputQuality:'advertised'}]};
    const result=findModelCapabilities(extended,original.id);
    assert.equal(result!.description,'Specific model metadata');
    assert.equal(result!.outputQuality,'advertised');
  }
});
