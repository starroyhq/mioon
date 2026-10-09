import {randomUUID} from 'node:crypto';
import {terminateMediaProcesses} from './media-processes.mjs';
import {rename,link,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileInfo,probe,safePath,stitch,run} from './media.mjs';
import {renderTimeline} from './timeline-media.mjs';
import {now} from './services.mjs';
export function startWorker(store,services,providers){
 const {list,get,put,tx,root}=store;let busy=false,stopped=false;
 const safeError=(e,code='PROVIDER_ERROR')=>({code:e.code||code,message:e.uncertain?'供应商可能已受理。正在对账，不会自动重新提交。':String(e.message||'任务操作失败').replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_\-.]+/gi,'[redacted]').slice(0,600),retryable:true});
 for(const j of list('jobs')){if(j.status==='submitting')services.saveJob(j,{status:'submission_unknown',phase:'recovering_submit',error:{code:'SUBMISSION_UNKNOWN',message:'服务在提交期间中断；先对账，绝不盲目重新提交',retryable:true}});}
 for(const e of list('exports'))if(e.status==='running')put('exports',{...e,status:'queued',updatedAt:now()});
 async function processJob(original){let j=get('jobs',original.id);const provider=providers.get(j.providerId),context={requestId:j.requestId,jobId:j.id,providerRegion:j.snapshot.capabilities?.region};let acceptedProviderId=null;
  if(j.nextPollAt&&Date.now()<j.nextPollAt)return;
  try{
   if(j.status==='queued'){
    j=services.saveJob(j,{status:'submitting',phase:'provider_submit',submissionCount:j.submissionCount+1});
    const adapterSnapshot={...j.snapshot,referenceAssets:await Promise.all(j.snapshot.referenceAssets.map(async ref=>{const asset=get('assets',ref.id);if(!asset||asset.projectId!==j.projectId||asset.sha256!==ref.sha256)throw Error('Reference snapshot no longer matches managed asset');return {...ref,path:await safePath(root,asset.relativePath)};}))};const accepted=await provider.submit(adapterSnapshot,context);acceptedProviderId=accepted.providerJobId;
    const latest=get('jobs',j.id);j=services.saveJob(latest,{providerJobId:accepted.providerJobId,...latest.status==='cancelled'?{}:{status:'running',phase:'polling',progress:5,error:null}});return;
   }
   if(j.status==='submission_unknown'){
    const found=j.providerJobId?{providerJobId:j.providerJobId}:await provider.reconcile(j.requestId,context);
    if(found)services.saveJob(j,{status:'running',phase:'reconciled',providerJobId:found.providerJobId,error:null,nextPollAt:0});else services.saveJob(j,{nextPollAt:Date.now()+5000});return;
   }
   if(j.status==='running'){
    const remote=await provider.poll(j.providerJobId,context);
    if(get('jobs',j.id).status==='cancelled')return;
    if(remote.status==='failed'){services.saveJob(j,{status:'failed',phase:'provider_failed',error:typeof remote.error==='object'?remote.error:{code:'GENERATION_FAILED',message:remote.error||'供应商任务失败',retryable:true}});return;}
    if(remote.status!=='succeeded'){services.saveJob(j,{progress:remote.progress==null?j.progress:Math.round(remote.progress*100),nextPollAt:Date.now()+(provider.capabilities.minPollIntervalMs||350),error:null});return;}
    j=services.saveJob(j,{status:'downloading',phase:'downloading',progress:90,nextPollAt:0,error:null});
   }
   if(j.status==='downloading'){
    const relativePath=`media/result-${j.id}.mp4`,file=path.join(root,relativePath),part=file+'.part.mp4';let info;
    try{info=await fileInfo(file);if(!info.hasVideo)throw Error('Generated output must contain video');}catch{await provider.download(j.providerJobId,part,context);info=await fileInfo(part);if(!info.hasVideo)throw Error('Generated output must contain video');await run('ffmpeg',['-v','error','-i',part,'-f','null','-']);await rename(part,file);}
    if(get('jobs',j.id).status==='cancelled')return;
    if(!provider.capabilities.mock){
     const [ratioWidth,ratioHeight]=j.snapshot.aspectRatio.split(':').map(Number);
     const actualRatio=info.width/info.height,expectedRatio=ratioWidth/ratioHeight;
     if(!Number.isFinite(actualRatio)||Math.abs(actualRatio/expectedRatio-1)>0.01){
      services.saveJob(j,{status:'cancelled',phase:'output_review_required',cancelScope:'local_only',error:{code:'OUTPUT_ASPECT_RATIO_MISMATCH',message:'供应商已完成，但下载的视频比例与镜头要求不符。已暂停发布版本；请检查已有任务，不要重新提交生成。',retryable:false},nextPollAt:0});
      return;
     }
    }
    tx(()=>{const previous=list('versions',j.projectId).find(v=>v.jobId===j.id);if(previous){services.saveJob(j,{status:'succeeded',phase:'complete',versionId:previous.id,progress:100,error:null});return;}
     const asset={id:randomUUID(),projectId:j.projectId,name:`${j.snapshot.title} ${j.providerId==='mock'?'模拟':'生成'}视频.mp4`,mimeType:'video/mp4',...info,relativePath,url:null,provenance:j.providerId==='mock'?'synthetic-mock':'generated',createdAt:now()};asset.url=`/media/${asset.id}`;put('assets',asset);
     const version={id:randomUUID(),projectId:j.projectId,shotId:j.shotId,jobId:j.id,number:list('versions',j.projectId).filter(v=>v.shotId===j.shotId).length+1,providerId:j.providerId,model:j.model,isMock:j.providerId==='mock',snapshot:j.snapshot,assetId:asset.id,url:asset.url,sha256:info.sha256,createdAt:now()};put('versions',version);
     const s=get('shots',j.shotId);if(!s.selectedVersionId)put('shots',{...s,selectedVersionId:version.id,revision:s.revision+1,updatedAt:now()});services.saveJob(j,{status:'succeeded',phase:'complete',progress:100,versionId:version.id,error:null});
    });
   }
  }catch(e){const latest=get('jobs',j.id);if(latest.status==='cancelled')return;
   if(j.status==='submitting'){const uncertain=Boolean(e.uncertain||acceptedProviderId);services.saveJob(latest,{status:uncertain?'submission_unknown':'failed',phase:uncertain?'reconciliation_required':'submit_failed',...(acceptedProviderId?{providerJobId:acceptedProviderId}:{}),error:safeError(uncertain?{code:'SUBMISSION_UNKNOWN',uncertain:true}:e),nextPollAt:Date.now()+800});}
   else if(j.status==='running'||j.status==='downloading'||j.status==='submission_unknown')services.saveJob(latest,{error:safeError(e,j.status==='downloading'?'DOWNLOAD_FAILED':'POLL_ERROR'),nextPollAt:Date.now()+1000});
   else services.saveJob(latest,{status:'failed',error:safeError(e)});
  }
 }
 async function processExport(e){
  put('exports',{...e,status:'running',updatedAt:now()});
  // Every recovery attempt gets a fresh file. A crash after publication must
  // never make a later render overwrite an existing output or source asset.
  const relativePath=`media/export-${e.id}-${randomUUID()}.mp4`,file=path.join(root,relativePath),part=file+'.part.mp4';
  try{
   if(e.mode==='timeline'){
    if(!e.snapshot?.timeline||!Array.isArray(e.snapshot.assets))throw Error('Timeline render has no frozen snapshot');
    const assets=new Map();
    for(const frozen of e.snapshot.assets){
     const a=get('assets',frozen.id);
     if(!a||a.projectId!==e.projectId||a.sha256!==frozen.sha256||a.mimeType!==frozen.mimeType||assets.has(a.id))throw Error('Timeline snapshot does not match managed asset');
     if(frozen.relativePath!==undefined&&frozen.relativePath!==a.relativePath)throw Error('Timeline snapshot path no longer matches managed asset');
     const mediaPath=await safePath(root,a.relativePath),actual=await fileInfo(mediaPath);
     if(actual.sha256!==frozen.sha256)throw Error('Timeline input bytes differ from frozen asset hash');
     const media=await probe(mediaPath);
     assets.set(a.id,{...frozen,...actual,videoStreamIndex:media.videoStreamIndex,audioStreamIndex:media.audioStreamIndex,path:mediaPath});
    }
    await renderTimeline(e.snapshot,assets,part);
   }else{
    const files=[];
    for(const v of e.snapshot){const a=get('assets',v.assetId);if(!a||a.projectId!==e.projectId||a.sha256!==v.sha256)throw Error('Export snapshot hash mismatch');const mediaPath=await safePath(root,a.relativePath);const actual=await fileInfo(mediaPath);if(actual.sha256!==v.sha256)throw Error('Export input bytes differ from frozen version hash');files.push(mediaPath);}
    await stitch(files,part);
   }
   const info=await fileInfo(part);
   // link is an atomic, non-overwriting publication on the managed filesystem.
   await link(part,file);await unlink(part);
   tx(()=>{const a={id:randomUUID(),projectId:e.projectId,name:e.mode==='timeline'?`多轨时间线-${e.purpose==='preview'?'预览':'导出'}-9x16.mp4`:'分镜拼接-9x16.mp4',mimeType:'video/mp4',relativePath,...info,provenance:'export',createdAt:now()};a.url=`/media/${a.id}`;put('assets',a);put('exports',{...e,status:'succeeded',assetId:a.id,url:a.url,error:null,updatedAt:now()});});
  }catch(error){put('exports',{...e,status:stopped&&error.code==='MEDIA_CANCELLED'?'queued':'failed',error:stopped&&error.code==='MEDIA_CANCELLED'?null:safeError(error,'EXPORT_FAILED'),updatedAt:now()});}
  finally{await unlink(part).catch(()=>{});}
 }
 async function tick(){if(busy||stopped)return;busy=true;try{for(const j of list('jobs'))if(!stopped&&['queued','running','downloading','submission_unknown'].includes(j.status))await processJob(j);for(const e of list('exports'))if(!stopped&&e.status==='queued')await processExport(e);}catch(e){console.error('Worker cycle failed:',e.code||e.name);}finally{busy=false;}}
 const timer=setInterval(tick,200);tick();return {stop:async({interruptMedia=false}={})=>{stopped=true;clearInterval(timer);if(interruptMedia)await terminateMediaProcesses();while(busy)await new Promise(r=>setTimeout(r,25));},tick};
}
