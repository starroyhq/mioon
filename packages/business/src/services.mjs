import {randomUUID,createHash} from 'node:crypto';
import {writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {parse,AppError,publicValue,getGenerationIssue} from '@video-workbench/contracts';
import {normalizedCapabilities,generationLimit,providerSettings} from './provider-registry.mjs';
import {fileInfo,safePath} from './media.mjs';
import {createTimelineServices} from './timeline.mjs';
export const now=()=>new Date().toISOString();
export function canonical(v){return JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);}
export const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
export function createServices(store,providers,{env=process.env}={}){
 const {db,root,get,list,put,tx}=store;
 const required=(t,id)=>{const v=get(t,id);if(!v)throw new AppError('NOT_FOUND','找不到记录',404,{id});return v;};
 const check=(v,rev)=>{if(v.revision!==rev)throw new AppError('REVISION_CONFLICT','内容已有新版本，请重新读取后再修改',409,{entityId:v.id,expectedRevision:rev,currentRevision:v.revision,current:publicValue(v)});};
 const refs=(projectId,ids)=>{for(const id of ids){const a=required('assets',id);if(a.projectId!==projectId)throw new AppError('CROSS_PROJECT_REFERENCE','素材不属于此项目');}};
 const touchProject=id=>{const p=required('projects',id);put('projects',{...p,revision:p.revision+1,updatedAt:now()});};
 const dedupe=(scope,requestId,requestHash,table)=>{const r=db.prepare('SELECT * FROM idempotency WHERE scope=? AND requestId=?').get(scope,requestId);if(!r)return null;if(r.requestHash!==requestHash)throw new AppError('IDEMPOTENCY_CONFLICT','同一请求 ID 已用于不同内容',409,{requestId});return required(table,r.resourceId);};
 const idem=(scope,key,h,id)=>db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(scope,key,h,id);
 const event=(job,event)=>db.prepare('INSERT INTO job_events(jobId,event,createdAt) VALUES(?,?,?)').run(job.id,JSON.stringify(event),now());
 const saveJob=(job,patch)=>{const current=required('jobs',job.id);if((current.revision||0)!==(job.revision||0))return current;const result={...current,...patch,revision:(current.revision||0)+1,updatedAt:now()};put('jobs',result);event(result,{status:result.status,phase:result.phase,error:result.error});return result;};
 const capabilitiesFor=provider=>normalizedCapabilities(provider,env,list('jobs').filter(j=>j.providerId===provider.id).length);
 const validateProvider=(source,providerId,requestedModel,parameters)=>{
  const p=providers.get(providerId);if(!p)throw new AppError('PROVIDER_NOT_FOUND','供应商不存在');
  const c=capabilitiesFor(p),first=c.models[0],model=requestedModel||(typeof first==='string'?first:first.id);
  const assets=source.referenceAssetIds.map(id=>required('assets',id));
  // Config checks never reveal credentials. Raw adapter enabled remains distinct from
  // the exhausted/missing local generation limit exposed in the capability status.
  if(!p.capabilities.enabled||!p.capabilities.configured)throw new AppError('PROVIDER_DISABLED','真实供应商尚未安全配置并授权；当前可使用模拟供应商',403,{providerId,status:c.status,configuration:c.configuration});
  if(providerSettings[providerId]){
   const max=generationLimit(providerId,env),used=list('jobs').filter(j=>j.providerId===providerId).length;
   if(!max||used>=max)throw new AppError('LIVE_BUDGET_REQUIRED','需要后端设置已授权生成次数上限，或当前额度已耗尽',403,{providerId,budget:c.budget});
  }
  if(source.capabilities?.region&&c.region!==source.capabilities.region)throw new AppError('PROVIDER_REGION_CHANGED','供应商账户区域已更改，请恢复此任务原有区域后继续',409);
  const snapshot={...source,model,referenceAssets:assets,parameters};
  const issue=getGenerationIssue(snapshot,c);if(issue)throw new AppError(issue.code,issue.message,400,{providerId,model});
  if(p.validate){try{p.validate(snapshot);}catch(error){throw new AppError(error.code||'UNSUPPORTED_PARAMETERS',error.message||'此供应商不支持所选参数',400,{providerId,model});}}
  return {p,model,assets,capabilities:c};
 };
 const createJob=(input,retrySnapshot=null,retryOfJobId=null)=>tx(()=>{
  const requestHash=hash(input), prior=dedupe('generation',input.requestId,requestHash,'jobs');if(prior)return prior;
  const shot=required('shots',input.shotId);if(!retrySnapshot)check(shot,input.expectedRevision);
  const source=retrySnapshot||shot;const parameters=retrySnapshot?.parameters||{...shot.parameters,...input.parameters};const {model,assets,capabilities}=validateProvider(source,input.providerId,input.model,parameters);
  const snapshot=retrySnapshot||{shotId:shot.id,shotRevision:shot.revision,title:shot.title,prompt:shot.prompt,referenceAssetIds:[...shot.referenceAssetIds],referenceAssets:assets.map(a=>({id:a.id,relativePath:a.relativePath,mimeType:a.mimeType,sha256:a.sha256,width:a.width,height:a.height})),aspectRatio:shot.aspectRatio,duration:shot.duration,providerId:input.providerId,model,parameters,capabilities};
  const job={id:randomUUID(),projectId:shot.projectId,shotId:shot.id,requestId:input.requestId,requestHash,providerId:input.providerId,model,revision:1,status:'queued',phase:'waiting',progress:0,snapshot,providerJobId:null,submissionCount:0,error:null,createdAt:now(),updatedAt:now(),versionId:null,cancelScope:null,retryOfJobId};put('jobs',job);idem('generation',input.requestId,requestHash,job.id);event(job,{status:'queued'});return job;
 });
 const timeline=createTimelineServices(store,{required,check,hash,now});
 const handlers={
 ...timeline.handlers,
 'project.create':i=>put('projects',{id:randomUUID(),name:i.name,description:i.description||'',revision:1,createdAt:now(),updatedAt:now()}),
 'project.list':()=>list('projects').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),
 'project.get':i=>tx(()=>{const project=required('projects',i.projectId);return {project,timeline:timeline.ensure(i.projectId),timelineHistory:timeline.history(i.projectId),...Object.fromEntries(['assets','shots','nodes','edges','jobs','versions','exports'].map(t=>[t,list(t,i.projectId).sort(t==='shots'?(a,b)=>a.orderIndex-b.orderIndex:(a,b)=>(a.createdAt||'').localeCompare(b.createdAt||''))]))};}),
 'asset.import':async i=>{
  required('projects',i.projectId);
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(i.dataBase64)||i.dataBase64.length%4)throw new AppError('INVALID_MEDIA','无效的 base64');
  const bytes=Buffer.from(i.dataBase64,'base64');
  if(bytes.length>30*1024*1024||bytes.length===0)throw new AppError('INVALID_MEDIA','素材大小须为 1 字节至 30 MiB');
  const four=(start,value)=>bytes.toString('ascii',start,start+4)===value;
  const mp3Frame=bytes.length>=4&&bytes[0]===255&&(bytes[1]&224)===224&&(bytes[1]&24)!==8&&(bytes[1]&6)!==0&&(bytes[2]&240)!==240&&(bytes[2]&12)!==12;
  const detected=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':
   bytes[0]===255&&bytes[1]===216?'image/jpeg':
   four(0,'RIFF')&&four(8,'WEBP')?'image/webp':
   four(0,'RIFF')&&four(8,'WAVE')?'audio/wav':
   bytes.toString('ascii',0,3)==='ID3'||mp3Frame?'audio/mpeg':
   four(4,'ftyp')?'iso-bmff':
   bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]))?'video/webm':null;
  const matches=detected==='iso-bmff'?['video/mp4','audio/mp4'].includes(i.mimeType):detected===i.mimeType;
  if(!matches)throw new AppError('INVALID_MEDIA','文件类型与实际内容不符');
  const id=randomUUID(),ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','audio/wav':'wav','audio/mpeg':'mp3','audio/mp4':'m4a'}[i.mimeType],relativePath=`media/${id}.${ext}`,file=path.join(root,relativePath);
  await writeFile(file,bytes,{flag:'wx'});
  try{
   const info=await fileInfo(file),hasVideo=info.hasVideo??(info.width>0&&info.height>0);
   if(i.mimeType.startsWith('audio/')?(!info.hasAudio||hasVideo||!(info.duration>0)):!hasVideo)
    throw Error('Declared media kind does not match decoded streams');
   return put('assets',{id,projectId:i.projectId,name:i.name,mimeType:i.mimeType,...info,relativePath,url:`/media/${id}`,createdAt:now(),provenance:'user-import'});
  }catch(e){await unlink(file);throw new AppError('INVALID_MEDIA','无法解码素材或媒体类型不符，请检查文件');}
 },
 'asset.list':i=>{required('projects',i.projectId);return list('assets',i.projectId);},
 'shot.create':i=>tx(()=>{required('projects',i.projectId);refs(i.projectId,i.referenceAssetIds||[]);const shot={id:randomUUID(),projectId:i.projectId,title:i.title,prompt:i.prompt||'',referenceAssetIds:i.referenceAssetIds||[],aspectRatio:i.aspectRatio||'9:16',duration:i.duration||2,parameters:i.parameters||{},position:i.position||{x:80+list('shots',i.projectId).length*300,y:100},orderIndex:list('shots',i.projectId).length,revision:1,selectedVersionId:null,createdAt:now(),updatedAt:now()};put('shots',shot);touchProject(i.projectId);return shot;}),
 'shot.update':i=>tx(()=>{const shot=required('shots',i.shotId);check(shot,i.expectedRevision);refs(shot.projectId,i.patch.referenceAssetIds||shot.referenceAssetIds);return put('shots',{...shot,...i.patch,revision:shot.revision+1,updatedAt:now()});}),
 'shot.reorder':i=>tx(()=>{const p=required('projects',i.projectId);check(p,i.expectedRevision);const shots=list('shots',p.id);if(i.shotIds.length!==shots.length||new Set(i.shotIds).size!==shots.length||shots.some(s=>!i.shotIds.includes(s.id)))throw new AppError('INVALID_ORDER','顺序必须包含全部镜头且不能重复');i.shotIds.forEach((id,orderIndex)=>{const s=required('shots',id);put('shots',{...s,orderIndex});});touchProject(p.id);return get('projects',p.id);}),
 'node.create':i=>{required('projects',i.projectId);if(i.type!=='text'){if(!i.assetId)throw new AppError('ASSET_REQUIRED','图片/视频/音频节点需要素材');refs(i.projectId,[i.assetId]);const a=required('assets',i.assetId);if(!a.mimeType.startsWith(i.type+'/'))throw new AppError('INVALID_NODE_ASSET','节点类型与素材不一致');}return put('nodes',{id:randomUUID(),...i,label:i.label||'',text:i.text||'',revision:1,createdAt:now()});},
 'node.update':i=>{const n=required('nodes',i.nodeId);check(n,i.expectedRevision);return put('nodes',{...n,...i.patch,revision:n.revision+1});},
 'edge.create':i=>{required('projects',i.projectId);for(const id of [i.source,i.target]){const n=get('shots',id)||get('nodes',id);if(!n||n.projectId!==i.projectId)throw new AppError('INVALID_EDGE','只能连接同项目的节点');}if(i.source===i.target)throw new AppError('INVALID_EDGE','不能连接到自身');const existing=list('edges',i.projectId).find(e=>e.source===i.source&&e.target===i.target);return existing||put('edges',{id:randomUUID(),...i});},
 'edge.delete':i=>{required('edges',i.edgeId);db.prepare('DELETE FROM edges WHERE id=?').run(i.edgeId);return {deleted:true};},
 'provider.list':()=>[...providers.values()].map(capabilitiesFor),
 'generation.submit':i=>createJob(i),
 'job.get':i=>required('jobs',i.jobId),
 'job.list':i=>{required('projects',i.projectId);return list('jobs',i.projectId);},
 'job.retry':i=>{const old=required('jobs',i.jobId);const newInput={shotId:old.shotId,expectedRevision:old.snapshot.shotRevision,requestId:i.requestId,providerId:old.providerId,model:old.model,parameters:old.snapshot.parameters,retryOfJobId:old.id};const prior=dedupe('generation',i.requestId,hash(newInput),'jobs');if(prior)return prior;if(old.status!=='failed')throw new AppError('UNSAFE_RETRY','只有明确失败的任务可重新提交；未知提交结果须先对账',409);const activeChild=list('jobs',old.projectId).find(child=>child.retryOfJobId===old.id&&['queued','submitting','running','downloading','submission_unknown'].includes(child.status));if(activeChild)throw new AppError('RETRY_ALREADY_ACTIVE','该失败任务已有重试正在处理，请查询已有任务',409,{jobId:activeChild.id});if(i.requestId===old.requestId)throw new AppError('NEW_REQUEST_REQUIRED','重试必须使用新的请求 ID',409);return createJob(newInput,old.snapshot,old.id);},
 'job.cancel':i=>{const j=required('jobs',i.jobId);if(['succeeded','failed','cancelled'].includes(j.status))return j;return saveJob(j,{status:'cancelled',phase:'local_wait_stopped',cancelScope:'local_only',error:{code:'LOCAL_WAIT_STOPPED',message:'已停止本地等待；供应商任务未确认取消，可能仍会完成或计费',retryable:true}});},
 'job.reconcile':async i=>{const j=required('jobs',i.jobId),context={jobId:j.id,requestId:j.requestId,providerRegion:j.snapshot.capabilities?.region};if(['succeeded','failed','queued','submitting'].includes(j.status)){if(i.providerJobId)throw new AppError('INVALID_RECONCILIATION_STATE','当前任务状态不允许绑定供应商任务',409);return j;}if(i.providerJobId&&j.providerJobId&&i.providerJobId!==j.providerJobId)throw new AppError('TASK_ID_CONFLICT','已知供应商任务 ID 不可替换',409);if(i.providerJobId){const owner=list('jobs').find(other=>other.id!==j.id&&other.providerId===j.providerId&&other.providerJobId===i.providerJobId);if(owner)throw new AppError('TASK_ID_CONFLICT','供应商任务已属于另一个本地任务，不能替换其参数快照',409);if(j.providerId==='mock'){const own=await providers.get('mock').reconcile(j.requestId,context);if(!own||own.providerJobId!==i.providerJobId)throw new AppError('TASK_ID_CONFLICT','模拟任务 ID 与此提交请求不匹配',409);}}const p=providers.get(j.providerId);if(j.snapshot.capabilities?.region&&p.capabilities.region!==j.snapshot.capabilities.region)throw new AppError('PROVIDER_REGION_CHANGED','供应商账户区域已更改，请恢复此任务原有区域后继续',409);const found=i.providerJobId?{providerJobId:i.providerJobId}:j.providerJobId?{providerJobId:j.providerJobId}:await p.reconcile(j.requestId,context);if(!found)return saveJob(j,{status:'submission_unknown',phase:'reconciliation_required',error:{code:'SUBMISSION_UNKNOWN',message:'无法确认是否已被受理；不会自动重新提交。请在供应商后台核实已有任务 ID',retryable:true}});await p.poll(found.providerJobId,context);const competing=list('jobs').find(other=>other.id!==j.id&&other.providerId===j.providerId&&other.providerJobId===found.providerJobId);if(competing)throw new AppError('TASK_ID_CONFLICT','供应商任务已由另一个本地任务占用',409);return saveJob(j,{status:'running',phase:'polling',providerJobId:found.providerJobId,error:null,cancelScope:null});},
 'version.list':i=>{const s=required('shots',i.shotId);return list('versions',s.projectId).filter(v=>v.shotId===s.id).sort((a,b)=>a.number-b.number);},
 'version.select':i=>tx(()=>{const s=required('shots',i.shotId);check(s,i.expectedRevision);const v=required('versions',i.versionId);if(v.shotId!==s.id)throw new AppError('INVALID_VERSION','版本不属于此镜头');return put('shots',{...s,selectedVersionId:v.id,revision:s.revision+1,updatedAt:now()});}),
 'export.create':i=>tx(()=>{const h=hash(i),prior=dedupe('export',i.requestId,h,'exports');if(prior)return prior;required('projects',i.projectId);const shots=list('shots',i.projectId).sort((a,b)=>a.orderIndex-b.orderIndex);if(!shots.length||shots.some(s=>!s.selectedVersionId))throw new AppError('MISSING_SELECTION','请为每个镜头选择已生成的视频版本');const versions=shots.map(s=>required('versions',s.selectedVersionId));const e={id:randomUUID(),projectId:i.projectId,requestId:i.requestId,status:'queued',orderedVersionIds:versions.map(v=>v.id),snapshot:versions.map(v=>({versionId:v.id,assetId:v.assetId,sha256:v.sha256,shotId:v.shotId})),assetId:null,url:null,error:null,createdAt:now(),updatedAt:now()};put('exports',e);idem('export',i.requestId,h,e.id);return e;}),
 'export.get':i=>required('exports',i.exportId)
 };
 async function call(op,input){const parsed=parse(op,input);return publicValue(await handlers[op](parsed));}
 return {call,required,check,event,saveJob,createJob,handlers,publicValue};
}
