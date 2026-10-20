import path from 'node:path';
import {AppError} from '@mioon/contracts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory} from '@mioon/contracts/private-storage';
import {workspaceSettingsUpdateSchema,type WorkspaceSettings,type WorkspaceSettingsUpdate} from '../../contracts/src/workspace-configuration.ts';
import {checkSeparate} from './workspace-backup-storage.ts';

const FILE='workspace-settings-v1.json',MAX_BYTES=16*1024;
interface StoredSettings {formatVersion:1;revision:number;liveGeneration:boolean;automaticBackup:boolean;backupIntervalHours:1|6|24|168;backupLocation:'default'|'selected';selectedDirectory?:string}
const failure=(code:string)=>new AppError(code,'Workspace settings could not be saved safely.',409);
export function createWorkspaceConfiguration({root,env=process.env}:{root:string;env?:NodeJS.ProcessEnv}) {
  root=path.resolve(root);validatePrivateDirectory(root);
  const file=path.join(root,FILE),defaultDirectory=path.join(path.dirname(root),`${path.basename(root)}-backups`);
  const read=():StoredSettings=>{
    const raw=readPrivateFile(file,{root,maxBytes:MAX_BYTES,allowMissing:true,encoding:'utf8'});
    if(raw===null)return {formatVersion:1,revision:0,liveGeneration:env.MIOON_ENABLE_LIVE_PROVIDER==='1',automaticBackup:false,backupIntervalHours:24,backupLocation:'default'};
    let value:unknown;try{value=JSON.parse(String(raw));}catch{throw failure('WORKSPACE_SETTINGS_INVALID');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw failure('WORKSPACE_SETTINGS_INVALID');
    const candidate=value as Record<string,unknown>;
    const parsed=workspaceSettingsUpdateSchema.safeParse({expectedRevision:candidate.revision,liveGeneration:candidate.liveGeneration,automaticBackup:candidate.automaticBackup,backupIntervalHours:candidate.backupIntervalHours,backupLocation:candidate.backupLocation});
    if(!parsed.success||candidate.formatVersion!==1||Object.keys(candidate).some(key=>!['formatVersion','revision','liveGeneration','automaticBackup','backupIntervalHours','backupLocation','selectedDirectory'].includes(key))||candidate.selectedDirectory!==undefined&&(typeof candidate.selectedDirectory!=='string'||!path.isAbsolute(candidate.selectedDirectory)||path.resolve(candidate.selectedDirectory)!==candidate.selectedDirectory))throw failure('WORKSPACE_SETTINGS_INVALID');
    if(candidate.backupLocation==='selected'&&typeof candidate.selectedDirectory!=='string')throw failure('WORKSPACE_SETTINGS_INVALID');
    return candidate as unknown as StoredSettings;
  };
  const publicValue=(value:StoredSettings):WorkspaceSettings=>({formatVersion:1,revision:value.revision,liveGeneration:value.liveGeneration,automaticBackup:value.automaticBackup,backupIntervalHours:value.backupIntervalHours,backupLocation:value.backupLocation,backupDirectory:value.backupLocation==='selected'?value.selectedDirectory!:defaultDirectory});
  const save=(value:StoredSettings)=>{writePrivateFileAtomic(file,JSON.stringify(value),{root,maxBytes:MAX_BYTES});return publicValue(value);};
  const get=()=>publicValue(read());
  const listeners=new Set<()=>void>();
  return {
    get,
    set(input:WorkspaceSettingsUpdate):WorkspaceSettings {
      const patch=workspaceSettingsUpdateSchema.parse(input),current=read();
      if(patch.expectedRevision!==current.revision)throw failure('WORKSPACE_SETTINGS_CONFLICT');
      if(patch.backupLocation==='selected'&&!current.selectedDirectory)throw failure('WORKSPACE_BACKUP_LOCATION_REQUIRED');
      const {expectedRevision:_,...changes}=patch,next={...current,...changes,revision:current.revision+1};
      const result=save(next);for(const listener of listeners)listener();return result;
    },
    // Trusted native composition only. Public RPC accepts a location choice,
    // never a filesystem path; the Electron picker must call this capability.
    setBackupDirectory(directory:string):WorkspaceSettings {
      if(!path.isAbsolute(directory)||path.resolve(directory)!==directory||directory.length>4096)throw failure('WORKSPACE_BACKUP_LOCATION_INVALID');
      validatePrivateDirectory(directory);checkSeparate(root,directory);
      const current=read(),result=save({...current,revision:current.revision+1,selectedDirectory:directory,backupLocation:'selected'});
      for(const listener of listeners)listener();return result;
    },
    liveEnabled:()=>get().liveGeneration,
    assertLiveEnabled():void {if(!get().liveGeneration)throw new AppError('LIVE_GENERATION_DISABLED','Live generation is disabled in workspace settings.',409);},
    environment():NodeJS.ProcessEnv {
      const copy={...env};Object.defineProperty(copy,'MIOON_ENABLE_LIVE_PROVIDER',{enumerable:true,configurable:false,get:()=>get().liveGeneration?'1':'0'});return copy;
    },
    subscribe(listener:()=>void):()=>void {listeners.add(listener);return()=>listeners.delete(listener);},
    root,
  };
}
export type WorkspaceConfiguration=ReturnType<typeof createWorkspaceConfiguration>;
