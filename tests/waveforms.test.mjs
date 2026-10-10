import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile,symlink,link,mkdir,rename,truncate} from 'node:fs/promises';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import path from 'node:path';
import {parse,isWaveformResponse} from '@mioon/contracts';
import {openStore,ownsStoreLock} from '../packages/business/src/db.mjs';
import {withProbePermit} from '../packages/business/src/media-probe.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';
import {createWaveformServices,probeWaveform,WAVEFORM_ALGORITHM,WAVEFORM_CACHE_LIMITS} from '../packages/business/src/waveforms.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const metadata=(duration=1,channels=2,patch={})=>({duration,probe:{format:{duration:String(duration),start_time:'0',format_name:'wav'},streams:[{codec_type:'audio',duration:String(duration),channels,start_time:'0',...patch}]}});
const decoded=(duration=1,peak=32768)=>({sampleFrames:Math.round(duration*48000),clipped:false,peaks:new Uint16Array(Math.ceil(duration*100)).fill(peak)});
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function waitFor(read,predicate=value=>!['queued','running'].includes(value.status)){
 const until=Date.now()+5000;let value;
 do{value=read();if(predicate(value))return value;await tick();}while(Date.now()<until);
 assert.fail(`Timed out waiting for waveform state: ${JSON.stringify(value)}`);
}
async function fixture(t,{decode=async()=>decoded(),probe=async()=>metadata(),signal}={}){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-waveforms-'));let store=openStore(root),service;
 const project={id:randomUUID(),name:'Owned project'},other={id:randomUUID(),name:'Foreign private project'};
 store.put('projects',project);store.put('projects',other);
 const options={decode,probe,signal};service=createWaveformServices(store,options);
 const f={root,project,other,options,get store(){return store;},get service(){return service;},
  input:(asset,extra={})=>({projectId:asset.projectId,assetId:asset.id,...extra}),
  call(op,input){const result=service.handlers[op](parse(op,input));assert.ok(isWaveformResponse(result),JSON.stringify(result));return result;},
  get(asset,extra){return f.call('asset.waveform.get',f.input(asset,extra));},
  request(asset,extra){return f.call('asset.waveform.request',f.input(asset,extra));},
  async ready(asset){f.request(asset);return waitFor(()=>f.get(asset));},
  async asset({projectId=project.id,bytes=randomUUID(),...patch}={}){
   const id=randomUUID(),relativePath=`media/${id}.wav`,data=Buffer.from(bytes);await writeFile(path.join(root,relativePath),data);
   return store.put('assets',{id,projectId,name:'Private source',mimeType:'audio/wav',duration:1,hasAudio:true,sizeBytes:data.length,sha256:hash(data),relativePath,url:`/media/${id}`,...patch});
  },
  async restart(){await service.drain();store.close();store=openStore(root);service=createWaveformServices(store,options);},
 };
 t.after(async()=>{await service.drain();store.close();await rm(root,{recursive:true,force:true});});
 return f;
}
const changes=f=>f.store.db.prepare('SELECT total_changes() AS n').get().n;
const rows=f=>f.store.db.prepare('SELECT * FROM waveform_cache ORDER BY position').all();
const sourceRows=f=>Object.fromEntries(['projects','assets','versions','timelines','timeline_history','timeline_requests','mutation_requests','asset_range_requests','asset_disposition_requests'].map(table=>[table,f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const missing=error=>error.code==='NOT_FOUND'&&error.status===404&&error.message==='找不到记录'&&JSON.stringify(error.details)==='{}';
const patchAsset=(f,asset,patch,projectId=asset.projectId)=>f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(projectId,JSON.stringify({...asset,...patch}),asset.id);
function replaceCacheRow(f,row,patch){
 const next={...row,...patch},data=typeof next.data==='string'?JSON.parse(next.data):next.data;
 const bytes=Buffer.byteLength(JSON.stringify({cacheKey:next.cacheKey,projectId:next.projectId,sourceSha256:next.sourceSha256,algorithm:next.algorithm,status:next.status,attemptId:next.attemptId,data}));
 f.store.db.prepare('UPDATE waveform_cache SET status=?,attemptId=?,data=?,bytes=?,reservedBytes=? WHERE cacheKey=?').run(next.status,next.attemptId,JSON.stringify(data),bytes,next.reservedBytes,next.cacheKey);
}

test('GET is noncreating and read-only; ready windows reduce source-aligned maxima without changing media or business rows',async t=>{
 let probes=0,decodes=0;const values=Uint16Array.from({length:100},(_,i)=>i<50?6553:52428);
 const f=await fixture(t,{probe:async()=>{probes++;return metadata();},decode:async()=>{decodes++;return {...decoded(),peaks:values};}}),asset=await f.asset();
 const before=sourceRows(f),media=await readFile(path.join(f.root,asset.relativePath)),writes=changes(f);
 for(let i=0;i<4;i++)assert.equal(f.get(asset).status,'missing');
 assert.equal(changes(f),writes);assert.equal(rows(f).length,0);assert.equal(probes,0);assert.equal(decodes,0);
 const ready=await f.ready(asset);assert.equal(ready.status,'ready');assert.equal(ready.sourceFrames,30);assert.equal(ready.decodedSampleFrames,48000);
 const saved=rows(f),readWrites=changes(f);
 assert.deepEqual(f.get(asset,{sourceStartFrame:0,sourceEndFrame:15,points:2}).peaks,[6553/65535,6553/65535]);
 assert.deepEqual(f.get(asset,{sourceStartFrame:15,sourceEndFrame:30,points:2}).peaks,[.8,.8]);
 assert.equal(f.get(asset,{points:1}).peaks[0],.8);
 assert.equal(f.get(asset,{points:2048}).peaks.length,100);
 for(const range of [{sourceStartFrame:30},{sourceEndFrame:31},{sourceStartFrame:1,sourceEndFrame:1}])assert.throws(()=>f.get(asset,range));
 assert.equal(changes(f),readWrites);assert.deepEqual(rows(f),saved);assert.deepEqual(sourceRows(f),before);assert.deepEqual(await readFile(path.join(f.root,asset.relativePath)),media);
 assert.equal(f.request(asset).status,'ready');assert.equal(probes,1);assert.equal(decodes,1);
});

test('actual PCM coverage is explicit and codec tails remain null rather than fabricated silence',async t=>{
 const f=await fixture(t,{decode:async()=>decoded(.94),probe:async()=>metadata(.94)}),asset=await f.asset();
 const ready=await f.ready(asset);assert.equal(ready.status,'ready');assert.equal(ready.duration,1);assert.equal(ready.sourceFrames,30);assert.equal(ready.decodedSampleFrames,45120);
 const tail=f.get(asset,{sourceStartFrame:27,sourceEndFrame:30,points:10});
 assert.deepEqual(tail.peaks.slice(0,4),Array(4).fill(32768/65535));assert.deepEqual(tail.peaks.slice(4),Array(6).fill(null));
});

test('same project/source requests and duplicate service wrappers share one owned decode; projects never share cache state',async t=>{
 const gate=deferred();let count=0;const decode=async()=>{count++;await gate.promise;return decoded();};
 const f=await fixture(t,{decode}),asset=await f.asset({bytes:'identical'}),same=await f.asset({bytes:'identical'}),foreign=await f.asset({projectId:f.other.id,bytes:'identical'});
 assert.equal(createWaveformServices(f.store,f.options),f.service);
 assert.equal(createWaveformServices({...f.store},f.options),f.service);
 assert.throws(()=>createWaveformServices(f.store,{...f.options,signal:new AbortController().signal}),{code:'WAVEFORM_SERVICE_ACTIVE'});
 const accepted=f.request(asset);assert.equal(f.request(same).attemptId,accepted.attemptId);assert.equal(f.get(foreign).status,'missing');
 await waitFor(()=>({status:count===1?'started':'queued'}));assert.equal(count,1);gate.resolve();
 await waitFor(()=>f.get(asset));assert.equal(f.get(same).status,'ready');assert.equal(rows(f).length,1);
 await f.ready(foreign);assert.equal(count,2);assert.equal(rows(f).length,2);
});

test('bounded owner checks reject missing, foreign, malformed and contradictory ownership before cache lookup or probing',async t=>{
 let processes=0;const f=await fixture(t,{probe:async()=>{processes++;return metadata();}}),asset=await f.asset(),foreign=await f.asset({projectId:f.other.id});
 f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run('{foreign secret',foreign.id);
 for(const input of [{projectId:f.project.id,assetId:foreign.id},{projectId:f.other.id,assetId:asset.id},{projectId:randomUUID(),assetId:asset.id},{projectId:f.project.id,assetId:randomUUID()}]){
  for(const op of ['asset.waveform.get','asset.waveform.request'])assert.throws(()=>f.call(op,input),missing);
 }
 for(const bad of ['{secret',JSON.stringify({...asset,padding:'x'.repeat(17000)}),JSON.stringify({...asset,projectId:f.other.id}),JSON.stringify({...asset,id:randomUUID()})]){
  f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(bad,asset.id);
  for(const op of ['asset.waveform.get','asset.waveform.request'])assert.throws(()=>f.call(op,f.input(asset)),missing);
 }
 patchAsset(f,asset,{});f.store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...f.project,id:f.other.id}),f.project.id);
 assert.throws(()=>f.get(asset),missing);assert.equal(processes,0);assert.equal(rows(f).length,0);
});

test('hash mismatch is terminal and sanitized until explicit retry; no probe or decoder sees unverified bytes',async t=>{
 let processes=0;const f=await fixture(t,{probe:async()=>{processes++;return metadata();}}),asset=await f.asset();
 await writeFile(path.join(f.root,asset.relativePath),'changed secret bytes');
 const failed=await f.ready(asset);assert.equal(failed.status,'error');assert.equal(failed.reason.code,'WAVEFORM_SOURCE_CHANGED');assert.equal(processes,0);
 const attempt=failed.attemptId,writes=changes(f);assert.equal(f.request(asset).attemptId,attempt);assert.equal(changes(f),writes);
 const bytes=Buffer.from('restored');await writeFile(path.join(f.root,asset.relativePath),bytes);
 patchAsset(f,asset,{sha256:hash(bytes),sizeBytes:bytes.length});asset.sha256=hash(bytes);asset.sizeBytes=bytes.length;
 const ready=await f.ready(asset);assert.equal(ready.status,'ready');assert.notEqual(ready.attemptId,attempt);assert.equal(processes,1);
 assert.ok(!JSON.stringify(ready).includes('media/'));assert.ok(!JSON.stringify(failed).includes('secret'));
});

test('managed source validation rejects traversal, symlinks, hardlinks, FIFOs and oversized files before probing',async t=>{
 let processes=0;const f=await fixture(t,{probe:async()=>{processes++;return metadata();}}),target=await f.asset();
 const cases=[];
 const symlinkAsset=await f.asset();await rm(path.join(f.root,symlinkAsset.relativePath));await symlink(path.join(f.root,target.relativePath),path.join(f.root,symlinkAsset.relativePath));cases.push(symlinkAsset);
 const hardlinkAsset=await f.asset();await rm(path.join(f.root,hardlinkAsset.relativePath));await link(path.join(f.root,target.relativePath),path.join(f.root,hardlinkAsset.relativePath));cases.push(hardlinkAsset);
 const fifo=await f.asset();await rm(path.join(f.root,fifo.relativePath));execFileSync('mkfifo',[path.join(f.root,fifo.relativePath)]);cases.push(fifo);
 const traversal=await f.asset();patchAsset(f,traversal,{relativePath:'media/../workbench.sqlite'});cases.push(traversal);
 await mkdir(path.join(f.root,'media','real'));await symlink(path.join(f.root,'media','real'),path.join(f.root,'media','linked'));
 const descendant=await f.asset();patchAsset(f,descendant,{relativePath:'media/linked/file.wav'});await writeFile(path.join(f.root,'media','real','file.wav'),'x');cases.push(descendant);
 for(const asset of cases){const result=await f.ready(asset);assert.equal(result.status,'error');assert.equal(result.reason.code,'WAVEFORM_SOURCE_INVALID');}
 const huge=await f.asset();await truncate(path.join(f.root,huge.relativePath),WAVEFORM_CACHE_LIMITS.sourceBytes+1);
 const result=await f.ready(huge);assert.equal(result.status,'unsupported');assert.equal(result.reason.code,'WAVEFORM_SOURCE_TOO_LARGE');assert.equal(processes,0);
});

test('probe restrictions reject no audio, extra channels, long or unknown duration and unaligned/unknown origins',async t=>{
 const cases=[
  {value:{duration:1,probe:{streams:[],format:{}}},code:'WAVEFORM_NO_AUDIO'},
  {value:metadata(1,6),code:'WAVEFORM_CHANNELS_UNSUPPORTED'},
  {value:metadata(601),code:'WAVEFORM_DURATION_UNSUPPORTED'},
  {value:metadata(0),code:'WAVEFORM_DURATION_UNSUPPORTED'},
  {value:metadata(1,2,{start_time:'.001'}),code:'WAVEFORM_TIMING_UNSUPPORTED'},
  {value:metadata(1,2,{start_time:'-.001'}),code:'WAVEFORM_TIMING_UNSUPPORTED'},
  {value:metadata(1,2,{start_time:'N/A'}),code:'WAVEFORM_TIMING_UNSUPPORTED'},
  {value:metadata(1,2,{duration:'.5'}),code:'WAVEFORM_TIMING_UNSUPPORTED'},
 ];
 for(const [i,entry] of cases.entries()){
  let decodes=0;await t.test(String(i),async sub=>{const f=await fixture(sub,{probe:async()=>entry.value,decode:async()=>{decodes++;return decoded();}}),asset=await f.asset();
   const result=await f.ready(asset);assert.equal(result.status,'unsupported');assert.equal(result.reason.code,entry.code);assert.equal(decodes,0);
  });
 }
 await t.test('untimed WAV sample zero is the documented safe absence',async sub=>{
  const info=metadata();delete info.probe.streams[0].start_time;delete info.probe.format.start_time;
  const f=await fixture(sub,{probe:async()=>info}),asset=await f.asset();assert.equal((await f.ready(asset)).status,'ready');
 });
 await t.test('matching absolute nonzero origins preserve relative zero',async sub=>{
  const info=metadata();info.probe.streams[0].start_time='10';info.probe.format.start_time='10';
  const f=await fixture(sub,{probe:async()=>info}),asset=await f.asset();assert.equal((await f.ready(asset)).status,'ready');
 });
});

test('file mutation/replacement and current owned metadata changes fence ready publication',async t=>{
 for(const mode of ['bytes','replacement','sha256','relativePath','duration','sizeBytes','hasAudio','owner'])await t.test(mode,async sub=>{
  let f,asset;
  f=await fixture(sub,{decode:async()=>{
   const file=path.join(f.root,asset.relativePath);
   if(mode==='bytes')await writeFile(file,Buffer.alloc(asset.sizeBytes,120));
   else if(mode==='replacement'){const bytes=await readFile(file);await rename(file,file+'.old');await writeFile(file,bytes);}
   else if(mode==='owner')patchAsset(f,asset,{projectId:f.other.id},f.other.id);
   else patchAsset(f,asset,{[mode]:({sha256:'f'.repeat(64),relativePath:'media/changed.wav',duration:2,sizeBytes:999,hasAudio:false})[mode]});
   return decoded();
  }});asset=await f.asset();f.request(asset);
  await waitFor(()=>({status:rows(f)[0].status}));assert.notEqual(rows(f)[0].status,'ready');
  if(mode==='owner')assert.throws(()=>f.get(asset),missing);
 });
});

test('late attempt callbacks cannot replace newer durable state',async t=>{
 const gate=deferred();let entered=false;const f=await fixture(t,{decode:async()=>{entered=true;await gate.promise;return decoded();}}),asset=await f.asset();
 f.request(asset);await waitFor(()=>({status:entered?'started':'queued'}));
 const old=rows(f)[0],newAttempt=randomUUID();replaceCacheRow(f,old,{attemptId:newAttempt,status:'interrupted',reservedBytes:0,data:{reason:{code:'WAVEFORM_INTERRUPTED',message:'Waveform preparation was interrupted. Request an explicit retry to restart it.'}}});
 gate.resolve();await waitFor(()=>({status:f.get(asset).status}));await tick();await f.service.drain();assert.equal(rows(f)[0].attemptId,newAttempt);assert.equal(rows(f)[0].status,'interrupted');
});

test('ready cache corruption is read-only error until explicit retry; clear removes only disposable derivations',async t=>{
 let count=0;const f=await fixture(t,{decode:async()=>{count++;return decoded();}}),asset=await f.asset();await f.ready(asset);const original=rows(f)[0],before=sourceRows(f);
 for(const patch of [{peaks:[1]},{peakDigest:'f'.repeat(64)},{peaks:Array(100).fill(null)},{duration:2},{sourceFrames:31}]){
  replaceCacheRow(f,original,{data:{...JSON.parse(original.data),...patch}});
  const saved=rows(f),writes=changes(f);assert.equal(f.get(asset).reason.code,'CACHE_CORRUPT');assert.equal(f.request(asset).reason.code,'CACHE_CORRUPT');assert.equal(count,1);assert.deepEqual(rows(f),saved);assert.equal(changes(f),writes);
 }
 const retry=f.request(asset,{retry:true});assert.notEqual(retry.attemptId,original.attemptId);assert.equal((await waitFor(()=>f.get(asset))).status,'ready');assert.equal(count,2);
 patchAsset(f,asset,{duration:2});assert.equal(f.get(asset).reason.code,'CACHE_CORRUPT');patchAsset(f,asset,{});
 f.store.db.exec('DELETE FROM waveform_cache');const writes=changes(f);assert.equal(f.get(asset).status,'missing');assert.equal(changes(f),writes);assert.deepEqual(sourceRows(f),before);
});

test('one active plus four queued operations are bounded; overflow has no persistent entry',async t=>{
 const gate=deferred();let running=0,max=0,count=0;
 const f=await fixture(t,{decode:async()=>{running++;max=Math.max(max,running);count++;await gate.promise;await tick();running--;return decoded();}});
 const assets=await Promise.all(Array.from({length:6},()=>f.asset()));
 for(let i=0;i<5;i++)assert.ok(['queued','running'].includes(f.request(assets[i]).status));
 const overflow=f.request(assets[5]);assert.equal(overflow.reason.code,'WAVEFORM_BUSY');assert.equal(rows(f).length,5);
 await waitFor(()=>({status:count===1?'started':'queued'}));assert.equal(count,1);gate.resolve();
 for(const asset of assets.slice(0,5))assert.equal((await waitFor(()=>f.get(asset))).status,'ready');
 assert.equal(max,1);assert.equal(count,5);
});

test('owned drain interrupts queued work, joins a late callback, and restart requires explicit fresh attempt',async t=>{
 const gate=deferred();let entered=false;
 const f=await fixture(t,{decode:async()=>{entered=true;await gate.promise;return decoded();}}),asset=await f.asset(),queued=await f.asset();
 const initial=f.request(asset);f.request(queued);await waitFor(()=>({status:entered?'started':'queued'}));
 let drained=false;const drain=f.service.drain().then(()=>{drained=true;});await tick();assert.equal(drained,false);
 assert.ok(rows(f).every(row=>row.status==='interrupted'));gate.resolve();await drain;assert.equal(drained,true);assert.ok(rows(f).every(row=>row.status==='interrupted'));
 await f.restart();assert.equal(f.get(asset).status,'interrupted');assert.equal(f.request(asset).attemptId,initial.attemptId);
 const retry=f.request(asset,{retry:true});assert.notEqual(retry.attemptId,initial.attemptId);assert.equal((await waitFor(()=>f.get(asset))).status,'ready');
});

test('startup marks only unfinished rows interrupted and never probes; completed rows persist byte-for-byte',async t=>{
 let probes=0;const f=await fixture(t,{probe:async()=>{probes++;return metadata();}}),ready=await f.asset(),unfinished=await f.asset();
 await f.ready(ready);await f.ready(unfinished);const originalReady=rows(f).find(row=>row.sourceSha256===ready.sha256),old=rows(f).find(row=>row.sourceSha256===unfinished.sha256);
 replaceCacheRow(f,old,{status:'running',data:{},reservedBytes:WAVEFORM_CACHE_LIMITS.recordBytes});await f.restart();
 assert.equal(probes,2);assert.deepEqual(rows(f).find(row=>row.sourceSha256===ready.sha256),originalReady);assert.equal(f.get(unfinished).status,'interrupted');
 assert.equal(f.get(unfinished).attemptId,old.attemptId);assert.equal(f.request(unfinished).status,'interrupted');assert.equal(probes,2);
});

test('explicit admission deterministically evicts oldest terminal entries; GET never refreshes ordering',async t=>{
 const f=await fixture(t),assets=[];
 for(let i=0;i<64;i++){const asset=await f.asset();assets.push(asset);assert.equal((await f.ready(asset)).status,'ready');}
 assert.equal(rows(f).length,64);const writes=changes(f);f.get(assets[0]);assert.equal(changes(f),writes);
 const fresh=await f.asset();assert.equal((await f.ready(fresh)).status,'ready');assert.equal(rows(f).length,64);assert.equal(f.get(assets[0]).status,'missing');assert.equal(f.get(assets[1]).status,'ready');
});

test('serialized peak payload plus in-flight maximum reservation respects the 16 MiB aggregate limit',async t=>{
 const f=await fixture(t,{probe:async()=>metadata(600),decode:async()=>decoded(600,65535)}),assets=[];
 for(let i=0;i<48;i++){
  const asset=await f.asset({duration:600});assets.push(asset);f.request(asset);
  const total=f.store.db.prepare('SELECT sum(max(bytes,reservedBytes)) AS bytes FROM waveform_cache').get().bytes;assert.ok(total<=WAVEFORM_CACHE_LIMITS.bytes,total);
  assert.equal((await waitFor(()=>f.get(asset,{points:1}))).status,'ready');
 }
 assert.ok(rows(f).length<48);assert.equal(f.get(assets[0]).status,'missing');assert.ok(rows(f).every(row=>row.reservedBytes===0));
});

test('unconfirmed decoder termination remains a shutdown failure with no ready partial cache',async t=>{
 const error=Object.assign(new Error('private decoder diagnostic'),{terminationUnconfirmed:true,code:'MEDIA_TERMINATION_UNCONFIRMED'});
 const root=await mkdtemp(path.join(tmpdir(),'mioon-waveform-unconfirmed-')),store=openStore(root),project={id:randomUUID()};store.put('projects',project);
 const bytes=Buffer.from('source'),asset={id:randomUUID(),projectId:project.id,mimeType:'audio/wav',duration:1,relativePath:'media/source.wav',sha256:hash(bytes)};store.put('assets',asset);await writeFile(path.join(root,asset.relativePath),bytes);
 const service=createWaveformServices(store,{probe:async()=>metadata(),decode:async()=>{throw error;}}),input={projectId:project.id,assetId:asset.id};
 service.handlers['asset.waveform.request'](input);const result=await waitFor(()=>service.handlers['asset.waveform.get'](input));assert.equal(result.status,'error');assert.ok(!JSON.stringify(result).includes('private decoder'));
 await assert.rejects(service.drain(),e=>e===error);store.close();await rm(root,{recursive:true,force:true});
});

test('a partial final PCM bin never fills a wholly uncovered exact requested interval',async t=>{
 const sampleFrames=44650,duration=sampleFrames/48000;
 const f=await fixture(t,{probe:async()=>metadata(duration),decode:async()=>({sampleFrames,clipped:false,peaks:new Uint16Array(Math.ceil(sampleFrames/480)).fill(65535)})}),asset=await f.asset();
 assert.equal((await f.ready(asset)).status,'ready');
 assert.deepEqual(f.get(asset,{sourceStartFrame:28,sourceEndFrame:29,points:4}).peaks,[null,null,null,null]);
 const partial=f.get(asset,{sourceStartFrame:27,sourceEndFrame:29,points:8}).peaks;
 assert.ok(partial.some(value=>value===1));assert.ok(partial.some(value=>value===null));
 assert.deepEqual(f.get(asset,{sourceStartFrame:28,sourceEndFrame:30,points:1}).peaks,[null]);
});

test('unknown non-WAV origins and matching negative origins are conservatively unsupported',async t=>{
 for(const kind of ['unknown','negative'])await t.test(kind,async sub=>{
  const info=metadata();info.probe.format.format_name='mov';
  if(kind==='unknown'){delete info.probe.streams[0].start_time;delete info.probe.format.start_time;}
  else{info.probe.streams[0].start_time='-1';info.probe.format.start_time='-1';}
  const f=await fixture(sub,{probe:async()=>info}),asset=await f.asset();assert.equal((await f.ready(asset)).reason.code,'WAVEFORM_TIMING_UNSUPPORTED');
 });
});

test('ownership reassignment as a publication trigger rolls back both ready data and reassignment',async t=>{
 const f=await fixture(t),asset=await f.asset();
 f.store.db.exec(`CREATE TRIGGER reassign_waveform_owner AFTER UPDATE ON waveform_cache WHEN NEW.status='ready' BEGIN
 UPDATE assets SET projectId='${f.other.id}',data=json_set(data,'$.projectId','${f.other.id}') WHERE id='${asset.id}'; END;`);
 const result=await f.ready(asset);assert.equal(result.status,'error');assert.equal(f.store.get('assets',asset.id).projectId,f.project.id);assert.equal(rows(f)[0].status,'error');
});

test('malformed budget columns and oversized cache identities fail closed without damaging an explicit retry target',async t=>{
 const f=await fixture(t),a=await f.asset(),b=await f.asset();await f.ready(a);await f.ready(b);const originals=rows(f),other=originals[1];
 f.store.db.exec('PRAGMA ignore_check_constraints=ON');
 for(const [column,value] of [['algorithm','x'.repeat(1000000)],['bytes',-1],['reservedBytes',-2],['status','x'.repeat(1000000)],['cacheKey','x'.repeat(1000000)]]){
  f.store.db.prepare(`UPDATE waveform_cache SET ${column}=? WHERE position=?`).run(value,other.position);
  const before=rows(f),changesBefore=changes(f),response=f.request(a,{retry:true});
  // An already valid ready result requires no admission or global cache work.
  assert.equal(response.status,'ready');assert.deepEqual(rows(f),before);assert.equal(changes(f),changesBefore);
  const fresh=await f.asset();assert.equal(f.request(fresh).reason.code,'WAVEFORM_CAPACITY');assert.deepEqual(rows(f),before);
  f.store.db.prepare(`UPDATE waveform_cache SET ${column}=? WHERE position=?`).run(other[column],other.position);
 }
 f.store.db.exec('PRAGMA ignore_check_constraints=OFF');
});

test('excess cache row corruption does not block startup or original editing and is never silently repaired',async t=>{
 const f=await fixture(t),asset=await f.asset();await f.ready(asset);const seed=rows(f)[0];
 for(let i=1;i<65;i++){
  const sourceSha256=hash(String(i)),cacheKey=hash(JSON.stringify([asset.projectId,sourceSha256,WAVEFORM_ALGORITHM]));
  f.store.db.prepare('INSERT INTO waveform_cache(cacheKey,projectId,sourceSha256,algorithm,status,attemptId,data,bytes,reservedBytes) VALUES(?,?,?,?,?,?,?,?,?)')
   .run(cacheKey,asset.projectId,sourceSha256,WAVEFORM_ALGORITHM,'ready',randomUUID(),seed.data,seed.bytes,0);
 }
 const before=rows(f);await f.restart();assert.deepEqual(rows(f),before);assert.equal(f.get(asset).reason.code,'WAVEFORM_CACHE_UNAVAILABLE');
 assert.equal(f.request(asset,{retry:true}).reason.code,'WAVEFORM_CAPACITY');assert.deepEqual(rows(f),before);
 f.store.put('projects',{...f.project,name:'Editing still available'});assert.equal(f.store.get('projects',f.project.id).name,'Editing still available');
});

test('whole-attempt timeout aborts owned work and reports a sanitized terminal reason',async t=>{
 let entered=false;
 const f=await fixture(t,{decode:async(_file,{signal})=>{
  entered=true;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('private timeout diagnostic')),{once:true}));
 }}),asset=await f.asset();
 t.mock.timers.enable({apis:['setTimeout']});f.request(asset);await waitFor(()=>({status:entered?'started':'queued'}));
 t.mock.timers.tick(WAVEFORM_CACHE_LIMITS.attemptMs+1);
 const failed=await waitFor(()=>f.get(asset));assert.equal(failed.status,'error');assert.equal(failed.reason.code,'WAVEFORM_TIMEOUT');
 t.mock.timers.reset();
});

test('waveform-specific real ffprobe denies playlist/network references before any outbound request',async t=>{
 let connections=0,decodes=0;const server=createServer((_request,response)=>{connections++;response.writeHead(404);response.end();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const address=server.address(),playlist=`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${address.port}/private.ts\n#EXT-X-ENDLIST\n`;
 const f=await fixture(t,{probe:probeWaveform,decode:async()=>{decodes++;return decoded();}}),asset=await f.asset({bytes:playlist,mimeType:'audio/mp4'});
 const result=await f.ready(asset);assert.equal(result.status,'error');assert.equal(connections,0);assert.equal(decodes,0);assert.ok(!JSON.stringify(result).includes('http'));
});

test('waveform-specific real ffprobe accepts sample-zero WAV without inventing a missing timestamp',async t=>{
 const samples=Buffer.alloc(48000*2),header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+samples.length,4);header.write('WAVEfmt ',8);
 header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(48000,24);header.writeUInt32LE(96000,28);
 header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(samples.length,40);
 const f=await fixture(t,{probe:probeWaveform}),asset=await f.asset({bytes:Buffer.concat([header,samples])});assert.equal((await f.ready(asset)).status,'ready');
});

test('empty and ready-only construction performs zero transactions or writes; unfinished recovery uses one synchronous transaction',async t=>{
 const f=await fixture(t),asset=await f.asset();await f.service.drain();
 const originalTx=f.store.tx;let txCalls=0;
 f.store.tx=callback=>{txCalls++;assert.notEqual(callback.constructor.name,'AsyncFunction');return originalTx(callback);};
 let before=changes(f),service=createWaveformServices(f.store,f.options);
 assert.equal(txCalls,0);assert.equal(changes(f),before);
 service.handlers['asset.waveform.request'](f.input(asset));await waitFor(()=>service.handlers['asset.waveform.get'](f.input(asset)));await service.drain();
 txCalls=0;before=changes(f);service=createWaveformServices(f.store,f.options);
 assert.equal(txCalls,0);assert.equal(changes(f),before);await service.drain();
 replaceCacheRow(f,rows(f)[0],{status:'running',data:{},reservedBytes:WAVEFORM_CACHE_LIMITS.recordBytes});
 txCalls=0;before=changes(f);service=createWaveformServices(f.store,f.options);
 assert.equal(txCalls,1);assert.equal(changes(f),before+1);assert.equal(service.handlers['asset.waveform.get'](f.input(asset)).status,'interrupted');await service.drain();
});

test('oversized foreign relational ownership is filtered in SQL before any foreign row reaches the service',async t=>{
 const f=await fixture(t),asset=await f.asset(),foreign=await f.asset({projectId:f.other.id});
 f.store.db.exec('PRAGMA foreign_keys=OFF');
 f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run('foreign private owner '.repeat(100000),'{foreign secret malformed metadata',foreign.id);
 f.store.db.exec('PRAGMA foreign_keys=ON');
 const before=changes(f);
 for(const operation of ['asset.waveform.get','asset.waveform.request'])assert.throws(()=>f.call(operation,{projectId:f.project.id,assetId:foreign.id}),missing);
 assert.equal(f.get(asset).status,'missing');assert.equal(rows(f).length,0);assert.equal(changes(f),before);
});

test('a second lock:false process sees active state but cannot reconcile, steal, queue or decode',async t=>{
 const gate=deferred();let entered=false;
 const f=await fixture(t,{decode:async()=>{entered=true;await gate.promise;return decoded();}}),asset=await f.asset();
 const initial=f.request(asset);await waitFor(()=>({status:entered?'started':'queued'}));const before=rows(f);
 const helper=fileURLToPath(new URL('./helpers/waveform-readonly-owner.mjs',import.meta.url));
 const {stdout}=await promisify(execFile)(process.execPath,[helper,f.root,JSON.stringify(f.input(asset))],{timeout:10000,maxBuffer:128*1024});
 const result=JSON.parse(stdout);assert.equal(result.owner,false);assert.equal(result.txCalls,0);assert.equal(result.spawns,0);assert.equal(result.changes,0);assert.equal(result.exclusiveDenied,true);
 assert.equal(result.read.status,'running');assert.equal(result.after.status,'running');assert.equal(result.read.attemptId,initial.attemptId);assert.equal(result.request.reason.code,'WAVEFORM_OWNER_REQUIRED');assert.deepEqual(rows(f),before);
 gate.resolve();assert.equal((await waitFor(()=>f.get(asset))).status,'ready');
});

test('replaced or deleted workspace lock permanently fences admission, callbacks and shutdown error saves',async t=>{
 for(const mode of ['replaced','deleted'])await t.test(mode,async sub=>{
  const gate=deferred();let entered=false;const f=await fixture(sub,{decode:async()=>{entered=true;await gate.promise;return decoded();}}),asset=await f.asset(),fresh=await f.asset();
  f.request(asset);await waitFor(()=>({status:entered?'started':'queued'}));
  const lockFile=path.join(f.root,'server.lock');await rm(lockFile);if(mode==='replaced')await writeFile(lockFile,String(process.pid),{mode:0o600});
  assert.equal(ownsStoreLock(f.store),false);const before=rows(f),writes=changes(f);
  assert.equal(f.request(fresh).reason.code,'WAVEFORM_OWNER_REQUIRED');gate.resolve();await f.service.drain();
  assert.deepEqual(rows(f),before);assert.equal(changes(f),writes);assert.equal(f.get(asset).status,'running');
  f.store.close();if(mode==='replaced')assert.equal(await readFile(lockFile,'utf8'),String(process.pid));
 });
});

test('exclusive close revokes old callbacks before a new owner reconciles and publishes a fresh attempt',async t=>{
 const gate=deferred();let entered=false;
 const f=await fixture(t,{decode:async()=>{entered=true;await gate.promise;return decoded();}}),asset=await f.asset();
 const oldAttempt=f.request(asset).attemptId;await waitFor(()=>({status:entered?'started':'queued'}));f.store.close();assert.equal(ownsStoreLock(f.store),false);
 const replacement=openStore(f.root),service=createWaveformServices(replacement,{probe:async()=>metadata(),decode:async()=>decoded()});
 assert.equal(ownsStoreLock(replacement),true);assert.equal(service.handlers['asset.waveform.get'](f.input(asset)).status,'interrupted');
 const fresh=service.handlers['asset.waveform.request']({...f.input(asset),retry:true});assert.notEqual(fresh.attemptId,oldAttempt);
 await waitFor(()=>service.handlers['asset.waveform.get'](f.input(asset)));const before=replacement.db.prepare('SELECT * FROM waveform_cache').all();
 gate.resolve();await f.service.drain();assert.deepEqual(replacement.db.prepare('SELECT * FROM waveform_cache').all(),before);
 await service.drain();replacement.close();
});

test('ownership is rechecked after a saturated global probe permit before any late ffprobe spawn',async t=>{
 const gate=deferred();t.after(()=>gate.resolve());let permitsEntered=0,queued=false,ownershipDenied=false,spawns=0;
 const permits=Array.from({length:4},()=>withProbePermit(undefined,async()=>{permitsEntered++;await gate.promise;}));
 await waitFor(()=>({status:permitsEntered===4?'saturated':'queued'}));
 const stopObserving=onMediaProcess(event=>{if(event.type==='started'&&event.kind==='ffprobe')spawns++;});t.after(stopObserving);
 const probe=async(file,options)=>{
  queued=true;
  return probeWaveform(file,{...options,beforeSpawn:()=>{try{options.beforeSpawn();}catch(error){ownershipDenied=true;throw error;}}});
 };
 const f=await fixture(t,{probe}),asset=await f.asset();f.request(asset);await waitFor(()=>({status:queued?'waiting':'queued'}));
 f.store.close();const replacement=openStore(f.root),service=createWaveformServices(replacement,{probe:async()=>metadata(),decode:async()=>decoded()});
 service.handlers['asset.waveform.request']({...f.input(asset),retry:true});await waitFor(()=>service.handlers['asset.waveform.get'](f.input(asset)));
 const before=replacement.db.prepare('SELECT * FROM waveform_cache').all();
 gate.resolve();await Promise.all(permits);await waitFor(()=>({status:ownershipDenied?'denied':'queued'}));await f.service.drain();
 assert.equal(spawns,0);assert.deepEqual(replacement.db.prepare('SELECT * FROM waveform_cache').all(),before);
 await service.drain();replacement.close();
});
