import {isFrameRequestResponse,isFrameTaskResponse,isImageRequestResponse,isImageTaskResponse} from '@mioon/contracts';
import type {FrameTaskResponse,ImageTaskResponse} from '@mioon/contracts';

const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
export interface AgentTaskRecoveryIntent {projectId:string;taskId:string;key:string;current:()=>boolean}
export interface AgentTaskRecoveryLocation {kind:'image'|'frame';identity:'task'|'request';id:string}
export type AgentTaskRecoveryRecord={kind:'image';task:ImageTaskResponse}|{kind:'frame';task:FrameTaskResponse};
export function parseAgentTaskRecoveryLocation(value:unknown):AgentTaskRecoveryLocation|null {
  if(typeof value!=='string')return null;
  const match=/^(image|frame)(-request)?:([a-f\d-]+)$/iu.exec(value);
  return match&&uuid.test(match[3]!)?{kind:match[1]!.toLowerCase() as 'image'|'frame',identity:match[2]?'request':'task',id:match[3]!}:null;
}
/** Resolves an existing local record only. A missing receipt is never evidence
 * that it is safe to submit again. Navigation remains fenced by the caller. */
export async function resolveAgentTaskRecoveryLocation(location:AgentTaskRecoveryLocation,projectId:string,read:(operation:string,input:Record<string,unknown>)=>Promise<unknown>,current:()=>boolean):Promise<AgentTaskRecoveryRecord|null> {
  if(!['image','frame'].includes(location.kind)||!['task','request'].includes(location.identity)||!uuid.test(projectId)||!uuid.test(location.id)||!current())return null;
  let taskId=location.id,originalRequest:string|undefined;
  if(location.identity==='request'){
    const receipt=await read(`${location.kind}.request.get`,{projectId,requestId:location.id});if(!current())return null;
    const valid=location.kind==='image'?isImageRequestResponse(receipt):isFrameRequestResponse(receipt);
    if(!valid||!receipt)return null;
    const value=receipt as {projectId:string;requestId:string;operation:string;response:{id:string;projectId:string;requestId:string}};
    if(value.projectId!==projectId||value.requestId!==location.id||value.operation!==(location.kind==='image'?'image.generate':'frame.extract')||value.response.projectId!==projectId||value.response.requestId!==location.id)return null;
    taskId=value.response.id;originalRequest=location.id;
  }
  if(!uuid.test(taskId)||!current())return null;
  const task=await read(`${location.kind}.task.get`,{projectId,taskId});if(!current())return null;
  if(location.kind==='image'&&isImageTaskResponse(task)&&task.projectId===projectId&&task.id===taskId&&(!originalRequest||task.requestId===originalRequest))return {kind:'image',task};
  if(location.kind==='frame'&&isFrameTaskResponse(task)&&task.projectId===projectId&&task.id===taskId&&(!originalRequest||task.requestId===originalRequest))return {kind:'frame',task};
  return null;
}
