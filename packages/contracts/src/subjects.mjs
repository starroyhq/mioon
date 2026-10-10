import {z} from 'zod';

export const SUBJECT_KINDS=Object.freeze(['character','product','location','look']);
export const SUBJECT_MUTATION_OPERATIONS=Object.freeze(['subject.create','subject.version.add','subject.binding.set']);
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
export const subjectVersionResponseSchema=z.object({id,projectId:id,subjectId:id,number:revision,assetId:id,sha256:z.string().regex(/^[a-f0-9]{64}$/),mimeType:z.enum(['image/png','image/jpeg','image/webp']),width:z.number().int().min(1).max(100000),height:z.number().int().min(1).max(100000),provenance:z.object({kind:z.enum(['user-import','generated','synthetic-mock','export']),versionId:id.nullable(),shotId:id.nullable(),jobId:id.nullable()}).strict().refine(v=>[v.versionId,v.shotId,v.jobId].every(x=>x===null)||[v.versionId,v.shotId,v.jobId].every(x=>x!==null)),createdAt:timestamp}).strict();
export const subjectResponseSchema=z.object({id,projectId:id,kind:z.enum(SUBJECT_KINDS),name:z.string().min(1).max(120),revision,headVersionId:id,headVersion:subjectVersionResponseSchema,createdAt:timestamp,updatedAt:timestamp}).strict().refine(v=>v.headVersion.id===v.headVersionId&&v.headVersion.subjectId===v.id&&v.headVersion.projectId===v.projectId&&v.headVersion.number===v.revision);
export const subjectBindingResponseSchema=z.object({id,projectId:id,shotId:id,subjectId:id,role:z.enum(['subject','style']),revision,subjectVersionId:id.nullable(),reviewedHeadVersionId:id,headVersionId:id,subjectRevision:revision,needsReview:z.boolean(),createdAt:timestamp,updatedAt:timestamp}).strict().refine(v=>v.needsReview===(v.subjectVersionId!==null&&v.reviewedHeadVersionId!==v.headVersionId));
export const isSubjectVersionResponse=value=>subjectVersionResponseSchema.safeParse(value).success;
export const isSubjectResponse=value=>subjectResponseSchema.safeParse(value).success;
export const isSubjectBindingResponse=value=>subjectBindingResponseSchema.safeParse(value).success;
export function isSubjectMutationResponse(operation,input,result){
 if(!SUBJECT_MUTATION_OPERATIONS.includes(operation)||!subjectSchemas[operation].safeParse(input).success||result?.projectId!==input.projectId)return false;
 if(operation==='subject.create')return isSubjectResponse(result)&&result.revision===1&&result.kind===input.kind&&result.name===input.name&&result.headVersion.assetId===input.assetId;
 if(operation==='subject.version.add')return isSubjectResponse(result)&&result.id===input.subjectId&&result.revision===input.expectedRevision+1&&result.headVersion.assetId===input.assetId;
 return isSubjectBindingResponse(result)&&result.shotId===input.shotId&&result.subjectId===input.subjectId&&result.role===input.role&&result.subjectVersionId===input.subjectVersionId&&result.revision===input.expectedRevision+1&&result.subjectRevision===input.expectedSubjectRevision&&result.reviewedHeadVersionId===result.headVersionId&&result.needsReview===false;
}
export function isSubjectListResponse(operation,input,result){
 if(!['subject.list','subject.version.list','subject.binding.list'].includes(operation)||!subjectSchemas[operation].safeParse(input).success||!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).sort().join(',')!=='items,nextCursor,projectId'||result.projectId!==input.projectId||!Array.isArray(result.items)||result.items.length>(input.limit??20)||(result.nextCursor!==null&&(typeof result.nextCursor!=='string'||result.nextCursor.length>768)))return false;
 const validate=operation==='subject.list'?isSubjectResponse:operation==='subject.version.list'?isSubjectVersionResponse:isSubjectBindingResponse;
 return new Set(result.items.map(item=>item?.id)).size===result.items.length&&result.items.every(item=>validate(item)&&item.projectId===input.projectId&&(!input.subjectId||(operation==='subject.list'?item.id:item.subjectId)===input.subjectId)&&(!input.shotId||item.shotId===input.shotId));
}
