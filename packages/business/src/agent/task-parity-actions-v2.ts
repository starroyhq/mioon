import {AppError,PREVIS_LIMITS,canonicalImageInput,isImageMutationResponse,isImageProfilesResponse,isImageReviewPreparationResponse,
 isImageReviewResponse,isImageTaskResponse,isPrevisThumbnailGetResponse,isPrevisThumbnailSetResponse,isSubjectVariantBatch,
 isSubjectVariantMutationResponse,previsThumbnailPublicSchemas,subjectVariantImageRequestId,subjectVariantSchemas} from '@mioon/contracts';
import type {ImageProfilesResponse,ImageTaskResponse,PrevisThumbnailGetResponse,PrevisThumbnailSetResponse,SubjectVariantBatch} from '@mioon/contracts';
import type {OrdinaryServices} from '../services.ts';
import {previsJpegSize} from '../previs.ts';

type Row=Record<string,unknown>;
export type ParityThumbnailOperation='previs.thumbnail.get'|'previs.thumbnail.set';
export type ParityThumbnailInput=ReturnType<(typeof previsThumbnailPublicSchemas)[ParityThumbnailOperation]['parse']>;
type Services=Pick<OrdinaryServices,'call'|'imageApproval'>;
interface EffectContext {readonly signal?:AbortSignal|null;readonly beforeEffect:()=>void}
const record=(value:unknown):value is Row=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid=():never=>{throw new AppError('VALIDATION_ERROR','输入字段无效',400);};
const invalidResult=():never=>{throw new AppError('AGENT_TASK_INVALID_TOOL_RESULT','工具未返回与本次请求匹配的结果',409);};
function fence(context:EffectContext):void {context.signal?.throwIfAborted();context.beforeEffect();}

/** This is the only model argument that may carry bytes: one bounded JPEG,
 * checked with the same schema and container validator as ordinary clients. */
export function prepareParityThumbnail(operation:ParityThumbnailOperation,input:unknown,projectId:string,{format4}:{format4:boolean}):ParityThumbnailInput {
 if(!record(input)||Object.hasOwn(input,'projectId'))return invalid();
 if(operation==='previs.thumbnail.get'&&(!Array.isArray(input.slots)||input.slots.length!==1))return invalid();
 const parsed=previsThumbnailPublicSchemas[operation].safeParse({...input,projectId});
 if(!parsed.success||format4&&!parsed.data.framePresetId)return invalid();
 if(operation==='previs.thumbnail.set'){
  const value=parsed.data as ReturnType<typeof previsThumbnailPublicSchemas['previs.thumbnail.set']['parse']>;
  const bytes=Buffer.from(value.dataBase64,'base64'),size=previsJpegSize(bytes);
  if(bytes.toString('base64')!==value.dataBase64||bytes.length>PREVIS_LIMITS.thumbnailBytes||!size||size.width>PREVIS_LIMITS.thumbnailEdge||size.height>PREVIS_LIMITS.thumbnailEdge)return invalid();
 }
 return parsed.data;
}

export async function executeParityThumbnail({operation,input,services,...context}:EffectContext&{
 readonly operation:ParityThumbnailOperation;readonly input:ParityThumbnailInput;readonly services:Pick<Services,'call'>;
}):Promise<PrevisThumbnailGetResponse|PrevisThumbnailSetResponse>{
 const parsed=previsThumbnailPublicSchemas[operation].safeParse(input);
 if(!parsed.success)return invalid();
 if(operation==='previs.thumbnail.get'&&'slots' in parsed.data&&parsed.data.slots.length!==1)return invalid();
 fence(context);
 const result=await services.call(operation,parsed.data,{signal:context.signal});
 if(!(operation==='previs.thumbnail.get'?isPrevisThumbnailGetResponse(parsed.data,result):isPrevisThumbnailSetResponse(parsed.data,result)))return invalidResult();
 // The validators cap every image at 64 KiB and only expose the requested
 // owned node/slots. Generic tool projection intentionally strips raw bytes.
 return result as PrevisThumbnailGetResponse|PrevisThumbnailSetResponse;
}

type VariantRetryInput=ReturnType<typeof subjectVariantSchemas['subject.variants.retry']['parse']>;
function ownedBatch(value:unknown,projectId:string,batchId:string):SubjectVariantBatch {
 if(!isSubjectVariantBatch(value)||value.projectId!==projectId||value.id!==batchId)return invalidResult();
 return value;
}
function retryCandidate(batch:SubjectVariantBatch,input:VariantRetryInput):void {
 if(batch.revision!==input.expectedRevision)throw new AppError('REVISION_CONFLICT','这批变体已有新版本，请重新读取',409);
 const item=batch.items[input.position-1];
 if(batch.state!=='active'||!item||item.versionId!==null||!item.image||!['failed','cancelled_before_dispatch'].includes(item.image.state))
  throw new AppError('SUBJECT_VARIANT_RETRY_UNAVAILABLE','这张变体当前不能重试',409);
}

/** The caller must obtain the task's explicit paid approval before entering
 * here. The retry receipt rotates one attempt, then its exact derived image
 * request goes through the existing per-generation review/dispatch gate. */
export async function executeSubjectVariantRetry({services,projectId,input, ...context}:EffectContext&{
 readonly services:Services;readonly projectId:string;readonly input:unknown;
}):Promise<{batch:SubjectVariantBatch;task:ImageTaskResponse}>{
 const parsed=subjectVariantSchemas['subject.variants.retry'].safeParse(input);
 if(!parsed.success||parsed.data.projectId!==projectId)return invalid();
 const request=parsed.data,getInput={projectId,batchId:request.batchId};
 fence(context);
 const previous=ownedBatch(await services.call('subject.variants.get',getInput,{signal:context.signal}),projectId,request.batchId);
 retryCandidate(previous,request);
 let settingsRevision:number|undefined;
 if(previous.providerId!=='mock'){
  fence(context);
  const profileInput={includeSettingsRevision:true},profiles=await services.call('image.profile.list',profileInput,{signal:context.signal});
  if(!isImageProfilesResponse(profiles,profileInput))return invalidResult();
  const profile=(profiles as ImageProfilesResponse).items.find(item=>item.enabled&&item.providerId===previous.providerId&&item.model===previous.model);
  if(!profile||!('settingsRevision' in profile)||typeof profile.settingsRevision!=='number')
   throw new AppError('AGENT_TASK_GENERATION_SERVICE_UNAVAILABLE','这个生成服务当前不可用',409);
  settingsRevision=profile.settingsRevision;
 }
 fence(context);
 const rotated=await services.call('subject.variants.retry',request,{signal:context.signal});
 if(!isSubjectVariantMutationResponse('subject.variants.retry',request,rotated))return invalidResult();
 const batch=ownedBatch(rotated,projectId,request.batchId),item=batch.items[request.position-1]!,priorItem=previous.items[request.position-1]!;
 const imageInput=item.imageInput;
 if(batch.subjectId!==previous.subjectId||batch.sourceVersionId!==previous.sourceVersionId||batch.providerId!==previous.providerId||batch.model!==previous.model||batch.kind!==previous.kind||batch.size!==previous.size||
  item.attempt!==priorItem.attempt+1||imageInput.projectId!==projectId||imageInput.providerId!==batch.providerId||imageInput.model!==batch.model||
  canonicalImageInput({...imageInput,requestId:priorItem.imageInput.requestId})!==canonicalImageInput(priorItem.imageInput)||
  imageInput.requestId!==subjectVariantImageRequestId(batch.id,request.position,item.attempt))return invalidResult();
 // A changed batch or a lost response must never cause a second rotation or
 // dispatch. Only this still-pending exact attempt can proceed once.
 const stillCurrent=async():Promise<void>=>{
  fence(context);
  const current=ownedBatch(await services.call('subject.variants.get',getInput,{signal:context.signal}),projectId,batch.id),live=current.items[request.position-1];
  if(current.state!=='active'||current.revision!==batch.revision||!live||live.attempt!==item.attempt||live.status!=='pending'||live.image!==null||live.versionId!==null||
   canonicalImageInput(live.imageInput)!==canonicalImageInput(imageInput))throw new AppError('AGENT_TASK_TARGET_CHANGED','这张变体已经变化，请重新读取',409);
 };
 await stillCurrent();
 let task:unknown;
 if(batch.providerId==='mock'){
  fence(context);
  task=await services.call('image.generate',imageInput,{signal:context.signal});
 }else{
  fence(context);
  const reviewInput={input:imageInput,settingsRevision},review=await services.call('image.review.prepare',reviewInput,{signal:context.signal});
  if(!isImageReviewPreparationResponse(reviewInput,review)||!isImageReviewResponse(review)||review.state!=='pending')return invalidResult();
  await stillCurrent();
  fence(context);
  task=await services.imageApproval({projectId,reviewId:review.id,expectedRevision:review.revision});
 }
 if(!isImageMutationResponse('image.generate',imageInput,task)||!isImageTaskResponse(task))return invalidResult();
 return {batch,task};
}
