import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {createClipDraftClient} from '../apps/web/src/clip-draft-client.ts';
import {createLocalDraftHttp} from '../apps/server/src/local-drafts-http.ts';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalDrafts,LOCAL_DRAFT_FILENAME} from '../packages/business/src/local-drafts.ts';
import {createLocalDrafts as createOldLocalDrafts} from './fixtures/local-drafts-v1-reader.ts';
import {clipDraftRawSchema,clipDraftRawV1Schema,clipDraftDiskSchema,clipDraftSlotSchema,clipDraftEnvelopeSchema,LOCAL_DRAFT_LIMITS} from '@mioon/contracts/local-drafts';
import {VOLUME_ENVELOPE_PROFILE} from '../packages/contracts/src/timeline-volume-envelope.ts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';
const storage={readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile};
const error=code=>e=>e.code===code;
const envelope=(points=[])=>({profileId:VOLUME_ENVELOPE_PROFILE,points});
function fixture(t){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-draft-format-'));
 writeFileSync(path.join(root,'workbench.sqlite'),'synthetic identity only',{mode:0o600});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const key={projectId:randomUUID(),timelineId:randomUUID(),clipId:randomUUID()};
 const asset={id:randomUUID(),projectId:key.projectId,sha256:'a'.repeat(64)};
 const clip={id:key.clipId,assetId:asset.id};
 const timeline={id:key.timelineId,projectId:key.projectId,revision:1,clips:[clip]};
 const raw={name:'Raw draft',trackId:randomUUID(),startFrame:'0',durationFrames:'90',sourceInFrame:'0',rect:{x:'0',y:'0',width:'20',height:'20'},gain:'1'};
 let fault=()=>{};
 const options={root,storage,guards:{ownsLock:()=>true,isRestored:()=>false,readTimeline:()=>timeline,readClipAsset:()=>asset},fault:p=>fault(p)};
 const drafts=createLocalDrafts(options),file=path.join(root,LOCAL_DRAFT_FILENAME);
 return {root,key,asset,clip,timeline,raw,drafts,file,options,setFault:fn=>{fault=fn;},
  input:(response=drafts.get(key),fields={})=>({...key,workspaceScope:response.workspaceScope,instanceId:response.instanceId,expectedRevision:response.revision,baseRevision:1,source:{assetId:asset.id,assetSha256:asset.sha256},raw:{...raw,...fields}}),
  deletion:response=>({...key,workspaceScope:response.workspaceScope,instanceId:response.instanceId,expectedRevision:response.revision}),
 };
}
test('strict raw schema retains bounded editing strings and absent/null independently',()=>{
 const raw={name:'',trackId:randomUUID(),startFrame:'',durationFrames:'',sourceInFrame:'',rect:{x:'',y:'',width:'',height:''},gain:''};
 for(const fields of [{},{volumeEnvelope:null},{volumeEnvelope:envelope()},{volumeEnvelope:envelope(Array.from({length:16},()=>({frame:'-1e+2.',multiplier:'.'.repeat(32)})))}]){
  const input={...raw,...fields};assert.deepEqual(clipDraftRawSchema.parse(input),input);
  assert.equal(clipDraftRawV1Schema.safeParse(input).success,!Object.hasOwn(fields,'volumeEnvelope'));
 }
 for(const value of [envelope([{frame:1,multiplier:'1'}]),envelope([{frame:'1',multiplier:1}]),envelope([{frame:'1'.repeat(9),multiplier:'1'}]),envelope([{frame:'1',multiplier:'1'.repeat(33)}]),envelope([{frame:'１',multiplier:'1'}]),envelope([{frame:'1',multiplier:' 1'}]),envelope([{frame:'1',multiplier:'\n'}]),envelope(Array.from({length:17},()=>({frame:'0',multiplier:'1'}))),{...envelope(),profileId:'future'}, {...envelope(),unknown:true}])assert.equal(clipDraftRawSchema.safeParse({...raw,volumeEnvelope:value}).success,false);
});
test('v1 read is byte-preserving; legacy PUT stays v1; explicit null promotes all rows atomically; v2 never downgrades',t=>{
 const f=fixture(t);const initial=f.drafts.put(f.input());
 let disk=JSON.parse(readFileSync(f.file));assert.equal(disk.version,1);
 const tombstone={...f.key,clipId:randomUUID(),revision:33,draft:null};
 const other={...disk.entries[0],clipId:randomUUID(),revision:19};
 disk.entries.push(tombstone,other);writeFileSync(f.file,JSON.stringify(disk)+'\n');
 const before=readFileSync(f.file);f.drafts.get(f.key);f.drafts.list({projectId:f.key.projectId});assert.deepEqual(readFileSync(f.file),before);
 const saved=f.drafts.put(f.input(initial,{volumeEnvelope:null}));disk=JSON.parse(readFileSync(f.file));
 assert.equal(disk.version,2);assert.deepEqual(disk.entries.slice(1),[tombstone,other]);assert.equal(saved.draft.raw.volumeEnvelope,null);
 const legacy=f.drafts.put(f.input(saved));assert.equal(Object.hasOwn(legacy.draft.raw,'volumeEnvelope'),false);assert.equal(JSON.parse(readFileSync(f.file)).version,2);
 f.drafts.discard(f.deletion(legacy));assert.equal(JSON.parse(readFileSync(f.file)).version,2);
 assert.equal(createLocalDrafts(f.options).get(f.key).draft,null);
});
test('actual frozen old service reads v1 but rejects v2 GET/list/PUT/DELETE without replacing bytes',t=>{
 const f=fixture(t),first=f.drafts.put(f.input()),old=createOldLocalDrafts(f.options),oldRead=old.get(f.key);
 const oldInput={...f.input(first),instanceId:oldRead.instanceId};
 const oldDelete={...f.deletion(first),instanceId:oldRead.instanceId};
 f.drafts.put(f.input(first,{volumeEnvelope:envelope([{frame:'1e',multiplier:'-.'}])}));
 const before=readFileSync(f.file);
 for(const call of [()=>old.get(f.key),()=>old.list({projectId:f.key.projectId}),()=>old.put(oldInput),()=>old.discard(oldDelete)]){
  assert.throws(call,error('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.deepEqual(readFileSync(f.file),before);
 }
 const reopened=createLocalDrafts(f.options).get(f.key);assert.deepEqual(reopened.draft.raw.volumeEnvelope,envelope([{frame:'1e',multiplier:'-.'}]));
});
test('strict v1 rejects envelope presence and strict v2 rejects future fields without repair',t=>{
 const f=fixture(t),saved=f.drafts.put(f.input()),valid=JSON.parse(readFileSync(f.file));
 const malformed=[{...valid,version:3},{...valid,extra:true},{...valid,entries:[{...valid.entries[0],draft:{...valid.entries[0].draft,raw:{...f.raw,volumeEnvelope:null}}}]},{...valid,version:2,entries:[{...valid.entries[0],draft:{...valid.entries[0].draft,raw:{...f.raw,volumeEnvelope:{...envelope(),extra:true}}}}]}];
 for(const disk of malformed){assert.equal(clipDraftDiskSchema.safeParse(disk).success,false);const bytes=JSON.stringify(disk);writeFileSync(f.file,bytes);
  for(const call of [()=>f.drafts.get(f.key),()=>f.drafts.list({projectId:f.key.projectId}),()=>f.drafts.put(f.input(saved)),()=>f.drafts.discard(f.deletion(saved))])assert.throws(call,error('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));
  assert.equal(readFileSync(f.file,'utf8'),bytes);
 }
});
test('arrays only admitted at exact points path and all descriptors inspected without getters/proxy traps',t=>{
 const f=fixture(t),input=f.input();let touched=0;
 const point={frame:'0',multiplier:'1'},getter=[point];Object.defineProperty(getter,'0',{enumerable:true,get(){touched++;return point;}});
 const sparse=Array(1),extra=[point];extra.extra=true;
 const symbol=[point];symbol[Symbol('x')]=1;
 const hidden=[point];Object.defineProperty(hidden,'0',{value:point,enumerable:false});
 const proxy=new Proxy([point],{get(){touched++;return undefined;},ownKeys(){touched++;return [];}});
 const subclass=new(class extends Array {})(point),proto=[point];Object.setPrototypeOf(proto,null);
 for(const points of [getter,sparse,extra,symbol,hidden,proxy,subclass,proto,[[point]]])assert.throws(()=>f.drafts.put({...input,raw:{...f.raw,volumeEnvelope:envelope(points)}}),error('LOCAL_DRAFT_VALIDATION'));
 for(const bad of [{...input,raw:[]},{...input,source:[]},{...input,raw:{...f.raw,rect:[]}},{...input,raw:{...f.raw,gain:[]}}])assert.throws(()=>f.drafts.put(bad),error('LOCAL_DRAFT_VALIDATION'));
 assert.equal(touched,0);assert.equal(existsSync(f.file),false);
 const good=f.drafts.put({...input,raw:{...f.raw,volumeEnvelope:envelope(Array.from({length:16},()=>point))}});assert.equal(good.draft.raw.volumeEnvelope.points.length,16);
});
for(const failure of ['beforePersist','afterPersist','beforeDirectorySync'])test(`promotion ${failure} retains old bytes or exact new bytes and supports qualified retry`,t=>{
 const f=fixture(t),first=f.drafts.put(f.input()),before=readFileSync(f.file),input=f.input(first,{volumeEnvelope:null});
 f.setFault(p=>{if(p===failure)throw Error('fixture');});assert.throws(()=>f.drafts.put(input),error(failure==='beforePersist'?'LOCAL_DRAFT_STORAGE_UNAVAILABLE':'LOCAL_DRAFT_SAVE_UNCERTAIN'));
 const disk=JSON.parse(readFileSync(f.file));assert.equal(disk.version,failure==='beforePersist'?1:2);
 if(failure==='beforePersist')assert.deepEqual(readFileSync(f.file),before);
 f.setFault(()=>{});const saved=f.drafts.put(input);assert.equal(saved.revision,2);assert.equal(saved.draft.raw.volumeEnvelope,null);assert.equal(JSON.parse(readFileSync(f.file)).version,2);
});
test('published limits stay unchanged',()=>assert.deepEqual({row:LOCAL_DRAFT_LIMITS.rowBytes,http:LOCAL_DRAFT_LIMITS.httpBytes,disk:LOCAL_DRAFT_LIMITS.envelopeBytes},{row:8192,http:12288,disk:2097152}));

const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
function maximumSlot(f){
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',escaped='\u0001'.repeat(48),hash='a'.repeat(64);
 const source={assetId:f.asset.id,assetSha256:hash,versionId:id,shotId:id,jobId:id};
 Object.assign(f.clip,{versionId:id,shotId:id,jobId:id});f.timeline.revision=Number.MAX_SAFE_INTEGER;
 const colour={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:hash,streamIndex:Number.MAX_SAFE_INTEGER,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:'2026-10-15T00:00:00.000Z'},look:{resourceId:id,resourceSha256:hash,resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:1}};
 const raw={name:'\u0001'.repeat(200),trackId:id,startFrame:escaped,durationFrames:escaped,sourceInFrame:escaped,rect:{x:escaped,y:escaped,width:escaped,height:escaped},gain:escaped,fadeInFrames:escaped,fadeOutFrames:escaped,colour,audioRole:'music'};
 return {...f.key,revision:Number.MAX_SAFE_INTEGER,draft:{baseRevision:Number.MAX_SAFE_INTEGER,source,raw,updatedAt:'2026-10-15T00:00:00.000Z'}};
}
const maximumEnvelope=()=>envelope(Array.from({length:16},()=>({frame:'9'.repeat(8),multiplier:'9'.repeat(32)})));
function sizedSlot(slot,size){
 const copy=structuredClone(slot),delta=size-bytes(copy);assert.ok(delta>=0);
 copy.draft.updatedAt='2026-10-15T00:00:00.'+'0'.repeat(3+delta)+'Z';
 assert.equal(bytes(copy),size);assert.equal(clipDraftSlotSchema.safeParse(copy).success,true);return copy;
}
function writeDisk(f,entries,version=2){
 const workspaceScope=f.drafts.get(f.key).workspaceScope;
 const disk={version,workspaceScope,entries};writeFileSync(f.file,JSON.stringify(disk)+'\n',{mode:0o600});return disk;
}
async function handlerRequest(drafts,payload,declared){
 const data=Buffer.from(payload),req=Readable.from([data.subarray(0,6144),data.subarray(6144)]);
 Object.assign(req,{method:'PUT',url:'/api/local-drafts/clip',headers:{'content-type':'application/json',...(declared===undefined?{}:{'content-length':String(declared)})}});
 const res={headers:{},destroyed:false,writableEnded:false,headersSent:false,setHeader(name,value){this.headers[name]=value;},writeHead(status,headers){this.status=status;this.headersSent=true;Object.assign(this.headers,headers);},end(body){this.body=body;this.writableEnded=true;},destroy(){this.destroyed=true;}};
 assert.equal(await createLocalDraftHttp({drafts})(req,res,new URL('http://127.0.0.1/api/local-drafts/clip')),true);
 return {...res,json:JSON.parse(res.body)};
}
test('complete ordinary6611/adversarial9373 fixtures qualify aggregate rows, requests and success wrappers',t=>{
 const f=fixture(t),legacy=maximumSlot(f),combined={...legacy,draft:{...legacy.draft,raw:{...legacy.draft.raw,volumeEnvelope:maximumEnvelope()}}};
 assert.equal(bytes(legacy),5430);assert.equal(bytes(combined),6611);
 const adversarialLegacy=sizedSlot(legacy,8192),overflow={...adversarialLegacy,draft:{...adversarialLegacy.draft,raw:combined.draft.raw}};
 assert.equal(bytes(overflow),9373);assert.equal(clipDraftSlotSchema.safeParse(overflow).success,true,'field validity does not establish aggregate admission');
 writeDisk(f,[{...legacy,revision:Number.MAX_SAFE_INTEGER-1}],1);
 const current=f.drafts.get(f.key),input={...f.input(current),baseRevision:legacy.draft.baseRevision,source:legacy.draft.source,raw:combined.draft.raw};
 const saved=f.drafts.put(input),published=JSON.parse(readFileSync(f.file));
 assert.equal(bytes(published.entries[0]),6611);assert.equal(published.version,2);assert.deepEqual(saved.draft.raw,combined.draft.raw);
 assert.equal(clipDraftEnvelopeSchema.safeParse(saved).success,true);
 const success={ok:true,data:saved};assert.ok(bytes(input)<=12288);assert.ok(bytes(success)<=12288);
 const maxRow=sizedSlot(combined,8192),maxSuccess={ok:true,data:{...saved,draft:maxRow.draft}};
 assert.equal(clipDraftEnvelopeSchema.safeParse(maxSuccess.data).success,true);assert.ok(bytes(maxSuccess)<12288);
 t.diagnostic(JSON.stringify({legacySlotBytes:bytes(legacy),ordinaryEnvelopeSlotBytes:bytes(combined),adversarialEnvelopeSlotBytes:bytes(overflow),completePutBytes:bytes(input),completeSuccessBytes:bytes(success),maximumRowSuccessBytes:bytes(maxSuccess)}));
 const scope=saved.workspaceScope;
 writeFileSync(f.file,JSON.stringify({version:2,workspaceScope:scope,entries:[overflow]}));const before=readFileSync(f.file);
 assert.throws(()=>f.drafts.get(f.key),error('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.throws(()=>f.drafts.put(input),error('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.deepEqual(readFileSync(f.file),before);
});
for(const size of [8191,8192,8193])test(`serialized complete row ${size}: inclusive real service read boundary and evidence preservation`,t=>{
 const f=fixture(t),slot=maximumSlot(f);slot.draft.raw.volumeEnvelope=maximumEnvelope();const sized=sizedSlot(slot,size);
 writeDisk(f,[sized]);const before=readFileSync(f.file);
 if(size<=8192){const got=f.drafts.get(f.key);assert.deepEqual(got.draft,sized.draft);assert.equal(f.drafts.list({projectId:f.key.projectId}).items.length,1);}
 else{assert.throws(()=>f.drafts.get(f.key),error('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.throws(()=>f.drafts.list({projectId:f.key.projectId}),error('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));}
 assert.deepEqual(readFileSync(f.file),before);
});
test('actual HTTP handler accepts12287/12288 and refuses12289 bytes before mutation for declared and streamed requests',async t=>{
 const f=fixture(t),input=f.input(undefined,{volumeEnvelope:maximumEnvelope()}),payload=JSON.stringify(input);
 const saved=f.drafts.put(input),before=readFileSync(f.file);
 for(const declared of [true,false])for(const size of [12287,12288,12289]){
  const body=payload+' '.repeat(size-Buffer.byteLength(payload));assert.equal(Buffer.byteLength(body),size);
  const response=await handlerRequest(f.drafts,body,declared?size:undefined);
  assert.equal(response.status,size<=12288?200:413);
  if(size<=12288)assert.deepEqual(response.json,{ok:true,data:saved});else assert.equal(response.json.error.code,'LOCAL_DRAFT_LIMIT');
  assert.deepEqual(readFileSync(f.file),before,'exact replay or size refusal cannot rewrite the promoted file');
 }
});
test('complete 128 maximum rows and mixed tombstones fit disk accounting; no 129th slot eviction',t=>{
 const f=fixture(t),slot=maximumSlot(f);slot.draft.raw.volumeEnvelope=maximumEnvelope();const full=sizedSlot(slot,8192);
 const entries=Array.from({length:128},(_,i)=>({...structuredClone(full),clipId:i===0?f.key.clipId:`${String(i).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`}));
 const disk=writeDisk(f,entries),serialized=JSON.stringify(disk)+'\n',accounted=bytes({version:2,workspaceScope:disk.workspaceScope,entries:[]})+128*8192+127+1;
 assert.equal(Buffer.byteLength(serialized),accounted);assert.ok(accounted<2097152);assert.equal(clipDraftDiskSchema.safeParse(disk).success,true);
 assert.equal(f.drafts.list({projectId:f.key.projectId}).items.length,128);assert.equal(readFileSync(f.file,'utf8'),serialized);
 const tombstone={...f.key,clipId:entries[127].clipId,revision:Number.MAX_SAFE_INTEGER,draft:null};disk.entries[127]=tombstone;
 const mixed=JSON.stringify(disk)+'\n';writeFileSync(f.file,mixed);assert.equal(f.drafts.list({projectId:f.key.projectId}).items.length,127);
 assert.equal(Buffer.byteLength(mixed),accounted-8192+bytes(tombstone));assert.equal(readFileSync(f.file,'utf8'),mixed);
 // A new target still matching the owned graph cannot evict a tombstone.
 const newClip={...f.clip,id:randomUUID()};f.timeline.clips.push(newClip);const key={...f.key,clipId:newClip.id},current=f.drafts.get(key);
 const input={...f.input(current),...key,baseRevision:f.timeline.revision,source:full.draft.source,raw:f.raw};
 assert.throws(()=>f.drafts.put(input),error('LOCAL_DRAFT_CAPACITY'));assert.equal(readFileSync(f.file,'utf8'),mixed);
 t.diagnostic(JSON.stringify({max128RowsDiskBytes:accounted,mixed127RowsOneTombstoneBytes:Buffer.byteLength(mixed),tombstoneBytes:bytes(tombstone),metadataCommasNewlineBytes:accounted-128*8192}));
});
for(const size of [2097151,2097152,2097153])test(`actual companion file ${size} bytes: whitespace counts toward disk read cap`,t=>{
 const f=fixture(t),initial=f.drafts.get(f.key),json=JSON.stringify({version:2,workspaceScope:initial.workspaceScope,entries:[]});
 const contents=json+' '.repeat(size-Buffer.byteLength(json)-1)+'\n';assert.equal(Buffer.byteLength(contents),size);writeFileSync(f.file,contents,{mode:0o600});
 if(size<=2097152){assert.equal(f.drafts.get(f.key).draft,null);assert.deepEqual(f.drafts.list({projectId:f.key.projectId}).items,[]);}
 else{assert.throws(()=>f.drafts.get(f.key),error('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.throws(()=>f.drafts.put(f.input(initial)),error('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));}
 assert.equal(readFileSync(f.file,'utf8'),contents,'reads preserve every original whitespace byte');
});
test('maximum-row success wrapper accepts12287/12288 and rejects12289 actual client response bytes',async t=>{
 const f=fixture(t),slot=maximumSlot(f);slot.draft.raw.volumeEnvelope=maximumEnvelope();writeDisk(f,[sizedSlot(slot,8192)]);
 const result=f.drafts.get(f.key),json=JSON.stringify({ok:true,data:result});assert.equal(Buffer.byteLength(json),8398);
 for(const declared of [true,false])for(const size of [12287,12288,12289]){
  const payload=new TextEncoder().encode(json+' '.repeat(size-Buffer.byteLength(json)));assert.equal(payload.length,size);
  const client=createClipDraftClient(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(payload.subarray(0,6144));controller.enqueue(payload.subarray(6144));controller.close();}}),{headers:declared?{'Content-Length':String(size)}:{}}));
  if(size<=12288)assert.deepEqual(await client.get(f.key),result);
  else await assert.rejects(client.get(f.key),error('LOCAL_DRAFT_PROTOCOL_UNKNOWN'));
 }
});
