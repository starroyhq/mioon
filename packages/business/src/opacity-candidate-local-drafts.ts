/** Fixed candidate companions. Ordinary42 keeps v3; an independently admitted
 *43 application may persist only its current origin in a separate format. */
import {createRequire} from 'node:module';
import {randomUUID, createHash} from 'node:crypto';
import {constants, openSync, closeSync, fsyncSync, fstatSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import type {StatementSync} from 'node:sqlite';
import {isProxy,isPromise} from 'node:util/types';
import path from 'node:path';
import {calculateWorkspaceScope} from '../../contracts/src/workspace-scope.ts';
import type {WorkspaceStatIdentity} from '../../contracts/src/workspace-scope.ts';
import {LOCAL_DRAFT_LIMITS, clipDraftKeySchema, clipDraftSourceSchema, clipDraftDeleteSchema, clipDraftProjectSchema} from '../../contracts/src/local-drafts.ts';
import type {ClipDraftKey, ClipDraftSource, ClipDraftList as OrdinaryList} from '../../contracts/src/local-drafts.ts';
import {clipDraftOpacityCandidateWriteSchema, captureClipDraftOpacityCandidateDiskV3, captureClipDraftOpacityCandidateSlot} from '../../contracts/src/local-drafts-opacity-candidate.ts';
import type {ClipDraftOpacityCandidateSlot as Slot, ClipDraftOpacityCandidateDiskV3 as OrdinaryDisk, ClipDraftOpacityCandidateEnvelope as OrdinaryEnvelope, ClipDraftOpacityCandidateValue as Draft} from '../../contracts/src/local-drafts-opacity-candidate.ts';
import {OPACITY_RESTORED_DRAFT_PROFILE, clipDraftOpacityRestoredReadSchema, clipDraftOpacityRestoredProjectSchema,
  clipDraftOpacityRestoredWriteSchema, clipDraftOpacityRestoredDeleteSchema, captureClipDraftOpacityRestoredDisk} from '../../contracts/src/local-drafts-opacity-restored.ts';
import type {ClipDraftOpacityRestoredDisk as RestoredDisk, ClipDraftOpacityRestoredEnvelope as RestoredEnvelope,
  ClipDraftOpacityRestoredList as RestoredList} from '../../contracts/src/local-drafts-opacity-restored.ts';
import {LocalDraftError} from './local-drafts.ts';
import {getOpacityCandidateAssembly, isRestoredOpacityCandidateApplicationStore} from './opacity-candidate-store.ts';
import {createOpacityCandidateDomain} from './opacity-candidate-domain.ts';

export const OPACITY_CANDIDATE_LOCAL_DRAFT_FILENAME = 'local-drafts-v3.json';
export const OPACITY_RESTORED_LOCAL_DRAFT_FILENAME = 'local-drafts-restored43-v1.json';
export const OPACITY_CANDIDATE_DRAFT_REQUEST_LIMITS = Object.freeze({nodes:132, depth:8});
export const OPACITY_RESTORED_DRAFT_REQUEST_LIMITS = Object.freeze({nodes:134, depth:8});
type Disk = OrdinaryDisk | RestoredDisk;
type Envelope = OrdinaryEnvelope | RestoredEnvelope;
type ClipDraftList = OrdinaryList | RestoredList;
type Value = Record<string, unknown>;
type FaultPoint = 'beforePersist' | 'afterPersist' | 'beforeDirectorySync' | 'afterDirectorySync';
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const fail = (code: ConstructorParameters<typeof LocalDraftError>[0]): never => {throw new LocalDraftError(code);};
const require = createRequire(import.meta.url);
const storage: unknown = require('../../contracts/src/private-storage.mjs');
function privateCall(name: string, args: unknown[]): unknown {
  if (!object(storage) || typeof storage[name] !== 'function') return fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
  return Reflect.apply(storage[name], storage, args) as unknown;
}
function stat(value: unknown): WorkspaceStatIdentity {
  if (!object(value) || !['number', 'bigint'].includes(typeof value.dev) || !['number', 'bigint'].includes(typeof value.ino) || own(value, 'birthtimeMs') && typeof value.birthtimeMs !== 'number') return fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
  return value as unknown as WorkspaceStatIdentity;
}
function nativePrepare(db: DatabaseSync, sql: string): StatementSync {
  const value: unknown = Reflect.apply(DatabaseSync.prototype.prepare, db, [sql]);
  if (!value || typeof value !== 'object') return fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
  return value as StatementSync;
}
/** Full request capture. The maximal old-field132-node request retains both
 * exact typed arrays and all source provenance; nothing is silently trimmed. */
export function captureOpacityCandidateDraftRequest(value: unknown) {
  return captureDraftRequest(value, OPACITY_CANDIDATE_DRAFT_REQUEST_LIMITS.nodes);
}
/** Exactly two extra root identity leaves; ordinary42 retains its132 limit. */
export function captureOpacityRestoredDraftRequest(value: unknown) {
  return captureDraftRequest(value, OPACITY_RESTORED_DRAFT_REQUEST_LIMITS.nodes);
}
function captureDraftRequest(value: unknown, maxNodes: number) {
  let nodes=0, depth=0; const parents=new Set<object>();
  function visit(item: unknown, at: readonly string[]): unknown {
    if (++nodes>maxNodes || at.length>OPACITY_CANDIDATE_DRAFT_REQUEST_LIMITS.depth) fail('LOCAL_DRAFT_VALIDATION');
    depth=Math.max(depth, at.length);
    if (item===null || typeof item==='boolean') return item;
    if (typeof item==='number') {if (!Number.isFinite(item) || Object.is(item,-0)) fail('LOCAL_DRAFT_VALIDATION');return item;}
    if (typeof item==='string') {if (item.length>8192) fail('LOCAL_DRAFT_LIMIT');return item;}
    if (!item || typeof item!=='object' || isProxy(item) || parents.has(item)) return fail('LOCAL_DRAFT_VALIDATION');
    const array=Array.isArray(item), prototype: unknown=Object.getPrototypeOf(item);
    if (array ? prototype!==Array.prototype : prototype!==Object.prototype && prototype!==null) fail('LOCAL_DRAFT_VALIDATION');
    const keys=Reflect.ownKeys(item), descriptors=Object.getOwnPropertyDescriptors(item);parents.add(item);
    let result: unknown[] | Value;
    if (array) {
      const leaf=at.join('.'), limit=leaf==='raw.opacityEnvelope.points'?7:leaf==='raw.volumeEnvelope.points'?16:0;
      const length: unknown=descriptors.length?.value;
      if (typeof length!=='number' || !Number.isSafeInteger(length) || length<0 || length>limit || !limit || keys.length!==length+1) return fail('LOCAL_DRAFT_VALIDATION');
      result=[];
      for(let index=0;index<length;index++) {const descriptor=descriptors[index];if(!descriptor?.enumerable || !own(descriptor,'value')) fail('LOCAL_DRAFT_VALIDATION');result.push(visit(descriptor.value,[...at,String(index)]));}
    } else {
      result={};if(keys.length>64)fail('LOCAL_DRAFT_VALIDATION');
      for(const key of keys) {if(typeof key!=='string' || key==='__proto__')return fail('LOCAL_DRAFT_VALIDATION');const descriptor=descriptors[key];if(!descriptor?.enumerable || !own(descriptor,'value'))fail('LOCAL_DRAFT_VALIDATION');result[key]=visit(descriptor.value,[...at,key]);}
    }
    parents.delete(item);return result;
  }
  const captured=visit(value,[]), text=JSON.stringify(captured), bytes=Buffer.byteLength(text);
  if(bytes>LOCAL_DRAFT_LIMITS.httpBytes)fail('LOCAL_DRAFT_LIMIT');
  return {value:captured,nodes,depth,bytes};
}
const keyOf=(key:ClipDraftKey):string=>JSON.stringify([key.projectId,key.timelineId,key.clipId]);
const keyOnly=(key:ClipDraftKey):ClipDraftKey=>({projectId:key.projectId,timelineId:key.timelineId,clipId:key.clipId});
const unsupported=Object.freeze({supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'} as const);

type Options = {signal?:AbortSignal;fault?:(point:FaultPoint)=>void};
export function createOpacityCandidateLocalDrafts(store:unknown, options:Options={}) {
  return createCandidateLocalDrafts(store, options, false);
}
/** The fixed constructor is not selected by a request or a generic43 handle.
 * It never reads the source42 companion or the old43 unsupported endpoint. */
export function createRestoredOpacityCandidateLocalDrafts(store:unknown, options:Options={}) {
  if (!isRestoredOpacityCandidateApplicationStore(store)) return fail('LOCAL_DRAFT_OWNER_REQUIRED');
  return createCandidateLocalDrafts(store, options, true);
}
function createCandidateLocalDrafts(store:unknown, {signal,fault=()=>{}}:Options, restoredApplication:boolean) {
  const candidate=getOpacityCandidateAssembly(store);
  if(!candidate || !object(store) || typeof store.root!=='string' || !(store.db instanceof DatabaseSync) || typeof fault!=='function')return fail('LOCAL_DRAFT_OWNER_REQUIRED');
  const assembly=candidate, root=store.root, db=store.db, domain=createOpacityCandidateDomain(store);
  const restoredOrigin=restoredApplication?assembly.getRestoreContext()?.workspaceOrigin:undefined;
  if (restoredApplication && !restoredOrigin) return fail('LOCAL_DRAFT_OWNER_REQUIRED');
  const file=path.join(root,restoredApplication?OPACITY_RESTORED_LOCAL_DRAFT_FILENAME:OPACITY_CANDIDATE_LOCAL_DRAFT_FILENAME), instanceId=randomUUID();let scope:string|undefined;
  const wire=()=>({schemaVersion:1 as const,profileId:OPACITY_RESTORED_DRAFT_PROFILE,workspaceOrigin:restoredOrigin!});
  function parsed<T>(schema:{safeParse(value:unknown):{success:true;data:T}|{success:false}}, value:unknown):T {
    const captured=restoredApplication?captureOpacityRestoredDraftRequest(value):captureOpacityCandidateDraftRequest(value), result=schema.safeParse(captured.value);
    if(!result.success)return fail('LOCAL_DRAFT_VALIDATION');return result.data;
  }
  function origin(value:unknown):void {
    if(restoredApplication && (!object(value) || value.expectedWorkspaceOrigin!==restoredOrigin)) fail('LOCAL_DRAFT_SCOPE_MISMATCH');
  }
  function guarded<T>(fn:()=>T):T {try{return fn();}catch(error){if(error instanceof LocalDraftError)throw error;throw new LocalDraftError('LOCAL_DRAFT_STORAGE_UNAVAILABLE');}}
  function active():boolean {
    assembly.checkpoint();if(signal?.aborted)fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
    if(getOpacityCandidateAssembly(store)!==assembly || !assembly.ownsLock())fail('LOCAL_DRAFT_OWNER_REQUIRED');
    if(restoredApplication) {
      if(!isRestoredOpacityCandidateApplicationStore(store) || assembly.getRestoreContext()?.workspaceOrigin!==restoredOrigin) fail('LOCAL_DRAFT_OWNER_REQUIRED');
      return true;
    }
    return assembly.getRestoreContext()===null;
  }
  function identity():string {
    const directory=stat(privateCall('validatePrivateDirectory',[root])), database=stat(privateCall('validateManagedFile',[path.join(root,'workbench.sqlite'),{root}]));
    const base=calculateWorkspaceScope({channel:'web',root,directory,db:database});
    const current=restoredApplication?createHash('sha256').update(JSON.stringify([OPACITY_RESTORED_DRAFT_PROFILE,restoredOrigin,base])).digest('hex'):base;
    if(scope!==undefined && current!==scope)fail('LOCAL_DRAFT_SCOPE_MISMATCH');scope=current;return current;
  }
  function checkpoint():string {if(!active())fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');const current=identity();if(!active())fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');return current;}
  function read():Disk {
    const workspaceScope=checkpoint(), contents=privateCall('readPrivateFile',[file,{root,allowMissing:true,private:true,maxBytes:LOCAL_DRAFT_LIMITS.envelopeBytes}]);
    if(contents===null)return restoredApplication?{version:1,profileId:OPACITY_RESTORED_DRAFT_PROFILE,workspaceOrigin:restoredOrigin!,workspaceScope,entries:[]}:{version:3,workspaceScope,entries:[]};
    if(!Buffer.isBuffer(contents) || contents.length>LOCAL_DRAFT_LIMITS.envelopeBytes)return fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
    let decoded:unknown, text:string;
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(contents);decoded=JSON.parse(text);}catch{return fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');}
    const duplicate=nativePrepare(db,"SELECT EXISTS(SELECT 1 FROM json_tree(?) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1) AS duplicate").get(text);
    if(duplicate?.duplicate!==0)fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
    let disk:Disk;try{disk=restoredApplication?captureClipDraftOpacityRestoredDisk(decoded).disk:captureClipDraftOpacityCandidateDiskV3(decoded).disk;}catch{return fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');}
    if(restoredApplication && (!('workspaceOrigin' in disk) || disk.workspaceOrigin!==restoredOrigin))fail('LOCAL_DRAFT_SCOPE_MISMATCH');
    if(disk.workspaceScope!==workspaceScope)fail('LOCAL_DRAFT_SCOPE_MISMATCH');checkpoint();return disk;
  }
  function timeline(projectId:string):Value|null {
    const value=domain.boundary({projectId}).read({legacyMissingProject:true});if(value===null)return null;
    if(!object(value) || value.projectId!==projectId || !Array.isArray(value.clips))return fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');return value;
  }
  function source(projectId:string,clip:Value):ClipDraftSource {
    const asset=domain.boundary({projectId}).clipSource(clip);
    if(!object(asset) || asset.id!==clip.assetId || asset.projectId!==projectId)return fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
    const value=clipDraftSourceSchema.safeParse({assetId:clip.assetId,assetSha256:asset.sha256,...Object.fromEntries(['versionId','shotId','jobId'].filter(key=>own(clip,key)).map(key=>[key,clip[key]]))});
    if(!value.success)return fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');return value.data;
  }
  function historical(row:Slot|undefined):void {
    if(!row?.draft)return;const {assetSha256,...clipSource}=row.draft.source, actual=source(row.projectId,clipSource);
    if(actual.assetSha256!==assetSha256 || !same(actual,row.draft.source))fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
  }
  function status(key:ClipDraftKey,draft:Pick<Draft,'baseRevision'|'source'>|null,current:Value|null):'matching'|'changed'|'missing' {
    if(!current || current.id!==key.timelineId || !Array.isArray(current.clips))return 'missing';
    const clip:unknown=current.clips.find((value:unknown)=>object(value)&&value.id===key.clipId);if(!object(clip))return 'missing';
    const actual=source(key.projectId,clip);return draft && (current.revision!==draft.baseRevision || !same(actual,draft.source))?'changed':'matching';
  }
  function response(key:ClipDraftKey,row:Slot|undefined,current:Value|null):Envelope {
    historical(row);return {supported:true,...(restoredApplication?wire():{}),workspaceScope:checkpoint(),instanceId,key:keyOnly(key),revision:row?.revision??0,draft:row?.draft??null,targetStatus:status(key,row?.draft??null,current)};
  }
  function writable(value:{workspaceScope:string;instanceId:string}):void {
    origin(value);if(value.workspaceScope!==checkpoint())fail('LOCAL_DRAFT_SCOPE_MISMATCH');if(value.instanceId!==instanceId)fail('LOCAL_DRAFT_STALE_INSTANCE');
  }
  function inject(point:FaultPoint):void {const result:unknown=fault(point);if(result && (typeof result==='object' || typeof result==='function') && 'then' in result){if(isPromise(result))void result.catch(()=>{});fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');}}
  function confirmPublished():void {
    try{
      checkpoint();inject('beforeDirectorySync');checkpoint();const expected=stat(privateCall('validatePrivateDirectory',[root]));
      const fd=openSync(root,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{const actual=fstatSync(fd);if(!actual.isDirectory() || actual.dev!==expected.dev || actual.ino!==expected.ino || actual.uid!==process.getuid?.() || (actual.mode&0o077))fail('LOCAL_DRAFT_STORAGE_UNAVAILABLE');checkpoint();fsyncSync(fd);}finally{closeSync(fd);}
      inject('afterDirectorySync');checkpoint();
    }catch{return fail('LOCAL_DRAFT_SAVE_UNCERTAIN');}
  }
  function savedResponse(key:ClipDraftKey,row:Slot,current:Value|null):Envelope {
    try{confirmPublished();const result=response(key,row,current);checkpoint();return result;}catch{return fail('LOCAL_DRAFT_SAVE_UNCERTAIN');}
  }
  function persist(disk:Disk):void {
    if(disk.workspaceScope!==checkpoint())fail('LOCAL_DRAFT_SCOPE_MISMATCH');
    let text:string;try{text=restoredApplication?captureClipDraftOpacityRestoredDisk(disk).text:captureClipDraftOpacityCandidateDiskV3(disk).text;}catch{return fail('LOCAL_DRAFT_CAPACITY');}
    inject('beforePersist');if(disk.workspaceScope!==checkpoint())fail('LOCAL_DRAFT_SCOPE_MISMATCH');
    let published=false;
    try{privateCall('writePrivateFileAtomic',[file,text,{root,private:true,maxBytes:LOCAL_DRAFT_LIMITS.envelopeBytes}]);published=true;inject('afterPersist');}
    catch(error){if(published)fail('LOCAL_DRAFT_SAVE_UNCERTAIN');throw error;}
  }
  return Object.freeze({
    get(input:unknown):Envelope{return guarded(()=>{
      if(!active())return unsupported;const key=parsed(restoredApplication?clipDraftOpacityRestoredReadSchema:clipDraftKeySchema,input);origin(key);
      const current=timeline(key.projectId), disk=read();return response(key,disk.entries.find(row=>keyOf(row)===keyOf(key)),current);
    });},
    list(input:unknown):ClipDraftList{return guarded(()=>{
      if(!active())return unsupported;const args=parsed(restoredApplication?clipDraftOpacityRestoredProjectSchema:clipDraftProjectSchema,input);origin(args);
      const {projectId}=args, current=timeline(projectId), disk=read();
      return {supported:true,...(restoredApplication?wire():{}),workspaceScope:checkpoint(),instanceId,projectId,limit:128,items:disk.entries.filter(row=>row.projectId===projectId && row.draft!==null).map(row=>{historical(row);return {key:keyOnly(row),name:row.draft!.raw.name,baseRevision:row.draft!.baseRevision,updatedAt:row.draft!.updatedAt,targetStatus:status(row,row.draft,current)};})};
    });},
    put(input:unknown):Envelope{return guarded(()=>{
      if(!active())return unsupported;const args=parsed(restoredApplication?clipDraftOpacityRestoredWriteSchema:clipDraftOpacityCandidateWriteSchema,input);writable(args);
      const current=timeline(args.projectId), disk=read(), index=disk.entries.findIndex(row=>keyOf(row)===keyOf(args)), previous=disk.entries[index];historical(previous);
      const value={baseRevision:args.baseRevision,source:args.source,raw:args.raw};
      if(previous && previous.revision===args.expectedRevision+1 && previous.draft && same(value,{baseRevision:previous.draft.baseRevision,source:previous.draft.source,raw:previous.draft.raw}))return savedResponse(args,previous,current);
      if((previous?.revision??0)!==args.expectedRevision || args.expectedRevision===Number.MAX_SAFE_INTEGER)fail('LOCAL_DRAFT_CONFLICT');
      if(previous?.draft){if(previous.draft.baseRevision!==args.baseRevision || !same(previous.draft.source,args.source))fail('LOCAL_DRAFT_CONFLICT');}
      else if(status(args,value,current)!=='matching')fail('LOCAL_DRAFT_CONFLICT');
      const row:Slot={...keyOnly(args),revision:args.expectedRevision+1,draft:{...value,updatedAt:new Date().toISOString()}};
      try{captureClipDraftOpacityCandidateSlot(row);}catch{return fail('LOCAL_DRAFT_LIMIT');}
      if(index<0)disk.entries.push(row);else disk.entries[index]=row;persist(disk);return savedResponse(args,row,current);
    });},
    discard(input:unknown):Envelope{return guarded(()=>{
      if(!active())return unsupported;const args=parsed(restoredApplication?clipDraftOpacityRestoredDeleteSchema:clipDraftDeleteSchema,input);writable(args);
      const current=timeline(args.projectId), disk=read(), index=disk.entries.findIndex(row=>keyOf(row)===keyOf(args)), previous=disk.entries[index];historical(previous);
      if(previous && previous.revision===args.expectedRevision+1 && previous.draft===null)return savedResponse(args,previous,current);
      if(!previous || previous.draft===null || previous.revision!==args.expectedRevision || args.expectedRevision===Number.MAX_SAFE_INTEGER)fail('LOCAL_DRAFT_CONFLICT');
      const row:Slot={...keyOnly(args),revision:previous.revision+1,draft:null};disk.entries[index]=row;persist(disk);return savedResponse(args,row,current);
    });},
  });
}
