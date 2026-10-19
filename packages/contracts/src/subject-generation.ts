import {z} from 'zod';
import {subjectVersionResponseSchema} from './subjects.ts';
import {getCapabilityProfile, SUBJECT_REFERENCE_PROFILE_VERSION, type ImplementedGenerationInputRole} from './generation-input-profiles.ts';

export const SUBJECT_GENERATION_KINDS=Object.freeze(['character','product','location'] as const);
export type SubjectGenerationKind = (typeof SUBJECT_GENERATION_KINDS)[number];
export const SUBJECT_GENERATION_RESPONSE_BYTES=256*1024;
export const subjectReferenceSchema=z.object({
 subjectVersionId:z.string().uuid(),
 subjectName:z.string().min(1).max(120).refine(value=>Boolean(value.trim()),'Name must not be blank'),
 subjectKind:z.enum(SUBJECT_GENERATION_KINDS),
 subjectVersion:subjectVersionResponseSchema,
}).strict().refine(value=>value.subjectVersionId===value.subjectVersion.id,'The selected immutable version must match the frozen version.');
export type SubjectReference = z.infer<typeof subjectReferenceSchema>;
export interface SubjectGenerationIssue {code: string; message: string; path: (string | number)[]}
export interface SubjectGenerationSnapshotOptions {projectId?: unknown; requireProfilePin?: boolean}
export interface SubjectGenerationMatchOptions {projectId?: unknown; subjectReference?: unknown}
export interface SubjectRetryMatchOptions extends SubjectGenerationMatchOptions {snapshot?: unknown}

const own=(value: unknown,key: PropertyKey): boolean=>Object.hasOwn(value as object,key);
const record=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&!Object.getOwnPropertySymbols(value).length&&Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>!d.get&&!d.set&&d.enumerable);
const dense=(value: unknown,max=8): value is unknown[] => {
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max)return false;
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
 return keys.length===value.length+1&&keys.every(key=>key==='length'||typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)&&Number(key)<value.length&&!descriptors[key].get&&!descriptors[key].set&&descriptors[key].enumerable);
};
const uuid=(value: unknown): value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const text=(value: unknown,min: number,max: number): value is string=>typeof value==='string'&&value.length>=min&&value.length<=max;
const integer=(value: unknown,min: number,max=Number.MAX_SAFE_INTEGER): value is number=>Number.isSafeInteger(value)&&(value as number)>=min&&(value as number)<=max;
const fields=(value: unknown,required: readonly string[],optional: readonly string[]=[]): value is Record<string, unknown>=>record(value)&&required.every(key=>own(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const timestamp=(value: unknown): value is string=>text(value,1,64)&&Number.isFinite(Date.parse(value));
const encoder=new TextEncoder();
// Do not invoke getters, inherited toJSON hooks, or cycles while checking a
// response. All accepted records are ordinary bounded wire data.
function safeData(value: unknown): boolean {
 const seen=new Set<unknown>();let nodes=0;
 const visit=(item: unknown,depth: number): boolean=>{
  if(++nodes>10000||depth>24)return false;
  if(item===null||typeof item==='boolean'||typeof item==='string')return true;
  if(typeof item==='number')return Number.isFinite(item);
  if(typeof item!=='object'||seen.has(item)||!(Array.isArray(item)?dense(item,10000):record(item)))return false;
  seen.add(item);const valid=Object.values(item).every(child=>visit(child,depth+1));seen.delete(item);return valid;
 };
 return visit(value,0);
}
const same=(left: unknown,right: unknown): boolean=>left===right||Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&(left as unknown[]).every((value,index)=>same(value,(right as unknown[])[index]))||record(left)&&record(right)&&Object.keys(left).length===Object.keys(right).length&&Object.keys(left).every(key=>own(right,key)&&same(left[key],right[key]));
export function isSubjectReference(value: unknown): value is SubjectReference {return safeData(value)&&subjectReferenceSchema.safeParse(value).success;}

/** Check a frozen subject manifest without resolving a subject, head or asset.
 * No subject claim means legacy input is left alone. Any partial subject claim
 * fails closed instead of acquiring first-frame semantics. Authoritative callers
 * supply projectId; historical snapshots need not grow a new projectId field.
 * Unpinned planning input is allowed. Frozen consumers must requireProfilePin;
 * partial pins never fall back to planning or the currently active profile.
 */
export function getSubjectGenerationSnapshotIssue(snapshot: unknown,options: SubjectGenerationSnapshotOptions = {}): SubjectGenerationIssue | null {
 const issue=(message: string,path: (string | number)[]=[]): SubjectGenerationIssue=>({code:'INVALID_REFERENCE_MANIFEST',message,path});
 if(!record(snapshot)||!fields(options,[],['projectId','requireProfilePin'])||own(options,'requireProfilePin')&&typeof options.requireProfilePin!=='boolean')return issue('主体生成快照和检查选项必须为普通数据对象');
 const manifest = snapshot as Record<string, unknown>;
 const subjectRole=(items: unknown): boolean=>dense(items)&&items.some(item=>record(item)&&item.role==='subject_reference');
 const claims=own(manifest,'subjectReference')||own(manifest,'subjectVersionId')||subjectRole(manifest.referenceAssets)||subjectRole(manifest.referenceBindings);
 if(!claims)return null;
 if(own(manifest,'subjectVersionId')||!isSubjectReference(manifest.subjectReference))return issue('必须冻结一个完整且有效的主体版本，不能使用规划风格或推断首帧',['subjectReference']);
 const {subjectVersion:version}=manifest.subjectReference;
 const versionRecord = version as unknown as Record<string, unknown>;
 if(options.projectId!==undefined&&(!uuid(options.projectId)||version.projectId!==options.projectId)||own(manifest,'projectId')&&manifest.projectId!==version.projectId)return issue('主体版本必须属于本次生成的项目',['subjectReference','subjectVersion','projectId']);
 const pinKeys=['inputProfileId','inputProfileVersion','providerRegion'];
 let profile;
 if(options.requireProfilePin||pinKeys.some(key=>own(manifest,key))){
  profile=getCapabilityProfile(manifest.providerId,manifest.model,manifest.providerRegion,{profileId:manifest.inputProfileId,profileVersion:manifest.inputProfileVersion});
  if(!pinKeys.every(key=>own(manifest,key))||!profile||profile.profileVersion!==SUBJECT_REFERENCE_PROFILE_VERSION||!profile.inputs.roles.subject_reference.implemented)return issue('主体生成必须固定完整的已实现 v3 输入配置和供应商区域',['inputProfileId']);
 }
 const referenceAssetIds = manifest.referenceAssetIds;
 if(!dense(referenceAssetIds)||referenceAssetIds.length!==1||referenceAssetIds[0]!==version.assetId)return issue('主体生成必须只包含所选版本的一个素材 ID',['referenceAssetIds']);
 const bindings=manifest.referenceBindings;
 if(!dense(bindings)||bindings.length!==1)return issue('主体生成必须包含与所选版本完全一致的显式角色和哈希',['referenceBindings']);
 const binding=bindings[0];
 if(!fields(binding,['role','assetId','sha256'])||binding.role!=='subject_reference'||binding.assetId!==version.assetId||binding.sha256!==version.sha256)return issue('主体生成必须包含与所选版本完全一致的显式角色和哈希',['referenceBindings']);
 const assets=manifest.referenceAssets,asset=dense(assets)&&assets.length===1?assets[0]:null;
 if(!record(asset)||asset.role!=='subject_reference'||asset.id!==version.assetId||['sha256','mimeType','width','height'].some(key=>asset[key]!==versionRecord[key])||!integer(asset.sizeBytes,1)||own(asset,'projectId')&&asset.projectId!==version.projectId||own(asset,'durationSeconds')||own(asset,'duration')&&asset.duration!==0)return issue('主体素材元数据必须完整且与冻结版本一致',['referenceAssets']);
 if(profile){
  const rule=profile.inputs.roles.subject_reference as ImplementedGenerationInputRole,dims=rule.dimensions;
  if(!rule.mimeTypes.includes(asset.mimeType as string)||(asset.sizeBytes as number)>rule.maxBytes||dims&&
      ([(asset.width as number),(asset.height as number)].some(value=>value<dims.min||dims.max!==null&&value>dims.max)||dims.minAspectRatio!==undefined&&(asset.width as number)/(asset.height as number)<dims.minAspectRatio||dims.maxAspectRatio!==undefined&&(asset.width as number)/(asset.height as number)>dims.maxAspectRatio))return issue('主体图片不符合冻结输入配置的格式、大小或尺寸限制',['referenceAssets']);
 }
 const referenceConnections = manifest.referenceConnections;
 if(options.requireProfilePin&&!own(manifest,'referenceConnections')||own(manifest,'referenceConnections')&&(!dense(referenceConnections)||referenceConnections.length!==0)||own(manifest,'lastFrameAssetId')&&manifest.lastFrameAssetId!==null)return issue('主体参考必须明确没有首帧连线，不能与首帧或尾帧混合',['referenceConnections']);
 return null;
}

const jobFields=['id','projectId','shotId','requestId','providerId','model','revision','status','phase','progress','snapshot','providerJobId','submissionCount','error','createdAt','updatedAt','versionId','cancelScope','retryOfJobId'];
const snapshotFields=['shotId','shotRevision','title','prompt','referenceAssetIds','referenceAssets','referenceConnections','aspectRatio','duration','providerId','model','parameters','capabilities','inputProfileVersion','inputProfileId','providerRegion','referenceBindings','subjectReference'];
const statuses=['queued','submitting','running','downloading','submission_unknown','failed','cancelled','succeeded'];
const scenarios=['success','failure','delay','timeout','unknown','reject','download_fail_once','rejected_before_accept','accepted_then_response_lost','poll_timeout_then_recover','terminal_failure'];
const parameters=(value: unknown): boolean=>fields(value,[],['scenario','delayMs','seed'])&&(!own(value,'scenario')||scenarios.includes(value.scenario as string))&&(!own(value,'delayMs')||integer(value.delayMs,0,120000))&&(!own(value,'seed')||Number.isSafeInteger(value.seed));

/** Opt-in receipt matching for explicit subject generation.submit only.
 * A progressed public job may prove its original submit, never a job.retry or
 * a coincident request key. This does not change any historical ACK policy.
 * UI callers can additionally bind the complete reference reviewed before send.
 */
export function isSubjectGenerationResponse(operation: unknown,input: unknown,result: unknown,options: SubjectGenerationMatchOptions = {}): boolean {
 return operation==='generation.submit'&&matchesSubjectGenerationResponse(input,result,options,null);
}
function matchesSubjectGenerationResponse(input: unknown,result: unknown,options: SubjectGenerationMatchOptions,expectedRetryOfJobId: unknown): boolean {
 if(!safeData(input)||!safeData(result)||!fields(options,[],['projectId','subjectReference']))return false;
 if(!fields(input,['shotId','expectedRevision','requestId','providerId','subjectVersionId'],['model','parameters']))return false;
 const request = input as Record<string, unknown>;
 if(!uuid(request.shotId)||!uuid(request.subjectVersionId)||!integer(request.expectedRevision,1)||!text(request.requestId,8,200)||typeof request.providerId!=='string'||!['mock','ark'].includes(request.providerId)||own(request,'model')&&!text(request.model,0,100)||own(request,'parameters')&&!parameters(request.parameters))return false;
 if(!fields(result,jobFields,['allowedActions','nextPollAt']))return false;
 const job = result as Record<string, unknown>;
 if(!uuid(job.id)||!uuid(job.projectId)||job.requestId!==request.requestId||job.shotId!==request.shotId||job.providerId!==request.providerId||request.model&&job.model!==request.model||!text(job.model,1,100)||!integer(job.revision,1)||typeof job.status!=='string'||!statuses.includes(job.status)||!text(job.phase,1,100)||!integer(job.progress,0,100)||!integer(job.submissionCount,0)||!timestamp(job.createdAt)||!timestamp(job.updatedAt)||job.retryOfJobId!==expectedRetryOfJobId||!(job.providerJobId===null||text(job.providerJobId,1,200))||!(job.versionId===null||uuid(job.versionId))||!([null,'local_only'] as unknown[]).includes(job.cancelScope)||own(job,'nextPollAt')&&!integer(job.nextPollAt,0))return false;
 const jobError=job.error;
 if(jobError!==null&&(!fields(jobError,['code','message'],['retryable'])||!text(jobError.code,1,200)||!text(jobError.message,1,600)||own(jobError,'retryable')&&typeof jobError.retryable!=='boolean'))return false;
 const allowed=job.status==='failed'?['retry']:job.status==='submission_unknown'?['reconcile','cancel']:job.status==='cancelled'?['reconcile']:job.status==='succeeded'?[]:['cancel'];
 if(own(job,'allowedActions')&&!same(job.allowedActions,allowed))return false;
 if(options.projectId!==undefined&&job.projectId!==options.projectId)return false;
 const snapshot=job.snapshot;
 if(!fields(snapshot,snapshotFields,['projectId','lastFrameAssetId']))return false;
 const frozen = snapshot as Record<string, unknown>;
 if(frozen.shotId!==request.shotId||frozen.shotRevision!==request.expectedRevision||frozen.providerId!==job.providerId||frozen.model!==job.model||!text(frozen.title,1,150)||!text(frozen.prompt,0,5000)||!parameters(frozen.parameters)||!record(frozen.capabilities)||getSubjectGenerationSnapshotIssue(frozen,{projectId:job.projectId,requireProfilePin:true}))return false;
 const subjectVersionId=(frozen.subjectReference as SubjectReference).subjectVersionId;
 const inputParameters=request.parameters as Record<string, unknown> | undefined;
 const snapshotParameters=frozen.parameters as Record<string, unknown>;
 if(subjectVersionId!==request.subjectVersionId||inputParameters&&Object.keys(inputParameters).some(key=>snapshotParameters[key]!==inputParameters[key]))return false;
 if(own(options,'subjectReference')&&(!isSubjectReference(options.subjectReference)||!same(frozen.subjectReference,options.subjectReference)))return false;
 const profile=getCapabilityProfile(job.providerId,job.model,frozen.providerRegion,{profileId:frozen.inputProfileId,profileVersion:frozen.inputProfileVersion})!;
 if(!profile.aspectRatios.includes(frozen.aspectRatio as string)||!profile.durationsSeconds.includes(frozen.duration as number))return false;
 const prompt=frozen.prompt as string;
 if(profile.prompt.required&&!prompt.trim()||prompt.length>profile.prompt.maxCodeUnits)return false;
 for(const [key,value] of Object.entries(snapshotParameters)){
  if(!own(profile.parameters,key))return false;
  const rule=profile.parameters[key];
  if(rule.type==='integer'&&(typeof value!=='number'||!Number.isSafeInteger(value)||value<rule.min||value>rule.max)||rule.type==='enum'&&!rule.values.includes(value as string))return false;
 }
 return encoder.encode(JSON.stringify(result)).byteLength<=SUBJECT_GENERATION_RESPONSE_BYTES;
}

/** Match only an explicit retry of a subject job. The original public snapshot
 * can be pinned by a renderer that knows the source job; context-free clients
 * can still verify the retry identity and complete returned subject manifest.
 * Neither the wire input nor the original snapshot is changed or normalized.
 */
export function isSubjectGenerationRetryResponse(input: unknown,result: unknown,options: SubjectRetryMatchOptions = {}): boolean {
 if(!safeData(input)||!fields(input,['jobId','requestId']))return false;
 const request = input as Record<string, unknown>;
 if(!uuid(request.jobId)||!text(request.requestId,8,200)||!safeData(result)||!record(result))return false;
 const job = result as Record<string, unknown>;
 if(!record(job.snapshot)||!isSubjectReference(job.snapshot.subjectReference)||!fields(options,[],['projectId','subjectReference','snapshot'])||job.id===request.jobId)return false;
 const frozen = job.snapshot as Record<string, unknown>;
 const {snapshot:expectedSnapshot,...context}=options as SubjectRetryMatchOptions;
 const identity={shotId:job.shotId,expectedRevision:frozen.shotRevision,requestId:request.requestId,providerId:job.providerId,model:job.model,subjectVersionId:(frozen.subjectReference as SubjectReference).subjectVersionId};
 if(!matchesSubjectGenerationResponse(identity,result,context,request.jobId))return false;
 return !own(options,'snapshot')||safeData(expectedSnapshot)&&same(frozen,expectedSnapshot);
}
