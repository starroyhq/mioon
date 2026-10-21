import {randomUUID} from 'node:crypto';
import {calculateWorkspaceScope} from '@mioon/contracts/workspace-scope';
import {constants,openSync,closeSync,fsyncSync,fstatSync} from 'node:fs';
import {isProxy} from 'node:util/types';
import path from 'node:path';
import {LOCAL_DRAFT_LIMITS,clipDraftKeySchema,clipDraftSourceSchema,clipDraftWriteSchema,clipDraftDeleteSchema,clipDraftProjectSchema,clipDraftDiskSchema} from '@mioon/contracts/local-drafts';
import type {ClipDraftKey,ClipDraftSource,ClipDraftValue,ClipDraftEnvelope,ClipDraftList,ClipDraftSlot as Slot,ClipDraftDisk as Disk} from '@mioon/contracts/local-drafts';

export const LOCAL_DRAFT_FILENAME='local-drafts-v1.json';
const messages={
  LOCAL_DRAFT_VALIDATION:[400,'本地草稿参数无效。'],
  LOCAL_DRAFT_CONFLICT:[409,'草稿或编辑对象已变化。请重新查看，原草稿仍保留。'],
  LOCAL_DRAFT_STALE_INSTANCE:[409,'本地服务已重新启动。请重新读取草稿，不能继续使用旧窗口请求。'],
  LOCAL_DRAFT_SCOPE_MISMATCH:[409,'草稿属于另一个工作区或渠道，已停止读取和写入。'],
  LOCAL_DRAFT_OWNER_REQUIRED:[403,'本地草稿需要持有当前工作区锁。'],
  LOCAL_DRAFT_NOT_FOUND:[404,'草稿所属项目或编辑对象不存在。'],
  LOCAL_DRAFT_LIMIT:[413,'本地草稿超过字段或大小限制。'],
  LOCAL_DRAFT_CAPACITY:[507,'本地草稿容量已满，已有草稿保持不变。'],
  LOCAL_DRAFT_STORAGE_UNAVAILABLE:[503,'无法安全读取或保存本地草稿，已有文件未被重置。'],
  LOCAL_DRAFT_SAVE_UNCERTAIN:[503,'草稿可能已写入，但持久化确认未完成。请重新读取原草稿。'],
} as const;
type ErrorCode=keyof typeof messages;
export class LocalDraftError extends Error {
  readonly code:ErrorCode; readonly status:number;
  constructor(code:ErrorCode){super(messages[code][1]);this.code=code;this.status=messages[code][0];}
}
function fail(code:ErrorCode):never{throw new LocalDraftError(code);}
export function safeLocalDraftError(error:unknown):{status:number;code:ErrorCode;message:string}{
  const safe=error instanceof LocalDraftError?error:new LocalDraftError('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
  return {status:safe.status,code:safe.code,message:safe.message};
}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const same=(left:unknown,right:unknown):boolean=>canonical(left)===canonical(right);
function plain(value:unknown,depth=0,budget={nodes:0},fieldPath:string[]=[]):void{
  if(++budget.nodes>128||depth>8)fail('LOCAL_DRAFT_VALIDATION');
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value))fail('LOCAL_DRAFT_VALIDATION');return;}
  if(typeof value==='string'){if(value.length>8192)fail('LOCAL_DRAFT_LIMIT');return;}
  if(value!==null&&typeof value==='object'&&isProxy(value))fail('LOCAL_DRAFT_VALIDATION');
  // Arrays are admitted only at the typed raw envelope points path, not in
  // arbitrary request objects. Inspect descriptors before touching any value.
  if(Array.isArray(value)){
    if((fieldPath.length!==3||fieldPath[0]!=='raw'||fieldPath[1]!=='volumeEnvelope'||fieldPath[2]!=='points')||Object.getPrototypeOf(value)!==Array.prototype)fail('LOCAL_DRAFT_VALIDATION');
    const length=Object.getOwnPropertyDescriptor(value,'length');
    if(!length||!Object.hasOwn(length,'value')||!Number.isInteger(length.value)||length.value<0||length.value>16)fail('LOCAL_DRAFT_VALIDATION');
    const keys=Reflect.ownKeys(value);
    if(keys.length!==length.value+1)fail('LOCAL_DRAFT_VALIDATION');
    for(let index=0;index<length.value;index++){
      const entry=Object.getOwnPropertyDescriptor(value,String(index));
      if(!entry?.enumerable||!Object.hasOwn(entry,'value'))fail('LOCAL_DRAFT_VALIDATION');
      plain(entry.value,depth+1,budget,[...fieldPath,String(index)]);
    }
    return;
  }
  if(!object(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('LOCAL_DRAFT_VALIDATION');
  for(const key of Reflect.ownKeys(value)){
    const entry=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string'||key==='__proto__'||!entry?.enumerable||!Object.hasOwn(entry,'value'))fail('LOCAL_DRAFT_VALIDATION');
    plain(entry.value,depth+1,budget,[...fieldPath,key]);
  }
}
function parsed<T>(schema:{safeParse(input:unknown):{success:true;data:T}|{success:false}},input:unknown):T{plain(input);const result=schema.safeParse(input);if(!result.success)fail('LOCAL_DRAFT_VALIDATION');return result.data;}
type Identity={dev:number|bigint;ino:number|bigint;birthtimeMs?:number};
interface PrivateOptions{root?:string;allowMissing?:boolean;private?:boolean;maxBytes?:number;encoding?:BufferEncoding;replace?:boolean}
export interface LocalDraftStorage {
  validatePrivateDirectory(directory:string,options?:{allowMissing?:boolean}):Identity|null|undefined;
  validateManagedFile(file:string,options:PrivateOptions):Identity|null|undefined;
  readPrivateFile(file:string,options:PrivateOptions):unknown;
  writePrivateFileAtomic(file:string,bytes:string,options:PrivateOptions):unknown;
}
export interface LocalDraftGuards {
  ownsLock():boolean;
  isRestored():boolean;
  /** Existing bounded owned graph, never timeline.get's initializing path. */
  readTimeline(projectId:string):unknown;
  readClipAsset(projectId:string,clip:Record<string,unknown>):unknown;
}
export interface LocalDraftOptions {
  root:string;channel?:'web'|'production'|'development';guards:LocalDraftGuards;storage:LocalDraftStorage;
  signal?:AbortSignal;fault?:(point:'beforePersist'|'afterPersist'|'beforeDirectorySync'|'afterDirectorySync')=>void;
}
const unsupported={supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'} as const;

/** One private companion envelope, serialized by synchronous owned-backend
 * calls. There is no main DB migration, provider, domain write or task method. */
export function createLocalDrafts({root,channel='web',guards,storage,signal,fault=()=>{}}:LocalDraftOptions){
  if(!path.isAbsolute(root)||!['web','production','development'].includes(channel))fail('LOCAL_DRAFT_VALIDATION');
  const file=path.join(root,LOCAL_DRAFT_FILENAME),instanceId=randomUUID();
  let scope:string|undefined;
  function guarded<T>(fn:()=>T):T{try{return fn();}catch(error){if(error instanceof LocalDraftError)throw error;throw new LocalDraftError('LOCAL_DRAFT_STORAGE_UNAVAILABLE');}}
  function active():boolean{
    // The legacy draft ACK still requires POSIX directory-descriptor fsync.
    // Refuse before reads/persistence; v2 SQLite editing leases are separate.
    if(process.platform==='win32')fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
    if(signal?.aborted)fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
    if(guards.isRestored())return false;
    if(!guards.ownsLock())fail('LOCAL_DRAFT_OWNER_REQUIRED');
    return true;
  }
  function owned():void{if(!active())fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');}
  function identity():string{
    const directory=storage.validatePrivateDirectory(root),db=storage.validateManagedFile(path.join(root,'workbench.sqlite'),{root});
    if(!directory||!db)fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
    const current=calculateWorkspaceScope({channel,root,directory,db});
    if(scope!==undefined&&scope!==current)fail('LOCAL_DRAFT_SCOPE_MISMATCH');
    scope=current;return current;
  }
  function checkpoint():string{
    owned();const current=identity();owned();return current;
  }
  function read():Disk{
    const workspaceScope=identity(),contents=storage.readPrivateFile(file,{root,allowMissing:true,private:true,maxBytes:LOCAL_DRAFT_LIMITS.envelopeBytes});
    if(contents===null)return {version:1,workspaceScope,entries:[]};
    if(!Buffer.isBuffer(contents)||contents.length>LOCAL_DRAFT_LIMITS.envelopeBytes)fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
    let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(contents));}catch{fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');}
    const result=clipDraftDiskSchema.safeParse(value);if(!result.success)fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
    const disk=result.data;if(disk.workspaceScope!==workspaceScope)fail('LOCAL_DRAFT_SCOPE_MISMATCH');
    const keys=new Set<string>();
    for(const row of disk.entries){const key=keyOf(row);if(keys.has(key)||Buffer.byteLength(JSON.stringify(row))>LOCAL_DRAFT_LIMITS.rowBytes)fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');keys.add(key);}
    return disk;
  }
  const keyOf=(key:ClipDraftKey):string=>JSON.stringify([key.projectId,key.timelineId,key.clipId]);
  const keyOnly=(key:ClipDraftKey):ClipDraftKey=>({projectId:key.projectId,timelineId:key.timelineId,clipId:key.clipId});
  function timeline(projectId:string):Record<string,unknown>|null{
    const value=guards.readTimeline(projectId);
    if(value===null)return null;
    if(!object(value)||value.projectId!==projectId||typeof value.id!=='string'||!Number.isSafeInteger(value.revision)||!Array.isArray(value.clips))fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
    return value;
  }
  function source(projectId:string,clip:Record<string,unknown>):ClipDraftSource{
    const asset=guards.readClipAsset(projectId,clip);
    if(!object(asset)||asset.id!==clip.assetId||asset.projectId!==projectId)fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
    const parsed=clipDraftSourceSchema.safeParse({assetId:clip.assetId,assetSha256:asset.sha256,
      ...Object.fromEntries(['versionId','shotId','jobId'].filter(key=>Object.hasOwn(clip,key)).map(key=>[key,clip[key]]))});
    if(!parsed.success)fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');return parsed.data;
  }
  function status(key:ClipDraftKey,draft:Pick<ClipDraftValue,'baseRevision'|'source'>|null,current:Record<string,unknown>|null):'matching'|'changed'|'missing'{
    if(!current||current.id!==key.timelineId)return 'missing';
    const clip=(current.clips as unknown[]).find(value=>object(value)&&value.id===key.clipId);
    if(!object(clip))return 'missing';
    const actual=source(key.projectId,clip);
    return draft&&(current.revision!==draft.baseRevision||!same(actual,draft.source))?'changed':'matching';
  }
  function historical(row:Slot|undefined):void{
    if(!row?.draft)return;
    const {assetSha256,...clipSource}=row.draft.source;
    const actual=source(row.projectId,clipSource);
    if(actual.assetSha256!==assetSha256||!same(actual,row.draft.source))fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
  }
  function response(key:ClipDraftKey,row:Slot|undefined,current:Record<string,unknown>|null):ClipDraftEnvelope{
    historical(row);
    return {supported:true,workspaceScope:identity(),instanceId,key:keyOnly(key),revision:row?.revision??0,draft:row?.draft??null,targetStatus:status(key,row?.draft??null,current)};
  }
  function writable(input:{workspaceScope:string;instanceId:string}):void{
    if(!guards.ownsLock())fail('LOCAL_DRAFT_OWNER_REQUIRED');
    if(input.workspaceScope!==identity())fail('LOCAL_DRAFT_SCOPE_MISMATCH');
    if(input.instanceId!==instanceId)fail('LOCAL_DRAFT_STALE_INSTANCE');
  }
  function confirmPublished():void{
    try{
      checkpoint();fault('beforeDirectorySync');checkpoint();
      const expected=storage.validatePrivateDirectory(root);if(!expected)fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
      const fd=openSync(root,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const actual=fstatSync(fd);
        if(!actual.isDirectory()||actual.dev!==expected.dev||actual.ino!==expected.ino||actual.uid!==process.getuid?.()||(actual.mode&0o077))fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
        checkpoint();fsyncSync(fd);
      }finally{closeSync(fd);}
      fault('afterDirectorySync');checkpoint();
    }catch{fail('LOCAL_DRAFT_SAVE_UNCERTAIN');}
  }
  // Both fresh publication and recognized exact replay need a complete saved
  // ACK. A response-read failure cannot retroactively prove the write absent.
  function savedResponse(key:ClipDraftKey,row:Slot,current:Record<string,unknown>|null):ClipDraftEnvelope{
    try{
      confirmPublished();const result=response(key,row,current);checkpoint();return result;
    }catch{fail('LOCAL_DRAFT_SAVE_UNCERTAIN');}
  }
  function persist(disk:Disk):void{
    if(disk.workspaceScope!==checkpoint())fail('LOCAL_DRAFT_SCOPE_MISMATCH');
    const contents=JSON.stringify(disk)+'\n';
    if(disk.entries.length>LOCAL_DRAFT_LIMITS.slots||Buffer.byteLength(contents)>LOCAL_DRAFT_LIMITS.envelopeBytes)fail('LOCAL_DRAFT_CAPACITY');
    fault('beforePersist');
    if(disk.workspaceScope!==checkpoint())fail('LOCAL_DRAFT_SCOPE_MISMATCH');
    let published=false;
    try{
      storage.writePrivateFileAtomic(file,contents,{root,private:true,maxBytes:LOCAL_DRAFT_LIMITS.envelopeBytes});published=true;
      fault('afterPersist');
      // The atomic helper's parent sync is best effort. savedResponse performs
      // the mandatory directory/ownership checkpoint before returning an ACK.
    }catch(error){if(published)fail('LOCAL_DRAFT_SAVE_UNCERTAIN');throw error;}
  }
  return {
    assertProjectDeletable(projectId:string):void{guarded(()=>{owned();parsed(clipDraftProjectSchema,{projectId});read();});},
    removeProject(projectId:string):void{guarded(()=>{owned();parsed(clipDraftProjectSchema,{projectId});const disk=read(),entries=disk.entries.filter(row=>row.projectId!==projectId);if(entries.length===disk.entries.length)return;persist({...disk,entries});confirmPublished();});},
    get(input:unknown):ClipDraftEnvelope{return guarded(()=>{
      if(!active())return unsupported;const key=parsed(clipDraftKeySchema,input),current=timeline(key.projectId),disk=read();
      return response(key,disk.entries.find(row=>keyOf(row)===keyOf(key)),current);
    });},
    list(input:unknown):ClipDraftList{return guarded(()=>{
      if(!active())return unsupported;const {projectId}=parsed(clipDraftProjectSchema,input),current=timeline(projectId),disk=read();
      return {supported:true,workspaceScope:identity(),instanceId,projectId,limit:128,items:disk.entries.filter(row=>row.projectId===projectId&&row.draft!==null).map(row=>{historical(row);return {key:keyOnly(row),name:row.draft!.raw.name,baseRevision:row.draft!.baseRevision,updatedAt:row.draft!.updatedAt,targetStatus:status(row,row.draft,current)};})};
    });},
    put(input:unknown):ClipDraftEnvelope{return guarded(()=>{
      if(!active())return unsupported;const args=parsed(clipDraftWriteSchema,input);writable(args);
      const current=timeline(args.projectId),disk=read(),index=disk.entries.findIndex(row=>keyOf(row)===keyOf(args)),previous=disk.entries[index];
      historical(previous);
      const value={baseRevision:args.baseRevision,source:args.source,raw:args.raw};
      if(previous&&previous.revision===args.expectedRevision+1&&previous.draft&&same(value,{baseRevision:previous.draft.baseRevision,source:previous.draft.source,raw:previous.draft.raw}))return savedResponse(args,previous,current);
      if((previous?.revision??0)!==args.expectedRevision||args.expectedRevision===Number.MAX_SAFE_INTEGER)fail('LOCAL_DRAFT_CONFLICT');
      if(previous?.draft){if(previous.draft.baseRevision!==args.baseRevision||!same(previous.draft.source,args.source))fail('LOCAL_DRAFT_CONFLICT');}
      else if(status(args,value,current)!=='matching')fail('LOCAL_DRAFT_CONFLICT');
      const row:Slot={...keyOnly(args),revision:args.expectedRevision+1,draft:{...value,updatedAt:new Date().toISOString()}};
      if(Buffer.byteLength(JSON.stringify(row))>LOCAL_DRAFT_LIMITS.rowBytes)fail('LOCAL_DRAFT_LIMIT');
      if(index<0)disk.entries.push(row);else disk.entries[index]=row;
      // Only a successful explicit envelope-bearing PUT promotes the complete
      // companion, including null. Reads and legacy writes never migrate it.
      const next:Disk=Object.hasOwn(args.raw,'volumeEnvelope')?{...disk,version:2}:disk;
      persist(next);return savedResponse(args,row,current);
    });},
    discard(input:unknown):ClipDraftEnvelope{return guarded(()=>{
      if(!active())return unsupported;const args=parsed(clipDraftDeleteSchema,input);writable(args);
      const current=timeline(args.projectId),disk=read(),index=disk.entries.findIndex(row=>keyOf(row)===keyOf(args)),previous=disk.entries[index];
      historical(previous);
      if(previous&&previous.revision===args.expectedRevision+1&&previous.draft===null)return savedResponse(args,previous,current);
      if(!previous||previous.draft===null||previous.revision!==args.expectedRevision||args.expectedRevision===Number.MAX_SAFE_INTEGER)fail('LOCAL_DRAFT_CONFLICT');
      const row:Slot={...keyOnly(args),revision:previous.revision+1,draft:null};disk.entries[index]=row;
      persist(disk);return savedResponse(args,row,current);
    });},
  };
}
