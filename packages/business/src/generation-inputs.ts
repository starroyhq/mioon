import {AppError,getCapabilityProfile,getLegacyCapabilityProfile,getGenerationProfileRegion,buildAdapterPlan,getShotGenerationReferenceSelection,isSubjectReference,getSubjectGenerationSnapshotIssue,SUBJECT_REFERENCE_PROFILE_VERSION} from '@mioon/contracts';
import type {DatabaseSync} from 'node:sqlite';
import {validateImageConsumption} from './image-consumption.ts';
import {createOwnedMediaGraphReader} from './inspection.ts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.ts';

export type GenerationRecord=Record<string, unknown>;
export interface GenerationAsset {
 readonly id: string;
 readonly projectId: string;
 readonly sha256?: unknown;
 readonly relativePath?: unknown;
 readonly mimeType?: unknown;
 readonly width?: unknown;
 readonly height?: unknown;
 readonly sizeBytes?: unknown;
 readonly duration?: unknown;
 readonly durationSeconds?: unknown;
 readonly role?: unknown;
 readonly [key: string]: unknown;
}
export interface GenerationJob {
 readonly id: string;
 readonly projectId: string;
 readonly shotId: string;
 readonly providerId?: unknown;
 readonly model?: unknown;
 readonly requestId?: unknown;
 readonly requestHash?: unknown;
 readonly retryOfJobId?: unknown;
 readonly providerJobId?: unknown;
 readonly submissionCount?: unknown;
 readonly revision?: unknown;
 readonly status?: unknown;
 readonly snapshot: GenerationRecord;
 readonly [key: string]: unknown;
}
export interface GenerationShot {
 readonly id: string;
 readonly projectId: string;
 readonly referenceAssetIds?: unknown;
 readonly lastFrameAssetId?: unknown;
 readonly [key: string]: unknown;
}
export interface GenerationSource {
 readonly referenceAssetIds?: unknown;
 readonly referenceAssets?: unknown;
 readonly referenceConnections?: unknown;
 readonly referenceBindings?: unknown;
 readonly lastFrameAssetId?: unknown;
 readonly subjectReference?: unknown;
 readonly subjectVersionId?: unknown;
 readonly inputProfileVersion?: unknown;
 readonly inputProfileId?: unknown;
 readonly providerRegion?: unknown;
 readonly capabilities?: {readonly region?: unknown; readonly models?: unknown; readonly [key: string]: unknown} | null;
 readonly prompt?: unknown;
 readonly aspectRatio?: unknown;
 readonly duration?: unknown;
 readonly parameters?: unknown;
 readonly [key: string]: unknown;
}
export interface GenerationReference { readonly role?: string; readonly assetId: string; readonly [key: string]: unknown }
export interface GenerationSubjectGraph {
 asset(id: string): GenerationAsset;
 version(id: string, shotId: string, assetId: string): GenerationAsset;
 validateSubjectReference(value: unknown): void;
 subjectReference(subjectVersionId: string): {subjectVersion: {assetId: string; sha256: string; [key: string]: unknown}};
}
export interface PreparedGenerationInputs {
 readonly assets: GenerationAsset[];
 readonly plan: unknown;
 readonly fields: Record<string, unknown>;
}
export interface PrepareGenerationInputsOptions {
 readonly source: GenerationSource;
 readonly projectId: string;
 readonly providerId: string;
 readonly model: string;
 readonly capabilities: {readonly models?: unknown; readonly region?: unknown; readonly [key: string]: unknown};
 readonly readAsset: (id: string) => GenerationAsset;
 readonly asOf?: unknown;
 readonly frozen?: boolean;
}

function fail(code: string,message: string,details: Record<string,unknown>={}): never{throw new AppError(code,message,400,details);}
function manifestError(): never{return fail('INVALID_REFERENCE_MANIFEST','参考图完整清单与冻结快照不一致；不会删除或替换输入');}
const isRecord=(value: unknown): value is GenerationRecord=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const dense=(value: unknown): value is unknown[]=>Array.isArray(value)&&value.length<=8&&Object.keys(value).length===value.length;
export function assertGenerationReferenceIds(ids: unknown): void {if(!dense(ids)||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)manifestError();}
const metadataKeys=['mimeType','sha256','relativePath','width','height','sizeBytes'] as const;
const failures=new WeakSet<object>();
export const markGenerationPreflightFailure=<T extends object>(error: T): T=>{failures.add(error);return error;};
export const isGenerationPreflightFailure=(error: unknown): boolean=>typeof error==='object'&&error!==null&&failures.has(error);

// Assets are project-owned relational records before their metadata is decoded.
export function readGenerationAsset(db: DatabaseSync,id: string,projectId: string): GenerationAsset {
 const row=db.prepare('SELECT id,projectId,CASE WHEN typeof(data)=\'text\' AND length(CAST(data AS BLOB))<=65536 THEN data END AS data FROM assets WHERE id=?').get(id);
 if(!row)fail('NOT_FOUND','找不到记录',{id});
 if(row.projectId!==projectId)fail('INVALID_REFERENCE_OWNERSHIP','参考素材必须属于当前项目',{assetId:id});
 let asset: unknown;try{asset=JSON.parse(String(row.data));}catch{asset=undefined;}
 if(!isRecord(asset)||asset.id!==row.id||asset.projectId!==row.projectId)fail('INVALID_REFERENCE_METADATA','参考素材元数据不可用',{assetId:id});
 return validateImageConsumption(db,asset as GenerationAsset,projectId);
}
function ownedRecord(db: DatabaseSync,table: string,id: string): GenerationRecord {
 const row=db.prepare(`SELECT id,projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=262144 THEN data END AS data FROM ${table} WHERE id=?`).get(id);
 if(!row)fail('INVALID_GENERATION_OWNERSHIP','任务或镜头的项目归属已改变');
 let record: unknown;try{record=JSON.parse(String(row.data));}catch{record=undefined;}
 if(!isRecord(record)||record.id!==row.id||record.projectId!==row.projectId)fail('INVALID_GENERATION_OWNERSHIP','任务或镜头的项目归属已改变');
 return record;
}
// Bounded linked-job probe for subject-bearing version disclosure. Avoid
// introducing an unbounded legacy get() while deciding whether a guard applies.
export const readGenerationLinkedJob=(db: DatabaseSync,id: string): GenerationRecord=>ownedRecord(db,'jobs',id);
export function assertGenerationShotOwnership(db: DatabaseSync,shot: GenerationShot): void {
 const saved=ownedRecord(db,'shots',shot.id);
 if(saved.projectId!==shot.projectId)fail('INVALID_GENERATION_OWNERSHIP','镜头的项目归属已改变');
}
export function assertGenerationJobOwnership(db: DatabaseSync,job: GenerationJob): GenerationRecord {
 const saved=ownedRecord(db,'jobs',job.id),shot=ownedRecord(db,'shots',job.shotId);
 if(saved.projectId!==job.projectId||saved.shotId!==job.shotId||shot.projectId!==job.projectId||(job.snapshot as GenerationRecord).shotId!==job.shotId)
  fail('INVALID_GENERATION_OWNERSHIP','任务或镜头的项目归属已改变');
 return saved;
}
export function currentGenerationClaim(db: DatabaseSync,job: GenerationJob): GenerationRecord {
 const saved=assertGenerationJobOwnership(db,job);
 if(['id','projectId','shotId','providerId','model','requestId','requestHash','retryOfJobId','providerJobId','submissionCount','revision','status'].some(key=>saved[key]!==job[key])||JSON.stringify(saved.snapshot)!==JSON.stringify(job.snapshot))
  fail('GENERATION_STATE_CHANGED','任务身份或冻结快照已改变');
 return saved;
}
const pinKeys=['inputProfileVersion','inputProfileId','providerRegion','referenceBindings'] as const;

export const hasSubjectGeneration=(source: unknown): boolean=>Boolean(source&&typeof source==='object'&&((Object.hasOwn(source,'subjectReference')||Object.hasOwn(source,'subjectVersionId'))||
 ('referenceBindings' in source&&Array.isArray((source as {referenceBindings?: unknown}).referenceBindings)&&(source as {referenceBindings: unknown[]}).referenceBindings.some(binding=>isRecord(binding)&&binding.role==='subject_reference'))||
 ('referenceAssets' in source&&Array.isArray((source as {referenceAssets?: unknown}).referenceAssets)&&(source as {referenceAssets: unknown[]}).referenceAssets.some(asset=>isRecord(asset)&&asset.role==='subject_reference'))));

// This check does not refresh a historical job's prompt, shot revision, current
// subject head, saved first/tail selection, provider budget or lifecycle policy.
export function validateSubjectGenerationOwnership(db: DatabaseSync,job: GenerationJob): GenerationSubjectGraph {
 currentGenerationClaim(db,job);
 const receipt=db.prepare(`SELECT CASE WHEN typeof(requestId)='text' AND length(CAST(requestId AS BLOB)) BETWEEN 8 AND 800 THEN requestId END AS requestId,
  CASE WHEN typeof(requestHash)='text' AND length(CAST(requestHash AS BLOB))=64 THEN requestHash END AS requestHash,
  CASE WHEN typeof(resourceId)='text' AND length(CAST(resourceId AS BLOB))=36 THEN resourceId END AS resourceId FROM idempotency WHERE scope='generation' AND requestId=? LIMIT 1`).get(job.requestId as string);
 if(typeof job.requestId!=='string'||job.requestId.length<8||job.requestId.length>200||!/^[a-f0-9]{64}$/.test(typeof job.requestHash==='string'?job.requestHash:'')||!receipt||receipt.requestId!==job.requestId||receipt.requestHash!==job.requestHash||receipt.resourceId!==job.id)fail('INVALID_GENERATION_RECEIPT','原始主体生成请求凭据缺失或不一致；不会新建任务或自动重新提交');
 const snapshot=job.snapshot;
 const issue=getSubjectGenerationSnapshotIssue(snapshot,{projectId:job.projectId,requireProfilePin:true});
 if(issue)fail(issue.code,issue.message);
 if(!isSubjectReference(snapshot.subjectReference)||snapshot.inputProfileVersion!==SUBJECT_REFERENCE_PROFILE_VERSION||snapshot.providerId!==job.providerId||snapshot.model!==job.model)manifestError();
 const graph=createOwnedMediaGraphReader(db,job.projectId) as unknown as GenerationSubjectGraph;
 graph.validateSubjectReference(snapshot.subjectReference);
 return graph;
}

// Missing idempotency data never frees a retained subject request key, even
// when a caller omits its selector. Legacy non-subject replay semantics remain
// unchanged. JSON is byte/type guarded before extraction; bad rows are denial,
// not evidence that a key is unused. An unrelated damaged row may therefore
// block fresh admission. This defensive predicate can scan jobs; LIMIT bounds
// materialized candidates only, and exact legacy receipt replay returns first.
export function assertSubjectGenerationRequestVacant(db: DatabaseSync,input: {readonly requestId?: unknown; readonly subjectVersionId?: unknown; readonly [key: string]: unknown}): void {
 const limit=INSPECTION_ROW_LIMITS.jobs;
 // Old provenance-only job records can legitimately omit a request key. Only
 // known subject claims make an invalid retained key an uncertain reservation.
 const subjectClaim=`json_type(data,'$.snapshot.subjectReference') IS NOT NULL OR json_type(data,'$.snapshot.subjectVersionId') IS NOT NULL OR
  CASE WHEN json_type(data,'$.snapshot.referenceAssets')='array' THEN EXISTS(SELECT 1 FROM json_each(data,'$.snapshot.referenceAssets') ref WHERE CASE WHEN ref.type='object' THEN json_extract(ref.value,'$.role') END='subject_reference') ELSE 0 END OR
  CASE WHEN json_type(data,'$.snapshot.referenceBindings')='array' THEN EXISTS(SELECT 1 FROM json_each(data,'$.snapshot.referenceBindings') ref WHERE CASE WHEN ref.type='object' THEN json_extract(ref.value,'$.role') END='subject_reference') ELSE 0 END`;
 const rows=db.prepare(`SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND ${limit} THEN data END AS data FROM jobs
  WHERE CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND ${limit} THEN
   CASE WHEN json_valid(data) THEN CASE WHEN json_type(data)='object' THEN CASE WHEN json_type(data,'$.requestId') IS NOT 'text' OR length(CAST(json_extract(data,'$.requestId') AS BLOB)) NOT BETWEEN 8 AND 800 THEN (${subjectClaim}) ELSE json_extract(data,'$.requestId')=? END ELSE 1 END ELSE 1 END ELSE 1 END LIMIT 2`).all(input.requestId as string);
 if(rows.length>1)fail('INVALID_GENERATION_RECEIPT','保留的生成请求归属不一致；不会新建任务或修复凭据');
 for(const row of rows){
  let retained: unknown;try{retained=JSON.parse(String(row.data));}catch{retained=undefined;}
  const retainedRecord=isRecord(retained)?retained:null;
  if(!retainedRecord||retainedRecord.requestId!==input.requestId||input.subjectVersionId!==undefined||hasSubjectGeneration(retainedRecord.snapshot))fail('INVALID_GENERATION_RECEIPT','此请求 ID 已由保留的任务占用或凭据不完整；不会新建任务');
 }
}

// There is no indexed target column in the legacy edge table. The guarded JSON
// predicate can scan rows, but only bounded candidate rows/bytes are materialized.
// Unreadable edges, even in another project, cannot hide a target relation.
// An unrelated corrupt edge can therefore block new subject admission. Length
// checks and row scans are not a bound on database work; JSON parsing is bounded.
export function assertSubjectGenerationSelection(db: DatabaseSync,shot: GenerationShot): void {
 assertGenerationShotOwnership(db,shot);
 assertGenerationReferenceIds(shot.referenceAssetIds);
 const referenceIds=dense(shot.referenceAssetIds)?shot.referenceAssetIds:[];
 if(referenceIds.length||shot.lastFrameAssetId!=null)fail('REFERENCE_STATE_CONFLICT','本次主体参考不能与已保存的首帧或尾帧混用；请先明确修改镜头选择');
 const limit=INSPECTION_ROW_LIMITS.edges;
 const rows=db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id END AS id,CASE WHEN length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId,
  CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND ${limit} THEN data END AS data FROM edges
  WHERE CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND ${limit} THEN
   CASE WHEN json_valid(data) THEN CASE WHEN json_type(data) IS NOT 'object' THEN 1
    WHEN projectId=? AND (json_type(data,'$.target') IS NOT 'text' OR length(CAST(json_extract(data,'$.target') AS BLOB)) IS NOT 36 OR json_extract(data,'$.id') IS NOT id OR json_extract(data,'$.projectId') IS NOT projectId) THEN 1
    WHEN json_extract(data,'$.target')=? THEN 1 ELSE 0 END ELSE 1 END ELSE 1 END LIMIT 1025`).all(shot.projectId,shot.id);
 if(rows.length>1024)fail('INSPECTION_BUDGET_EXCEEDED','Inspection budget exceeded');
 let bytes=0;
 for(const row of rows){
  if(typeof row.data!=='string'||(bytes+=Buffer.byteLength(row.data))>4*1024*1024)fail('REFERENCE_STATE_CONFLICT','镜头连线状态无法安全核验');
  let edge: unknown;try{edge=JSON.parse(row.data);}catch{throw fail('REFERENCE_STATE_CONFLICT','镜头连线状态无法安全核验');}
  if(!isRecord(edge)||edge.id!==row.id||edge.projectId!==row.projectId||row.projectId!==shot.projectId||edge.target!==shot.id||edge.kind!=='decorative'||Object.hasOwn(edge,'role')||Object.hasOwn(edge,'sourceAssetId'))fail('REFERENCE_STATE_CONFLICT','本次主体参考不能与首帧连线或损坏的连线混用');
  const source=db.prepare('SELECT id,projectId FROM nodes WHERE id=? UNION ALL SELECT id,projectId FROM shots WHERE id=? LIMIT 2').all(edge.source as string,edge.source as string);
  if(source.length!==1||source[0].projectId!==shot.projectId)fail('REFERENCE_STATE_CONFLICT','镜头连线状态无法安全核验');
 }
}

// Only current shot selections are expanded. A frozen manifest is already
// complete and must never acquire a tail from the current shot or array order.
export function generationReferenceSelection(source: GenerationSource,{frozen=false}: {frozen?: boolean}={}): {ids: string[]; references: readonly GenerationReference[] | null} {
 assertGenerationReferenceIds(source.referenceAssetIds);
 const ids=source.referenceAssetIds as string[];
 if(frozen){const issue=getSubjectGenerationSnapshotIssue(source,{requireProfilePin:true});if(issue)fail(issue.code,issue.message);return {ids,references:null};}
 if(Object.hasOwn(source,'subjectReference')){
  const subjectReference=source.subjectReference as {subjectVersion?: {assetId?: unknown}; [key: string]: unknown} | null;
  if(!isSubjectReference(source.subjectReference)||ids.length!==1||ids[0]!==subjectReference?.subjectVersion?.assetId||source.lastFrameAssetId!=null)manifestError();
  return {ids,references:[{role:'subject_reference',assetId:ids[0] as string}]};
 }
 const selection=getShotGenerationReferenceSelection(source);
 if(!selection.ok){const issue=selection.issues[0];if(issue)fail(issue.code,issue.message,{issues:selection.issues});else manifestError();}
 return {ids:selection.references.map(reference=>reference.assetId),references:selection.references as unknown as readonly GenerationReference[]};
}

/** Resolve the complete saved selection. Never accept caller metadata or prune IDs. */
export function prepareGenerationInputs({source,projectId,providerId,model,capabilities,readAsset,asOf,frozen=false}: PrepareGenerationInputsOptions): PreparedGenerationInputs {
 const {ids,references:selection}=generationReferenceSelection(source,{frozen});
 let pinned: unknown[] | null=null;
 if(frozen){const candidate=source.referenceAssets;if(!dense(candidate))manifestError();pinned=candidate as unknown[];}
 if(frozen&&pinned&&(pinned.length!==ids.length||pinned.some((ref,index)=>!isRecord(ref)||ref.id!==ids[index])))manifestError();
 const assets=ids.map((id,index)=>{
  const asset=readAsset(id);
  if(!asset)fail('NOT_FOUND','找不到记录',{id});
  if(asset.id!==id||asset.projectId!==projectId)fail('INVALID_REFERENCE_OWNERSHIP','参考素材必须属于当前项目',{assetId:id});
  if(frozen){
   const ref=pinned?.[index];
   // Missing historical size is resolved only from the same managed identity.
   // Other frozen metadata is never substituted with a newer asset record.
   if(isRecord(ref)&&metadataKeys.some(key=>Object.hasOwn(ref,key)&&ref[key]!==asset[key]))
    fail('REFERENCE_CHANGED','参考图元数据已与冻结快照不同，请检查原始素材',{assetId:id});
  }
  return asset;
 });
 const hasPin=pinKeys.slice(0,3).some(key=>Object.hasOwn(source,key));
 if(hasPin&&!pinKeys.every(key=>Object.hasOwn(source,key)))manifestError();
 const connections=source.referenceConnections??[];
 if(Object.hasOwn(source,'subjectReference')&&(!dense(connections)||connections.length||frozen&&!hasPin))manifestError();
 if(!dense(connections)||connections.length>1||connections.some(connection=>!isRecord(connection)||connection.role!=='first_frame'||!ids.length||connection.sourceAssetId!==ids[0]))
  fail('REFERENCE_STATE_CONFLICT','首帧连线与镜头参考选择不一致，请先检查最新状态');
 const models=capabilities.models;
 if(!Array.isArray(models)||!models.some(item=>(typeof item==='string'?item:isRecord(item)?item.id:undefined)===model))fail('UNSUPPORTED_MODEL','此供应商不支持冻结快照的模型');
 const region=getGenerationProfileRegion(providerId,capabilities);
 const profile=hasPin?getCapabilityProfile(providerId,model,region,{profileId:source.inputProfileId,profileVersion:source.inputProfileVersion}):frozen?getLegacyCapabilityProfile(providerId,model,region):getCapabilityProfile(providerId,model,region);
 if(frozen&&isRecord(source.capabilities)&&source.capabilities.region&&source.capabilities.region!==region)fail('PROVIDER_REGION_CHANGED','供应商账户区域已更改，请恢复此任务原有区域后继续');
 if(!profile&&hasPin)manifestError();
 if(!profile)fail('INPUT_PROFILE_UNAVAILABLE','找不到此模型和服务器区域的精确输入规范；不会自动切换',{providerId,model});
 if(hasPin){
  if(source.inputProfileVersion!==profile.profileVersion||source.inputProfileId!==profile.profileId)manifestError();
  if(source.providerRegion!==region)fail('PROVIDER_REGION_CHANGED','供应商账户区域已更改，请恢复此任务原有区域后继续');
 }
 const ownerRole=(value: unknown): string|undefined=>isRecord(value)&&typeof value.role==='string'?value.role:undefined;
 const bindings: {role: string; assetId: string; sha256: unknown}[]=hasPin?source.referenceBindings as {role: string; assetId: string; sha256: unknown}[]:assets.map((asset,index)=>({
  role:ownerRole(pinned?.[index])??ownerRole(asset)??(typeof selection?.[index]?.role==='string'?selection[index]?.role:undefined)??'first_frame',
  assetId:asset.id,sha256:asset.sha256}));
 if(!hasPin&&Object.hasOwn(source,'referenceBindings')&&JSON.stringify(source.referenceBindings)!==JSON.stringify(bindings))manifestError();
 if(!dense(bindings)||bindings.length!==ids.length||bindings.some((binding,index)=>!isRecord(binding)||Object.keys(binding).some(key=>!['role','assetId','sha256'].includes(key))||binding.assetId!==ids[index]||binding.sha256!==assets[index]?.sha256))manifestError();
 // A pair needs an explicit, complete role manifest. The tail selection is
 // provenance, never a license to reinterpret the second array entry.
 if(frozen&&source.lastFrameAssetId!=null){
  if(!hasPin||ids.length!==2||source.lastFrameAssetId!==ids[1]||bindings[0]?.role!=='first_frame'||bindings[1]?.role!=='last_frame')manifestError();
 }
 if(bindings.some(binding=>binding.role==='last_frame')&&(!hasPin&&frozen||ids.length!==2||bindings[0]?.role!=='first_frame'||bindings[1]?.role!=='last_frame'||frozen&&source.lastFrameAssetId!==ids[1]))manifestError();
 const references=assets.map((asset,index)=>{
  const metadata: unknown=frozen?pinned?.[index]:asset;
  const metadataRecord=isRecord(metadata)?metadata:asset;
  const role=bindings[index]?.role as string;
  if([metadataRecord,asset as unknown].some(value=>isRecord(value)&&Object.hasOwn(value,'role')&&value.role!==role))manifestError();
  // Persisted semantic claims must never disappear through metadata projection.
  const timed=[metadataRecord,asset as GenerationRecord].find(value=>isRecord(value)&&(Object.hasOwn(value,'durationSeconds')||Object.hasOwn(value,'duration')&&value.duration!==0));
  const timedRecord=isRecord(timed)?timed:null;
  return {role,assetId:asset.id,mimeType:metadataRecord.mimeType,sha256:metadataRecord.sha256,
   ...(timedRecord?{durationSeconds:timedRecord.durationSeconds??timedRecord.duration}:{}),
   sizeBytes:metadataRecord.sizeBytes??asset.sizeBytes,
   ...(metadataRecord.width!==undefined?{width:metadataRecord.width}:{}),...(metadataRecord.height!==undefined?{height:metadataRecord.height}:{})};
 });
 const plan=buildAdapterPlan({providerId,model,region,prompt:source.prompt,aspectRatio:source.aspectRatio,duration:source.duration,parameters:source.parameters,references},{asOf,profileId:profile.profileId,profileVersion:profile.profileVersion});
 if(!plan.ok){const issue=plan.issues[0];fail(issue?.code??'INVALID_REFERENCE_MANIFEST',issue?.message??'Invalid generation inputs',{providerId,model,issues:plan.issues,warnings:plan.warnings});}
 const adapter=plan as unknown as {adapterSnapshot: {referenceAssets: GenerationRecord[]}; profileVersion: string; profileId: string; referenceBindings: unknown};
 return {assets:assets.map((asset,index)=>({...asset,...adapter.adapterSnapshot.referenceAssets[index]})),plan,
  fields:{inputProfileVersion:adapter.profileVersion,inputProfileId:adapter.profileId,providerRegion:region,referenceBindings:adapter.referenceBindings}};
}
