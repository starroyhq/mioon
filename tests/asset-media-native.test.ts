import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync,readFileSync,readdirSync,renameSync,utimesSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAssetMediaServices} from '../packages/business/src/asset-media-services.ts';
import {createNativeAssetMediaServices} from '../packages/business/src/asset-media-native.ts';
import {AppError} from '../packages/contracts/src/app-error.ts';
import {NATIVE_ASSET_MEDIA_LIMITS,nativeAssetMediaRequestSchema,nativeRelinkCandidateInputSchema,nativeRelinkPreviewSchema,nativeRelinkApplyResultSchema} from '../packages/contracts/src/asset-media-native.ts';
import {createNativeRelinkRetention} from '../packages/business/src/native-relink-retention.ts';
import type {AssetMediaDto} from '../packages/contracts/src/asset-media.ts';
import {assetMediaDtoSchema} from '../packages/contracts/src/asset-media.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

async function fixture(t:TestContext,{seedEvidence,now}:{seedEvidence?:(directory:string)=>void;now?:()=>number}={}){
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-native-relink-')),projectDir=path.join(root,'project'),external=path.join(root,'external');
 mkdirSync(projectDir);mkdirSync(external);
 const store=openStore(projectDir),app=openAppLibrary({dataDir:path.join(root,'application')});store.put('projects',{id:store.projectId,name:'Relink'});
 const services=createServices(store,new Map(),{application:createProjectServiceApplication(app)});
 const evidenceDirectory=path.join(store.tempDir,'asset-media','native-relink');
 if(seedEvidence){mkdirSync(evidenceDirectory,{recursive:true,mode:0o700});seedEvidence(evidenceDirectory);}
 const native=createNativeAssetMediaServices(store,{outsidePaths:app.outsidePaths,...(now?{now}:{})});
 t.after(async()=>{await services.drain();store.close();app.close();rmSync(root,{recursive:true,force:true});});
 const ownerToken=randomUUID(),projectId=store.projectId;
 const imported=async(name='original.png',bytes=png()):Promise<{asset:AssetMediaDto;file:string}>=>{
  const file=path.join(projectDir,name);writeFileSync(file,bytes);const asset=assetMediaDtoSchema.parse(await services.call('asset.import',{projectId,requestId:randomUUID(),sourcePath:file}));return{asset,file};
 };
 const pick=async(asset:AssetMediaDto,file:string)=>native.candidate({projectId,ownerToken,assetId:asset.id,expectedReferenceRevision:asset.referenceRevision,sourcePath:file});
 const sequence=()=>store.db.prepare('SELECT contentSequence FROM project_file').get()!.contentSequence;
 return{root,store,app,services,native,ownerToken,projectId,projectDir,external,imported,pick,sequence};
}

test('native renderer contracts reject paths, owner tokens, consent and malformed project/revision bindings',()=>{
 const projectId=randomUUID(),assetId=randomUUID(),ownerToken=randomUUID(),input={action:'choose',projectId,assetId,expectedReferenceRevision:1};
 assert.equal(nativeAssetMediaRequestSchema.safeParse(input).success,true);
 for(const extra of [{sourcePath:'/private/file.png'},{allowOutside:true},{ownerToken},{expectedReferenceRevision:0}])assert.equal(nativeAssetMediaRequestSchema.safeParse({...input,...extra}).success,false);
 assert.equal(nativeRelinkCandidateInputSchema.safeParse({projectId,assetId,ownerToken,expectedReferenceRevision:1,sourcePath:'../file.png'}).success,false);
});

test('candidate and consented preview leave assets, registry and durable grants unchanged; discard retires the document',async t=>{
 const f=await fixture(t),{asset,file}=await f.imported(),moved=path.join(f.external,'relocated.png');renameSync(file,moved);
 const before=f.store.get('assets',asset.id),sequence=f.sequence(),registry=f.app.registry.list(),appChanges=f.app.db.prepare('SELECT total_changes() AS n').get()!.n;
 const candidate=await f.pick(asset,moved);assert.equal(candidate.displayPath,moved);assert.equal(candidate.outside,true);assert.equal(candidate.confirmationRequired,true);
 await assert.rejects(f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:false}),{code:'MEDIA_OUTSIDE_NOT_CONFIRMED'});
 const preview=await f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:true});nativeRelinkPreviewSchema.parse(preview);
 assert.equal(nativeRelinkPreviewSchema.safeParse({...preview,rows:[...preview.rows,...preview.rows]}).success,false);
 assert.equal(nativeRelinkPreviewSchema.safeParse({...preview,expectedReferenceRevision:2}).success,false);
 assert.equal(nativeRelinkPreviewSchema.safeParse({...preview,rows:preview.rows.map(row=>({...row,to:'/unverified/path.png'}))}).success,false);
 assert.equal(preview.rows[0]!.outcome,'picked');assert.equal(preview.rows[0]!.to,moved);assert.equal(preview.rows[0]!.from,file);
 assert.deepEqual(f.store.get('assets',asset.id),before);assert.equal(f.sequence(),sequence);assert.deepEqual(f.app.registry.list(),registry);assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);
 assert.equal(f.app.db.prepare('SELECT total_changes() AS n').get()!.n,appChanges);
 await f.native.discard({projectId:f.projectId,ownerToken:f.ownerToken});
 assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);
 assert.equal(readdirSync(path.join(f.store.tempDir,'asset-media','native-relink')).some(name=>name===`${preview.previewToken}.json`),false);
 await assert.rejects(f.pick(asset,moved),{code:'ASSET_MEDIA_NATIVE_UNAVAILABLE'});
});

test('a discarded owner prevents an in-flight metadata candidate from issuing a late ticket',async t=>{
 const f=await fixture(t),{asset,file}=await f.imported();
 const pending=f.pick(asset,file),rejected=assert.rejects(pending,{code:'ASSET_MEDIA_NATIVE_UNAVAILABLE'});
 await f.native.discard({projectId:f.projectId,ownerToken:f.ownerToken});await rejected;
 assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);
});

test('native candidates and previews cannot cross owner, project or reference revision',async t=>{
 const f=await fixture(t),{asset,file}=await f.imported(),candidate=await f.pick(asset,file);
 await assert.rejects(f.native.preview({projectId:f.projectId,ownerToken:randomUUID(),candidateToken:candidate.candidateToken,allowOutside:false}),{code:'ASSET_MEDIA_NATIVE_UNAVAILABLE'});
 await assert.rejects(f.native.preview({projectId:randomUUID(),ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:false}),{code:'ASSET_MEDIA_NATIVE_UNAVAILABLE'});
 const old=f.store.get('assets',asset.id) as Record<string,unknown>;f.store.put('assets',{...old,referenceRevision:2});
 await assert.rejects(f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:false}),{code:'REVISION_CONFLICT'});
 assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);
});

test('only trusted final apply can consume a native preview, and ACK replay cannot revive a revoked grant',async t=>{
 const f=await fixture(t),{asset,file}=await f.imported(),moved=path.join(f.external,'relocated.png');renameSync(file,moved);
 const candidate=await f.pick(asset,moved),preview=await f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:true});
 const requestId=randomUUID(),input={projectId:f.projectId,ownerToken:f.ownerToken,previewToken:preview.previewToken,requestId};
 await assert.rejects(createAssetMediaServices(f.store,{outsidePaths:f.app.outsidePaths}).call('asset.media.relink.apply',{projectId:f.projectId,previewToken:preview.previewToken,requestId}),{code:'REVISION_CONFLICT'});
 const result=await f.native.apply(input);nativeRelinkApplyResultSchema.parse(result);assert.equal(result.status,'applied');
 if(result.status!=='applied')throw new Error(JSON.stringify(result));
 assert.deepEqual(result.confirmedDirectories,[f.external]);assert.equal(result.assets[0]!.id,asset.id);assert.equal(result.assets[0]!.referenceRevision,2);
 assert.equal(f.store.list('assets',f.projectId).length,1);
 f.app.outsidePaths.revoke(f.projectId,f.external);
 assert.deepEqual(await f.native.apply(input),result);assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);
});

test('a file swap after preview is refused before persistent permission or project changes',async t=>{
 const f=await fixture(t),{asset,file}=await f.imported(),moved=path.join(f.external,'relocated.png');renameSync(file,moved);
 const candidate=await f.pick(asset,moved),preview=await f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:true}),sequence=f.sequence();
 const replacement=path.join(f.external,'replacement.png');writeFileSync(replacement,png());renameSync(replacement,moved);
 const result=await f.native.apply({projectId:f.projectId,ownerToken:f.ownerToken,previewToken:preview.previewToken,requestId:randomUUID()});
 assert.equal(result.status,'failed');if(result.status==='failed')assert.equal(result.error.code,'REVISION_CONFLICT');
 assert.deepEqual(result.confirmedDirectories,[]);assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);assert.equal(f.sequence(),sequence);
});

test('a recorded full hash still rejects same-size same-mtime unsampled candidate changes',async t=>{
 const f=await fixture(t),bytes=Buffer.concat([png(),Buffer.alloc(3*1024*1024)]),{asset,file}=await f.imported('large.png',bytes),before=statSync(file),moved=path.join(f.external,'different.png');
 const changed=Buffer.from(bytes);changed[1500000]=1;writeFileSync(moved,changed);utimesSync(moved,before.atime,before.mtime);rmSync(file);
 assert.ok(asset.sha256);
 const candidate=await f.pick(asset,moved),preview=await f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:true});
 assert.equal(preview.rows[0]!.outcome,'changed');assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);
 const result=await f.native.apply({projectId:f.projectId,ownerToken:f.ownerToken,previewToken:preview.previewToken,requestId:randomUUID()});
 assert.equal(result.status,'failed');if(result.status==='failed')assert.equal(result.error.code,'MEDIA_CHANGED');assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);
});

test('aborting preview interrupts its hash before assets, grants or preview publication',async t=>{
 const f=await fixture(t),{asset,file}=await f.imported(),moved=path.join(f.external,'relocated.png');renameSync(file,moved);const candidate=await f.pick(asset,moved),sequence=f.sequence(),abort=new AbortController();let checks=0;
 await assert.rejects(f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:true},{signal:abort.signal,beforeEffect:()=>{if(++checks===8)abort.abort();}}));
 assert.ok(abort.signal.aborted);assert.equal(f.sequence(),sequence);assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);
 assert.deepEqual(readdirSync(path.join(f.store.tempDir,'asset-media','native-relink')),[]);
});

test('apply failure after explicit final consent reports its grant; retry never regrants after revocation',async t=>{
 const f=await fixture(t),{asset,file}=await f.imported(),moved=path.join(f.external,'relocated.png');renameSync(file,moved);
 const candidate=await f.pick(asset,moved),preview=await f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:true}),input={projectId:f.projectId,ownerToken:f.ownerToken,previewToken:preview.previewToken,requestId:randomUUID()},sequence=f.sequence();
 let refused=false;
 const result=await f.native.apply(input,{beforeEffect:()=>{if(!refused&&f.app.outsidePaths.list(f.projectId).length){refused=true;throw new AppError('REVISION_CONFLICT','Synthetic refusal',409);}}});
 assert.equal(result.status,'failed');assert.deepEqual(result.confirmedDirectories,[f.external]);assert.equal(f.sequence(),sequence);
 f.app.outsidePaths.revoke(f.projectId,f.external);
 const retried=await f.native.apply(input);assert.equal(retried.status,'failed');assert.deepEqual(retried.confirmedDirectories,[]);assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);assert.equal(f.sequence(),sequence);
 assert.deepEqual(readFileSync(moved),png());
});

test('an existing grant revoked after preview cannot be borrowed as new temporary consent',async t=>{
 const f=await fixture(t),{asset,file}=await f.imported(),moved=path.join(f.external,'relocated.png');renameSync(file,moved);
 f.app.outsidePaths.confirm({projectId:f.projectId,directory:f.external,confirmedAt:new Date().toISOString()});
 const candidate=await f.pick(asset,moved);assert.equal(candidate.confirmationRequired,false);
 const preview=await f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:false});
 f.app.outsidePaths.revoke(f.projectId,f.external);const sequence=f.sequence();
 const result=await f.native.apply({projectId:f.projectId,ownerToken:f.ownerToken,previewToken:preview.previewToken,requestId:randomUUID()});
 assert.equal(result.status,'failed');if(result.status==='failed')assert.equal(result.error.code,'MEDIA_OUTSIDE_NOT_CONFIRMED');
 assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);assert.equal(f.sequence(),sequence);
});

test('auto matches keep relative structure under the exact temporarily consented directory',async t=>{
 const f=await fixture(t),first=await f.imported('chosen.png'),second=await f.imported('sibling.png');
 const moved=path.join(f.external,'chosen.png');renameSync(first.file,moved);renameSync(second.file,path.join(f.external,'sibling.png'));
 const candidate=await f.pick(first.asset,moved),preview=await f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:true});
 assert.deepEqual(preview.rows.map(row=>row.outcome).sort(),['auto','picked']);assert.equal(preview.foundBy?.count,1);
 const result=await f.native.apply({projectId:f.projectId,ownerToken:f.ownerToken,previewToken:preview.previewToken,requestId:randomUUID()});assert.equal(result.status,'applied');
 assert.deepEqual(f.app.outsidePaths.list(f.projectId).map(grant=>grant.directory),[f.external]);
 assert.equal(f.store.list('assets',f.projectId).length,2);
});

test('abort after the S1 commit reports unknown and exact request reconciliation never regrants',async t=>{
 const f=await fixture(t),{asset,file}=await f.imported(),moved=path.join(f.external,'relocated.png');renameSync(file,moved);
 const candidate=await f.pick(asset,moved),preview=await f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:true}),input={projectId:f.projectId,ownerToken:f.ownerToken,previewToken:preview.previewToken,requestId:randomUUID()},abort=new AbortController();
 const result=await f.native.apply(input,{signal:abort.signal,beforeEffect:()=>{if(!f.store.db.isTransaction&&f.store.db.prepare('SELECT 1 FROM idempotency WHERE scope=? AND requestId=?').get('asset.media.relink.apply',input.requestId))abort.abort();}});
 assert.equal(result.status,'failed');if(result.status==='failed')assert.equal(result.error.code,'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN');
 assert.equal((f.store.get('assets',asset.id) as Record<string,unknown>).referenceRevision,2);assert.deepEqual(result.confirmedDirectories,[f.external]);
 f.app.outsidePaths.revoke(f.projectId,f.external);
 const reconciled=await f.native.apply(input);assert.equal(reconciled.status,'applied');assert.deepEqual(reconciled.confirmedDirectories,[]);assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);
 assert.equal((f.store.get('assets',asset.id) as Record<string,unknown>).referenceRevision,2);assert.equal(f.store.list('assets',f.projectId).length,1);
});

test('a completed native receipt proves success despite its final ACK fence being interrupted',async t=>{
 const f=await fixture(t),{asset,file}=await f.imported(),candidate=await f.pick(asset,file),preview=await f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:false}),input={projectId:f.projectId,ownerToken:f.ownerToken,previewToken:preview.previewToken,requestId:randomUUID()},abort=new AbortController();
 const directory=path.join(f.store.tempDir,'asset-media','native-relink');let interrupted=false;
 const result=await f.native.apply(input,{signal:abort.signal,beforeEffect:()=>{
  for(const name of readdirSync(directory))if(name.startsWith('native-relink-request-')){const saved=JSON.parse(readFileSync(path.join(directory,name),'utf8')) as {phase:string};if(saved.phase==='completed'){interrupted=true;abort.abort();}}
 }});
 assert.equal(interrupted,true);assert.equal(result.status,'applied');assert.equal((f.store.get('assets',asset.id) as Record<string,unknown>).referenceRevision,2);
 assert.deepEqual(await f.native.apply(input),result);assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);
});

test('temporary folder consent never extends to an automatically discovered child directory',async t=>{
 const f=await fixture(t);mkdirSync(path.join(f.projectDir,'child'));
 const first=await f.imported('chosen.png'),nested=await f.imported('child/nested.png'),moved=path.join(f.external,'chosen.png');
 renameSync(first.file,moved);renameSync(path.dirname(nested.file),path.join(f.external,'child'));
 const candidate=await f.pick(first.asset,moved),preview=await f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:true});
 assert.equal(preview.rows.find(row=>row.assetId===nested.asset.id)!.outcome,'missing');assert.equal(preview.foundBy,null);
 const result=await f.native.apply({projectId:f.projectId,ownerToken:f.ownerToken,previewToken:preview.previewToken,requestId:randomUUID()});assert.equal(result.status,'applied');
 assert.equal((f.store.get('assets',nested.asset.id) as Record<string,unknown>).referenceRevision,1);
 assert.deepEqual(f.app.outsidePaths.list(f.projectId).map(grant=>grant.directory),[f.external]);
 const next=await f.pick(nested.asset,path.join(f.external,'child/nested.png'));assert.equal(next.confirmationRequired,true);
});

test('cancellation at the private preview publication fence cleans its token without creating a grant',async t=>{
 const f=await fixture(t),{asset,file}=await f.imported(),candidate=await f.pick(asset,file),abort=new AbortController(),directory=path.join(f.store.tempDir,'asset-media','native-relink');let published=false;
 await assert.rejects(f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:false},{signal:abort.signal,beforeEffect:()=>{
  if(existsSync(directory)&&readdirSync(directory).some(name=>/^[a-f0-9-]+\.json$/u.test(name))){published=true;abort.abort();abort.signal.throwIfAborted();}
 }}));
 assert.equal(published,true);assert.deepEqual(readdirSync(directory),[]);assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);assert.equal((f.store.get('assets',asset.id) as Record<string,unknown>).referenceRevision,1);
});

test('native evidence byte and entry admission account replacements, removals and restart without eviction',async t=>{
 const f=await fixture(t),directory=path.join(f.root,'retention-unit'),evidence=createNativeRelinkRetention(directory);
 assert.equal(existsSync(directory),false,'inventory does not create a missing directory');
 const chunk='x'.repeat(8*1024*1024);
 for(let index=0;index<4;index++)evidence.write(`chunk-${index}.json`,chunk);
 assert.deepEqual(evidence.usage(),{entries:4,bytes:NATIVE_ASSET_MEDIA_LIMITS.retainedBytes});
 assert.throws(()=>evidence.write('one-more.json','1'),{code:'ASSET_MEDIA_NATIVE_RETENTION_LIMIT'});
 assert.equal(existsSync(path.join(directory,'one-more.json')),false);
 evidence.write('chunk-0.json',chunk.slice(0,-1));evidence.write('one-more.json','1');
 assert.equal(evidence.usage().bytes,NATIVE_ASSET_MEDIA_LIMITS.retainedBytes);
 assert.throws(()=>evidence.write('one-more.json','11'),{code:'ASSET_MEDIA_NATIVE_RETENTION_LIMIT'});
 const restarted=createNativeRelinkRetention(directory);assert.deepEqual(restarted.usage(),evidence.usage());
 restarted.remove('one-more.json');assert.equal(restarted.usage().bytes,NATIVE_ASSET_MEDIA_LIMITS.retainedBytes-1);
 const countDirectory=path.join(f.root,'count-unit');mkdirSync(countDirectory,{mode:0o700});
 for(let index=0;index<NATIVE_ASSET_MEDIA_LIMITS.retainedEntries;index++)writeFileSync(path.join(countDirectory,`retained-${index}.json`),'{}',{mode:0o600});
 const full=createNativeRelinkRetention(countDirectory);assert.equal(full.usage().entries,NATIVE_ASSET_MEDIA_LIMITS.retainedEntries);
 assert.throws(()=>full.write('extra.json','{}'),{code:'ASSET_MEDIA_NATIVE_RETENTION_LIMIT'});
 assert.equal(readdirSync(countDirectory).length,NATIVE_ASSET_MEDIA_LIMITS.retainedEntries);
});

test('full native evidence refuses a new apply without a grant and cancellation releases an unaccepted preview slot',async t=>{
 const f=await fixture(t,{seedEvidence:directory=>{for(let index=0;index<NATIVE_ASSET_MEDIA_LIMITS.retainedEntries-1;index++)writeFileSync(path.join(directory,`unknown-${index}.json`),'{}',{mode:0o600});}}),{asset,file}=await f.imported(),moved=path.join(f.external,'chosen.png');renameSync(file,moved);
 const candidate=await f.pick(asset,moved),preview=await f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:true}),sequence=f.sequence(),directory=path.join(f.store.tempDir,'asset-media','native-relink');
 const result=await f.native.apply({projectId:f.projectId,ownerToken:f.ownerToken,previewToken:preview.previewToken,requestId:randomUUID()});
 assert.equal(result.status,'failed');if(result.status==='failed')assert.equal(result.error.code,'ASSET_MEDIA_NATIVE_RETENTION_LIMIT');
 assert.deepEqual(result.confirmedDirectories,[]);assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);assert.equal(f.sequence(),sequence);
 assert.equal(readdirSync(directory).length,NATIVE_ASSET_MEDIA_LIMITS.retainedEntries);
 await f.native.discard({projectId:f.projectId,ownerToken:f.ownerToken,previewToken:preview.previewToken});
 assert.equal(readdirSync(directory).length,NATIVE_ASSET_MEDIA_LIMITS.retainedEntries-1,'only the unaccepted preview is removed, not unknown evidence');
});

test('unknown original-ID queries survive temporary TTL, a rebuilt authority and full retained evidence without writes or regrant',async t=>{
 let clock=Date.now();
 const f=await fixture(t,{now:()=>clock,seedEvidence:directory=>{for(let index=0;index<NATIVE_ASSET_MEDIA_LIMITS.retainedEntries-3;index++)writeFileSync(path.join(directory,`unknown-${index}.json`),'{}',{mode:0o600});}}),{asset,file}=await f.imported(),moved=path.join(f.external,'chosen.png');renameSync(file,moved);
 const candidate=await f.pick(asset,moved),preview=await f.native.preview({projectId:f.projectId,ownerToken:f.ownerToken,candidateToken:candidate.candidateToken,allowOutside:true}),input={projectId:f.projectId,ownerToken:f.ownerToken,previewToken:preview.previewToken,requestId:randomUUID()},abort=new AbortController();
 const unknown=await f.native.apply(input,{signal:abort.signal,beforeEffect:()=>{if(!f.store.db.isTransaction&&f.store.db.prepare('SELECT 1 FROM idempotency WHERE scope=? AND requestId=?').get('asset.media.relink.apply',input.requestId))abort.abort();}});
 assert.equal(unknown.status,'failed');if(unknown.status==='failed')assert.equal(unknown.error.code,'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN');
 const directory=path.join(f.store.tempDir,'asset-media','native-relink');assert.equal(readdirSync(directory).length,NATIVE_ASSET_MEDIA_LIMITS.retainedEntries);
 f.app.outsidePaths.revoke(f.projectId,f.external);rmSync(moved);clock+=NATIVE_ASSET_MEDIA_LIMITS.ticketMs+1;
 const before=f.sequence(),files=readdirSync(directory).sort(),appChanges=f.app.db.prepare('SELECT total_changes() AS n').get()!.n;
 const reconciled=await f.native.apply(input);assert.equal(reconciled.status,'applied');assert.deepEqual(reconciled.confirmedDirectories,[]);
 const rebuilt=createNativeAssetMediaServices(f.store,{outsidePaths:f.app.outsidePaths,now:()=>clock});
 assert.deepEqual(await rebuilt.apply(input),reconciled);
 await assert.rejects(rebuilt.apply({...input,ownerToken:randomUUID()}),{code:'IDEMPOTENCY_CONFLICT'});
 await assert.rejects(rebuilt.apply({...input,requestId:randomUUID()}),{code:'ASSET_MEDIA_NATIVE_UNAVAILABLE'});
 assert.equal(f.sequence(),before);assert.deepEqual(readdirSync(directory).sort(),files);assert.equal(f.app.db.prepare('SELECT total_changes() AS n').get()!.n,appChanges);assert.deepEqual(f.app.outsidePaths.list(f.projectId),[]);
});
