import {z} from 'zod';
import {AppError} from './app-error.ts';
import {getCapabilityProfile,INPUT_ROLES} from './generation-input-profiles.ts';
import type {GenerationInputProfile} from './generation-input-profiles.ts';

export const VIDEO_PROVIDER_IDS=['runway','ark','veo','minimax','vidu','kling','wan'] as const;
export type VideoProviderId=typeof VIDEO_PROVIDER_IDS[number];
// Keep historical protocol IDs readable while limiting the suppliers offered in the UI.
export const VIDEO_CATALOG_PROVIDER_IDS=VIDEO_PROVIDER_IDS.filter(id=>id!=='runway');
export const isVideoCatalogProvider=(id:string):boolean=>VIDEO_CATALOG_PROVIDER_IDS.some(providerId=>providerId===id);
export const VIDEO_TEMPLATE_IDS=['runway-v1','ark-v3','veo-v1','minimax-v2','vidu-v2','kling-v1','wan27-t2v','wan27-i2v'] as const;
export type VideoTemplateId=typeof VIDEO_TEMPLATE_IDS[number];
export const VIDEO_INPUT_MODES=['text','image','frames','subject'] as const;
export type VideoInputMode=typeof VIDEO_INPUT_MODES[number];
export const VIDEO_ASPECT_RATIOS=['9:16','16:9','1:1','3:4','4:3','21:9'] as const;
export const VIDEO_SETTINGS_LIMITS={updateBytes:256*1024,fileBytes:4*1024*1024,connections:32,models:64,credentials:256} as const;
export const VIDEO_SECRET_NAMESPACE='mioon.video.providers.v1';
export const VIDEO_INPUT_PROFILE_VERSION='mioon-video-input/1';
const name=z.string().trim().min(1).max(120),modelId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/),host=z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);
export const videoModelEntrySchema=z.object({
 id:z.string().uuid(),name,modelId,templateId:z.enum(VIDEO_TEMPLATE_IDS),enabled:z.boolean(),archived:z.boolean(),
 inputModes:z.array(z.enum(VIDEO_INPUT_MODES)).min(1).max(4),aspectRatios:z.array(z.enum(VIDEO_ASPECT_RATIOS)).min(1).max(6),
 durationResolutionMap:z.array(z.object({duration:z.array(z.number().int().min(1).max(20)).min(1).max(20),resolution:z.array(z.string().min(1).max(20)).min(1).max(8)}).strict()).min(1).max(20),
 audio:z.enum(['default','off','on','optional']),seed:z.boolean(),
}).strict();
export type VideoModelEntry=z.infer<typeof videoModelEntrySchema>;
export interface VideoTemplate {
 id:VideoTemplateId;providerId:VideoProviderId;inputModes:readonly VideoInputMode[];aspectRatios:readonly string[];
 durations:readonly number[];resolutions:readonly string[];audio:readonly VideoModelEntry['audio'][];seed:boolean;
 maxImageBytes:number;minDimension:number;maxDimension:number;mimeTypes:readonly string[];defaultOutputHosts:readonly string[];
}
const range=(min:number,max:number)=>Array.from({length:max-min+1},(_,i)=>i+min);
const image={maxImageBytes:10*1024*1024,minDimension:1,maxDimension:16384,mimeTypes:['image/png','image/jpeg']};
export const VIDEO_TEMPLATES:readonly VideoTemplate[]=Object.freeze([
 {id:'runway-v1',providerId:'runway',inputModes:['image'],aspectRatios:VIDEO_ASPECT_RATIOS,durations:range(2,10),resolutions:['720p'],audio:['default'],seed:true,...image,maxImageBytes:3932160,mimeTypes:['image/png','image/jpeg','image/webp'],defaultOutputHosts:['dnznrvs05pmza.cloudfront.net']},
 {id:'ark-v3',providerId:'ark',inputModes:['text','image','frames','subject'],aspectRatios:['9:16','16:9'],durations:[4,8],resolutions:['720p'],audio:['off'],seed:false,...image,minDimension:300,maxDimension:6000,defaultOutputHosts:['ark-content-generation-cn-beijing.tos-cn-beijing.volces.com','ark-acg-cn-beijing.tos-cn-beijing.volces.com']},
 {id:'veo-v1',providerId:'veo',inputModes:['text','image'],aspectRatios:['9:16','16:9'],durations:[4,6,8],resolutions:['720p'],audio:['on'],seed:false,...image,defaultOutputHosts:['generativelanguage.googleapis.com']},
 {id:'minimax-v2',providerId:'minimax',inputModes:['text','image'],aspectRatios:['9:16','16:9'],durations:[4,8],resolutions:['768P'],audio:['default'],seed:false,...image,minDimension:256,maxDimension:5760,defaultOutputHosts:['cdn.hailuoai.com','video-product.cdn.minimax.io']},
 {id:'vidu-v2',providerId:'vidu',inputModes:['text','image'],aspectRatios:['9:16','16:9'],durations:[4,8],resolutions:['720p'],audio:['off'],seed:false,...image,maxImageBytes:9999999,defaultOutputHosts:[]},
 {id:'kling-v1',providerId:'kling',inputModes:['text','image'],aspectRatios:['9:16','16:9','1:1'],durations:range(3,15),resolutions:['720p','1080p','4k'],audio:['off','on','optional'],seed:false,...image,minDimension:300,defaultOutputHosts:[]},
 {id:'wan27-t2v',providerId:'wan',inputModes:['text'],aspectRatios:['9:16','16:9','1:1','3:4','4:3'],durations:range(2,15),resolutions:['720P','1080P'],audio:['default'],seed:true,...image,minDimension:240,maxDimension:8000,defaultOutputHosts:[]},
 {id:'wan27-i2v',providerId:'wan',inputModes:['image'],aspectRatios:['9:16','16:9','1:1','3:4','4:3'],durations:range(2,15),resolutions:['720P','1080P'],audio:['default'],seed:true,...image,minDimension:240,maxDimension:8000,defaultOutputHosts:[]},
]);
export const VIDEO_REGIONS:Readonly<Record<VideoProviderId,readonly string[]>>={runway:['global'],ark:['cn-beijing'],veo:['global'],minimax:['global','cn'],vidu:['global','cn'],kling:['global','cn'],wan:['cn-beijing','ap-southeast-1']};
export const VIDEO_PROVIDER_NAMES:Readonly<Record<VideoProviderId,string>>={runway:'Runway',ark:'Seedance · 火山方舟',veo:'Google Veo',minimax:'MiniMax',vidu:'Vidu',kling:'Kling · 可灵',wan:'Wan · 通义万相'};
export const videoConnectionConfigurationSchema=z.object({
 id:z.string().uuid(),providerId:z.enum(VIDEO_PROVIDER_IDS),name,region:z.string().min(1).max(40),workspaceId:z.string().regex(/^[A-Za-z0-9_-]{0,80}$/),
 enabled:z.boolean(),archived:z.boolean(),outputHosts:z.array(host).max(32),models:z.array(videoModelEntrySchema).max(VIDEO_SETTINGS_LIMITS.models),
}).strict().superRefine((value,ctx)=>{
 if(!VIDEO_REGIONS[value.providerId].includes(value.region))ctx.addIssue({code:'custom',path:['region'],message:'Unsupported official region.'});
 if(value.providerId!=='wan'&&value.workspaceId)ctx.addIssue({code:'custom',path:['workspaceId'],message:'This provider does not use a workspace ID.'});
 if(new Set(value.models.map(model=>model.id)).size!==value.models.length)ctx.addIssue({code:'custom',path:['models'],message:'Duplicate model entry identity.'});
 for(const [index,model] of value.models.entries()){
  const template=VIDEO_TEMPLATES.find(item=>item.id===model.templateId);
  if(!template||template.providerId!==value.providerId||model.inputModes.some(mode=>!template.inputModes.includes(mode))||model.aspectRatios.some(ratio=>!template.aspectRatios.includes(ratio))||!template.audio.includes(model.audio)||model.seed&&!template.seed||model.durationResolutionMap.some(pair=>pair.duration.some(duration=>!template.durations.includes(duration))||pair.resolution.some(resolution=>!template.resolutions.includes(resolution))))ctx.addIssue({code:'custom',path:['models',index],message:'Model capabilities exceed the selected implemented protocol.'});
  if(model.inputModes.includes('subject')&&model.modelId!=='doubao-seedance-2-5-260628')ctx.addIssue({code:'custom',path:['models',index,'inputModes'],message:'Subject reference is implemented only for the existing exact Seedance model.'});
 }
});
export type VideoConnectionConfiguration=z.infer<typeof videoConnectionConfigurationSchema>;
export const videoSecretUpdateSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('keep')}).strict(),z.object({action:z.literal('remove')}).strict(),
 z.object({action:z.literal('replace'),value:z.string().min(1).max(8192).refine(value=>value===value.trim()&&!/[\u0000-\u0020\u007f]/.test(value),'Invalid API key.'),storage:z.enum(['session','persistent'])}).strict(),
]);
export type VideoSecretUpdate=z.infer<typeof videoSecretUpdateSchema>;
export const videoSettingsUpdateSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('save'),expectedRevision:z.number().int().nonnegative(),configuration:videoConnectionConfigurationSchema,secret:videoSecretUpdateSchema}).strict(),
 z.object({action:z.literal('archive'),expectedRevision:z.number().int().nonnegative(),connectionId:z.string().uuid()}).strict(),
 z.object({action:z.literal('restoreCredential'),expectedRevision:z.number().int().nonnegative(),connectionId:z.string().uuid(),credentialRef:z.string().uuid(),secret:z.object({action:z.literal('replace'),value:z.string().min(1).max(8192).refine(value=>value===value.trim()&&!/[\u0000-\u0020\u007f]/.test(value)),storage:z.enum(['session','persistent'])}).strict()}).strict(),
]);
export type VideoSettingsUpdate=z.infer<typeof videoSettingsUpdateSchema>;
export interface VideoStorage {persistentAvailable:boolean;sessionScope:'app'|'server';reasonCode:string|null}
export interface VideoCredentialView {ref:string;region:string;endpoint:string;configured:boolean;storage:'none'|'session'|'persistent'}
export interface VideoConnectionView {
 configuration:VideoConnectionConfiguration;revision:number;credentialRef:string|null;
 secret:{configured:boolean;storage:'none'|'session'|'persistent'};credentials:VideoCredentialView[];
}
export interface VideoSettingsSnapshot {revision:number;connections:VideoConnectionView[];storage:VideoStorage}
export const videoExecutionBindingSchema=z.object({
 version:z.literal(1),connectionId:z.string().uuid(),configurationRevision:z.number().int().positive(),providerId:z.enum(VIDEO_PROVIDER_IDS),
 region:z.string().min(1).max(40),workspaceId:z.string().regex(/^[A-Za-z0-9_-]{0,80}$/),endpoint:z.string().min(1).max(300),credentialRef:z.string().uuid(),
 model:videoModelEntrySchema,outputHosts:z.array(host).max(32),
}).strict();
export type VideoExecutionBinding=z.infer<typeof videoExecutionBindingSchema>;
export function videoSettingsError(code='VIDEO_SETTINGS_VALIDATION',message='视频供应商配置无效。',status=400):AppError{return new AppError(code,message,status);}
export function resolveVideoEndpoint(providerId:VideoProviderId,region:string,workspaceId=''):string {
 if(!VIDEO_REGIONS[providerId]?.includes(region)||!/^[A-Za-z0-9_-]{0,80}$/.test(workspaceId)||providerId!=='wan'&&workspaceId)throw videoSettingsError();
 switch(providerId){
  case 'runway':return 'https://api.dev.runwayml.com';
  case 'ark':return 'https://ark.cn-beijing.volces.com/api/v3';
  case 'veo':return 'https://generativelanguage.googleapis.com/v1beta';
  case 'minimax':return region==='cn'?'https://api.minimax.cn':'https://api.minimax.io';
  case 'vidu':return region==='cn'?'https://api.vidu.cn':'https://api.vidu.com';
  case 'kling':return region==='cn'?'https://api-beijing.klingai.com':'https://api-singapore.klingai.com';
  case 'wan':return `${workspaceId?`https://${workspaceId}.${region}.maas.aliyuncs.com`:region==='cn-beijing'?'https://dashscope.aliyuncs.com':'https://dashscope-intl.aliyuncs.com'}/api/v1`;
 }
}
export function parseVideoBinding(value:unknown):VideoExecutionBinding {
 const parsed=videoExecutionBindingSchema.safeParse(value);if(!parsed.success)throw videoSettingsError('VIDEO_BINDING_INVALID','视频任务连接绑定无效。');
 const binding=parsed.data;
 videoConnectionConfigurationSchema.parse({id:binding.connectionId,providerId:binding.providerId,name:'bound',region:binding.region,workspaceId:binding.workspaceId,enabled:true,archived:false,models:[binding.model],outputHosts:binding.outputHosts});
 if(binding.endpoint!==resolveVideoEndpoint(binding.providerId,binding.region,binding.workspaceId))throw videoSettingsError('VIDEO_BINDING_INVALID','视频任务必须使用绑定的原厂端点。');
 return binding;
}
export const videoTemplate=(id:VideoTemplateId):VideoTemplate=>{const template=VIDEO_TEMPLATES.find(item=>item.id===id);if(!template)throw videoSettingsError();return template;};
export function videoOutputHosts(binding:VideoExecutionBinding):string[]{return [...new Set([...videoTemplate(binding.model.templateId).defaultOutputHosts,...binding.outputHosts])];}
export function defaultVideoModels(providerId:VideoProviderId):VideoModelEntry[]{
 const modelNames:Record<VideoProviderId,string[]>={runway:['gen4_turbo'],ark:['doubao-seedance-2-5-260628'],veo:['veo-3.1-generate-preview'],minimax:['MiniMax-H3'],vidu:['viduq3-turbo'],kling:['kling-3.0'],wan:['wan2.7-t2v','wan2.7-i2v']};
 return VIDEO_TEMPLATES.filter(template=>template.providerId===providerId).map((template,index)=>({id:crypto.randomUUID(),name:modelNames[providerId][index]!,modelId:modelNames[providerId][index]!,templateId:template.id,enabled:true,archived:false,inputModes:[...template.inputModes],aspectRatios:[...template.aspectRatios] as VideoModelEntry['aspectRatios'],durationResolutionMap:[{duration:providerId==='kling'?[5,10]:providerId==='wan'?[5,10,15]:[...template.durations],resolution:[template.resolutions[0]!]}],audio:template.audio[0]!,seed:template.seed}));
}

/** Capability data is compiled from the bounded, backend-owned connection, never from a generation request. */
export function videoInputProfile(binding:VideoExecutionBinding):GenerationInputProfile {
 const template=videoTemplate(binding.model.templateId),model=binding.model,original=getCapabilityProfile(binding.providerId,model.modelId,binding.region);
 const roles=Object.fromEntries(INPUT_ROLES.map(role=>[role,{implemented:false,min:0,max:0,reason:'This video protocol does not implement this reference role.'}])) as GenerationInputProfile['inputs']['roles'];
 const constraints={mimeTypes:[...template.mimeTypes],maxBytes:template.maxImageBytes,maxBytesSource:'Mioon video protocol limit',dimensions:{min:template.minDimension,max:template.maxDimension,matchAspectRatio:true}};
 if(model.inputModes.some(mode=>mode==='image'||mode==='frames'))roles.first_frame={...constraints,implemented:true,min:model.inputModes.includes('text')?0:1,max:1};
 if(model.inputModes.includes('frames'))roles.last_frame={...constraints,implemented:true,min:0,max:1};
 if(model.inputModes.includes('subject'))roles.subject_reference={...constraints,implemented:true,min:0,max:1,dimensions:{...constraints.dimensions,matchAspectRatio:false,minAspectRatio:.4,maxAspectRatio:2.5}};
 const combinations:string[][]=[];
 if(model.inputModes.includes('text'))combinations.push([]);
 if(model.inputModes.includes('image'))combinations.push(['first_frame']);
 if(model.inputModes.includes('frames'))combinations.push(['first_frame','last_frame']);
 if(model.inputModes.includes('subject'))combinations.push(['subject_reference']);
 return {profileVersion:original&&model.inputModes.includes('subject')?original.profileVersion:VIDEO_INPUT_PROFILE_VERSION,profileId:original&&model.inputModes.includes('subject')?original.profileId:`video:${binding.connectionId}:${binding.configurationRevision}:${model.id}`,
  reviewedOn:'2026-10-20',implemented:true,liveVerified:false,runtimeAvailability:'configured',prompt:{required:true,maxCodeUnits:1000},aspectRatios:[...model.aspectRatios],durationsSeconds:[...new Set(model.durationResolutionMap.flatMap(pair=>pair.duration))],parameters:{...(model.seed?{seed:{type:'integer' as const,min:0,max:binding.providerId==='wan'?2147483647:4294967295}}:{}),resolution:{type:'enum',values:[...new Set(model.durationResolutionMap.flatMap(pair=>pair.resolution))]}},approvalRequired:true,requiresManagedImageVerification:true,
  providerId:binding.providerId,model:model.modelId,regions:[binding.region],regionMeaning:'Explicit official API region; credentials must match.',apiFamily:model.templateId,origins:{[binding.region]:binding.endpoint},adapterSource:'packages/business/src/video/runtime.ts',inputModes:[...new Set(model.inputModes.map(mode=>mode==='frames'?'image':mode))],output:{audio:model.audio},inputs:{minReferences:Math.min(...combinations.map(combination=>combination.length)),maxReferences:Math.max(...combinations.map(combination=>combination.length)),combinations,roles},...(original?.lifecycle?{lifecycle:original.lifecycle}:{}),};
}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function validateVideoSnapshot(bindingValue:VideoExecutionBinding,snapshot:unknown,{asOf=new Date().toISOString().slice(0,10)}:{}&{asOf?:string}={}):true {
 const binding=parseVideoBinding(bindingValue),model=binding.model,template=videoTemplate(model.templateId);
 const fail=(code:string,message:string):never=>{throw new AppError(code,message,400);};
 if(!object(snapshot)||snapshot.model!==model.modelId||snapshot.providerId!==undefined&&snapshot.providerId!==binding.providerId)fail('VIDEO_BINDING_INVALID','生成模型与冻结连接不一致。');
 const value=snapshot as Record<string,unknown>,profile=videoInputProfile(binding),params=value.parameters??{};
 if(profile.lifecycle&&asOf>=profile.lifecycle.earliestShutdownDate)fail('MODEL_LIFECYCLE_REVALIDATION_REQUIRED','此视频模型已到达需要重新核验的日期。');
 if(typeof value.prompt!=='string'||!value.prompt.trim()||value.prompt.length>1000)fail('INVALID_PROMPT','请输入不超过 1000 字符的提示词。');
 if(!model.aspectRatios.includes(value.aspectRatio as VideoModelEntry['aspectRatios'][number])||!Number.isInteger(value.duration))fail('UNSUPPORTED_PARAMETERS','所选画幅或时长不受此模型支持。');
 if(!object(params)||Object.keys(params).some(key=>!['seed','resolution','generateAudio'].includes(key)))fail('UNSUPPORTED_PARAMETERS','此模型参数无效。');
 const parameters=params as Record<string,unknown>,resolution=parameters.resolution??model.durationResolutionMap.find(pair=>pair.duration.includes(value.duration as number))?.resolution[0];
 if(!model.durationResolutionMap.some(pair=>pair.duration.includes(value.duration as number)&&pair.resolution.includes(resolution as string)))fail('UNSUPPORTED_PARAMETERS','此时长与分辨率组合不受支持。');
 if(parameters.seed!==undefined&&(!model.seed||!Number.isSafeInteger(parameters.seed)||(parameters.seed as number)<0||(parameters.seed as number)>(binding.providerId==='wan'?2147483647:4294967295)))fail('UNSUPPORTED_PARAMETERS','此随机种子不受模型支持。');
 if(parameters.generateAudio!==undefined&&(model.audio!=='optional'||typeof parameters.generateAudio!=='boolean'))fail('UNSUPPORTED_PARAMETERS','此模型不支持切换音频。');
 const assets=value.referenceAssets;if(!Array.isArray(assets)||assets.length>2||assets.some(asset=>!object(asset)))fail('INVALID_REFERENCE_MANIFEST','参考图片清单无效。');
 const references=assets as Record<string,unknown>[],roles=references.map(asset=>asset.role??'first_frame');
 if(!profile.inputs.combinations.some(combination=>JSON.stringify(combination)===JSON.stringify(roles)))fail('UNSUPPORTED_INPUT_ROLE','此协议未实现所选参考图片组合。');
 if(new Set(references.map(asset=>asset.id)).size!==references.length)fail('INVALID_REFERENCE_MANIFEST','参考图片不能重复。');
 for(const [index,asset] of references.entries()){
  const role=roles[index] as string,rule=profile.inputs.roles[role],width=asset.width,height=asset.height;
  if(typeof asset.id!=='string'||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(asset.sha256)||!template.mimeTypes.includes(asset.mimeType as string)||!Number.isSafeInteger(asset.sizeBytes)||(asset.sizeBytes as number)<=0||(asset.sizeBytes as number)>template.maxImageBytes)fail('INVALID_REFERENCE_METADATA','参考图片格式、大小或哈希无效。');
  if(!Number.isInteger(width)||!Number.isInteger(height)||(width as number)<template.minDimension||(height as number)<template.minDimension||(width as number)>template.maxDimension||(height as number)>template.maxDimension)fail('INVALID_REFERENCE_DIMENSIONS','参考图片尺寸超出协议范围。');
  if(rule?.dimensions?.matchAspectRatio){const [w,h]=(value.aspectRatio as string).split(':').map(Number);if((width as number)*h!==(height as number)*w!)fail('REFERENCE_ASPECT_RATIO_MISMATCH','参考帧必须匹配所选画幅。');}
  if(role==='subject_reference'&&((width as number)/(height as number)<.4||(width as number)/(height as number)>2.5))fail('REFERENCE_ASPECT_RATIO_MISMATCH','主体图片比例超出支持范围。');
 }
 return true;
}
export function videoBindingCapabilities(binding:VideoExecutionBinding,{configured=true,enabled=true,asOf=new Date().toISOString().slice(0,10)}:{configured?:boolean;enabled?:boolean;asOf?:string}={}) {
 const model=binding.model,profile=videoInputProfile(binding),retired=Boolean(profile.lifecycle&&asOf>=profile.lifecycle.earliestShutdownDate),hosts=videoOutputHosts(binding),missing=[...(!configured?['API_KEY']:[]),...(!hosts.length?['OUTPUT_HOSTS']:[])];
 return {id:binding.providerId,providerId:binding.providerId,connectionId:binding.connectionId,configurationRevision:binding.configurationRevision,modelEntryId:model.id,name:model.name,models:[model.modelId],region:binding.region,providerRegion:binding.region,mock:false,configured:configured&&hosts.length>0,enabled,status:missing.length?'not_configured':!enabled?'disabled':'available',liveVerified:false,verification:'offline-tested-not-live',configuration:{missing},inputProfileVersion:'mioon-input-profiles/1',profileEvaluationDate:asOf,inputProfiles:[profile],inputProfileEvaluations:[{profileId:profile.profileId,evaluatedAsOf:asOf,ok:!retired,issues:retired?[{code:'MODEL_LIFECYCLE_REVALIDATION_REQUIRED',message:'此模型需要重新核验。'}]:[],warnings:[]}],modelCapabilities:[{id:model.modelId,name:model.name,inputModes:[...model.inputModes],aspectRatios:[...model.aspectRatios],durations:profile.durationsSeconds,resolutions:[...new Set(model.durationResolutionMap.flatMap(pair=>pair.resolution))],referenceImages:{min:profile.inputs.minReferences,max:profile.inputs.maxReferences},parameters:[...(model.seed?['seed']:[]),'resolution',...(model.audio==='optional'?['generateAudio']:[])],promptRequired:true,maxPromptLength:1000}],videoModel:model,videoConnection:{version:binding.version,connectionId:binding.connectionId,configurationRevision:binding.configurationRevision,providerId:binding.providerId,region:binding.region,workspaceId:binding.workspaceId,endpoint:binding.endpoint,outputHosts:binding.outputHosts}};
}
export interface VideoConnectionDescriptor {
 connectionId:string;configurationRevision:number;providerId:VideoProviderId;name:string;region:string;enabled:boolean;archived:boolean;configured:boolean;
 models:Array<{entry:VideoModelEntry;capabilities:ReturnType<typeof videoBindingCapabilities>}>;
}
/** Browser advisory only. Server selection resolves the real credential reference from its private settings. */
export function getVideoGenerationIssue(snapshot:unknown,capabilities:unknown):{code:string;message:string}|null {
 try{
  if(!object(capabilities)||!object(capabilities.videoConnection)||!object(capabilities.videoModel))return {code:'VIDEO_BINDING_INVALID',message:'视频连接能力尚未加载。'};
  const binding=parseVideoBinding({...capabilities.videoConnection,model:capabilities.videoModel,credentialRef:'00000000-0000-4000-8000-000000000000'});
  validateVideoSnapshot(binding,snapshot,{asOf:typeof capabilities.profileEvaluationDate==='string'?capabilities.profileEvaluationDate:undefined});return null;
 }catch(error){return {code:error instanceof AppError?error.code:'VIDEO_BINDING_INVALID',message:error instanceof AppError?error.message:'视频连接参数无效。'};}
}
