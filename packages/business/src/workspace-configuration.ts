import path from 'node:path';
import {AppError} from '@mioon/contracts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory} from '@mioon/contracts/private-storage';
import {workspaceSettingsSchema,workspaceSettingsUpdateSchema,type WorkspaceSettings,type WorkspaceSettingsUpdate} from '../../contracts/src/workspace-configuration.ts';
import type {AppDocumentStore} from './app-db/stores.ts';

const FILE='workspace-settings-v1.json',MAX_BYTES=16*1024;
const RETIRED_KEYS=new Set(['liveGeneration','automaticBackup','backupIntervalHours','backupLocation','backupDirectory','selectedDirectory']);
const CURRENT_KEYS=new Set(['formatVersion','revision']);
const failure=(code:string)=>new AppError(code,'Workspace settings could not be saved safely.',409);
export function createWorkspaceConfiguration({root,env=process.env,documents}:{root:string;env?:NodeJS.ProcessEnv;documents?:Pick<AppDocumentStore,'read'|'write'>}) {
  root=path.resolve(root);validatePrivateDirectory(root);
  const file=path.join(root,FILE);
  const read=():WorkspaceSettings=>{
    const raw=documents?documents.read(FILE):readPrivateFile(file,{root,maxBytes:MAX_BYTES,allowMissing:true,encoding:'utf8'});
    if(raw===null)return {formatVersion:1,revision:0,liveGeneration:true};
    if(Buffer.byteLength(String(raw))>MAX_BYTES)throw failure('WORKSPACE_SETTINGS_INVALID');
    let value:unknown;try{value=JSON.parse(String(raw));}catch{throw failure('WORKSPACE_SETTINGS_INVALID');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw failure('WORKSPACE_SETTINGS_INVALID');
    const candidate=value as Record<string,unknown>;
    if(Object.keys(candidate).some(key=>!CURRENT_KEYS.has(key)&&!RETIRED_KEYS.has(key)))throw failure('WORKSPACE_SETTINGS_INVALID');
    // Older documents can contain the retired backup settings and live flag.
    // Keep the legacy RPC response shape while discarding those values.
    const parsed=workspaceSettingsSchema.safeParse({formatVersion:candidate.formatVersion,revision:candidate.revision,liveGeneration:true});
    if(!parsed.success)throw failure('WORKSPACE_SETTINGS_INVALID');
    return parsed.data;
  };
  const save=(value:Omit<WorkspaceSettings,'liveGeneration'>)=>{const text=JSON.stringify(value);if(documents)documents.write(FILE,text);else writePrivateFileAtomic(file,text,{root,maxBytes:MAX_BYTES});return value;};
  const get=()=>read();
  const listeners=new Set<()=>void>();
  return {
    get,
    set(input:WorkspaceSettingsUpdate):WorkspaceSettings {
      const patch=workspaceSettingsUpdateSchema.parse(input),current=read();
      if(patch.expectedRevision!==current.revision)throw failure('WORKSPACE_SETTINGS_CONFLICT');
      const result=save({formatVersion:1,revision:current.revision+1});
      for(const listener of listeners)listener();return {...result,liveGeneration:true};
    },
    // Only the explicitly provisioned server-side video adapter opt-in is
    // inherited here. Settings-backed connections never consult it.
    environment:():NodeJS.ProcessEnv=>({...env}),
    subscribe(listener:()=>void):()=>void {listeners.add(listener);return()=>listeners.delete(listener);},
    root,
  };
}
export type WorkspaceConfiguration=ReturnType<typeof createWorkspaceConfiguration>;
