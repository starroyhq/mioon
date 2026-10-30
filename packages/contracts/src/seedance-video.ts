/** Reviewed Seedance 2.5 capabilities for the existing ark-v3 protocol. Only the
 * exact model, region and protocol row below enables generation-level duration
 * and ratio, ordered reference images and reference audio; model names never
 * grant capabilities by prefix. */
export const SEEDANCE25_MODEL_ID='doubao-seedance-2-5-260628';
export const SEEDANCE25_PROTOCOL_VERSION='ark-v3';
export const SEEDANCE25_REVIEWED_ON='2026-10-30';
export const SEEDANCE25_SOURCE='https://ark.volcengine.com/region:cn-beijing/docs/create-video-generation-task-api';

export interface Seedance25Capability {
 modelId:typeof SEEDANCE25_MODEL_ID;region:'cn-beijing';protocolVersion:typeof SEEDANCE25_PROTOCOL_VERSION;
 source:string;reviewedOn:string;smartDuration:true;adaptiveAspectRatio:true;maxPromptLength:5000;
 minAspectRatio:0.4;maxAspectRatio:2.5;referenceImages:30;maxEncodedImageBytes:60000000;
 referenceAudios:10;audioMimeTypes:readonly string[];maxAudioBytes:15000000;minAudioSeconds:2;maxAudioSeconds:30;maxTotalAudioSeconds:30;
 promptReferences:Readonly<{image:'@图片';audio:'@音频'}>;soundMarks:Readonly<{music:'()';effect:'<>';dialogue:'{}';subtitle:'【】'}>;
 durationsSeconds:readonly number[];aspectRatios:readonly string[];resolutions:readonly string[];
 defaults:Readonly<{resolution:'720p';generateAudio:false}>;
}

// Ark documents 4–30 seconds or -1 (the model chooses), six fixed ratios plus
// adaptive, and 480p/720p (8-bit) or 1080p (10-bit HEVC) output. It sets no hard
// prompt limit, so the shot prompt field's own 5000 code units apply. Audio is
// off unless the user turns it on; Ark's own default would be on.
// A reference task takes up to 30 images and up to 10 WAV or MP3 clips of 2–30
// seconds each, 30 seconds in total and 15 MB each; it may carry audio alone.
// Mioon sends both as Base64 data URIs and Ark caps the request body at 64 MB,
// so images and audio together stay under 60,000,000 encoded bytes (the field
// keeps its first name), leaving room for the prompt and the other fields.
// Ark's prompt rules name the materials @图片1 and @音频1, numbered from 1 in
// the order they are sent, and mark music, effects, dialogue and subtitles with
// (), <>, {} and 【】. The built-in shot prompt method reads these two fields
// from the capability instead of a model name.
export const SEEDANCE25_CAPABILITIES:readonly Seedance25Capability[]=Object.freeze([Object.freeze({
 modelId:SEEDANCE25_MODEL_ID,region:'cn-beijing' as const,protocolVersion:SEEDANCE25_PROTOCOL_VERSION,
 source:SEEDANCE25_SOURCE,reviewedOn:SEEDANCE25_REVIEWED_ON,smartDuration:true as const,adaptiveAspectRatio:true as const,
 maxPromptLength:5000 as const,minAspectRatio:0.4 as const,maxAspectRatio:2.5 as const,
 referenceImages:30 as const,maxEncodedImageBytes:60000000 as const,
 referenceAudios:10 as const,audioMimeTypes:Object.freeze(['audio/wav','audio/mpeg']),maxAudioBytes:15000000 as const,minAudioSeconds:2 as const,maxAudioSeconds:30 as const,maxTotalAudioSeconds:30 as const,
 promptReferences:Object.freeze({image:'@图片' as const,audio:'@音频' as const}),
 soundMarks:Object.freeze({music:'()' as const,effect:'<>' as const,dialogue:'{}' as const,subtitle:'【】' as const}),
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
/** Ark's Base64 audio data URIs name the format: data:audio/wav or data:audio/mp3. */
export function seedanceAudioDataUriPrefix(mimeType:string):string {
 return `data:audio/${mimeType==='audio/mpeg'?'mp3':'wav'};base64,`;
}
/** Exact byte length of a Base64 data URI with this prefix, without encoding anything. */
export function seedanceEncodedBytes(prefix:string,sizeBytes:number):number {
 return prefix.length+4*Math.ceil(sizeBytes/3);
}
