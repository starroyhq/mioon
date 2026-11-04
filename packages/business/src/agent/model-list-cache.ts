import path from 'node:path';
import {createHash} from 'node:crypto';
import {opendirSync} from 'node:fs';
import {ensurePrivateDirectory,validateManagedDirectory,validateManagedFile,readPrivateFile,writePrivateFileAtomic,removePrivateFile} from '@mioon/contracts/private-storage';
import {agentServiceKeySchema} from '../../../contracts/src/agent-connection-settings.ts';
import {AGENT_MODEL_LIST_CACHE_LIMITS,agentModelListCacheIdentitySchema as identitySchema,agentModelListCacheRecordSchema as recordSchema} from '../../../contracts/src/agent-model-list-private.ts';
import type {AgentModelListResult} from '../../../contracts/src/agent-model-list.ts';

export {AGENT_MODEL_LIST_CACHE_LIMITS} from '../../../contracts/src/agent-model-list-private.ts';
export type CachedAgentModelList=Extract<AgentModelListResult,{outcome:'success'}>;
export interface AgentModelListCacheIdentity{serviceKey:string;binding:string;descriptor:string}
export interface AgentModelListCacheStore{
 read(identity:AgentModelListCacheIdentity):CachedAgentModelList|null|Promise<CachedAgentModelList|null>;
 write(identity:AgentModelListCacheIdentity,result:CachedAgentModelList):boolean|Promise<boolean>;
 remove(serviceKey:string):void|Promise<void>;
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const prefix=(serviceKey:string)=>digest(agentServiceKeySchema.parse(serviceKey));
const name=(identity:AgentModelListCacheIdentity)=>`${prefix(identity.serviceKey)}-${digest(JSON.stringify(identitySchema.parse(identity)))}.json`;
const filename=/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/u;

/** Disposable observations, never a settings envelope or credential store.
 * Every read is bounded and fail-open as a cache miss; unsafe files are never
 * opened, repaired, chmodded or followed. Only this dedicated directory is read.
 */
export function createAgentModelListCache({directory,privateRoot=directory}:{directory:string;privateRoot?:string}):AgentModelListCacheStore{
 const root=path.resolve(privateRoot),cache=path.resolve(directory),relative=path.relative(root,cache);
 if(!path.isAbsolute(directory)||!path.isAbsolute(privateRoot)||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error('Invalid model list cache directory');
 function exists():boolean{return Boolean(ensurePrivateDirectory(root,{allowMissing:true})&&validateManagedDirectory(cache,{root,private:true,allowMissing:true}));}
 function inventory():Array<{name:string;bytes:number}>|null{
  if(!exists())return [];
  const entries:Array<{name:string;bytes:number}>=[];let bytes=0;
  const handle=opendirSync(cache);
  try{
   for(let item=handle.readSync();item;item=handle.readSync()){
    // Stop after the first over-limit entry; never enumerate an unbounded dir.
    if(entries.length>=AGENT_MODEL_LIST_CACHE_LIMITS.files||!item.isFile()||!filename.test(item.name))return null;
    const info=validateManagedFile(path.join(cache,item.name),{root,private:true,maxBytes:AGENT_MODEL_LIST_CACHE_LIMITS.directoryBytes});
    if(!info)return null;bytes+=info.size;
    if(bytes>AGENT_MODEL_LIST_CACHE_LIMITS.directoryBytes)return null;
    entries.push({name:item.name,bytes:info.size});
   }
  }finally{handle.closeSync();}
  validateManagedDirectory(cache,{root,private:true});return entries;
 }
 return {
  read(identity){
   try{
    const file=name(identity),entries=inventory();
    if(!entries||!entries.some(entry=>entry.name===file)||entries.some(entry=>entry.bytes>AGENT_MODEL_LIST_CACHE_LIMITS.fileBytes))return null;
    const bytes=readPrivateFile(path.join(cache,file),{root,allowMissing:true,maxBytes:AGENT_MODEL_LIST_CACHE_LIMITS.fileBytes});
    if(!(bytes instanceof Uint8Array))return null;
    const parsed=recordSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    if(JSON.stringify(parsed.identity)!==JSON.stringify(identitySchema.parse(identity))||parsed.result.outcome!=='success')return null;
    return parsed.result;
   }catch{return null;}
  },
  write(identity,result){
   try{
    const file=name(identity),record=recordSchema.parse({version:AGENT_MODEL_LIST_CACHE_LIMITS.version,identity:identitySchema.parse(identity),result});
    const serialized=JSON.stringify(record)+'\n',size=Buffer.byteLength(serialized);
    if(size>AGENT_MODEL_LIST_CACHE_LIMITS.fileBytes)return false;
    // A bounded oversized observation is disposable. Remove only our exact
    // hashed target after the normal private-file checks; never repair links,
    // permissions, foreign entries or an unbounded directory.
    if(exists()){
     const target=validateManagedFile(path.join(cache,file),{root,private:true,allowMissing:true,maxBytes:64*1024*1024});
     if(target&&target.size>AGENT_MODEL_LIST_CACHE_LIMITS.fileBytes)removePrivateFile(path.join(cache,file),{root,private:true,maxBytes:64*1024*1024});
    }
    const entries=inventory();if(!entries)return false;
    const prior=entries.find(entry=>entry.name===file);
    if(entries.length+(prior?0:1)>AGENT_MODEL_LIST_CACHE_LIMITS.files||entries.reduce((sum,entry)=>sum+entry.bytes,0)-(prior?.bytes??0)+size>AGENT_MODEL_LIST_CACHE_LIMITS.directoryBytes)return false;
    ensurePrivateDirectory(root,{create:true});ensurePrivateDirectory(cache,{create:true});
    if(prior&&prior.bytes>AGENT_MODEL_LIST_CACHE_LIMITS.fileBytes)removePrivateFile(path.join(cache,file),{root,private:true,maxBytes:AGENT_MODEL_LIST_CACHE_LIMITS.directoryBytes});
    writePrivateFileAtomic(path.join(cache,file),serialized,{root,maxBytes:AGENT_MODEL_LIST_CACHE_LIMITS.fileBytes});return true;
   }catch{return false;}
  },
  remove(serviceKey){
   try{
    const starts=`${prefix(serviceKey)}-`,entries=inventory();if(!entries)return;
    for(const entry of entries)if(entry.name.startsWith(starts))removePrivateFile(path.join(cache,entry.name),{root,private:true,maxBytes:AGENT_MODEL_LIST_CACHE_LIMITS.directoryBytes});
   }catch{/* A settings commit is never rolled back because disposable cleanup failed. */}
  },
 };
}
