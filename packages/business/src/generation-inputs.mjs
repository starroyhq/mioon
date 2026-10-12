import {AppError,getCapabilityProfile,getLegacyCapabilityProfile,getGenerationProfileRegion,buildAdapterPlan,getShotGenerationReferenceSelection,isSubjectReference,getSubjectGenerationSnapshotIssue,SUBJECT_REFERENCE_PROFILE_VERSION} from '@mioon/contracts';
import {validateImageConsumption} from './image-consumption.mjs';
import {createOwnedMediaGraphReader} from './inspection.mjs';
import {INSPECTION_ROW_LIMITS} from './inspection-query.mjs';

const fail=(code,message,details={})=>{throw new AppError(code,message,400,details);};
const manifestError=()=>fail('INVALID_REFERENCE_MANIFEST','参考图完整清单与冻结快照不一致；不会删除或替换输入');
const dense=value=>Array.isArray(value)&&value.length<=8&&Object.keys(value).length===value.length;
export function assertGenerationReferenceIds(ids){if(!dense(ids)||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)manifestError();}
const metadataKeys=['mimeType','sha256','relativePath','width','height','sizeBytes'];
const failures=new WeakSet();
export const markGenerationPreflightFailure=error=>{failures.add(error);return error;};
export const isGenerationPreflightFailure=error=>failures.has(error);

// Assets are project-owned relational records before their metadata is decoded.
export function readGenerationAsset(db,id,projectId){
 const row=db.prepare('SELECT id,projectId,CASE WHEN typeof(data)=\'text\' AND length(CAST(data AS BLOB))<=65536 THEN data END AS data FROM assets WHERE id=?').get(id);
 if(!row)fail('NOT_FOUND','找不到记录',{id});
 if(row.projectId!==projectId)fail('INVALID_REFERENCE_OWNERSHIP','参考素材必须属于当前项目',{assetId:id});
 let asset;try{asset=JSON.parse(row.data);}catch{}
 if(!asset||asset.id!==row.id||asset.projectId!==row.projectId)fail('INVALID_REFERENCE_METADATA','参考素材元数据不可用',{assetId:id});
 return validateImageConsumption(db,asset,projectId);
}
function ownedRecord(db,table,id){
 const row=db.prepare(`SELECT id,projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=262144 THEN data END AS data FROM ${table} WHERE id=?`).get(id);
 let record;try{record=JSON.parse(row?.data);}catch{}
 if(!record||record.id!==row.id||record.projectId!==row.projectId)fail('INVALID_GENERATION_OWNERSHIP','任务或镜头的项目归属已改变');
 return record;
}
// Bounded linked-job probe for subject-bearing version disclosure. Avoid
// introducing an unbounded legacy get() while deciding whether a guard applies.
export const readGenerationLinkedJob=(db,id)=>ownedRecord(db,'jobs',id);
export function assertGenerationShotOwnership(db,shot){
 const saved=ownedRecord(db,'shots',shot.id);
 if(saved.projectId!==shot.projectId)fail('INVALID_GENERATION_OWNERSHIP','镜头的项目归属已改变');
}
export function assertGenerationJobOwnership(db,job){
 const saved=ownedRecord(db,'jobs',job.id),shot=ownedRecord(db,'shots',job.shotId);
 if(saved.projectId!==job.projectId||saved.shotId!==job.shotId||shot.projectId!==job.projectId||job.snapshot.shotId!==job.shotId)
  fail('INVALID_GENERATION_OWNERSHIP','任务或镜头的项目归属已改变');
 return saved;
}
export function currentGenerationClaim(db,job){
 const saved=assertGenerationJobOwnership(db,job);
 if(['id','projectId','shotId','providerId','model','requestId','requestHash','retryOfJobId','providerJobId','submissionCount','revision','status'].some(key=>saved[key]!==job[key])||JSON.stringify(saved.snapshot)!==JSON.stringify(job.snapshot))
  fail('GENERATION_STATE_CHANGED','任务身份或冻结快照已改变');
 return saved;
}
const pinKeys=['inputProfileVersion','inputProfileId','providerRegion','referenceBindings'];

export const hasSubjectGeneration=source=>Boolean(source&&(Object.hasOwn(source,'subjectReference')||Object.hasOwn(source,'subjectVersionId'))||source?.referenceBindings?.some?.(binding=>binding?.role==='subject_reference')||source?.referenceAssets?.some?.(asset=>asset?.role==='subject_reference'));

// This check does not refresh a historical job's prompt, shot revision, current
// subject head, saved first/tail selection, provider budget or lifecycle policy.
export function validateSubjectGenerationOwnership(db,job){
 currentGenerationClaim(db,job);
 const receipt=db.prepare(`SELECT CASE WHEN typeof(requestId)='text' AND length(CAST(requestId AS BLOB)) BETWEEN 8 AND 800 THEN requestId END AS requestId,
  CASE WHEN typeof(requestHash)='text' AND length(CAST(requestHash AS BLOB))=64 THEN requestHash END AS requestHash,
  CASE WHEN typeof(resourceId)='text' AND length(CAST(resourceId AS BLOB))=36 THEN resourceId END AS resourceId FROM idempotency WHERE scope='generation' AND requestId=? LIMIT 1`).get(job.requestId);
 if(typeof job.requestId!=='string'||job.requestId.length<8||job.requestId.length>200||!/^[a-f0-9]{64}$/.test(job.requestHash??'')||!receipt||receipt.requestId!==job.requestId||receipt.requestHash!==job.requestHash||receipt.resourceId!==job.id)fail('INVALID_GENERATION_RECEIPT','原始主体生成请求凭据缺失或不一致；不会新建任务或自动重新提交');
 const issue=getSubjectGenerationSnapshotIssue(job.snapshot,{projectId:job.projectId,requireProfilePin:true});
 if(issue)fail(issue.code,issue.message);
 if(!isSubjectReference(job.snapshot.subjectReference)||job.snapshot.inputProfileVersion!==SUBJECT_REFERENCE_PROFILE_VERSION||job.snapshot.providerId!==job.providerId||job.snapshot.model!==job.model)manifestError();
 const graph=createOwnedMediaGraphReader(db,job.projectId);
 graph.validateSubjectReference(job.snapshot.subjectReference);
 return graph;
}

// Missing idempotency data never frees a retained subject request key, even
// when a caller omits its selector. Legacy non-subject replay semantics remain
// unchanged. JSON is byte/type guarded before extraction; bad rows are denial,
// not evidence that a key is unused. An unrelated damaged row may therefore
// block fresh admission. This defensive predicate can scan jobs; LIMIT bounds
// materialized candidates only, and exact legacy receipt replay returns first.
export function assertSubjectGenerationRequestVacant(db,input){
 const limit=INSPECTION_ROW_LIMITS.jobs;
 // Old provenance-only job records can legitimately omit a request key. Only
 // known subject claims make an invalid retained key an uncertain reservation.
 const subjectClaim=`json_type(data,'$.snapshot.subjectReference') IS NOT NULL OR json_type(data,'$.snapshot.subjectVersionId') IS NOT NULL OR
  CASE WHEN json_type(data,'$.snapshot.referenceAssets')='array' THEN EXISTS(SELECT 1 FROM json_each(data,'$.snapshot.referenceAssets') ref WHERE CASE WHEN ref.type='object' THEN json_extract(ref.value,'$.role') END='subject_reference') ELSE 0 END OR
  CASE WHEN json_type(data,'$.snapshot.referenceBindings')='array' THEN EXISTS(SELECT 1 FROM json_each(data,'$.snapshot.referenceBindings') ref WHERE CASE WHEN ref.type='object' THEN json_extract(ref.value,'$.role') END='subject_reference') ELSE 0 END`;
 const rows=db.prepare(`SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND ${limit} THEN data END AS data FROM jobs
  WHERE CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND ${limit} THEN
   CASE WHEN json_valid(data) THEN CASE WHEN json_type(data)='object' THEN CASE WHEN json_type(data,'$.requestId') IS NOT 'text' OR length(CAST(json_extract(data,'$.requestId') AS BLOB)) NOT BETWEEN 8 AND 800 THEN (${subjectClaim}) ELSE json_extract(data,'$.requestId')=? END ELSE 1 END ELSE 1 END ELSE 1 END LIMIT 2`).all(input.requestId);
 if(rows.length>1)fail('INVALID_GENERATION_RECEIPT','保留的生成请求归属不一致；不会新建任务或修复凭据');
 for(const row of rows){
  let retained;try{retained=JSON.parse(row.data);}catch{}
  if(!retained||typeof retained!=='object'||Array.isArray(retained)||retained.requestId!==input.requestId||input.subjectVersionId!==undefined||hasSubjectGeneration(retained.snapshot))fail('INVALID_GENERATION_RECEIPT','此请求 ID 已由保留的任务占用或凭据不完整；不会新建任务');
 }
}

// There is no indexed target column in the legacy edge table. The guarded JSON
// predicate can scan rows, but only bounded candidate rows/bytes are materialized.
// Unreadable edges, even in another project, cannot hide a target relation.
// An unrelated corrupt edge can therefore block new subject admission. Length
// checks and row scans are not a bound on database work; JSON parsing is bounded.
export function assertSubjectGenerationSelection(db,shot){
 assertGenerationShotOwnership(db,shot);
 assertGenerationReferenceIds(shot.referenceAssetIds);
 if(shot.referenceAssetIds.length||shot.lastFrameAssetId!=null)fail('REFERENCE_STATE_CONFLICT','本次主体参考不能与已保存的首帧或尾帧混用；请先明确修改镜头选择');
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
  let edge;try{edge=JSON.parse(row.data);}catch{fail('REFERENCE_STATE_CONFLICT','镜头连线状态无法安全核验');}
  if(!edge||edge.id!==row.id||edge.projectId!==row.projectId||row.projectId!==shot.projectId||edge.target!==shot.id||edge.kind!=='decorative'||Object.hasOwn(edge,'role')||Object.hasOwn(edge,'sourceAssetId'))fail('REFERENCE_STATE_CONFLICT','本次主体参考不能与首帧连线或损坏的连线混用');
  const source=db.prepare('SELECT id,projectId FROM nodes WHERE id=? UNION ALL SELECT id,projectId FROM shots WHERE id=? LIMIT 2').all(edge.source,edge.source);
  if(source.length!==1||source[0].projectId!==shot.projectId)fail('REFERENCE_STATE_CONFLICT','镜头连线状态无法安全核验');
 }
}

// Only current shot selections are expanded. A frozen manifest is already
// complete and must never acquire a tail from the current shot or array order.
export function generationReferenceSelection(source,{frozen=false}={}) {
 assertGenerationReferenceIds(source.referenceAssetIds);
 if(frozen){const issue=getSubjectGenerationSnapshotIssue(source,{requireProfilePin:true});if(issue)fail(issue.code,issue.message);return {ids:source.referenceAssetIds,references:null};}
 if(Object.hasOwn(source,'subjectReference')){
  if(!isSubjectReference(source.subjectReference)||source.referenceAssetIds.length!==1||source.referenceAssetIds[0]!==source.subjectReference.subjectVersion.assetId||source.lastFrameAssetId!=null)manifestError();
  return {ids:source.referenceAssetIds,references:[{role:'subject_reference',assetId:source.referenceAssetIds[0]}]};
 }
 const selection=getShotGenerationReferenceSelection(source);
 if(!selection.ok){const issue=selection.issues[0];fail(issue.code,issue.message,{issues:selection.issues});}
 return {ids:selection.references.map(reference=>reference.assetId),references:selection.references};
}

/** Resolve the complete saved selection. Never accept caller metadata or prune IDs. */
export function prepareGenerationInputs({source,projectId,providerId,model,capabilities,readAsset,asOf,frozen=false}) {
 const {ids,references:selection}=generationReferenceSelection(source,{frozen});
 const pinned=frozen?source.referenceAssets:null;
 if(frozen&&(!dense(pinned)||pinned.length!==ids.length||pinned.some((ref,index)=>!ref||ref.id!==ids[index])))manifestError();
 const assets=ids.map((id,index)=>{
  const asset=readAsset(id);
  if(!asset)fail('NOT_FOUND','找不到记录',{id});
  if(asset.id!==id||asset.projectId!==projectId)fail('INVALID_REFERENCE_OWNERSHIP','参考素材必须属于当前项目',{assetId:id});
  if(frozen){
   const ref=pinned[index];
   // Missing historical size is resolved only from the same managed identity.
   // Other frozen metadata is never substituted with a newer asset record.
   if(metadataKeys.some(key=>Object.hasOwn(ref,key)&&ref[key]!==asset[key]))
    fail('REFERENCE_CHANGED','参考图元数据已与冻结快照不同，请检查原始素材',{assetId:id});
  }
  return asset;
 });
 const hasPin=pinKeys.slice(0,3).some(key=>Object.hasOwn(source,key));
 if(hasPin&&!pinKeys.every(key=>Object.hasOwn(source,key)))manifestError();
 const connections=source.referenceConnections??[];
 if(Object.hasOwn(source,'subjectReference')&&(!dense(connections)||connections.length||frozen&&!hasPin))manifestError();
 if(!dense(connections)||connections.length>1||connections.some(connection=>!connection||connection.role!=='first_frame'||!ids.length||connection.sourceAssetId!==ids[0]))
  fail('REFERENCE_STATE_CONFLICT','首帧连线与镜头参考选择不一致，请先检查最新状态');
 if(!capabilities.models?.some(item=>(typeof item==='string'?item:item.id)===model))fail('UNSUPPORTED_MODEL','此供应商不支持冻结快照的模型');
 const region=getGenerationProfileRegion(providerId,capabilities);
 const profile=hasPin?getCapabilityProfile(providerId,model,region,{profileId:source.inputProfileId,profileVersion:source.inputProfileVersion}):frozen?getLegacyCapabilityProfile(providerId,model,region):getCapabilityProfile(providerId,model,region);
 if(frozen&&source.capabilities?.region&&source.capabilities.region!==region)fail('PROVIDER_REGION_CHANGED','供应商账户区域已更改，请恢复此任务原有区域后继续');
 if(!profile&&hasPin)manifestError();
 if(!profile)fail('INPUT_PROFILE_UNAVAILABLE','找不到此模型和服务器区域的精确输入规范；不会自动切换',{providerId,model});
 if(hasPin){
  if(source.inputProfileVersion!==profile.profileVersion||source.inputProfileId!==profile.profileId)manifestError();
  if(source.providerRegion!==region)fail('PROVIDER_REGION_CHANGED','供应商账户区域已更改，请恢复此任务原有区域后继续');
 }
 const bindings=hasPin?source.referenceBindings:assets.map((asset,index)=>({role:Object.hasOwn(pinned?.[index]??{},'role')?pinned[index].role:Object.hasOwn(asset,'role')?asset.role:selection?.[index]?.role??'first_frame',assetId:asset.id,sha256:asset.sha256}));
 if(!hasPin&&Object.hasOwn(source,'referenceBindings')&&JSON.stringify(source.referenceBindings)!==JSON.stringify(bindings))manifestError();
 if(!dense(bindings)||bindings.length!==ids.length||bindings.some((binding,index)=>!binding||Object.keys(binding).some(key=>!['role','assetId','sha256'].includes(key))||binding.assetId!==ids[index]||binding.sha256!==assets[index].sha256))manifestError();
 // A pair needs an explicit, complete role manifest. The tail selection is
 // provenance, never a license to reinterpret the second array entry.
 if(frozen&&source.lastFrameAssetId!=null){
  if(!hasPin||ids.length!==2||source.lastFrameAssetId!==ids[1]||bindings[0]?.role!=='first_frame'||bindings[1]?.role!=='last_frame')manifestError();
 }
 if(bindings.some(binding=>binding.role==='last_frame')&&(!hasPin&&frozen||ids.length!==2||bindings[0]?.role!=='first_frame'||bindings[1]?.role!=='last_frame'||frozen&&source.lastFrameAssetId!==ids[1]))manifestError();
 const references=assets.map((asset,index)=>{
  const metadata=frozen?pinned[index]:asset;
  const role=bindings[index].role;
  if([metadata,asset].some(value=>Object.hasOwn(value,'role')&&value.role!==role))manifestError();
  // Persisted semantic claims must never disappear through metadata projection.
  const timed=[metadata,asset].find(value=>Object.hasOwn(value,'durationSeconds')||Object.hasOwn(value,'duration')&&value.duration!==0);
  return {role,assetId:asset.id,mimeType:metadata.mimeType,sha256:metadata.sha256,
   ...(timed?{durationSeconds:timed.durationSeconds??timed.duration}:{}),
   sizeBytes:metadata.sizeBytes??asset.sizeBytes,
   ...(metadata.width!==undefined?{width:metadata.width}:{}),...(metadata.height!==undefined?{height:metadata.height}:{})};
 });
 const plan=buildAdapterPlan({providerId,model,region,prompt:source.prompt,aspectRatio:source.aspectRatio,duration:source.duration,parameters:source.parameters,references},{asOf,profileId:profile.profileId,profileVersion:profile.profileVersion});
 if(!plan.ok){const issue=plan.issues[0];fail(issue.code,issue.message,{providerId,model,issues:plan.issues,warnings:plan.warnings});}
 return {assets:assets.map((asset,index)=>({...asset,...plan.adapterSnapshot.referenceAssets[index]})),plan,
  fields:{inputProfileVersion:plan.profileVersion,inputProfileId:plan.profileId,providerRegion:region,referenceBindings:plan.referenceBindings}};
}
