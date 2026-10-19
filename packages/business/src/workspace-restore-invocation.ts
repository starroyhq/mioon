import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {AppError} from '@mioon/contracts';
import {getWorkspaceRestoreContext} from './workspace-restore-schema.ts';
import {ownsStoreLock} from './db.ts';
import type {DatabaseSync} from 'node:sqlite';

interface RestoreStore {db: DatabaseSync}
interface RestoreInvocationInput {projectId?: string}
interface RestoreOptions {signal?: AbortSignal;validate?: ()=>void}
interface RestoreInvocationEntry {
 readonly store: RestoreStore;readonly origin: string;readonly operation: string;readonly inputDigest: string;
 readonly projectId: string|undefined;readonly signal: AbortSignal|undefined;readonly validate: (()=>void)|undefined;
}
interface RestoreLifetime {live: boolean}
interface RestoreTaskRow {id: string;projectId: string;operation: string;input: string;digest: string;claim: string|null;claimInstance: string|null;executionEpoch: string}
interface RestoreTaskIdentity {id: string;projectId: string;operation: string;input: string;digest: string;claim: string|null;claimInstance: string|null;executionEpoch: string}
const isThenable=(value: unknown): value is PromiseLike<unknown>=>value!==null&&typeof value==='object'&&typeof (value as {then?: unknown}).then==='function';

const invocations=new AsyncLocalStorage<RestoreInvocationEntry>(),lifetimes=new WeakMap<RestoreInvocationEntry, RestoreLifetime>();
const canonical=(value: unknown): string|undefined=>JSON.stringify(value,(_key: string,part: unknown)=>part&&typeof part==='object'&&!Array.isArray(part)?Object.fromEntries(Object.entries(part).sort(([a],[b])=>a.localeCompare(b))):part);
export const restoreDigest=(value: unknown): string=>createHash('sha256').update(canonical(value) as string).digest('hex');
const unavailable: ()=>never=()=>{throw new AppError('RESTORE_OPERATION_UNAVAILABLE','This operation is unavailable in this restored workspace.',409);};
export function freezeRestoreInput<T>(value: T): T{
 const copy=structuredClone(value);
 const freeze=(item: unknown): unknown=>{if(item&&typeof item==='object'){for(const child of Object.values(item))freeze(child);Object.freeze(item);}return item;};
 return freeze(copy) as T;
}
function live(entry: RestoreInvocationEntry|undefined,store: RestoreStore): void{
 if(!entry||!lifetimes.get(entry)?.live||entry.store!==store||entry.signal?.aborted||!ownsStoreLock(store)||getWorkspaceRestoreContext(store)?.workspaceOrigin!==entry.origin)unavailable();
 entry.validate?.();
}
// Authority is private live state, separate from the frozen invocation identity.
// Async descendants inherit identity only; settling/abort revokes every child.
export function withRestoreInvocation<T>(store: RestoreStore,operation: string,input: RestoreInvocationInput,{signal,validate}: RestoreOptions={},callback: (input: RestoreInvocationInput)=>T): T|Promise<T>{
 if(!getWorkspaceRestoreContext(store))return callback(input);
 const parent=invocations.getStore();
 if(parent){assertRestoreInvocation(store,operation,input);return callback(input);}
 const entry: RestoreInvocationEntry=Object.freeze({store,origin:getWorkspaceRestoreContext(store)!.workspaceOrigin,operation,inputDigest:restoreDigest(input),projectId:input.projectId,signal,validate});
 const state={live:true};lifetimes.set(entry,state);
 const revoke=()=>{state.live=false;};
 signal?.addEventListener('abort',revoke,{once:true});
 const finish=()=>{revoke();signal?.removeEventListener('abort',revoke);};
 try{live(entry,store);const result=invocations.run(entry,()=>callback(input));if(isThenable(result))return Promise.resolve(result as unknown as PromiseLike<T>).finally(finish);finish();return result;}
 catch(error){finish();throw error;}
}
export function hasRestoreInvocation(store: RestoreStore,operation: string,input: RestoreInvocationInput): boolean{
 if(!invocations.getStore())return false;
 assertRestoreInvocation(store,operation,input);return true;
}
export function assertRestoreInvocation(store: RestoreStore,operation: string,input: RestoreInvocationInput|undefined): void{
 if(!getWorkspaceRestoreContext(store))return;
 const entry=invocations.getStore();live(entry,store);
 // These are fixed internal edges, never caller-selected operation delegates.
 if(operation==='timeline.get'&&input?.projectId===entry!.projectId&&['timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.rippleRemove','timeline.clip.split','timeline.seed','timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove'].includes(entry!.operation))return;
 if(operation==='timeline.export.capabilities'&&input===undefined&&['timeline.render','timeline.export.capabilities'].includes(entry!.operation))return;
 if(entry!.operation!==operation||entry!.inputDigest!==restoreDigest(input))unavailable();
}
export function restoreEffectFence(store: RestoreStore): (()=>void)|undefined{
 if(!getWorkspaceRestoreContext(store))return undefined;
 const entry=invocations.getStore();live(entry,store);
 return ()=>live(entry!,store);
}
export function withRestoreTaskInvocation<T>(store: RestoreStore,row: RestoreTaskRow,{signal}: {signal?: AbortSignal}={},callback: ()=>T): T|Promise<T>{
 const restored=getWorkspaceRestoreContext(store);
 if(!restored)return callback();
 const identity: RestoreTaskIdentity=Object.freeze({id:row.id,projectId:row.projectId,operation:row.operation,input:row.input,digest:row.digest,claim:row.claim,claimInstance:row.claimInstance,executionEpoch:row.executionEpoch});
 const validate=()=>{
  const actual=store.db.prepare('SELECT id,projectId,operation,input,digest,claim,claimInstance,executionEpoch,status FROM edit_tasks WHERE id=? AND projectId=?').get(identity.id,identity.projectId);
  if(!actual||actual.status!=='dispatching'||actual.executionEpoch!==restored.workspaceOrigin||!actual.claim||Object.keys(identity).some(key=>actual[key]!==(identity as unknown as Record<string, unknown>)[key]))unavailable();
 };
 validate();
 const input=freezeRestoreInput(JSON.parse(row.input));
 if(restoreDigest({operation:row.operation,input})!==row.digest)unavailable();
 return withRestoreInvocation(store,row.operation,input,{signal,validate},callback);
}
