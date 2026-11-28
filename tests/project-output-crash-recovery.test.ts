import {testEnv} from './helpers/test-env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createProjectFile,openProjectStore} from '../packages/business/src/project-file/index.ts';
import {registerProjectMediaStore} from '../packages/business/src/project-media-storage.ts';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';
import {PROJECT_OUTPUT_FOLDERS} from '../packages/contracts/src/project-output-publication.ts';
import {publishProjectOutput,assertPublishedProjectOutput,markProjectOutputRegistered,setProjectOutputPublicationTestHooks,reconcileInterruptedExportPublication} from '../packages/business/src/project-output-publication.ts';
import type {ProjectOutputInput,PublishedProjectOutput} from '../packages/business/src/project-output-publication.ts';
import {png,pngChunk} from './helpers/timeline-image-fixtures.ts';
import {mountProjectVolumeFixture} from './helpers/project-volume-fixture.ts';
import {outputFileIdentity} from '../packages/business/src/project-output-owner.ts';

const cases: {point: string; forceCopy: boolean; atomicExport?: true}[]=[
 {point:'after_intent',forceCopy:false},{point:'after_final',forceCopy:false},
 {point:'after_target_create',forceCopy:true},{point:'after_target_identity',forceCopy:true},{point:'after_copy_chunk',forceCopy:true},
 {point:'after_database_commit',forceCopy:false},{point:'after_registered',forceCopy:false},
 {point:'after_copy_chunk',forceCopy:false,atomicExport:true},{point:'after_final',forceCopy:false,atomicExport:true},
 {point:'after_install',forceCopy:false,atomicExport:true},
];
for(const scenario of cases)test(`SIGKILL ${scenario.point} ${scenario.atomicExport?'during an atomic export ':''}preserves project files and locally registers its exact output once`,async t=>{
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-output-crash-'));let dispose=()=>{};t.after(()=>{try{dispose();}finally{rmSync(root,{recursive:true,force:true});}});
 const projectDir=path.join(root,'project');mkdirSync(projectDir,{mode:0o755});const projectFile=path.join(projectDir,'movie.mioon'),projectId=createProjectFile(projectFile);
 const locate=()=>({localDir:path.join(root,'local'),cacheDir:path.join(root,'cache'),tempDir:path.join(root,'tmp')});
 const initial=openProjectStore({projectFile,locate});initial.put('projects',{id:projectId,name:'Crash recovery'});initial.close();
 const stages=path.join(root,'tmp','artifacts');ensurePrivateDirectory(stages,{create:true});
 const bytes=png({extra:[pngChunk('tEXt',Buffer.from('comment\0'+'x'.repeat(150000)))]}),stageFile=path.join(stages,'complete.png');writeFileSync(stageFile,bytes,{mode:0o600});
 const targetKind = scenario.atomicExport ? 'exports' : scenario.forceCopy ? 'generated' : 'assets';
 const publication:ProjectOutputInput={owner:{kind:scenario.atomicExport?'export':scenario.forceCopy?'image':'import',id:randomUUID(),requestId:randomUUID(),inputHash:'a'.repeat(64)},assetId:randomUUID(),stageFile,targetKind,mimeType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length};
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/project-output-crash-worker.ts',import.meta.url)),JSON.stringify({root,projectFile,publication,...scenario})],{env: testEnv(), stdio:'ignore',timeout:30000});
 assert.equal(child.error,undefined);assert.equal(child.status,null);assert.equal(child.signal,'SIGKILL');
 const targetDir=path.join(projectDir,PROJECT_OUTPUT_FOLDERS[targetKind]),prior=readdirSync(targetDir).map(name=>({file:path.join(targetDir,name),bytes:readFileSync(path.join(targetDir,name)),ino:statSync(path.join(targetDir,name),{bigint:true}).ino}));
 if(scenario.atomicExport){
  assert.deepEqual(prior.map(file=>file.bytes),scenario.point==='after_install'?[bytes]:[]);
  assert.deepEqual(readFileSync(stageFile),bytes);
 }
 const store=openProjectStore({projectFile,locate}),release=registerProjectMediaStore(store);dispose=()=>{release();store.close();};
 const committed=['after_database_commit','after_registered'].includes(scenario.point);assert.equal(store.list('assets',projectId).length,committed?1:0);
 const register=(output:PublishedProjectOutput):void=>{const {relativePath:_relative,...stored}=output;store.put('assets',{id:publication.assetId,projectId,name:'Crash output.png',mimeType:'image/png',width:64,height:64,...stored,provenance:scenario.atomicExport?'export':'generated',createdAt:'2026-11-03T00:00:00.000Z'});};
 if(scenario.atomicExport&&scenario.point==='after_install'){
  reconcileInterruptedExportPublication(store,publication.owner,publication.assetId);
  const sourceChanged=Error('Frozen source changed while the project was closed');
  await assert.rejects(publishProjectOutput(store,publication,{beforeEffect(){throw sourceChanged;}},register),sourceChanged);
  assert.deepEqual(readdirSync(targetDir),[]);
  assert.deepEqual(readdirSync(path.join(projectDir,'.mioon-export-staging')),[]);
  assert.equal(store.list('assets',projectId).length,0);
 }
 setProjectOutputPublicationTestHooks(store,{forceCopy:scenario.forceCopy});
 const output=await publishProjectOutput(store,publication,{},scenario.atomicExport?register:undefined);
 if(scenario.atomicExport){
  const candidateDir=path.join(projectDir,'.mioon-export-staging');
  if(existsSync(candidateDir))assert.deepEqual(readdirSync(candidateDir),[]);
  assert.deepEqual(readdirSync(targetDir),[path.basename(output.relativePath)]);
  if(prior.length)assert.equal(path.join(projectDir,output.relativePath),prior[0]!.file);
 }else{
  for(const old of prior){assert.deepEqual(readFileSync(old.file),old.bytes);assert.equal(statSync(old.file,{bigint:true}).ino,old.ino);}
  if(!committed)store.tx(()=>{assertPublishedProjectOutput(store,output.publication);register(output);});
 }
 assert.equal(store.list('assets',projectId).length,1);const asset=store.list('assets',projectId)[0];assert.ok(asset&&typeof asset==='object'&&'id' in asset);assert.equal(asset.id,publication.assetId);
 await markProjectOutputRegistered(store,output.publication);assert.equal(existsSync(stageFile),false);
 assert.deepEqual(readFileSync(path.join(projectDir,output.relativePath)),bytes);
 const names=readdirSync(targetDir);await publishProjectOutput(store,publication);assert.deepEqual(readdirSync(targetDir),names);assert.equal(store.list('assets',projectId).length,1);
});

for(const format of ['exFAT','FAT32'] as const)test(`SIGKILL during real ${format} media publication resumes the same request`,{timeout:120000},async t=>{
 const volume=await mountProjectVolumeFixture(t,format);
 if(!volume)return;
 for(const targetKind of ['assets','generated'] as const)await t.test(targetKind,async sub=>{
  const root=path.join(volume.root,targetKind),projectDir=path.join(volume.mount,targetKind);
  mkdirSync(root,{mode:0o700});mkdirSync(projectDir,{mode:0o755});
  const projectFile=path.join(projectDir,'project.mioon'),projectId=createProjectFile(projectFile);
  const locate=()=>({localDir:path.join(root,'local'),cacheDir:path.join(root,'cache'),tempDir:path.join(root,'tmp')});
  const initial=openProjectStore({projectFile,locate});
  try{initial.put('projects',{id:projectId,name:'Crash recovery'});}finally{initial.close();}
  const stages=path.join(root,'tmp','artifacts');ensurePrivateDirectory(stages,{create:true});
  const payload=png({extra:[pngChunk('tEXt',Buffer.from('comment\0'+'x'.repeat(150000)))]});
  const stageFile=path.join(stages,'complete.png');writeFileSync(stageFile,payload,{mode:0o600});
  const publication:ProjectOutputInput={owner:{kind:targetKind==='assets'?'import':'image',id:randomUUID(),requestId:randomUUID(),inputHash:'a'.repeat(64)},
   assetId:randomUUID(),publicationId:randomUUID(),stageFile,targetKind,mimeType:'image/png',sha256:createHash('sha256').update(payload).digest('hex'),sizeBytes:payload.length};
  const targetDir=path.join(projectDir,PROJECT_OUTPUT_FOLDERS[targetKind]);mkdirSync(targetDir);
  const foreign=path.join(targetDir,'user.png');writeFileSync(foreign,payload,{flag:'wx'});
  const foreignIdentity=outputFileIdentity(statSync(foreign,{bigint:true}));
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/project-output-crash-worker.ts',import.meta.url)),
   JSON.stringify({root,projectFile,publication,point:'after_copy_chunk',forceCopy:false})],{env:testEnv(),stdio:'pipe',timeout:30000});
  assert.equal(child.error,undefined);assert.equal(child.status,null);assert.equal(child.signal,'SIGKILL',child.stderr?.toString());
  const mediaNames=()=>readdirSync(targetDir).filter(name=>!name.startsWith('._')).sort();
  assert.deepEqual(mediaNames(),['user.png']);
  const candidateDir=path.join(projectDir,'.mioon-export-staging');
  const [partial,...others]=readdirSync(candidateDir).filter(name=>!name.startsWith('._'));
  assert.ok(partial);assert.deepEqual(others,[]);
  const written=readFileSync(path.join(candidateDir,partial));
  assert.ok(written.length>0&&written.length<payload.length);
  assert.deepEqual(written,payload.subarray(0,written.length));
  assert.deepEqual(readFileSync(stageFile),payload);
  const store=openProjectStore({projectFile,locate}),release=registerProjectMediaStore(store);
  sub.after(()=>{release();store.close();});
  assert.equal(store.list('assets',projectId).length,0);
  const output=await publishProjectOutput(store,publication);
  assert.equal(output.publication.assetId,publication.assetId);
  assert.equal(output.publication.publicationId,publication.publicationId);
  assert.equal(output.publication.owner.requestId,publication.owner.requestId);
  assert.deepEqual(readFileSync(path.join(projectDir,output.relativePath)),payload);
  const {relativePath:_relative,...stored}=output;
  store.tx(()=>{
   assertPublishedProjectOutput(store,output.publication);
   store.put('assets',{id:publication.assetId,projectId,name:'Crash output.png',mimeType:'image/png',width:64,height:64,...stored,
    provenance:targetKind==='assets'?'user-import':'generated',createdAt:'2026-11-03T00:00:00.000Z'});
  });
  await markProjectOutputRegistered(store,output.publication);
  assert.deepEqual(await publishProjectOutput(store,publication),output);
  assert.equal(store.list('assets',projectId).length,1);
  assert.deepEqual(readdirSync(candidateDir),[]);
  assert.deepEqual(mediaNames(),[path.basename(output.relativePath),'user.png'].sort());
  assert.deepEqual(outputFileIdentity(statSync(foreign,{bigint:true})),foreignIdentity);
  assert.deepEqual(readFileSync(foreign),payload);
 });
});
