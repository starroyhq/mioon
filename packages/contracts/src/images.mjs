import {z} from 'zod';
import {customImageModelSchema} from './image-compatible.mjs';
import {comfyCheckpointSchema,comfyImageOptionsSchema} from './comfy-images.mjs';
import {frameSchemas,FRAME_PROFILE_ID,FRAME_SELECTION_RULE} from './frame-extraction.mjs';
import {SOURCE_RANGE_FPS} from './source-range.mjs';

// Fixed image profiles; a provider label or local enable flag is never approval
// to send. Live acceptance additionally requires an immutable user review.
export const IMAGE_PROVIDER_IDS=Object.freeze(['mock','openai','openai-compatible','comfy-local']);
export const IMAGE_MODELS=Object.freeze({mock:'mock-image-v1',openai:'gpt-image-2.5-flare-2026-09-08'});
export const IMAGE_EDIT_LIMITS=Object.freeze({sourceBytes:8*1024*1024,sourceMaxEdge:1024,sourceMaxPixels:1024*1024,sourceNameCharacters:200,sourceNameBytes:800,sourceChainDepth:32});
export const IMAGE_FIXED_OPTIONS=Object.freeze({size:'1024x1024',quality:'low',outputFormat:'png',background:'opaque',n:1});
export const IMAGE_STATES=Object.freeze(['queued','interrupted_before_dispatch','dispatching','receiving','persisting','succeeded','cancelled_before_dispatch','failed','outcome_unknown','local_result_error']);
export const IMAGE_UNRESOLVED_STATES=Object.freeze(['queued','interrupted_before_dispatch','dispatching','receiving','persisting','outcome_unknown','local_result_error']);
export const IMAGE_MUTATION_OPERATIONS=Object.freeze(['image.generate','image.task.cancelQueued','image.task.recoverResult']);
export const IMAGE_LIMITS=Object.freeze({promptCharacters:2000,promptBytes:8000,inputBytes:24576,snapshotBytes:24576,taskBytes:65536,receiptBytes:4096,versionBytes:4096,responseBytes:32768,
 pageSize:20,maxPageSize:50,queuedPerProject:8,queuedGlobal:32,tasksPerProject:1000,tasksGlobal:10000,requestsPerProject:3000,requestsGlobal:30000,resultBytes:30*1024*1024});
export const canonicalImageInput=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const id=z.string().uuid(),revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),timestamp=z.string().min(1).max(40).refine(v=>Number.isFinite(Date.parse(v)),'Invalid timestamp');
const key=z.string().min(8).max(200),hash=z.string().regex(/^[a-f0-9]{64}$/),name=z.string().min(1).max(120).refine(v=>Boolean(v.trim()),'Name must not be blank');
const encoder=new TextEncoder(),prompt=z.string().min(1).max(IMAGE_LIMITS.promptCharacters).refine(v=>Boolean(v.trim())&&!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v)&&encoder.encode(v).length<=IMAGE_LIMITS.promptBytes,'Prompt must not be blank or oversized');
const providerId=z.enum(['mock','openai','openai-compatible']),model=customImageModelSchema;
export const imageSourceSchema=z.object({imageGroupId:id,imageTaskId:id,imageVersionId:id}).strict();
export const imageEditInputImageSchema=z.object({assetId:id,sha256:hash}).strict();
const frameInputFields=frameSchemas['frame.extract'].shape;
const editFrameSource=z.object({frameTaskId:id,sourceAssetId:frameInputFields.sourceAssetId,sourceHash:frameInputFields.sourceHash,
 sourceFrame:frameInputFields.sourceFrame,fps:z.literal(SOURCE_RANGE_FPS),profileId:z.literal(FRAME_PROFILE_ID),selectionRule:z.literal(FRAME_SELECTION_RULE)}).strict();
const editOrigin=z.union([z.object({kind:z.literal('user-import')}).strict(),
 z.object({kind:z.enum(['generated','synthetic-mock']),imageSource:imageSourceSchema}).strict(),
 z.object({kind:z.literal('extracted-frame'),frameSource:editFrameSource}).strict()]);
// Backend-derived, safe provenance. Paths, bytes, URLs and credentials never
// enter model/user arguments or retained public records.
export const imageEditSourceSchema=z.object({assetId:id,sha256:hash,mimeType:z.literal('image/png'),
 byteLength:z.number().int().min(1).max(IMAGE_EDIT_LIMITS.sourceBytes),
 width:z.number().int().min(1).max(IMAGE_EDIT_LIMITS.sourceMaxEdge),height:z.number().int().min(1).max(IMAGE_EDIT_LIMITS.sourceMaxEdge),
 name:z.string().min(1).max(IMAGE_EDIT_LIMITS.sourceNameCharacters).refine(value=>Boolean(value.trim())&&encoder.encode(value).length<=IMAGE_EDIT_LIMITS.sourceNameBytes,'Invalid source name'),origin:editOrigin}).strict()
 .refine(value=>value.width*value.height<=IMAGE_EDIT_LIMITS.sourceMaxPixels,'Source geometry exceeds edit profile');
const editFields={purpose:z.literal('edit'),inputImage:imageEditInputImageSchema};
const editSourceFields={...editFields,sourceImage:imageEditSourceSchema};
const matchesEditSource=value=>typeof value?.inputImage?.assetId==='string'&&value.inputImage.assetId===value.sourceImage?.assetId&&value.inputImage.sha256===value.sourceImage?.sha256;

export const imageOptionsSchema=z.object({size:z.literal('1024x1024'),quality:z.literal('low'),outputFormat:z.literal('png'),background:z.literal('opaque'),n:z.literal(1)}).strict();
const generation={providerId,model,prompt,options:imageOptionsSchema};
const providerMatches=v=>v.providerId==='openai-compatible'||IMAGE_MODELS[v.providerId]===v.model;
const comfyGeneration={providerId:z.literal('comfy-local'),model:comfyCheckpointSchema,prompt,options:comfyImageOptionsSchema};
const editGeneration={...generation,providerId:z.enum(['mock','openai'])};
export const imageAdapterInputSchema=z.union([z.object(generation).strict().refine(providerMatches,'Model does not belong to provider'),z.object(comfyGeneration).strict(),
 z.object({...editGeneration,...editSourceFields}).strict().refine(providerMatches,'Model does not belong to provider').refine(matchesEditSource,'Edit source identity mismatch')]);
const legacyGenerate=z.object({projectId:id,name,...generation,requestId:key,groupId:id.optional(),expectedRevision:revision.optional()}).strict()
 .refine(v=>(v.groupId===undefined)===(v.expectedRevision===undefined),'groupId and expectedRevision must be provided together').refine(providerMatches,'Model does not belong to provider');
const comfyGenerate=z.object({projectId:id,name,...comfyGeneration,requestId:key,groupId:id.optional(),expectedRevision:revision.optional()}).strict().refine(v=>(v.groupId===undefined)===(v.expectedRevision===undefined),'groupId and expectedRevision must be provided together');
const editGenerate=z.object({projectId:id,name,...editGeneration,...editFields,requestId:key,groupId:id.optional(),expectedRevision:revision.optional()}).strict()
 .refine(v=>(v.groupId===undefined)===(v.expectedRevision===undefined),'groupId and expectedRevision must be provided together').refine(providerMatches,'Model does not belong to provider');
const generate=z.union([legacyGenerate,comfyGenerate,editGenerate]);
const page={projectId:id,limit:z.number().int().min(1).max(IMAGE_LIMITS.maxPageSize).optional(),cursor:z.string().min(1).max(768).optional()};
export const imageSchemas=Object.freeze({
 'image.profile.list':z.object({includeSettingsRevision:z.boolean().optional()}).strict(),
 'image.generate':generate,
 'image.request.get':z.object({projectId:id,requestId:key}).strict(),
 'image.task.get':z.object({projectId:id,taskId:id}).strict(),
 'image.task.list':z.object({...page,groupId:id.optional()}).strict(),
 'image.group.list':z.object(page).strict(),
 'image.group.get':z.object({projectId:id,groupId:id}).strict(),
 'image.version.list':z.object({...page,groupId:id}).strict(),
 'image.task.cancelQueued':z.object({projectId:id,taskId:id,expectedRevision:revision,requestId:key}).strict(),
 'image.task.recoverResult':z.object({projectId:id,taskId:id,expectedRevision:revision,requestId:key}).strict(),
});
export const imageSnapshotSchema=z.union([z.object({schemaVersion:z.literal(1),projectId:id,groupId:id,taskId:id,name,...generation}).strict().refine(providerMatches,'Model does not belong to provider'),z.object({schemaVersion:z.literal(1),projectId:id,groupId:id,taskId:id,name,...comfyGeneration}).strict(),
 z.object({schemaVersion:z.literal(1),projectId:id,groupId:id,taskId:id,name,...editGeneration,...editSourceFields}).strict().refine(providerMatches,'Model does not belong to provider').refine(matchesEditSource,'Edit source identity mismatch')]);
const legacyReceiptSchema=z.object({schemaVersion:z.literal(1),taskId:id,projectId:id,groupId:id,inputHash:hash,assetId:id,versionId:id,sha256:hash,mimeType:z.literal('image/png'),width:z.literal(1024),height:z.literal(1024),byteLength:z.number().int().min(1).max(IMAGE_LIMITS.resultBytes),isMock:z.boolean()}).strict();
export const imageReceiptSchema=z.union([legacyReceiptSchema,legacyReceiptSchema.extend({schemaVersion:z.literal(2),providerId:z.literal('comfy-local'),width:z.literal(512),height:z.literal(512),isMock:z.literal(false)}).strict()]);
const legacyTaskResponseSchema=z.object({id,projectId:id,groupId:id,requestId:key,name,...generation,state:z.enum(IMAGE_STATES),revision,dispatched:z.boolean(),versionId:id.nullable(),errorCode:z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).nullable(),createdAt:timestamp,updatedAt:timestamp}).strict()
 .refine(providerMatches,'Model does not belong to provider')
 .refine(v=>(v.state==='succeeded')===(v.versionId!==null),'Only succeeded tasks have a version')
 .refine(v=>!['queued','interrupted_before_dispatch','cancelled_before_dispatch'].includes(v.state)||!v.dispatched,'Queued/cancelled tasks cannot have dispatched')
 .refine(v=>!['dispatching','receiving','persisting','succeeded','outcome_unknown','local_result_error'].includes(v.state)||v.dispatched,'Active/result tasks require dispatch fence');
const comfyTaskResponseSchema=z.object({id,projectId:id,groupId:id,requestId:key,name,...comfyGeneration,state:z.enum(IMAGE_STATES),revision,dispatched:z.boolean(),versionId:id.nullable(),errorCode:z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).nullable(),createdAt:timestamp,updatedAt:timestamp}).strict()
 .refine(v=>(v.state==='succeeded')===(v.versionId!==null),'Only succeeded tasks have a version')
 .refine(v=>!['queued','interrupted_before_dispatch','cancelled_before_dispatch'].includes(v.state)||!v.dispatched,'Queued/cancelled tasks cannot have dispatched')
 .refine(v=>!['dispatching','receiving','persisting','succeeded','outcome_unknown','local_result_error'].includes(v.state)||v.dispatched,'Active/result tasks require dispatch fence');
const editTaskResponseSchema=z.object({id,projectId:id,groupId:id,requestId:key,name,...editGeneration,...editSourceFields,state:z.enum(IMAGE_STATES),revision,dispatched:z.boolean(),versionId:id.nullable(),errorCode:z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).nullable(),createdAt:timestamp,updatedAt:timestamp}).strict()
 .refine(providerMatches,'Model does not belong to provider').refine(matchesEditSource,'Edit source identity mismatch')
 .refine(v=>(v.state==='succeeded')===(v.versionId!==null),'Only succeeded tasks have a version')
 .refine(v=>!['queued','interrupted_before_dispatch','cancelled_before_dispatch'].includes(v.state)||!v.dispatched,'Queued/cancelled tasks cannot have dispatched')
 .refine(v=>!['dispatching','receiving','persisting','succeeded','outcome_unknown','local_result_error'].includes(v.state)||v.dispatched,'Active/result tasks require dispatch fence');
export const imageTaskResponseSchema=z.union([legacyTaskResponseSchema,comfyTaskResponseSchema,editTaskResponseSchema]);
export const imageGroupResponseSchema=z.object({id,projectId:id,name,revision,headVersionId:id.nullable(),activeTaskId:id.nullable(),createdAt:timestamp,updatedAt:timestamp}).strict();
const legacyVersionResponseSchema=z.object({id,projectId:id,groupId:id,taskId:id,number:revision,assetId:id,sha256:hash,mimeType:z.literal('image/png'),width:z.literal(1024),height:z.literal(1024),byteLength:z.number().int().min(1).max(IMAGE_LIMITS.resultBytes),isMock:z.boolean(),providerId,model,options:imageOptionsSchema,createdAt:timestamp}).strict()
 .refine(providerMatches,'Model does not belong to provider').refine(v=>v.isMock===(v.providerId==='mock'),'Mock identity mismatch');
const editVersionResponseSchema=z.object({id,projectId:id,groupId:id,taskId:id,number:revision,assetId:id,sha256:hash,mimeType:z.literal('image/png'),width:z.literal(1024),height:z.literal(1024),byteLength:z.number().int().min(1).max(IMAGE_LIMITS.resultBytes),isMock:z.boolean(),providerId:z.enum(['mock','openai']),model,options:imageOptionsSchema,createdAt:timestamp,...editSourceFields}).strict()
 .refine(providerMatches,'Model does not belong to provider').refine(v=>v.isMock===(v.providerId==='mock'),'Mock identity mismatch').refine(matchesEditSource,'Edit source identity mismatch')
 .refine(value=>value.assetId!==value.inputImage?.assetId,'An edit must publish a new asset');
export const imageVersionResponseSchema=z.union([legacyVersionResponseSchema,editVersionResponseSchema,z.object({id,projectId:id,groupId:id,taskId:id,number:revision,assetId:id,sha256:hash,mimeType:z.literal('image/png'),width:z.literal(512),height:z.literal(512),byteLength:z.number().int().min(1).max(IMAGE_LIMITS.resultBytes),isMock:z.literal(false),providerId:z.literal('comfy-local'),model:comfyCheckpointSchema,options:comfyImageOptionsSchema,createdAt:timestamp}).strict()]);
const legacyProfileResponseSchema=z.object({providerId,model,name:z.string().min(1).max(120),enabled:z.boolean(),isMock:z.boolean(),evidence:z.enum(['deterministic-mock','offline-tested-not-live']),options:imageOptionsSchema,settingsRevision:revision.optional()}).strict()
 .refine(providerMatches,'Model does not belong to provider').refine(v=>v.isMock===(v.providerId==='mock')&&(!v.isMock||v.enabled&&!Object.hasOwn(v,'settingsRevision'))&&v.evidence===(v.isMock?'deterministic-mock':'offline-tested-not-live'),'Invalid image profile evidence');
export const imageProfileResponseSchema=z.union([legacyProfileResponseSchema,z.object({providerId:z.literal('comfy-local'),model:comfyCheckpointSchema,name:z.string().min(1).max(120),enabled:z.boolean(),isMock:z.literal(false),evidence:z.literal('offline-tested-not-live'),options:comfyImageOptionsSchema,settingsRevision:revision.optional()}).strict()]);
export const imageProfilesResponseSchema=z.object({items:z.array(imageProfileResponseSchema).max(4),liveEnabled:z.boolean()}).strict().refine(v=>new Set(v.items.map(i=>i.providerId)).size===v.items.length&&v.liveEnabled===v.items.some(i=>i.providerId!=='mock'&&i.enabled));
export const imageRequestResponseSchema=z.object({projectId:id,requestId:key,operation:z.enum(IMAGE_MUTATION_OPERATIONS),response:imageTaskResponseSchema}).strict()
 .refine(v=>v.response.projectId===v.projectId&&(v.operation!=='image.generate'||v.response.requestId===v.requestId))
 .refine(v=>v.operation==='image.generate'?v.response.state==='queued'&&v.response.revision===1&&!v.response.dispatched
  :v.operation==='image.task.cancelQueued'?v.response.state==='cancelled_before_dispatch'&&v.response.revision>1&&!v.response.dispatched
  :v.response.state==='persisting'&&v.response.revision>1&&v.response.dispatched,'Receipt must describe the original operation acknowledgement').nullable();
export const isImageTaskResponse=v=>imageTaskResponseSchema.safeParse(v).success;
export const isImageGroupResponse=v=>imageGroupResponseSchema.safeParse(v).success;
export const isImageVersionResponse=v=>imageVersionResponseSchema.safeParse(v).success;
export const isImageRequestResponse=v=>imageRequestResponseSchema.safeParse(v).success;
export const isImageProfilesResponse=(v,input={})=>imageSchemas['image.profile.list'].safeParse(input).success&&imageProfilesResponseSchema.safeParse(v).success&&(input.includeSettingsRevision===true||v.items.every(item=>!Object.hasOwn(item,'settingsRevision')));
export function isImageMutationResponse(operation,input,result){
 if(!IMAGE_MUTATION_OPERATIONS.includes(operation)||!imageSchemas[operation].safeParse(input).success||!isImageTaskResponse(result)||result.projectId!==input.projectId)return false;
 if(operation==='image.generate')return result.purpose===input.purpose&&canonicalImageInput(result.inputImage)===canonicalImageInput(input.inputImage)&&result.requestId===input.requestId&&result.name===input.name&&result.prompt===input.prompt&&result.providerId===input.providerId&&result.model===input.model&&canonicalImageInput(result.options)===canonicalImageInput(input.options)&&result.state==='queued'&&result.revision===1&&!result.dispatched&&result.versionId===null&&(input.groupId===undefined||result.groupId===input.groupId);
 if(result.id!==input.taskId||result.revision!==input.expectedRevision+1)return false;
 return operation==='image.task.cancelQueued'?result.state==='cancelled_before_dispatch'&&!result.dispatched:result.state==='persisting'&&result.dispatched;
}
export function isImageListResponse(operation,input,result){
 const validate={'image.task.list':isImageTaskResponse,'image.group.list':isImageGroupResponse,'image.version.list':isImageVersionResponse}[operation];
 if(!validate||!imageSchemas[operation].safeParse(input).success||!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).sort().join(',')!=='items,nextCursor,projectId'||result.projectId!==input.projectId||!Array.isArray(result.items)||result.items.length>(input.limit??IMAGE_LIMITS.pageSize)||(result.nextCursor!==null&&(typeof result.nextCursor!=='string'||result.nextCursor.length<1||result.nextCursor.length>768)))return false;
 return new Set(result.items.map(v=>v?.id)).size===result.items.length&&result.items.every(v=>validate(v)&&v.projectId===input.projectId&&(!input.groupId||v.groupId===input.groupId));
}
