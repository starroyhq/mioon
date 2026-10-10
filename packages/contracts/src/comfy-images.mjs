import {z} from 'zod';

// Browser-safe declarations for one bundled, reviewed workflow. These fields
// never authorize network access or execution, and never accept credentials.
export const COMFY_IMAGE_PROVIDER_ID = 'comfy-local';
export const COMFY_IMAGE_PROFILE_ID = 'comfy-t2i-png-v1';
export const COMFY_IMAGE_VERSION = '0.39.0';
export const COMFY_SETTINGS_NAMESPACE = 'mioon.comfy.local.v1';
export const COMFY_SETTINGS_LIMITS = Object.freeze({envelopeBytes:16384,updateBytes:16384});
export const COMFY_IMAGE_OPTIONS = Object.freeze({size:'512x512',steps:20,cfg:8,sampler:'euler',scheduler:'normal',denoise:1,n:1});
export const COMFY_IMAGE_POLICY = Object.freeze({maxPostAttempts:1,automaticRetry:false,price:'local-compute-unknown',promptStorage:'local-plaintext'});
export const COMFY_IMAGE_LIMITS = Object.freeze({graphBytes:32768,rowBytes:65536,descriptorBytes:4096,endpointCharacters:64,checkpointBytes:240,observationBytes:8192});
export const COMFY_REMOTE_STATES = Object.freeze(['prepared','submitted','submission_unknown','queued','running','completed','failed','unavailable']);
export const COMFY_OBSERVATION_STATES = Object.freeze(['queued','running','finished','interrupted']);
export const COMFY_IMAGE_MUTATION_OPERATIONS = Object.freeze(['image.task.observeRemote']);
const encoder = new TextEncoder(), id=z.string().uuid(), hash=z.string().regex(/^[a-f0-9]{64}$/);
const revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timestamp=z.string().min(1).max(40).refine(value=>Number.isFinite(Date.parse(value)),'Invalid timestamp');
const errorCode=z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).nullable();
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export function normalizeComfyImageBaseUrl(value) {
  if(typeof value!=='string')throw new TypeError('Invalid local ComfyUI endpoint');
  const match=/^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?$/.exec(value);
  if(!match||Number(match[2])>65535)throw new TypeError('Invalid local ComfyUI endpoint');
  return `http://${match[1]}:${match[2]}`;
}
export const comfyImageBaseUrlSchema=z.string().max(COMFY_IMAGE_LIMITS.endpointCharacters).refine(value=>{
  try{return normalizeComfyImageBaseUrl(value)===value;}catch{return false;}
},'ComfyUI endpoint must be a canonical explicit-port loopback origin');
export function getComfyImageDestination(baseUrl){return `${comfyImageBaseUrlSchema.parse(baseUrl)}/prompt`;}
export const comfyCheckpointSchema=z.string().min(1).max(COMFY_IMAGE_LIMITS.checkpointBytes).refine(value=>
  encoder.encode(value).length<=COMFY_IMAGE_LIMITS.checkpointBytes && !/[\\\x00-\x1f\x7f:%?#]/.test(value) &&
  !value.startsWith('/') && value.split('/').every(part=>Boolean(part)&&part!=='.'&&part!=='..'&&part.trim()===part),
  'Checkpoint must be a bounded safe relative name');
export const comfyImageOptionsSchema=z.object({size:z.literal('512x512'),steps:z.literal(20),cfg:z.literal(8),sampler:z.literal('euler'),scheduler:z.literal('normal'),denoise:z.literal(1),n:z.literal(1)}).strict();
export const DEFAULT_COMFY_IMAGE_CONFIGURATION=Object.freeze({enabled:false,providerId:COMFY_IMAGE_PROVIDER_ID,connectionId:COMFY_IMAGE_PROVIDER_ID,
  profileId:COMFY_IMAGE_PROFILE_ID,baseUrl:'',model:'',options:COMFY_IMAGE_OPTIONS,comfyVersion:COMFY_IMAGE_VERSION});
export const comfyImageConfigurationSchema=z.object({enabled:z.boolean(),providerId:z.literal(COMFY_IMAGE_PROVIDER_ID),connectionId:z.literal(COMFY_IMAGE_PROVIDER_ID),
  profileId:z.literal(COMFY_IMAGE_PROFILE_ID),baseUrl:z.union([z.literal(''),comfyImageBaseUrlSchema]),model:z.union([z.literal(''),comfyCheckpointSchema]),
  options:comfyImageOptionsSchema,comfyVersion:z.literal(COMFY_IMAGE_VERSION)}).strict().refine(value=>
  value.baseUrl===''||value.model===''?!value.enabled&&value.baseUrl===''&&value.model==='':true,'Local configuration must be complete or an empty disabled slot');
export const isCompleteComfyImageConfiguration=value=>comfyImageConfigurationSchema.safeParse(value).success&&value.baseUrl!==''&&value.model!=='';
export const comfyImageSettingsUpdateSchema=z.object({expectedRevision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),configuration:comfyImageConfigurationSchema}).strict();
export const comfyImageSettingsResultSchema=z.object({revision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),configuration:comfyImageConfigurationSchema,
  readiness:z.object({checked:z.boolean(),checkedAt:timestamp.nullable()}).strict().refine(value=>value.checked===(value.checkedAt!==null))}).strict();
export const isComfyImageSettingsResult=value=>comfyImageSettingsResultSchema.safeParse(value).success;
export const comfyImagePolicySchema=z.object({maxPostAttempts:z.literal(1),automaticRetry:z.literal(false),price:z.literal('local-compute-unknown'),promptStorage:z.literal('local-plaintext')}).strict();

const link=(node,slot)=>z.tuple([z.literal(node),z.literal(slot)]);
const node=(class_type,inputs)=>z.object({class_type:z.literal(class_type),inputs:z.object(inputs).strict()}).strict();
const graphPrompt=z.string().min(1).max(2000).refine(value=>Boolean(value.trim())&&!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)&&encoder.encode(value).length<=8000);
export const comfyImageGraphSchema=z.object({
  '1':node('CheckpointLoaderSimple',{ckpt_name:comfyCheckpointSchema}),
  '2':node('EmptyLatentImage',{width:z.literal(512),height:z.literal(512),batch_size:z.literal(1)}),
  '3':node('CLIPTextEncode',{text:graphPrompt,clip:link('1',1)}),
  '4':node('CLIPTextEncode',{text:z.literal(''),clip:link('1',1)}),
  '5':node('KSampler',{seed:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),steps:z.literal(20),cfg:z.literal(8),sampler_name:z.literal('euler'),scheduler:z.literal('normal'),denoise:z.literal(1),model:link('1',0),positive:link('3',0),negative:link('4',0),latent_image:link('2',0)}),
  '6':node('VAEDecode',{samples:link('5',0),vae:link('1',2)}),
  '7':node('SaveImage',{images:link('6',0),filename_prefix:z.string().regex(/^mioon_[0-9a-f-]{36}$/)}),
}).strict().refine(value=>encoder.encode(canonical(value)).length<=COMFY_IMAGE_LIMITS.graphBytes,'Workflow exceeds its byte limit');
export const comfyImageExecutionSchema=z.object({workflowId:z.literal(COMFY_IMAGE_PROFILE_ID),workflowVersion:z.literal(1),comfyVersion:z.literal(COMFY_IMAGE_VERSION),
  seed:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),promptId:id,clientId:id,outputNonce:id,filenamePrefix:z.string().regex(/^mioon_[0-9a-f-]{36}$/),graphHash:hash,graph:comfyImageGraphSchema}).strict()
  .refine(value=>value.filenamePrefix===`mioon_${value.outputNonce}`&&value.graph['7'].inputs.filename_prefix===value.filenamePrefix&&value.graph['5'].inputs.seed===value.seed,'Graph must bind the frozen seed and output nonce');
export const comfyOutputDescriptorSchema=z.object({filename:z.string().max(160).regex(/^mioon_[0-9a-f-]{36}_[0-9]+_\.png$/),subfolder:z.literal(''),type:z.literal('output')}).strict();
export const comfyRemoteSchemas=Object.freeze({
  'image.task.remote.get':z.object({projectId:id,taskId:id}).strict(),
  'image.task.observeRemote':z.object({projectId:id,taskId:id,expectedRevision:revision,requestId:z.string().min(8).max(200)}).strict(),
});
export const comfyRemoteRunResponseSchema=z.object({taskId:id,projectId:id,reviewId:id,promptId:id,clientId:id,outputNonce:id,filenamePrefix:z.string().max(80),
  workflowId:z.literal(COMFY_IMAGE_PROFILE_ID),workflowVersion:z.literal(1),comfyVersion:z.literal(COMFY_IMAGE_VERSION),seed:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  baseUrl:comfyImageBaseUrlSchema,graphHash:hash,state:z.enum(COMFY_REMOTE_STATES),revision,contentVerified:z.boolean(),
  outputDescriptor:comfyOutputDescriptorSchema.nullable(),resultSha256:hash.nullable(),resultBytes:z.number().int().min(1).max(30*1024*1024).nullable(),errorCode,createdAt:timestamp,updatedAt:timestamp,lastObservedAt:timestamp.nullable()}).strict()
  .refine(value=>value.filenamePrefix===`mioon_${value.outputNonce}`&&(!value.contentVerified||['completed','failed'].includes(value.state))&&
    (!['completed','failed'].includes(value.state)||value.contentVerified)&&
    (value.state==='completed')===(value.resultSha256!==null)&&(value.state==='completed')===(value.resultBytes!==null)&&
    (value.state==='completed')===(value.outputDescriptor!==null)&&(!value.outputDescriptor||value.outputDescriptor.filename.startsWith(`${value.filenamePrefix}_`)), 'Invalid remote evidence');
const observationFields={id,projectId:id,taskId:id,requestId:z.string().min(8).max(200),state:z.enum(COMFY_OBSERVATION_STATES),revision,remoteRevision:revision,createdAt:timestamp};
export const comfyObservationAcknowledgementSchema=z.object({...observationFields,state:z.literal('queued'),revision:z.literal(1)}).strict();
export const comfyObservationResponseSchema=z.object({...observationFields,errorCode,updatedAt:timestamp}).strict();
export const comfyRemoteResponseSchema=z.object({projectId:id,taskId:id,remote:comfyRemoteRunResponseSchema,observation:comfyObservationResponseSchema.nullable()}).strict()
  .refine(value=>value.remote.projectId===value.projectId&&value.remote.taskId===value.taskId&&(!value.observation||value.observation.projectId===value.projectId&&value.observation.taskId===value.taskId),'Remote ownership mismatch');
export const isComfyRemoteResponse=value=>comfyRemoteResponseSchema.safeParse(value).success;
export const isComfyObservationResponse=value=>comfyObservationResponseSchema.safeParse(value).success;
export const isComfyObservationAcknowledgement=value=>comfyObservationAcknowledgementSchema.safeParse(value).success;
export function isComfyObserveResponse(input,result){return comfyRemoteSchemas['image.task.observeRemote'].safeParse(input).success&&isComfyObservationAcknowledgement(result)&&
  result.projectId===input.projectId&&result.taskId===input.taskId&&result.requestId===input.requestId&&result.remoteRevision===input.expectedRevision+1;}
export const comfyImageCheckRequestSchema=z.object({baseUrl:comfyImageBaseUrlSchema,model:z.union([z.literal(''),comfyCheckpointSchema]).optional()}).strict();
export const comfyImageCheckResultSchema=z.object({ok:z.literal(true),baseUrl:comfyImageBaseUrlSchema,comfyVersion:z.literal(COMFY_IMAGE_VERSION),
  checkpoints:z.array(comfyCheckpointSchema).max(256),selectedCheckpointAvailable:z.boolean(),
  nodeClasses:z.array(z.enum(['CheckpointLoaderSimple','EmptyLatentImage','CLIPTextEncode','KSampler','VAEDecode','SaveImage'])).length(6)}).strict()
  .refine(value=>new Set(value.nodeClasses).size===6&&new Set(value.checkpoints).size===value.checkpoints.length);
export const isComfyImageCheckResult=value=>comfyImageCheckResultSchema.safeParse(value).success;
