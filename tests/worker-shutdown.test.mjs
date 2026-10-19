import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {onMediaProcess,spawnMedia} from '../packages/business/src/media-processes.ts';
import {createJsonRequest,downloadMp4} from '../packages/business/src/providers/live-common.ts';
import {assertMediaTerminated} from '../packages/business/src/operation-lifecycle.ts';
import {probe} from '../packages/business/src/media.ts';
import {MEDIA_PROBE_LIMITS,withProbePermit} from '../packages/business/src/media-probe.ts';
import {deferred,settle,shutdownFixture} from './helpers/worker-shutdown-fixture.ts';

const post=(fetchImpl)=>createJsonRequest({api:'https://synthetic.invalid',headers:{},fetchImpl,ensureEnabled(){},name:'Synthetic'});
const MP4=Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109]);

test('shutdown before reference preparation finishes leaves queued with no attempt or media spawn',async t=>{
 const f=await shutdownFixture(t,{}, {reference:true}),events=[];
 const detach=onMediaProcess(event=>events.push(event));t.after(detach);
 const worker=f.start();await worker.stop();
 assert.equal(f.read().status,'queued');assert.equal(f.read().submissionCount,0);assert.equal(f.calls.submit,0);assert.deepEqual(events,[]);
});

test('pre-aborted shared POST is explicitly before dispatch; ambiguous abort after fetch stays unknown',async()=>{
 const controller=new AbortController();let calls=0;
 const request=post(async()=>{calls++;throw Error('No request permitted');});
 controller.abort();
 await assert.rejects(request('/tasks',{method:'POST',context:{signal:controller.signal}}),{code:'OPERATION_CANCELLED',beforeDispatch:true});
 assert.equal(calls,0);
 const after=new AbortController();
 const ambiguous=post(async()=>{calls++;after.abort();throw new DOMException('Synthetic abort','AbortError');});
 await assert.rejects(ambiguous('/tasks',{method:'POST',context:{signal:after.signal}}),{code:'SUBMISSION_UNKNOWN',uncertain:true});
 assert.equal(calls,1);
});

test('cooperative adapter preflight abort rolls back only the unsubmitted attempt',async t=>{
 const entered=deferred();let fetches=0;
 const request=post(async()=>{fetches++;throw Error('Fetch must not start');});
 const f=await shutdownFixture(t,{submit:async(snapshot,context)=>{
  entered.resolve();await new Promise(resolve=>context.signal.addEventListener('abort',resolve,{once:true}));
  return request('/tasks',{method:'POST',context});
 }});
 const worker=f.start();await entered.promise;await worker.stop();
 assert.equal(fetches,0);assert.equal(f.read().status,'queued');assert.equal(f.read().submissionCount,0);
});

test('uncooperative submit stops within budget, records unknown, and late acceptance cannot touch closed SQLite',async t=>{
 const entered=deferred(),receipt=deferred();let signal;
 const f=await shutdownFixture(t,{submit:async(snapshot,context)=>{signal=context.signal;entered.resolve();return receipt.promise;}});
 const worker=f.start();await entered.promise;
 const began=performance.now();const stopping=worker.stop();assert.equal(worker.stop(),stopping);await stopping;
 assert.ok(performance.now()-began<1000);assert.equal(signal.aborted,true);
 assert.equal(f.read().status,'submission_unknown');assert.equal(f.read().submissionCount,1);assert.equal(f.read().providerJobId,null);
 await assert.rejects(f.services.call('job.retry',{jobId:f.job.id,requestId:randomUUID()}),{code:'UNSAFE_RETRY'});
 f.close();receipt.resolve({providerJobId:'late-accepted-task'});await settle();await settle();
 assert.equal(f.closedTouches(),0);
 const store=openStore(f.root),services=createServices(store,f.providers),restarted=startWorker(store,services,f.providers);
 try {await restarted.stop();assert.equal(store.get('jobs',f.job.id).status,'submission_unknown');assert.equal(f.calls.submit,1);assert.equal(store.list('versions').length,0);}
 finally {await restarted.stop();store.close();}
});

test('accepted receipt inside the stop window is durable without starting another phase',async t=>{
 const entered=deferred(),receipt=deferred();
 const f=await shutdownFixture(t,{submit:async()=>{entered.resolve();return receipt.promise;}}),worker=f.start();
 await entered.promise;
 const stopped=worker.stop();receipt.resolve({providerJobId:'accepted-before-fence'});await stopped;
 assert.equal(f.read().providerJobId,'accepted-before-fence');assert.equal(f.read().status,'running');assert.equal(f.calls.poll,0);assert.equal(f.calls.download,0);
});

for(const stage of ['poll','reconcile','download'])test(`shutdown during ${stage} keeps original recoverable state and fences late phase/media`,async t=>{
 const entered=deferred(),result=deferred(),events=[];
 let signal;
 const f=await shutdownFixture(t,{[stage]:async(...args)=>{signal=args.at(-1).signal;entered.resolve();return result.promise;}});
 const status={poll:'running',reconcile:'submission_unknown',download:'downloading'}[stage];
 f.transition({status,providerJobId:stage==='reconcile'?null:'original-provider-task',submissionCount:1});
 const detach=onMediaProcess(event=>events.push(event));t.after(detach);
 const worker=f.start();await entered.promise;await worker.stop();
 const snapshot=structuredClone(f.read()),starts=events.filter(e=>e.type==='started').length;
 assert.equal(signal.aborted,true);assert.equal(snapshot.status,status);assert.equal(snapshot.submissionCount,1);assert.equal(f.calls.submit,0);
 f.close();result.resolve(stage==='reconcile'?{providerJobId:'late-reconciliation'}:{status:'succeeded'});await settle();await settle();
 assert.equal(f.closedTouches(),0);assert.equal(events.filter(e=>e.type==='started').length,starts);
});

test('export interruption preserves frozen multi-input snapshot and queues recovery without late probe',async t=>{
 const f=await shutdownFixture(t,{}, {reference:true}),events=[];
 f.transition({status:'cancelled'});
 const snapshot=[0,1].map(()=>({assetId:f.assets[0].id,sha256:f.assets[0].sha256}));
 const record={id:randomUUID(),projectId:f.project.id,status:'queued',snapshot,assetId:null};f.store.put('exports',record);
 const detach=onMediaProcess(event=>events.push(event));t.after(detach);
 const worker=f.start();await worker.stop();
 assert.equal(f.store.get('exports',record.id).status,'queued');assert.deepEqual(f.store.get('exports',record.id).snapshot,snapshot);assert.equal(f.store.list('versions').length,0);assert.deepEqual(events,[]);
});

test('service import shutdown gate covers write-to-probe await and removes unpublished owned file',async t=>{
 const controller=new AbortController(),f=await shutdownFixture(t,{}, {signal:controller.signal}),events=[];
 const detach=onMediaProcess(event=>events.push(event));t.after(detach);
 const pending=f.services.call('asset.import',{projectId:f.project.id,name:'Synthetic.png',mimeType:'image/png',dataBase64:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')});
 const rejected=assert.rejects(pending,{code:'OPERATION_CANCELLED'});controller.abort();await rejected;await f.services.drain();
 assert.equal(f.store.list('assets').length,0);assert.deepEqual(await readdir(path.join(f.root,'media')),[]);assert.deepEqual(events,[]);
 await assert.rejects(f.services.call('project.list'),{code:'OPERATION_CANCELLED'});
});

test('RPC reconciliation drains an ignored provider promise and cannot mutate after SQLite closes',async t=>{
 const controller=new AbortController(),entered=deferred(),result=deferred();
 const f=await shutdownFixture(t,{reconcile:async()=>{entered.resolve();return result.promise;}},{signal:controller.signal});
 f.transition({status:'submission_unknown',submissionCount:1});
 const pending=f.services.call('job.reconcile',{jobId:f.job.id}),rejected=assert.rejects(pending,{code:'OPERATION_CANCELLED'});
 await entered.promise;controller.abort();await f.services.drain();await rejected;f.close();
 result.resolve({providerJobId:'late-remote-task'});await settle();await settle();assert.equal(f.closedTouches(),0);assert.equal(f.calls.poll,0);
});

test('download abort cancels stalled read, removes only temporary bytes, and preserves existing output',async t=>{
 const f=await shutdownFixture(t),controller=new AbortController(),reading=deferred();let cancelled=0;
 const destination=path.join(f.root,'media','existing.mp4');await writeFile(destination,'existing-output');
 const response=new Response(new ReadableStream({start(stream){stream.enqueue(MP4);},pull(){reading.resolve();return new Promise(()=>{});},cancel(){cancelled++;}}));
 const pending=downloadMp4({root:f.root,destination,url:new URL('https://synthetic.invalid/output'),context:{signal:controller.signal},fetchImpl:async()=>response});
 const rejected=assert.rejects(pending,{code:'OPERATION_CANCELLED'});await reading.promise;controller.abort();await rejected;
 assert.equal(await readFile(destination,'utf8'),'existing-output');assert.deepEqual(await readdir(path.join(f.root,'media')),['existing.mp4']);assert.equal(cancelled,1);
});

test('unconfirmed owned-child termination is an explicit worker stop failure, never a successful close',{timeout:7000},async t=>{
 const entered=deferred(),ready=deferred();let child,kill;
 const f=await shutdownFixture(t,{download:async(id,destination,context)=>{
  child=spawnMedia(process.execPath,['-e',"process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']},{kind:'shutdown-fixture',signal:context.signal});
  kill=child.kill;child.kill=()=>false;child.stdout.once('data',()=>ready.resolve());entered.resolve();return new Promise(()=>{});
 }});
 f.transition({status:'downloading',providerJobId:'owned-child-task',submissionCount:1});
 const worker=f.start();await entered.promise;await ready.promise;
 try {await assert.rejects(worker.stop(),{code:'MEDIA_TERMINATION_UNCONFIRMED',terminationUnconfirmed:true});assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);}
 finally {child.kill=kill;const exited=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await exited;}
});

test('server/worker termination result validator rejects every unconfirmed outcome',()=>{
 assert.deepEqual(assertMediaTerminated([]),[]);assert.doesNotThrow(()=>assertMediaTerminated([{status:'exited'}]));
 assert.throws(()=>assertMediaTerminated([{status:'exited'},{status:'unconfirmed'}]),{code:'MEDIA_TERMINATION_UNCONFIRMED'});
});


test('retired worker operation aborts its queued probe before later semaphore release can spawn',async t=>{
 const release=deferred(),occupied=deferred(),queuedOutcome=deferred();let reservations=0,signal;
 const blockers=Array.from({length:MEDIA_PROBE_LIMITS.concurrent},()=>withProbePermit(undefined,async()=>{
  if(++reservations===MEDIA_PROBE_LIMITS.concurrent)occupied.resolve();await release.promise;
 }));
 await occupied.promise;
 const events=[],detach=onMediaProcess(event=>events.push(event));t.after(detach);
 const f=await shutdownFixture(t,{submit:async(snapshot,context)=>{
  signal=context.signal;
  probe(path.join(f.root,'media','never-created.mp4'),{signal}).then(queuedOutcome.resolve,queuedOutcome.resolve);
  throw Error('Synthetic adapter exits before its queued sibling');
 }});
 try {
  const worker=f.start();await worker.tick();
  assert.equal(f.read().status,'failed');assert.equal(signal.aborted,true);
  assert.equal((await queuedOutcome.promise).code,'MEDIA_CANCELLED');await worker.stop();
 } finally {release.resolve();await Promise.all(blockers);}
 await settle();assert.deepEqual(events,[]);
});


function queuedFollowers(f) {
 const job={...f.read(),id:randomUUID(),requestId:randomUUID(),providerJobId:null,status:'queued',phase:'waiting',submissionCount:0};
 const render={id:randomUUID(),projectId:f.project.id,status:'queued',snapshot:[{assetId:'absent-synthetic-asset',sha256:'a'.repeat(64)}],assetId:null};
 f.store.put('jobs',job);f.store.put('exports',render);
 return ()=>{assert.equal(f.store.get('jobs',job.id).status,'queued');assert.equal(f.store.get('exports',render.id).status,'queued');};
}

async function remainsStopped(worker,assertQueued) {
 assertQueued();await worker.tick();assertQueued();
 // An interval tick would have fired here if the fatal boundary had not latched.
 await new Promise(resolve=>setTimeout(resolve,250));assertQueued();
 await assert.rejects(worker.stop(),error=>error.terminationUnconfirmed===true);
}

test('ordinary unconfirmed provider/media failure stops same-cycle and future jobs/exports before explicit stop',async t=>{
 const f=await shutdownFixture(t,{download:async()=>{throw Object.assign(Error('Synthetic unconfirmed media failure'),{code:'MEDIA_TERMINATION_UNCONFIRMED',terminationUnconfirmed:true});}});
 f.transition({status:'downloading',providerJobId:'original-provider-task',submissionCount:1});
 const assertQueued=queuedFollowers(f),worker=f.start();await worker.tick();
 await remainsStopped(worker,assertQueued);
 assert.equal(f.calls.download,1);assert.equal(f.calls.submit,0);assert.equal(f.read().status,'downloading');
 assert.equal(f.read().error.code,'MEDIA_TERMINATION_UNCONFIRMED');assert.equal(f.read().error.retryable,false);
 await assert.rejects(f.services.call('job.retry',{jobId:f.job.id,requestId:randomUUID()}),{code:'UNSAFE_RETRY'});
});

test('ordinary final-reap failure latches the worker before later timer ticks can dispatch another job',{timeout:8000},async t=>{
 let child,kill;const ready=deferred();
 const f=await shutdownFixture(t,{submit:async(snapshot,context)=>{
  child=spawnMedia(process.execPath,['-e',"process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']},{kind:'ordinary-reap-fixture',signal:context.signal});
  kill=child.kill;child.kill=()=>false;child.stdout.once('data',()=>ready.resolve());await ready.promise;
  return {providerJobId:'accepted-before-unconfirmed-reap'};
 }});
 const assertQueued=queuedFollowers(f);
 try {
  const worker=f.start();await worker.tick();
  await remainsStopped(worker,assertQueued);assert.equal(f.calls.submit,1);
  assert.equal(f.read().providerJobId,'accepted-before-unconfirmed-reap');assert.equal(f.read().status,'running');
  assert.equal(f.read().error.code,'MEDIA_TERMINATION_UNCONFIRMED');assert.equal(f.read().error.retryable,false);
 } finally {
  if(child){child.kill=kill;if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill('SIGKILL');await closed;}}
 }
});

test('unconfirmed existing-result probe never falls back to provider download or advances queued work',{timeout:8000},async t=>{
 const f=await shutdownFixture(t);f.transition({status:'downloading',providerJobId:'original-provider-task',submissionCount:1});
 await writeFile(path.join(f.root,`media/result-${f.job.id}.mp4`),'Owned inert bytes for injected probe');
 const assertQueued=queuedFollowers(f),originalSpawn=ChildProcess.prototype.spawn,originalKill=ChildProcess.prototype.kill;
 let child;
 // Redirect only this test's ffprobe invocation to a real, exact-owned Node
 // child. It exceeds stdout policy and refuses injected kills, without network
 // access, a production test hook, arbitrary PID signalling, or fabricated exit.
 const spawnHook=t.mock.method(ChildProcess.prototype,'spawn',function(options){
  if(options.args?.includes('-show_streams')) {
   child=this;
   return originalSpawn.call(this,{...options,file:process.execPath,args:[process.execPath,'-e',"process.stdout.on('error',()=>{});process.stdout.write(Buffer.alloc(5*1024*1024));setInterval(()=>{},1000)"]});
  }
  return originalSpawn.call(this,options);
 });
 const killHook=t.mock.method(ChildProcess.prototype,'kill',function(signal){return this===child?false:originalKill.call(this,signal);});
 try {
  const worker=f.start();await worker.tick();
  assert.ok(child,'existing result probe must run');assert.equal(f.calls.download,0);
  await remainsStopped(worker,assertQueued);assert.equal(f.calls.submit,0);assert.equal(f.read().status,'downloading');
  assert.equal(f.read().error.code,'MEDIA_TERMINATION_UNCONFIRMED');assert.equal(f.read().error.retryable,false);
 } finally {
  spawnHook.mock.restore();killHook.mock.restore();
  if(child&&child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');originalKill.call(child,'SIGKILL');await closed;}
 }
});


test('unconfirmed export failure stays queued with its snapshot and a durable pause diagnostic',async t=>{
 const f=await shutdownFixture(t);f.transition({status:'cancelled'});
 const snapshot=[{assetId:'synthetic-unconfirmed-input',sha256:'a'.repeat(64)}];
 const render={id:randomUUID(),projectId:f.project.id,status:'queued',snapshot,assetId:null};f.store.put('exports',render);
 const originalGet=f.store.get;
 f.store.get=(table,id)=>{
  if(table==='assets'&&id==='synthetic-unconfirmed-input')throw Object.assign(Error('Synthetic unconfirmed input probe'),{code:'MEDIA_TERMINATION_UNCONFIRMED',terminationUnconfirmed:true});
  return originalGet(table,id);
 };
 const worker=f.start();await worker.tick();await assert.rejects(worker.stop(),error=>error.terminationUnconfirmed===true);
 const saved=f.store.get('exports',render.id);
 assert.equal(saved.status,'queued');assert.deepEqual(saved.snapshot,snapshot);assert.equal(saved.assetId,null);
 assert.equal(saved.error.code,'MEDIA_TERMINATION_UNCONFIRMED');assert.equal(saved.error.retryable,false);
});

test('unconfirmed media failure during ambiguous submission keeps acceptance uncertainty primary',async t=>{
 const f=await shutdownFixture(t,{submit:async()=>{throw Object.assign(Error('Synthetic ambiguous adapter/media failure'),{code:'MEDIA_TERMINATION_UNCONFIRMED',terminationUnconfirmed:true});}});
 const worker=f.start();await worker.tick();await assert.rejects(worker.stop(),error=>error.terminationUnconfirmed===true);
 assert.equal(f.read().status,'submission_unknown');assert.equal(f.read().error.code,'SUBMISSION_UNKNOWN');
 assert.match(f.read().error.message,/可能已受理/);assert.match(f.read().error.message,/媒体进程退出尚未确认/);
 await assert.rejects(f.services.call('job.retry',{jobId:f.job.id,requestId:randomUUID()}),{code:'UNSAFE_RETRY'});
});
