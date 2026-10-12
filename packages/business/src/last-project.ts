import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,fsyncSync,fstatSync} from 'node:fs';
import {isProxy} from 'node:util/types';
import path from 'node:path';
import {LAST_PROJECT_LIMITS,lastProjectPutSchema,lastProjectDiskSchema} from '@mioon/contracts/last-project';
import type {LastProjectEnvelope,LastProjectDisk,LastProjectPut} from '@mioon/contracts/last-project';
import type {LocalDraftStorage} from './local-drafts.ts';

export const LAST_PROJECT_FILENAME='last-project-v1.json';
const messages={
  LAST_PROJECT_VALIDATION:[400,'上次项目参数无效。'],
  LAST_PROJECT_CONFLICT:[409,'上次项目记录已变化。请重新读取后再选择。'],
  LAST_PROJECT_STALE_INSTANCE:[409,'本地服务已重新启动。请重新读取上次项目。'],
  LAST_PROJECT_SCOPE_MISMATCH:[409,'上次项目属于另一个工作区或渠道，已停止读取和写入。'],
  LAST_PROJECT_OWNER_REQUIRED:[403,'上次项目需要持有当前工作区锁。'],
  LAST_PROJECT_NOT_FOUND:[404,'所选项目不存在。'],
  LAST_PROJECT_LIMIT:[413,'上次项目请求超过大小限制。'],
  LAST_PROJECT_STORAGE_UNAVAILABLE:[503,'无法安全读取或保存上次项目，已有文件未被重置。'],
  LAST_PROJECT_SAVE_UNCERTAIN:[503,'上次项目可能已保存，但持久化确认未完成。请重新读取。'],
} as const;
type ErrorCode=keyof typeof messages;
export class LastProjectError extends Error{
  readonly code:ErrorCode;readonly status:number;
  constructor(code:ErrorCode){super(messages[code][1]);this.code=code;this.status=messages[code][0];}
}
function fail(code:ErrorCode):never{throw new LastProjectError(code);}
export function safeLastProjectError(error:unknown):{status:number;code:ErrorCode;message:string}{
  const safe=error instanceof LastProjectError?error:new LastProjectError('LAST_PROJECT_STORAGE_UNAVAILABLE');
  return {status:safe.status,code:safe.code,message:safe.message};
}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function input(value:unknown):LastProjectPut{
  // Do not run getters, proxy traps or toJSON on direct service calls.
  if(!object(value)||isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('LAST_PROJECT_VALIDATION');
  const keys=Reflect.ownKeys(value);
  if(keys.length!==4)fail('LAST_PROJECT_VALIDATION');
  for(const key of keys){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string'||!['workspaceScope','instanceId','expectedRevision','projectId'].includes(key)||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))fail('LAST_PROJECT_VALIDATION');
    if(typeof descriptor.value==='string'){if(descriptor.value.length>LAST_PROJECT_LIMITS.httpBytes)fail('LAST_PROJECT_LIMIT');}
    else if(typeof descriptor.value!=='number'||!Number.isFinite(descriptor.value))fail('LAST_PROJECT_VALIDATION');
  }
  const parsed=lastProjectPutSchema.safeParse(value);
  if(!parsed.success)fail('LAST_PROJECT_VALIDATION');
  if(Buffer.byteLength(JSON.stringify(parsed.data))>LAST_PROJECT_LIMITS.httpBytes)fail('LAST_PROJECT_LIMIT');
  return parsed.data;
}
interface ProjectDatabase{prepare(sql:string):{get(...params:string[]):unknown}}
/** One bounded primary-key lookup. It never calls an initializing project or
 * timeline reader, and never returns a project name or arbitrary JSON fields. */
export function readLastProjectTarget(db:ProjectDatabase,projectId:string):{id:string}|null{
  const row=db.prepare(`SELECT CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=36 THEN id END AS id,
    CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data
    FROM projects WHERE id=? LIMIT 1`).get(projectId);
  if(row===undefined||row===null)return null;
  if(!object(row)||row.id!==projectId||typeof row.data!=='string')fail('LAST_PROJECT_STORAGE_UNAVAILABLE');
  let project:unknown;try{project=JSON.parse(row.data);}catch{fail('LAST_PROJECT_STORAGE_UNAVAILABLE');}
  if(!object(project)||project.id!==projectId)fail('LAST_PROJECT_STORAGE_UNAVAILABLE');
  return {id:projectId};
}
export interface LastProjectGuards{ownsLock():boolean;isRestored():boolean;readProject(projectId:string):unknown}
export interface LastProjectOptions{
  root:string;channel?:'web'|'production'|'development';guards:LastProjectGuards;storage:LocalDraftStorage;signal?:AbortSignal;
  fault?:(point:'beforePersist'|'afterPersist'|'beforeDirectorySync'|'afterDirectorySync')=>void;
}
const unsupported={supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'} as const;
export function createLastProject({root,channel='web',guards,storage,signal,fault=()=>{}}:LastProjectOptions){
  if(!path.isAbsolute(root)||!['web','production','development'].includes(channel))fail('LAST_PROJECT_VALIDATION');
  const file=path.join(root,LAST_PROJECT_FILENAME),instanceId=randomUUID();let scope:string|undefined;
  function guarded<T>(fn:()=>T):T{try{return fn();}catch(error){if(error instanceof LastProjectError)throw error;fail('LAST_PROJECT_STORAGE_UNAVAILABLE');}}
  function checkpoint():void{if(signal?.aborted)fail('LAST_PROJECT_STORAGE_UNAVAILABLE');}
  function active():boolean{
    checkpoint();if(guards.isRestored())return false;
    if(!guards.ownsLock())fail('LAST_PROJECT_OWNER_REQUIRED');return true;
  }
  function owned():void{checkpoint();if(!guards.ownsLock())fail('LAST_PROJECT_OWNER_REQUIRED');}
  function identity():string{
    const directory=storage.validatePrivateDirectory(root),db=storage.validateManagedFile(path.join(root,'workbench.sqlite'),{root});
    if(!directory||!db)fail('LAST_PROJECT_STORAGE_UNAVAILABLE');
    // Keep exactly the existing local-draft identity: trusted build channel,
    // canonical private root identity and existing SQLite identity.
    const current=createHash('sha256').update(JSON.stringify([channel,path.resolve(root),String(directory.dev),String(directory.ino),String(db.dev),String(db.ino),db.birthtimeMs??null])).digest('hex');
    if(scope!==undefined&&scope!==current)fail('LAST_PROJECT_SCOPE_MISMATCH');scope=current;return current;
  }
  function read():LastProjectDisk|null{
    const workspaceScope=identity(),bytes=storage.readPrivateFile(file,{root,allowMissing:true,private:true,maxBytes:LAST_PROJECT_LIMITS.fileBytes});
    if(bytes===null)return null;
    if(!Buffer.isBuffer(bytes)||bytes.length>LAST_PROJECT_LIMITS.fileBytes)fail('LAST_PROJECT_STORAGE_UNAVAILABLE');
    let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('LAST_PROJECT_STORAGE_UNAVAILABLE');}
    const parsed=lastProjectDiskSchema.safeParse(value);if(!parsed.success)fail('LAST_PROJECT_STORAGE_UNAVAILABLE');
    if(parsed.data.workspaceScope!==workspaceScope)fail('LAST_PROJECT_SCOPE_MISMATCH');return parsed.data;
  }
  function target(projectId:string):boolean{
    const project=guards.readProject(projectId);if(project===null)return false;
    if(!object(project)||project.id!==projectId)fail('LAST_PROJECT_STORAGE_UNAVAILABLE');return true;
  }
  function response(disk:LastProjectDisk|null,matching?:boolean):LastProjectEnvelope{
    owned();const authority={supported:true as const,workspaceScope:identity(),instanceId};
    return disk?{...authority,revision:disk.revision,projectId:disk.projectId,updatedAt:disk.updatedAt,targetStatus:(matching??target(disk.projectId))?'matching':'missing'}:
      {...authority,revision:0,projectId:null,updatedAt:null,targetStatus:'unset'};
  }
  function writable(args:LastProjectPut):void{
    owned();if(args.workspaceScope!==identity())fail('LAST_PROJECT_SCOPE_MISMATCH');
    if(args.instanceId!==instanceId)fail('LAST_PROJECT_STALE_INSTANCE');
  }
  function confirmPublished():void{
    owned();identity();
    try{
      fault('beforeDirectorySync');owned();identity();
      const expected=storage.validatePrivateDirectory(root);if(!expected)fail('LAST_PROJECT_STORAGE_UNAVAILABLE');
      const fd=openSync(root,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const actual=fstatSync(fd);
        if(!actual.isDirectory()||actual.dev!==expected.dev||actual.ino!==expected.ino||actual.uid!==process.getuid?.()||(actual.mode&0o077))fail('LAST_PROJECT_STORAGE_UNAVAILABLE');
        fsyncSync(fd);
      }finally{closeSync(fd);}
      fault('afterDirectorySync');owned();identity();
    }catch{fail('LAST_PROJECT_SAVE_UNCERTAIN');}
  }
  function persist(disk:LastProjectDisk):void{
    owned();if(disk.workspaceScope!==identity())fail('LAST_PROJECT_SCOPE_MISMATCH');
    const contents=JSON.stringify(disk)+'\n';if(Buffer.byteLength(contents)>LAST_PROJECT_LIMITS.fileBytes)fail('LAST_PROJECT_LIMIT');
    fault('beforePersist');owned();if(disk.workspaceScope!==identity())fail('LAST_PROJECT_SCOPE_MISMATCH');
    let published=false;
    try{
      storage.writePrivateFileAtomic(file,contents,{root,private:true,maxBytes:LAST_PROJECT_LIMITS.fileBytes});published=true;
      fault('afterPersist');confirmPublished();
    }catch(error){if(published)fail('LAST_PROJECT_SAVE_UNCERTAIN');throw error;}
  }
  return {
    get():LastProjectEnvelope{return guarded(()=>{if(!active())return unsupported;return response(read());});},
    put(value:unknown):LastProjectEnvelope{return guarded(()=>{
      if(!active())return unsupported;const args=input(value);writable(args);
      const disk=read();if(!target(args.projectId))fail('LAST_PROJECT_NOT_FOUND');writable(args);
      // Only the immediately preceding exact write can replay. Ownership,
      // instance, workspace and existing target checks always precede replay.
      if(disk&&disk.revision===args.expectedRevision+1&&disk.projectId===args.projectId){confirmPublished();return response(disk,true);}
      if((disk?.revision??0)!==args.expectedRevision||args.expectedRevision===Number.MAX_SAFE_INTEGER)fail('LAST_PROJECT_CONFLICT');
      const next:LastProjectDisk={version:1,workspaceScope:args.workspaceScope,revision:args.expectedRevision+1,projectId:args.projectId,updatedAt:new Date().toISOString()};
      persist(next);return response(next,true);
    });},
  };
}
