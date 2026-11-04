import type {OrdinaryLocalDrafts} from './helpers/strict-timeline-audio-draft-types.ts';
import type {ClipDraftRaw} from '@mioon/contracts/local-drafts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {createClipDraftClient} from '../apps/web/src/clip-draft-client.ts';
import {createLocalDraftHttp} from '../apps/server/src/local-drafts-http.ts';
import {mkdtempSync,realpathSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalDrafts,LOCAL_DRAFT_FILENAME} from '../packages/business/src/local-drafts.ts';
import {clipDraftRawSchema,clipDraftRawV1Schema,clipDraftDiskSchema,clipDraftSlotSchema,clipDraftEnvelopeSchema,LOCAL_DRAFT_LIMITS, type ClipDraftEnvelope, type ClipDraftList} from '@mioon/contracts/local-drafts';
import {VOLUME_ENVELOPE_PROFILE} from '../packages/contracts/src/timeline-volume-envelope.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {ownsStoreLock} from '../packages/business/src/store-runtime.ts';
import {clipDraftEntries,clipDraftSnapshot,seedClipDraftEntries} from './helpers/local-clip-draft-sql.ts';
const error=(code: string)=>(e: unknown)=>(e as {code:string}).code===code;
const envelope=<T=unknown>(points:T[]=[])=>({profileId:VOLUME_ENVELOPE_PROFILE as typeof VOLUME_ENVELOPE_PROFILE,points});
function fixture(t: test.TestContext){
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-draft-format-'));
 const store=openStore(root);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const key={projectId:store.projectId,timelineId:randomUUID(),clipId:randomUUID()};
 const asset={id:randomUUID(),projectId:key.projectId,sha256:'a'.repeat(64)};
 const clip={id:key.clipId,assetId:asset.id};
 const timeline={id:key.timelineId,projectId:key.projectId,revision:1,clips:[clip]};
 const raw={name:'Raw draft',trackId:randomUUID(),startFrame:'0',durationFrames:'90',sourceInFrame:'0',rect:{x:'0',y:'0',width:'20',height:'20'},gain:'1'};
 let fault:(phase:string)=>void=()=>{};
 const options={store,guards:{ownsLock:()=>ownsStoreLock(store),readTimeline:()=>timeline,readClipAsset:()=>asset},fault:(p: string)=>fault(p)};
 const drafts=(createLocalDrafts(options as unknown as Parameters<typeof createLocalDrafts>[0]) as OrdinaryLocalDrafts),file=path.join(store.localDir,LOCAL_DRAFT_FILENAME);
 return {root,store,key,asset,clip,timeline,raw,drafts,file,options,setFault:(fn: (phase:string) => void)=>{fault=fn;},
  input:(response=drafts.get(key),fields={})=>({...key,workspaceScope:response.workspaceScope,instanceId:response.instanceId,expectedRevision:response.revision,baseRevision:1,source:{assetId:asset.id,assetSha256:asset.sha256},raw:{...raw,...fields}}),
  deletion:(response: { workspaceScope: unknown; instanceId: unknown; revision: unknown; })=>({...key,workspaceScope:response.workspaceScope,instanceId:response.instanceId,expectedRevision:response.revision}),
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
test('SQL raw retains absent/null and neighboring slots atomically without a private container promotion',t=>{
 const f=fixture(t),initial=f.drafts.put(f.input());
 let disk=readDisk(f);assert.equal(disk.version,2);
 const tombstone={...f.key,clipId:randomUUID(),revision:33,draft:null};
 const other={...disk.entries[0],clipId:randomUUID(),revision:19};
 writeDisk(f,[...disk.entries,tombstone,other]);
 const before=clipDraftSnapshot(f.store);f.drafts.get(f.key);f.drafts.list({projectId:f.key.projectId});assert.equal(clipDraftSnapshot(f.store),before);
 const saved=f.drafts.put(f.input(initial,{volumeEnvelope:null}));disk=readDisk(f);
 assert.equal(disk.version,2);assert.deepEqual(disk.entries.slice(1),[tombstone,other]);assert.equal(saved.draft!.raw.volumeEnvelope,null);
 const absent=f.drafts.put(f.input(saved));assert.equal(Object.hasOwn(absent.draft!.raw,'volumeEnvelope'),false);assert.equal(readDisk(f).version,2);
 f.drafts.discard(f.deletion(absent));assert.equal(readDisk(f).version,2);
 assert.equal((createLocalDrafts(f.options) as OrdinaryLocalDrafts).get(f.key).draft,null);assert.equal(existsSync(f.file),false);
});
test('retired v1 and v2 files are never read, imported or changed by SQL GET/list/PUT/DELETE',t=>{
 const f=fixture(t),first=f.drafts.put(f.input()),value=envelope([{frame:'1e',multiplier:'-.'}]);
 for(const version of [1,2]){
  const old=JSON.stringify({version,workspaceScope:'f'.repeat(64),entries:[]});writeFileSync(f.file,old,{mode:0o600});
  for(const call of [()=>f.drafts.get(f.key),()=>f.drafts.list({projectId:f.key.projectId}),()=>f.drafts.put(f.input(undefined,{volumeEnvelope:value})),()=>f.drafts.discard(f.deletion(f.drafts.get(f.key)))]){
   assert.ok(call());assert.equal(readFileSync(f.file,'utf8'),old);
  }
 }
 const saved=f.drafts.put(f.input(undefined,{volumeEnvelope:value}));assert.ok(saved.revision>first.revision);
 const reopened=(createLocalDrafts(f.options) as OrdinaryLocalDrafts).get(f.key);assert.deepEqual(reopened.draft!.raw.volumeEnvelope,value);
});
test('SQL typed slot reader rejects future nested fields without repairing corrupt evidence',t=>{
 const f=fixture(t),saved=f.drafts.put(f.input()),valid=clipDraftEntries(f.store)[0] as ReturnType<typeof maximumSlot>;
 const malformed=[{...valid,draft:{...valid.draft,extra:true}},{...valid,draft:{...valid.draft,raw:{...f.raw,extra:true}}},{...valid,draft:{...valid.draft,source:{...valid.draft.source,credentials:'PRIVATE'}}},{...valid,draft:{...valid.draft,raw:{...f.raw,volumeEnvelope:{...envelope(),extra:true}}}}];
 for(const row of malformed){assert.equal(clipDraftSlotSchema.safeParse(row).success,false);seedClipDraftEntries(f.store,saved.workspaceScope,[row]);const before=clipDraftSnapshot(f.store);
  for(const call of [()=>f.drafts.get(f.key),()=>f.drafts.list({projectId:f.key.projectId}),()=>f.drafts.put(f.input(saved)),()=>f.drafts.discard(f.deletion(saved))])assert.throws(call,error('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));
  assert.equal(clipDraftSnapshot(f.store),before);
 }
});
test('arrays only admitted at exact points path and all descriptors inspected without getters/proxy traps',t=>{
 const f=fixture(t),input=f.input();let touched=0;
 const point={frame:'0',multiplier:'1'},getter=[point];Object.defineProperty(getter,'0',{enumerable:true,get(){touched++;return point;}});
 const sparse=Array(1),extra:typeof point[] & {extra?:boolean}=[point];extra.extra=true;
 const symbol=[point] as typeof point[] & {[key:symbol]:unknown};symbol[Symbol('x')]=1;
 const hidden=[point];Object.defineProperty(hidden,'0',{value:point,enumerable:false});
 const proxy=new Proxy([point],{get(){touched++;return undefined;},ownKeys(){touched++;return [];}});
 const subclass=new(class extends Array<unknown> {})(point),proto=[point];Object.setPrototypeOf(proto,null);
 for(const points of [getter,sparse,extra,symbol,hidden,proxy,subclass,proto,[[point]]])assert.throws(()=>f.drafts.put({...input,raw:{...f.raw,volumeEnvelope:envelope(points)}}),error('LOCAL_DRAFT_VALIDATION'));
 for(const bad of [{...input,raw:[]},{...input,source:[]},{...input,raw:{...f.raw,rect:[]}},{...input,raw:{...f.raw,gain:[]}}])assert.throws(()=>f.drafts.put(bad),error('LOCAL_DRAFT_VALIDATION'));
 assert.equal(touched,0);assert.equal(existsSync(f.file),false);
 const good=f.drafts.put({...input,raw:{...f.raw,volumeEnvelope:envelope(Array.from({length:16},()=>point))}});assert.equal(good.draft!.raw.volumeEnvelope!.points.length,16);
});
for(const failure of ['beforePersist','beforeCommit','afterCommit','afterPersist','beforeConfirm'])test(`SQL save ${failure} retains old row or exact new row and supports qualified retry`,t=>{
 const f=fixture(t),first=f.drafts.put(f.input()),before=clipDraftSnapshot(f.store),input=f.input(first,{volumeEnvelope:null}),precommit=['beforePersist','beforeCommit'].includes(failure);
 f.setFault((p:string)=>{if(p===failure)throw Error('fixture');});assert.throws(()=>f.drafts.put(input),error(precommit?'LOCAL_DRAFT_STORAGE_UNAVAILABLE':'LOCAL_DRAFT_SAVE_UNCERTAIN'));
 const disk=readDisk(f);assert.equal(disk.entries[0].revision,precommit?1:2);
 if(precommit)assert.equal(clipDraftSnapshot(f.store),before);
 f.setFault(()=>{});const saved=f.drafts.put(input);assert.equal(saved.revision,2);assert.equal(saved.draft!.raw.volumeEnvelope,null);assert.equal(readDisk(f).version,2);
});
test('published limits stay unchanged',()=>assert.deepEqual({row:LOCAL_DRAFT_LIMITS.rowBytes,http:LOCAL_DRAFT_LIMITS.httpBytes,disk:LOCAL_DRAFT_LIMITS.envelopeBytes},{row:8192,http:12288,disk:2097152}));

const bytes=(value: unknown)=>Buffer.byteLength(JSON.stringify(value),'utf8');
function maximumSlot(f: Awaited<ReturnType<typeof fixture>>){
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',escaped='\u0001'.repeat(48),hash='a'.repeat(64);
 const source={assetId:f.asset.id,assetSha256:hash,versionId:id,shotId:id,jobId:id};
 Object.assign(f.clip,{versionId:id,shotId:id,jobId:id});f.timeline.revision=Number.MAX_SAFE_INTEGER;
 const colour:NonNullable<ClipDraftRaw["colour"]>={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:hash,streamIndex:Number.MAX_SAFE_INTEGER,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:'2026-10-15T00:00:00.000Z'},look:{resourceId:id,resourceSha256:hash,resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:1}};
 const raw: ClipDraftRaw={name:'\u0001'.repeat(200),trackId:id,startFrame:escaped,durationFrames:escaped,sourceInFrame:escaped,rect:{x:escaped,y:escaped,width:escaped,height:escaped},gain:escaped,fadeInFrames:escaped,fadeOutFrames:escaped,colour,audioRole:'music'};
 return {...f.key,revision:Number.MAX_SAFE_INTEGER,draft:{baseRevision:Number.MAX_SAFE_INTEGER,source,raw,updatedAt:'2026-10-15T00:00:00.000Z'}};
}
const maximumEnvelope=()=>envelope(Array.from({length:16},()=>({frame:'9'.repeat(8),multiplier:'9'.repeat(32)})));
function sizedSlot<T extends ReturnType<typeof maximumSlot>>(slot:T,size:number){
 const copy=structuredClone(slot),delta=size-bytes(copy);assert.ok(delta>=0);
 copy.draft.updatedAt='2026-10-15T00:00:00.'+'0'.repeat(3+delta)+'Z';
 assert.equal(bytes(copy),size);assert.equal(clipDraftSlotSchema.safeParse(copy).success,true);return copy;
}
function readDisk(f:ReturnType<typeof fixture>){return {version:2,workspaceScope:String(f.store.db.prepare("SELECT workspaceScope FROM local_draft_states WHERE kind='clip'").get()?.workspaceScope??f.drafts.get(f.key).workspaceScope),entries:clipDraftEntries(f.store) as ReturnType<typeof maximumSlot>[]};}
function writeDisk(f:ReturnType<typeof fixture>,entries:readonly {projectId:string;timelineId:string;clipId:string;revision:number;draft:unknown}[]){
 const workspaceScope=f.drafts.get(f.key).workspaceScope;
 seedClipDraftEntries(f.store,workspaceScope,entries);return {version:2,workspaceScope,entries:[...entries]};
}
async function handlerRequest(drafts: { assertProjectDeletable(projectId: string): void; removeProject(projectId: string): void; get(input: unknown): ClipDraftEnvelope; list(input: unknown): ClipDraftList; put(input: unknown): ClipDraftEnvelope; discard(input: unknown): ClipDraftEnvelope; },payload: string,declared: number|undefined){
 const data=Buffer.from(payload),req=Readable.from([data.subarray(0,6144),data.subarray(6144)]);
 Object.assign(req,{method:'PUT',url:'/api/local-drafts/clip',headers:{'content-type':'application/json',...(declared===undefined?{}:{'content-length':String(declared)})}});
 const res:{headers:Record<string,unknown>;status?:number;body?:string;destroyed:boolean;writableEnded:boolean;headersSent:boolean;setHeader(name:string|number,value:unknown):void;writeHead(status:number,headers:Record<string,unknown>):void;end(body:string):void;destroy():void}={headers:{},destroyed:false,writableEnded:false,headersSent:false,setHeader(name: string|number,value: unknown){this.headers[name]=value;},writeHead(status: number,headers: Record<string,unknown>){this.status=status;this.headersSent=true;Object.assign(this.headers,headers);},end(body: string){this.body=body;this.writableEnded=true;},destroy(){this.destroyed=true;}};
 assert.equal(await createLocalDraftHttp({drafts})(req as unknown as Parameters<ReturnType<typeof createLocalDraftHttp>>[0],res as unknown as Parameters<ReturnType<typeof createLocalDraftHttp>>[1],new URL('http://127.0.0.1/api/local-drafts/clip')),true);
 return {...res,json:JSON.parse(res.body!)};
}
test('complete ordinary6611/adversarial9373 fixtures qualify aggregate rows, requests and success wrappers',t=>{
 const f=fixture(t),legacy=maximumSlot(f),combined={...legacy,draft:{...legacy.draft,raw:{...legacy.draft.raw,volumeEnvelope:maximumEnvelope()}}};
 assert.equal(bytes(legacy),5430);assert.equal(bytes(combined),6611);
 const adversarialLegacy=sizedSlot(legacy,8192),overflow={...adversarialLegacy,draft:{...adversarialLegacy.draft,raw:combined.draft.raw}};
 assert.equal(bytes(overflow),9373);assert.equal(clipDraftSlotSchema.safeParse(overflow).success,true,'field validity does not establish aggregate admission');
 writeDisk(f,[{...legacy,revision:Number.MAX_SAFE_INTEGER-1}]);
 const current=f.drafts.get(f.key),input={...f.input(current),baseRevision:legacy.draft.baseRevision,source:legacy.draft.source,raw:combined.draft.raw};
 const saved=f.drafts.put(input),published=readDisk(f);
 assert.equal(bytes(published.entries[0]),6611);assert.equal(published.version,2);assert.deepEqual(saved.draft!.raw,combined.draft.raw);
 assert.equal(clipDraftEnvelopeSchema.safeParse(saved).success,true);
 const success={ok:true,data:saved};assert.ok(bytes(input)<=12288);assert.ok(bytes(success)<=12288);
 const maxRow=sizedSlot(combined,8192),maxSuccess={ok:true,data:{...saved,draft:maxRow.draft}};
 assert.equal(clipDraftEnvelopeSchema.safeParse(maxSuccess.data).success,true);assert.ok(bytes(maxSuccess)<12288);
 t.diagnostic(JSON.stringify({legacySlotBytes:bytes(legacy),ordinaryEnvelopeSlotBytes:bytes(combined),adversarialEnvelopeSlotBytes:bytes(overflow),completePutBytes:bytes(input),completeSuccessBytes:bytes(success),maximumRowSuccessBytes:bytes(maxSuccess)}));
 const before=clipDraftSnapshot(f.store);
 assert.throws(()=>writeDisk(f,[overflow]));assert.deepEqual(f.drafts.get(f.key),saved);assert.equal(clipDraftSnapshot(f.store),before);
});
for(const size of [8191,8192,8193])test(`serialized complete row ${size}: inclusive SQL admission and evidence preservation`,t=>{
 const f=fixture(t),slot=maximumSlot(f);slot.draft.raw.volumeEnvelope=maximumEnvelope();const sized=sizedSlot(slot,size),before=clipDraftSnapshot(f.store);
 if(size<=8192){writeDisk(f,[sized]);const got=f.drafts.get(f.key);assert.deepEqual(got.draft,sized.draft);assert.equal(f.drafts.list({projectId:f.key.projectId}).items.length,1);assert.equal(clipDraftEntries(f.store).length,1);}
 else{assert.throws(()=>writeDisk(f,[sized]));assert.equal(f.drafts.get(f.key).revision,0);assert.deepEqual(f.drafts.list({projectId:f.key.projectId}).items,[]);assert.equal(clipDraftSnapshot(f.store),before);}
});
test('actual HTTP handler accepts12287/12288 and refuses12289 bytes before mutation for declared and streamed requests',async t=>{
 const f=fixture(t),input=f.input(undefined,{volumeEnvelope:maximumEnvelope()}),payload=JSON.stringify(input);
 const saved=f.drafts.put(input),before=clipDraftSnapshot(f.store);
 for(const declared of [true,false])for(const size of [12287,12288,12289]){
  const body=payload+' '.repeat(size-Buffer.byteLength(payload));assert.equal(Buffer.byteLength(body),size);
  const response=await handlerRequest(f.drafts,body,declared?size:undefined);
  assert.equal(response.status,size<=12288?200:413);
  if(size<=12288)assert.deepEqual(response.json,{ok:true,data:saved});else assert.equal(response.json.error.code,'LOCAL_DRAFT_LIMIT');
  assert.equal(clipDraftSnapshot(f.store),before,'exact replay or size refusal cannot rewrite SQL state');
 }
});
test('complete 128 maximum rows and mixed tombstones fit disk accounting; no 129th slot eviction',t=>{
 const f=fixture(t),slot=maximumSlot(f);slot.draft.raw.volumeEnvelope=maximumEnvelope();const full=sizedSlot(slot,8192);
 const entries=Array.from({length:128},(_,i)=>({...structuredClone(full),clipId:i===0?f.key.clipId:`${String(i).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`}));
 const disk=writeDisk(f,entries),serialized=JSON.stringify(disk)+'\n',accounted=bytes({version:2,workspaceScope:disk.workspaceScope,entries:[]})+128*8192+127+1;
 assert.equal(Buffer.byteLength(serialized),accounted);assert.ok(accounted<2097152);assert.equal(clipDraftDiskSchema.safeParse(disk).success,true);
 assert.equal(f.drafts.list({projectId:f.key.projectId}).items.length,128);assert.equal(JSON.stringify(readDisk(f))+'\n',serialized);
 const tombstone={...f.key,clipId:entries[127].clipId,revision:Number.MAX_SAFE_INTEGER,draft:null};disk.entries[127]=tombstone;
 const mixed=JSON.stringify(disk)+'\n';seedClipDraftEntries(f.store,disk.workspaceScope,disk.entries);assert.equal(f.drafts.list({projectId:f.key.projectId}).items.length,127);
 assert.equal(Buffer.byteLength(mixed),accounted-8192+bytes(tombstone));assert.equal(JSON.stringify(readDisk(f))+'\n',mixed);
 // A new target still matching the owned graph cannot evict a tombstone.
 const newClip={...f.clip,id:randomUUID()};f.timeline.clips.push(newClip);const key={...f.key,clipId:newClip.id},current=f.drafts.get(key);
 const input={...f.input(current),...key,baseRevision:f.timeline.revision,source:full.draft.source,raw:f.raw};
 assert.throws(()=>f.drafts.put(input),error('LOCAL_DRAFT_CAPACITY'));assert.equal(JSON.stringify(readDisk(f))+'\n',mixed);
 t.diagnostic(JSON.stringify({max128RowsDiskBytes:accounted,mixed127RowsOneTombstoneBytes:Buffer.byteLength(mixed),tombstoneBytes:bytes(tombstone),metadataCommasNewlineBytes:accounted-128*8192}));
});
for(const size of [2097151,2097152,2097153])test(`retired companion file ${size} bytes is ignored and its exact whitespace remains untouched`,t=>{
 const f=fixture(t),initial=f.drafts.get(f.key),json=JSON.stringify({version:2,workspaceScope:initial.workspaceScope,entries:[]});
 const contents=json+' '.repeat(size-Buffer.byteLength(json)-1)+'\n';assert.equal(Buffer.byteLength(contents),size);writeFileSync(f.file,contents,{mode:0o600});
 assert.equal(f.drafts.get(f.key).draft,null);assert.deepEqual(f.drafts.list({projectId:f.key.projectId}).items,[]);
 assert.equal(f.drafts.put(f.input(initial)).revision,1);assert.equal(clipDraftEntries(f.store).length,1);
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
