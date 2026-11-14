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
import {publishProjectOutput,assertPublishedProjectOutput,markProjectOutputRegistered,setProjectOutputPublicationTestHooks} from '../packages/business/src/project-output-publication.ts';
import type {ProjectOutputInput} from '../packages/business/src/project-output-publication.ts';
import {png,pngChunk} from './helpers/timeline-image-fixtures.ts';

const cases=[
 {point:'after_intent',forceCopy:false},{point:'after_final',forceCopy:false},
 {point:'after_target_create',forceCopy:true},{point:'after_target_identity',forceCopy:true},{point:'after_copy_chunk',forceCopy:true},
 {point:'after_database_commit',forceCopy:false},{point:'after_registered',forceCopy:false},
];
for(const scenario of cases)test(`SIGKILL ${scenario.point} preserves project files and locally registers its exact output once`,async t=>{
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-output-crash-'));let dispose=()=>{};t.after(()=>{try{dispose();}finally{rmSync(root,{recursive:true,force:true});}});
 const projectDir=path.join(root,'project');mkdirSync(projectDir,{mode:0o755});const projectFile=path.join(projectDir,'movie.mioon'),projectId=createProjectFile(projectFile);
 const locate=()=>({localDir:path.join(root,'local'),cacheDir:path.join(root,'cache'),tempDir:path.join(root,'tmp')});
 const initial=openProjectStore({projectFile,locate});initial.put('projects',{id:projectId,name:'Crash recovery'});initial.close();
 const stages=path.join(root,'tmp','artifacts');ensurePrivateDirectory(stages,{create:true});
 const bytes=png({extra:[pngChunk('tEXt',Buffer.from('comment\0'+'x'.repeat(150000)))]}),stageFile=path.join(stages,'complete.png');writeFileSync(stageFile,bytes,{mode:0o600});
 const publication:ProjectOutputInput={owner:{kind:scenario.forceCopy?'image':'import',id:randomUUID(),requestId:randomUUID(),inputHash:'a'.repeat(64)},assetId:randomUUID(),stageFile,targetKind:scenario.forceCopy?'generated':'assets',mimeType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length};
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/project-output-crash-worker.ts',import.meta.url)),JSON.stringify({root,projectFile,publication,...scenario})],{env: testEnv(), stdio:'ignore',timeout:30000});
 assert.equal(child.error,undefined);assert.equal(child.status,null);assert.equal(child.signal,'SIGKILL');
 const targetDir=path.join(projectDir,scenario.forceCopy?'生成':'素材'),prior=readdirSync(targetDir).map(name=>({file:path.join(targetDir,name),bytes:readFileSync(path.join(targetDir,name)),ino:statSync(path.join(targetDir,name),{bigint:true}).ino}));
 const store=openProjectStore({projectFile,locate}),release=registerProjectMediaStore(store);dispose=()=>{release();store.close();};
 const committed=['after_database_commit','after_registered'].includes(scenario.point);assert.equal(store.list('assets',projectId).length,committed?1:0);
 setProjectOutputPublicationTestHooks(store,{forceCopy:scenario.forceCopy});const output=await publishProjectOutput(store,publication);
 for(const old of prior){assert.deepEqual(readFileSync(old.file),old.bytes);assert.equal(statSync(old.file,{bigint:true}).ino,old.ino);}
 if(!committed)store.tx(()=>{assertPublishedProjectOutput(store,output.publication);const {relativePath:_relative,...stored}=output;store.put('assets',{id:publication.assetId,projectId,name:'Crash output.png',mimeType:'image/png',width:64,height:64,...stored,provenance:'generated',createdAt:'2026-11-03T00:00:00.000Z'});});
 assert.equal(store.list('assets',projectId).length,1);const asset=store.list('assets',projectId)[0];assert.ok(asset&&typeof asset==='object'&&'id' in asset);assert.equal(asset.id,publication.assetId);
 await markProjectOutputRegistered(store,output.publication);assert.equal(existsSync(stageFile),false);
 assert.deepEqual(readFileSync(path.join(projectDir,output.relativePath)),bytes);
 const names=readdirSync(targetDir);await publishProjectOutput(store,publication);assert.deepEqual(readdirSync(targetDir),names);assert.equal(store.list('assets',projectId).length,1);
});
