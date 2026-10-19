import {z} from 'zod';
import {SOURCE_RANGE_FPS,sourceFrameCount} from './source-range.ts';

// This profile names a local decoder contract, never a provider/model choice.
// sourceFrame is a requested 30fps mark; it is not an observed native/VFR PTS.
export const FRAME_PROFILE_ID='local-png-1024-v1';
export const FRAME_SELECTION_RULE='first-pts-at-or-after-v1';
export const FRAME_PROFILE=Object.freeze({id:FRAME_PROFILE_ID,maxEdge:1024,mimeType:'image/png',upscale:false,selectionRule:FRAME_SELECTION_RULE});
export const FRAME_STATES=Object.freeze(['queued','running','persisting','succeeded','cancelled_before_start','interrupted','local_result_error','failed']);
export const FRAME_MUTATION_OPERATIONS=Object.freeze(['frame.extract','frame.task.cancelQueued','frame.task.recoverResult']);
export const FRAME_LIMITS=Object.freeze({
 inputBytes:4096,snapshotBytes:4096,receiptBytes:4096,taskBytes:16384,requestBytes:12288,responseBytes:4096,
 pageSize:20,maxPageSize:50,cursorBytes:768,activeGlobal:1,queuedPerProject:2,queuedGlobal:8,
 tasksPerProject:256,tasksGlobal:2048,requestsPerTask:16,reservedControlRequestsPerTask:15,requestsPerProject:4096,requestsGlobal:32768,
 sourceBytes:512*1024*1024,sourceDuration:600,sourceMaxEdge:4096,sourceMaxPixels:8*1024*1024,
 resultBytes:4*1024*1024,resultMaxEdge:1024,resultMaxPixels:1024*1024,relativePathBytes:1024,
});
export const canonicalFrameInput=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const encoder=new TextEncoder();
const bytes=value=>encoder.encode(typeof value==='string'?value:JSON.stringify(value)).length;
const bounded=(schema,limit)=>schema.refine(value=>bytes(value)<=limit,'Frame record exceeds its byte limit');
const id=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
const requestId=z.string().min(8).max(200).refine(value=>bytes(value)<=800,'Request ID exceeds its byte limit');
const revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const frame=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp=z.string().min(1).max(40).refine(value=>Number.isFinite(Date.parse(value)),'Invalid timestamp');
const sourceDimension=z.number().int().min(1).max(FRAME_LIMITS.sourceMaxEdge);
const outputDimension=z.number().int().min(1).max(FRAME_LIMITS.resultMaxEdge);
const cursor=z.string().min(1).max(FRAME_LIMITS.cursorBytes).refine(value=>bytes(value)<=FRAME_LIMITS.cursorBytes,'Cursor exceeds its byte limit');
const control={projectId:id,taskId:id,expectedRevision:revision,requestId};
export const frameSchemas=Object.freeze({
 'frame.extract':z.object({projectId:id,sourceAssetId:id,sourceHash:hash,sourceFrame:frame,requestId}).strict(),
 'frame.request.get':z.object({projectId:id,requestId}).strict(),
 'frame.task.get':z.object({projectId:id,taskId:id}).strict(),
 'frame.task.list':z.object({projectId:id,limit:z.number().int().min(1).max(FRAME_LIMITS.maxPageSize).optional(),cursor:cursor.optional()}).strict(),
 'frame.task.cancelQueued':z.object(control).strict(),
 'frame.task.recoverResult':z.object(control).strict(),
});
export const frameProfileSchema=z.object({id:z.literal(FRAME_PROFILE_ID),maxEdge:z.literal(FRAME_LIMITS.resultMaxEdge),mimeType:z.literal('image/png'),upscale:z.literal(false),selectionRule:z.literal(FRAME_SELECTION_RULE)}).strict();
// Internal only. Filesystem identity is frozen at acceptance and never exposed
// by task/request DTOs. Runtime must additionally validate the managed path.
const relativePath=z.string().min(1).max(FRAME_LIMITS.relativePathBytes).refine(value=>
 bytes(value)<=FRAME_LIMITS.relativePathBytes&&!/[\\:\u0000-\u001f\u007f]/.test(value)&&
 !value.startsWith('/')&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'),
 'Source must have a bounded relative managed path');
export const frameSnapshotSchema=bounded(z.object({
 schemaVersion:z.literal(1),projectId:id,taskId:id,
 source:z.object({assetId:id,sha256:hash,mimeType:z.enum(['video/mp4','video/webm']),sizeBytes:z.number().int().min(1).max(FRAME_LIMITS.sourceBytes),relativePath,
  duration:z.number().finite().positive().max(FRAME_LIMITS.sourceDuration),width:sourceDimension,height:sourceDimension}).strict(),
 requested:z.object({sourceFrame:frame,fps:z.literal(SOURCE_RANGE_FPS)}).strict(),profile:frameProfileSchema,
}).strict().refine(value=>value.source.width*value.source.height<=FRAME_LIMITS.sourceMaxPixels,'Source geometry exceeds profile')
 .refine(value=>sourceFrameCount(value.source.duration)!==null&&value.requested.sourceFrame<sourceFrameCount(value.source.duration),'Requested mark is outside frozen source bounds'),FRAME_LIMITS.snapshotBytes);
export const frameProbeSchema=z.object({streamIndex:z.number().int().min(0).max(255),timeBaseNumerator:z.literal(1),timeBaseDenominator:z.number().int().min(1).max(1_000_000_000),
 width:sourceDimension,height:sourceDimension,rotation:z.literal(0),sarNumerator:z.literal(1),sarDenominator:z.literal(1)}).strict()
 .refine(value=>value.width*value.height<=FRAME_LIMITS.sourceMaxPixels,'Probe geometry exceeds profile');
export const frameOutputSchema=z.object({assetId:id,sha256:hash,mimeType:z.literal('image/png'),width:outputDimension,height:outputDimension,byteLength:z.number().int().min(1).max(FRAME_LIMITS.resultBytes)}).strict();
export const frameReceiptSchema=bounded(z.object({schemaVersion:z.literal(1),projectId:id,taskId:id,inputHash:hash,
 sourceAssetId:id,sourceHash:hash,sourceFrame:frame,fps:z.literal(SOURCE_RANGE_FPS),profileId:z.literal(FRAME_PROFILE_ID),selectionRule:z.literal(FRAME_SELECTION_RULE),
 ...frameOutputSchema.shape,probe:frameProbeSchema,
}).strict().refine(value=>value.assetId!==value.sourceAssetId,'An extracted frame must own a new asset')
 .refine(value=>{const ratio=Math.min(1,FRAME_LIMITS.resultMaxEdge/Math.max(value.probe.width,value.probe.height));return value.width===Math.max(1,Math.round(value.probe.width*ratio))&&value.height===Math.max(1,Math.round(value.probe.height*ratio));},'Output geometry must follow the frozen no-upscale profile'),FRAME_LIMITS.receiptBytes);
export const frameTaskResponseSchema=bounded(z.object({id,projectId:id,requestId,sourceAssetId:id,sourceHash:hash,sourceFrame:frame,fps:z.literal(SOURCE_RANGE_FPS),profileId:z.literal(FRAME_PROFILE_ID),
 state:z.enum(FRAME_STATES),revision,started:z.boolean(),result:frameOutputSchema.nullable(),errorCode:z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).nullable(),createdAt:timestamp,updatedAt:timestamp,
}).strict().refine(value=>(value.state==='succeeded')===(value.result!==null),'Only a succeeded task has a published result')
 .refine(value=>!['queued','cancelled_before_start'].includes(value.state)||!value.started,'An unstarted task cannot have crossed its start fence')
 .refine(value=>!['running','persisting','succeeded','local_result_error'].includes(value.state)||value.started,'Active/result tasks require the start fence')
 .refine(value=>!['queued','running','persisting','succeeded','cancelled_before_start'].includes(value.state)||value.errorCode===null,'Healthy and cancelled tasks cannot carry an error')
 .refine(value=>value.state!=='queued'||value.revision===1,'Queued tasks retain their original revision')
 .refine(value=>value.result===null||value.result.assetId!==value.sourceAssetId,'An extracted frame must own a new asset'),FRAME_LIMITS.responseBytes);
export const frameRequestResponseSchema=z.object({projectId:id,requestId,operation:z.enum(FRAME_MUTATION_OPERATIONS),response:frameTaskResponseSchema}).strict()
 .refine(value=>value.response.projectId===value.projectId&&(value.operation!=='frame.extract'||value.response.requestId===value.requestId),'Request acknowledgement identity mismatch')
 .refine(value=>value.operation==='frame.extract'?value.response.state==='queued'&&value.response.revision===1&&!value.response.started:
  value.operation==='frame.task.cancelQueued'?value.response.state==='cancelled_before_start'&&value.response.revision>1&&!value.response.started:
  value.response.state==='persisting'&&value.response.revision>1&&value.response.started,'Receipt must describe the original operation acknowledgement').nullable();
export const isFrameTaskResponse=value=>frameTaskResponseSchema.safeParse(value).success;
export const isFrameRequestResponse=value=>frameRequestResponseSchema.safeParse(value).success;
export function isFrameMutationResponse(operation,input,result){
 if(!FRAME_MUTATION_OPERATIONS.includes(operation)||!frameSchemas[operation].safeParse(input).success||!isFrameTaskResponse(result)||result.projectId!==input.projectId)return false;
 if(operation==='frame.extract')return result.requestId===input.requestId&&result.sourceAssetId===input.sourceAssetId&&result.sourceHash===input.sourceHash&&result.sourceFrame===input.sourceFrame&&result.state==='queued'&&result.revision===1&&!result.started&&result.result===null;
 if(result.id!==input.taskId||result.revision!==input.expectedRevision+1)return false;
 return operation==='frame.task.cancelQueued'?result.state==='cancelled_before_start'&&!result.started:result.state==='persisting'&&result.started;
}
export function isFrameListResponse(operation,input,result){
 if(operation!=='frame.task.list'||!frameSchemas[operation].safeParse(input).success||!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).sort().join(',')!=='items,nextCursor,projectId'||result.projectId!==input.projectId||!Array.isArray(result.items)||result.items.length>(input.limit??FRAME_LIMITS.pageSize)||(result.nextCursor!==null&&!cursor.safeParse(result.nextCursor).success))return false;
 return new Set(result.items.map(value=>value?.id)).size===result.items.length&&result.items.every(value=>isFrameTaskResponse(value)&&value.projectId===input.projectId);
}
