import type {WorkspaceStore} from './db.ts';
import {ownsStoreLock} from './db.ts';
import {getWorkspaceRestoreContext} from './workspace-restore-schema.ts';
import {isTimelineRenderRecord,AppError} from '@mioon/contracts';
import {readTimelineExportOutput} from './timeline-delivery-read.ts';
import {readOwnedTimelineAsset} from './timeline-sources.ts';
import {verifiedManagedHash} from './managed-media.ts';
import {isFloatTimelineExport,claimFloatTimelineExport} from './timeline-float-outcome.ts';
import {timelineRenderDeliveryFields} from '../../contracts/src/timeline-delivery.ts';
import {assertFloatTimelineExportRead} from './timeline-float-outcome.ts';
import {exportControlSchemas,exportActivitySchema,exportOutputSchema} from '../../contracts/src/export-controls.ts';

type Stage='preparing'|'encoding'|'finalizing';
interface Activity {stage:Stage;started:number;abort():void}
const activities=new WeakMap<object,Map<string,Activity>>();
const row=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const isCancelledExport=(value:unknown):boolean=>row(value)&&value.status==='failed'&&row(value.error)&&value.error.code==='EXPORT_CANCELLED';
/** Runtime authority is held by the worker, never accepted from an RPC. The
 * terminal cancellation uses the existing failed outcome, keeping historical
 * frozen export/backup contracts exact. */
export function exportStage(store:object,id:string,stage:Stage):void {const activity=activities.get(store)?.get(id);if(activity)activity.stage=stage;}
export function registerExportActivity(store:object,id:string,abort:()=>void):{stage(value:Stage):void;close():void}{
  let owned=activities.get(store);if(!owned){owned=new Map();activities.set(store,owned);}
  const activity:Activity={stage:'preparing',started:Date.now(),abort};owned.set(id,activity);
  return {stage:value=>{if(owned.get(id)===activity)activity.stage=value;},close:()=>{if(owned.get(id)===activity)owned.delete(id);}};
}
export function createExportControlServices(store:WorkspaceStore,{signal}:{signal?:AbortSignal}={}){
  function checkpoint(){signal?.throwIfAborted();if(!ownsStoreLock(store)||getWorkspaceRestoreContext(store))throw new AppError('WORKSPACE_READ_ONLY','当前工作区不支持此操作',409);}
  function read(projectId:string,exportId:string){
    checkpoint();const raw=store.db.prepare('SELECT data FROM exports WHERE id=? AND projectId=? AND length(CAST(data AS BLOB))<=4194304').get(exportId,projectId);
    let value:unknown;try{value=raw&&typeof raw.data==='string'?JSON.parse(raw.data):null;}catch{value=null;}
    if(!row(value)||value.id!==exportId||value.projectId!==projectId||typeof value.status!=='string')throw new AppError('NOT_FOUND','导出任务不存在',404);
    if(value.mode==='timeline'&&!isTimelineRenderRecord(value,{projectId,requestId:value.requestId,purpose:value.purpose,expectedRevision:value.timelineRevision,...timelineRenderDeliveryFields(value.snapshot)}))throw new AppError('INVALID_TIMELINE_SNAPSHOT','导出任务无法核对',409);
    assertFloatTimelineExportRead(store.db,value,{isTimelineRenderRecord,readOwnedAsset:(owner,id)=>readOwnedTimelineAsset(store.db,owner,id)});
    if(value.mode!=='timeline'){
      const receipt=store.db.prepare("SELECT resourceId FROM idempotency WHERE scope='export' AND requestId=?").get(String(value.requestId));
      if(receipt?.resourceId!==exportId||!Array.isArray(value.snapshot))throw new AppError('INVALID_TIMELINE_SNAPSHOT','导出任务无法核对',409);
    }
    return value;
  }
  return {handlers:{
    'export.cancel':(raw:unknown)=>{
      const input=exportControlSchemas['export.cancel'].parse(raw);
      const result=store.tx(()=>{
        const current=read(input.projectId,input.exportId);
        if(!['queued','running'].includes(String(current.status)))return current;
        const timestamp=new Date().toISOString();
        const claimed=isFloatTimelineExport(current)&&current.status==='queued'?claimFloatTimelineExport(current,timestamp):current;
        const next={...claimed,status:'failed',error:{code:'EXPORT_CANCELLED',message:'导出已取消',retryable:false},updatedAt:timestamp};
        store.put('exports',next);return next;
      });
      if(isCancelledExport(result))activities.get(store)?.get(input.exportId)?.abort();
      return result;
    },
    'export.activity.get':(raw:unknown)=>{
      const input=exportControlSchemas['export.activity.get'].parse(raw),record=read(input.projectId,input.exportId),activity=activities.get(store)?.get(input.exportId),cancelled=isCancelledExport(record);
      const stage=cancelled?'cancelled':record.status==='succeeded'?'complete':record.status==='failed'?'failed':activity?.stage??'queued';
      return exportActivitySchema.parse({...input,status:record.status,stage,progress:record.status==='succeeded'?100:record.status==='queued'?0:null,elapsedSeconds:Math.max(0,((['succeeded','failed'].includes(String(record.status))?Date.parse(String(record.updatedAt)):Date.now())-(activity?.started??Date.parse(String(record.createdAt))))/1000)||0,cancelled});
    },
    'export.output.get':async(raw:unknown)=>{
      const input=exportControlSchemas['export.output.get'].parse(raw),record=read(input.projectId,input.exportId);
      if(record.status!=='succeeded')throw new AppError('EXPORT_FILE_UNAVAILABLE','导出文件尚不可用',409);
      const output=readTimelineExportOutput(store.db,input,{isTimelineRenderRecord,readOwnedAsset:(projectId,assetId)=>readOwnedTimelineAsset(store.db,projectId,assetId)});
      if(record.mode==='timeline'&&!output)throw new AppError('EXPORT_FILE_UNAVAILABLE','导出回执无法核对',409);
      const asset=output?.asset??(typeof record.assetId==='string'?readOwnedTimelineAsset(store.db,input.projectId,record.assetId):null);
      if(!row(asset)||typeof asset.relativePath!=='string'||!new RegExp(`^media/export-${input.exportId}-[a-f0-9-]{36}\\.mp4$`,'u').test(asset.relativePath)||asset.mimeType!=='video/mp4'||asset.provenance!=='export'||typeof asset.sha256!=='string')throw new AppError('EXPORT_FILE_UNAVAILABLE','导出文件无法核对',409);
      const verified=await verifiedManagedHash(store.root,{relativePath:asset.relativePath,sha256:asset.sha256},{signal,maxBytes:8*1024**3,beforeEffect:checkpoint});
      if(asset.sizeBytes!==verified.sizeBytes||store.db.prepare("SELECT 1 FROM assets WHERE id<>? AND json_extract(data,'$.relativePath')=? LIMIT 1").get(String(asset.id),asset.relativePath)||read(input.projectId,input.exportId).assetId!==asset.id)throw new AppError('EXPORT_FILE_UNAVAILABLE','导出文件已变化',409);
      return exportOutputSchema.parse({...input,assetId:asset.id,fileLocation:verified.file,sizeBytes:verified.sizeBytes,sha256:verified.sha256,url:record.url});
    },
  }};
}
