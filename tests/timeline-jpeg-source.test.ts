import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createTimelineImageSourceServices,readManagedTimelineImage,validateTimelineImageSourceInterpretation} from '../packages/business/src/timeline-image-source.ts';
import {validateManagedSource} from '../packages/business/src/managed-media.ts';
import {runStreaming} from '../packages/business/src/media-runtime.ts';
import {waitForMediaProcesses} from '../packages/business/src/media-processes.ts';
import {probe} from '../packages/business/src/media.ts';
import {pillowJfifFixture} from './helpers/timeline-jpeg-fixtures.ts';
import {jpegColour} from './helpers/timeline-jpeg-workflow-fixtures.ts';
import {sha} from './helpers/timeline-image-fixtures.ts';
const deferred=<T = unknown>(): {promise: Promise<T>; resolve: (value: T) => void} => {let resolve!: (value: T) => void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};};
type ServiceFixture = ReturnType<typeof createTimelineImageSourceServices>;
interface SourceFixture {root: string; db: DatabaseSync; asset: {id: string; projectId: string; sha256: string; sizeBytes: number; mimeType: string; relativePath: string}; file: string; bytes: Buffer; runtime: Record<string, unknown>; services: ServiceFixture; inspect(context?: unknown): Promise<Record<string, unknown> & {status: string; evidence: Record<string, unknown>}>}
async function fixture(t: import('node:test').TestContext, override: Record<string, unknown> = {}): Promise<SourceFixture> {
 const root=await mkdtemp(path.join(tmpdir(),'mioon-jfif-source-'));await mkdir(path.join(root,'media'),{mode:0o700});const bytes=pillowJfifFixture(),file=path.join(root,'media/source.jpg');await writeFile(file,bytes,{mode:0o600});const db=new DatabaseSync(':memory:');
 const asset={id:randomUUID(),projectId:randomUUID(),sha256:sha(bytes),sizeBytes:bytes.length,mimeType:'image/jpeg',relativePath:'media/source.jpg'};
 const runtime={validateSource:validateManagedSource,runStreaming,waitForMediaProcesses,ownsLock:()=>true,assertOrdinaryWorkspace(){},readOwnedAsset:(projectId: string,assetId: string)=>projectId===asset.projectId&&assetId===asset.id?asset:null,...override};
 const services=createTimelineImageSourceServices({db,root},{runtime});t.after(async()=>{await services.drain();db.close();await rm(root,{recursive:true,force:true});});
 return{root,db,asset,file,bytes,runtime,services,inspect:(context?: unknown)=> (services.handlers['timeline.colour.jpeg.inspect'] as (input: Record<string, unknown>, context?: unknown) => Promise<Record<string, unknown> & {status: string; evidence: Record<string, unknown>}>)({projectId:asset.projectId,assetId:asset.id},context)};
}
test('owned JPEG inspection performs exact bounded decode, no writes and no implicit colour claim',async t=>{
 let decodes=0;const f=await fixture(t,{runStreaming:async(...args: Parameters<typeof runStreaming>)=>{decodes++;return runStreaming(...args);}}),before=(f.db.prepare('SELECT total_changes() n').get() as {n: number}).n;
 const result=await f.inspect();assert.equal(decodes,1);assert.equal(result.status,'needs_interpretation');assert.equal(result.evidence.colourTag,'untagged');assert.equal(result.evidence.alphaMode,'opaque');assert.equal(JSON.stringify(result).includes(f.root),false);assert.deepEqual(await readFile(f.file),f.bytes);assert.equal((f.db.prepare('SELECT total_changes() n').get() as {n: number}).n,before);
 const media=await probe(f.file),input={source:jpegColour(result.evidence as never).source,evidence:result.evidence,assetSha256:f.asset.sha256,probe:media.probe,streamIndex:media.videoStreamIndex};
 assert.deepEqual(validateTimelineImageSourceInterpretation(input),result.evidence);
 interface InterpretationInput { source: { evidence: Record<string, unknown>; [key: string]: unknown }; evidence: Record<string, unknown>; probe: { streams: Record<string, unknown>[]; [key: string]: unknown }; [key: string]: unknown }
 const changes: ((value: InterpretationInput) => unknown)[] = [x=>{(x.source.evidence as Record<string, unknown>).sampling='444';},x=>{(x.evidence as Record<string, unknown>).decoderPolicy='automatic';},x=>{(x.probe.streams[0] as Record<string, unknown>).pix_fmt='yuv420p';},x=>{(x as unknown as Record<string, unknown>).streamIndex=1;},x=>{(x.source.evidence as Record<string, unknown>).orientation=6;}];
 for(const change of changes){const bad=structuredClone(input);change(bad);assert.throws(()=>validateTimelineImageSourceInterpretation(bad));}
});
test('strict decoder failure cannot produce JPEG evidence or infer compatibility',async t=>{
 const failure=Object.assign(Error('strict decoder failed'),{code:'MEDIA_EXIT_FAILED'});const f=await fixture(t,{runStreaming:async()=>{throw failure;}});
 await assert.rejects(f.inspect(),failure);
 await assert.rejects(readManagedTimelineImage(f.root,f.asset,{}, {validateSource:validateManagedSource}),{code:'TIMELINE_COLOUR_SOURCE_UNAVAILABLE'});
});
test('outer timeout retains terminationUnconfirmed and single-flight permit until actual child join',async t=>{
 const started=deferred<void>(),joined=deferred<void>();let decodeSignal: AbortSignal | undefined,joinSignal: AbortSignal | undefined;
 const f=await fixture(t,{runStreaming:async(_command: string,_args: string[],{signal}: {signal: AbortSignal})=>{decodeSignal=signal;started.resolve();await new Promise<void>(resolve=>{signal.addEventListener('abort',()=>resolve(),{once:true});});throw Object.assign(Error('unconfirmed exact child'),{code:'MEDIA_CANCELLED',terminationUnconfirmed:true});},waitForMediaProcesses:({signal}: {signal: AbortSignal})=>{joinSignal=signal;return joined.promise;}});
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=f.inspect();const rejected=assert.rejects(pending,(error: unknown)=>{const failure=error as {code?: string; terminationUnconfirmed?: boolean};return failure.code==='TIMELINE_COLOUR_SOURCE_TIMEOUT'&&failure.terminationUnconfirmed===true;});
 await started.promise;t.mock.timers.tick(15000);await rejected;assert.equal(joinSignal,decodeSignal);
 await assert.rejects(f.inspect(),{code:'TIMELINE_COLOUR_SOURCE_BUSY'});
 let drained=false;const drain=f.services.drain().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);joined.resolve();await drain;assert.equal(drained,true);t.mock.timers.reset();
});

test('drain begun before decoder rejection still awaits the subsequently installed exact-child join',async t=>{
 const started=deferred<void>(),failed=deferred<void>(),joined=deferred<void>();
 const f=await fixture(t,{runStreaming:async()=>{started.resolve();await failed.promise;throw Object.assign(Error('unconfirmed exact child'),{code:'MEDIA_CANCELLED',terminationUnconfirmed:true});},waitForMediaProcesses:()=>joined.promise});
 const rejected=assert.rejects(f.inspect(),(error: unknown)=>(error as {terminationUnconfirmed?: boolean}).terminationUnconfirmed===true);await started.promise;
 let drained=false;const drain=f.services.drain().then(()=>{drained=true;});failed.resolve();await rejected;
 await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);joined.resolve();await drain;assert.equal(drained,true);
});
