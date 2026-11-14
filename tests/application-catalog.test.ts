import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProviderCatalog, createProviderRegistry, normalizedCapabilities, profileDate} from '../packages/business/src/provider-registry.ts';
import {listImageProfiles} from '../packages/business/src/images.ts';
import {createImageSettings, createCustomImageSettings} from '../packages/business/src/images/settings.ts';
import {createLiveImageGateway, createCompatibleImageGateway} from '../packages/business/src/images/gateway.ts';
import {startServer} from '../apps/server/src/index.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS} from '../packages/contracts/src/images.ts';
import {projectMediaPath} from '../packages/contracts/src/project-file.ts';
import {rpcPathFor} from '../packages/contracts/src/project-addressing.ts';
import {DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';

test('application provider catalog matches project discovery without creating a database or managed files',t=>{
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-app-catalog-')),db=new DatabaseSync(':memory:');
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  const before=globalThis.fetch;globalThis.fetch=async()=>assert.fail('Discovery cannot use the network');t.after(()=>{globalThis.fetch=before;});
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),changes=db.prepare('SELECT total_changes() AS n').get();
  for(const env of [{},{MIOON_ENABLE_LIVE_PROVIDER:'1',RUNWAYML_API_SECRET:'synthetic-catalog-key',ARK_API_KEY:'synthetic-catalog-key',GEMINI_API_KEY:'synthetic-catalog-key',MINIMAX_API_KEY:'synthetic-catalog-key',VIDU_API_KEY:'synthetic-catalog-key'},
    {MINIMAX_REGION:'invalid',VIDU_REGION:'invalid'}]) {
    const catalog=createProviderCatalog({root,env}),registry=createProviderRegistry({db,root,env});
    assert.deepEqual(catalog.list(),[...registry.values()].map(provider=>normalizedCapabilities(provider,env,0,{asOf:profileDate(),requireInputProfiles:true})));
    assert.equal(catalog.list().length,6);assert.doesNotMatch(JSON.stringify(catalog.list()),/synthetic-catalog-key/);
    assert.deepEqual(Object.keys(catalog),['list']);
  }
  assert.deepEqual(readdirSync(root),[]);
  assert.deepEqual(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),schema);
  assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(),changes);
});

test('application catalog exposes independent metadata snapshots without execution handles',()=>{
  const catalog=createProviderCatalog({root:'/uncreated/application/catalog',env:{}}),first=catalog.list();
  first[0].id='mutated';assert.equal(catalog.list()[0].id,'mock');
  assert.equal(first.some(value=>'submit' in value||'poll' in value||'download' in value),false);
});

test('image profile discovery reads settings metadata without opening a project or sending credentials',async()=>{
  const persistence={load:async()=>null,save:async()=>{}};
  const settings=await createImageSettings({persistence}),customSettings=await createCustomImageSettings({persistence});
  try {
    const saved=await settings.put({expectedRevision:(await settings.get()).revision,configuration:{...DEFAULT_IMAGE_CONFIGURATION,enabled:true},secret:{action:'replace',storage:'session',value:'synthetic-catalog-key'}});
    const custom=await customSettings.put({expectedRevision:(await customSettings.get()).revision,configuration:{...DEFAULT_CUSTOM_IMAGE_CONFIGURATION,enabled:true,baseUrl:'https://catalog.example.test/images',model:'catalog-model'},secret:{action:'replace',storage:'session',value:'synthetic-custom-key'}});
    const dependencies={settings,customSettings,liveGateway:createLiveImageGateway({settings}),customGateway:createCompatibleImageGateway({settings:customSettings})};
    const legacy=listImageProfiles(dependencies),revisions=listImageProfiles(dependencies,{includeSettingsRevision:true});
    assert.equal(legacy.liveEnabled,true);assert.deepEqual(legacy.items.map(item=>item.providerId),['mock','openai','openai-compatible']);
    assert.equal(legacy.items.some(item=>'settingsRevision' in item),false);
    assert.equal(revisions.items[1].settingsRevision,saved.revision);assert.equal(revisions.items[2].settingsRevision,custom.revision);
    assert.doesNotMatch(JSON.stringify(revisions),/synthetic-catalog-key|synthetic-custom-key|apiKey|encrypted/);
    assert.equal(listImageProfiles({settings}).liveEnabled,false,'a settings flag cannot invent an unavailable gateway');
    assert.equal(listImageProfiles().items.length,2);
  } finally {await settings.close();await customSettings.close();}
});

test('stable channel hides Mock and denies new work while existing Mock outputs remain readable', {timeout:15000}, async t=>{
  const dataDir=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-stable-generation-'));
  const token='synthetic-stable-catalog-token';
  let server=await startServer({dataDir,token,port:0,localDraftChannel:'development'});
  t.after(async()=>{await server.close();rmSync(dataDir,{recursive:true,force:true});});
  type Row={id:string;[key:string]:unknown};
  const rpc=async(operation:string,input:Record<string,unknown>={},projectId?:string)=>{
    const response=await fetch(server.url+rpcPathFor(operation,input,projectId),{method:'POST',
      headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({operation,input})});
    return {status:response.status,...await response.json()} as {status:number;ok:boolean;data:unknown;error?:{code:string;details?:Record<string,unknown>}};
  };
  const read=async(operation:string,input:Record<string,unknown>={},projectId?:string)=>{
    const result=await rpc(operation,input,projectId);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.ok,true);return result.data;
  };
  const providers=()=>read('provider.list') as Promise<Row[]>;
  const profiles=()=>read('image.profile.list') as Promise<{items:{providerId:string;enabled:boolean}[]}>;
  assert.ok((await providers()).some(provider=>provider.id==='mock'));
  assert.ok((await profiles()).items.some(profile=>profile.providerId==='mock'&&profile.enabled));
  const project=await read('project.create',{name:'Synthetic project with historical generations'}) as Row;
  const shot=await read('shot.create',{projectId:project.id,title:'Synthetic shot',aspectRatio:'9:16',duration:4,referenceAssetIds:[]}) as Row;
  const imageInput={projectId:project.id,requestId:randomUUID(),providerId:'mock',model:IMAGE_MODELS.mock,name:'Historical synthetic image',
    prompt:'Deterministic test image',options:{...IMAGE_FIXED_OPTIONS}};
  const accepted=await read('image.generate',imageInput) as Row;
  const versionList=()=>read('image.version.list',{projectId:project.id,groupId:accepted.groupId}) as Promise<{items:Row[]}>;
  let versions=await versionList();
  const deadline=Date.now()+10000;
  while(Date.now()<deadline&&versions.items.length===0){
    await new Promise(resolve=>setTimeout(resolve,25));versions=await versionList();
  }
  const version=versions.items[0];assert.ok(version);assert.equal(version.isMock,true);
  const media=()=>fetch(server.url+projectMediaPath(project.id,String(version.assetId)),{headers:{authorization:'Bearer '+token}});
  const before=await media();assert.equal(before.status,200);
  const bytes=Buffer.from(await before.arrayBuffer());assert.ok(bytes.length>0);
  await server.close();
  server=await startServer({dataDir,token,port:0,localDraftChannel:'production'});
  assert.ok((await providers()).every(provider=>provider.id!=='mock'&&provider.mock!==true));
  assert.ok((await profiles()).items.every(profile=>profile.providerId!=='mock'));
  assert.deepEqual(await versionList(),versions);
  const historicalMedia=await media();assert.equal(historicalMedia.status,200);
  assert.deepEqual(Buffer.from(await historicalMedia.arrayBuffer()),bytes);
  assert.deepEqual(await read('image.generate',imageInput),accepted,'exact replay reads the original receipt');
  const rejectGeneration=async(operation:string,input:Record<string,unknown>,scope?:string)=>{
    const result=await rpc(operation,input,scope);
    assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.ok,false);
    assert.equal(result.error?.code,'GENERATION_SERVICE_UNAVAILABLE');
    assert.equal(result.error.details?.mutationOutcome,'not_applied');
  };
  const newImage={...imageInput,requestId:randomUUID()};
  await rejectGeneration('image.generate',newImage);
  assert.equal(await read('image.request.get',{projectId:project.id,requestId:newImage.requestId}),null);
  await rejectGeneration('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,requestId:randomUUID(),providerId:'mock'},project.id);
  assert.deepEqual(await read('job.list',{projectId:project.id}),[]);
  assert.deepEqual(await versionList(),versions);
});
