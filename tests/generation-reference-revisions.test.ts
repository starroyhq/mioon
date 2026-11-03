import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, open, readFile, rename, rm, stat, utimes, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {startWorker, type Worker} from '../packages/business/src/jobs.ts';
import {mediaReferenceSchema} from '../packages/contracts/src/media-reference.ts';
import {sampleRanges} from '../packages/business/src/media-reference/fingerprint.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

type Row = Record<string, unknown>;
interface Asset {id: string; projectId: string; sha256: string; referenceRevision: number}
interface Shot {id: string; revision: number}
interface Job {id: string}
interface ReferenceRevision {assetId: string; referenceRevision: number; sha256: string}
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function row(value: unknown): Row {assert.ok(value && typeof value === 'object' && !Array.isArray(value));return value as Row;}
function sampled(bytes: Buffer): string {const hash=createHash('sha256');for(const range of sampleRanges(bytes.length))hash.update(bytes.subarray(range.start,range.start+range.length));return hash.digest('hex');}

async function fixture(t: TestContext, {large=false, pair=false}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'generation-reference-revisions-')),store=openStore(root);
  const providers=createProviderRegistry({db:store.db,root,env:{MIOON_ENABLE_LIVE_PROVIDER:'0'}}),base=providers.get('mock');assert.ok(base);
  let submitCounter=0,dispatchCounter=0,worker:Worker|undefined;
  providers.set('mock',{...base,submit:async(_snapshot,context)=>{submitCounter++;context.beforeSubmit?.();dispatchCounter++;return {providerJobId:'counted-local-submit'};},
    poll:async()=>({status:'running',progress:.1}),reconcile:async()=>null,download:async()=>{throw Error('These pre-dispatch tests never download or render');}});
  const services=createServices(store,providers,{env:{MIOON_ENABLE_LIVE_PROVIDER:'0'},profileNow:()=>Date.parse('2026-10-10T12:00:00Z')});
  t.after(async()=>{await worker?.stop();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
  const project=row(await services.call('project.create',{name:'Reference confirmation regressions'}));assert.equal(project.id,store.projectId);
  await mkdir(path.join(root,'sources'));
  const sources: {asset:Asset;file:string;bytes:Buffer}[]=[];
  for(let index=0;index<(pair?2:1);index++) {
    let seed=0x5ac17;
    const bytes=large?png({width:720,height:1280,pixel:()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return [seed&255,(seed>>>8)&255,(seed>>>16)&255,255];}}):
      png({width:360,height:640,pixel:()=>[80+index*30,120,160,255]});
    const file=path.join(root,'sources',`input-${index}.png`);await writeFile(file,bytes);
    // An exact whole-second source timestamp makes the later unchanged-mtime
    // mutation independent of filesystem submillisecond rounding.
    const seconds=1_790_000_000+index;await utimes(file,seconds,seconds);
    const asset=await services.call('asset.import',{projectId:store.projectId,requestId:randomUUID(),sourcePath:file,name:`Input ${index}`}) as Asset;
    assert.equal(asset.sha256,digest(bytes));assert.equal(asset.referenceRevision,1);
    const persisted=row(store.get('assets',asset.id));assert.equal(persisted.relativePath,undefined);mediaReferenceSchema.parse(persisted.reference);
    sources.push({asset,file,bytes});
  }
  const shot=await services.call('shot.create',{projectId:store.projectId,title:'Confirmed source',prompt:'Local deterministic test',duration:4,referenceAssetIds:[sources[0]!.asset.id],
    ...(pair?{lastFrameAssetId:sources[1]!.asset.id}:{})}) as Shot;
  const input={shotId:shot.id,expectedRevision:shot.revision,providerId:'mock',requestId:randomUUID()};
  const revisions:ReferenceRevision[]=sources.map(({asset})=>({assetId:asset.id,referenceRevision:asset.referenceRevision,sha256:asset.sha256}));
  const saved=(jobId:string)=>row(store.get('jobs',jobId));
  return {root,store,services,sources,shot,input,revisions,saved,submits:()=>submitCounter,dispatches:()=>dispatchCounter,
    submit:(patch:Row={})=>services.call('generation.submit',{...input,...patch}) as Promise<Job>,
    async tick(){worker??=startWorker(store,services,providers);await worker.tick();},
  };
}

test('web confirmation revisions are an exact ordered set and reject drift before writing any job',async t=>{
  const f=await fixture(t,{pair:true}),expected=f.revisions;
  const cases:readonly (readonly [string,ReferenceRevision[]])[]=[
    ['omitted reference',[expected[0]!]],['reordered references',[expected[1]!,expected[0]!]],
    ['stale revision',[{...expected[0]!,referenceRevision:2},expected[1]!]],
    ['different full hash',[{...expected[0]!,sha256:'f'.repeat(64)},expected[1]!]],
    ['extra reference',[...expected,{assetId:randomUUID(),referenceRevision:1,sha256:'e'.repeat(64)}]],
    ['duplicate reference',[expected[0]!,expected[0]!]],['empty confirmation',[]],
  ];
  for(const [name,referenceRevisions] of cases) await t.test(name,async()=>{
    const writes=f.store.db.prepare('SELECT total_changes() AS n').get()?.n;
    await assert.rejects(f.submit({requestId:randomUUID(),referenceRevisions}),{code:'REFERENCE_CHANGED',status:409});
    assert.equal(f.store.list('jobs').length,0);assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM idempotency WHERE scope='generation'").get()?.n,0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM job_events').get()?.n,0);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()?.n,writes);assert.equal(f.submits(),0);assert.equal(f.dispatches(),0);
  });
  const job=await f.submit({referenceRevisions:expected});assert.equal(f.saved(job.id).submissionCount,0);
  await f.tick();assert.equal(f.submits(),1);assert.equal(f.dispatches(),1);assert.equal(f.saved(job.id).status,'running');
});

test('Mio business submission freezes full hashes and revisions even without web confirmation; relink invalidates queued dispatch',async t=>{
  const f=await fixture(t),source=f.sources[0]!,job=await f.submit();
  const before=f.saved(job.id),snapshot=JSON.stringify(before.snapshot),frozen=row((row(before.snapshot).referenceAssets as unknown[])[0]);
  assert.equal(frozen.id,source.asset.id);assert.equal(frozen.referenceRevision,1);assert.equal(frozen.sha256,source.asset.sha256);
  const reference=mediaReferenceSchema.parse(frozen.reference);assert.equal(reference.fullSha256,source.asset.sha256);assert.equal(frozen.relativePath,undefined);
  assert.equal(before.submissionCount,0);assert.equal(f.submits(),0);
  const replacement=path.join(f.root,'sources','same-content.png');await rename(source.file,replacement);
  const preview=row(await f.services.call('asset.media.relink.preview',{projectId:f.store.projectId,assetId:source.asset.id,sourcePath:replacement,expectedReferenceRevision:1}));
  assert.equal(row(preview.chosen).matches,true);
  await f.services.call('asset.media.relink.apply',{projectId:f.store.projectId,requestId:randomUUID(),previewToken:preview.previewToken});
  const current=row(f.store.get('assets',source.asset.id));assert.equal(current.referenceRevision,2);assert.equal(current.sha256,source.asset.sha256);
  assert.notEqual(mediaReferenceSchema.parse(current.reference).path,reference.path);
  await f.tick();const rejected=f.saved(job.id);
  assert.equal(rejected.status,'failed');assert.equal(row(rejected.error).code,'REFERENCE_CHANGED');assert.equal(rejected.submissionCount,0);
  assert.equal(f.submits(),0);assert.equal(f.dispatches(),0);assert.equal(JSON.stringify(rejected.snapshot),snapshot,'frozen confirmation is never refreshed to the relinked source');
});

test('dispatch whole-file hash catches unsampled image changes with restored size and mtime before any submit',async t=>{
  const f=await fixture(t,{large:true}),source=f.sources[0]!;assert.ok(source.bytes.length>1024*1024);
  const job=await f.submit(),original=f.saved(job.id),snapshot=JSON.stringify(original.snapshot),metadata=await stat(source.file,{bigint:true});
  const ranges=sampleRanges(source.bytes.length);let offset=-1;
  for(let index=1;index<ranges.length;index++){const end=ranges[index-1]!.start+ranges[index-1]!.length;if(ranges[index]!.start>end){offset=end+Math.floor((ranges[index]!.start-end)/2);break;}}
  assert.ok(offset>0&&ranges.every(range=>offset<range.start||offset>=range.start+range.length));
  const handle=await open(source.file,'r+');try{await handle.write(Buffer.from([source.bytes[offset]!^1]),0,1,offset);}finally{await handle.close();}
  const seconds=Number(metadata.mtimeNs/1_000_000_000n);await utimes(source.file,seconds,seconds);
  const changed=await readFile(source.file),after=await stat(source.file,{bigint:true});
  assert.equal(after.size,metadata.size);assert.equal(after.mtimeNs,metadata.mtimeNs);assert.equal(sampled(changed),sampled(source.bytes));assert.notEqual(digest(changed),source.asset.sha256);
  const states=row(await f.services.call('asset.media.status.list',{projectId:f.store.projectId,assetIds:[source.asset.id]}));
  const state=row((states.items as unknown[])[0]);assert.equal(state.status,'online');assert.equal(state.readable,true,'sample/stat checks alone do not notice the changed middle byte');
  await f.tick();const rejected=f.saved(job.id);
  assert.equal(rejected.status,'failed');assert.equal(row(rejected.error).code,'REFERENCE_CHANGED');assert.equal(rejected.submissionCount,0);
  assert.equal(f.submits(),0);assert.equal(f.dispatches(),0);assert.equal(JSON.stringify(rejected.snapshot),snapshot);
});
