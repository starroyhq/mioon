import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient,discoverSchema} from '../packages/client/src/index.ts';
import {assetImportSchema,toAssetMediaDto,assetMediaEffects} from '../packages/contracts/src/asset-media.ts';
import {publicValue} from '../packages/contracts/src/index.ts';
import {checkGenerationMediaReferences,generationReferenceIdentity} from '../apps/web/src/generation-settings.ts';
import {createAssetImportHost} from '../apps/desktop/src/asset-import-host.ts';
import {createAssetImportBridge} from '../apps/desktop/src/asset-import-preload.ts';
const projectId='11111111-1111-4111-8111-111111111111',assetId='22222222-2222-4222-8222-222222222222',sha='a'.repeat(64),requestId='33333333-3333-4333-8333-333333333333';
const reference={pathForm:'relative' as const,path:'../私人/image.png',volume:null,sizeBytes:42,mtimeMs:1,sampledSha256:'b'.repeat(64),fullSha256:sha};
const record={id:assetId,projectId,name:'image.png',mimeType:'image/png' as const,sizeBytes:42,sha256:sha,reference,referenceRevision:1};
const dto=toAssetMediaDto(record);
test('asset import union and public asset projection keep path and sampled hash semantics',()=>{
 assert.ok(assetImportSchema.safeParse({projectId,requestId,sourcePath:'/large/image.png'}).success);
 assert.equal(assetImportSchema.safeParse({projectId,requestId,sourcePath:'/large/image.png',dataBase64:'AA==',mimeType:'image/png',name:'x'}).success,false);
 const value=publicValue({assets:[record],nested:{asset:record}});
 assert.deepEqual(value,{assets:[dto],nested:{asset:dto}});
 assert.ok(!JSON.stringify(value).includes('私人'));
 const {name:_name,...frozen}=record;const snapshot=publicValue({...frozen,role:'first_frame'});assert.deepEqual(snapshot,{id:assetId,projectId,mimeType:'image/png',sizeBytes:42,sha256:sha,referenceRevision:1,role:'first_frame',fingerprint:dto.fingerprint});
 assert.equal(toAssetMediaDto({...record,sha256:null,reference:{...reference,fullSha256:null}}).sha256,null);
 assert.equal(toAssetMediaDto({...record,sha256:null,reference:{...reference,fullSha256:null}}).hashState,'sampled');
});
test('discovery omits sensitive location and permission operations',()=>{
 const operations=(discoverSchema() as {operations:{operation:string}[]}).operations.map(item=>item.operation);
 assert.ok(operations.includes('asset.media.status.list'));assert.ok(operations.includes('asset.media.prepare'));
 assert.equal(assetMediaEffects['asset.media.prepare'].fileWrite,false);for(const name of ['asset.media.relink.preview','asset.media.relink.apply','asset.media.acceptChanged'] as const)assert.equal(assetMediaEffects[name].fileWrite,true);
 assert.equal(assetMediaEffects['asset.media.relink.preview'].readOnly,false);
 for(const name of ['asset.media.location.list','asset.media.outside.confirm','asset.media.outside.revoke','asset.import.path'])assert.equal(operations.includes(name),false,name);
});
test('ordinary reference operations and explicit user action use separate authenticated routes',async()=>{
 const requests:{url:string;headers:Headers;body:unknown}[]=[];
 const client=createClient({env:{MIOON_BASE_URL:'http://127.0.0.1:12345',MIOON_TOKEN:'synthetic-local-token'},fetchImpl:async(url,options)=>{
  const body=JSON.parse(String(options?.body));requests.push({url:String(url),headers:new Headers(options?.headers),body});return Response.json({ok:true,data:body.operation==='asset.media.status.list'?{items:[],nextCursor:null}:{asset:dto,confirmedDirectories:['/large']}});
 }});
 await client.rpc('asset.media.status.list',{projectId,assetIds:[assetId]});
 await client.trustedAssetMedia('asset.import.path',{projectId,requestId,sourcePath:'/large/image.png'});
 assert.equal(requests[0].url,`http://127.0.0.1:12345/api/projects/${projectId}/rpc`);
 assert.equal(requests[0].headers.has('x-mioon-user-action'),false);
 assert.equal(requests[1].url,`http://127.0.0.1:12345/api/projects/${projectId}/asset-media/trusted`);
 assert.equal(requests[1].headers.get('x-mioon-user-action'),'asset-media');
 assert.equal(requests[1].headers.get('authorization'),'Bearer synthetic-local-token');
 await assert.rejects(client.rpc('asset.media.outside.confirm',{projectId,requestId,locationToken:assetId}),{code:'UNKNOWN_OPERATION'});
});
test('paid confirmation checks both image and audio availability/full hash/revision',async()=>{
 const audio={...dto,id:requestId,mimeType:'audio/mpeg',name:'sound.mp3'};
 const shot={projectId,videoInput:{version:1 as const,mode:'reference_images' as const,images:[{assetId,role:'reference_image' as const}],audios:[{assetId:requestId,role:'reference_audio' as const}]}};
 // The explicit input schema version is not part of this bounded status gate;
 // use the supported image/subject selection and add audio independently.
 const simple={projectId,referenceAssetIds:[assetId]};
 let requested:unknown;
 const online=async(input:unknown)=>{requested=input;return {items:[{assetId,referenceRevision:1,status:'online',reason:'same-stats',outside:false,readable:true,fingerprintToken:'c'.repeat(64)}],nextCursor:null};};
 await checkGenerationMediaReferences(simple,[dto],{},online);
 assert.deepEqual(requested,{projectId,assetIds:[assetId]});
 await assert.rejects(checkGenerationMediaReferences(simple,[{...dto,sha256:null}],{},online));
 await assert.rejects(checkGenerationMediaReferences(simple,[{...dto,referenceRevision:2}],{},online));
 await assert.rejects(checkGenerationMediaReferences(simple,[dto],{},async()=>({items:[{assetId,referenceRevision:1,status:'online',reason:'same-stats',outside:true,readable:false,fingerprintToken:'c'.repeat(64)}],nextCursor:null})));
 const audioOnly={projectId,videoInput:{...shot.videoInput,images:[]}};
 await checkGenerationMediaReferences(audioOnly,[audio],{},async input=>{assert.deepEqual(input.assetIds,[requestId]);return {items:[{assetId:requestId,referenceRevision:1,status:'online',reason:'same-stats',outside:false,readable:true,fingerprintToken:'c'.repeat(64)}],nextCursor:null};});
 await assert.rejects(checkGenerationMediaReferences(audioOnly,[audio],{},async()=>({items:[{assetId:requestId,referenceRevision:1,status:'missing',reason:'not-found',outside:true,readable:false,fingerprintToken:'c'.repeat(64)}],nextCursor:null})));
 assert.notEqual(generationReferenceIdentity(audioOnly,[audio]),generationReferenceIdentity(audioOnly,[{...audio,referenceRevision:2}]));
});
test('native selection tokens bind exact current document and never expose source paths',async()=>{
 let live=true,calls=0;const key={},owner={projectId,key,isCurrent:()=>live};
 const host=createAssetImportHost({ownerForEvent:()=>owner,chooseFiles:async()=>['/large/image.png'],importPath:async input=>{calls++;assert.equal(input.sourcePath,'/large/image.png');return {asset:dto,confirmedDirectories:['/large']};}});
 const files=await host.dispatch({}, {action:'choose'}) as {token:string;name:string}[];
 assert.deepEqual(Object.keys(files[0]).sort(),['name','token']);assert.equal(files[0].name,'image.png');
 assert.deepEqual(await host.dispatch({}, {action:'import',token:files[0].token,requestId}),dto);
 live=false;await assert.rejects(host.dispatch({}, {action:'import',token:files[0].token,requestId}));assert.equal(calls,1);
 let complete!:(files:string[])=>void;live=true;const blocked=createAssetImportHost({ownerForEvent:()=>owner,chooseFiles:()=>new Promise(resolve=>{complete=resolve;}),importPath:async()=>{throw Error('must not import');}});
 const waiting=blocked.dispatch({}, {action:'choose'});live=false;complete(['/large/image.png']);await assert.rejects(waiting);
});
test('preload drop only obtains paths from native File backing, rejects synthesized files',async()=>{
 const calls:unknown[]=[];
 const bridge=createAssetImportBridge({invoke:async(_channel,input)=>{calls.push(input);return [];},pathForFile:()=>''});
 await assert.rejects(bridge.files([new File(['fake'],'image.png')]));assert.equal(calls.length,0);
 await bridge.choose();assert.deepEqual(calls,[{action:'choose'}]);
});
