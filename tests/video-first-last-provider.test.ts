import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import {createArkProvider} from '../packages/business/src/providers/ark.ts';
import {createVeoProvider} from '../packages/business/src/providers/veo.ts';
import {createMinimaxProvider} from '../packages/business/src/providers/minimax.ts';
import {createViduProvider} from '../packages/business/src/providers/vidu.ts';
import {createRunwayProvider} from '../packages/business/src/providers/runway.ts';
import {type TestContext} from 'node:test';
import {errorView} from './helpers/test-error.ts';
interface PairAsset {id: string; path: string; mimeType: string; sha256: string; sizeBytes: number; width: number; height: number; role: string}
interface PairSnapshot {model: string; prompt: string; duration: number; aspectRatio: string; parameters: Record<string, unknown>; lastFrameAssetId: string | null; referenceAssetIds: string[]; referenceAssets: PairAsset[]; referenceBindings: {role: string; assetId: string; sha256: string}[]; [key: string]: unknown}
interface PairFixture {root: string; assets: PairAsset[]; buffers: Buffer[]; env: Record<string, string>; provider: ReturnType<typeof createArkProvider>; snapshot: PairSnapshot; calls: {url: string; options: RequestInit & {body: string}}[]}
interface PairOptions {reply?: () => Response; approved?: boolean}

function png(width=360,height=640,fill=0): Buffer {
 const chunk=(name: string,data: Buffer)=>{const body=Buffer.concat([Buffer.from(name),data]),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc32(body));return Buffer.concat([head,body,tail]);};
 const head=Buffer.alloc(13);head.writeUInt32BE(width);head.writeUInt32BE(height,4);head[8]=8;head[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height,fill))),chunk('IEND',Buffer.alloc(0))]);
}
const sha=(bytes: Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t: TestContext,{reply,approved=true}: PairOptions={}): Promise<PairFixture> {
 const root=await mkdtemp(path.join(tmpdir(),'mioon-pair-adapter-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const buffers=[png(),png(360,640,1)],assets=[];
 for(let index=0;index<2;index++){const id=randomUUID(),file=path.join(root,`${id}.png`);await writeFile(file,buffers[index]);assets.push({id,path:file,mimeType:'image/png',sha256:sha(buffers[index]),sizeBytes:buffers[index].length,width:360,height:640,role:index===0?'first_frame':'last_frame'});}
 const env={MIOON_ENABLE_LIVE_PROVIDER:'1',ARK_API_KEY:'INERT-DO-NOT-LEAK',ARK_APPROVED_ASSET_SHA256:assets.slice(0,approved?2:1).map(a=>a.sha256).join(',')},calls: {url: string; options: RequestInit & {body: string}}[]=[];
 const provider=createArkProvider({root,env,fetchImpl:(async(url: string,options: RequestInit)=>{calls.push({url,options:options as RequestInit & {body: string}});return reply?reply():new Response(JSON.stringify({id:'offline-frame-pair'}));}) as unknown as typeof fetch});
 const snapshot={model:'doubao-seedance-2-5-260628',prompt:'Synthetic shapes',duration:4,aspectRatio:'9:16',parameters:{},lastFrameAssetId:assets[1].id,referenceAssetIds:assets.map(a=>a.id),referenceAssets:assets,referenceBindings:assets.map(a=>({role:a.role,assetId:a.id,sha256:a.sha256}))};
 return {root,assets,buffers,env,provider,snapshot,calls};
}

test('Ark pair sends exact fixed-origin model, first/last roles, adaptive ratio and silent MP4 once',async t=>{
 const f=await fixture(t);let reads=0,fences=0;
 assert.equal(f.provider.validate(f.snapshot),true);assert.equal(f.provider.capabilities.maxReferenceImages,2);
 assert.deepEqual(await f.provider.submit(f.snapshot,{validateReferenceState:()=>{reads++;},beforeSubmit:()=>{fences++;assert.equal(reads,10);}}),{providerJobId:'offline-frame-pair'});
 assert.equal(fences,1);assert.equal(f.calls.length,1);const {url,options}=f.calls[0],body=JSON.parse(options.body);
 assert.equal(url,'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
 assert.deepEqual(body,{model:'doubao-seedance-2-5-260628',content:[{type:'text',text:f.snapshot.prompt},...f.assets.map((asset,index)=>({type:'image_url',image_url:{url:`data:image/png;base64,${f.buffers[index].toString('base64')}`},role:asset.role}))],duration:4,ratio:'adaptive',resolution:'720p',output_format:'mp4',generate_audio:false});
 assert.doesNotMatch(JSON.stringify(f.provider.capabilities),/INERT-DO-NOT-LEAK/);
});

for(const change of ['untyped','reversed','last-only','duplicate','binding-mismatch','tail-id-mismatch','null-tail','missing-pair'])test(`Ark refuses ${change} reference roles without network`,async t=>{
 const f=await fixture(t),snapshot=structuredClone(f.snapshot) as PairSnapshot;
 if(change==='untyped'){snapshot.referenceAssets.forEach((a: PairAsset)=>delete (a as {role?: string}).role);delete (snapshot as {referenceBindings?: unknown}).referenceBindings;}
 if(change==='reversed')snapshot.referenceAssets.reverse();
 if(change==='last-only'){snapshot.referenceAssets=[snapshot.referenceAssets[1]];snapshot.referenceBindings=[snapshot.referenceBindings[1]];}
 if(change==='duplicate')snapshot.referenceAssets[1].id=snapshot.referenceAssets[0].id;
 if(change==='binding-mismatch')snapshot.referenceBindings[1].sha256='f'.repeat(64);
 if(change==='tail-id-mismatch')snapshot.lastFrameAssetId=randomUUID();
 if(change==='null-tail')snapshot.lastFrameAssetId=null;
 if(change==='missing-pair'){snapshot.referenceAssets=[];snapshot.referenceAssetIds=[];snapshot.referenceBindings=[];}
 await assert.rejects(f.provider.submit(snapshot));assert.equal(f.calls.length,0);
});

test('each actual image requires its own explicit approved hash',async t=>{
 const f=await fixture(t,{approved:false});await assert.rejects(f.provider.submit(f.snapshot),{code:'REFERENCE_NOT_APPROVED'});assert.equal(f.calls.length,0);
});
for(const [name,alter,code] of [
 ['hash mismatch',async (f: PairFixture)=>{const changed=Buffer.from(f.buffers[1]);changed[changed.length-1]^=1;await writeFile(f.assets[1].path,changed);},'REFERENCE_CHANGED'],
 ['MIME signature mismatch',async (f: PairFixture)=>{f.assets[1].mimeType='image/jpeg';},'INVALID_REFERENCE_TYPE'],
 ['over 10 MiB',async (f: PairFixture)=>writeFile(f.assets[1].path,Buffer.alloc(10*1024*1024+1)),'REFERENCE_TOO_LARGE'],
 ['actual dimensions mismatch',async (f: PairFixture)=>{f.assets[1].width=720;f.assets[1].height=1280;},'REFERENCE_CHANGED'],
 ['unsupported MIME',async (f: PairFixture)=>{f.assets[1].mimeType='image/webp';},'INVALID_REFERENCE_TYPE'],
 ['wrong aspect',async (f: PairFixture)=>{f.assets[1].width=640;f.assets[1].height=360;},'REFERENCE_ASPECT_RATIO_MISMATCH'],
 ['small dimensions',async (f: PairFixture)=>{f.assets[1].width=90;f.assets[1].height=160;},'INVALID_REFERENCE_DIMENSIONS'],
])test(`second frame ${name} prevents POST`,async (t: TestContext)=>{const f=await fixture(t);await (alter as (fixture: PairFixture)=>Promise<void>)(f);await assert.rejects(f.provider.submit(f.snapshot),{code});assert.equal(f.calls.length,0);});

test('abort at second-image async boundary is definitely before dispatch',async t=>{
 const f=await fixture(t),controller=new AbortController();let checks=0;
 await assert.rejects(f.provider.submit(f.snapshot,{signal:controller.signal,validateReferenceState:()=>{if(++checks===7)controller.abort();}}),(error: unknown)=>{const failure=errorView(error);return failure.code==='OPERATION_CANCELLED'&&failure.beforeDispatch===true&&!failure.uncertain;});
 assert.equal(f.calls.length,0);
});

test('second-image owner check and final POST fence both fail closed',async t=>{
 const f=await fixture(t);let checks=0;
 await assert.rejects(f.provider.submit(f.snapshot,{validateReferenceState:()=>{if(++checks===7)throw Object.assign(Error('Changed owned record'),{code:'OWNERSHIP_CHANGED'});}}),{code:'OWNERSHIP_CHANGED'});assert.equal(f.calls.length,0);
 await assert.rejects(f.provider.submit(f.snapshot,{beforeSubmit:()=>{throw Object.assign(Error('Changed claim'),{code:'GENERATION_STATE_CHANGED'});}}),{code:'GENERATION_STATE_CHANGED'});assert.equal(f.calls.length,0);
});

test('outgoing first image remains its captured approved buffer if file changes during second read',async t=>{
 const f=await fixture(t);let checks=0;
 await f.provider.submit(f.snapshot,{validateReferenceState:()=>{if(++checks===7)writeFileSync(f.assets[0].path,'later unrelated bytes');}});
 const body=JSON.parse(f.calls[0].options.body),outgoing=Buffer.from(body.content[1].image_url.url.split(',')[1],'base64');
 assert.equal(sha(outgoing),f.assets[0].sha256);assert.deepEqual(outgoing,f.buffers[0]);
 // This proves captured-buffer integrity, not elimination of filesystem TOCTOU.
});

test('unknown pair submission is never retried and cancellation remains explicitly local',async t=>{
 const f=await fixture(t,{reply:()=>{throw Error('Lost response');}});
 await assert.rejects(f.provider.submit(f.snapshot),(error: unknown)=>{const failure=errorView(error);return failure.code==='SUBMISSION_UNKNOWN'&&failure.uncertain===true;});assert.equal(f.calls.length,1);
 assert.equal(await (f.provider.reconcile as unknown as (id: string)=>Promise<unknown>)('unknown'),null);const cancel=await (f.provider.cancel as unknown as (id: string)=>Promise<{scope: string; remoteCancelled: boolean; reason: string}>)('unknown');assert.equal(cancel.scope,'local');assert.equal(cancel.remoteCancelled,false);assert.match(cancel.reason,/charges may continue/);assert.equal(f.calls.length,1);
});

for(const [name,factory,model,duration] of [['veo',createVeoProvider,'veo-3.1-generate-preview',4],['minimax',createMinimaxProvider,'MiniMax-H3',4],['vidu',createViduProvider,'viduq3-turbo',4],['runway',createRunwayProvider,'gen4_turbo',5]])test(`${name} adapter rejects a frame pair without dropping its second input`,async t=>{
 const f=await fixture(t),provider=(factory as unknown as (options: Record<string, unknown>)=>{validate(input: unknown): boolean})({root:f.root,env:{},fetchImpl:()=>assert.fail('Network forbidden')});assert.throws(()=>provider.validate({...f.snapshot,model,duration}),(error: unknown)=>['INVALID_REFERENCE_COUNT','INVALID_REFERENCE'].includes(errorView(error).code ?? ''));
});
