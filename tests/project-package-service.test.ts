import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadStream,unlinkSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import path from 'node:path';
import {readProjectState,changeMarks} from './helpers/project-state.ts';
import {createProjectPackageService} from '../packages/business/src/project-package/service.ts';
import {buildSampleProject,openWorkspace,tempRoot,cleanup,mediaToolsAvailable} from './helpers/project-package-fixture.ts';

async function settle(service:any,id:string){for(let i=0;i<200;i++){const status=service.status(id);if(status.phase!=='running')return status;await pause(20);}throw new Error('export did not finish');}

test('private container export and staging stay intact while current project import and duplicate reject atomically',{skip:!mediaToolsAvailable&&'ffmpeg unavailable'},async t=>{
 const root=tempRoot('package-service');t.after(()=>cleanup(root));
 const ws=openWorkspace(root);t.after(()=>ws.store.close());
 const sample=await buildSampleProject(root,ws);
 const jobs:string[]=[];
 const service=createProjectPackageService({store:ws.store,appVersion:'0.4.1',afterCreate:async result=>{jobs.push(...result.jobIds);}});
 service.clearStale();
 const preview=service.preview(sample.project.id,{media:'used',includeExports:false});
 assert.equal(preview.assets.total,5);assert.ok(preview.assets.used<=5);assert.deepEqual(preview.missing,[]);
 const started=service.startExport(sample.project.id,{media:'all',includeExports:false});
 assert.throws(()=>service.startExport(sample.project.id,{media:'all',includeExports:false}),{code:'PROJECT_PACKAGE_BUSY'});
 const done=await settle(service,started.id);
 assert.equal(done.phase,'ready');assert.equal(done.fileName,'UI 走查项目.mioon');assert.equal(done.files,done.totalFiles);
 const {file}=service.exportFile(started.id);
 assert.equal(service.takeOpened(),null);
 const opened=await service.stageImport(createReadStream(file),undefined,{opened:true});
 const taken=service.takeOpened();
 assert.equal(taken?.id,opened.id);assert.equal(taken?.suggestedName,'UI 走查项目（2）');
 assert.equal(service.takeOpened(),null,'an opened file is handed out once');
 service.discardImport(opened.id);
 const staged=await service.stageImport(createReadStream(file));
 assert.equal(service.takeOpened(),null,'in-app uploads are never handed to other windows');
 assert.equal(staged.nameTaken,true);assert.equal(staged.suggestedName,'UI 走查项目（2）');assert.equal(staged.counts.versions,1);
 const requestId=randomUUID();
 const before={state:readProjectState(ws.store.db),marks:changeMarks(ws.store.db)};
 const unavailable={name:'TypeError',message:'Legacy project package imports cannot run on project databases.'};
 await assert.rejects(service.commitImport(staged.id,{requestId,name:staged.suggestedName}),unavailable);
 await assert.rejects(service.commitImport(staged.id,{requestId,name:staged.suggestedName}),unavailable);
 assert.equal(jobs.length,0);
 await service.discardExport(started.id);assert.equal(existsSync(file),false);
 await assert.rejects(service.duplicate(sample.project.id,{requestId:randomUUID(),name:'Unavailable copy'}),unavailable);
 assert.equal(ws.store.list('projects').length,1);
 assert.deepEqual({state:readProjectState(ws.store.db),marks:changeMarks(ws.store.db)},before);
 service.discardImport(staged.id);
 // Successful import/duplicate receipts and post-create jobs move to V4.

});

test('missing media block the export and are listed',{skip:!mediaToolsAvailable&&'ffmpeg unavailable'},async t=>{
 const root=tempRoot('package-missing');t.after(()=>cleanup(root));
 const ws=openWorkspace(root);t.after(()=>ws.store.close());
 const sample=await buildSampleProject(root,ws);
 unlinkSync(path.join(root,sample.assets.music.relativePath));
 const service=createProjectPackageService({store:ws.store,appVersion:'0.4.1'});
 assert.deepEqual(service.preview(sample.project.id,{media:'all',includeExports:false}).missing,[{assetId:sample.assets.music.id,name:'music.wav',reason:'missing'}]);
 assert.throws(()=>service.startExport(sample.project.id,{media:'all',includeExports:false}),{code:'PROJECT_PACKAGE_SOURCE_MISSING'});
});
