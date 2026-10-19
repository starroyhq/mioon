import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readManagedTimelineImage,createTimelineImageSourceServices,validateTimelineImageSourceInterpretation} from '../packages/business/src/timeline-image-source.ts';
import {validateManagedSource} from '../packages/business/src/managed-media.ts';
import {probe} from '../packages/business/src/media.ts';
import {png,pngChunk,sha,imageColour} from './helpers/timeline-image-fixtures.ts';
async function fixture(t,bytes=png()){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-image-source-'));await mkdir(path.join(root,'media'),{mode:0o700});const file=path.join(root,'media','fixture.png');await writeFile(file,bytes,{mode:0o600});const db=new DatabaseSync(':memory:');
 const asset={id:randomUUID(),projectId:randomUUID(),sha256:sha(bytes),sizeBytes:bytes.length,mimeType:'image/png',relativePath:'media/fixture.png'};let owned=true;
 const runtime={validateSource:validateManagedSource,assertOrdinaryWorkspace(){},ownsLock:()=>owned,readOwnedAsset:(projectId,assetId)=>projectId===asset.projectId&&assetId===asset.id?asset:null};
 const services=createTimelineImageSourceServices({db,root},{runtime});t.after(async()=>{await services.drain();db.close();await rm(root,{recursive:true,force:true});});
 return{root,file,asset,db,runtime,services,bytes,owner:value=>{owned=value;},inspect:(input={projectId:asset.projectId,assetId:asset.id},context)=>services.handlers['timeline.colour.image.inspect'](input,context)};
}
test('owned PNG inspection validates bytes, returns no paths and changes no files or DB',async t=>{
 const f=await fixture(t),before=f.db.prepare('SELECT total_changes() n').get().n,result=await f.inspect();assert.equal(result.status,'compatible');assert.equal(result.evidence.alphaMode,'straight');assert.equal(result.assetSha256,f.asset.sha256);assert.equal(result.evidence.width,64);assert.equal(JSON.stringify(result).includes(f.root),false);assert.deepEqual(await readFile(f.file),f.bytes);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 const media=await probe(f.file);assert.deepEqual(validateTimelineImageSourceInterpretation({source:imageColour(result.evidence).source,evidence:result.evidence,assetSha256:f.asset.sha256,probe:media.probe,streamIndex:media.videoStreamIndex}),result.evidence);
});
test('untagged image needs explicit declaration; conflicting PNG metadata cannot be overridden',async t=>{
 const untagged=await fixture(t,png({tagged:false}));assert.equal((await untagged.inspect()).status,'needs_interpretation');
 const conflict=await fixture(t,png({extra:[pngChunk('iCCP',Buffer.from('hidden'))]}));await assert.rejects(conflict.inspect(),{code:'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
});
test('ownership, project, MIME and exact SHA mismatch fail before evidence is returned',async t=>{
 const f=await fixture(t);f.owner(false);await assert.rejects(f.inspect(),{code:'TIMELINE_COLOUR_SOURCE_OWNER_REQUIRED'});f.owner(true);await assert.rejects(f.inspect({projectId:randomUUID(),assetId:f.asset.id}),{code:'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
 f.asset.sha256='0'.repeat(64);await assert.rejects(f.inspect(),{code:'TIMELINE_COLOUR_SOURCE_MISMATCH'});f.asset.sha256=sha(f.bytes);f.asset.mimeType='image/jpeg';await assert.rejects(f.inspect(),{code:'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
});
test('getters, proxy inputs and caller paths are not evaluated or read',async t=>{
 const f=await fixture(t);let called=0;await assert.rejects(f.inspect({get projectId(){called++;return f.asset.projectId;},assetId:f.asset.id}),{code:'VALIDATION_ERROR'});
 await assert.rejects(f.inspect(new Proxy({},{get(){called++;throw Error();}})),{code:'VALIDATION_ERROR'});await assert.rejects(f.inspect({projectId:f.asset.projectId,assetId:f.asset.id,path:'/outside'}),{code:'VALIDATION_ERROR'});assert.equal(called,0);
});
test('source replacement across an await, symlinks and revoked ownership fail closed',async t=>{
 const f=await fixture(t);let calls=0;await assert.rejects(readManagedTimelineImage(f.root,f.asset,{beforeEffect(){if(++calls===4)f.asset.sha256='b'.repeat(64);}},{validateSource:validateManagedSource}),{code:'TIMELINE_COLOUR_SOURCE_MISMATCH'});
 await rm(f.file);await symlink('/etc/hosts',f.file);await assert.rejects(f.inspect());
});
test('single flight, transaction and cancellation preserve lifecycle ownership',async t=>{
 const f=await fixture(t,png({width:1920,height:1080}));f.db.exec('BEGIN');await assert.rejects(f.inspect(),{code:'TIMELINE_COLOUR_SOURCE_UNAVAILABLE'});f.db.exec('ROLLBACK');
 const controller=new AbortController(),pending=f.inspect(undefined,{signal:controller.signal});await assert.rejects(f.inspect(),{code:'TIMELINE_COLOUR_SOURCE_BUSY'});controller.abort();await assert.rejects(pending,{code:'OPERATION_CANCELLED'});await f.services.drain();await assert.rejects(f.inspect(),{code:'OPERATION_CANCELLED'});
});
test('saved dimensions, alpha, stream and decoder interpretation cannot be forged',async t=>{
 const f=await fixture(t),result=await f.inspect(),media=await probe(f.file),input={source:imageColour(result.evidence).source,evidence:result.evidence,assetSha256:f.asset.sha256,probe:media.probe,streamIndex:media.videoStreamIndex};
 for(const change of [x=>x.source.evidence.width++,x=>x.evidence.alphaMode='opaque',x=>x.streamIndex=1,x=>x.probe.streams[0].pix_fmt='rgba64be',x=>x.probe.streams[0].width++]){const x=structuredClone(input);change(x);assert.throws(()=>validateTimelineImageSourceInterpretation(x));}
});
