/** Synthetic process harness only. Its parent owns the ChildProcess handle and
 * alone sends SIGKILL. All mutation/replay/ownership behavior is production code.
 * This file also exports the exact server wiring for the cold-backup test. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeSync} from 'node:fs';
import {openStore,ownsStoreLock,getWorkspaceRestoreContext} from '../../packages/business/src/db.mjs';
import {createServices,canonical} from '../../packages/business/src/services.mjs';
import {createLocalMutationServices} from '../../packages/business/src/local-mutations.mjs';
import {validateImageConsumption} from '../../packages/business/src/image-consumption.mjs';
import {createLocalShotTextDomain} from '../../packages/business/src/local-shot-text-domain.ts';
import {createLocalShotText} from '../../packages/business/src/local-shot-text.ts';
import {schemas,AppError} from '@mioon/contracts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';

export function shotTextForStore(store,services,{fault=()=>{},afterCommit=()=>{},dispatches=[]}={}){
 const calls={storage:0,ownsLock:0,readShot:0,readReceipt:0,update:0};
 const neverMutate=()=>{throw Error('Read-only replay must never mutate');};
 const replay=createLocalMutationServices(store,{readOnly:true,canonical,check:neverMutate,now:neverMutate,references:{guardManualUpdate:neverMutate}});
 const domain=createLocalShotTextDomain({db:store.db,canonical,replay:(projectId,input)=>replay.updateShotInProject(projectId,input),
  validateAsset:(projectId,asset)=>validateImageConsumption(store.db,asset,projectId),isRevisionConflict:error=>error instanceof AppError&&error.code==='REVISION_CONFLICT',
  updateShotInProject:(projectId,input)=>services.updateShotInProject(projectId,input)});
 const storage=Object.fromEntries(Object.entries({readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile}).map(([name,fn])=>[name,(...args)=>{calls.storage++;return fn(...args);}])) ;
 const local=createLocalShotText({root:store.root,storage,fault,guards:{...domain,
  ownsLock:()=>{calls.ownsLock++;return ownsStoreLock(store);},isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),isShotUpdateInput:value=>schemas['shot.update'].safeParse(value).success,
  readShot:(...args)=>{calls.readShot++;return domain.readShot(...args);},readReceipt:(...args)=>{calls.readReceipt++;return domain.readReceipt(...args);},
  update:async(projectId,input)=>{calls.update++;dispatches.push({projectId,input:structuredClone(input)});const response=await domain.update(projectId,input);
   const saved=store.db.prepare('SELECT * FROM mutation_requests WHERE requestId=?').get(input.requestId);assert.ok(saved,'Real shot commit requires immutable shared receipt');assert.equal(saved.operation,'shot.update');assert.deepEqual(JSON.parse(saved.response),response);afterCommit();return response;}}});
 return {local,calls};
}
async function main(){
 const [root,...extra]=process.argv.slice(2);assert.ok(path.isAbsolute(root));assert.equal(extra.length,0);assert.ok(process.send);
 const store=openStore(root),services=createServices(store,new Map(),{env:{MIOON_ENABLE_LIVE_PROVIDER:'0'}});let armed=null,inOutcome=false,closing=false;const dispatches=[];
 function boundary(phase){if(armed!==phase)return;writeSync(1,JSON.stringify({type:'boundary',phase,dispatches:dispatches.length})+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);throw Error('A crash-only boundary resumed');}
 const {local}=shotTextForStore(store,services,{dispatches,afterCommit:()=>boundary('afterBusinessReceiptCommit'),fault:point=>{if(point==='beforeOutcomePersist')inOutcome=true;boundary(inOutcome&&point==='afterDirectorySync'?'afterOutcomePersist':point);}});
 const first=store.db.prepare('SELECT id,projectId FROM shots ORDER BY rowid LIMIT 1').get();const instanceId=local.get({projectId:first.projectId,shotId:first.id}).instanceId;
 process.on('message',async message=>{if(closing)return;const {id,method,input}=message;try{
  if(method==='close'){closing=true;await services.drain();store.close();process.disconnect();return;}
  let data;
  if(method==='arm'){assert.ok(['beforePersist','afterDirectorySync','beforeDispatch','afterBusinessReceiptCommit','beforeOutcomePersist','afterOutcomePersist'].includes(input));armed=input;inOutcome=false;data={armed};}
  else if(method==='identity')data={instanceId};
  else if(method==='observe')data={dispatches:structuredClone(dispatches)};
  else if(method==='rpc'){assert.equal(input.operation,'shot.update');data=await services.call(input.operation,input.input);}
  else if(method==='executeBoth')data=await Promise.all([local.execute(input),local.recover(input)]);
  else if(method==='corruptReceipt'){
   const prior=store.db.prepare('SELECT * FROM mutation_requests WHERE requestId=?').get(input.requestId);assert.ok(prior);assert.equal(prior.operation,'shot.update');
   // Deliberate synthetic disk corruption after disabling its exact protective trigger.
   // No product path removes these triggers. The post-corruption snapshot must stay unchanged.
   if(input.kind==='duplicate')store.db.exec('DROP TRIGGER reject_asset_range_cross_request');
   else store.db.exec('DROP TRIGGER immutable_mutation_requests');
   if(input.kind==='response'){const response=JSON.parse(prior.response);response.prompt='CORRUPTED_HISTORICAL_AFTERTEXT';store.db.prepare('UPDATE mutation_requests SET response=? WHERE requestId=?').run(JSON.stringify(response),input.requestId);}
   else if(input.kind==='owner')store.db.prepare('UPDATE mutation_requests SET projectId=? WHERE requestId=?').run(input.foreignProjectId,input.requestId);
   else if(input.kind==='canonical')store.db.prepare('UPDATE mutation_requests SET canonicalInput=? WHERE requestId=?').run('{}',input.requestId);
   else if(input.kind==='duplicate')store.db.prepare('INSERT INTO asset_range_requests(requestId,operation,projectId,canonicalInput,response) VALUES(?,?,?,?,?)').run(prior.requestId,'asset.range.set',prior.projectId,prior.canonicalInput,prior.response);
   else throw Error('Unknown corruption');data={corrupted:input.kind};
  }else{assert.ok(['get','put','discard','prepare','execute','recover'].includes(method));data=await local[method](input);}
  process.send({type:'reply',id,data});
 }catch(error){process.send({type:'reply',id,error:{code:error.code??'HARNESS_ERROR',message:error.message}});}});
 process.send({type:'ready',pid:process.pid,dispatches:0});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
