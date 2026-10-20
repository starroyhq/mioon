import {randomUUID} from 'node:crypto';
import {workspaceNativeUtilityReplySchema,workspaceNativeUtilityRequestSchema,type WorkspaceNativeUtilityRequest} from '../../../packages/contracts/src/workspace-native.ts';
import type {WorkspaceSettings} from '../../../packages/contracts/src/workspace-configuration.ts';
const unavailable=()=>Object.assign(new Error('Native workspace action is unavailable.'),{code:'WORKSPACE_NATIVE_UNAVAILABLE'});
export function createWorkspaceNativeBroker({send,isCurrent,timeoutMs=10000}:{send(message:WorkspaceNativeUtilityRequest):void;isCurrent():boolean;timeoutMs?:number}) {
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw unavailable();
 const pending=new Map<string,{resolve(value:WorkspaceSettings):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();let closed=false;
 return {
  setBackupDirectory(directory:string):Promise<WorkspaceSettings>{
   if(closed||!isCurrent()||pending.size>=4)return Promise.reject(unavailable());
   const request=workspaceNativeUtilityRequestSchema.parse({type:'workspace-native:setBackupDirectory',requestId:randomUUID(),directory});
   return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(request.requestId);reject(unavailable());},timeoutMs);pending.set(request.requestId,{resolve,reject,timer});try{send(request);}catch{clearTimeout(timer);pending.delete(request.requestId);reject(unavailable());}});
  },
  handle(raw:unknown):boolean {
   if(!raw||typeof raw!=='object'||!('type' in raw)||raw.type!=='workspace-native:reply')return false;
   const parsed=workspaceNativeUtilityReplySchema.safeParse(raw);if(!parsed.success||closed||!isCurrent())return true;
   const reply=parsed.data,entry=pending.get(reply.requestId);if(!entry)return true;clearTimeout(entry.timer);pending.delete(reply.requestId);if(reply.ok)entry.resolve(reply.settings);else entry.reject(unavailable());return true;
  },
  close():void {closed=true;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(unavailable());}pending.clear();},
 };
}
