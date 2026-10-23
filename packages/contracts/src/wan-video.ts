import {z} from 'zod';

export const WAN30_MODEL_IDS=['wan3.0-video','wan3.0-video-prime'] as const;
export const WAN30_PROTOCOL_VERSION='wan30-v1';
export const WAN30_REVIEWED_ON='2026-10-23';
export const WAN30_SOURCE='https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference';
export const WAN30_INPUT_MODES=['text','first_frame','first_last_frame','reference_images'] as const;
export const wanVideoInputSchema=z.object({
 version:z.literal(1),mode:z.enum(WAN30_INPUT_MODES),
 images:z.array(z.object({role:z.enum(['first_frame','last_frame','reference_image']),assetId:z.string().uuid()}).strict()).max(10),
 prompt:z.string().max(20000).optional(),
}).strict().superRefine((value,ctx)=>{
 const roles=value.images.map(image=>image.role),expected=value.mode==='text'?[]:value.mode==='first_frame'?['first_frame']:value.mode==='first_last_frame'?['first_frame','last_frame']:null;
 if(expected?JSON.stringify(roles)!==JSON.stringify(expected):!roles.length||roles.some(role=>role!=='reference_image'))ctx.addIssue({code:'custom',path:['images'],message:'Images must exactly match the selected video input mode and order.'});
 if(new Set(value.images.map(image=>image.assetId)).size!==value.images.length)ctx.addIssue({code:'custom',path:['images'],message:'Video input images must be distinct.'});
});
export type WanVideoInput=z.infer<typeof wanVideoInputSchema>;
export const wanVideoParametersSchema=z.object({
 durationSeconds:z.union([z.literal(-1),z.number().int().min(2).max(30)]).optional(),
 aspectRatio:z.enum(['adaptive','9:16','16:9','1:1','3:4','4:3','21:9']).optional(),
 promptExtend:z.boolean().optional(),watermark:z.boolean().optional(),
});
export type WanVideoParameters=z.infer<typeof wanVideoParametersSchema>;
export const videoGenerationParametersSchema=wanVideoParametersSchema.extend({
 seed:z.number().int().optional(),resolution:z.string().min(1).max(20).optional(),generateAudio:z.boolean().optional(),
}).strict();
export type VideoGenerationParameters=z.infer<typeof videoGenerationParametersSchema>;

export interface Wan30Capability {
 modelId:typeof WAN30_MODEL_IDS[number];region:string;protocolVersion:typeof WAN30_PROTOCOL_VERSION;
 source:string;reviewedOn:string;smartDuration:true;adaptiveAspectRatio:true;
 referenceImages:10;maxPromptLength:20000;maxImageBytes:20000000;minDimension:240;maxDimension:8000;maxAspectRatio:8;
 durationsSeconds:readonly number[];aspectRatios:readonly string[];resolutions:readonly string[];
 defaults:Readonly<{durationSeconds:5;resolution:'720P';generateAudio:true;promptExtend:true;watermark:false}>;
}
const wan30Defaults=Object.freeze({durationSeconds:5 as const,resolution:'720P' as const,generateAudio:true as const,promptExtend:true as const,watermark:false as const});
const wan30Durations=Object.freeze(Array.from({length:29},(_,index)=>index+2));
const wan30AspectRatios=Object.freeze(['9:16','16:9','1:1','3:4','4:3','21:9']);
const wan30Resolutions=Object.freeze(['720P','480P','1080P']);
/** Reviewed exact model/region/protocol rows; model names never grant capabilities by prefix. */
export const WAN30_CAPABILITIES:readonly Wan30Capability[]=Object.freeze(WAN30_MODEL_IDS.flatMap(modelId=>['cn-beijing','ap-southeast-1'].map(region=>Object.freeze({
 modelId,region,protocolVersion:WAN30_PROTOCOL_VERSION,source:WAN30_SOURCE,reviewedOn:WAN30_REVIEWED_ON,
 smartDuration:true as const,adaptiveAspectRatio:true as const,referenceImages:10 as const,maxPromptLength:20000 as const,
 maxImageBytes:20000000 as const,minDimension:240 as const,maxDimension:8000 as const,maxAspectRatio:8 as const,
 durationsSeconds:wan30Durations,aspectRatios:wan30AspectRatios,resolutions:wan30Resolutions,defaults:wan30Defaults,
}))));
export function getWan30Capability(modelId:string,region:string,templateId:string):Wan30Capability|undefined {
 return WAN30_CAPABILITIES.find(capability=>capability.modelId===modelId&&capability.region===region&&capability.protocolVersion===templateId);
}
export function isWan30Binding(binding:{providerId:string;region:string;model:{modelId:string;templateId:string}}):boolean {
 return binding.providerId==='wan'&&Boolean(getWan30Capability(binding.model.modelId,binding.region,binding.model.templateId));
}

/** Resolve new-request defaults once at admission; frozen tasks keep their original parameters. */
export function resolveWanGenerationParameters(
 model:{aspectRatios:readonly string[];durationResolutionMap:readonly {duration:readonly number[];resolution:readonly string[]}[]},
 defaults:{durationSeconds:number;resolution:string;generateAudio:boolean;promptExtend:boolean;watermark:boolean},
 snapshot:{aspectRatio?:unknown;parameters?:unknown},overrides:Record<string,unknown>={},
):Record<string,unknown> {
 const saved=snapshot.parameters&&typeof snapshot.parameters==='object'&&!Array.isArray(snapshot.parameters)?snapshot.parameters as Record<string,unknown>:{};
 const specified=Object.fromEntries(Object.entries({...saved,...overrides}).filter(([,value])=>value!==undefined));
 const durations=model.durationResolutionMap.flatMap(pair=>pair.duration);
 const durationSeconds=durations.includes(defaults.durationSeconds)?defaults.durationSeconds:durations[0];
 const requestedDuration=specified.durationSeconds??durationSeconds;
 const resolutions=model.durationResolutionMap.filter(pair=>requestedDuration===-1||pair.duration.includes(Number(requestedDuration))).flatMap(pair=>pair.resolution);
 const resolution=resolutions.includes(defaults.resolution)?defaults.resolution:resolutions[0];
 const aspectRatio=model.aspectRatios.includes(snapshot.aspectRatio as string)?snapshot.aspectRatio:model.aspectRatios[0];
 return {durationSeconds,resolution,aspectRatio,generateAudio:defaults.generateAudio,promptExtend:defaults.promptExtend,watermark:defaults.watermark,...specified};
}

/** Automatic values belong to the generation request, never the saved shot's fixed fields. */
export function effectiveVideoParameters(binding:{providerId:string;region:string;model:{modelId:string;templateId:string;durationResolutionMap:Array<{duration:number[];resolution:string[]}>}},snapshot:{prompt?:unknown;duration?:unknown;aspectRatio?:unknown;parameters?:unknown;videoInput?:unknown}) {
 const parameters=snapshot.parameters&&typeof snapshot.parameters==='object'&&!Array.isArray(snapshot.parameters)?snapshot.parameters as Record<string,unknown>:{},capability=binding.providerId==='wan'?getWan30Capability(binding.model.modelId,binding.region,binding.model.templateId):undefined,wan30=Boolean(capability);
 const input=snapshot.videoInput&&typeof snapshot.videoInput==='object'?snapshot.videoInput as {prompt?:unknown}:undefined;
 const durationSeconds=wan30?parameters.durationSeconds??snapshot.duration:snapshot.duration;
 return {
  prompt:(wan30&&input?.prompt!==undefined?input.prompt:snapshot.prompt)??(wan30?'':undefined),
  durationSeconds,aspectRatio:wan30?parameters.aspectRatio??snapshot.aspectRatio:snapshot.aspectRatio,
  resolution:parameters.resolution??binding.model.durationResolutionMap.find(pair=>pair.duration.includes(durationSeconds as number))?.resolution[0]??(wan30&&durationSeconds===-1?binding.model.durationResolutionMap[0]?.resolution[0]:undefined),
  generateAudio:parameters.generateAudio??capability?.defaults.generateAudio,promptExtend:parameters.promptExtend??capability?.defaults.promptExtend,watermark:parameters.watermark??capability?.defaults.watermark,seed:parameters.seed,
 };
}
