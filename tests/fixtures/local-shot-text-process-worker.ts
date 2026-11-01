/** Synthetic process harness only. Its parent owns the ChildProcess handle and
 * alone sends SIGKILL. All mutation/replay/ownership behavior is production code.
 * This file also exports the exact server wiring for the cold-backup test. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeSync} from 'node:fs';
import {openStore,ownsStoreLock,getWorkspaceRestoreContext} from '../../packages/business/src/db.ts';
import {createServices,canonical} from '../../packages/business/src/services.ts';
import {createLocalMutationServices} from '../../packages/business/src/local-mutations.ts';
import {validateImageConsumption} from '../../packages/business/src/image-consumption.ts';
import {createLocalShotTextDomain} from '../../packages/business/src/local-shot-text-domain.ts';
import {createLocalShotText} from '../../packages/business/src/local-shot-text.ts';
import {schemas,AppError} from '@mioon/contracts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';
import {withoutForeignKeys} from '../helpers/project-database.ts';

type Store = ReturnType<typeof openStore>
type Services = ReturnType<typeof createServices>
export interface ShotTextFixtureOptions {fault?: (point: string)=>void; afterCommit?: ()=>void; dispatches?: {projectId: string; input: unknown}[]}
export function shotTextForStore(store: Store, services: Services, {fault=()=>{},afterCommit=()=>{},dispatches=[]}: ShotTextFixtureOptions = {}) {
 const calls={storage:0,ownsLock:0,readShot:0,readReceipt:0,update:0};
 const neverMutate=()=>{throw Error('Read-only replay must never mutate');};
 const replay=createLocalMutationServices(store,{readOnly:true,canonical,check:neverMutate,now:neverMutate,references:{guardManualUpdate:neverMutate}});
 const domain=createLocalShotTextDomain({db:store.db,canonical,replay:(projectId: string,input: never)=>replay.updateShotInProject(projectId,input as never),
  validateAsset:(projectId: string,asset: never)=>validateImageConsumption(store.db,asset as never,projectId),isRevisionConflict:(error: unknown)=>error instanceof AppError&&error.code==='REVISION_CONFLICT',
  updateShotInProject:(projectId: string,input: never)=>services.updateShotInProject(projectId,input as never)} as never);
 const wrap = <F extends (...args: never[])=>unknown>(fn: F): F => (((...args: never[])=>{calls.storage++;return fn(...args);}) as F);
 const storage = {readPrivateFile: wrap(readPrivateFile as never), writePrivateFileAtomic: wrap(writePrivateFileAtomic as never), validatePrivateDirectory: wrap(validatePrivateDirectory as never), validateManagedFile: wrap(validateManagedFile as never)} as never;
 const local=createLocalShotText({root:store.root,storage,fault,guards:{...domain,
  ownsLock:()=>{calls.ownsLock++;return ownsStoreLock(store);},isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),isShotUpdateInput:(value: unknown)=>schemas['shot.update'].safeParse(value).success,
  readShot:(...args: never[])=>{calls.readShot++;return (domain.readShot as (...rest: never[])=>unknown)(...args);},readReceipt:(...args: never[])=>{calls.readReceipt++;return (domain.readReceipt as (...rest: never[])=>unknown)(...args);},
  update:async(projectId: string,input: {requestId: string})=>{calls.update++;dispatches.push({projectId,input:structuredClone(input)});const response=await domain.update(projectId,input as never);
   const saved=store.db.prepare('SELECT * FROM mutation_requests WHERE requestId=?').get(input.requestId) as {operation: string; response: string}|undefined;assert.ok(saved,'Real shot commit requires immutable shared receipt');assert.equal(saved.operation,'shot.update');assert.deepEqual(JSON.parse(saved.response),response);afterCommit();return response;}}} as never);
 return {local,calls};
}
async function main(){
 const [root,...extra]=process.argv.slice(2);assert.ok(root&&path.isAbsolute(root));assert.equal(extra.length,0);const send=process.send?.bind(process);assert.ok(send);
 const store=openStore(root),services=createServices(store,new Map(),{env:{MIOON_ENABLE_LIVE_PROVIDER:'0'}});let armed: string|null=null,inOutcome=false,closing=false;const dispatches: {projectId: string; input: unknown}[]=[];
 function boundary(phase: string): void {if(armed!==phase)return;writeSync(1,JSON.stringify({type:'boundary',phase,dispatches:dispatches.length})+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);throw Error('A crash-only boundary resumed');}
 const {local}=shotTextForStore(store,services,{dispatches,afterCommit:()=>boundary('afterBusinessReceiptCommit'),fault:(point: string)=>{if(point==='beforeOutcomePersist')inOutcome=true;boundary(inOutcome&&point==='afterDirectorySync'?'afterOutcomePersist':point);}});
 const first=store.db.prepare('SELECT id,projectId FROM shots ORDER BY rowid LIMIT 1').get() as {id: string; projectId: string}|undefined;assert.ok(first);const instanceId=(local.get({projectId:first.projectId,shotId:first.id}) as {instanceId?: string}).instanceId;
 interface WorkerMessage {id: string; method: string; input: Record<string, unknown> & {requestId?: string; kind?: string; foreignProjectId?: string; operation?: string; [key: string]: unknown}}
 process.on('message',async (raw: unknown)=>{if(closing)return;const message=raw as WorkerMessage;const {id,method,input}=message;try{
  if(method==='close'){closing=true;await services.drain();store.close();process.disconnect();return;}
  let data;
  if(method==='arm'){assert.ok(typeof input==='string'&&['beforePersist','afterDirectorySync','beforeDispatch','afterBusinessReceiptCommit','beforeOutcomePersist','afterOutcomePersist'].includes(input as never));armed=String(input);inOutcome=false;data={armed};}
  else if(method==='identity')data={instanceId};
  else if(method==='observe')data={dispatches:structuredClone(dispatches)};
  else if(method==='rpc'){assert.equal(input.operation,'shot.update');data=await services.call(String(input.operation),input.input as never);}
  else if(method==='executeBoth')data=await Promise.all([local.execute(input as never),local.recover(input as never)]);
  else if(method==='corruptReceipt'){
   const prior=store.db.prepare('SELECT * FROM mutation_requests WHERE requestId=?').get(String(input.requestId)) as {requestId: string; projectId: string; canonicalInput: string; response: string; operation: string}|undefined;assert.ok(prior);assert.equal(prior.operation,'shot.update');
   // Deliberate synthetic disk corruption after disabling its exact protective trigger.
   // No product path removes these triggers. The post-corruption snapshot must stay unchanged.
   if(input.kind==='duplicate')store.db.exec('DROP TRIGGER reject_asset_range_cross_request');
   else store.db.exec('DROP TRIGGER immutable_mutation_requests');
   if(input.kind==='response'){const response=JSON.parse(prior.response) as Record<string, unknown>;response.prompt='CORRUPTED_HISTORICAL_AFTERTEXT';store.db.prepare('UPDATE mutation_requests SET response=? WHERE requestId=?').run(JSON.stringify(response),String(input.requestId));}
   // The foreign project lives in a store of its own; write the damaged owner as a corrupt file would hold it.
   else if(input.kind==='owner')withoutForeignKeys(store.db,()=>store.db.prepare('UPDATE mutation_requests SET projectId=? WHERE requestId=?').run(String(input.foreignProjectId),String(input.requestId)));
   else if(input.kind==='canonical')store.db.prepare('UPDATE mutation_requests SET canonicalInput=? WHERE requestId=?').run('{}',String(input.requestId));
   else if(input.kind==='duplicate')store.db.prepare('INSERT INTO asset_range_requests(requestId,operation,projectId,canonicalInput,response) VALUES(?,?,?,?,?)').run(prior.requestId,'asset.range.set',prior.projectId,prior.canonicalInput,prior.response);
   else throw Error('Unknown corruption');data={corrupted:input.kind};
  }else{assert.ok(['get','put','discard','prepare','execute','recover'].includes(method));data=await (local as unknown as Record<string,(value: unknown)=>Promise<unknown>>)[method](input);}
  send({type:'reply',id,data});
 }catch(error){const failure=error as {code?: string; message?: string};send({type:'reply',id,error:{code:failure.code??'HARNESS_ERROR',message:failure.message??String(error)}});}});
 send({type:'ready',pid:process.pid,dispatches:0});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
