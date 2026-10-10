import {z} from 'zod';
import {customImageModelSchema} from './image-compatible.mjs';

// Fixed image profiles; a provider label or local enable flag is never approval
// to send. Live acceptance additionally requires an immutable user review.
export const IMAGE_PROVIDER_IDS=Object.freeze(['mock','openai','openai-compatible']);
export const IMAGE_MODELS=Object.freeze({mock:'mock-image-v1',openai:'gpt-image-2.5-flare-2026-09-08'});
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
const providerId=z.enum(IMAGE_PROVIDER_IDS),model=customImageModelSchema;
export const imageOptionsSchema=z.object({size:z.literal('1024x1024'),quality:z.literal('low'),outputFormat:z.literal('png'),background:z.literal('opaque'),n:z.literal(1)}).strict();
const generation={providerId,model,prompt,options:imageOptionsSchema};
const providerMatches=v=>v.providerId==='openai-compatible'||IMAGE_MODELS[v.providerId]===v.model;
export const imageAdapterInputSchema=z.object(generation).strict().refine(providerMatches,'Model does not belong to provider');
const generate=z.object({projectId:id,name,...generation,requestId:key,groupId:id.optional(),expectedRevision:revision.optional()}).strict()
 .refine(v=>(v.groupId===undefined)===(v.expectedRevision===undefined),'groupId and expectedRevision must be provided together').refine(providerMatches,'Model does not belong to provider');
const page={projectId:id,limit:z.number().int().min(1).max(IMAGE_LIMITS.maxPageSize).optional(),cursor:z.string().min(1).max(768).optional()};
export const imageSchemas=Object.freeze({
 'image.profile.list':z.object({}).strict(),
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
export const imageSnapshotSchema=z.object({schemaVersion:z.literal(1),projectId:id,groupId:id,taskId:id,name,...generation}).strict().refine(providerMatches,'Model does not belong to provider');
export const imageReceiptSchema=z.object({schemaVersion:z.literal(1),taskId:id,projectId:id,groupId:id,inputHash:hash,assetId:id,versionId:id,sha256:hash,mimeType:z.literal('image/png'),width:z.literal(1024),height:z.literal(1024),byteLength:z.number().int().min(1).max(IMAGE_LIMITS.resultBytes),isMock:z.boolean()}).strict();
export const imageSourceSchema=z.object({imageGroupId:id,imageTaskId:id,imageVersionId:id}).strict();
export const imageTaskResponseSchema=z.object({id,projectId:id,groupId:id,requestId:key,name,...generation,state:z.enum(IMAGE_STATES),revision,dispatched:z.boolean(),versionId:id.nullable(),errorCode:z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).nullable(),createdAt:timestamp,updatedAt:timestamp}).strict()
 .refine(providerMatches,'Model does not belong to provider')
 .refine(v=>(v.state==='succeeded')===(v.versionId!==null),'Only succeeded tasks have a version')
 .refine(v=>!['queued','interrupted_before_dispatch','cancelled_before_dispatch'].includes(v.state)||!v.dispatched,'Queued/cancelled tasks cannot have dispatched')
 .refine(v=>!['dispatching','receiving','persisting','succeeded','outcome_unknown','local_result_error'].includes(v.state)||v.dispatched,'Active/result tasks require dispatch fence');
export const imageGroupResponseSchema=z.object({id,projectId:id,name,revision,headVersionId:id.nullable(),activeTaskId:id.nullable(),createdAt:timestamp,updatedAt:timestamp}).strict();
export const imageVersionResponseSchema=z.object({id,projectId:id,groupId:id,taskId:id,number:revision,assetId:id,sha256:hash,mimeType:z.literal('image/png'),width:z.literal(1024),height:z.literal(1024),byteLength:z.number().int().min(1).max(IMAGE_LIMITS.resultBytes),isMock:z.boolean(),providerId,model,options:imageOptionsSchema,createdAt:timestamp}).strict()
 .refine(providerMatches,'Model does not belong to provider').refine(v=>v.isMock===(v.providerId==='mock'),'Mock identity mismatch');
export const imageProfileResponseSchema=z.object({providerId,model,name:z.string().min(1).max(120),enabled:z.boolean(),isMock:z.boolean(),evidence:z.enum(['deterministic-mock','offline-tested-not-live']),options:imageOptionsSchema}).strict()
 .refine(providerMatches,'Model does not belong to provider').refine(v=>v.isMock===(v.providerId==='mock')&&(!v.isMock||v.enabled)&&v.evidence===(v.isMock?'deterministic-mock':'offline-tested-not-live'),'Invalid image profile evidence');
export const imageProfilesResponseSchema=z.object({items:z.array(imageProfileResponseSchema).max(3),liveEnabled:z.boolean()}).strict().refine(v=>new Set(v.items.map(i=>i.providerId)).size===v.items.length&&v.liveEnabled===v.items.some(i=>i.providerId!=='mock'&&i.enabled));
export const imageRequestResponseSchema=z.object({projectId:id,requestId:key,operation:z.enum(IMAGE_MUTATION_OPERATIONS),response:imageTaskResponseSchema}).strict()
 .refine(v=>v.response.projectId===v.projectId&&(v.operation!=='image.generate'||v.response.requestId===v.requestId))
 .refine(v=>v.operation==='image.generate'?v.response.state==='queued'&&v.response.revision===1&&!v.response.dispatched
  :v.operation==='image.task.cancelQueued'?v.response.state==='cancelled_before_dispatch'&&v.response.revision>1&&!v.response.dispatched
  :v.response.state==='persisting'&&v.response.revision>1&&v.response.dispatched,'Receipt must describe the original operation acknowledgement').nullable();
export const isImageTaskResponse=v=>imageTaskResponseSchema.safeParse(v).success;
export const isImageGroupResponse=v=>imageGroupResponseSchema.safeParse(v).success;
export const isImageVersionResponse=v=>imageVersionResponseSchema.safeParse(v).success;
export const isImageRequestResponse=v=>imageRequestResponseSchema.safeParse(v).success;
export const isImageProfilesResponse=v=>imageProfilesResponseSchema.safeParse(v).success;
export function isImageMutationResponse(operation,input,result){
 if(!IMAGE_MUTATION_OPERATIONS.includes(operation)||!imageSchemas[operation].safeParse(input).success||!isImageTaskResponse(result)||result.projectId!==input.projectId)return false;
 if(operation==='image.generate')return result.requestId===input.requestId&&result.name===input.name&&result.prompt===input.prompt&&result.providerId===input.providerId&&result.model===input.model&&canonicalImageInput(result.options)===canonicalImageInput(input.options)&&result.state==='queued'&&result.revision===1&&!result.dispatched&&result.versionId===null&&(input.groupId===undefined||result.groupId===input.groupId);
 if(result.id!==input.taskId||result.revision!==input.expectedRevision+1)return false;
 return operation==='image.task.cancelQueued'?result.state==='cancelled_before_dispatch'&&!result.dispatched:result.state==='persisting'&&result.dispatched;
}
export function isImageListResponse(operation,input,result){
 const validate={'image.task.list':isImageTaskResponse,'image.group.list':isImageGroupResponse,'image.version.list':isImageVersionResponse}[operation];
 if(!validate||!imageSchemas[operation].safeParse(input).success||!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).sort().join(',')!=='items,nextCursor,projectId'||result.projectId!==input.projectId||!Array.isArray(result.items)||result.items.length>(input.limit??IMAGE_LIMITS.pageSize)||(result.nextCursor!==null&&(typeof result.nextCursor!=='string'||result.nextCursor.length<1||result.nextCursor.length>768)))return false;
 return new Set(result.items.map(v=>v?.id)).size===result.items.length&&result.items.every(v=>validate(v)&&v.projectId===input.projectId&&(!input.groupId||v.groupId===input.groupId));
}
