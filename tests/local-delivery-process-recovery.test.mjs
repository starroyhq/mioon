/** Real Node process death around real shared business services and the private
 * delivery sidecar. This does not claim native GUI lost-ACK coverage or media
 * validation; tests/local-delivery-qa-native.mjs covers the native title flow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,realpath,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {publicValue} from '@mioon/contracts';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices,hash} from '../packages/business/src/services.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url)),workerPath=fileURLToPath(new URL('./fixtures/local-delivery-process-worker.mjs',import.meta.url));
const authority=value=>({workspaceScope:value.workspaceScope,instanceId:value.instanceId,projectId:value.projectId});
const action=value=>({...authority(value),intentId:value.intent.intentId,expectedIntentRevision:value.intentRevision});
const deadline=(promise,label,ms=15000)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`Timed out: ${label}`)),ms);})]).finally(()=>clearTimeout(timer));};

function spawnWorker(root){
 const child=spawn(process.execPath,[workerPath,root],{cwd:repo,stdio:['ignore','pipe','pipe','ipc'],
  env:{PATH:process.env.PATH||'',TMPDIR:root,LANG:'C.UTF-8',MIOON_ENABLE_LIVE_PROVIDER:'0'}});
 const ready=Promise.withResolvers(),exited=Promise.withResolvers(),pending=new Map(),boundaries=new Map();
 let stopped=null,stdout='',stderr='';
 // Always attach a rejection handler immediately, including startup failures.
 void ready.promise.catch(()=>{});
 function rejectAll(error){ready.reject(error);for(const item of pending.values())item.reject(error);for(const item of boundaries.values())item.reject(error);}
 child.stdout.setEncoding('utf8').on('data',chunk=>{
  stdout+=chunk;assert.ok(stdout.length<8192,'Bounded harness stdout');
  for(let end;(end=stdout.indexOf('\n'))>=0;){const line=stdout.slice(0,end);stdout=stdout.slice(end+1);const value=JSON.parse(line);
   assert.equal(value.type,'boundary');const gate=boundaries.get(value.phase);assert.ok(gate,'An unarmed crash boundary was reached');gate.resolve(value);}
 });
 child.stderr.setEncoding('utf8').on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
 child.once('error',rejectAll);
 child.once('close',(code,signal)=>{stopped={code,signal};rejectAll(Object.assign(Error(`Owned delivery worker exited (${code}, ${signal})\n${stderr}`),{code:'WORKER_EXITED',signal}));exited.resolve(stopped);});
 child.on('message',message=>{
  if(message.type==='ready')ready.resolve(message);
  else if(message.type==='reply'){const reply=pending.get(message.id);if(message.error)reply?.reject(Object.assign(Error(message.error.message),{code:message.error.code}));else reply?.resolve(message.data);}
 });
 return {child,ready:ready.promise,exited:exited.promise,get stopped(){return stopped;},
  async ask(method,input){assert.equal(stopped,null);const id=randomUUID(),reply=Promise.withResolvers();pending.set(id,reply);
   child.send({id,method,input},error=>{if(error)reply.reject(error);});
   try{return await deadline(reply.promise,method+' reply');}finally{pending.delete(id);}},
  waitBoundary(phase){assert.equal(boundaries.has(phase),false);const gate=Promise.withResolvers();boundaries.set(phase,gate);return deadline(gate.promise,phase+' boundary');},
  kill(){assert.equal(stopped,null);assert.equal(child.kill('SIGKILL'),true);return deadline(exited.promise,'exact owned child SIGKILL');},
  async close(){if(stopped)return stopped;if(child.connected)child.send({method:'close'});
   try{return await deadline(exited.promise,'owned worker normal close');}catch(error){if(!stopped){child.kill('SIGKILL');await deadline(exited.promise,'owned worker cleanup');}throw error;}}
 };
}
async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-local-delivery-process-'))),workers=[];let worker;
 t.after(async()=>{let safelyClosed=false;try{const results=await Promise.allSettled(workers.map(value=>value.close()));safelyClosed=workers.every(value=>value.stopped);
  for(const result of results)if(result.status==='rejected')throw result.reason;
 }finally{if(safelyClosed)await rm(root,{recursive:true,force:true});}});
 const store=openStore(root),services=createServices(store,new Map());let project,timeline;
 try{
  project=await services.call('project.create',{name:'Synthetic export delivery crash'});
  timeline=await services.call('timeline.get',{projectId:project.id});
  const id=randomUUID(),source=Buffer.from('synthetic business-only source bytes'),relativePath=`media/${id}.png`;
  await writeFile(path.join(root,relativePath),source,{mode:0o600,flag:'wx'});
  store.put('assets',{id,projectId:project.id,name:'Synthetic metadata source',mimeType:'image/png',relativePath,
   sha256:createHash('sha256').update(source).digest('hex'),width:2,height:2,hasVideo:true,hasAudio:false,sizeBytes:source.length,provenance:'user-import',createdAt:new Date().toISOString()});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:60});
 }finally{await services.drain();store.close();}
 const f={root,project,timeline,file:path.join(root,'local-delivery-v1.json'),get worker(){return worker;},
  async start(){worker=spawnWorker(root);workers.push(worker);const ready=await deadline(worker.ready,'worker startup');assert.equal(ready.pid,worker.child.pid);assert.equal(ready.dispatches,0);
   assert.equal(await readFile(path.join(root,'server.lock'),'utf8'),String(worker.child.pid));return ready;},
  async restart(){await worker.close();return this.start();},
  ask:(method,input)=>worker.ask(method,input),get:()=>worker.ask('get',{projectId:project.id}),
  put:(value,name='原始导出 🎬')=>({...authority(value),expectedDraftRevision:value.draftRevision,draftId:value.draft?.draftId??randomUUID(),timelineId:timeline.id,baseRevision:timeline.revision,raw:{deliveryName:name}}),
  prepare:value=>({...authority(value),expectedIntentRevision:value.intentRevision,expectedIntentId:value.intent?.intentId??null,intentId:randomUUID(),timelineId:timeline.id,baseRevision:timeline.revision,
   draft:value.draft?{draftId:value.draft.draftId,revision:value.draftRevision,raw:value.draft.raw}:null,
   input:{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',...(value.draft?.raw.deliveryName?{deliveryName:value.draft.raw.deliveryName}:{})}}),
  read(fn){const db=new DatabaseSync(path.join(root,'workbench.sqlite'),{readOnly:true});try{db.exec('PRAGMA query_only=ON; BEGIN');return fn(db);}finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}},
  snapshot(){return this.read(db=>({schema:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),tables:Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=>{assert.match(name,/^[a-z_]+$/);return [name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()];}))}));},
  receipt:requestId=>f.read(db=>db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(requestId)),
  sidecar:()=>readFile(path.join(root,'local-delivery-v1.json'),'utf8'),
  async crash(phase,method,input){await worker.ask('arm',phase);const reached=worker.waitBoundary(phase),reply=worker.ask(method,input);
   const lost=assert.rejects(reply,{code:'WORKER_EXITED',signal:'SIGKILL'});const point=await reached;
   assert.deepEqual(await worker.kill(),{code:null,signal:'SIGKILL'});await lost;
   assert.equal(await readFile(path.join(root,'server.lock'),'utf8'),String(worker.child.pid),'A true crash must leave the exact stale lock for product startup');
   t.diagnostic(`${phase}: exact owned child ${worker.child.pid} killed before IPC reply; dispatches=${point.dispatches}`);return point;}
 };
 await f.start();return f;
}
const noDispatch=async f=>assert.deepEqual(await f.ask('observe'),{dispatches:[]});
async function title(f){return f.ask('put',f.put(await f.get()));}

// Draft durability alone must never be confused with export intent durability.
test('before intent publication: real process death preserves draft and zero dispatches',{timeout:45000},async t=>{
 const f=await fixture(t),draft=await title(f),input=f.prepare(draft),before=f.snapshot(),sidecar=await f.sidecar();
 const point=await f.crash('beforePersist','prepare',input);assert.equal(point.dispatches,0);assert.equal(await f.sidecar(),sidecar);assert.deepEqual(f.snapshot(),before);
 await f.start();const current=await f.get();assert.equal(current.intent,null);assert.deepEqual(current.draft,draft.draft);assert.notEqual(current.instanceId,draft.instanceId);
 assert.equal(await f.sidecar(),sidecar);assert.deepEqual(f.snapshot(),before);await noDispatch(f);
 await assert.rejects(f.ask('prepare',input),{code:'LOCAL_DELIVERY_STALE_INSTANCE'});await noDispatch(f);
});

for(const phase of ['afterDirectorySync','beforeDispatch'])test(`${phase}: prepared process crash is passive on startup and explicitly recovers exact input once`,{timeout:45000},async t=>{
 const f=await fixture(t),draft=await title(f),input=f.prepare(draft),before=f.snapshot();let prepared;
 if(phase==='afterDirectorySync')assert.equal((await f.crash(phase,'prepare',input)).dispatches,0);
 else{prepared=await f.ask('prepare',input);assert.equal((await f.crash(phase,'execute',action(prepared))).dispatches,0);}
 const bytes=await f.sidecar();assert.deepEqual(f.snapshot(),before);await f.start();const current=await f.get();
 assert.equal(current.intent.outcome.status,'pending');assert.deepEqual(current.intent.input,input.input);assert.equal(await f.sidecar(),bytes);assert.deepEqual(f.snapshot(),before);await noDispatch(f);
 await assert.rejects(f.ask('recover',{...action(current),instanceId:draft.instanceId}),{code:'LOCAL_DELIVERY_STALE_INSTANCE'});
 const accepted=await f.ask('recover',action(current));assert.equal(accepted.envelope.intent.outcome.status,'accepted');assert.equal(accepted.response.requestId,input.input.requestId);
 assert.deepEqual((await f.ask('observe')).dispatches,[input.input]);assert.equal(f.snapshot().tables.exports.length,1);
 assert.equal(f.snapshot().tables.timeline_requests.length,before.tables.timeline_requests.length+1);
 const complete=f.snapshot(),settled=await f.sidecar();assert.deepEqual(await f.ask('recover',action(accepted.envelope)),accepted);
 assert.deepEqual(f.snapshot(),complete);assert.equal(await f.sidecar(),settled);assert.deepEqual((await f.ask('observe')).dispatches,[input.input]);
});

for(const phase of ['afterBusinessReceiptCommit','beforeOutcomePersist','afterOutcomePersist'])test(`${phase}: lost ACK uses immutable business receipt after process restart without a second export`,{timeout:45000},async t=>{
 const f=await fixture(t),draft=await title(f),prepared=await f.ask('prepare',f.prepare(draft)),frozen=JSON.stringify(prepared.intent.input);
 assert.equal((await f.crash(phase,'execute',action(prepared))).dispatches,1);
 const receipt=f.receipt(prepared.intent.input.requestId),original=publicValue(JSON.parse(receipt.response)),committed=f.snapshot(),bytes=await f.sidecar();
 assert.equal(receipt.requestHash,hash({operation:'timeline.render',input:prepared.intent.input}));assert.equal(committed.tables.exports.length,1);
 await f.start();const current=await f.get();assert.equal(current.intent.outcome.status,phase==='afterOutcomePersist'?'accepted':'pending');
 assert.equal(JSON.stringify(current.intent.input),frozen);assert.equal(current.workspaceScope,prepared.workspaceScope);assert.notEqual(current.instanceId,prepared.instanceId);
 assert.deepEqual(f.snapshot(),committed);assert.equal(await f.sidecar(),bytes);await noDispatch(f);
 await assert.rejects(f.ask('recover',action(prepared)),{code:'LOCAL_DELIVERY_STALE_INSTANCE'});
 // A later real business edit must not rebase the frozen recovery input.
 await f.ask('rpc',{operation:'timeline.track.add',input:{projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),kind:'audio'}});
 const newer=f.snapshot();assert.equal((await f.get()).intentTargetStatus,'changed');await noDispatch(f);
 const recovered=await f.ask('recover',action(await f.get()));assert.deepEqual(recovered.response,original);assert.equal(JSON.stringify(recovered.envelope.intent.input),frozen);
 assert.equal(recovered.envelope.intent.outcome.status,'accepted');assert.deepEqual(f.receipt(prepared.intent.input.requestId),receipt);assert.deepEqual(f.snapshot(),newer);await noDispatch(f);
 assert.deepEqual(await f.ask('recover',action(recovered.envelope)),recovered);assert.deepEqual(f.snapshot(),newer);await noDispatch(f);
});

test('durably not_applied remains terminal across process death and repeated explicit recovery',{timeout:45000},async t=>{
 const f=await fixture(t),draft=await title(f),prepared=await f.ask('prepare',f.prepare(draft));
 await f.ask('rpc',{operation:'timeline.track.add',input:{projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),kind:'audio'}});
 const before=f.snapshot();assert.equal((await f.crash('afterOutcomePersist','execute',action(prepared))).dispatches,1);
 assert.deepEqual(f.snapshot(),before);assert.equal(f.receipt(prepared.intent.input.requestId),undefined);
 await f.start();const current=await f.get(),sidecar=await f.sidecar();assert.equal(current.intent.outcome.status,'not_applied');assert.equal(current.intent.outcome.code,'REVISION_CONFLICT');assert.deepEqual(current.draft,draft.draft);
 for(let i=0;i<2;i++){const result=await f.ask('recover',action(current));assert.equal(result.response,null);assert.deepEqual(result.envelope,current);}
 assert.equal(await f.sidecar(),sidecar);assert.deepEqual(f.snapshot(),before);await noDispatch(f);
});

test('two windows share one durable reservation and one exact original dispatch',{timeout:45000},async t=>{
 const f=await fixture(t),draft=await title(f),windowA=await f.get(),windowB=await f.get(),request=f.prepare(windowA),prepared=await f.ask('prepare',request);
 await assert.rejects(f.ask('prepare',f.prepare(windowB)),{code:'LOCAL_DELIVERY_CONFLICT'});
 await assert.rejects(f.ask('recover',{...action(prepared),input:{...request.input,deliveryName:'Forged newer title'}}),{code:'LOCAL_DELIVERY_VALIDATION'});
 const newer=await f.ask('put',f.put(prepared,'另一个窗口的新名称'));
 const [a,b]=await f.ask('executeBoth',action(prepared));assert.deepEqual(a,b);assert.deepEqual(a.envelope.draft,newer.draft);assert.equal(a.response.snapshot.deliveryName,draft.draft.raw.deliveryName);
 assert.deepEqual((await f.ask('observe')).dispatches,[request.input]);assert.equal(f.snapshot().tables.exports.length,1);
 await assert.rejects(f.ask('put',f.put(windowB,'Stale overwrite')),{code:'LOCAL_DELIVERY_CONFLICT'});
 const before=f.snapshot(),sidecar=await f.sidecar();await f.restart();const current=await f.get();await noDispatch(f);
 assert.deepEqual(current.draft,newer.draft);assert.deepEqual((await f.ask('recover',action(current))).response,a.response);
 assert.equal(await f.sidecar(),sidecar);assert.deepEqual(f.snapshot(),before);await noDispatch(f);
});
