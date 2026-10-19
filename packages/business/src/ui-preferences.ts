import {createHash} from 'node:crypto';
import {isProxy} from 'node:util/types';
import path from 'node:path';
import {calculateWorkspaceScope} from '../../contracts/src/workspace-scope.ts';
import {DEFAULT_UI_PREFERENCES,UI_PREFERENCES_LIMITS,uiPreferencesPutSchema,uiPreferencesDiskSchema,normalizeUiPreferences,uiPreferencesSchema,uiPreferencesProjectIdSchema,uiPreferencesOpenedAtSchema} from '../../contracts/src/ui-preferences.ts';
import type {UiPreferences,UiPreferencesResponse} from '../../contracts/src/ui-preferences.ts';
import type {LocalDraftStorage} from './local-drafts.ts';

export const UI_PREFERENCES_FILENAME='ui-preferences-v1.json';
const errors={
  UI_PREFERENCES_VALIDATION:[400,'界面偏好参数无效。'],
  UI_PREFERENCES_CONFLICT:[409,'界面偏好已被其他窗口更新，请重新读取。'],
  UI_PREFERENCES_SCOPE_MISMATCH:[409,'界面偏好属于不同工作区，已保留原文件。'],
  UI_PREFERENCES_UNAVAILABLE:[503,'无法安全读取或保存界面偏好。'],
  UI_PREFERENCES_READ_ONLY:[409,'当前工作区不支持保存界面偏好。'],
  UI_PREFERENCES_LIMIT:[507,'界面偏好记录容量已满。'],
} as const;
type Code=keyof typeof errors;
export class UiPreferencesError extends Error{
  readonly code:Code;readonly status:number;
  constructor(code:Code){super(errors[code][1]);this.code=code;this.status=errors[code][0];}
}
function fail(code:Code):never{throw new UiPreferencesError(code);}
interface Options{
  root:string;channel?:'web'|'production'|'development';storage:LocalDraftStorage;signal?:AbortSignal;
  guards:{ownsLock():boolean;isReadOnly():boolean;hasProject(projectId:string):boolean};now?:()=>string;
}
interface Disk{
  version:1;workspaceScope:string;revision:number;preferences:UiPreferences;recentOpened:Record<string,string>;
  lastWrite?:{requestId:string;digest:string};recoveredDefaults:boolean;
}
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
function plain(value:unknown,depth=0):void{
  if(depth>3)fail('UI_PREFERENCES_VALIDATION');
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number')return;
  if(!value||typeof value!=='object'||isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('UI_PREFERENCES_VALIDATION');
  const keys=Reflect.ownKeys(value);if(keys.length>10)fail('UI_PREFERENCES_VALIDATION');
  for(const key of keys){const field=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!field?.enumerable||!Object.hasOwn(field,'value'))fail('UI_PREFERENCES_VALIDATION');plain(field.value,depth+1);}
}

/** Synchronous private companion writes share the backend's workspace lock.
 * Global appearance never lives in a project's layout/CAS record. */
export function createUiPreferences({root,channel='web',storage,guards,signal,now=()=>new Date().toISOString()}:Options){
  if(!path.isAbsolute(root)||!['web','production','development'].includes(channel))fail('UI_PREFERENCES_VALIDATION');
  const file=path.join(root,UI_PREFERENCES_FILENAME);let establishedScope:string|undefined;
  function owned():void{if(signal?.aborted||!guards.ownsLock())fail('UI_PREFERENCES_UNAVAILABLE');}
  function scope():string{
    owned();const directory=storage.validatePrivateDirectory(root),db=storage.validateManagedFile(path.join(root,'workbench.sqlite'),{root});
    if(!directory||!db)fail('UI_PREFERENCES_UNAVAILABLE');
    const current=calculateWorkspaceScope({root,channel,directory,db});
    if(establishedScope!==undefined&&establishedScope!==current)fail('UI_PREFERENCES_SCOPE_MISMATCH');establishedScope=current;return current;
  }
  function safe<T>(fn:()=>T):T{try{return fn();}catch(error){if(error instanceof UiPreferencesError)throw error;throw new UiPreferencesError('UI_PREFERENCES_UNAVAILABLE');}}
  function read():Disk{
    const workspaceScope=scope(),empty:Disk={version:1,workspaceScope,revision:0,preferences:{...DEFAULT_UI_PREFERENCES},recentOpened:{},recoveredDefaults:false};
    const bytes=storage.readPrivateFile(file,{root,allowMissing:true,private:true,maxBytes:UI_PREFERENCES_LIMITS.fileBytes});
    if(bytes===null)return empty;
    if(!Buffer.isBuffer(bytes))fail('UI_PREFERENCES_UNAVAILABLE');
    let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return {...empty,recoveredDefaults:true};}
    if(value&&typeof value==='object'&&!Array.isArray(value)){
      const metadata=value as Record<string,unknown>;
      if(typeof metadata.workspaceScope==='string'&&metadata.workspaceScope!==workspaceScope)fail('UI_PREFERENCES_SCOPE_MISMATCH');
      if(metadata.version!==1)fail('UI_PREFERENCES_UNAVAILABLE');
    }
    const parsed=uiPreferencesDiskSchema.safeParse(value);
    if(!parsed.success)return {...empty,recoveredDefaults:true};
    if(parsed.data.workspaceScope!==workspaceScope)fail('UI_PREFERENCES_SCOPE_MISMATCH');
    const preferences=normalizeUiPreferences(parsed.data.preferences),recentOpened:Record<string,string>={};
    const raw=parsed.data.recentOpened;
    if(raw&&typeof raw==='object'&&!Array.isArray(raw)){
      const entries=Object.entries(raw);if(entries.length>UI_PREFERENCES_LIMITS.recentProjects)fail('UI_PREFERENCES_LIMIT');
      for(const [id,date] of entries)if(uiPreferencesProjectIdSchema.safeParse(id).success&&uiPreferencesOpenedAtSchema.safeParse(date).success)recentOpened[id]=date as string;
    }
    return {...parsed.data,preferences,recentOpened,recoveredDefaults:!uiPreferencesSchema.safeParse(parsed.data.preferences).success};
  }
  function response(disk:Disk):UiPreferencesResponse{return {revision:disk.revision,preferences:{...disk.preferences},recentOpened:{...disk.recentOpened},recoveredDefaults:disk.recoveredDefaults,writable:!guards.isReadOnly()};}
  function persist(disk:Disk):void{
    owned();if(guards.isReadOnly())fail('UI_PREFERENCES_READ_ONLY');if(disk.workspaceScope!==scope())fail('UI_PREFERENCES_SCOPE_MISMATCH');
    const {recoveredDefaults:_recovered,...saved}=disk,bytes=JSON.stringify(saved);
    if(Buffer.byteLength(bytes)>UI_PREFERENCES_LIMITS.fileBytes)fail('UI_PREFERENCES_LIMIT');
    storage.writePrivateFileAtomic(file,bytes,{root,private:true,maxBytes:UI_PREFERENCES_LIMITS.fileBytes});owned();scope();
  }
  return {
    get():UiPreferencesResponse{return safe(()=>response(read()));},
    put(value:unknown):UiPreferencesResponse{return safe(()=>{
      plain(value);const input=uiPreferencesPutSchema.safeParse(value);if(!input.success)fail('UI_PREFERENCES_VALIDATION');
      if(guards.isReadOnly())fail('UI_PREFERENCES_READ_ONLY');
      const disk=read(),digest=createHash('sha256').update(canonical(input.data)).digest('hex');
      if(disk.lastWrite?.requestId===input.data.requestId){if(disk.lastWrite.digest!==digest)fail('UI_PREFERENCES_CONFLICT');return response(disk);}
      if(input.data.expectedRevision!==disk.revision||disk.revision===Number.MAX_SAFE_INTEGER)fail('UI_PREFERENCES_CONFLICT');
      const next:Disk={...disk,revision:disk.revision+1,preferences:input.data.preferences,recoveredDefaults:false,lastWrite:{requestId:input.data.requestId,digest}};
      persist(next);return response(next);
    });},
    markOpened(projectId:unknown):void{safe(()=>{
      const parsed=uiPreferencesProjectIdSchema.safeParse(projectId);if(!parsed.success)fail('UI_PREFERENCES_VALIDATION');
      if(guards.isReadOnly())fail('UI_PREFERENCES_READ_ONLY');
      if(!guards.hasProject(parsed.data))fail('UI_PREFERENCES_VALIDATION');
      const disk=read();
      if(!Object.hasOwn(disk.recentOpened,parsed.data)&&Object.keys(disk.recentOpened).length>=UI_PREFERENCES_LIMITS.recentProjects)fail('UI_PREFERENCES_LIMIT');
      disk.recentOpened[parsed.data]=now();persist(disk);
    });},
    /** Backend project-deletion cleanup; no project lookup after DB removal. */
    removeProject(projectId:unknown):void{safe(()=>{
      const parsed=uiPreferencesProjectIdSchema.safeParse(projectId);if(!parsed.success)fail('UI_PREFERENCES_VALIDATION');
      const disk=read();if(!Object.hasOwn(disk.recentOpened,parsed.data))return;
      delete disk.recentOpened[parsed.data];persist(disk);
    });},
  };
}
