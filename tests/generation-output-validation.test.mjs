import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {startWorker} from '../packages/business/src/jobs.mjs';
import {run} from '../packages/business/src/media.mjs';

for(const [dimensions,expected] of [['128x128','cancelled'],['144x256','succeeded']])test(`decoded live output ${dimensions} validates actual ratio before version publication`,async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'wb-output-contract-')),store=openStore(root);
 let worker,submissions=0;
 t.after(async()=>{if(worker)await worker.stop();store.close();await rm(root,{recursive:true,force:true});});
 const fixture=path.join(root,'media/synthetic-fixture.mp4');
 await run('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',`color=c=blue:s=${dimensions}:r=24`,'-t','0.2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',fixture]);
 const provider={id:'ark',capabilities:{id:'ark',models:['fixture'],inputModes:['text'],aspectRatios:['9:16'],durations:[4],configured:true,enabled:true,mock:false},
  submit:async()=>{submissions++;return {providerJobId:'existing-offline-fixture-task'};},poll:async()=>({status:'succeeded'}),reconcile:async()=>null,
  download:async(id,destination)=>copyFile(fixture,destination)};
 const providers=new Map([['ark',provider]]),services=createServices(store,providers,{env:{ARK_MAX_GENERATIONS:'1'}});
 const project=await services.call('project.create',{name:'Offline output shape fixture'});
 const shot=await services.call('shot.create',{projectId:project.id,title:'Output shape',prompt:'A synthetic blue rectangle',duration:4});
 const job=await services.call('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,providerId:'ark',requestId:randomUUID()});
 worker=startWorker(store,services,providers);
 const deadline=Date.now()+5000;
 while(Date.now()<deadline&&!['cancelled','succeeded'].includes(store.get('jobs',job.id).status))await new Promise(resolve=>setTimeout(resolve,30));
 const completed=store.get('jobs',job.id);assert.equal(completed.status,expected);assert.equal(submissions,1);
 if(expected==='cancelled'){
  assert.equal(completed.phase,'output_review_required');assert.equal(completed.error.code,'OUTPUT_ASPECT_RATIO_MISMATCH');assert.equal(completed.error.retryable,false);
  assert.equal(store.list('versions').length,0);assert.equal(completed.providerJobId,'existing-offline-fixture-task');
  await assert.rejects(services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'UNSAFE_RETRY'});
 }else{assert.equal(store.list('versions').length,1);assert.ok(completed.versionId);}
});
