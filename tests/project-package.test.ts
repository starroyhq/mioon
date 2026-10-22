import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,createWriteStream,createReadStream,existsSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {collectProject,packageDocumentBytes,buildManifest,createProjectFromDocument} from '../packages/business/src/project-package/document.ts';
import {writeProjectPackage,readProjectPackage} from '../packages/business/src/project-package/container.ts';
import {buildSampleProject,openWorkspace,tempRoot,cleanup,mediaToolsAvailable} from './helpers/project-package-fixture.ts';

const options={media:'all' as const,includeExports:false};
async function exportTo(store:any,projectId:string,file:string){
 const collected=collectProject(store,projectId,options),document=packageDocumentBytes(collected.document);
 const manifest=buildManifest({collected,document,appVersion:'test',options,name:collected.document.project.name});
 await pipeline(Readable.from(writeProjectPackage({manifest,document,media:collected.media.map(entry=>entry.source)})),createWriteStream(file));
 return collected;
}
const projectRows=(store:any,projectId:string)=>Object.fromEntries(['assets','shots','nodes','edges','jobs','versions','timelines'].map(table=>[table,store.list(table,projectId).length]));

test('a project round-trips through a .mioon file into another workspace and survives reopening',{skip:!mediaToolsAvailable&&'ffmpeg unavailable'},async t=>{
 const sourceRoot=tempRoot('package-source'),targetRoot=tempRoot('package-target'),work=mkdtempSync(path.join(tmpdir(),'mioon-package-work-'));
 t.after(()=>cleanup(sourceRoot,targetRoot,work));
 const source=openWorkspace(sourceRoot),sample=await buildSampleProject(sourceRoot,source);
 const file=path.join(work,'sample.mioon'),collected=await exportTo(source.store,sample.project.id,file);
 assert.deepEqual(collected.missing,[]);
 source.store.close();
 const staging=mkdtempSync(path.join(tmpdir(),'mioon-package-stage-'));t.after(()=>cleanup(staging));
 const read=await readProjectPackage({source:createReadStream(file),destination:staging});
 assert.equal(read.manifest.counts.versions,1);
 let target=openWorkspace(targetRoot);
 const files=new Map([...read.media].map(([key,value])=>[key,value.file]));
 const {projectId}=createProjectFromDocument(target.store,{document:read.document as any,files,name:'UI 走查项目（2）',move:true});
 assert.deepEqual(projectRows(target.store,projectId),{assets:5,shots:1,nodes:2,edges:2,jobs:1,versions:1,timelines:1});
 target.store.close();target=openWorkspace(targetRoot);t.after(()=>target.store.close());
 const project:any=await target.services.call('project.get',{projectId});
 assert.equal((project.project??project).name,'UI 走查项目（2）');
 const timeline:any=await target.services.call('timeline.get',{projectId});
 assert.equal(timeline.clips.length,3);assert.equal(timeline.subtitles.cues.length,1);
 const text=JSON.stringify(target.store.list('shots',projectId))+JSON.stringify(timeline);
 for(const old of [sample.project.id,sample.shot.id,sample.assets.video.id,sample.versionId])assert.equal(text.includes(old),false);
 for(const asset of target.store.list('assets',projectId) as any[]){
  const bytes=readFileSync(path.join(targetRoot,asset.relativePath));assert.equal(bytes.length,asset.sizeBytes);
 }
 // The imported project behaves like any other: it can be edited and deleted.
 const shot=target.store.list('shots',projectId)[0] as any;
 await target.services.call('shot.update',{requestId:crypto.randomUUID(),shotId:shot.id,expectedRevision:shot.revision,patch:{title:'改名'}});
});

test('duplicating copies media files instead of sharing them',{skip:!mediaToolsAvailable&&'ffmpeg unavailable'},async t=>{
 const root=tempRoot('package-duplicate');t.after(()=>cleanup(root));
 const ws=openWorkspace(root);t.after(()=>ws.store.close());
 const sample=await buildSampleProject(root,ws);
 const collected=collectProject(ws.store,sample.project.id,options);
 const files=new Map(collected.media.map(entry=>[entry.path,path.join(root,'__unused__')]));
 for(const asset of ws.store.list('assets',sample.project.id) as any[]){const entry=collected.document.assets.find(item=>item.id===asset.id)!;files.set(entry.media,path.join(root,asset.relativePath));}
 for(const lut of collected.document.luts){const file=path.join(root,`lut-${lut.id}.cube`);writeFileSync(file,Buffer.from((ws.store.db.prepare('SELECT content FROM project_lut_resources WHERE id=?').get(lut.id) as any).content));files.set(lut.media,file);}
 const {projectId}=createProjectFromDocument(ws.store,{document:collected.document,files,name:'UI 走查项目 副本',move:false});
 const originals=new Set((ws.store.list('assets',sample.project.id) as any[]).map(asset=>statSync(path.join(root,asset.relativePath)).ino));
 for(const asset of ws.store.list('assets',projectId) as any[]){assert.ok(existsSync(path.join(root,asset.relativePath)));assert.equal(originals.has(statSync(path.join(root,asset.relativePath)).ino),false);}
});

import {randomUUID} from 'node:crypto';
import {createProjectLifecycleServices} from '../packages/business/src/project-lifecycle.ts';
import {ownsStoreLock,getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile,validateManagedDirectory} from '@mioon/contracts/private-storage';
import {PROJECT_PACKAGE_MAGIC} from '../packages/business/src/project-package/container.ts';

test('an imported project can be permanently deleted with its media',{skip:!mediaToolsAvailable&&'ffmpeg unavailable'},async t=>{
 const root=tempRoot('package-delete'),work=mkdtempSync(path.join(tmpdir(),'mioon-package-work-'));t.after(()=>cleanup(root,work));
 const ws=openWorkspace(root);t.after(()=>{if(ws.store.db.isOpen)ws.store.close();});
 const sample=await buildSampleProject(root,ws),file=path.join(work,'p.mioon');
 await exportTo(ws.store,sample.project.id,file);
 const staging=mkdtempSync(path.join(tmpdir(),'mioon-package-stage-'));t.after(()=>cleanup(staging));
 const read=await readProjectPackage({source:createReadStream(file),destination:staging});
 const {projectId}=createProjectFromDocument(ws.store,{document:read.document as any,files:new Map([...read.media].map(([k,v])=>[k,v.file])),name:'导入',move:true});
 const paths=(ws.store.list('assets',projectId) as any[]).map(asset=>path.join(root,asset.relativePath));
 const storage={readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile,validateManagedDirectory};
 const lifecycle=createProjectLifecycleServices(ws.store,{storage,ownsLock:()=>ownsStoreLock(ws.store),isReadOnly:()=>Boolean(getWorkspaceRestoreContext(ws.store)),assertIdle:()=>{},fault:()=>{}});
 lifecycle.setProjectDeletionCompanions({assertDeletable:()=>{},removeProject:()=>{}});
 await lifecycle.handlers['project.delete']({requestId:randomUUID(),projectId,expectedRevision:(ws.store.get('projects',projectId) as any).revision,confirmPermanentDeletion:true});
 assert.equal(ws.store.get('projects',projectId),null);
 for(const file of paths)assert.equal(existsSync(file),false,file);
 assert.ok(ws.store.get('projects',sample.project.id),'the source project is untouched');
});

async function rejects(bytes:Buffer,code:string){
 const staging=mkdtempSync(path.join(tmpdir(),'mioon-package-bad-'));
 try{await assert.rejects(readProjectPackage({source:Readable.from([bytes]),destination:staging}),{code});}
 finally{cleanup(staging);}
}
test('damaged, foreign and newer files are rejected with distinct codes',{skip:!mediaToolsAvailable&&'ffmpeg unavailable'},async t=>{
 const root=tempRoot('package-bad'),work=mkdtempSync(path.join(tmpdir(),'mioon-package-work-'));t.after(()=>cleanup(root,work));
 const ws=openWorkspace(root);t.after(()=>ws.store.close());
 const sample=await buildSampleProject(root,ws),file=path.join(work,'p.mioon');
 await exportTo(ws.store,sample.project.id,file);
 const good=readFileSync(file);
 await rejects(Buffer.from('PK\x03\x04 not a project'),'PROJECT_PACKAGE_NOT_MIOON');
 await rejects(good.subarray(0,good.length-200),'PROJECT_PACKAGE_CORRUPT');
 const flipped=Buffer.from(good);flipped[flipped.length-400]^=0xff;await rejects(flipped,'PROJECT_PACKAGE_CORRUPT');
 const size=good.readUInt32BE(PROJECT_PACKAGE_MAGIC.length),headerEnd=PROJECT_PACKAGE_MAGIC.length+4+size;
 const manifestSize=JSON.parse(good.subarray(PROJECT_PACKAGE_MAGIC.length+4,headerEnd).toString()).bytes;
 const manifest=JSON.parse(good.subarray(headerEnd,headerEnd+manifestSize).toString());
 const newer=Buffer.from(JSON.stringify({...manifest,formatVersion:2}));
 const head=Buffer.alloc(4),body=Buffer.from(JSON.stringify({path:'manifest.json',bytes:newer.length}));head.writeUInt32BE(body.length);
 await rejects(Buffer.concat([PROJECT_PACKAGE_MAGIC,head,body,newer]),'PROJECT_PACKAGE_NEWER_FORMAT');
});

import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
test('a workspace holding an imported project backs up, verifies and restores',{skip:!mediaToolsAvailable&&'ffmpeg unavailable'},async t=>{
 const root=tempRoot('package-backup'),work=mkdtempSync(path.join(tmpdir(),'mioon-package-work-'));t.after(()=>cleanup(root,work));
 const ws=openWorkspace(root),sample=await buildSampleProject(root,ws),file=path.join(work,'p.mioon');
 await exportTo(ws.store,sample.project.id,file);
 const staging=mkdtempSync(path.join(tmpdir(),'mioon-package-stage-'));t.after(()=>cleanup(staging));
 const read=await readProjectPackage({source:createReadStream(file),destination:staging});
 const {projectId}=createProjectFromDocument(ws.store,{document:read.document as any,files:new Map([...read.media].map(([k,v])=>[k,v.file])),name:'导入',move:true,receipt:{scope:'project-import',requestId:randomUUID(),requestHash:'b'.repeat(64)}});
 ws.store.close();
 const backup=path.join(work,'backup'),restored=path.join(work,'restored');
 const result=await createWorkspaceBackup({source:root,destination:backup});
 assert.equal(result.integrity,'verified');
 assert.equal(((await verifyWorkspaceBackup({directory:backup})) as any).integrity,'verified');
 await restoreWorkspaceBackup({directory:backup,destination:restored});
 const reopened=openWorkspace(restored);t.after(()=>reopened.store.close());
 assert.ok(reopened.store.get('projects',projectId));
});
