import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getGenerationIssue,schemas} from '../packages/contracts/src/index.ts';
import {defaultVideoModels,effectiveVideoParameters,getWan30Capability,parseVideoBinding,resolveVideoEndpoint,resolveWanGenerationParameters,validateVideoSnapshot,videoBindingCapabilities,videoConnectionConfigurationSchema,videoInputProfile,wanVideoInputSchema} from '../packages/contracts/src/video-providers.ts';
import type {VideoExecutionBinding,WanVideoInput} from '../packages/contracts/src/video-providers.ts';

function binding(modelId='wan3.0-video',region='cn-beijing'):VideoExecutionBinding {
 const model=defaultVideoModels('wan').find(model=>model.modelId===modelId)!;
 return {version:1,connectionId:randomUUID(),configurationRevision:1,providerId:'wan',region,workspaceId:'workspace_01',endpoint:resolveVideoEndpoint('wan',region,'workspace_01'),credentialRef:randomUUID(),model,outputHosts:['output.example.com']};
}
function image(role:string,id:string=randomUUID()) {return {id,role,sha256:'a'.repeat(64),mimeType:'image/png',sizeBytes:20_000_000,width:8000,height:1000};}
function snapshot(b:VideoExecutionBinding,input:WanVideoInput={version:1,mode:'text',images:[]}) {
 return {providerId:'wan',model:b.model.modelId,prompt:'A sunset',duration:5,aspectRatio:'16:9',parameters:{resolution:'720P'},videoInput:input,referenceAssets:input.images.map(item=>image(item.role,item.assetId))};
}
function configured(b:VideoExecutionBinding) {return {id:b.connectionId,providerId:b.providerId,name:'Wan account',region:b.region,workspaceId:b.workspaceId,enabled:true,archived:false,outputHosts:b.outputHosts,models:[b.model]};}

test('Wan input wire contract bounds modes, order, identity, provider and subject conflicts',()=>{
 const b=binding(),first=randomUUID(),last=randomUUID();
 const input:WanVideoInput={version:1,mode:'first_last_frame',images:[{role:'first_frame',assetId:first},{role:'last_frame',assetId:last}]};
 const request={shotId:randomUUID(),expectedRevision:1,requestId:'synthetic-request',providerId:'wan',connectionId:b.connectionId,configurationRevision:1,modelEntryId:b.model.id,videoInput:input,parameters:{durationSeconds:-1,aspectRatio:'adaptive',promptExtend:true,watermark:false}};
 assert.equal(schemas['generation.submit'].safeParse(request).success,true);
 for(const invalid of [{...input,version:2},{...input,images:[...input.images].reverse()},{...input,images:[input.images[0],input.images[0]]},{...input,mode:'first_frame'}, {...input,images:[...input.images],url:'https://unmanaged.example/image.png'}])assert.equal(wanVideoInputSchema.safeParse(invalid).success,false);
 assert.equal(schemas['generation.submit'].safeParse({...request,subjectVersionId:randomUUID()}).success,false);
 assert.equal(schemas['generation.submit'].safeParse({...request,providerId:'ark'}).success,false);
 assert.equal(schemas['generation.submit'].safeParse({...request,connectionId:undefined,configurationRevision:undefined,modelEntryId:undefined}).success,false);
 for(const providerId of ['mock','ark','veo','minimax','vidu','kling','runway'])for(const parameters of [{durationSeconds:5},{aspectRatio:'16:9'},{promptExtend:false},{watermark:false}])assert.equal(schemas['generation.submit'].safeParse({...request,providerId,videoInput:undefined,parameters}).success,false);
 assert.equal(wanVideoInputSchema.safeParse({version:1,mode:'reference_images',images:Array.from({length:11},()=>({role:'reference_image',assetId:randomUUID()}))}).success,false);
});

test('only reviewed exact model/region/protocol rows advertise full Wan 3.0 features',()=>{
 const defaults=defaultVideoModels('wan');
 assert.deepEqual(defaults.map(model=>model.modelId),['wan2.7-t2v','wan2.7-i2v','wan3.0-video','wan3.0-video-prime']);
 for(const modelId of ['wan3.0-video','wan3.0-video-prime'])for(const region of ['cn-beijing','ap-southeast-1']){
  const b=binding(modelId,region),profile=videoInputProfile(b),capability=videoBindingCapabilities(b).modelCapabilities[0]!;
  assert.equal(parseVideoBinding(b).model.modelId,modelId);assert.equal(videoConnectionConfigurationSchema.safeParse(configured(b)).success,true);
  assert.equal(profile.inputs.maxReferences,10);assert.equal(profile.prompt.maxCodeUnits,20000);assert.equal(profile.inputs.roles.reference_image!.max,10);
  assert.equal(capability.wanCapabilities?.modelId,modelId);assert.equal(capability.wanCapabilities?.region,region);assert.equal(capability.wanCapabilities?.reviewedOn,'2026-10-23');
  assert.equal(capability.wanCapabilities?.smartDuration,true);assert.ok(capability.parameters.includes('durationSeconds'));assert.ok(capability.parameters.includes('watermark'));
  assert.ok(profile.durationsSeconds.includes(-1));assert.ok(profile.aspectRatios.includes('adaptive'));
 }
 assert.equal(getWan30Capability('wan3.0-video-future','cn-beijing','wan30-v1'),undefined);
 assert.equal(getWan30Capability('wan3.0-video','global','wan30-v1'),undefined);
 assert.equal(getWan30Capability('wan3.0-video','cn-beijing','wan27-t2v'),undefined);
 const custom=binding();custom.model={...custom.model,modelId:'wan3.0-custom'};
 assert.equal(videoConnectionConfigurationSchema.safeParse(configured(custom)).success,false);
 custom.model={...custom.model,inputModes:['text','image'],aspectRatios:['16:9'],audio:'default',durationResolutionMap:[{duration:[5],resolution:['720P']}]};
 assert.equal(videoConnectionConfigurationSchema.safeParse(configured(custom)).success,false,'Narrowing a custom model does not grant a reviewed Wan 3.0 protocol');
 custom.model={...defaultVideoModels('wan')[0]!,modelId:'custom-wan-future'};
 assert.equal(videoConnectionConfigurationSchema.safeParse(configured(custom)).success,true,'Legacy custom IDs retain their explicitly selected Wan 2.7 protocol');
 const customCapabilities=videoBindingCapabilities(custom).modelCapabilities[0]!;
 assert.equal(customCapabilities.wanCapabilities,undefined);assert.equal(customCapabilities.parameters.includes('durationSeconds'),false);
 const exact=binding();
 for(const audio of ['off','on','default']as const)assert.equal(videoConnectionConfigurationSchema.safeParse(configured({...exact,model:{...exact.model,audio}})).success,false);
});

test('Wan 3.0 accepts each image mode and freezes all ten reference images in declared order',()=>{
 const b=binding();
 const inputs:WanVideoInput[]=[{version:1,mode:'text',images:[]},{version:1,mode:'first_frame',images:[{role:'first_frame',assetId:randomUUID()}],prompt:''},{version:1,mode:'first_last_frame',images:[{role:'first_frame',assetId:randomUUID()},{role:'last_frame',assetId:randomUUID()}]}, {version:1,mode:'reference_images',images:Array.from({length:10},()=>({role:'reference_image',assetId:randomUUID()})),prompt:'让图1与图10同框'}];
 for(const input of inputs)assert.equal(validateVideoSnapshot(b,snapshot(b,input)),true);
 const value=snapshot(b,inputs[3]!);
 assert.throws(()=>validateVideoSnapshot(b,{...value,referenceAssets:[...value.referenceAssets].reverse()}),{code:'INVALID_REFERENCE_MANIFEST'});
 assert.throws(()=>validateVideoSnapshot(b,{...value,referenceAssets:value.referenceAssets.slice(1)}),{code:'INVALID_REFERENCE_MANIFEST'});
 assert.throws(()=>validateVideoSnapshot(b,{...value,referenceAssetIds:[...value.videoInput.images.map(image=>image.assetId)].reverse()}),{code:'INVALID_REFERENCE_MANIFEST'});
 assert.throws(()=>validateVideoSnapshot(b,{...value,referenceBindings:value.referenceAssets.map(asset=>({assetId:asset.id,role:asset.role,sha256:'b'.repeat(64)}))}),{code:'INVALID_REFERENCE_MANIFEST'});
 assert.throws(()=>validateVideoSnapshot(b,{...value,videoInput:undefined}),{code:'INVALID_REFERENCE_MANIFEST'});
 assert.throws(()=>validateVideoSnapshot(b,{...value,subjectReference:{}}),{code:'UNSUPPORTED_INPUT_ROLE'});
 assert.throws(()=>validateVideoSnapshot(b,snapshot(b,{version:1,mode:'text',images:[],prompt:' '})),{code:'INVALID_PROMPT'});
 assert.equal(validateVideoSnapshot(b,snapshot(b,{version:1,mode:'text',images:[],prompt:'a'.repeat(20000)})),true);
 assert.throws(()=>validateVideoSnapshot(b,snapshot(b,{version:1,mode:'text',images:[],prompt:'a'.repeat(20001)})),{code:'UNSUPPORTED_INPUT_ROLE'});
});

test('Wan generation parameters preserve fixed shot fields while validating effective automatic and fixed values',()=>{
 const b=binding(),base=snapshot(b),automatic={...base,parameters:{durationSeconds:-1,aspectRatio:'adaptive',seed:-1,generateAudio:false,promptExtend:false,watermark:true,resolution:'480P'}};
 assert.equal(validateVideoSnapshot(b,automatic),true);
 assert.equal(getGenerationIssue(automatic,videoBindingCapabilities(b)),null);
 assert.equal(getGenerationIssue({...automatic,parameters:{durationSeconds:31}},videoBindingCapabilities(b))?.code,'UNSUPPORTED_PARAMETERS');
 assert.deepEqual(effectiveVideoParameters(b,automatic),{prompt:'A sunset',durationSeconds:-1,aspectRatio:'adaptive',resolution:'480P',seed:-1,generateAudio:false,promptExtend:false,watermark:true});
 assert.equal(automatic.duration,5);assert.equal(automatic.aspectRatio,'16:9');
 assert.equal(effectiveVideoParameters(b,base).generateAudio,true);assert.equal(effectiveVideoParameters(b,base).promptExtend,true);assert.equal(effectiveVideoParameters(b,base).watermark,false);
 assert.equal(validateVideoSnapshot(b,{...base,parameters:{durationSeconds:30,aspectRatio:'21:9',resolution:'1080P',seed:2147483647}}),true);
 for(const durationSeconds of [-2,0,1,31,2.5])assert.throws(()=>validateVideoSnapshot(b,{...base,parameters:{durationSeconds}}),{code:'UNSUPPORTED_PARAMETERS'});
 for(const parameters of [{seed:-2},{seed:2147483648},{promptExtend:'true'},{watermark:0},{generateAudio:'false'},{resolution:'4K'},{aspectRatio:'auto'}])assert.throws(()=>validateVideoSnapshot(b,{...base,parameters}),{code:'UNSUPPORTED_PARAMETERS'});
 const pair=binding();pair.model.durationResolutionMap=[{duration:[5],resolution:['720P']},{duration:[10],resolution:['1080P']}];
 assert.throws(()=>validateVideoSnapshot(pair,{...snapshot(pair),parameters:{durationSeconds:10,resolution:'720P'}}),{code:'UNSUPPORTED_PARAMETERS'});
});

test('new Wan defaults use allowed model options without rewriting historical parameter interpretation',()=>{
 const b=binding(),defaults=getWan30Capability(b.model.modelId,b.region,b.model.templateId)!.defaults;
 const historical={...snapshot(b),duration:4,parameters:{}};
 const parameters=resolveWanGenerationParameters(b.model,defaults,historical);
 assert.deepEqual(parameters,{durationSeconds:5,resolution:'720P',aspectRatio:'16:9',generateAudio:true,promptExtend:true,watermark:false});
 assert.deepEqual(resolveWanGenerationParameters(b.model,defaults,{...historical,parameters:{durationSeconds:undefined}},{resolution:undefined,generateAudio:undefined,promptExtend:undefined,watermark:undefined,aspectRatio:undefined}),parameters);
 assert.equal(effectiveVideoParameters(b,historical).durationSeconds,4);
 assert.deepEqual(historical.parameters,{});
 const narrowed={...b.model,aspectRatios:['1:1'],durationResolutionMap:[{duration:[10],resolution:['1080P']}]};
 assert.deepEqual(resolveWanGenerationParameters(narrowed,defaults,historical),{durationSeconds:10,resolution:'1080P',aspectRatio:'1:1',generateAudio:true,promptExtend:true,watermark:false});
 const explicit={durationSeconds:-1,aspectRatio:'adaptive',generateAudio:false,promptExtend:false,watermark:true,seed:0};
 assert.deepEqual(resolveWanGenerationParameters(b.model,defaults,{...historical,parameters:{resolution:'480P'}},explicit),{...parameters,resolution:'480P',...explicit});
 const paired={...b.model,durationResolutionMap:[{duration:[5],resolution:['720P']},{duration:[10],resolution:['1080P']}]};
 assert.equal(resolveWanGenerationParameters(paired,defaults,historical,{durationSeconds:10}).resolution,'1080P');
 const invalid=resolveWanGenerationParameters(b.model,defaults,historical,{durationSeconds:31});
 assert.throws(()=>validateVideoSnapshot(b,{...historical,parameters:invalid}),{code:'UNSUPPORTED_PARAMETERS'});
});

test('Wan image manifest enforces reviewed bytes, dimensions, format, ratio and hashes',()=>{
 const b=binding(),input:WanVideoInput={version:1,mode:'first_frame',images:[{role:'first_frame',assetId:randomUUID()}]},base=snapshot(b,input);
 assert.equal(validateVideoSnapshot(b,{...base,referenceAssets:[{...base.referenceAssets[0]!,mimeType:'image/webp'}]}),true);
 for(const patch of [{sizeBytes:20_000_001},{sizeBytes:0},{mimeType:'image/bmp'},{sha256:'unverified'}])assert.throws(()=>validateVideoSnapshot(b,{...base,referenceAssets:[{...base.referenceAssets[0]!,...patch}]}),{code:'INVALID_REFERENCE_METADATA'});
 for(const patch of [{width:239},{height:8001}])assert.throws(()=>validateVideoSnapshot(b,{...base,referenceAssets:[{...base.referenceAssets[0]!,...patch}]}),{code:'INVALID_REFERENCE_DIMENSIONS'});
 assert.throws(()=>validateVideoSnapshot(b,{...base,referenceAssets:[{...base.referenceAssets[0]!,width:8000,height:999}]}),{code:'REFERENCE_ASPECT_RATIO_MISMATCH'});
});

test('legacy Wan bindings retain old limits and reject all Wan 3.0 input and advanced parameters',()=>{
 const b=binding('wan2.7-t2v'),base={...snapshot(b),videoInput:undefined};
 assert.equal(validateVideoSnapshot(b,base),true);
 assert.throws(()=>validateVideoSnapshot(b,{...base,prompt:'a'.repeat(1001)}),{code:'INVALID_PROMPT'});
 assert.throws(()=>validateVideoSnapshot(b,{...base,videoInput:{version:1,mode:'text',images:[]}}),{code:'UNSUPPORTED_INPUT_ROLE'});
 for(const parameters of [{durationSeconds:5},{aspectRatio:'16:9'},{promptExtend:false},{watermark:false},{seed:-1}])assert.throws(()=>validateVideoSnapshot(b,{...base,parameters}),{code:'UNSUPPORTED_PARAMETERS'});
});
