import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,readdir,readFile,writeFile,rm,stat,mkdir,symlink,link,chmod,truncate} from 'node:fs/promises';
import {createAgentModelListCache,AGENT_MODEL_LIST_CACHE_LIMITS} from '../packages/business/src/agent/model-list-cache.ts';
import type {AgentModelListCacheIdentity} from '../packages/business/src/agent/model-list-cache.ts';
import {agentModelListCacheRecordSchema} from '../packages/contracts/src/agent-model-list-private.ts';
import type {AgentModelListSuccess} from '../packages/contracts/src/agent-model-list.ts';

const result=(complete=true):AgentModelListSuccess=>({outcome:'success',models:[{id:'model-one',displayName:'Model One',adaptation:'unverified'}],complete,source:'current_protocol',fetchedAt:'2026-11-04T00:00:00.000Z'});
const identity=(index=0):AgentModelListCacheIdentity=>({serviceKey:'openai',binding:'non-secret-recipient',descriptor:`list-v1-${index}`});
async function fixture(t:test.TestContext){const root=await mkdtemp(path.join(tmpdir(),'mioon-model-cache-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=path.join(root,'agent-settings','model-list-cache');return {root,directory,cache:createAgentModelListCache({directory,privateRoot:root})};}
async function onlyFile(directory:string){const entries=await readdir(directory);assert.equal(entries.length,1);return path.join(directory,entries[0]!);}

test('first cache miss is read-only; private success and partial observations survive a new cache instance',async t=>{
 const f=await fixture(t);assert.equal(await f.cache.read(identity()),null);assert.deepEqual(await readdir(f.root),[]);
 assert.equal(await f.cache.write(identity(),result()),true);const file=await onlyFile(f.directory),text=await readFile(file,'utf8');
 const stored=agentModelListCacheRecordSchema.parse(JSON.parse(text));assert.equal(stored.version,AGENT_MODEL_LIST_CACHE_LIMITS.version);assert.deepEqual(stored.identity,identity());
 assert.deepEqual(await f.cache.read(identity()),result());assert.deepEqual(await createAgentModelListCache({directory:f.directory,privateRoot:f.root}).read(identity()),result());
 if(process.platform!=='win32'){assert.equal((await stat(f.directory)).mode&0o777,0o700);assert.equal((await stat(file)).mode&0o777,0o600);}
 const empty={...result(false),models:[]};assert.equal(await f.cache.write(identity(),empty),true);assert.deepEqual(await f.cache.read(identity()),empty);
 for(const changed of [{...identity(),serviceKey:'deepseek'},{...identity(),binding:'different-recipient'},{...identity(),descriptor:'different-descriptor'}])assert.equal(await f.cache.read(changed),null);
});

test('malformed, unknown-version and foreign-identity cache records are misses; next successful fetch rewrites them',async t=>{
 const f=await fixture(t);assert.equal(await f.cache.write(identity(),result()),true);const file=await onlyFile(f.directory),original=JSON.parse(await readFile(file,'utf8')) as Record<string,unknown>;
 for(const value of ['{bad-json',JSON.stringify({...original,version:AGENT_MODEL_LIST_CACHE_LIMITS.version+1}),JSON.stringify({...original,identity:identity(99)}),JSON.stringify({...original,secret:'SYNTHETIC_FORBIDDEN_FIELD'}),JSON.stringify({...original,result:{...result(),raw:'SYNTHETIC_RAW'}})]){
  await writeFile(file,value,{mode:0o600});assert.equal(await f.cache.read(identity()),null);assert.equal(await f.cache.write(identity(),result()),true);assert.deepEqual(await f.cache.read(identity()),result());
 }
 const invalidUtf8=Buffer.from([0xff]);await writeFile(file,invalidUtf8);assert.equal(await f.cache.read(identity()),null);assert.equal(await f.cache.write(identity(),result()),true);
 await writeFile(file,'x'.repeat(AGENT_MODEL_LIST_CACHE_LIMITS.fileBytes+1));assert.equal(await f.cache.read(identity()),null);assert.equal(await f.cache.write(identity(),result()),true);assert.deepEqual(await f.cache.read(identity()),result());
 await truncate(file,AGENT_MODEL_LIST_CACHE_LIMITS.directoryBytes+1);assert.equal(await f.cache.read(identity()),null);assert.equal(await f.cache.write(identity(),result()),true);assert.deepEqual(await f.cache.read(identity()),result());
});

test('cache file accepts the exact byte limit and rejects the next byte without disturbing the existing record',async t=>{
 const f=await fixture(t),large:AgentModelListSuccess={...result(),models:Array.from({length:500},(_,index)=>({id:`${index}`.padEnd(200,'i'),displayName:'d'.repeat(256),adaptation:'unverified'}))};
 const base={version:AGENT_MODEL_LIST_CACHE_LIMITS.version,identity:{...identity(),binding:'b',descriptor:'d'},result:large},gap=AGENT_MODEL_LIST_CACHE_LIMITS.fileBytes-Buffer.byteLength(JSON.stringify(base)+'\n');
 assert.ok(gap>0&&gap<=16382);
 const bindingPadding=Math.min(8191,gap);base.identity.binding+='b'.repeat(bindingPadding);base.identity.descriptor+='d'.repeat(gap-bindingPadding);
 assert.equal(Buffer.byteLength(JSON.stringify(base)+'\n'),AGENT_MODEL_LIST_CACHE_LIMITS.fileBytes);
 assert.equal(await f.cache.write(base.identity,large),true);const file=await onlyFile(f.directory),before=await readFile(file);
 const over={...base.identity,descriptor:base.identity.descriptor+'d'};assert.equal(await f.cache.write(over,large),false);
 assert.deepEqual(await readFile(file),before);assert.equal((await readdir(f.directory)).length,1);
});

test('dedicated directory entry and byte ceilings are bounded misses without touching unrelated files',async t=>{
 const f=await fixture(t);
 for(let i=0;i<AGENT_MODEL_LIST_CACHE_LIMITS.files;i++)assert.equal(await f.cache.write(identity(i),result()),true);
 assert.equal((await readdir(f.directory)).length,AGENT_MODEL_LIST_CACHE_LIMITS.files);assert.equal(await f.cache.write(identity(57),result()),false);
 assert.deepEqual(await f.cache.read(identity()),result());
 const extra=path.join(f.directory,'unrelated.txt');await writeFile(extra,'SYNTHETIC_UNRELATED',{mode:0o600});
 assert.equal(await f.cache.read(identity()),null);assert.equal(await f.cache.write(identity(),result()),false);assert.equal(await readFile(extra,'utf8'),'SYNTHETIC_UNRELATED');await rm(extra);
 const files=await readdir(f.directory),file=path.join(f.directory,files[0]!);await truncate(file,AGENT_MODEL_LIST_CACHE_LIMITS.directoryBytes+1);
 assert.equal(await f.cache.read(identity()),null);assert.equal(await f.cache.write(identity(),result()),false);
});

test('removal touches only the named service and never recreates directories',async t=>{
 const f=await fixture(t);await f.cache.remove('openai');assert.deepEqual(await readdir(f.root),[]);
 const other={...identity(),serviceKey:'deepseek'};assert.equal(await f.cache.write(identity(),result()),true);assert.equal(await f.cache.write(other,result()),true);
 await f.cache.remove('openai');assert.equal(await f.cache.read(identity()),null);assert.deepEqual(await f.cache.read(other),result());
 assert.equal((await readdir(f.directory)).length,1);
});

test('unsafe cache files and directories are misses and cannot overwrite or chmod their targets',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t);assert.equal(await f.cache.write(identity(),result()),true);const file=await onlyFile(f.directory),outside=path.join(f.root,'outside.json');await writeFile(outside,'SYNTHETIC_OUTSIDE',{mode:0o600});
 for(const mode of ['symlink','hardlink','public','directory'] as const){
  await rm(file,{recursive:true,force:true});
  if(mode==='symlink')await symlink(outside,file);else if(mode==='hardlink')await link(outside,file);else if(mode==='public'){await writeFile(file,'SYNTHETIC_PUBLIC',{mode:0o644});await chmod(file,0o644);}else await mkdir(file,{mode:0o700});
  assert.equal(await f.cache.read(identity()),null);assert.equal(await f.cache.write(identity(),result()),false);await f.cache.remove('openai');assert.equal(await readFile(outside,'utf8'),'SYNTHETIC_OUTSIDE');
  if(mode==='public')assert.equal((await stat(file)).mode&0o777,0o644);
 }
 await rm(file,{recursive:true,force:true});await rm(f.directory,{recursive:true});await symlink(path.dirname(outside),f.directory);
 assert.equal(await f.cache.read(identity()),null);assert.equal(await f.cache.write(identity(),result()),false);assert.equal(await readFile(outside,'utf8'),'SYNTHETIC_OUTSIDE');
});
