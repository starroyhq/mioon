import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile,unlink,symlink,truncate,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {isExportPreflightResponse,EXPORT_PREFLIGHT_LIMITS} from '@mioon/contracts';
import {openStore} from '../packages/business/src/db.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createTimelinePreflightServices,timelineSnapshotHash} from '../packages/business/src/timeline-preflight.ts';
import {readTimelinePreflightSnapshot,prepareTimelineInputs,readOwnedTimelineAsset,validateFrozenTimelineSourceGraph} from '../packages/business/src/timeline-sources.ts';
import {validateTimeline,freezeTimelineSnapshot} from '../packages/business/src/timeline-inputs.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {run} from '../packages/business/src/media.ts';
import {withProbePermit} from '../packages/business/src/media-probe.ts';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const meta=()=>({width:0,height:0,duration:1,hasAudio:true,hasVideo:false,audioStreamIndex:0,probe:{streams:[{index:0,codec_type:'audio'}]}});
function wav(){const data=Buffer.alloc(44+96000);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(48000,24);data.writeUInt32LE(96000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(96000,40);return data;}
async function fixture(t,options={}){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-preflight-')),store=openStore(root),services=createServices(store,new Map());
 const project={id:randomUUID(),name:'Synthetic owned'},other={id:randomUUID(),name:'Synthetic private foreign'};store.put('projects',project);store.put('projects',other);
 const preflight=createTimelinePreflightServices(store,{probe:async()=>meta(),...options});
 const f={root,store,services,project,other,preflight,
  input:()=>({projectId:project.id,expectedRevision:f.timeline?.revision??1}),
  call:async input=>{const arg=input??f.input(),result=await preflight.handlers['timeline.export.preflight'](arg);assert.ok(isExportPreflightResponse(result,arg),JSON.stringify(result));return result;},
  writes:()=>store.db.prepare('SELECT total_changes() AS n').get().n,
  state:()=>Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])),
  async asset(patch={}){const id=randomUUID(),bytes=patch.bytes??wav(),relativePath=`media/${id}.wav`;await writeFile(path.join(root,relativePath),bytes);const {bytes:_,...rest}=patch;return store.put('assets',{id,projectId:project.id,name:'Synthetic source',mimeType:'audio/wav',relativePath,sha256:sha(bytes),sizeBytes:bytes.length,duration:1,width:0,height:0,hasAudio:true,...rest});},
  save(timeline){f.timeline=store.put('timelines',timeline);return f.timeline;},
  async seed(patch={}){const asset=await f.asset(patch),trackId=randomUUID();f.assetValue=asset;f.save({id:randomUUID(),projectId:project.id,revision:1,fps:30,width:720,height:1280,tracks:[{id:trackId,name:'Audio',kind:'audio',orderIndex:0,hidden:false,muted:false}],clips:[{id:randomUUID(),trackId,assetId:asset.id,name:'Synthetic audio clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1}],durationFrames:30,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'});return asset;},
 };
 t.after(async()=>{await preflight.drain();await services.drain();store.close();await rm(root,{recursive:true,force:true});});return f;
}

test('preflight never initializes a legacy timeline, writes tables, or creates files',async t=>{
 const f=await fixture(t),before=f.state(),writes=f.writes(),files=await readdir(f.root,{recursive:true});
 for(let i=0;i<2;i++){const result=await f.call();assert.equal(result.status,'blocked');assert.equal(result.issues[0].code,'TIMELINE_MISSING');assert.equal(result.snapshotHash,null);}
 assert.equal(f.writes(),writes);assert.deepEqual(f.state(),before);assert.deepEqual(await readdir(f.root,{recursive:true}),files);
});

test('ready report summarizes saved state, hashes once and probes once without writes',async t=>{
 let probes=0;const f=await fixture(t,{probe:async()=>{probes++;return meta();}}),asset=await f.seed();
 f.timeline.clips.push({...f.timeline.clips[0],id:randomUUID(),startFrame:30});f.timeline.durationFrames=60;f.timeline.clips.forEach(c=>c.durationFrames=15);f.timeline.clips[1].startFrame=15;f.timeline.durationFrames=30;f.save(f.timeline);
 const before=f.state(),writes=f.writes(),bytes=await readFile(path.join(f.root,asset.relativePath)),result=await f.call();
 assert.equal(result.status,'ready');assert.equal(result.summary.clipCount,2);assert.equal(result.summary.audibleClipCount,2);assert.equal(result.summary.visualClipCount,0);assert.equal(probes,1);
 assert.deepEqual(result.checks,{totalAssets:1,checkedAssets:1,bytesHashed:bytes.length,fullDecode:false});assert.match(result.snapshotHash,/^[a-f0-9]{64}$/);
 assert.equal(result.snapshotHash,timelineSnapshotHash(readTimelinePreflightSnapshot(f.store,f.project.id).snapshot));
 assert.equal(f.writes(),writes);assert.deepEqual(f.state(),before);assert.deepEqual(await readFile(path.join(f.root,asset.relativePath)),bytes);
 assert.ok(!JSON.stringify(result).includes(f.root));assert.ok(!JSON.stringify(result).includes(asset.relativePath));
});

test('missing, corrupt and byte-replaced sources block with sanitized reasons',async t=>{
 const f=await fixture(t),asset=await f.seed(),file=path.join(f.root,asset.relativePath);await unlink(file);
 assert.equal((await f.call()).issues[0].code,'PREFLIGHT_SOURCE_INVALID');await writeFile(file,'different private bytes');
 const changed=await f.call();assert.equal(changed.status,'blocked');assert.equal(changed.issues[0].code,'PREFLIGHT_SOURCE_CHANGED');assert.ok(!JSON.stringify(changed).includes('private bytes'));
 const corrupt=createTimelinePreflightServices(f.store,{probe:async()=>{throw Object.assign(Error('SECRET /private/path'),{code:'MEDIA_EXIT_FAILED'});}});
 await writeFile(file,wav());const result=await corrupt.handlers['timeline.export.preflight'](f.input());assert.equal(result.status,'blocked');assert.equal(result.issues[0].code,'PREFLIGHT_MEDIA_INVALID');assert.ok(!JSON.stringify(result).includes('SECRET'));await corrupt.drain();
});

test('deep ownership and SQL JSON bounds prevent foreign reference and path leakage before probes',async t=>{
 let probes=0;const f=await fixture(t,{probe:async()=>{probes++;return meta();}}),asset=await f.seed();
 const update=data=>f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(data,asset.id);
 for(const data of [JSON.stringify({...asset,projectId:f.other.id,relativePath:'/secret-foreign-path'}),JSON.stringify({...asset,id:f.other.id}),JSON.stringify({...asset,padding:'SECRET'.repeat(4000)}),'{SECRET']){
  update(data);const result=await f.call();assert.equal(result.status,'blocked');assert.equal(result.issues[0].code,'TIMELINE_SOURCE_UNAVAILABLE');assert.ok(!JSON.stringify(result).includes(f.other.id));assert.ok(!JSON.stringify(result).includes('SECRET'));
 }
 update(JSON.stringify(asset));f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.other.id,asset.id);assert.equal((await f.call()).status,'blocked');assert.equal(probes,0);
 f.store.db.prepare('UPDATE timelines SET data=? WHERE id=?').run(JSON.stringify({...f.timeline,padding:'x'.repeat(256 * 1024)}),f.timeline.id);assert.equal((await f.call()).issues[0].code,'INVALID_TIMELINE_SNAPSHOT');
});

test('symlinks are refused without repairing files or permissions',async t=>{
 const f=await fixture(t),asset=await f.seed(),file=path.join(f.root,asset.relativePath),target=path.join(f.root,'private.wav');await writeFile(target,wav());await unlink(file);await symlink(target,file);
 assert.equal((await f.call()).issues[0].code,'PREFLIGHT_SOURCE_INVALID');assert.deepEqual(await readFile(target),wav());
});

test('caps and exhausted total budget return incomplete while legacy rendering still queues',async t=>{
 const f=await fixture(t,{limits:{...EXPORT_PREFLIGHT_LIMITS,sourceBytes:8}});await f.seed();
 const result=await f.call();assert.equal(result.status,'incomplete');assert.equal(result.issues[0].code,'PREFLIGHT_BUDGET');assert.equal(result.checks.bytesHashed,0);
 const exportResult=await f.services.call('timeline.render',{...f.input(),requestId:randomUUID(),purpose:'export',preflightSnapshotHash:result.snapshotHash});assert.equal(exportResult.status,'queued');
 const total=createTimelinePreflightServices(f.store,{probe:async()=>meta(),limits:{...EXPORT_PREFLIGHT_LIMITS,totalBytes:8}});assert.equal((await total.handlers['timeline.export.preflight'](f.input())).status,'incomplete');await total.drain();
});

test('stale revision and source metadata drift never publish ready',async t=>{
 let probes=0;const f=await fixture(t,{probe:async()=>{probes++;f.store.put('assets',{...f.assetValue,duration:2});return meta();}});await f.seed();
 assert.equal((await f.call({...f.input(),expectedRevision:2})).status,'stale');assert.equal(probes,0);
 const result=await f.call();assert.equal(result.status,'stale');assert.equal(result.issues[0].code,'PREFLIGHT_STALE');assert.equal(probes,1);
});

test('source reassignment during a probe is stale without disclosing the foreign owner',async t=>{
 const f=await fixture(t,{probe:async()=>{f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.other.id,JSON.stringify({...f.assetValue,projectId:f.other.id}),f.assetValue.id);return meta();}});await f.seed();
 const result=await f.call();assert.equal(result.status,'stale');assert.ok(!JSON.stringify(result).includes(f.other.id));
});

test('new digest render rejects drift after CAS, but exact replay returns original bytes',async t=>{
 const f=await fixture(t);await f.seed();const report=await f.call(),input={...f.input(),requestId:randomUUID(),purpose:'export',preflightSnapshotHash:report.snapshotHash};
 const first=await f.services.call('timeline.render',input),saved=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
 f.store.put('assets',{...f.assetValue,duration:2});const writes=f.writes();
 assert.deepEqual(await f.services.call('timeline.render',input),first);assert.equal(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,saved);assert.equal(f.writes(),writes);
 await assert.rejects(f.services.call('timeline.render',{...input,requestId:randomUUID()}),{code:'PREFLIGHT_STALE'});assert.equal(f.writes(),writes);
 await assert.rejects(f.services.call('timeline.render',{...input,requestId:randomUUID(),expectedRevision:2}),{code:'REVISION_CONFLICT'});
 const legacy=await f.services.call('timeline.render',{...f.input(),requestId:randomUUID(),purpose:'preview'});assert.equal(legacy.status,'queued');assert.ok(!Object.hasOwn(legacy,'preflightSnapshotHash'));
});

test('one active check has no queue; time budget cancels late work without writes',async t=>{
 const gate=deferred(),entered=deferred();let probes=0;const f=await fixture(t,{limits:{...EXPORT_PREFLIGHT_LIMITS,timeoutMs:35},probe:async()=>{probes++;entered.resolve();await gate.promise;return meta();}});await f.seed();const before=f.state(),writes=f.writes();
 const pending=f.call();await entered.promise;const busy=await f.call();assert.equal(busy.status,'incomplete');assert.equal(busy.issues[0].code,'PREFLIGHT_BUSY');
 const result=await pending;assert.equal(result.status,'incomplete');assert.equal(result.issues[0].code,'PREFLIGHT_TIMEOUT');const returned=clone(result);gate.resolve();await tick();await tick();assert.deepEqual(result,returned);assert.equal(probes,1);assert.equal(f.writes(),writes);assert.deepEqual(f.state(),before);
});

test('drain cancels pending read and late probe completion cannot publish or read a closed store',async t=>{
 const gate=deferred(),entered=deferred();const f=await fixture(t,{probe:async()=>{entered.resolve();await gate.promise;return meta();}});await f.seed();const before=f.state(),writes=f.writes();
 const pending=f.call(),rejected=assert.rejects(pending,{code:'OPERATION_CANCELLED'});await entered.promise;let drained=false;const draining=f.preflight.drain().then(()=>{drained=true;});await rejected;await tick();assert.equal(drained,false);assert.equal(f.writes(),writes);assert.deepEqual(f.state(),before);gate.resolve();await draining;await tick();assert.equal(f.writes(),writes);
});

test('cancelled queued probe never spawns and ready checks launch only ffprobe',async t=>{
 const gate=deferred(),occupied=deferred();let occupiedCount=0;
 const holds=Array.from({length:4},()=>withProbePermit(undefined,async()=>{if(++occupiedCount===4)occupied.resolve();await gate.promise;}));await occupied.promise;
 const f=await fixture(t,{probe:undefined,limits:{...EXPORT_PREFLIGHT_LIMITS,timeoutMs:25}});await f.seed();const events=[],off=onMediaProcess(event=>events.push(event));
 try{assert.equal((await f.call()).status,'incomplete');assert.deepEqual(events,[]);}finally{gate.resolve();await Promise.all(holds);off();}
 const real=createTimelinePreflightServices(f.store),realEvents=[],unsubscribe=onMediaProcess(event=>realEvents.push(event));
 try{const report=await real.handlers['timeline.export.preflight'](f.input());assert.equal(report.status,'ready');assert.deepEqual(realEvents.filter(e=>e.type==='started').map(e=>e.kind),['ffprobe']);}finally{unsubscribe();await real.drain();}
});

test('playlist-shaped bytes cannot make the restricted metadata probe contact a network endpoint',async t=>{
 let requests=0;const server=createServer((req,res)=>{requests++;res.end('not media');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const f=await fixture(t,{probe:undefined});await f.seed({bytes:Buffer.from(`#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1:${server.address().port}/private\n`)});
 const result=await f.call();assert.equal(result.status,'blocked');assert.equal(requests,0);assert.equal(result.checks.fullDecode,false);
});

test('shared renderer validator retains precise legacy messages and input preparation is uncapped by default',async t=>{
 assert.throws(()=>validateTimeline({},new Map()),{code:'INVALID_TIMELINE_SNAPSHOT',message:'Timeline output must match a supported 720 or 1080 preset at 30 fps'});
 const f=await fixture(t);await f.seed();const snapshot=readTimelinePreflightSnapshot(f.store,f.project.id).snapshot;let probes=0;
 const assets=await prepareTimelineInputs(snapshot,{root:f.root,projectId:f.project.id,readAsset:id=>readOwnedTimelineAsset(f.store.db,f.project.id,id),probe:async()=>{probes++;return meta();}});
 assert.equal(assets.size,1);assert.equal(probes,1);assert.equal(assets.get(f.assetValue.id).hasAudio,true);
});

test('ready matches saved enqueue duration/fade rules and unknown legacy audio is verified by probe',async t=>{
 const f=await fixture(t);await f.seed();
 f.store.put('assets',{...f.assetValue,duration:.5});assert.equal((await f.call()).status,'blocked');
 await assert.rejects(f.services.call('timeline.render',{...f.input(),requestId:randomUUID(),purpose:'export'}),{code:'SOURCE_BOUNDS'});
 f.store.put('assets',{...f.assetValue,hasAudio:undefined});let report=await f.call();assert.equal(report.status,'ready');assert.equal(report.summary.audibleClipCount,1);
 f.timeline.clips[0].fadeInFrames=1;f.save(f.timeline);report=await f.call();assert.equal(report.status,'blocked');
 await assert.rejects(f.services.call('timeline.render',{...f.input(),requestId:randomUUID(),purpose:'export'}),{code:'FADE_AUDIO_UNSUPPORTED'});
});

test('optional foreign clip lineage and generated reverse ownership block before filesystem work',async t=>{
 let probes=0;const f=await fixture(t,{probe:async()=>{probes++;return meta();}});await f.seed();const original=clone(f.timeline),foreign=randomUUID();
 for(const field of ['versionId','shotId','jobId']){f.save({...clone(original),clips:[{...clone(original.clips[0]),[field]:foreign}]});const report=await f.call();assert.equal(report.status,'blocked');assert.ok(!JSON.stringify(report).includes(foreign));}
 f.save(original);f.store.put('assets',{...f.assetValue,provenance:'generated'});assert.equal((await f.call()).status,'blocked');assert.equal(probes,0);
 f.store.put('assets',f.assetValue);const jobId=randomUUID(),versionId=randomUUID();f.store.put('jobs',{id:jobId,projectId:f.other.id});f.store.put('versions',{id:versionId,projectId:f.other.id,jobId,assetId:f.assetValue.id});
 const report=await f.call();assert.equal(report.status,'blocked');assert.equal(probes,0);assert.ok(!JSON.stringify(report).includes(versionId));assert.ok(!JSON.stringify(report).includes(f.other.id));
});

test('oversized relational timeline identity is replaced with SQL NULL before materialization',async t=>{
 const f=await fixture(t);await f.seed();f.store.db.prepare('UPDATE timelines SET id=? WHERE id=?').run('secret'.repeat(350000),f.timeline.id);
 const original=f.store.db.prepare.bind(f.store.db);let sawTimeline=false;
 const mocked=t.mock.method(f.store.db,'prepare',function(sql){const statement=original(sql);if(sql.includes('FROM timelines WHERE projectId=')){const get=statement.get.bind(statement);statement.get=(...args)=>{const row=get(...args);assert.equal(row.id,null);sawTimeline=true;return row;};}return statement;});
 try{assert.equal((await f.call()).status,'blocked');assert.equal(sawTimeline,true);}finally{mocked.mock.restore();}
});

test('a caller deadline retains the exact uncooperative preparation admission until settlement',async t=>{
 const gate=deferred(),entered=deferred(),cleanup=deferred(),cleanupEntered=deferred(),settled=deferred();
 let probes=0,activeProbes=0,maximumActive=0;
 const f=await fixture(t,{probe:async()=>{
  const first=++probes===1;maximumActive=Math.max(maximumActive,++activeProbes);
  try{if(first){entered.resolve();await gate.promise;}return meta();}
  finally{if(first){cleanupEntered.resolve();await cleanup.promise;}activeProbes--;if(first)settled.resolve();}
 }});await f.seed();const before=f.state(),writes=f.writes();
 // Move only the production deadline timer. Filesystem open/hash/close still
 // completes normally, and the probe must actually enter before time expires.
 // Keep a real bounded observation deadline independent of the mocked clock.
 const realTimeout=setTimeout,realClearTimeout=clearTimeout;
 const bounded=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{
  timer=realTimeout(()=>reject(Error(`${label} did not settle within 3 seconds`)),3000);
 })]);}finally{realClearTimeout(timer);}};
 t.mock.timers.enable({apis:['setTimeout']});let pending;
 try{
  pending=f.call();await bounded(entered.promise,'Initial probe entry');
  t.mock.timers.tick(EXPORT_PREFLIGHT_LIMITS.timeoutMs);
  const result=await bounded(pending,'Caller deadline');assert.equal(result.issues[0].code,'PREFLIGHT_TIMEOUT');const returned=clone(result);
  assert.equal((await bounded(f.call(),'Held probe admission')).issues[0].code,'PREFLIGHT_BUSY');assert.equal(probes,1);
  gate.resolve();await bounded(cleanupEntered.promise,'Probe cleanup entry');
  assert.equal((await bounded(f.call(),'Held cleanup admission')).issues[0].code,'PREFLIGHT_BUSY','returned probe value cannot release an outstanding cleanup');
  assert.equal(activeProbes,1);assert.equal(probes,1);
  cleanup.resolve();await bounded(settled.promise,'Exact probe settlement');
  const next=await bounded((async()=>{
   // Admission is authoritative only after preparation and its owned cleanup
   // settle. Observe it rather than assuming any fixed count of event-loop ticks.
   const until=performance.now()+2500;
   while(performance.now()<until){const value=await f.call();if(value.issues[0]?.code!=='PREFLIGHT_BUSY')return value;await tick();}
   throw Error('Settled preparation did not release admission');
  })(),'Preparation admission release');
  assert.equal(next.status,'ready');assert.equal(probes,2);assert.equal(maximumActive,1);
  assert.deepEqual(result,returned);assert.equal(f.writes(),writes);assert.deepEqual(f.state(),before);
 }finally{gate.resolve();cleanup.resolve();t.mock.timers.reset();if(pending)await bounded(pending.catch(()=>{}),'Caller cleanup settlement');}
});

test('valid imported, generated, mock and export source ownership all remain usable',async t=>{
 const f=await fixture(t);await f.seed();
 for(const provenance of [undefined,'user-import','export']){f.store.put('assets',{...f.assetValue,provenance});assert.equal((await f.call()).status,'ready');}
 const shotId=randomUUID(),jobId=randomUUID(),versionId=randomUUID();
 f.store.put('shots',{id:shotId,projectId:f.project.id,referenceAssetIds:[]});
 f.store.put('jobs',{id:jobId,projectId:f.project.id,shotId,versionId});
 f.store.put('versions',{id:versionId,projectId:f.project.id,jobId,shotId,assetId:f.assetValue.id,sha256:f.assetValue.sha256});
 for(const provenance of ['generated','synthetic-mock']){f.store.put('assets',{...f.assetValue,provenance});assert.equal((await f.call()).status,'ready');}
 f.timeline.clips[0]={...f.timeline.clips[0],versionId,shotId,jobId};f.save(f.timeline);assert.equal((await f.call()).status,'ready');
});

test('bounded graph metadata exhaustion is incomplete and never reported as corrupt media',async t=>{
 let probes=0;const f=await fixture(t,{probe:async()=>{probes++;return meta();}});await f.seed();const template=clone(f.timeline.clips[0]);f.timeline.clips=[];
 for(let i=0;i<42;i++){
  const asset={...f.assetValue,id:randomUUID(),provenance:'generated'},shotId=randomUUID(),jobId=randomUUID(),versionId=randomUUID();
  f.store.put('assets',asset);f.store.put('shots',{id:shotId,projectId:f.project.id,referenceAssetIds:[]});
  f.store.put('jobs',{id:jobId,projectId:f.project.id,shotId,versionId,padding:'x'.repeat(100000)});
  f.store.put('versions',{id:versionId,projectId:f.project.id,jobId,shotId,assetId:asset.id,sha256:asset.sha256});
  f.timeline.clips.push({...template,id:randomUUID(),assetId:asset.id,startFrame:i*30});
 }
 f.timeline.durationFrames=42*30;f.save(f.timeline);const writes=f.writes();const report=await f.call();
 assert.equal(report.status,'incomplete');assert.equal(report.snapshotHash,null);assert.equal(report.issues[0].code,'PREFLIGHT_SNAPSHOT_BUDGET');assert.equal(probes,0);assert.equal(f.writes(),writes);
 const snapshot=freezeTimelineSnapshot(f.timeline,new Map(f.store.list('assets',f.project.id).map(a=>[a.id,a])));
 snapshot.assets.forEach(a=>{delete a.relativePath;delete a.hasAudio;});
 const prepared=await prepareTimelineInputs(snapshot,{root:f.root,projectId:f.project.id,readAsset:id=>readOwnedTimelineAsset(f.store.db,f.project.id,id),
  validateLinks:timeline=>validateFrozenTimelineSourceGraph(f.store.db,f.project.id,timeline),probe:async()=>{probes++;return meta();}});
 assert.equal(prepared.size,42);assert.equal(probes,42);assert.equal(f.writes(),writes);
 snapshot.timeline.clips.at(-1).versionId=randomUUID();let touched=0;
 await assert.rejects(prepareTimelineInputs(snapshot,{root:f.root,projectId:f.project.id,readAsset:()=>{touched++;return null;},
  validateLinks:timeline=>validateFrozenTimelineSourceGraph(f.store.db,f.project.id,timeline),probe:async()=>{touched++;return meta();}}));
 assert.equal(touched,0);

});

test('legacy recovered snapshots with omitted relativePath and hasAudio still prepare actual media',async t=>{
 const f=await fixture(t);await f.seed();const snapshot=readTimelinePreflightSnapshot(f.store,f.project.id).snapshot;
 delete snapshot.assets[0].relativePath;delete snapshot.assets[0].hasAudio;
 const assets=await prepareTimelineInputs(snapshot,{root:f.root,projectId:f.project.id,readAsset:id=>readOwnedTimelineAsset(f.store.db,f.project.id,id),probe:async()=>meta()});
 assert.equal(assets.get(f.assetValue.id).hasAudio,true);assert.ok(assets.get(f.assetValue.id).path.endsWith('.wav'));assert.equal(Object.hasOwn(snapshot.assets[0],'relativePath'),false);assert.equal(Object.hasOwn(snapshot.assets[0],'hasAudio'),false);
});

test('restricted metadata probe accepts PNG JPEG WEBP MP4 WebM MP3 WAV and M4A with no full-decode process',async t=>{
 const f=await fixture(t,{probe:undefined});await f.seed();
 const recipes=[
  ['png','image/png',['-f','lavfi','-i','color=c=red:s=16x16:d=1','-frames:v','1','-c:v','png','-threads','1']],
  ['jpg','image/jpeg',['-f','lavfi','-i','color=c=red:s=16x16:d=1','-frames:v','1','-c:v','mjpeg','-threads','1']],
  ['webp','image/webp',['-f','lavfi','-i','color=c=red:s=16x16:d=1','-frames:v','1','-c:v','libwebp','-threads','1']],
  ['mp4','video/mp4',['-f','lavfi','-i','color=c=red:s=16x16:r=30:d=1','-c:v','libx264','-pix_fmt','yuv420p','-threads','1']],
  ['webm','video/webm',['-f','lavfi','-i','color=c=red:s=16x16:r=30:d=1','-c:v','libvpx-vp9','-threads','1']],
  ['mp3','audio/mpeg',['-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','libmp3lame','-threads','1']],
  ['wav','audio/wav',['-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','pcm_s16le','-threads','1']],
  ['m4a','audio/mp4',['-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','aac','-threads','1']],
 ];
 for(const [ext,mimeType,args] of recipes){
  const relativePath=`media/fixture-${ext}.${ext}`,file=path.join(f.root,relativePath);await run('ffmpeg',['-hide_banner','-loglevel','error','-n',...args,file]);
  const bytes=await readFile(file),audio=mimeType.startsWith('audio/');f.store.put('assets',{...f.assetValue,mimeType,relativePath,sha256:sha(bytes),sizeBytes:bytes.length,duration:mimeType.startsWith('image/')?0:1,width:audio?0:16,height:audio?0:16,hasAudio:audio});
  f.timeline.tracks[0].kind=audio?'audio':'video';f.save(f.timeline);const events=[],off=onMediaProcess(event=>events.push(event));
  try{const report=await f.call();assert.equal(report.status,'ready',`${ext}: ${JSON.stringify(report)}`);assert.equal(report.checks.fullDecode,false);assert.deepEqual(events.filter(e=>e.type==='started').map(e=>e.kind),['ffprobe']);}finally{off();}
 }
});

test('default source byte cap rejects sparse oversized files before SHA or probe',async t=>{
 let probes=0;const f=await fixture(t,{probe:async()=>{probes++;return meta();}}),asset=await f.seed();await truncate(path.join(f.root,asset.relativePath),EXPORT_PREFLIGHT_LIMITS.sourceBytes+1);
 const report=await f.call();assert.equal(report.status,'incomplete');assert.equal(report.issues[0].code,'PREFLIGHT_BUDGET');assert.equal(report.checks.bytesHashed,0);assert.equal(probes,0);
});

test('unconfirmed owned media termination fences later checks and prevents successful drain',async t=>{
 const f=await fixture(t);await f.seed();const failure=Object.assign(Error('Synthetic unconfirmed process'),{code:'MEDIA_OUTPUT_LIMIT',terminationUnconfirmed:true});
 const service=createTimelinePreflightServices(f.store,{probe:async()=>{throw failure;}});
 await assert.rejects(service.handlers['timeline.export.preflight'](f.input()),error=>error===failure);
 await assert.rejects(service.handlers['timeline.export.preflight'](f.input()),error=>error===failure);
 await assert.rejects(service.drain(),error=>error===failure);
});

test('recovered snapshots bind the exact expected project and contain only referenced assets before file work',async t=>{
 const f=await fixture(t);await f.seed();const original=readTimelinePreflightSnapshot(f.store,f.project.id).snapshot;
 const cases=[
  snapshot=>{snapshot.timeline.projectId=f.other.id;},
  snapshot=>{delete snapshot.timeline.projectId;},
  snapshot=>{snapshot.assets.push({...snapshot.assets[0],id:randomUUID()});},
  snapshot=>{snapshot.assets.push({...snapshot.assets[0],id:randomUUID(),projectId:f.other.id,relativePath:'/foreign/private-file.wav'});},
  snapshot=>{snapshot.assets=[];},
 ];
 for(const mutate of cases){const snapshot=clone(original);mutate(snapshot);let reads=0,probes=0,graphs=0;
  await assert.rejects(prepareTimelineInputs(snapshot,{root:f.root,projectId:f.project.id,readAsset:()=>{reads++;return f.assetValue;},
   probe:async()=>{probes++;return meta();},validateLinks:()=>{graphs++;}}),{code:'INVALID_TIMELINE_SNAPSHOT'});
  assert.deepEqual({reads,probes,graphs},{reads:0,probes:0,graphs:0});
 }
});

const exportRecord=(f,status='queued',extra={})=>({id:randomUUID(),projectId:f.project.id,mode:'timeline',purpose:'export',status,
 timelineRevision:f.timeline.revision,snapshot:freezeTimelineSnapshot(f.timeline,new Map([[f.assetValue.id,f.assetValue]])),requestId:randomUUID(),assetId:null,url:null,error:null,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',...extra});
const exportRows=f=>f.store.db.prepare('SELECT id,projectId,data FROM exports ORDER BY rowid').all();

test('worker startup and queued enumeration leave aliased foreign malformed and oversized timeline rows untouched',async t=>{
 for(const status of ['running','queued'])await t.test(status,async t=>{
  const f=await fixture(t);await f.seed();const rows=[
   {...exportRecord(f,status),projectId:f.other.id},
   {...exportRecord(f,status),id:randomUUID()},
   {...exportRecord(f,status),snapshot:{...exportRecord(f,status).snapshot,timeline:{...f.timeline,projectId:f.other.id}}},
   {...exportRecord(f,status),padding:'SECRET'.repeat(750000)},
  ];
  const insert=f.store.db.prepare('INSERT INTO exports(id,projectId,data) VALUES(?,?,?)');
  rows.forEach((record,index)=>insert.run(index===1?randomUUID():record.id,f.project.id,JSON.stringify(record)));
  insert.run(randomUUID(),f.project.id,'{SECRET corrupt');
  const hugeIdentity=exportRecord(f,status);insert.run('SECRET'.repeat(350000),f.project.id,JSON.stringify(hugeIdentity));
  const before=exportRows(f),writes=f.writes(),events=[],diagnostics=[],off=onMediaProcess(event=>events.push(event));const mocked=t.mock.method(console,'error',(...args)=>diagnostics.push(args));
  const owner=new AbortController();if(status==='running')owner.abort();const worker=startWorker(f.store,f.services,new Map(),{signal:owner.signal});
  try{await worker.tick();await worker.stop();assert.equal(f.writes(),writes);assert.deepEqual(exportRows(f),before);assert.deepEqual(events,[]);assert.equal(diagnostics.length,1);assert.deepEqual(diagnostics[0],['Skipped invalid local export record.']);}
  finally{off();mocked.mock.restore();await worker.stop();}
 });
});

test('worker keeps valid timeline recovery and large ordinary storyboard recovery compatible',async t=>{
 const f=await fixture(t);await f.seed();const normal=exportRecord(f,'running');delete normal.snapshot.assets[0].relativePath;delete normal.snapshot.assets[0].hasAudio;
 const legacy={id:randomUUID(),projectId:f.project.id,status:'running',requestId:randomUUID(),snapshot:[],orderedVersionIds:[],padding:'x'.repeat(5*1024*1024),createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};
 f.store.put('exports',normal);f.store.put('exports',legacy);const owner=new AbortController();owner.abort();const worker=startWorker(f.store,f.services,new Map(),{signal:owner.signal});await worker.stop();
 const recovered=f.store.get('exports',normal.id),storyboard=f.store.get('exports',legacy.id);assert.equal(recovered.status,'queued');assert.deepEqual(recovered.snapshot,normal.snapshot);assert.equal(storyboard.status,'queued');assert.equal(storyboard.padding,legacy.padding);assert.deepEqual(storyboard.snapshot,legacy.snapshot);
});

test('worker rechecks relational identity inside recovery and queued status transactions before the first write',async t=>{
 for(const status of ['running','queued'])await t.test(status,async t=>{
  const f=await fixture(t);await f.seed();const record=exportRecord(f,status);f.store.put('exports',record);const data=exportRows(f)[0].data;
  const originalTx=f.store.tx;let moved=false,puts=0;f.store.tx=fn=>{if(!moved){moved=true;f.store.db.prepare('UPDATE exports SET projectId=? WHERE id=?').run(f.other.id,record.id);}return originalTx(fn);};
  const put=f.store.put;f.store.put=(table,value)=>{if(table==='exports')puts++;return put(table,value);};const mocked=t.mock.method(console,'error',()=>{}),events=[],off=onMediaProcess(event=>events.push(event));
  const owner=new AbortController();if(status==='running')owner.abort();const worker=startWorker(f.store,f.services,new Map(),{signal:owner.signal});
  try{await worker.tick();await worker.stop();assert.equal(moved,true);assert.equal(puts,0);assert.equal(exportRows(f)[0].data,data);assert.equal(exportRows(f)[0].projectId,f.other.id);assert.deepEqual(events,[]);}finally{off();mocked.mock.restore();await worker.stop();}
 });
});

test('worker rechecks the timeline export owner after preparation before renderer dispatch',async t=>{
 const f=await fixture(t);await f.seed();const record=exportRecord(f);f.store.put('exports',record);let moved=false,dataAtMove;const events=[];
 const off=onMediaProcess(event=>{events.push(event);if(event.type==='started'&&event.kind==='ffprobe'&&!moved){moved=true;dataAtMove=exportRows(f)[0].data;f.store.db.prepare('UPDATE exports SET projectId=? WHERE id=?').run(f.other.id,record.id);}}),mocked=t.mock.method(console,'error',()=>{});
 const worker=startWorker(f.store,f.services,new Map());
 try{await worker.tick();await worker.stop();assert.equal(moved,true);assert.equal(exportRows(f)[0].data,dataAtMove);assert.deepEqual(events.filter(e=>e.type==='started').map(e=>e.kind),['ffprobe']);assert.equal(f.store.list('assets').length,1);assert.deepEqual((await readdir(path.join(f.root,'media'))).sort(),[path.basename(f.assetValue.relativePath)]);}
 finally{off();mocked.mock.restore();await worker.stop();}
});

test('worker rechecks relational ownership after rendering and never publishes to a reassigned row',async t=>{
 const f=await fixture(t);await f.seed();f.timeline.clips[0].durationFrames=1;f.timeline.durationFrames=1;f.save(f.timeline);const record=exportRecord(f);f.store.put('exports',record);let moved=false,dataAtMove;
 const off=onMediaProcess(event=>{if(event.type==='started'&&event.kind==='ffmpeg'&&!moved){moved=true;dataAtMove=exportRows(f)[0].data;f.store.db.prepare('UPDATE exports SET projectId=? WHERE id=?').run(f.other.id,record.id);}}),mocked=t.mock.method(console,'error',()=>{});const worker=startWorker(f.store,f.services,new Map());
 try{await worker.tick();await worker.stop();assert.equal(moved,true);assert.equal(exportRows(f)[0].data,dataAtMove);assert.equal(f.store.list('assets').length,1);assert.deepEqual((await readdir(path.join(f.root,'media'))).sort(),[path.basename(f.assetValue.relativePath)]);}
 finally{off();mocked.mock.restore();await worker.stop();}
});

test('worker timeline failure guard and status write share one transaction and preserve a reassigned row',async t=>{
 const f=await fixture(t);await f.seed();await unlink(path.join(f.root,f.assetValue.relativePath));const record=exportRecord(f);f.store.put('exports',record);
 const originalTx=f.store.tx;let transactions=0,dataAtMove;f.store.tx=fn=>{if(++transactions===2){dataAtMove=exportRows(f)[0].data;f.store.db.prepare('UPDATE exports SET projectId=? WHERE id=?').run(f.other.id,record.id);}return originalTx(fn);};
 const mocked=t.mock.method(console,'error',()=>{}),events=[],off=onMediaProcess(event=>events.push(event));const worker=startWorker(f.store,f.services,new Map());
 try{await worker.tick();await worker.stop();assert.ok(transactions>=2);assert.equal(exportRows(f)[0].data,dataAtMove);assert.deepEqual(events,[]);assert.equal(f.store.get('exports',record.id).error,null);}
 finally{off();mocked.mock.restore();await worker.stop();}
});

test('worker rejects malformed 36-character and traversal UUID identities before recovery status or filename use',async t=>{
 const identities=['../../../../'+'x'.repeat(24),'x'.repeat(36),'00000000-0000-0000-0000-00000000000z'];
 for(const status of ['running','queued'])await t.test(status,async t=>{
  const f=await fixture(t);await f.seed();const insert=f.store.db.prepare('INSERT INTO exports(id,projectId,data) VALUES(?,?,?)');
  for(const bad of identities){
   assert.equal(bad.length,36);const row=exportRecord(f,status,{id:bad});insert.run(bad,f.project.id,JSON.stringify(row));
   f.store.put('projects',{id:bad,name:'Synthetic invalid identity'});const projectRow=exportRecord(f,status,{projectId:bad});projectRow.snapshot.timeline.projectId=bad;insert.run(projectRow.id,bad,JSON.stringify(projectRow));
  }
  const before=exportRows(f),writes=f.writes(),files=await readdir(f.root,{recursive:true}),events=[],off=onMediaProcess(event=>events.push(event));const mocked=t.mock.method(console,'error',()=>{});const owner=new AbortController();if(status==='running')owner.abort();const worker=startWorker(f.store,f.services,new Map(),{signal:owner.signal});
  try{await worker.tick();await worker.stop();assert.equal(f.writes(),writes);assert.deepEqual(exportRows(f),before);assert.deepEqual(events,[]);assert.deepEqual(await readdir(f.root,{recursive:true}),files);}
  finally{off();mocked.mock.restore();await worker.stop();}
 });
});

test('SQL rejects duplicate mode keys before oversized timeline JSON can bypass its materialization cap',async t=>{
 const f=await fixture(t);await f.seed();const insert=f.store.db.prepare('INSERT INTO exports(id,projectId,data) VALUES(?,?,?)');
 for(const escaped of [false,true]){const row=exportRecord(f,'running'),body=JSON.stringify({...row,padding:'x'.repeat(5*1024*1024)});const data='{"mode":"storyboard",'+body.slice(1).replace('"mode":"timeline"',escaped?'"m\\u006fde":"timeline"':'"mode":"timeline"');insert.run(row.id,f.project.id,data);}
 for(const malformed of [JSON.stringify('x'.repeat(5*1024*1024)),JSON.stringify([{...exportRecord(f,'running'),padding:'x'.repeat(5*1024*1024)}])])insert.run(randomUUID(),f.project.id,malformed);
 const singleEscaped=exportRecord(f,'running');insert.run(singleEscaped.id,f.project.id,JSON.stringify({...singleEscaped,padding:'x'.repeat(5*1024*1024)}).replace('"mode":"timeline"','"m\\u006fde":"timeline"'));
 const before=exportRows(f),writes=f.writes(),events=[],off=onMediaProcess(event=>events.push(event));const original=f.store.db.prepare.bind(f.store.db);let seen=0;
 const prepare=t.mock.method(f.store.db,'prepare',function(sql){const statement=original(sql);if(sql.startsWith('SELECT CASE')&&sql.endsWith('FROM exports')){const all=statement.all.bind(statement);statement.all=(...args)=>{const rows=all(...args);rows.forEach(row=>assert.equal(row.data,null));seen++;return rows;};}return statement;});
 const mocked=t.mock.method(console,'error',()=>{}),owner=new AbortController();owner.abort();const worker=startWorker(f.store,f.services,new Map(),{signal:owner.signal});
 try{await worker.stop();assert.ok(seen);assert.equal(f.writes(),writes);assert.deepEqual(exportRows(f),before);assert.deepEqual(events,[]);}
 finally{off();mocked.mock.restore();prepare.mock.restore();await worker.stop();}
});

test('worker row identity cannot be bypassed by absent storyboard or relabeled legacy mode',async t=>{
 for(const status of ['running','queued'])await t.test(status,async t=>{
  const f=await fixture(t);await f.seed();const insert=f.store.db.prepare('INSERT INTO exports(id,projectId,data) VALUES(?,?,?)');
  for(const mode of [undefined,'storyboard','legacy']){
   const foreign=exportRecord(f,status,{mode,projectId:f.other.id,snapshot:[]});insert.run(foreign.id,f.project.id,JSON.stringify(foreign));
   const alias=exportRecord(f,status,{mode,snapshot:[]});insert.run(randomUUID(),f.project.id,JSON.stringify(alias));
  }
  const before=exportRows(f),writes=f.writes(),events=[],off=onMediaProcess(event=>events.push(event)),mocked=t.mock.method(console,'error',()=>{}),owner=new AbortController();if(status==='running')owner.abort();const worker=startWorker(f.store,f.services,new Map(),{signal:owner.signal});
  try{await worker.tick();await worker.stop();assert.equal(f.writes(),writes);assert.deepEqual(exportRows(f),before);assert.deepEqual(events,[]);}
  finally{off();mocked.mock.restore();await worker.stop();}
 });
});

test('timeline byte mismatch preserves path-free legacy worker error text and preflight classification',async t=>{
 const f=await fixture(t);await f.seed();const snapshot=readTimelinePreflightSnapshot(f.store,f.project.id).snapshot;await writeFile(path.join(f.root,f.assetValue.relativePath),'synthetic changed bytes');let probes=0;
 await assert.rejects(prepareTimelineInputs(snapshot,{root:f.root,projectId:f.project.id,readAsset:id=>readOwnedTimelineAsset(f.store.db,f.project.id,id),probe:async()=>{probes++;return meta();}}),error=>error.code==='MANAGED_SOURCE_CHANGED'&&error.message==='Export input bytes differ from frozen version hash');
 assert.equal(probes,0);const report=await f.call();assert.equal(report.status,'blocked');assert.equal(report.issues[0].code,'PREFLIGHT_SOURCE_CHANGED');assert.ok(!JSON.stringify(report).includes(f.root));
});

test('ordinary storyboard recovery and queued dispatch re-read ownership inside the write transaction',async t=>{
 for(const status of ['running','queued'])await t.test(status,async t=>{
  const f=await fixture(t);await f.seed();const record=exportRecord(f,status,{mode:undefined,snapshot:[]});f.store.put('exports',record);const data=exportRows(f)[0].data;
  const originalTx=f.store.tx;let moved=false;f.store.tx=fn=>{if(!moved){moved=true;f.store.db.prepare('UPDATE exports SET projectId=? WHERE id=?').run(f.other.id,record.id);}return originalTx(fn);};
  const mocked=t.mock.method(console,'error',()=>{}),events=[],off=onMediaProcess(event=>events.push(event)),owner=new AbortController();if(status==='running')owner.abort();const worker=startWorker(f.store,f.services,new Map(),{signal:owner.signal});
  try{await worker.tick();await worker.stop();assert.equal(moved,true);assert.equal(exportRows(f)[0].data,data);assert.deepEqual(events,[]);}
  finally{off();mocked.mock.restore();await worker.stop();}
 });
});
