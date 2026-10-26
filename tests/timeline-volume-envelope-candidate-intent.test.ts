import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {schemas} from '../packages/contracts/src/index.ts';
import {isEditTask} from '../packages/contracts/src/edit-tasks.ts';
import {VOLUME_ENVELOPE_PROFILE as profileId} from '../packages/contracts/src/timeline-volume-envelope.ts';
import {captureVolumeEnvelopeCandidateIntent as capture,volumeEnvelopeCandidateIntentDigest as digest,isVolumeEnvelopeCandidateEditTask as taskValid} from './helpers/timeline-volume-envelope-candidate-intent.ts';
const id='11111111-1111-4111-8111-111111111111', add='timeline.clip.add',update='timeline.clip.update';
const envelope=()=>({profileId,points:Array.from({length:16},(_,i)=>({frame:i,multiplier:i/15}))});
const input=()=>({projectId:id,expectedRevision:1,requestId:'request-envelope',assetId:id,trackId:id,name:'clip',startFrame:0,durationFrames:20,sourceInFrame:0,rect:{x:0,y:0,width:1280,height:720},gain:1,fadeInFrames:1,fadeOutFrames:1,audioRole:'human',volumeEnvelope:envelope()});
const bad=(v?: unknown)=>assert.throws(()=>capture(add,v));
test('complete candidate intent is detached and bounded while live schema admission grants no workspace authority',()=>{
 const v=input(),before=JSON.stringify(v),result=capture(add,v);
 assert.equal(JSON.stringify(v),before);assert.deepEqual(result.input,v);assert.notEqual(result.input.volumeEnvelope.points,v.volumeEnvelope.points);
 assert.ok(result.nodes<=128&&result.depth<=8&&result.bytes<=8192);assert.equal(schemas[add].safeParse(v).success,true);
 for(const e of ([undefined,null,envelope()] as const)){
  const v=input();if(e===undefined)delete (v as {volumeEnvelope?: unknown}).volumeEnvelope;else v.volumeEnvelope=(e as unknown as (typeof v)["volumeEnvelope"]);
  const result=capture(add,v).input;assert.equal(Object.hasOwn(((result) as unknown as Parameters<typeof Object.hasOwn>[0]),'volumeEnvelope'),e!==undefined);assert.deepEqual(result,v);
 }
 const v2={projectId:id,expectedRevision:1,requestId:'request-envelope',clipId:id,patch:{volumeEnvelope:envelope()}};
 assert.throws(()=>capture(update,v2));assert.deepEqual(capture(update,v2,{durationFrames:20}).input,v2);
 assert.throws(()=>capture(update,{...v2,patch:{}}));assert.throws(()=>capture(update,{...v2,patch:{volumeEnvelope:undefined}}));
 assert.throws(()=>capture(update,v2,{durationFrames:10}));
 assert.deepEqual((capture(update,{...v2,patch:{volumeEnvelope:null}}).input as {patch:unknown}).patch,{volumeEnvelope:null});
});
test('only the typed points path admits an ordinary dense bounded array without running code',()=>{
 for(const field of (['name','gain','rect','assetId','unexpected'] as const))bad({...input(),[field]:[]});
 for(const points of ([[],new Array(2),Array(17).fill({frame:0,multiplier:1}),[[0,1]],Object.assign([{frame:0,multiplier:1}],{extra:1}),Object.setPrototypeOf([{frame:0,multiplier:1}],null)] as const))bad({...input(),volumeEnvelope:{profileId,points}});
 let calls=0;const get=()=>{calls++;throw Error('called');};
 const point={frame:0};Object.defineProperty(point,'multiplier',{enumerable:true,get});
 bad({...input(),volumeEnvelope:{profileId,points:[point]}});
 const arr=[{frame:0,multiplier:1}];Object.defineProperty(arr,'0',{enumerable:true,get});bad({...input(),volumeEnvelope:{profileId,points:arr}});
 const v=input();Object.defineProperty(v,'volumeEnvelope',{enumerable:true,get});bad(v);
 const handler={get,getPrototypeOf:get,ownKeys:get,getOwnPropertyDescriptor:get};
 bad(new Proxy(input(),handler));bad({...input(),volumeEnvelope:new Proxy(envelope(),handler)});bad({...input(),volumeEnvelope:{profileId,points:new Proxy(envelope().points,handler)}});
 assert.equal(calls,0);
 const nested=input();nested.volumeEnvelope.points[0].multiplier=([] as unknown as ((((typeof nested)["volumeEnvelope"])["points"])[number])["multiplier"]);bad(nested);
 for(const extra of ([{toJSON(){return null;}},{unexpected:undefined},{unexpected:Symbol('x')},{unexpected:NaN}] as const))bad({...input(),...extra});
 const symbol=input();(symbol as unknown as Record<symbol,unknown>)[Symbol('x')]=1;bad(symbol);
 const hidden=input();Object.defineProperty(hidden,'hidden',{value:1});bad(hidden);
});
test('node, depth, unicode and complete bytes fail closed without changing caps',()=>{
 const nodes=input();(nodes as typeof nodes & {extra:({ [k: string]: number; })|({ a: { b: { c: { d: { e: { f: { g: { h: { i: number; }; }; }; }; }; }; }; }; })}).extra=Object.fromEntries(Array.from({length:128},(_,i)=>['x'+i,0]));bad(nodes);
 const deep=input();(deep as typeof deep & {extra:({ [k: string]: number; })|({ a: { b: { c: { d: { e: { f: { g: { h: { i: number; }; }; }; }; }; }; }; }; })}).extra={a:{b:{c:{d:{e:{f:{g:{h:{i:1}}}}}}}}};bad(deep);
 bad({...input(),name:'\ud800'});bad({...input(),requestId:'x'.repeat(8193)});
 // A valid bounded candidate still includes escaped strings in actual byte count.
 const escaped=input();escaped.name='\u0001'.repeat(200);escaped.requestId='\u0002'.repeat(200);
 const r=capture(add,escaped);assert.equal(r.bytes,Buffer.byteLength(JSON.stringify(escaped)));assert.ok(r.bytes<8192);
});
test('complete candidate task binds exact intent including presence and all IDs',()=>{
 const v=input();const task={id,projectId:id,operation:add,input:v,requestId:v.requestId,digest:(digest as (...args:Partial<Parameters<typeof digest>>)=>ReturnType<typeof digest>)(add,v),lane:'timeline:mutation',status:'prepared',revision:1,createdAt:'2026-10-15T00:00:00Z',updatedAt:'2026-10-15T00:00:00Z',acknowledged:false,origin:'new'};
 assert.equal((taskValid as (...args:Partial<Parameters<typeof taskValid>>)=>ReturnType<typeof taskValid>)(task),true);assert.equal(isEditTask(task),true);
 // The structural task guard grants no ledger authority. Live capture hashes
 // operation/input without the standalone candidate's explicit hash domain.
 const liveText=JSON.stringify({operation:add,input:v},(_,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
 assert.notEqual(task.digest,createHash('sha256').update(liveText).digest('hex'));
 for(const change of ([{requestId:'another-request'},{projectId:'22222222-2222-4222-8222-222222222222'},{digest:'0'.repeat(64)},{unexpected:1},{input:{...v,volumeEnvelope:null}},{input:{...v,name:'changed'}}] as const))assert.equal((taskValid as (...args:Partial<Parameters<typeof taskValid>>)=>ReturnType<typeof taskValid>)({...task,...change}),false);
 const absent={...v};delete (absent as {volumeEnvelope?: unknown}).volumeEnvelope;assert.notEqual((digest as (...args:Partial<Parameters<typeof digest>>)=>ReturnType<typeof digest>)(add,absent),(digest as (...args:Partial<Parameters<typeof digest>>)=>ReturnType<typeof digest>)(add,{...v,volumeEnvelope:null}));
 const reordered=Object.fromEntries(Object.entries(v).reverse());assert.equal((digest as (...args:Partial<Parameters<typeof digest>>)=>ReturnType<typeof digest>)(add,v),(digest as (...args:Partial<Parameters<typeof digest>>)=>ReturnType<typeof digest>)(add,reordered));
 let calls=0;const hostile={...task};Object.defineProperty(hostile,'input',{enumerable:true,get(){calls++;throw Error();}});assert.equal((taskValid as (...args:Partial<Parameters<typeof taskValid>>)=>ReturnType<typeof taskValid>)(hostile),false);assert.equal(calls,0);
});
test('candidate is absent from production root and package export surface',()=>{
 const root=readFileSync(new URL('../packages/contracts/src/index.ts',import.meta.url),'utf8');
 const pkg=JSON.parse(readFileSync(new URL('../packages/contracts/package.json',import.meta.url),'utf8'));
 assert.equal(root.includes('timeline-volume-envelope-candidate'),false);assert.equal(JSON.stringify(pkg.exports).includes('volume-envelope'),false);
 assert.equal(Object.keys(schemas).some(k=>/envelope/i.test(k)),false);
});
test('maximal complete add and update include the largest current colour declaration within unchanged budgets',t=>{
 const hash='f'.repeat(64),sourceProfile='jfif-ycbcr8-srgb-v1';
 const colour={profileId:'mioon-jfif-image-clip-v1',source:{assetSha256:hash,profileId:sourceProfile,interpretation:'srgb',declaredBy:'user',declaredAt:'2026-10-15T00:00:00.000Z',evidence:{profileId:sourceProfile,sha256:hash,sourceByteLength:33554432,width:1920,height:1080,bitDepth:8,alphaMode:'opaque',orientation:1,colourTag:'untagged',sampling:'420',decoderPolicy:'ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1'}},look:{resourceId:id,resourceSha256:hash,resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:1}};
 const v={...input(),expectedRevision:Number.MAX_SAFE_INTEGER-1,volumeEnvelope:{profileId,points:Array.from({length:16},(_,i)=>({frame:17985+i,multiplier:1.2345678901234567e-100}))},colour,name:'\u0001'.repeat(200),requestId:'\u0002'.repeat(200),startFrame:0,durationFrames:18000,sourceInFrame:Number.MAX_SAFE_INTEGER-18000,gain:2,fadeInFrames:9000,fadeOutFrames:9000};
 const a=capture(add,v);const {projectId,expectedRevision,requestId,assetId,...patch}=v;
 const u=capture(update,{projectId,expectedRevision,requestId,clipId:id,patch});
 for(const r of ([a,u] as const)){assert.ok(r.bytes<=6541);assert.ok(r.nodes<=128);assert.ok(r.depth<=8);}
 t.diagnostic(JSON.stringify({maximalAdd:{bytes:a.bytes,nodes:a.nodes,depth:a.depth},maximalUpdate:{bytes:u.bytes,nodes:u.nodes,depth:u.depth}}));
 // Shape admission is not source eligibility: this worst-size JPEG declaration
 // must still be rejected by future source eligibility for non-null automation.
});
test('duration context is descriptor-checked before selection, including digest and task entry points',()=>{
 let calls=0;const get=()=>{calls++;throw Error('must not run');};
 const getter={};Object.defineProperty(getter,'durationFrames',{enumerable:true,get});
 const proxy=new Proxy({durationFrames:20},{get,getPrototypeOf:get,ownKeys:get,getOwnPropertyDescriptor:get});
 for(const context of ([getter,proxy,[],{durationFrames:undefined},{durationFrames:0},{durationFrames:20,unexpected:1}] as const)){
  assert.throws(()=>capture(add,input(),context));assert.throws(()=>digest(add,input(),context));
  const v=input(),task={id,projectId:id,operation:add,input:v,requestId:v.requestId,digest:(digest as (...args:Partial<Parameters<typeof digest>>)=>ReturnType<typeof digest>)(add,v),lane:'timeline:mutation',status:'prepared',revision:1,createdAt:'2026-10-15T00:00:00Z',updatedAt:'2026-10-15T00:00:00Z',acknowledged:false,origin:'new'};
  assert.equal(taskValid(task,context),false);
 }
 assert.equal(calls,0);
});
