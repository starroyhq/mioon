import {workspaceSettingsSchema,workspaceBackupStatusSchema,workspaceBackupRecordSchema} from '../../../packages/contracts/src/workspace-configuration.ts';
import type {WorkspaceSettings,WorkspaceSettingsUpdate} from '../../../packages/contracts/src/workspace-configuration.ts';

type Operation='workspace.settings.get'|'workspace.settings.set'|'workspace.backup.status'|'workspace.backup.create'|'workspace.backup.restore.stage';
export class WorkspaceSettingsError extends Error {readonly code:string;constructor(code:string){super('The workspace operation could not be confirmed.');this.code=code;}}
async function envelope(response:Response):Promise<unknown>{
  const reader=response.body?.getReader();if(!reader)throw new WorkspaceSettingsError('BACKEND_PROTOCOL_ERROR');
  const chunks:Uint8Array[]=[];let bytes=0;
  try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>256*1024)throw new WorkspaceSettingsError('BACKEND_PROTOCOL_ERROR');chunks.push(next.value);}}
  finally{reader.releaseLock();}
  const content=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){content.set(chunk,offset);offset+=chunk.byteLength;}
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(content));}catch{throw new WorkspaceSettingsError('BACKEND_PROTOCOL_ERROR');}
  if(!value||typeof value!=='object'||!('ok' in value))throw new WorkspaceSettingsError('BACKEND_PROTOCOL_ERROR');
  if(response.ok&&value.ok===true&&'data' in value)return value.data;
  const error='error' in value?value.error:null,code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)?error.code:'BACKEND_PROTOCOL_ERROR';
  throw new WorkspaceSettingsError(code);
}
async function call(operation:Operation,input:object={},signal?:AbortSignal):Promise<unknown>{
  try{return await envelope(await fetch('/api/rpc',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,input}),signal}));}
  catch(error){throw error instanceof WorkspaceSettingsError?error:new WorkspaceSettingsError('NETWORK');}
}
export const readWorkspaceSettings=async(signal?:AbortSignal)=>workspaceSettingsSchema.parse(await call('workspace.settings.get',{},signal));
export const saveWorkspaceSettings=async(input:WorkspaceSettingsUpdate)=>workspaceSettingsSchema.parse(await call('workspace.settings.set',input));
export const readWorkspaceBackupStatus=async(signal?:AbortSignal)=>workspaceBackupStatusSchema.parse(await call('workspace.backup.status',{},signal));
export const createLocalWorkspaceBackup=async(requestId:string)=>workspaceBackupRecordSchema.parse(await call('workspace.backup.create',{requestId}));
export const stageLocalWorkspaceRestore=async(backupId:string,requestId:string)=>call('workspace.backup.restore.stage',{backupId,requestId,confirmation:'RESTORE_BACKUP'});
export const workspaceBackupDownloadUrl=(id:string)=>`/api/workspace-backups/${encodeURIComponent(id)}/download`;
export async function importLocalWorkspaceBackup(file:File,requestId:string){
  try{return workspaceBackupRecordSchema.parse(await envelope(await fetch(`/api/workspace-backups/import?requestId=${encodeURIComponent(requestId)}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/vnd.mioon.workspace-backup'},body:file})));}
  catch(error){throw error instanceof WorkspaceSettingsError?error:new WorkspaceSettingsError('NETWORK');}
}
export interface WorkspaceBackupBridge {chooseLocation():Promise<WorkspaceSettings|null>;revealLocation():Promise<boolean>;restart?():Promise<void>}
export const workspaceBackupBridge=():WorkspaceBackupBridge|undefined=>(window as Window&{__mioonWorkspaceBackups?:WorkspaceBackupBridge}).__mioonWorkspaceBackups;
