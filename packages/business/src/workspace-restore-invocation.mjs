import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {AppError} from '@mioon/contracts';
import {getWorkspaceRestoreContext} from './workspace-restore-schema.mjs';
import {ownsStoreLock} from './db.mjs';

const invocations=new AsyncLocalStorage(),lifetimes=new WeakMap();
const canonical=value=>JSON.stringify(value,(_,part)=>part&&typeof part==='object'&&!Array.isArray(part)?Object.fromEntries(Object.entries(part).sort(([a],[b])=>a.localeCompare(b))):part);
export const restoreDigest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const unavailable=()=>{throw new AppError('RESTORE_OPERATION_UNAVAILABLE','This operation is unavailable in this restored workspace.',409);};
export function freezeRestoreInput(value){
 const copy=structuredClone(value);
 const freeze=item=>{if(item&&typeof item==='object'){for(const child of Object.values(item))freeze(child);Object.freeze(item);}return item;};
 return freeze(copy);
}
function live(entry,store){
 if(!entry||!lifetimes.get(entry)?.live||entry.store!==store||entry.signal?.aborted||!ownsStoreLock(store)||getWorkspaceRestoreContext(store)?.workspaceOrigin!==entry.origin)unavailable();
 entry.validate?.();
}
// Authority is private live state, separate from the frozen invocation identity.
// Async descendants inherit identity only; settling/abort revokes every child.
export function withRestoreInvocation(store,operation,input,{signal,validate}={},callback){
 if(!getWorkspaceRestoreContext(store))return callback(input);
 const parent=invocations.getStore();
 if(parent){assertRestoreInvocation(store,operation,input);return callback(input);}
 const entry=Object.freeze({store,origin:getWorkspaceRestoreContext(store).workspaceOrigin,operation,inputDigest:restoreDigest(input),projectId:input.projectId,signal,validate});
 const state={live:true};lifetimes.set(entry,state);
 const revoke=()=>{state.live=false;};
 signal?.addEventListener('abort',revoke,{once:true});
 const finish=()=>{revoke();signal?.removeEventListener('abort',revoke);};
 try{live(entry,store);const result=invocations.run(entry,()=>callback(input));if(result&&typeof result.then==='function')return Promise.resolve(result).finally(finish);finish();return result;}
 catch(error){finish();throw error;}
}
export function hasRestoreInvocation(store,operation,input){
 if(!invocations.getStore())return false;
 assertRestoreInvocation(store,operation,input);return true;
}
export function assertRestoreInvocation(store,operation,input){
 if(!getWorkspaceRestoreContext(store))return;
 const entry=invocations.getStore();live(entry,store);
 // These are fixed internal edges, never caller-selected operation delegates.
 if(operation==='timeline.get'&&input?.projectId===entry.projectId&&['timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.split','timeline.seed','timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove'].includes(entry.operation))return;
 if(operation==='timeline.export.capabilities'&&input===undefined&&['timeline.render','timeline.export.capabilities'].includes(entry.operation))return;
 if(entry.operation!==operation||entry.inputDigest!==restoreDigest(input))unavailable();
}
export function restoreEffectFence(store){
 if(!getWorkspaceRestoreContext(store))return undefined;
 const entry=invocations.getStore();live(entry,store);
 return ()=>live(entry,store);
}
export function withRestoreTaskInvocation(store,row,{signal}={},callback){
 const restored=getWorkspaceRestoreContext(store);
 if(!restored)return callback();
 const identity=Object.freeze({id:row.id,projectId:row.projectId,operation:row.operation,input:row.input,digest:row.digest,claim:row.claim,claimInstance:row.claimInstance,executionEpoch:row.executionEpoch});
 const validate=()=>{
  const actual=store.db.prepare('SELECT id,projectId,operation,input,digest,claim,claimInstance,executionEpoch,status FROM edit_tasks WHERE id=? AND projectId=?').get(identity.id,identity.projectId);
  if(!actual||actual.status!=='dispatching'||actual.executionEpoch!==restored.workspaceOrigin||!actual.claim||Object.keys(identity).some(key=>actual[key]!==identity[key]))unavailable();
 };
 validate();
 const input=freezeRestoreInput(JSON.parse(row.input));
 if(restoreDigest({operation:row.operation,input})!==row.digest)unavailable();
 return withRestoreInvocation(store,row.operation,input,{signal,validate},callback);
}
