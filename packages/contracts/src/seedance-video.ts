/** Reviewed Seedance 2.5 capabilities for the existing ark-v3 protocol. Only the
 * exact model, region and protocol row below enables generation-level duration
 * and ratio; model names never grant capabilities by prefix. */
export const SEEDANCE25_MODEL_ID='doubao-seedance-2-5-260628';
export const SEEDANCE25_PROTOCOL_VERSION='ark-v3';
export const SEEDANCE25_REVIEWED_ON='2026-10-30';
export const SEEDANCE25_SOURCE='https://ark.volcengine.com/region:cn-beijing/docs/create-video-generation-task-api';

export interface Seedance25Capability {
 modelId:typeof SEEDANCE25_MODEL_ID;region:'cn-beijing';protocolVersion:typeof SEEDANCE25_PROTOCOL_VERSION;
 source:string;reviewedOn:string;smartDuration:true;adaptiveAspectRatio:true;maxPromptLength:5000;
 minAspectRatio:0.4;maxAspectRatio:2.5;
 durationsSeconds:readonly number[];aspectRatios:readonly string[];resolutions:readonly string[];
 defaults:Readonly<{resolution:'720p';generateAudio:false}>;
}

// Ark documents 4–30 seconds or -1 (the model chooses), six fixed ratios plus
// adaptive, and 480p/720p (8-bit) or 1080p (10-bit HEVC) output. It sets no hard
// prompt limit, so the shot prompt field's own 5000 code units apply. Audio is
// off unless the user turns it on; Ark's own default would be on.
export const SEEDANCE25_CAPABILITIES:readonly Seedance25Capability[]=Object.freeze([Object.freeze({
 modelId:SEEDANCE25_MODEL_ID,region:'cn-beijing' as const,protocolVersion:SEEDANCE25_PROTOCOL_VERSION,
 source:SEEDANCE25_SOURCE,reviewedOn:SEEDANCE25_REVIEWED_ON,smartDuration:true as const,adaptiveAspectRatio:true as const,
 maxPromptLength:5000 as const,minAspectRatio:0.4 as const,maxAspectRatio:2.5 as const,
 durationsSeconds:Object.freeze(Array.from({length:27},(_,index)=>index+4)),
 aspectRatios:Object.freeze(['9:16','16:9','1:1','3:4','4:3','21:9']),
 resolutions:Object.freeze(['720p','480p','1080p']),
 defaults:Object.freeze({resolution:'720p' as const,generateAudio:false as const}),
})]);

export function getSeedance25Capability(modelId:string,region:string,templateId:string):Seedance25Capability|undefined {
 return SEEDANCE25_CAPABILITIES.find(capability=>capability.modelId===modelId&&capability.region===region&&capability.protocolVersion===templateId);
}
export function isSeedance25Binding(binding:{providerId:string;region:string;model:{modelId:string;templateId:string}}):boolean {
 return binding.providerId==='ark'&&Boolean(getSeedance25Capability(binding.model.modelId,binding.region,binding.model.templateId));
}
