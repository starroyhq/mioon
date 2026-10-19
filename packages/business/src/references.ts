import {refuseRestoredOperation} from './workspace-restore-policy.ts';
import {randomUUID} from 'node:crypto';
import {AppError} from '@mioon/contracts';
import {createReferenceRecoveryBoundary,readReferenceReceipt,rejectReferenceMutation,invalidReference} from './reference-recovery.ts';
import type {DatabaseSync} from 'node:sqlite';

type RefRecord = Record<string, unknown>;
interface RefShotLike {[key: string]: unknown;id: string;projectId: string;referenceAssetIds: string[];revision: number}
interface RefEdgeLike {[key: string]: unknown;id: string;projectId: string;kind?: string;target?: string;source?: string;role?: string;sourceAssetId?: string}
interface ReferenceInput {
 [key: string]: unknown;
 projectId: string;requestId: string;
 sourceNodeId?: string;targetShotId?: string;edgeId?: string;role?: string;
 expectedSourceRevision: number;expectedShotRevision: number;
}
interface ReferenceStore {db: DatabaseSync;list: (table: string,projectId: string)=>RefEdgeLike[];put: (table: string,value: unknown)=>unknown;tx: <T>(callback: ()=>T)=>T}
interface ReferenceServiceOptions {check: (value: unknown,expectedRevision: number)=>void;hash: (value: unknown)=>string;now: ()=>string}
interface ReferenceState {receiptAbsent: boolean;writesStarted: boolean;transactionEntered: boolean;callbackFailed: boolean;callbackError?: unknown}
interface ReferenceBoundary {
 node(id: unknown): {id: string;type?: string;assetId?: string|null;revision: number};
 shot(id: unknown): RefShotLike;
 bindings(value: RefShotLike): RefEdgeLike[];
 managed(source: RefRecord): RefAssetLike;
 edge(id: unknown,options?: {optional?: boolean}): RefEdgeLike|null;
 project(): unknown;
 response(operation: string,value: unknown,options?: {historical?: boolean}): unknown;
 replay(operation: string,text: string): unknown;
 validateResponse(operation: string,value: unknown): unknown;
}
interface RefAssetLike {[key: string]: unknown;id: string;mimeType?: string;sha256?: string;relativePath?: string}

// A reference edge owns one existing managed image and one shot reference slot.
// It never evaluates a graph or copies prompts from other nodes. Keep the stable
// asset ID on the edge: node labels/positions may change without retargeting it.
export function createReferenceServices(store: ReferenceStore,{check,hash,now}: ReferenceServiceOptions) {
 const {db,list,put,tx}=store;
 const bindings=(shot: RefShotLike): RefEdgeLike[]=>list('edges',shot.projectId).filter((edge)=>edge.kind==='reference'&&edge.target===shot.id);
 const conflict=(code: string,message: string,details: Record<string,unknown>={}): never=>{throw new AppError(code,message,409,details);};
 function validateBinding(shot: RefShotLike,edge: RefEdgeLike): void {
  if(edge.role!=='first_frame'||shot.referenceAssetIds.length!==1||shot.referenceAssetIds[0]!==edge.sourceAssetId)
   conflict('REFERENCE_STATE_CONFLICT','首帧连线与镜头参考选择不一致，请先检查最新状态',{edgeId:edge.id,shotId:shot.id});
 }
 function snapshot(shot: RefShotLike): {edgeId: string;sourceNodeId: string;sourceAssetId: string;role: string}[] {
  const edges=bindings(shot);
  if(edges.length>1)conflict('REFERENCE_STATE_CONFLICT','镜头存在多个首帧连线，请先检查最新状态',{shotId:shot.id});
  return edges.map(edge=>{validateBinding(shot,edge);return {edgeId:edge.id,sourceNodeId:edge.source as string,sourceAssetId:edge.sourceAssetId as string,role:edge.role as string};});
 }
 function guardManualUpdate(shot: RefShotLike,referenceAssetIds: unknown): void {
  if(referenceAssetIds===undefined)return;
  const edges=bindings(shot);
  if(edges.length&&JSON.stringify(referenceAssetIds)!==JSON.stringify(shot.referenceAssetIds))
   conflict('REFERENCE_CONNECTED','此镜头的首帧由画布连线控制；请先断开首帧连线，再修改参考图',{shotId:shot.id,edgeIds:edges.map(edge=>edge.id)});
 }
 function mutation(operation: string,input: ReferenceInput,apply: (boundary: ReferenceBoundary)=>{response: RefRecord;save?: ()=>void}): RefRecord {
  refuseRestoredOperation(store as never,operation,input);
  const state: ReferenceState={receiptAbsent:false,writesStarted:false,transactionEntered:false,callbackFailed:false};
  const write=()=>{state.writesStarted=true;};
  try{return tx(()=>{
   state.transactionEntered=true;
   try{
    const requestHash=hash({operation,input}),previous=readReferenceReceipt(db,input);
    if(previous){
     if(previous.requestHash!==requestHash)conflict('IDEMPOTENCY_CONFLICT','同一参考连线请求 ID 已用于不同内容',{requestId:input.requestId});
     return createReferenceRecoveryBoundary(db,input).replay(operation,previous.response as string) as RefRecord;
    }
    state.receiptAbsent=true;
    refuseRestoredOperation(store as never,operation,input);
    const boundary=createReferenceRecoveryBoundary(db,input);boundary.project();
    const {response,save}=apply(boundary as unknown as ReferenceBoundary);
    boundary.validateResponse(operation,response);
    if(save){write();save();}
    createReferenceRecoveryBoundary(db,input).response(operation,response);
    write();
    db.prepare('INSERT INTO reference_requests(requestId,requestHash,response) VALUES(?,?,?)').run(input.requestId,requestHash,JSON.stringify(response));
    createReferenceRecoveryBoundary(db,input).response(operation,response);
    const saved=readReferenceReceipt(db,input);
    if(saved?.requestHash!==requestHash||saved.response!==JSON.stringify(response))invalidReference();
    return response;
   }catch(error){state.callbackFailed=true;state.callbackError=error;throw error;}
  });}catch(error){rejectReferenceMutation(db,operation,input,error,state);throw error;}
 }
 const advance=(shot: {revision: number}): void=>{if(shot.revision===Number.MAX_SAFE_INTEGER)throw new AppError('REFERENCE_REVISION_LIMIT','镜头版本已达到安全上限',409);};
 const handlers={
  'reference.attach':(input: ReferenceInput)=>mutation('reference.attach',input,boundary=>{
   const source=boundary.node(input.sourceNodeId),shot=boundary.shot(input.targetShotId),edges=boundary.bindings(shot);
   if(edges.length>1)conflict('REFERENCE_STATE_CONFLICT','镜头存在多个首帧连线，请先检查最新状态',{shotId:shot.id});
   if(edges.length)validateBinding(shot,edges[0]);
   check(source,input.expectedSourceRevision);check(shot,input.expectedShotRevision);
   if(source.type!=='image'||!source.assetId)throw new AppError('INVALID_REFERENCE_SOURCE','首帧连线只接受已导入的托管图片节点');
   const asset=boundary.managed(source as unknown as RefRecord);
   if(edges.length){
    if(edges.length===1&&edges[0].source===source.id&&edges[0].sourceAssetId===asset.id&&edges[0].role===input.role){validateBinding(shot,edges[0]);return {response:{edge:edges[0],shot}};}
    conflict('REFERENCE_CONNECTED','此镜头已有首帧连线；请先断开，再连接其他图片',{shotId:shot.id,edgeIds:edges.map(edge=>edge.id)});
   }
   if(shot.referenceAssetIds.length)conflict('REFERENCE_SELECTION_EXISTS','此镜头已有手选参考图；请明确清除并保存选择后，再连接首帧',{shotId:shot.id,referenceAssetIds:shot.referenceAssetIds});
   advance(shot);
   const edge={id:randomUUID(),projectId:input.projectId,source:source.id,target:shot.id,kind:'reference',role:input.role,sourceAssetId:asset.id,createdAt:now()};
   const updated={...shot,referenceAssetIds:[asset.id],revision:shot.revision+1,updatedAt:now()};
   return {response:{edge,shot:updated},save:()=>{put('edges',edge);put('shots',updated);}};
  }),
  'reference.detach':(input: ReferenceInput)=>mutation('reference.detach',input,boundary=>{
   const edge=boundary.edge(input.edgeId)!;
   if(edge.kind!=='reference'||edge.role!=='first_frame')throw new AppError('INVALID_REFERENCE_EDGE','这不是首帧参考连线；视觉连线请使用 edge.delete');
   const shot=boundary.shot(edge.target),edges=boundary.bindings(shot);
   validateBinding(shot,edge);
   if(edges.length!==1)conflict('REFERENCE_STATE_CONFLICT','镜头存在多个首帧连线，请先检查最新状态',{shotId:shot.id});
   check(shot,input.expectedShotRevision);
   advance(shot);
   const updated={...shot,referenceAssetIds:[],revision:shot.revision+1,updatedAt:now()};
   return {response:{edge:edge as RefRecord,shot:updated,detached:true},save:()=>{db.prepare('DELETE FROM edges WHERE id=?').run(edge!.id);put('shots',updated);}};
  }),
 };
 return {handlers,guardManualUpdate,snapshot};
}
