import {AppError,INPUT_PROFILE_VERSION,getCapabilityProfile,getGenerationProfileRegion,buildAdapterPlan} from '@mioon/contracts';

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
 return asset;
}
function ownedRecord(db,table,id){
 const row=db.prepare(`SELECT id,projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=262144 THEN data END AS data FROM ${table} WHERE id=?`).get(id);
 let record;try{record=JSON.parse(row?.data);}catch{}
 if(!record||record.id!==row.id||record.projectId!==row.projectId)fail('INVALID_GENERATION_OWNERSHIP','任务或镜头的项目归属已改变');
 return record;
}
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

/** Resolve the complete saved selection. Never accept caller metadata or prune IDs. */
export function prepareGenerationInputs({source,projectId,providerId,model,capabilities,readAsset,asOf,frozen=false}) {
 const ids=source.referenceAssetIds;
 assertGenerationReferenceIds(ids);
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
 const connections=source.referenceConnections??[];
 if(!dense(connections)||connections.length>1||connections.some(connection=>!connection||connection.role!=='first_frame'||ids.length!==1||connection.sourceAssetId!==ids[0]))
  fail('REFERENCE_STATE_CONFLICT','首帧连线与镜头参考选择不一致，请先检查最新状态');
 if(!capabilities.models?.some(item=>(typeof item==='string'?item:item.id)===model))fail('UNSUPPORTED_MODEL','此供应商不支持冻结快照的模型');
 const region=getGenerationProfileRegion(providerId,capabilities),profile=getCapabilityProfile(providerId,model,region);
 if(frozen&&source.capabilities?.region&&source.capabilities.region!==region)fail('PROVIDER_REGION_CHANGED','供应商账户区域已更改，请恢复此任务原有区域后继续');
 if(!profile)fail('INPUT_PROFILE_UNAVAILABLE','找不到此模型和服务器区域的精确输入规范；不会自动切换',{providerId,model});
 const hasPin=pinKeys.some(key=>Object.hasOwn(source,key));
 if(hasPin){
  if(!pinKeys.every(key=>Object.hasOwn(source,key))||source.inputProfileVersion!==INPUT_PROFILE_VERSION||source.inputProfileId!==profile.profileId)manifestError();
  if(source.providerRegion!==region)fail('PROVIDER_REGION_CHANGED','供应商账户区域已更改，请恢复此任务原有区域后继续');
 }
 const bindings=hasPin?source.referenceBindings:assets.map((asset,index)=>({role:Object.hasOwn(pinned?.[index]??{},'role')?pinned[index].role:Object.hasOwn(asset,'role')?asset.role:'first_frame',assetId:asset.id,sha256:asset.sha256}));
 if(!dense(bindings)||bindings.length!==ids.length||bindings.some((binding,index)=>!binding||Object.keys(binding).some(key=>!['role','assetId','sha256'].includes(key))||binding.assetId!==ids[index]||binding.sha256!==assets[index].sha256))manifestError();
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
 const plan=buildAdapterPlan({providerId,model,region,prompt:source.prompt,aspectRatio:source.aspectRatio,duration:source.duration,parameters:source.parameters,references},{asOf});
 if(!plan.ok){const issue=plan.issues[0];fail(issue.code,issue.message,{providerId,model,issues:plan.issues,warnings:plan.warnings});}
 return {assets:assets.map((asset,index)=>({...asset,...plan.adapterSnapshot.referenceAssets[index]})),plan,
  fields:{inputProfileVersion:plan.profileVersion,inputProfileId:plan.profileId,providerRegion:region,referenceBindings:plan.referenceBindings}};
}
