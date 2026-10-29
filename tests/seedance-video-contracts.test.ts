import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getGenerationIssue,schemas} from '../packages/contracts/src/index.ts';
import {defaultVideoModels,effectiveVideoParameters,getSeedance25Capability,resolveVideoEndpoint,SEEDANCE25_MODEL_ID,validateVideoSnapshot,videoBindingCapabilities,videoConnectionConfigurationSchema,videoInputProfile,videoTemplate} from '../packages/contracts/src/video-providers.ts';
import type {VideoExecutionBinding,VideoModelEntry} from '../packages/contracts/src/video-providers.ts';

function binding(patch:Partial<VideoModelEntry>={}):VideoExecutionBinding {
 const model={...defaultVideoModels('ark')[0]!,...patch};
 return {version:1,connectionId:randomUUID(),configurationRevision:1,providerId:'ark',region:'cn-beijing',workspaceId:'',endpoint:resolveVideoEndpoint('ark','cn-beijing'),credentialRef:randomUUID(),model,outputHosts:[]};
}
function image(role:string,width=720,height=1280){return {id:randomUUID(),role,sha256:'a'.repeat(64),mimeType:'image/png',sizeBytes:1000,width,height};}
const snapshot=(b:VideoExecutionBinding,patch:Record<string,unknown>={})=>({providerId:'ark',model:b.model.modelId,prompt:'A paper boat drifts.',duration:4,aspectRatio:'9:16',parameters:{resolution:'720p'},referenceAssets:[],...patch});
const configured=(b:VideoExecutionBinding)=>({id:b.connectionId,providerId:'ark',name:'Ark account',region:'cn-beijing',workspaceId:'',enabled:true,archived:false,outputHosts:[],models:[b.model]});

test('the ark-v3 template and default Seedance 2.5 entry cover 4–30 seconds, six ratios, three resolutions and optional sound',()=>{
 const template=videoTemplate('ark-v3'),model=defaultVideoModels('ark')[0]!;
 assert.deepEqual(template.durations,Array.from({length:27},(_,index)=>index+4));
 assert.deepEqual(template.aspectRatios,['9:16','16:9','1:1','3:4','4:3','21:9']);assert.deepEqual(template.resolutions,['720p','480p','1080p']);
 assert.deepEqual(template.audio,['optional','off']);
 assert.equal(model.modelId,SEEDANCE25_MODEL_ID);assert.equal(model.audio,'optional');assert.deepEqual(model.durationResolutionMap,[{duration:[...template.durations],resolution:['720p','480p','1080p']}]);
 assert.equal(videoConnectionConfigurationSchema.safeParse(configured(binding({audio:'off',durationResolutionMap:[{duration:[4,8],resolution:['720p']}],aspectRatios:['9:16','16:9']}))).success,true,'Saved entries from the earlier template stay valid');
 for(const audio of ['on','default'] as const)assert.equal(videoConnectionConfigurationSchema.safeParse(configured(binding({audio}))).success,false);
});

test('only the exact reviewed model, region and protocol row advertises generation-level Seedance controls',()=>{
 const b=binding(),profile=videoInputProfile(b),capability=videoBindingCapabilities(b,{asOf:'2026-10-30'}).modelCapabilities[0]!;
 assert.equal(capability.seedanceCapabilities?.modelId,SEEDANCE25_MODEL_ID);assert.equal(capability.seedanceCapabilities?.smartDuration,true);assert.equal(capability.seedanceCapabilities?.reviewedOn,'2026-10-30');
 assert.equal(capability.wanCapabilities,undefined);assert.equal(profile.reviewedOn,'2026-10-30');
 assert.equal(profile.prompt.maxCodeUnits,5000);assert.equal(capability.maxPromptLength,5000);assert.equal(profile.prompt.required,true);
 assert.ok(profile.durationsSeconds.includes(-1));assert.ok(profile.durationsSeconds.includes(30));assert.ok(profile.aspectRatios.includes('adaptive'));assert.ok(profile.aspectRatios.includes('21:9'));
 assert.deepEqual(Object.keys(profile.parameters),['resolution','generateAudio','durationSeconds','aspectRatio']);
 assert.deepEqual(profile.parameters.resolution,{type:'enum',values:['720p','480p','1080p']});
 assert.deepEqual(profile.inputs.roles.first_frame?.dimensions,{min:300,max:6000,matchAspectRatio:true,minAspectRatio:.4,maxAspectRatio:2.5});
 assert.equal(getSeedance25Capability(SEEDANCE25_MODEL_ID,'cn-beijing','ark-v3')?.maxPromptLength,5000);
 assert.equal(getSeedance25Capability('doubao-seedance-2-5-future','cn-beijing','ark-v3'),undefined);
 assert.equal(getSeedance25Capability(SEEDANCE25_MODEL_ID,'cn-beijing','wan30-v1'),undefined);
 const custom=binding({modelId:'custom-seedance-model',inputModes:['text','image','frames'],durationResolutionMap:[{duration:[4,8],resolution:['720p']}]}),customProfile=videoInputProfile(custom),customCapability=videoBindingCapabilities(custom).modelCapabilities[0]!;
 assert.equal(customCapability.seedanceCapabilities,undefined);assert.equal(customProfile.prompt.maxCodeUnits,1000);
 assert.equal(customProfile.durationsSeconds.includes(-1),false);assert.equal(customProfile.aspectRatios.includes('adaptive'),false);
 assert.equal(Object.hasOwn(customProfile.parameters,'durationSeconds'),false);assert.equal(Object.hasOwn(customProfile.parameters,'aspectRatio'),false);
 assert.equal(Object.hasOwn(videoInputProfile(binding({audio:'off'})).parameters,'generateAudio'),false);
});

test('Seedance 2.5 takes duration and ratio from the request when given, otherwise from the saved shot',()=>{
 const b=binding(),base=snapshot(b);
 assert.deepEqual({...effectiveVideoParameters(b,base),prompt:undefined},{prompt:undefined,durationSeconds:4,aspectRatio:'9:16',resolution:'720p',generateAudio:undefined,promptExtend:undefined,watermark:undefined,seed:undefined});
 const request={...base,parameters:{durationSeconds:-1,aspectRatio:'adaptive',resolution:'1080p',generateAudio:true}};
 assert.equal(effectiveVideoParameters(b,request).durationSeconds,-1);assert.equal(effectiveVideoParameters(b,request).aspectRatio,'adaptive');assert.equal(effectiveVideoParameters(b,request).generateAudio,true);
 assert.equal(request.duration,4);assert.equal(request.aspectRatio,'9:16');
 const custom=binding({modelId:'custom-seedance-model',inputModes:['text','image','frames']});
 assert.equal(effectiveVideoParameters(custom,{...base,parameters:{durationSeconds:30}}).durationSeconds,4,'Other Ark models keep the saved shot duration');
});

test('Seedance 2.5 validation accepts the documented range and rejects values outside the exact model',()=>{
 const b=binding(),base=snapshot(b);
 for(const parameters of [{durationSeconds:30,aspectRatio:'21:9',resolution:'1080p',generateAudio:true},{durationSeconds:-1,aspectRatio:'adaptive',resolution:'480p',generateAudio:false},{durationSeconds:4,aspectRatio:'1:1',resolution:'720p'}])assert.equal(validateVideoSnapshot(b,{...base,parameters}),true,JSON.stringify(parameters));
 assert.equal(getGenerationIssue({...base,parameters:{durationSeconds:30,aspectRatio:'21:9',resolution:'1080p'}},videoBindingCapabilities(b)),null);
 for(const parameters of [{durationSeconds:3},{durationSeconds:31},{durationSeconds:2.5},{aspectRatio:'5:4'},{resolution:'4k'},{seed:1},{promptExtend:true},{watermark:false},{generateAudio:'true'}])assert.throws(()=>validateVideoSnapshot(b,{...base,parameters:{resolution:'720p',...parameters}}),{code:'UNSUPPORTED_PARAMETERS'},JSON.stringify(parameters));
 const paired=binding({durationResolutionMap:[{duration:[4,5],resolution:['720p']},{duration:[30],resolution:['1080p']}]});
 assert.throws(()=>validateVideoSnapshot(paired,{...snapshot(paired),parameters:{durationSeconds:30,resolution:'720p'}}),{code:'UNSUPPORTED_PARAMETERS'});
 assert.equal(validateVideoSnapshot(paired,{...snapshot(paired),parameters:{durationSeconds:-1,resolution:'720p'}}),true);
 assert.equal(validateVideoSnapshot(b,{...base,prompt:'一'.repeat(5000)}),true);
 assert.throws(()=>validateVideoSnapshot(b,{...base,prompt:'一'.repeat(5001)}),{code:'INVALID_PROMPT',message:'请输入不超过 5000 字符的提示词。'});
 assert.throws(()=>validateVideoSnapshot(b,{...base,prompt:' '}),{code:'INVALID_PROMPT'});
 assert.throws(()=>validateVideoSnapshot(binding({modelId:'custom-seedance-model',inputModes:['text','image','frames']}),{...base,model:'custom-seedance-model',prompt:'a'.repeat(1001)}),{code:'INVALID_PROMPT',message:'请输入不超过 1000 字符的提示词。'});
});

test('Seedance 2.5 frames match a fixed ratio, while adaptive accepts any frame inside Ark’s 0.4–2.5 range',()=>{
 const b=binding(),square=image('first_frame',960,960);
 assert.throws(()=>validateVideoSnapshot(b,snapshot(b,{referenceAssets:[square]})),{code:'REFERENCE_ASPECT_RATIO_MISMATCH'});
 assert.equal(validateVideoSnapshot(b,snapshot(b,{referenceAssets:[square],parameters:{resolution:'720p',aspectRatio:'1:1'}})),true);
 assert.equal(validateVideoSnapshot(b,snapshot(b,{referenceAssets:[square],parameters:{resolution:'720p',aspectRatio:'adaptive'}})),true);
 for(const [width,height] of [[2600,1000],[1000,2600]])assert.throws(()=>validateVideoSnapshot(b,snapshot(b,{referenceAssets:[image('first_frame',width,height)],parameters:{resolution:'720p',aspectRatio:'adaptive'}})),{code:'REFERENCE_ASPECT_RATIO_MISMATCH'});
 const pair=[image('first_frame',1440,1080),image('last_frame',1440,1080)];
 assert.equal(validateVideoSnapshot(b,snapshot(b,{referenceAssets:pair,parameters:{resolution:'1080p',aspectRatio:'4:3',durationSeconds:12}})),true);
});

test('the request schema lets Ark connections carry generation duration and ratio, never Wan-only fields',()=>{
 const b=binding(),request={shotId:randomUUID(),expectedRevision:1,requestId:'synthetic-request',providerId:'ark',connectionId:b.connectionId,configurationRevision:1,modelEntryId:b.model.id};
 for(const parameters of [{durationSeconds:30},{durationSeconds:-1,aspectRatio:'adaptive'},{aspectRatio:'21:9',resolution:'1080p',generateAudio:true}])assert.equal(schemas['generation.submit'].safeParse({...request,parameters}).success,true,JSON.stringify(parameters));
 for(const parameters of [{promptExtend:true},{watermark:false},{durationSeconds:31},{aspectRatio:'5:4'}])assert.equal(schemas['generation.submit'].safeParse({...request,parameters}).success,false,JSON.stringify(parameters));
 const legacy={shotId:request.shotId,expectedRevision:1,requestId:'synthetic-request',providerId:'ark'};
 for(const parameters of [{durationSeconds:30},{aspectRatio:'21:9'}])assert.equal(schemas['generation.submit'].safeParse({...legacy,parameters}).success,false,'The environment-configured provider keeps shot-only duration and ratio');
 assert.equal(schemas['generation.submit'].safeParse({...request,videoInput:{version:1,mode:'text',images:[]}}).success,true,'A configured Ark connection may carry an explicit input');
 assert.equal(schemas['generation.submit'].safeParse({...legacy,videoInput:{version:1,mode:'text',images:[]}}).success,false);
});

const references=(count:number,size:(index:number)=>[number,number]=index=>index%2?[1600,900]:[900,1600])=>Array.from({length:count},(_,index)=>image('reference_image',...size(index)));
const explicit=(assets:Array<{id:string}>)=>({version:1,mode:'reference_images',images:assets.map(asset=>({role:'reference_image',assetId:asset.id}))});

test('Seedance 2.5 takes 1–30 ordered reference images in any ratio inside 0.4–2.5, only through an explicit input',()=>{
 const b=binding(),profile=videoInputProfile(b),rule=profile.inputs.roles.reference_image!;
 assert.deepEqual(defaultVideoModels('ark')[0]!.inputModes,['text','image','frames','subject','reference']);
 assert.deepEqual({implemented:rule.implemented,min:rule.min,max:rule.max,dimensions:rule.dimensions},{implemented:true,min:1,max:30,dimensions:{min:300,max:6000,matchAspectRatio:false,minAspectRatio:.4,maxAspectRatio:2.5}});
 assert.equal(profile.inputs.maxReferences,30);assert.deepEqual(profile.inputs.combinations.at(-1),Array(30).fill('reference_image'));
 const capability=videoBindingCapabilities(b).modelCapabilities[0]!;
 assert.equal(capability.seedanceCapabilities?.referenceImages,30);assert.equal(capability.seedanceCapabilities?.maxEncodedImageBytes,60_000_000);assert.deepEqual(capability.referenceImages,{min:0,max:30});
 for(const count of [1,30]){const assets=references(count);assert.equal(validateVideoSnapshot(b,snapshot(b,{referenceAssets:assets,videoInput:explicit(assets),parameters:{resolution:'720p',aspectRatio:'16:9'}})),true,String(count));}
 const square=references(2,()=>[960,960]);
 assert.equal(validateVideoSnapshot(b,snapshot(b,{referenceAssets:square,videoInput:explicit(square)})),true,'Reference images need not match the 9:16 output');
 const many=references(31);
 assert.throws(()=>validateVideoSnapshot(b,snapshot(b,{referenceAssets:many,videoInput:explicit(many)})),{code:'UNSUPPORTED_INPUT_ROLE'});
 const group=references(2);
 assert.throws(()=>validateVideoSnapshot(b,snapshot(b,{referenceAssets:group})),{code:'INVALID_REFERENCE_MANIFEST',message:'参考生视频必须提供显式视频输入。'});
 for(const [width,height] of [[2600,1000],[1000,2600]]){const wide=[image('reference_image',width,height)];assert.throws(()=>validateVideoSnapshot(b,snapshot(b,{referenceAssets:wide,videoInput:explicit(wide)})),{code:'REFERENCE_ASPECT_RATIO_MISMATCH'});}
 const mixed=[image('first_frame'),image('reference_image')];
 assert.throws(()=>validateVideoSnapshot(b,snapshot(b,{referenceAssets:mixed,videoInput:{version:1,mode:'reference_images',images:mixed.map(asset=>({role:asset.role,assetId:asset.id}))}})),{code:'UNSUPPORTED_INPUT_ROLE'});
 assert.throws(()=>validateVideoSnapshot(b,snapshot(b,{referenceAssets:group,videoInput:explicit(group),subjectVersionId:randomUUID()})),{code:'UNSUPPORTED_INPUT_ROLE'});
 // A saved entry without the reference mode keeps working but cannot send a reference group.
 const saved=binding({inputModes:['text','image','frames','subject']});
 assert.equal(videoInputProfile(saved).inputs.maxReferences,2);assert.equal(videoInputProfile(saved).inputs.roles.reference_image,undefined);
 assert.throws(()=>validateVideoSnapshot(saved,snapshot(saved,{referenceAssets:group,videoInput:explicit(group)})),{code:'UNSUPPORTED_INPUT_ROLE'});
 const request={shotId:randomUUID(),expectedRevision:1,requestId:'synthetic-request',providerId:'ark',connectionId:b.connectionId,configurationRevision:1,modelEntryId:b.model.id};
 assert.equal(schemas['generation.submit'].safeParse({...request,videoInput:explicit(references(30))}).success,true);
 assert.equal(schemas['generation.submit'].safeParse({...request,videoInput:explicit(references(31))}).success,false);
 // The saved shot prompt is the prompt sent; a separate prompt belongs to Wan 3.0 only.
 assert.equal(schemas['generation.submit'].safeParse({...request,videoInput:{...explicit(group),prompt:'@图片1 在左，@图片2 在右'}}).success,false);
 assert.throws(()=>validateVideoSnapshot(b,snapshot(b,{referenceAssets:group,videoInput:{...explicit(group),prompt:'@图片1'}})),{code:'INVALID_PROMPT'});
});

test('only the exact Seedance 2.5 row may save the reference mode',()=>{
 assert.equal(videoConnectionConfigurationSchema.safeParse(configured(binding())).success,true);
 for(const modelId of ['custom-seedance-model','doubao-seedance-2-0-260128'])assert.equal(videoConnectionConfigurationSchema.safeParse(configured(binding({modelId,inputModes:['text','reference'],durationResolutionMap:[{duration:[4,8],resolution:['720p']}]}))).success,false,modelId);
 assert.equal(videoConnectionConfigurationSchema.safeParse(configured(binding({modelId:'custom-seedance-model',inputModes:['text','image','frames'],durationResolutionMap:[{duration:[4,8],resolution:['720p']}]}))).success,true);
});

test('Seedance 2.5 keeps the encoded reference images within 60,000,000 bytes of Ark’s 64 MB request body',()=>{
 const b=binding();
 // Each PNG data URI adds a 22-byte header to 4/3 of its bytes, rounded up to whole Base64 groups.
 const sized=(sizes:number[])=>sizes.map(sizeBytes=>({...image('reference_image',900,1600),sizeBytes}));
 const exact=sized([7_499_985,7_499_985,7_499_985,7_499_985,7_499_985,7_499_976]);
 assert.equal(exact.reduce((total,asset)=>total+22+4*Math.ceil(asset.sizeBytes/3),0),60_000_000);
 assert.equal(validateVideoSnapshot(b,snapshot(b,{referenceAssets:exact,videoInput:explicit(exact)})),true);
 const over=sized([7_499_985,7_499_985,7_499_985,7_499_985,7_499_985,7_499_977]);
 assert.throws(()=>validateVideoSnapshot(b,snapshot(b,{referenceAssets:over,videoInput:explicit(over)})),{code:'REFERENCE_REQUEST_TOO_LARGE'});
 const largest=sized(Array(5).fill(10*1024*1024));
 assert.throws(()=>validateVideoSnapshot(b,snapshot(b,{referenceAssets:largest,videoInput:explicit(largest)})),{code:'REFERENCE_REQUEST_TOO_LARGE'});
 assert.equal(validateVideoSnapshot(b,snapshot(b,{referenceAssets:largest.slice(0,4),videoInput:explicit(largest.slice(0,4))})),true,'Four 10 MiB images still fit');
});
