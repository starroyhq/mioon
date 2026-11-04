import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {startServer} from '../apps/server/src/index.ts';
import {validateWorkspaceStorage} from '../packages/business/src/application-storage.ts';
import {customImageCredentialBindingV2} from '../packages/business/src/images/custom-settings-v2.ts';
import {CUSTOM_IMAGE_SETTINGS_NAMESPACE,IMAGE_SETTINGS_NAMESPACE,IMAGE_SETTINGS_LIMITS,DEFAULT_CUSTOM_IMAGE_CONFIGURATION,DEFAULT_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import {CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE,DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';
import {VIDEO_SECRET_NAMESPACE,VIDEO_PROVIDER_NAMES,defaultVideoModels} from '../packages/contracts/src/video-providers.ts';
import {COMFY_SETTINGS_NAMESPACE,DEFAULT_COMFY_IMAGE_CONFIGURATION} from '../packages/contracts/src/comfy-images.ts';

async function fixture(t:test.TestContext) {
  const root=await mkdtemp(path.join(tmpdir(),'g1-generation-startup-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const image=path.join(root,'image-settings'),video=path.join(root,'video-settings'),comfy=path.join(root,'comfy-settings');
  for(const directory of [image,video,comfy])await mkdir(directory,{mode:0o700});
  return {root,customFile:path.join(image,'custom-settings.json'),officialFile:path.join(image,'settings.json'),videoFile:path.join(video,'settings.json'),comfyFile:path.join(comfy,'settings.json')};
}
const legacyVideo=()=>({version:1,namespace:VIDEO_SECRET_NAMESPACE,revision:0,connections:[],history:[],credentials:[]});
const legacyCustom=()=>({version:1,namespace:CUSTOM_IMAGE_SETTINGS_NAMESPACE,revision:0,configuration:DEFAULT_CUSTOM_IMAGE_CONFIGURATION,secret:null});

test('production startup recognizes strict old generation files without rewriting or decrypting, then explicit saves publish v2',async t=>{
  const f=await fixture(t),customBytes=JSON.stringify(legacyCustom(),null,2)+'\n',videoBytes=JSON.stringify(legacyVideo(),null,2)+'\n';
  const officialBytes=JSON.stringify({version:1,namespace:IMAGE_SETTINGS_NAMESPACE,revision:0,configuration:DEFAULT_IMAGE_CONFIGURATION,secret:null})+'\n';
  const comfyBytes=JSON.stringify({version:1,namespace:COMFY_SETTINGS_NAMESPACE,revision:0,configuration:DEFAULT_COMFY_IMAGE_CONFIGURATION})+'\n';
  await writeFile(f.customFile,customBytes,{mode:0o600});await writeFile(f.videoFile,videoBytes,{mode:0o600});
  await writeFile(f.officialFile,officialBytes,{mode:0o600});await writeFile(f.comfyFile,comfyBytes,{mode:0o600});
  validateWorkspaceStorage(f.root);
  let decrypts=0;const server=await startServer({dataDir:f.root,port:0,comfyModule:'skip',imageSecretCodec:{storage:()=>({persistentAvailable:true,sessionScope:'server',reasonCode:null}),
    async refreshStorage(){},encrypt:()=>assert.fail('No implicit encryption'),decrypt:()=>{decrypts++;return assert.fail('No old key decryption');}}});t.after(()=>server.close());
  const request=async(route:string,input?:unknown)=>{const response=await fetch(server.url+route,{method:input===undefined?'GET':'PUT',headers:{Authorization:`Bearer ${server.token}`,...(input===undefined?{}:{'content-type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});assert.equal(response.status,200);return await response.json() as {data:{revision:number;notice:string|null;connections:unknown[]}};};
  for(let i=0;i<2;i++) {assert.equal((await request('/api/images/custom-settings')).data.notice,'LEGACY_CUSTOM_IMAGE_SETTINGS_RESET');assert.equal((await request('/api/video-providers/settings')).data.notice,'VIDEO_SETTINGS_V1_RESET');}
  assert.equal(decrypts,0);assert.equal(await readFile(f.customFile,'utf8'),customBytes);assert.equal(await readFile(f.videoFile,'utf8'),videoBytes);
  const image=await request('/api/images/custom-settings',{action:'create',expectedRevision:0,connectionId:randomUUID(),name:'Draft',configuration:DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2,secret:{action:'keep'}});
  assert.equal(image.data.notice,null);assert.equal(JSON.parse(await readFile(f.customFile,'utf8')).version,2);
  const video=await request('/api/video-providers/settings',{action:'save',expectedRevision:0,configuration:{id:randomUUID(),name:VIDEO_PROVIDER_NAMES.minimax,providerId:'minimax',region:'global',workspaceId:'',enabled:false,outputHosts:[],models:defaultVideoModels('minimax')},secret:{action:'keep'}});
  assert.equal(video.data.notice,null);assert.equal(JSON.parse(await readFile(f.videoFile,'utf8')).version,2);
  assert.equal(await readFile(f.officialFile,'utf8'),officialBytes);assert.equal(await readFile(f.comfyFile,'utf8'),comfyBytes);
});

test('startup permits a bounded v2 custom collection above the old single-slot 64 KiB budget',async t=>{
  const f=await fixture(t),configuration={...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2,enabled:true,baseUrl:'https://images.example.com/v1',model:'same-model'};
  const connections=Array.from({length:2},(_,n)=>{const connectionId=randomUUID();return {connectionId,name:`Custom ${n}`,configurationRevision:1,configuration,
    secret:{binding:customImageCredentialBindingV2(connectionId,configuration),encrypted:Buffer.alloc(34*1024,n+1).toString('base64')}};});
  const bytes=JSON.stringify({version:2,namespace:CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE,revision:1,connections,deletedConnectionIds:[]});
  assert.ok(Buffer.byteLength(bytes)>IMAGE_SETTINGS_LIMITS.envelopeBytes);await writeFile(f.customFile,bytes,{mode:0o600});
  validateWorkspaceStorage(f.root);const server=await startServer({dataDir:f.root,port:0,comfyModule:'skip'});t.after(()=>server.close());
  const response=await fetch(server.url+'/api/images/custom-settings',{headers:{Authorization:`Bearer ${server.token}`}});assert.equal(response.status,200);
  const result=await response.json() as {data:{connections:unknown[];notice:unknown}};assert.equal(result.data.connections.length,2);assert.equal(result.data.notice,null);
  assert.equal(await readFile(f.customFile,'utf8'),bytes);
});

for(const kind of ['future-custom','bad-custom-v1','padded-custom-v1','future-video','bad-video-v1'] as const)
  test(`startup rejects ${kind} before creating locks, tokens or databases`,async t=>{
    const f=await fixture(t),video=kind.includes('video'),file=video?f.videoFile:f.customFile;
    const value=video?legacyVideo():legacyCustom();
    const bytes=kind==='padded-custom-v1'?JSON.stringify(value)+' '.repeat(IMAGE_SETTINGS_LIMITS.envelopeBytes):
      JSON.stringify(kind.startsWith('future')?{...value,version:9}:{...value,namespace:'mioon.agent.v1'});
    await writeFile(file,bytes,{mode:0o600});const before=await stat(file),code=video?'VIDEO_SETTINGS_CORRUPT':'IMAGE_SETTINGS_CORRUPT';
    assert.throws(()=>validateWorkspaceStorage(f.root),{code});await assert.rejects(startServer({dataDir:f.root,port:0}),{code});
    assert.equal(await readFile(file,'utf8'),bytes);assert.equal((await stat(file)).ino,before.ino);
    for(const name of ['server.lock','access-token','app-library.db'])await assert.rejects(stat(path.join(f.root,name)),{code:'ENOENT'});
  });
