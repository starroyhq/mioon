import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,existsSync,readFileSync,writeFileSync,statSync,lstatSync,copyFileSync,symlinkSync,unlinkSync,linkSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openOpacityCandidateStore} from '../packages/business/src/opacity-candidate-store.ts';
import {installWorkspaceRestoreSchemaV43} from '../packages/business/src/workspace-restore-schema-v43.ts';
import {createOpacityCandidateLocalDrafts,captureOpacityCandidateDraftRequest,OPACITY_CANDIDATE_LOCAL_DRAFT_FILENAME,OPACITY_CANDIDATE_DRAFT_REQUEST_LIMITS} from '../packages/business/src/opacity-candidate-local-drafts.ts';
import {clipDraftOpacityCandidateEnvelopeSchema,clipDraftOpacityCandidateWriteSchema} from '../packages/contracts/src/local-drafts-opacity-candidate.ts';
import {clipDraftEnvelopeSchema,LOCAL_DRAFT_LIMITS} from '../packages/contracts/src/local-drafts.ts';

const stamp='2026-10-16T00:00:00.000Z';
const opacity=()=>({profileId:'mioon-clip-linear-opacity-v1',points:[{frame:'0',opacity:'0.'},{frame:'3e',opacity:'-.'}]});
const volume=()=>({profileId:'mioon-clip-linear-attenuation-v1',points:[{frame:'0',multiplier:'1'}]});
const code=value=>error=>error?.code===value;
function fixture(t){
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-opacity-draft-v3-'));
 let store=openOpacityCandidateStore(root),drafts,fault=()=>{};
 const project={id:randomUUID(),name:'Synthetic draft',revision:1,createdAt:stamp,updatedAt:stamp};
 const asset={id:randomUUID(),projectId:project.id,name:'Synthetic metadata only',mimeType:'video/mp4',duration:1,width:720,height:1280,hasVideo:true,hasAudio:true,sha256:'a'.repeat(64),relativePath:'media/never-read.mp4',createdAt:stamp};
 const clip={id:randomUUID(),trackId:randomUUID(),assetId:asset.id,name:'Clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1};
 const timeline={id:randomUUID(),projectId:project.id,revision:1,fps:30,width:720,height:1280,tracks:[{id:clip.trackId,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],clips:[clip],durationFrames:30,createdAt:stamp,updatedAt:stamp};
 store.put('projects',project);store.put('assets',asset);store.put('timelines',timeline);
 const key={projectId:project.id,timelineId:timeline.id,clipId:clip.id},source={assetId:asset.id,assetSha256:asset.sha256};
 const raw={name:'Raw unsent input',trackId:clip.trackId,startFrame:'',durationFrames:'3e',sourceInFrame:'0',rect:{x:'0',y:'0',width:'720',height:'1280'},gain:'1',volumeEnvelope:volume(),opacityEnvelope:opacity()};
 const start=()=>drafts=createOpacityCandidateLocalDrafts(store,{fault:point=>fault(point)});start();
 const f={root,file:path.join(root,OPACITY_CANDIDATE_LOCAL_DRAFT_FILENAME),project,asset,clip,timeline,key,source,raw,get store(){return store;},get drafts(){return drafts;},
  input(response=drafts.get(key),patch={}){return {...key,workspaceScope:response.workspaceScope,instanceId:response.instanceId,expectedRevision:response.revision,baseRevision:timeline.revision,source,raw,...patch};},
  deletion(response){return {...key,workspaceScope:response.workspaceScope,instanceId:response.instanceId,expectedRevision:response.revision};},
  setFault(value){fault=value;},start,
  reopen(){store.close();store=openOpacityCandidateStore(root);start();},
  restore(){store.close();const db=new DatabaseSync(path.join(root,'workbench.sqlite'));try{db.exec('PRAGMA foreign_keys=ON;');installWorkspaceRestoreSchemaV43(db,{restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:stamp});}finally{db.close();}store=openOpacityCandidateStore(root);start();},
  snapshot(){return JSON.stringify(['projects','assets','timelines','timeline_requests','timeline_history','edit_tasks'].map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));},
 };
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return f;
}

test('actual42 v3 get/put/reopen/discard preserve unfinished opacity and volume without business writes',t=>{
 const f=fixture(t),before=f.snapshot(),changes=f.store.db.prepare('SELECT total_changes() AS n').get().n;
 const empty=f.drafts.get(f.key);assert.equal(empty.draft,null);assert.equal(existsSync(f.file),false);
 assert.deepEqual(f.drafts.list({projectId:f.project.id}).items,[]);
 const input=f.input(empty),saved=f.drafts.put(input);assert.equal(saved.revision,1);assert.deepEqual(saved.draft.raw,f.raw);
 assert.equal(clipDraftOpacityCandidateEnvelopeSchema.safeParse(saved).success,true);assert.equal(clipDraftEnvelopeSchema.safeParse(saved).success,false);
 assert.equal(JSON.parse(readFileSync(f.file,'utf8')).version,3);assert.equal(statSync(f.file).mode&0o777,0o600);
 assert.equal(f.snapshot(),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,changes);
 assert.deepEqual(f.drafts.put(input),saved);
 f.reopen();const reopened=f.drafts.get(f.key);assert.notEqual(reopened.instanceId,saved.instanceId);assert.equal(reopened.workspaceScope,saved.workspaceScope);assert.deepEqual(reopened.draft,saved.draft);
 assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_STALE_INSTANCE'));
 const deleted=f.drafts.discard(f.deletion(reopened));assert.equal(deleted.revision,2);assert.equal(deleted.draft,null);assert.deepEqual(f.drafts.discard(f.deletion(reopened)),deleted);
 f.reopen();assert.equal(f.drafts.get(f.key).draft,null);assert.equal(f.drafts.get(f.key).revision,2);
});

test('v3 CAS and tombstone revisions prevent two-window overwrite and ABA',t=>{
 const f=fixture(t),firstInput=f.input(),first=f.drafts.put(firstInput),second=f.drafts.put(f.input(first,{raw:{...f.raw,name:'Newer'}}));
 assert.throws(()=>f.drafts.put(firstInput),code('LOCAL_DRAFT_CONFLICT'));assert.throws(()=>f.drafts.discard(f.deletion(first)),code('LOCAL_DRAFT_CONFLICT'));
 const deleted=f.drafts.discard(f.deletion(second)),recreated=f.drafts.put(f.input(deleted));assert.equal(recreated.revision,4);
 assert.throws(()=>f.drafts.discard(f.deletion(second)),code('LOCAL_DRAFT_CONFLICT'));
});

test('independent v3 companion never reads or overwrites v1/v2 and refuses v1/v2 masquerading as v3',t=>{
 const f=fixture(t),legacy=path.join(f.root,'local-drafts-v1.json'),bytes=Buffer.from('{"version":2,"unread":"preserve these exact bytes"}\n');writeFileSync(legacy,bytes,{mode:0o600});
 const input=f.input(),saved=f.drafts.put(input);assert.deepEqual(readFileSync(legacy),bytes);assert.equal(saved.draft.raw.opacityEnvelope.profileId,'mioon-clip-linear-opacity-v1');
 const valid=readFileSync(f.file,'utf8');
 for(const version of [1,2,4,'3']){writeFileSync(f.file,JSON.stringify({...JSON.parse(valid),version}),{mode:0o600});const before=readFileSync(f.file);assert.throws(()=>f.drafts.get(f.key),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.deepEqual(readFileSync(f.file),before);}
 assert.deepEqual(readFileSync(legacy),bytes);
});

function maximumRequest(f){
 const versionId=randomUUID(),shotId=randomUUID(),jobId=randomUUID(),hash=f.asset.sha256,profileId='jfif-ycbcr8-srgb-v1';
 f.store.put('shots',{id:shotId,projectId:f.project.id,referenceAssetIds:[],selectedVersionId:versionId});
 f.store.put('jobs',{id:jobId,projectId:f.project.id,shotId,versionId,assetId:f.asset.id});
 f.store.put('versions',{id:versionId,projectId:f.project.id,jobId,shotId,assetId:f.asset.id,sha256:hash});
 Object.assign(f.clip,{versionId,shotId,jobId});f.timeline.revision=Number.MAX_SAFE_INTEGER;f.store.put('timelines',f.timeline);
 const raw={name:'\u0001'.repeat(200),trackId:f.clip.trackId,startFrame:'\u0001'.repeat(48),durationFrames:'\u0001'.repeat(48),sourceInFrame:'\u0001'.repeat(48),rect:{x:'\u0001'.repeat(48),y:'\u0001'.repeat(48),width:'\u0001'.repeat(48),height:'\u0001'.repeat(48)},gain:'\u0001'.repeat(48),fadeInFrames:'\u0001'.repeat(48),fadeOutFrames:'\u0001'.repeat(48),audioRole:'human',
 volumeEnvelope:{profileId:'mioon-clip-linear-attenuation-v1',points:Array.from({length:16},()=>({frame:'9'.repeat(8),multiplier:'9'.repeat(32)}))},
 opacityEnvelope:{profileId:'mioon-clip-linear-opacity-v1',points:Array.from({length:7},()=>({frame:'9'.repeat(8),opacity:'9'.repeat(32)}))},
 colour:{profileId:'mioon-jfif-image-clip-v1',source:{assetSha256:hash,profileId,interpretation:'srgb',declaredBy:'user',declaredAt:'2026-10-16T00:00:00.'+'0'.repeat(19)+'Z',evidence:{profileId,sha256:hash,sourceByteLength:33554432,width:1920,height:1080,bitDepth:8,alphaMode:'opaque',orientation:1,colourTag:'untagged',sampling:'420',decoderPolicy:'ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1'}},look:{resourceId:randomUUID(),resourceSha256:hash,resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:false,strength:1.2345678901234567e-100}}};
 const initial=f.drafts.get(f.key);writeFileSync(f.file,JSON.stringify({version:3,workspaceScope:initial.workspaceScope,entries:[{...f.key,revision:Number.MAX_SAFE_INTEGER-1,draft:null}]})+'\n',{mode:0o600});
 return f.input(undefined,{raw,source:{...f.source,versionId,shotId,jobId}});
}
const count=value=>1+(value&&typeof value==='object'?Object.values(value).reduce((n,child)=>n+count(child),0):0);

test('complete132-node v3 request retains all legal fields and provenance;133 refuses atomically',t=>{
 const f=fixture(t),input=maximumRequest(f),capture=captureOpacityCandidateDraftRequest(input);
 assert.equal(clipDraftOpacityCandidateWriteSchema.safeParse(input).success,true);
 assert.deepEqual(OPACITY_CANDIDATE_DRAFT_REQUEST_LIMITS,{nodes:132,depth:8});
 assert.equal(count(input),132);assert.equal(capture.nodes,132);assert.equal(capture.depth,5);assert.equal(capture.bytes,Buffer.byteLength(JSON.stringify(input)));
 const before=f.snapshot(),saved=f.drafts.put(input);assert.deepEqual(saved.draft.raw,input.raw);assert.deepEqual(saved.draft.source,input.source);
 assert.equal(saved.draft.source.versionId,input.source.versionId);assert.equal(saved.draft.source.shotId,input.source.shotId);assert.equal(saved.draft.source.jobId,input.source.jobId);
 const file=readFileSync(f.file),extra={...input,unknown:true};assert.equal(count(extra),133);
 assert.throws(()=>captureOpacityCandidateDraftRequest(extra),code('LOCAL_DRAFT_VALIDATION'));assert.throws(()=>f.drafts.put(extra),code('LOCAL_DRAFT_VALIDATION'));
 assert.deepEqual(readFileSync(f.file),file);assert.equal(f.snapshot(),before);
 t.diagnostic(JSON.stringify({requestNodes:capture.nodes,requestBytes:capture.bytes,requestDepth:capture.depth,rowBytes:Buffer.byteLength(JSON.stringify({...f.key,revision:saved.revision,draft:saved.draft})),httpBytes:Buffer.byteLength(JSON.stringify({ok:true,data:saved})),diskBytes:file.byteLength}));
});

test('only two typed raw point arrays are admitted and hostile descriptors never execute',t=>{
 const f=fixture(t),input=f.input();let calls=0;const trap=()=>{calls++;throw Error('Untrusted code ran');};
 const getter={...input};Object.defineProperty(getter,'raw',{enumerable:true,get:trap});
 const points=[{frame:'0',opacity:'1'}];Object.defineProperty(points,'0',{enumerable:true,get:trap});
 const values=[getter,new Proxy(input,{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap}),{...input,source:[]},{...input,raw:{...f.raw,name:[]}},{...input,raw:{...f.raw,opacityEnvelope:{...opacity(),points}}}];
 for(const value of values)assert.throws(()=>f.drafts.put(value),code('LOCAL_DRAFT_VALIDATION'));
 assert.equal(calls,0);assert.equal(existsSync(f.file),false);
});

test('faults preserve before-publication bytes and retain published unknown outcomes for exact retry',t=>{
 for(const point of ['beforePersist','afterPersist','beforeDirectorySync','afterDirectorySync']){
  const f=fixture(t),saved=f.drafts.put(f.input()),before=readFileSync(f.file),input=f.input(saved,{raw:{...f.raw,name:`Fault ${point}`}});
  f.setFault(at=>{if(at===point)throw Error('Synthetic publication failure');});
  assert.throws(()=>f.drafts.put(input),code(point==='beforePersist'?'LOCAL_DRAFT_STORAGE_UNAVAILABLE':'LOCAL_DRAFT_SAVE_UNCERTAIN'));
  if(point==='beforePersist')assert.deepEqual(readFileSync(f.file),before);
  else assert.equal(JSON.parse(readFileSync(f.file,'utf8')).entries[0].draft.raw.name,input.raw.name);
  f.setFault(()=>{});const accepted=f.drafts.put(input);assert.equal(accepted.revision,2);assert.deepEqual(accepted.draft.raw,input.raw);
  const exact=readFileSync(f.file);assert.deepEqual(f.drafts.put(input),accepted);assert.deepEqual(readFileSync(f.file),exact);
 }
});

test('retained raw draft keeps base/source after edits and remains recoverable after target deletion',t=>{
 const f=fixture(t),saved=f.drafts.put(f.input());f.store.put('timelines',{...f.timeline,revision:2});
 const changed=f.drafts.get(f.key);assert.equal(changed.targetStatus,'changed');assert.equal(changed.draft.baseRevision,1);
 assert.throws(()=>f.drafts.put(f.input(changed,{baseRevision:2})),code('LOCAL_DRAFT_CONFLICT'));
 f.store.put('timelines',{...f.timeline,revision:3,clips:[],durationFrames:0});const missing=f.drafts.get(f.key);
 assert.equal(missing.targetStatus,'missing');assert.deepEqual(missing.draft,saved.draft);assert.equal(f.drafts.list({projectId:f.project.id}).items[0].targetStatus,'missing');
 assert.equal(f.drafts.discard(f.deletion(missing)).draft,null);
});

test('unknown/corrupt/duplicate/oversized rows never mean empty or permit overwrite',t=>{
 const f=fixture(t),input=f.input(),saved=f.drafts.put(input),valid=JSON.parse(readFileSync(f.file,'utf8'));
 const row=valid.entries[0],sized=size=>{const copy=structuredClone(row),delta=size-Buffer.byteLength(JSON.stringify(copy));assert.ok(delta>0);copy.draft.updatedAt='2026-10-16T00:00:00.'+'0'.repeat(3+delta)+'Z';assert.equal(Buffer.byteLength(JSON.stringify(copy)),size);return copy;};
 writeFileSync(f.file,JSON.stringify({...valid,entries:[sized(8192)]})+'\n',{mode:0o600});assert.equal(f.drafts.get(f.key).draft.raw.name,f.raw.name);
 const malformed=['{',Buffer.from([0xff]),JSON.stringify({...valid,entries:[sized(8193)]}),JSON.stringify({...valid,entries:[row,row]}),JSON.stringify(valid).replace('"version":3','"version":2,"version":3'),JSON.stringify({...valid,unexpected:true})];
 for(const contents of malformed){writeFileSync(f.file,contents,{mode:0o600});const before=readFileSync(f.file);assert.throws(()=>f.drafts.get(f.key),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.deepEqual(readFileSync(f.file),before);}
 assert.equal(saved.revision,1);assert.deepEqual({row:LOCAL_DRAFT_LIMITS.rowBytes,http:LOCAL_DRAFT_LIMITS.httpBytes,disk:LOCAL_DRAFT_LIMITS.envelopeBytes},{row:8192,http:12288,disk:2097152});
});

test('slot capacity is bounded and symlink storage never reaches its target',t=>{
 const f=fixture(t),input=f.input(),rows=Array.from({length:128},()=>({projectId:f.project.id,timelineId:randomUUID(),clipId:randomUUID(),revision:1,draft:null}));
 writeFileSync(f.file,JSON.stringify({version:3,workspaceScope:input.workspaceScope,entries:rows})+'\n',{mode:0o600});const full=readFileSync(f.file);
 assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_CAPACITY'));assert.deepEqual(readFileSync(f.file),full);
 unlinkSync(f.file);const target=path.join(f.root,'untouched.txt');writeFileSync(target,'untouched',{mode:0o600});symlinkSync(target,f.file);
 assert.throws(()=>f.drafts.get(f.key),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.throws(()=>f.drafts.put(input),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.equal(readFileSync(target,'utf8'),'untouched');
});

test('closed/copied/foreign-scope and aborted owners cannot use v3 persistence',t=>{
 const f=fixture(t),saved=f.drafts.put(f.input()),old=f.drafts;
 assert.throws(()=>createOpacityCandidateLocalDrafts({...f.store}),code('LOCAL_DRAFT_OWNER_REQUIRED'));
 const g=fixture(t);copyFileSync(f.file,g.file);assert.throws(()=>g.drafts.get(g.key),code('LOCAL_DRAFT_SCOPE_MISMATCH'));
 const abort=new AbortController(),stopped=createOpacityCandidateLocalDrafts(f.store,{signal:abort.signal}),before=readFileSync(f.file);abort.abort();
 assert.throws(()=>stopped.get(f.key),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.deepEqual(readFileSync(f.file),before);
 f.reopen();assert.throws(()=>old.put(f.input(saved)),code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));assert.deepEqual(readFileSync(f.file),before);
});

test('43 remains unsupported and never reads or writes either companion',t=>{
 const f=fixture(t),saved=f.drafts.put(f.input()),before=readFileSync(f.file);f.restore();
 const unsupported={supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'};
 for(const call of [()=>f.drafts.get(f.key),()=>f.drafts.list({projectId:f.project.id}),()=>f.drafts.put({invalid:'ignored while unsupported'}),()=>f.drafts.discard(f.deletion(saved))])assert.deepEqual(call(),unsupported);
 assert.deepEqual(readFileSync(f.file),before);assert.equal(existsSync(path.join(f.root,'local-drafts-v1.json')),false);
});


test('historical source hash and project ownership remain required before draft disclosure or deletion',t=>{
 for(const kind of ['hash','owner']){
  const f=fixture(t),saved=f.drafts.put(f.input()),before=readFileSync(f.file);f.store.put('timelines',{...f.timeline,clips:[],durationFrames:0});
  if(kind==='hash')f.store.put('assets',{...f.asset,sha256:'b'.repeat(64)});
  else{const foreign={...f.project,id:randomUUID()};f.store.put('projects',foreign);f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(foreign.id,JSON.stringify({...f.asset,projectId:foreign.id}),f.asset.id);}
  for(const call of [()=>f.drafts.get(f.key),()=>f.drafts.list({projectId:f.project.id}),()=>f.drafts.put(f.input(saved)),()=>f.drafts.discard(f.deletion(saved))])assert.throws(call,code('LOCAL_DRAFT_STORAGE_UNAVAILABLE'));
  assert.deepEqual(readFileSync(f.file),before);
 }
});


test('candidate reopen preflights the v3 companion before lock or SQLite writes',t=>{
 for(const kind of ['symlink','permissions','hardlink','size']){
  const f=fixture(t);f.drafts.put(f.input());f.store.close();
  const valid=readFileSync(f.file),target=path.join(f.root,'preserved-v3-target.json');
  if(kind==='symlink'){unlinkSync(f.file);writeFileSync(target,valid,{mode:0o600});symlinkSync(target,f.file);}
  else if(kind==='permissions')chmodSync(f.file,0o644);
  else if(kind==='hardlink')linkSync(f.file,target);
  else writeFileSync(f.file,Buffer.alloc(LOCAL_DRAFT_LIMITS.envelopeBytes+1,0x20),{mode:0o600});
  const database=path.join(f.root,'workbench.sqlite'),beforeDb=readFileSync(database),beforeFile=readFileSync(f.file),beforeStat=lstatSync(f.file);
  assert.equal(existsSync(path.join(f.root,'server.lock')),false);
  assert.throws(()=>openOpacityCandidateStore(f.root),error=>error?.code==='STORAGE_PRIVATE_REQUIRED'&&error.reason===({symlink:'SYMBOLIC_LINK',permissions:'FILE_PERMISSIONS',hardlink:'HARD_LINK',size:'SIZE_LIMIT'}[kind]));
  assert.deepEqual(readFileSync(database),beforeDb,'unsafe companion rejects before opening or modifying SQLite');
  assert.deepEqual(readFileSync(f.file),beforeFile);assert.equal(lstatSync(f.file).ino,beforeStat.ino);assert.equal(lstatSync(f.file).mode,beforeStat.mode);
  assert.equal(existsSync(path.join(f.root,'server.lock')),false);assert.equal(existsSync(database+'-wal'),false);assert.equal(existsSync(database+'-shm'),false);
  if(kind==='symlink')assert.deepEqual(readFileSync(target),valid);
 }
});
