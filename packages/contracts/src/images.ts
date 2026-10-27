type Rec = Record<string, unknown>;
import {z} from 'zod';
import {customImageModelSchema} from './image-compatible.ts';
import {comfyCheckpointSchema,comfyImageOptionsSchema} from './comfy-images.ts';
import {frameSchemas,FRAME_PROFILE_ID,FRAME_SELECTION_RULE} from './frame-extraction.ts';
import {SOURCE_RANGE_FPS} from './source-range.ts';
import {IMAGE_EDIT_SOURCE_BOUNDS,IMAGE_EDIT_SOURCE_MIME_TYPES,IMAGE_EDIT_OUTPUT_BOUNDS,imageEditProfile,imageEditSourceIssue,isImageEditOutputSize,parseImageSize} from './image-edit-profiles.ts';

// Fixed image profiles; a provider label or local enable flag is never approval
// to send. Live acceptance additionally requires an immutable user review.
export const IMAGE_PROVIDER_IDS=Object.freeze(['mock','openai','openai-compatible','comfy-local']);
export const IMAGE_MODELS=Object.freeze({mock:'mock-image-v1',openai:'gpt-image-2.5-flare-2026-09-08'});
// Source bounds are the union of every edit profile; each model's own limits
// are checked against its profile (image-edit-profiles.ts).
export const IMAGE_EDIT_LIMITS=Object.freeze({sourceBytes:IMAGE_EDIT_SOURCE_BOUNDS.maxBytes,sourceMaxEdge:IMAGE_EDIT_SOURCE_BOUNDS.maxEdge,sourceMaxPixels:IMAGE_EDIT_SOURCE_BOUNDS.maxPixels,sourceNameCharacters:200,sourceNameBytes:800,sourceChainDepth:32});
export const IMAGE_FIXED_OPTIONS=Object.freeze({size:'1024x1024',quality:'low',outputFormat:'png',background:'opaque',n:1});
export const IMAGE_STATES=Object.freeze(['queued','interrupted_before_dispatch','dispatching','receiving','persisting','succeeded','cancelled_before_dispatch','failed','outcome_unknown','local_result_error'] as const);
export const IMAGE_UNRESOLVED_STATES=Object.freeze(['queued','interrupted_before_dispatch','dispatching','receiving','persisting','outcome_unknown','local_result_error']);
export const IMAGE_MUTATION_OPERATIONS=Object.freeze(['image.generate','image.task.cancelQueued','image.task.recoverResult'] as const);
export const IMAGE_LIMITS=Object.freeze({promptCharacters:2000,promptBytes:8000,inputBytes:24576,snapshotBytes:24576,taskBytes:65536,receiptBytes:4096,versionBytes:4096,responseBytes:32768,
 pageSize:20,maxPageSize:50,queuedPerProject:8,queuedGlobal:32,tasksPerProject:1000,tasksGlobal:10000,requestsPerProject:3000,requestsGlobal:30000,resultBytes:30*1024*1024});
export const canonicalImageInput=(value: unknown): string=>JSON.stringify(value,(_key: string,v: unknown)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
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
export const imageEditSourceSchema=z.object({assetId:id,sha256:hash,mimeType:z.enum(IMAGE_EDIT_SOURCE_MIME_TYPES),
 byteLength:z.number().int().min(1).max(IMAGE_EDIT_LIMITS.sourceBytes),
 width:z.number().int().min(1).max(IMAGE_EDIT_LIMITS.sourceMaxEdge),height:z.number().int().min(1).max(IMAGE_EDIT_LIMITS.sourceMaxEdge),
 name:z.string().min(1).max(IMAGE_EDIT_LIMITS.sourceNameCharacters).refine(value=>Boolean(value.trim())&&encoder.encode(value).length<=IMAGE_EDIT_LIMITS.sourceNameBytes,'Invalid source name'),origin:editOrigin}).strict()
 .refine(value=>value.width*value.height<=IMAGE_EDIT_LIMITS.sourceMaxPixels,'Source geometry exceeds edit profile');
const editFields={purpose:z.literal('edit'),inputImage:imageEditInputImageSchema};
const editSourceFields={...editFields,sourceImage:imageEditSourceSchema};
interface EditSourceValues {inputImage?: {assetId?: unknown; sha256?: unknown}; sourceImage?: {assetId?: unknown; sha256?: unknown}}
const matchesEditSource=(value: EditSourceValues): boolean=>typeof value?.inputImage?.assetId==='string'&&value.inputImage.assetId===value.sourceImage?.assetId&&value.inputImage.sha256===value.sourceImage?.sha256;

export const imageOptionsSchema=z.object({size:z.literal('1024x1024'),quality:z.literal('low'),outputFormat:z.literal('png'),background:z.literal('opaque'),n:z.literal(1)}).strict();
// Text-to-image stays 1024x1024. An edit's size must satisfy its model's edit
// profile; legacy 1024x1024 edits remain valid under every profile.
export const imageEditOptionsSchema=z.object({size:z.string().regex(/^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$/),quality:z.literal('low'),outputFormat:z.literal('png'),background:z.literal('opaque'),n:z.literal(1)}).strict();
const generation={providerId,model,prompt,options:imageOptionsSchema};
const providerMatches=(v: {providerId?: unknown; model?: unknown}): boolean=>v.providerId==='openai-compatible'||(IMAGE_MODELS as Record<string, string>)[v.providerId as string]===v.model;
interface EditCapabilityValues {providerId?: unknown; model?: unknown; options?: {size?: unknown}; sourceImage?: Record<string, unknown>}
const editCapable=(v: EditCapabilityValues): boolean=>{const profile=imageEditProfile(v.providerId,v.model);return isImageEditOutputSize(profile,v.options?.size)&&(v.sourceImage===undefined||imageEditSourceIssue(profile!,v.sourceImage)===null);};
const comfyGeneration={providerId:z.literal('comfy-local'),model:comfyCheckpointSchema,prompt,options:comfyImageOptionsSchema};
const editGeneration={...generation,providerId:z.enum(['mock','openai']),options:imageEditOptionsSchema};
export const imageAdapterInputSchema=z.union([z.object(generation).strict().refine(providerMatches,'Model does not belong to provider'),z.object(comfyGeneration).strict(),
 z.object({...editGeneration,...editSourceFields}).strict().refine(providerMatches,'Model does not belong to provider').refine(matchesEditSource,'Edit source identity mismatch').refine(editCapable,'Model cannot produce this edit')]);
const legacyGenerate=z.object({projectId:id,name,...generation,requestId:key,groupId:id.optional(),expectedRevision:revision.optional()}).strict()
 .refine(v=>(v.groupId===undefined)===(v.expectedRevision===undefined),'groupId and expectedRevision must be provided together').refine(providerMatches,'Model does not belong to provider');
const comfyGenerate=z.object({projectId:id,name,...comfyGeneration,requestId:key,groupId:id.optional(),expectedRevision:revision.optional()}).strict().refine(v=>(v.groupId===undefined)===(v.expectedRevision===undefined),'groupId and expectedRevision must be provided together');
const editGenerate=z.object({projectId:id,name,...editGeneration,...editFields,requestId:key,groupId:id.optional(),expectedRevision:revision.optional()}).strict()
 .refine(v=>(v.groupId===undefined)===(v.expectedRevision===undefined),'groupId and expectedRevision must be provided together').refine(providerMatches,'Model does not belong to provider').refine(editCapable,'Model cannot produce this edit');
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
 z.object({schemaVersion:z.literal(1),projectId:id,groupId:id,taskId:id,name,...editGeneration,...editSourceFields}).strict().refine(providerMatches,'Model does not belong to provider').refine(matchesEditSource,'Edit source identity mismatch').refine(editCapable,'Model cannot produce this edit')]);
const legacyReceiptSchema=z.object({schemaVersion:z.literal(1),taskId:id,projectId:id,groupId:id,inputHash:hash,assetId:id,versionId:id,sha256:hash,mimeType:z.literal('image/png'),width:z.literal(1024),height:z.literal(1024),byteLength:z.number().int().min(1).max(IMAGE_LIMITS.resultBytes),isMock:z.boolean()}).strict();
const outputEdge=z.number().int().min(IMAGE_EDIT_OUTPUT_BOUNDS.minEdge).max(IMAGE_EDIT_OUTPUT_BOUNDS.maxEdge);
// v3 is a sized edit result; a 1024x1024 result keeps the v1 receipt shape.
export const imageReceiptSchema=z.union([legacyReceiptSchema,legacyReceiptSchema.extend({schemaVersion:z.literal(2),providerId:z.literal('comfy-local'),width:z.literal(512),height:z.literal(512),isMock:z.literal(false)}).strict(),
 legacyReceiptSchema.extend({schemaVersion:z.literal(3),width:outputEdge,height:outputEdge}).strict().refine(v=>v.width!==1024||v.height!==1024,'A 1024x1024 result uses the v1 receipt')]);
/** The receipt shape a task's result must have: Comfy is 512x512 (v2), a
 * sized edit is its requested size (v3), everything else 1024x1024 (v1). */
export function imageResultGeometry(snapshot: {providerId?: unknown; purpose?: unknown; options?: unknown}): {schemaVersion: 1 | 2 | 3; width: number; height: number} {
 if(snapshot.providerId==='comfy-local')return {schemaVersion:2,width:512,height:512};
 const options=snapshot.options,size=snapshot.purpose==='edit'&&options!==null&&typeof options==='object'?parseImageSize((options as {size?: unknown}).size):null;
 return size&&(size.width!==1024||size.height!==1024)?{schemaVersion:3,...size}:{schemaVersion:1,width:1024,height:1024};
}
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
 .refine(providerMatches,'Model does not belong to provider').refine(matchesEditSource,'Edit source identity mismatch').refine(editCapable,'Model cannot produce this edit')
 .refine(v=>(v.state==='succeeded')===(v.versionId!==null),'Only succeeded tasks have a version')
 .refine(v=>!['queued','interrupted_before_dispatch','cancelled_before_dispatch'].includes(v.state)||!v.dispatched,'Queued/cancelled tasks cannot have dispatched')
 .refine(v=>!['dispatching','receiving','persisting','succeeded','outcome_unknown','local_result_error'].includes(v.state)||v.dispatched,'Active/result tasks require dispatch fence');
export const imageTaskResponseSchema=z.union([legacyTaskResponseSchema,comfyTaskResponseSchema,editTaskResponseSchema]);
export const imageGroupResponseSchema=z.object({id,projectId:id,name,revision,headVersionId:id.nullable(),activeTaskId:id.nullable(),createdAt:timestamp,updatedAt:timestamp}).strict();
const legacyVersionResponseSchema=z.object({id,projectId:id,groupId:id,taskId:id,number:revision,assetId:id,sha256:hash,mimeType:z.literal('image/png'),width:z.literal(1024),height:z.literal(1024),byteLength:z.number().int().min(1).max(IMAGE_LIMITS.resultBytes),isMock:z.boolean(),providerId,model,options:imageOptionsSchema,createdAt:timestamp}).strict()
 .refine(providerMatches,'Model does not belong to provider').refine(v=>v.isMock===(v.providerId==='mock'),'Mock identity mismatch');
const editVersionResponseSchema=z.object({id,projectId:id,groupId:id,taskId:id,number:revision,assetId:id,sha256:hash,mimeType:z.literal('image/png'),width:outputEdge,height:outputEdge,byteLength:z.number().int().min(1).max(IMAGE_LIMITS.resultBytes),isMock:z.boolean(),providerId:z.enum(['mock','openai']),model,options:imageEditOptionsSchema,createdAt:timestamp,...editSourceFields}).strict()
 .refine(providerMatches,'Model does not belong to provider').refine(v=>v.isMock===(v.providerId==='mock'),'Mock identity mismatch').refine(matchesEditSource,'Edit source identity mismatch').refine(editCapable,'Model cannot produce this edit')
 .refine(v=>{const size=parseImageSize(v.options.size);return size?.width===v.width&&size.height===v.height;},'Edit result must match the requested size')
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
const imageOperationSchemas = imageSchemas as Record<string, z.ZodTypeAny>;
export type ImageTaskResponse = z.infer<typeof imageTaskResponseSchema>;
export type ImageGroupResponse = z.infer<typeof imageGroupResponseSchema>;
export type ImageVersionResponse = z.infer<typeof imageVersionResponseSchema>;
export type ImageRequestResponse = z.infer<typeof imageRequestResponseSchema>;
export type ImageProfilesResponse = z.infer<typeof imageProfilesResponseSchema>;
export const isImageTaskResponse=(v: unknown): v is ImageTaskResponse=>imageTaskResponseSchema.safeParse(v).success;
export const isImageGroupResponse=(v: unknown): v is ImageGroupResponse=>imageGroupResponseSchema.safeParse(v).success;
export const isImageVersionResponse=(v: unknown): v is ImageVersionResponse=>imageVersionResponseSchema.safeParse(v).success;
export const isImageRequestResponse=(v: unknown): v is ImageRequestResponse=>imageRequestResponseSchema.safeParse(v).success;
export function isImageProfilesResponse(v: unknown,input: unknown = {}): boolean {
 if(!imageOperationSchemas['image.profile.list'].safeParse(input).success||!imageProfilesResponseSchema.safeParse(v).success)return false;
 const request=input as {includeSettingsRevision?: unknown}, response=v as ImageProfilesResponse;
 return request.includeSettingsRevision===true||response.items.every(item=>!Object.hasOwn(item,'settingsRevision'));
}
export function isImageMutationResponse(operation: unknown,input: unknown,result: unknown): boolean {
 if(typeof operation!=='string'||!(IMAGE_MUTATION_OPERATIONS as readonly string[]).includes(operation)||!imageOperationSchemas[operation].safeParse(input).success||!isImageTaskResponse(result)||result.projectId!==(input as Rec).projectId)return false;
 const request=input as Rec, response=result as unknown as Rec;
 if(operation==='image.generate')return response.purpose===request.purpose&&canonicalImageInput(response.inputImage)===canonicalImageInput(request.inputImage)&&response.requestId===request.requestId&&response.name===request.name&&response.prompt===request.prompt&&response.providerId===request.providerId&&response.model===request.model&&canonicalImageInput(response.options)===canonicalImageInput(request.options)&&response.state==='queued'&&response.revision===1&&!response.dispatched&&response.versionId===null&&(request.groupId===undefined||response.groupId===request.groupId);
 if(response.id!==request.taskId||response.revision!==(request.expectedRevision as number)+1)return false;
 return operation==='image.task.cancelQueued'?response.state==='cancelled_before_dispatch'&&!response.dispatched:response.state==='persisting'&&response.dispatched===true;
}
export function isImageListResponse(operation: unknown,input: unknown,result: unknown): boolean {
 const validates: Record<string, (value: unknown)=>value is ImageTaskResponse|ImageGroupResponse|ImageVersionResponse>={'image.task.list':isImageTaskResponse,'image.group.list':isImageGroupResponse,'image.version.list':isImageVersionResponse};
 const validate=typeof operation==='string'?validates[operation]:undefined;
 const request=input as Rec, response=result as Rec | null | undefined;
 if(!validate||!imageOperationSchemas[operation as string].safeParse(input).success||!response||typeof response!=='object'||Array.isArray(response)||Object.keys(response).sort().join(',')!=='items,nextCursor,projectId'||response.projectId!==request.projectId||!Array.isArray(response.items)||response.items.length>((request.limit as number|undefined)??IMAGE_LIMITS.pageSize)||(response.nextCursor!==null&&(typeof response.nextCursor!=='string'||response.nextCursor.length<1||response.nextCursor.length>768)))return false;
 const items=response.items as Rec[];
 return new Set(items.map((v: Rec)=>v?.id)).size===items.length&&items.every((v: Rec)=>validate(v)&&v.projectId===request.projectId&&(!request.groupId||(v as Rec).groupId===request.groupId));
}
