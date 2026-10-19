import {z} from 'zod';
import {imageSourceSchema} from './images.ts';
import {FRAME_PROFILE_ID,FRAME_SELECTION_RULE} from './frame-extraction.ts';
import {SOURCE_RANGE_FPS} from './source-range.ts';

export const SUBJECT_KINDS=Object.freeze(['character','product','location','look'] as const);
export const SUBJECT_MUTATION_OPERATIONS=Object.freeze(['subject.create','subject.version.add','subject.binding.set'] as const);
export type SubjectMutationOperation = (typeof SUBJECT_MUTATION_OPERATIONS)[number];
export const SUBJECT_LIMITS=Object.freeze({inputBytes:8192,responseBytes:16384,pageSize:20,maxPageSize:50,bindingsPerShot:8});
const id=z.string().uuid(),revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),key=z.string().min(8).max(200);
const page={projectId:id,limit:z.number().int().min(1).max(50).optional(),cursor:z.string().min(1).max(768).optional()};
export const subjectSchemas=Object.freeze({
 'subject.create':z.object({projectId:id,kind:z.enum(SUBJECT_KINDS),name:z.string().min(1).max(120).refine(value=>Boolean(value.trim()),'Name must not be blank'),assetId:id,requestId:key}).strict(),
 'subject.version.add':z.object({projectId:id,subjectId:id,expectedRevision:revision,assetId:id,requestId:key}).strict(),
 'subject.binding.set':z.object({projectId:id,shotId:id,subjectId:id,role:z.enum(['subject','style']),subjectVersionId:id.nullable(),expectedRevision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),expectedSubjectRevision:revision,requestId:key}).strict(),
 'subject.list':z.object(page).strict(),
 'subject.version.list':z.object({...page,subjectId:id}).strict(),
 'subject.binding.list':z.object({...page,shotId:id.optional(),subjectId:id.optional()}).strict().refine(value=>Boolean(value.shotId)!==Boolean(value.subjectId),'Exactly one shotId or subjectId filter is required'),
});
const timestamp=z.string().min(1).max(40);
const frameSourceSchema=z.object({frameTaskId:id,sourceAssetId:id,sourceHash:z.string().regex(/^[a-f0-9]{64}$/),sourceFrame:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),fps:z.literal(SOURCE_RANGE_FPS),profileId:z.literal(FRAME_PROFILE_ID),selectionRule:z.literal(FRAME_SELECTION_RULE)}).strict();
export const subjectVersionResponseSchema=z.object({id,projectId:id,subjectId:id,number:revision,assetId:id,sha256:z.string().regex(/^[a-f0-9]{64}$/),mimeType:z.enum(['image/png','image/jpeg','image/webp']),width:z.number().int().min(1).max(100000),height:z.number().int().min(1).max(100000),provenance:z.object({kind:z.enum(['user-import','generated','synthetic-mock','export','extracted-frame']),versionId:id.nullable(),shotId:id.nullable(),jobId:id.nullable(),imageSource:imageSourceSchema.optional(),frameSource:frameSourceSchema.optional()}).strict().refine(v=>v.frameSource!==undefined?v.kind==='extracted-frame'&&v.imageSource===undefined&&[v.versionId,v.shotId,v.jobId].every(x=>x===null):v.kind==='extracted-frame'?false:v.imageSource!==undefined?['generated','synthetic-mock'].includes(v.kind)&&[v.versionId,v.shotId,v.jobId].every(x=>x===null):[v.versionId,v.shotId,v.jobId].every(x=>x===null)||[v.versionId,v.shotId,v.jobId].every(x=>x!==null)),createdAt:timestamp}).strict();
export const subjectResponseSchema=z.object({id,projectId:id,kind:z.enum(SUBJECT_KINDS),name:z.string().min(1).max(120),revision,headVersionId:id,headVersion:subjectVersionResponseSchema,createdAt:timestamp,updatedAt:timestamp}).strict().refine(v=>v.headVersion.id===v.headVersionId&&v.headVersion.subjectId===v.id&&v.headVersion.projectId===v.projectId&&v.headVersion.number===v.revision);
export const subjectBindingResponseSchema=z.object({id,projectId:id,shotId:id,subjectId:id,role:z.enum(['subject','style']),revision,subjectVersionId:id.nullable(),reviewedHeadVersionId:id,headVersionId:id,subjectRevision:revision,needsReview:z.boolean(),createdAt:timestamp,updatedAt:timestamp}).strict().refine(v=>v.needsReview===(v.subjectVersionId!==null&&v.reviewedHeadVersionId!==v.headVersionId));
export type SubjectVersionResponse = z.infer<typeof subjectVersionResponseSchema>;
export type SubjectResponse = z.infer<typeof subjectResponseSchema>;
export type SubjectBindingResponse = z.infer<typeof subjectBindingResponseSchema>;
export function isSubjectVersionResponse(value: unknown): value is SubjectVersionResponse {return subjectVersionResponseSchema.safeParse(value).success;}
export function isSubjectResponse(value: unknown): value is SubjectResponse {return subjectResponseSchema.safeParse(value).success;}
export function isSubjectBindingResponse(value: unknown): value is SubjectBindingResponse {return subjectBindingResponseSchema.safeParse(value).success;}
const subjectOperationSchemas = subjectSchemas as Record<string, z.ZodTypeAny>;
export function isSubjectMutationResponse(operation: unknown, input: unknown, result: unknown): boolean {
 const request = input as Record<string, unknown>;
 if(typeof operation!=='string'||!(SUBJECT_MUTATION_OPERATIONS as readonly string[]).includes(operation)||!subjectOperationSchemas[operation].safeParse(input).success||(result as {projectId?: unknown} | null | undefined)?.projectId!==request.projectId)return false;
 if(operation==='subject.create')return isSubjectResponse(result)&&result.revision===1&&result.kind===request.kind&&result.name===request.name&&result.headVersion.assetId===request.assetId;
 if(operation==='subject.version.add')return isSubjectResponse(result)&&result.id===request.subjectId&&result.revision===(request.expectedRevision as number)+1&&result.headVersion.assetId===request.assetId;
 return isSubjectBindingResponse(result)&&result.shotId===request.shotId&&result.subjectId===request.subjectId&&result.role===request.role&&result.subjectVersionId===request.subjectVersionId&&result.revision===(request.expectedRevision as number)+1&&result.subjectRevision===request.expectedSubjectRevision&&result.reviewedHeadVersionId===result.headVersionId&&result.needsReview===false;
}
export function isSubjectListResponse(operation: unknown, input: unknown, result: unknown): boolean {
 const request = input as Record<string, unknown>;
 if(typeof operation!=='string'||!['subject.list','subject.version.list','subject.binding.list'].includes(operation)||!subjectOperationSchemas[operation].safeParse(input).success||!result||typeof result!=='object'||Array.isArray(result))return false;
 const page = result as {items?: unknown; nextCursor?: unknown; projectId?: unknown};
 if(Object.keys(result).sort().join(',')!=='items,nextCursor,projectId'||page.projectId!==request.projectId||!Array.isArray(page.items)||page.items.length>((request.limit as number | undefined)??20)||(page.nextCursor!==null&&(typeof page.nextCursor!=='string'||page.nextCursor.length>768)))return false;
 const validate = operation==='subject.list'?isSubjectResponse:operation==='subject.version.list'?isSubjectVersionResponse:isSubjectBindingResponse;
 const items = page.items as Record<string, unknown>[];
 return new Set(items.map(item=>item?.id)).size===items.length&&items.every(item=>{
  if(!validate(item)||item.projectId!==request.projectId)return false;
  const identity = item as Record<string, unknown>;
  return (!request.subjectId||(operation==='subject.list'?identity.id:identity.subjectId)===request.subjectId)&&(!request.shotId||identity.shotId===request.shotId);
 });
}
