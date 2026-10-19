import {z} from 'zod';
import {subjectVersionResponseSchema} from './subjects.ts';
import {getCapabilityProfile, SUBJECT_REFERENCE_PROFILE_VERSION} from './generation-input-profiles.ts';

export const SUBJECT_GENERATION_KINDS=Object.freeze(['character','product','location']);
export const SUBJECT_GENERATION_RESPONSE_BYTES=256*1024;
export const subjectReferenceSchema=z.object({
 subjectVersionId:z.string().uuid(),
 subjectName:z.string().min(1).max(120).refine(value=>Boolean(value.trim()),'Name must not be blank'),
 subjectKind:z.enum(SUBJECT_GENERATION_KINDS),
 subjectVersion:subjectVersionResponseSchema,
}).strict().refine(value=>value.subjectVersionId===value.subjectVersion.id,'The selected immutable version must match the frozen version.');

const own=(value,key)=>Object.hasOwn(value,key);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&!Object.getOwnPropertySymbols(value).length&&Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>!d.get&&!d.set&&d.enumerable);
const dense=(value,max=8)=>{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max)return false;
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
 return keys.length===value.length+1&&keys.every(key=>key==='length'||typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)&&Number(key)<value.length&&!descriptors[key].get&&!descriptors[key].set&&descriptors[key].enumerable);
};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const text=(value,min,max)=>typeof value==='string'&&value.length>=min&&value.length<=max;
const integer=(value,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const fields=(value,required,optional=[])=>record(value)&&required.every(key=>own(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const timestamp=value=>text(value,1,64)&&Number.isFinite(Date.parse(value));
const encoder=new TextEncoder();
// Do not invoke getters, inherited toJSON hooks, or cycles while checking a
// response. All accepted records are ordinary bounded wire data.
function safeData(value){
 const seen=new Set();let nodes=0;
 const visit=(item,depth)=>{
  if(++nodes>10000||depth>24)return false;
  if(item===null||typeof item==='boolean'||typeof item==='string')return true;
  if(typeof item==='number')return Number.isFinite(item);
  if(typeof item!=='object'||seen.has(item)||!(Array.isArray(item)?dense(item,10000):record(item)))return false;
  seen.add(item);const valid=Object.values(item).every(child=>visit(child,depth+1));seen.delete(item);return valid;
 };
 return visit(value,0);
}
const same=(left,right)=>left===right||Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((value,index)=>same(value,right[index]))||record(left)&&record(right)&&Object.keys(left).length===Object.keys(right).length&&Object.keys(left).every(key=>own(right,key)&&same(left[key],right[key]));
export const isSubjectReference=value=>safeData(value)&&subjectReferenceSchema.safeParse(value).success;

/** Check a frozen subject manifest without resolving a subject, head or asset.
 * No subject claim means legacy input is left alone. Any partial subject claim
 * fails closed instead of acquiring first-frame semantics. Authoritative callers
 * supply projectId; historical snapshots need not grow a new projectId field.
 * Unpinned planning input is allowed. Frozen consumers must requireProfilePin;
 * partial pins never fall back to planning or the currently active profile.
 */
export function getSubjectGenerationSnapshotIssue(snapshot,options={}){
 const issue=(message,path=[])=>({code:'INVALID_REFERENCE_MANIFEST',message,path});
 if(!record(snapshot)||!fields(options,[],['projectId','requireProfilePin'])||own(options,'requireProfilePin')&&typeof options.requireProfilePin!=='boolean')return issue('主体生成快照和检查选项必须为普通数据对象');
 const subjectRole=items=>dense(items)&&items.some(item=>record(item)&&item.role==='subject_reference');
 const claims=own(snapshot,'subjectReference')||own(snapshot,'subjectVersionId')||subjectRole(snapshot.referenceAssets)||subjectRole(snapshot.referenceBindings);
 if(!claims)return null;
 if(own(snapshot,'subjectVersionId')||!isSubjectReference(snapshot.subjectReference))return issue('必须冻结一个完整且有效的主体版本，不能使用规划风格或推断首帧',['subjectReference']);
 const {subjectVersion:version}=snapshot.subjectReference;
 if(options.projectId!==undefined&&(!uuid(options.projectId)||version.projectId!==options.projectId)||own(snapshot,'projectId')&&snapshot.projectId!==version.projectId)return issue('主体版本必须属于本次生成的项目',['subjectReference','subjectVersion','projectId']);
 const pinKeys=['inputProfileId','inputProfileVersion','providerRegion'];
 let profile;
 if(options.requireProfilePin||pinKeys.some(key=>own(snapshot,key))){
  profile=getCapabilityProfile(snapshot.providerId,snapshot.model,snapshot.providerRegion,{profileId:snapshot.inputProfileId,profileVersion:snapshot.inputProfileVersion});
  if(!pinKeys.every(key=>own(snapshot,key))||!profile||profile.profileVersion!==SUBJECT_REFERENCE_PROFILE_VERSION||!profile.inputs.roles.subject_reference.implemented)return issue('主体生成必须固定完整的已实现 v3 输入配置和供应商区域',['inputProfileId']);
 }
 if(!dense(snapshot.referenceAssetIds)||snapshot.referenceAssetIds.length!==1||snapshot.referenceAssetIds[0]!==version.assetId)return issue('主体生成必须只包含所选版本的一个素材 ID',['referenceAssetIds']);
 const bindings=snapshot.referenceBindings;
 if(!dense(bindings)||bindings.length!==1||!fields(bindings[0],['role','assetId','sha256'])||bindings[0].role!=='subject_reference'||bindings[0].assetId!==version.assetId||bindings[0].sha256!==version.sha256)return issue('主体生成必须包含与所选版本完全一致的显式角色和哈希',['referenceBindings']);
 const assets=snapshot.referenceAssets,asset=dense(assets)&&assets.length===1?assets[0]:null;
 if(!record(asset)||asset.role!=='subject_reference'||asset.id!==version.assetId||['sha256','mimeType','width','height'].some(key=>asset[key]!==version[key])||!integer(asset.sizeBytes,1)||own(asset,'projectId')&&asset.projectId!==version.projectId||own(asset,'durationSeconds')||own(asset,'duration')&&asset.duration!==0)return issue('主体素材元数据必须完整且与冻结版本一致',['referenceAssets']);
 if(profile){
  const rule=profile.inputs.roles.subject_reference,dims=rule.dimensions;
  if(!rule.mimeTypes.includes(asset.mimeType)||asset.sizeBytes>rule.maxBytes||dims&&
      ([asset.width,asset.height].some(value=>value<dims.min||dims.max!==null&&value>dims.max)||dims.minAspectRatio!==undefined&&asset.width/asset.height<dims.minAspectRatio||dims.maxAspectRatio!==undefined&&asset.width/asset.height>dims.maxAspectRatio))return issue('主体图片不符合冻结输入配置的格式、大小或尺寸限制',['referenceAssets']);
 }
 if(options.requireProfilePin&&!own(snapshot,'referenceConnections')||own(snapshot,'referenceConnections')&&(!dense(snapshot.referenceConnections)||snapshot.referenceConnections.length!==0)||own(snapshot,'lastFrameAssetId')&&snapshot.lastFrameAssetId!==null)return issue('主体参考必须明确没有首帧连线，不能与首帧或尾帧混合',['referenceConnections']);
 return null;
}

const jobFields=['id','projectId','shotId','requestId','providerId','model','revision','status','phase','progress','snapshot','providerJobId','submissionCount','error','createdAt','updatedAt','versionId','cancelScope','retryOfJobId'];
const snapshotFields=['shotId','shotRevision','title','prompt','referenceAssetIds','referenceAssets','referenceConnections','aspectRatio','duration','providerId','model','parameters','capabilities','inputProfileVersion','inputProfileId','providerRegion','referenceBindings','subjectReference'];
const statuses=['queued','submitting','running','downloading','submission_unknown','failed','cancelled','succeeded'];
const scenarios=['success','failure','delay','timeout','unknown','reject','download_fail_once','rejected_before_accept','accepted_then_response_lost','poll_timeout_then_recover','terminal_failure'];
const parameters=value=>fields(value,[],['scenario','delayMs','seed'])&&(!own(value,'scenario')||scenarios.includes(value.scenario))&&(!own(value,'delayMs')||integer(value.delayMs,0,120000))&&(!own(value,'seed')||Number.isSafeInteger(value.seed));

/** Opt-in receipt matching for explicit subject generation.submit only.
 * A progressed public job may prove its original submit, never a job.retry or
 * a coincident request key. This does not change any historical ACK policy.
 * UI callers can additionally bind the complete reference reviewed before send.
 */
export function isSubjectGenerationResponse(operation,input,result,options={}){
 return operation==='generation.submit'&&matchesSubjectGenerationResponse(input,result,options,null);
}
function matchesSubjectGenerationResponse(input,result,options,expectedRetryOfJobId){
 if(!safeData(input)||!safeData(result)||!fields(options,[],['projectId','subjectReference']))return false;
 if(!fields(input,['shotId','expectedRevision','requestId','providerId','subjectVersionId'],['model','parameters'])||!uuid(input.shotId)||!uuid(input.subjectVersionId)||!integer(input.expectedRevision,1)||!text(input.requestId,8,200)||!['mock','ark'].includes(input.providerId)||own(input,'model')&&!text(input.model,0,100)||own(input,'parameters')&&!parameters(input.parameters))return false;
 if(!fields(result,jobFields,['allowedActions','nextPollAt'])||!uuid(result.id)||!uuid(result.projectId)||result.requestId!==input.requestId||result.shotId!==input.shotId||result.providerId!==input.providerId||input.model&&result.model!==input.model||!text(result.model,1,100)||!integer(result.revision,1)||!statuses.includes(result.status)||!text(result.phase,1,100)||!integer(result.progress,0,100)||!integer(result.submissionCount,0)||!timestamp(result.createdAt)||!timestamp(result.updatedAt)||result.retryOfJobId!==expectedRetryOfJobId||!(result.providerJobId===null||text(result.providerJobId,1,200))||!(result.versionId===null||uuid(result.versionId))||![null,'local_only'].includes(result.cancelScope)||own(result,'nextPollAt')&&!integer(result.nextPollAt,0))return false;
 if(result.error!==null&&(!fields(result.error,['code','message'],['retryable'])||!text(result.error.code,1,200)||!text(result.error.message,1,600)||own(result.error,'retryable')&&typeof result.error.retryable!=='boolean'))return false;
 const allowed=result.status==='failed'?['retry']:result.status==='submission_unknown'?['reconcile','cancel']:result.status==='cancelled'?['reconcile']:result.status==='succeeded'?[]:['cancel'];
 if(own(result,'allowedActions')&&!same(result.allowedActions,allowed))return false;
 if(options.projectId!==undefined&&result.projectId!==options.projectId)return false;
 const snapshot=result.snapshot;
 if(!fields(snapshot,snapshotFields,['projectId','lastFrameAssetId'])||snapshot.shotId!==input.shotId||snapshot.shotRevision!==input.expectedRevision||snapshot.providerId!==result.providerId||snapshot.model!==result.model||!text(snapshot.title,1,150)||!text(snapshot.prompt,0,5000)||!parameters(snapshot.parameters)||!record(snapshot.capabilities)||getSubjectGenerationSnapshotIssue(snapshot,{projectId:result.projectId,requireProfilePin:true}))return false;
 if(snapshot.subjectReference.subjectVersionId!==input.subjectVersionId||input.parameters&&Object.keys(input.parameters).some(key=>snapshot.parameters[key]!==input.parameters[key]))return false;
 if(own(options,'subjectReference')&&(!isSubjectReference(options.subjectReference)||!same(snapshot.subjectReference,options.subjectReference)))return false;
 const profile=getCapabilityProfile(result.providerId,result.model,snapshot.providerRegion,{profileId:snapshot.inputProfileId,profileVersion:snapshot.inputProfileVersion});
 if(!profile.aspectRatios.includes(snapshot.aspectRatio)||!profile.durationsSeconds.includes(snapshot.duration))return false;
 if(profile.prompt.required&&!snapshot.prompt.trim()||snapshot.prompt.length>profile.prompt.maxCodeUnits)return false;
 for(const [key,value] of Object.entries(snapshot.parameters)){
  if(!own(profile.parameters,key))return false;
  const rule=profile.parameters[key];
  if(rule.type==='integer'&&(!Number.isSafeInteger(value)||value<rule.min||value>rule.max)||rule.type==='enum'&&!rule.values.includes(value))return false;
 }
 return encoder.encode(JSON.stringify(result)).byteLength<=SUBJECT_GENERATION_RESPONSE_BYTES;
}

/** Match only an explicit retry of a subject job. The original public snapshot
 * can be pinned by a renderer that knows the source job; context-free clients
 * can still verify the retry identity and complete returned subject manifest.
 * Neither the wire input nor the original snapshot is changed or normalized.
 */
export function isSubjectGenerationRetryResponse(input,result,options={}){
 if(!safeData(input)||!fields(input,['jobId','requestId'])||!uuid(input.jobId)||!text(input.requestId,8,200)||!safeData(result)||!record(result)||!record(result.snapshot)||!isSubjectReference(result.snapshot.subjectReference)||!fields(options,[],['projectId','subjectReference','snapshot'])||result.id===input.jobId)return false;
 const {snapshot:expectedSnapshot,...context}=options;
 const identity={shotId:result.shotId,expectedRevision:result.snapshot.shotRevision,requestId:input.requestId,providerId:result.providerId,model:result.model,subjectVersionId:result.snapshot.subjectReference.subjectVersionId};
 if(!matchesSubjectGenerationResponse(identity,result,context,input.jobId))return false;
 return !own(options,'snapshot')||safeData(expectedSnapshot)&&same(result.snapshot,expectedSnapshot);
}
