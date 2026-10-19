import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,chmod,rename,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createMockProvider} from '../packages/business/src/providers/mock.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';

const listing=names=>'Filters:\n  T.. = Timeline support\n'+names.map(name=>` ... ${name.padEnd(16)} V->V       Synthetic filter.\n`).join('');
const missing=listing(['scale','drawbox']),supported=listing(['scale','drawbox','drawtext']);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message){const end=Date.now()+5000;while(!await predicate()){assert.ok(Date.now()<end,message);await pause(10);}}
const input={prompt:'Owned synthetic Mock boundary fixture',duration:2,aspectRatio:'9:16',model:'mock-motion-v1',parameters:{scenario:'success',delayMs:0},referenceAssets:[]};

// Every executable and control file belongs to this test's temporary directory.
// Successful renders copy an existing synthetic MP4; these tests assert provider /
// worker boundaries, not FFmpeg rendering quality (covered by providers.test.mjs).
async function fixture(t,configuration={}){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-mock-fences-'));
 const previous={ffmpeg:process.env.MIOON_FFMPEG_PATH,path:process.env.PATH};
 const tools=path.join(root,'tools');await mkdir(tools);
 let serial=0;
 const makeTool=async(config={},directory=tools)=>{
  await mkdir(directory,{recursive:true});
  const file=path.join(directory,'ffmpeg'),control=path.join(directory,'control.json'),events=path.join(directory,'events.jsonl'),entered=path.join(directory,'entered'),release=path.join(directory,'release');
  const source=`#!${process.execPath}\nconst fs=require('node:fs');\nconst c=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));\nconst events=${JSON.stringify(events)};\nconst rows=fs.existsSync(events)?fs.readFileSync(events,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];\nconst filters=process.argv.includes('-filters');\nconst render=process.argv.includes('-vf');\nfs.appendFileSync(events,JSON.stringify(filters?'probe':render?'render':'validate')+'\\n');\nconst index=rows.filter(x=>x==='probe').length;\nconst emit=()=>{if((filters&&c.overflowProbe)||(!filters&&render&&c.overflowRender)){process.stdout.on('error',()=>{});process.stdout.write(Buffer.alloc(5*1024*1024));setInterval(()=>{},1000);return;}if(filters){process.stdout.write((c.listings??[${JSON.stringify(missing)}])[Math.min(index,(c.listings??[0]).length-1)]);process.exit(c.probeExit??0);}else if(render){if(c.renderSucceeds){fs.copyFileSync(${JSON.stringify(path.resolve('examples/timeline-synthetic/scene-a.mp4'))},process.argv.at(-1));}else process.exitCode=1;}};\nif(filters&&c.gateProbe===index){fs.writeFileSync(${JSON.stringify(entered)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);emit();}},10);setTimeout(()=>{clearInterval(timer);process.exit(2);},4500).unref();}else emit();\n`;
  await writeFile(control,JSON.stringify(config));await writeFile(file,source);await chmod(file,0o700);
  return {file,control,entered,release,source,
   configure:next=>writeFile(control,JSON.stringify(next)),
   counts:async()=>{const all=await readFile(events,'utf8').catch(()=>'');return all.trim().split('\n').filter(Boolean).map(JSON.parse);},
   repair:async(next,{replace=true}={})=>{await writeFile(control,JSON.stringify(next));const target=replace?`${file}.replacement`:file;await writeFile(target,source+`\n// repaired identity ${++serial}\n`);await chmod(target,0o700);if(replace)await rename(target,file);},
  };
 };
 const tool=await makeTool(configuration);process.env.MIOON_FFMPEG_PATH=tool.file;
 let store,provider,providers,services;const workers=[];
 const reopen=()=>{store=openStore(root);provider=createMockProvider({db:store.db,root});providers=new Map([['mock',provider]]);services=createServices(store,providers);};reopen();
 t.after(async()=>{await Promise.all(workers.map(worker=>worker.stop().catch(()=>{})));store?.close();if(previous.ffmpeg===undefined)delete process.env.MIOON_FFMPEG_PATH;else process.env.MIOON_FFMPEG_PATH=previous.ffmpeg;if(previous.path===undefined)delete process.env.PATH;else process.env.PATH=previous.path;await rm(root,{recursive:true,force:true});});
 const f={root,tool,makeTool,get store(){return store;},get provider(){return provider;},get services(){return services;},get providers(){return providers;},
  start(){const worker=startWorker(store,services,providers);workers.push(worker);return worker;},
  async reopen(){await Promise.all(workers.map(worker=>worker.stop()));store.close();store=null;reopen();},
  async task(){return (await provider.submit(input,{requestId:randomUUID()})).providerJobId;},
  async job(){const project=await services.call('project.create',{name:'Mock capability boundary'});const shot=await services.call('shot.create',{projectId:project.id,title:'Synthetic Mock capability',duration:2});const request={shotId:shot.id,expectedRevision:shot.revision,providerId:'mock',parameters:input.parameters,requestId:randomUUID()};return {job:await services.call('generation.submit',request),request};},
 };
 return f;
}

function terminal(f,id){const saved=f.store.get('jobs',id);assert.equal(saved.status,'failed');assert.equal(saved.error.code,'MOCK_RENDERER_UNSUPPORTED');assert.equal(saved.error.retryable,false);assert.equal(saved.nextPollAt??0,0);assert.equal(f.store.list('versions').length,0);return saved;}

test('unknown first filter probe followed by missing drawtext ends the actual worker download once',async t=>{
 const f=await fixture(t,{listings:['unrecognized probe\n',missing]}),{job,request}=await f.job(),worker=f.start();
 await worker.tick();await worker.tick();await worker.stop();
 const saved=terminal(f,job.id);assert.equal(saved.submissionCount,1);assert.equal(f.provider.stats().downloadAttempts,1);assert.equal(f.provider.stats().taskCount,1);
 const replay=await f.services.call('generation.submit',request);assert.equal(replay.id,job.id);assert.equal(replay.status,'failed');assert.equal(f.provider.stats().taskCount,1);
});

test('persisted downloading job reopens on its original task and terminally records proven missing drawtext',async t=>{
 const f=await fixture(t,{listings:['unknown\n']}),{job}=await f.job(),worker=f.start();await worker.tick();await worker.tick();await worker.stop();
 const previous=f.store.get('jobs',job.id);assert.equal(previous.status,'downloading');assert.equal(previous.error.retryable,true);
 await f.tool.configure({listings:[missing]});await f.reopen();
 await pause(Math.max(0,previous.nextPollAt-Date.now()+10));const resumed=f.start();await resumed.tick();await resumed.stop();
 const saved=terminal(f,job.id);assert.equal(saved.providerJobId,previous.providerJobId);assert.equal(saved.requestId,previous.requestId);assert.deepEqual(saved.snapshot,previous.snapshot);assert.equal(f.provider.stats().submissionCount,1);assert.equal(f.provider.stats().taskCount,1);
});

test('render failure with unknown capability remains retryable on the accepted task',async t=>{
 const f=await fixture(t,{listings:['unknown\n']}),{job}=await f.job(),worker=f.start();await worker.tick();await worker.tick();await worker.stop();
 const saved=f.store.get('jobs',job.id);assert.equal(saved.status,'downloading');assert.equal(saved.error.code,'MOCK_RENDER_FAILED');assert.equal(saved.error.retryable,true);assert.equal(f.provider.stats().taskCount,1);assert.equal(f.provider.stats().submissionCount,1);
});

for(const replacement of ['same-path replacement','same-path overwrite','different tool path'])test(`${replacement} permits explicit new-key retry without reviving the old request`,async t=>{
 const f=await fixture(t,{listings:[missing]}),{job,request}=await f.job(),worker=f.start();await worker.tick();await worker.tick();await worker.stop();terminal(f,job.id);
 if(replacement==='different tool path'){const other=await f.makeTool({listings:[supported],renderSucceeds:true},path.join(f.root,'other-tools'));process.env.MIOON_FFMPEG_PATH=other.file;}
 else await f.tool.repair({listings:[supported],renderSucceeds:true},{replace:replacement==='same-path replacement'});
 const replay=await f.services.call('generation.submit',request);assert.equal(replay.id,job.id);assert.equal(replay.status,'failed');assert.equal(f.provider.stats().taskCount,1);
 await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:job.requestId}));assert.equal(f.provider.stats().taskCount,1);
 const retryRequest={jobId:job.id,requestId:randomUUID()},retry=await f.services.call('job.retry',retryRequest);
 assert.notEqual(retry.id,job.id);assert.deepEqual((await f.services.call('job.retry',retryRequest)).id,retry.id);
 const resumed=f.start();await resumed.tick();await resumed.tick();await resumed.stop();
 const saved=f.store.get('jobs',retry.id);assert.equal(saved.status,'succeeded');assert.equal(saved.retryOfJobId,job.id);assert.equal(f.store.get('jobs',job.id).status,'failed');assert.equal(f.provider.stats().submissionCount,2);assert.equal(f.provider.stats().taskCount,2);assert.equal(f.store.list('versions').length,1);
});

test('default PATH lookup is never cached across a PATH change',async t=>{
 const f=await fixture(t,{listings:[missing]}),id=await f.task();delete process.env.MIOON_FFMPEG_PATH;process.env.PATH=path.dirname(f.tool.file);
 assert.equal((await f.provider.poll(id)).status,'failed');
 const other=await f.makeTool({listings:[supported]},path.join(f.root,'other-tools'));process.env.PATH=path.dirname(other.file);
 assert.equal((await f.provider.poll(id)).status,'succeeded');assert.deepEqual(await other.counts(),['probe']);
});

for(const mode of ['configured path changes','executable is replaced'])test(`in-flight filter result is unknown when ${mode}`,async t=>{
 const f=await fixture(t,{listings:[missing],gateProbe:0}),id=await f.task(),pending=f.provider.poll(id);
 await until(()=>readFile(f.tool.entered).then(()=>true,()=>false),'owned probe did not enter');
 if(mode==='configured path changes'){const other=await f.makeTool({listings:[supported]},path.join(f.root,'other-tools'));process.env.MIOON_FFMPEG_PATH=other.file;}
 else await f.tool.repair({listings:[supported]});
 await writeFile(f.tool.release,'release');assert.equal((await pending).status,'succeeded');assert.equal((await f.provider.poll(id)).status,'succeeded');
});

test('only a fully recognized filter listing may prove missing drawtext; unknown results are not cached',async t=>{
 const f=await fixture(t),id=await f.task();let index=0;
 for(const malformed of ['not a filter table\n ... scale V->V Synthetic.\n','Filters:\n garbage\n ... scale V->V Synthetic.\n','Filters:\n T.. = corrupted legend\n ... scale V->V Synthetic.\n','Filters:\n ... scale V->V Synthetic.\n drawtext row truncated\n',
  'Filters:\n ------\n ------\n ... scale V->V Synthetic.\n',
  'Filters:\n -----\n ... scale V->V Synthetic.\n',
  'Filters:\n ... scale V->V Synthetic.\n ------\n',
  'Filters:\n ------\n T.. = Timeline support\n ... scale V->V Synthetic.\n']){
  const tool=await f.makeTool({listings:[malformed,missing]},path.join(f.root,`malformed-${++index}`));process.env.MIOON_FFMPEG_PATH=tool.file;
  assert.equal((await f.provider.poll(id)).status,'succeeded');assert.equal((await f.provider.poll(id)).status,'failed');assert.deepEqual(await tool.counts(),['probe','probe']);
 }
});

test('failed filter command is unknown and is probed again',async t=>{
 const f=await fixture(t,{listings:[missing],probeExit:1}),id=await f.task();assert.equal((await f.provider.poll(id)).status,'succeeded');await f.tool.configure({listings:[missing]});assert.equal((await f.provider.poll(id)).status,'failed');assert.deepEqual(await f.tool.counts(),['probe','probe']);
});

test('unchanged configured executable caches its recognized filter listing',async t=>{
 const f=await fixture(t,{listings:[missing]}),id=await f.task();assert.equal((await f.provider.poll(id)).status,'failed');assert.equal((await f.provider.poll(id)).status,'failed');assert.deepEqual(await f.tool.counts(),['probe']);
});

// Scoped control injection uses the existing ChildProcess/media lifecycle, never
// a production knob: only this fixture executable's selected child refuses the
// runner's kills. Finally restores and kills that exact owned child and observes
// its real close; no PID guesses, fabricated exits, or surviving child are used.
async function unconfirmedChild(t,file,predicate,action){
 const spawn=ChildProcess.prototype.spawn,kill=ChildProcess.prototype.kill;let child;
 const hook=t.mock.method(ChildProcess.prototype,'spawn',function(options){if(options.file===file&&predicate(options.args)){child=this;this.kill=()=>false;}return spawn.call(this,options);});
 try{await action(()=>child);assert.ok(child,'expected exact owned fixture child');}
 finally{hook.mock.restore();if(child){child.kill=kill;if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');kill.call(child,'SIGKILL');await closed;}}}
}

test('unconfirmed filter-probe termination propagates from the actual Mock provider',{timeout:9000},async t=>{
 const f=await fixture(t,{overflowProbe:true}),id=await f.task();
 await unconfirmedChild(t,f.tool.file,args=>args.includes('-filters'),async()=>{await assert.rejects(f.provider.poll(id),error=>error.code==='MEDIA_OUTPUT_LIMIT'&&error.terminationUnconfirmed===true);});
});

test('unconfirmed render termination outranks a cached missing-drawtext result',{timeout:9000},async t=>{
 const f=await fixture(t,{listings:[missing],overflowRender:true}),id=await f.task();assert.equal((await f.provider.poll(id)).status,'failed');
 await unconfirmedChild(t,f.tool.file,args=>args.includes('-vf'),async()=>{await assert.rejects(f.provider.download(id,path.join(f.root,'media','owned.mp4')),error=>error.code==='MEDIA_OUTPUT_LIMIT'&&error.terminationUnconfirmed===true);});
});

test('unconfirmed Mock render latches worker pause before later jobs and future ticks',{timeout:9000},async t=>{
 const f=await fixture(t,{listings:['unknown\n',missing],overflowRender:true}),{job}=await f.job();const worker=f.start();await worker.tick();
 const {job:later}=await f.job();
 await unconfirmedChild(t,f.tool.file,args=>args.includes('-vf'),async()=>{
  await worker.tick();assert.equal(f.store.get('jobs',job.id).status,'downloading');assert.equal(f.store.get('jobs',job.id).error.code,'MEDIA_TERMINATION_UNCONFIRMED');assert.equal(f.store.get('jobs',job.id).error.retryable,false);
  assert.equal(f.store.get('jobs',later.id).status,'queued');await worker.tick();await pause(250);assert.equal(f.store.get('jobs',later.id).status,'queued');await assert.rejects(worker.stop(),error=>error.terminationUnconfirmed===true);assert.equal(f.provider.stats().submissionCount,1);
 });
});

test('pre-aborted Mock capability and render never spawn or rewrite cancellation',async t=>{
 const f=await fixture(t,{listings:[missing]}),id=await f.task(),controller=new AbortController(),events=[];controller.abort();const detach=onMediaProcess(event=>events.push(event));t.after(detach);
 await assert.rejects(f.provider.poll(id,{signal:controller.signal}),{code:'MEDIA_CANCELLED'});await assert.rejects(f.provider.download(id,path.join(f.root,'media','owned.mp4'),{signal:controller.signal}),{code:'MEDIA_CANCELLED'});assert.deepEqual(events,[]);
});

test('abort while a filter probe is running preserves cancellation and reaps the owned child',async t=>{
 const f=await fixture(t,{listings:[missing],gateProbe:0}),id=await f.task(),controller=new AbortController();
 const pending=assert.rejects(f.provider.poll(id,{signal:controller.signal}),{code:'MEDIA_CANCELLED'});
 await until(()=>readFile(f.tool.entered).then(()=>true,()=>false),'owned probe did not enter');controller.abort();await pending;
});

test('abort during Mock rendering takes priority over cached unsupported capability',async t=>{
 const f=await fixture(t,{listings:[missing]}),id=await f.task(),controller=new AbortController();assert.equal((await f.provider.poll(id)).status,'failed');
 const detach=onMediaProcess(event=>{if(event.type==='started'&&event.kind==='ffmpeg')controller.abort();});t.after(detach);
 await assert.rejects(f.provider.download(id,path.join(f.root,'media','owned.mp4'),{signal:controller.signal}),{code:'MEDIA_CANCELLED'});
});

for(const control of ['other provider','different error code','submission unknown'])test(`worker terminal classification does not broaden to ${control}`,async t=>{
 const f=await fixture(t,{listings:['unknown\n']}),{job}=await f.job();
 // Deliberate trusted-adapter/state control injection isolates the worker branch;
 // no external provider or submission is made by these negative controls.
 const problem=Object.assign(new Error('Synthetic classification control'),{code:control==='different error code'?'OTHER_RENDER_ERROR':'MOCK_RENDERER_UNSUPPORTED',retryable:false});
 const providerId=control==='other provider'?'synthetic-other':'mock';
 if(control==='other provider')f.providers.set(providerId,{...f.provider,id:providerId,download:async()=>{throw problem;}});
 else if(control==='submission unknown')f.provider.reconcile=async()=>{throw problem;};
 else f.provider.download=async()=>{throw problem;};
 f.store.put('jobs',{...job,providerId,status:control==='submission unknown'?'submission_unknown':'downloading',providerJobId:control==='submission unknown'?null:'synthetic-existing-task',submissionCount:1});
 const worker=f.start();await worker.tick();await worker.stop();
 const saved=f.store.get('jobs',job.id);assert.equal(saved.status,control==='submission unknown'?'submission_unknown':'downloading');assert.equal(saved.error.code,problem.code);assert.equal(saved.error.retryable,true);assert.equal(f.provider.stats().taskCount,0);assert.equal(f.provider.stats().submissionCount,0);
});


test('replacement invalidates a positive drawtext cache as well as a negative one',async t=>{
 const f=await fixture(t,{listings:[supported]}),id=await f.task();assert.equal((await f.provider.poll(id)).status,'succeeded');assert.equal((await f.provider.poll(id)).status,'succeeded');assert.deepEqual(await f.tool.counts(),['probe']);
 await f.tool.repair({listings:[missing]});assert.equal((await f.provider.poll(id)).status,'failed');assert.deepEqual(await f.tool.counts(),['probe','probe']);
});
