import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createTimelineImageSourceServices,readManagedTimelineImage,validateTimelineImageSourceInterpretation} from '../packages/business/src/timeline-image-source.ts';
import {validateManagedSource} from '../packages/business/src/managed-media.mjs';
import {runStreaming} from '../packages/business/src/media-runtime.mjs';
import {waitForMediaProcesses} from '../packages/business/src/media-processes.mjs';
import {probe} from '../packages/business/src/media.mjs';
import {pillowJfifFixture} from './helpers/timeline-jpeg-fixtures.mjs';
import {jpegColour} from './helpers/timeline-jpeg-workflow-fixtures.mjs';
import {sha} from './helpers/timeline-image-fixtures.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function fixture(t,override={}){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-jfif-source-'));await mkdir(path.join(root,'media'),{mode:0o700});const bytes=pillowJfifFixture(),file=path.join(root,'media/source.jpg');await writeFile(file,bytes,{mode:0o600});const db=new DatabaseSync(':memory:');
 const asset={id:randomUUID(),projectId:randomUUID(),sha256:sha(bytes),sizeBytes:bytes.length,mimeType:'image/jpeg',relativePath:'media/source.jpg'};
 const runtime={validateSource:validateManagedSource,runStreaming,waitForMediaProcesses,ownsLock:()=>true,assertOrdinaryWorkspace(){},readOwnedAsset:(projectId,assetId)=>projectId===asset.projectId&&assetId===asset.id?asset:null,...override};
 const services=createTimelineImageSourceServices({db,root},{runtime});t.after(async()=>{await services.drain();db.close();await rm(root,{recursive:true,force:true});});
 return{root,db,asset,file,bytes,runtime,services,inspect:(context)=>services.handlers['timeline.colour.jpeg.inspect']({projectId:asset.projectId,assetId:asset.id},context)};
}
test('owned JPEG inspection performs exact bounded decode, no writes and no implicit colour claim',async t=>{
 let decodes=0;const f=await fixture(t,{runStreaming:async(...args)=>{decodes++;return runStreaming(...args);}}),before=f.db.prepare('SELECT total_changes() n').get().n;
 const result=await f.inspect();assert.equal(decodes,1);assert.equal(result.status,'needs_interpretation');assert.equal(result.evidence.colourTag,'untagged');assert.equal(result.evidence.alphaMode,'opaque');assert.equal(JSON.stringify(result).includes(f.root),false);assert.deepEqual(await readFile(f.file),f.bytes);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 const media=await probe(f.file),input={source:jpegColour(result.evidence).source,evidence:result.evidence,assetSha256:f.asset.sha256,probe:media.probe,streamIndex:media.videoStreamIndex};
 assert.deepEqual(validateTimelineImageSourceInterpretation(input),result.evidence);
 for(const change of [x=>x.source.evidence.sampling='444',x=>x.evidence.decoderPolicy='automatic',x=>x.probe.streams[0].pix_fmt='yuv420p',x=>x.streamIndex=1,x=>x.source.evidence.orientation=6]){const bad=structuredClone(input);change(bad);assert.throws(()=>validateTimelineImageSourceInterpretation(bad));}
});
test('strict decoder failure cannot produce JPEG evidence or infer compatibility',async t=>{
 const failure=Object.assign(Error('strict decoder failed'),{code:'MEDIA_EXIT_FAILED'});const f=await fixture(t,{runStreaming:async()=>{throw failure;}});
 await assert.rejects(f.inspect(),failure);
 await assert.rejects(readManagedTimelineImage(f.root,f.asset,{}, {validateSource:validateManagedSource}),{code:'TIMELINE_COLOUR_SOURCE_UNAVAILABLE'});
});
test('outer timeout retains terminationUnconfirmed and single-flight permit until actual child join',async t=>{
 const started=deferred(),joined=deferred();let decodeSignal,joinSignal;
 const f=await fixture(t,{runStreaming:async(_command,_args,{signal})=>{decodeSignal=signal;started.resolve();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw Object.assign(Error('unconfirmed exact child'),{code:'MEDIA_CANCELLED',terminationUnconfirmed:true});},waitForMediaProcesses:({signal})=>{joinSignal=signal;return joined.promise;}});
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=f.inspect();const rejected=assert.rejects(pending,error=>error.code==='TIMELINE_COLOUR_SOURCE_TIMEOUT'&&error.terminationUnconfirmed===true);
 await started.promise;t.mock.timers.tick(15000);await rejected;assert.equal(joinSignal,decodeSignal);
 await assert.rejects(f.inspect(),{code:'TIMELINE_COLOUR_SOURCE_BUSY'});
 let drained=false;const drain=f.services.drain().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);joined.resolve();await drain;assert.equal(drained,true);t.mock.timers.reset();
});

test('drain begun before decoder rejection still awaits the subsequently installed exact-child join',async t=>{
 const started=deferred(),failed=deferred(),joined=deferred();
 const f=await fixture(t,{runStreaming:async()=>{started.resolve();await failed.promise;throw Object.assign(Error('unconfirmed exact child'),{code:'MEDIA_CANCELLED',terminationUnconfirmed:true});},waitForMediaProcesses:()=>joined.promise});
 const rejected=assert.rejects(f.inspect(),e=>e.terminationUnconfirmed===true);await started.promise;
 let drained=false;const drain=f.services.drain().then(()=>{drained=true;});failed.resolve();await rejected;
 await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);joined.resolve();await drain;assert.equal(drained,true);
});
