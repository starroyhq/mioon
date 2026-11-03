import {mediaFixturePath, mp4HeaderFixture} from './helpers/media-reference-fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFile,readFile,mkdtemp,rm,readdir,unlink} from 'node:fs/promises';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {selectedRangeFixture} from './fixtures/selected-range-http-fixture.ts';
import {registerExportActivity,exportStage} from '../packages/business/src/export-controls.ts';
import type { Store as WorkspaceStore } from '../packages/business/src/store-contract.ts';
import type {OrdinaryServices} from '../packages/business/src/services.ts';
import {exportActivitySchema,exportOutputSchema} from '../packages/contracts/src/export-controls.ts';
import {publicValue} from '@mioon/contracts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {run} from '../packages/business/src/media.ts';
import {isProjectStore} from '../packages/business/src/project-file/store.ts';
import {publishProjectOutput} from '../packages/business/src/project-output-publication.ts';
import {exportOutputArtifactIdentity} from '../packages/contracts/src/output-artifact.ts';
interface Fixture {project:{id:string};timeline:{revision:number};root:string;store:WorkspaceStore;services:OrdinaryServices;restart():Promise<void>}
interface ExportRecord extends Record<string,unknown>{id:string;requestId:string;snapshot:unknown}
const fixture=async(t:Parameters<typeof selectedRangeFixture>[0]):Promise<Fixture>=>await selectedRangeFixture(t) as unknown as Fixture;
const object=(value:unknown)=>value as Record<string,unknown>;
async function queued(f:Fixture){const accepted=object(await f.services.call('timeline.render',{projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),purpose:'export'}));return object(f.store.get('exports',String(accepted.id))) as ExportRecord;}
test('queued cancellation preserves frozen receipt and sources, survives restart and never requeues',async t=>{
  const f=await fixture(t),record=await queued(f),identity={projectId:f.project.id,exportId:record.id};
  const sources=f.store.list('assets'),receipt=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(String(record.requestId));
  const cancelled=object(await f.services.call('export.cancel',identity));assert.equal(cancelled.status,'failed');assert.equal(object(cancelled.error).code,'EXPORT_CANCELLED');assert.deepEqual(object(f.store.get('exports',String(record.id))).snapshot,record.snapshot);
  assert.deepEqual(f.store.list('assets'),sources);assert.deepEqual(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(String(record.requestId)),receipt);
  assert.deepEqual(await f.services.call('export.cancel',identity),cancelled);await f.restart();assert.deepEqual(await f.services.call('export.cancel',identity),cancelled);
  const activity=exportActivitySchema.parse(await f.services.call('export.activity.get',identity));assert.equal(activity.stage,'cancelled');assert.equal(activity.cancelled,true);
});
test('running cancellation aborts only its owned operation and terminal publication wins atomically',async t=>{
  const f=await fixture(t),one=await queued(f),two=await queued(f);let first=0,second=0;
  f.store.put('exports',{...one,status:'running'});f.store.put('exports',{...two,status:'running'});
  const a=registerExportActivity(f.store,String(one.id),()=>first++),b=registerExportActivity(f.store,String(two.id),()=>second++);t.after(()=>{a.close();b.close();});
  exportStage(f.store,String(one.id),'encoding');const input={projectId:f.project.id,exportId:one.id};
  assert.equal(exportActivitySchema.parse(await f.services.call('export.activity.get',input)).stage,'encoding');await f.services.call('export.cancel',input);assert.equal(first,1);assert.equal(second,0);assert.equal(object(f.store.get('exports',String(two.id))).status,'running');
  const done={...two,status:'succeeded',assetId:randomUUID(),url:'/media/synthetic',error:null};f.store.put('exports',done);
  // A malformed terminal record must be rejected, never repaired by cancellation.
  await assert.rejects(f.services.call('export.cancel',{projectId:f.project.id,exportId:two.id}),{code:'INVALID_TIMELINE_SNAPSHOT'});assert.equal(second,0);
  await assert.rejects(f.services.call('export.cancel',{projectId:randomUUID(),exportId:one.id}),{code:'NOT_FOUND'});
});
test('output location is bound to the accepted export and rejects changed bytes, foreign owners and injected paths',async t=>{
  const f=await fixture(t),record=await queued(f),assetId=randomUUID();assert.ok(isProjectStore(f.store));
  const bytes=mp4HeaderFixture('Owned synthetic output bytes; file validation is independent of media decoding');
  const sha256=createHash('sha256').update(bytes).digest('hex'),stageFile=path.join(f.store.tempDir,`${assetId}.mp4`);await writeFile(stageFile,bytes,{mode:0o600,flag:'wx'});
  const published=await publishProjectOutput(f.store,{owner:{kind:'export',id:record.id,requestId:record.requestId,inputHash:createHash('sha256').update(exportOutputArtifactIdentity(record)).digest('hex')},assetId,targetKind:'exports',stageFile,mimeType:'video/mp4',sha256,sizeBytes:bytes.length});
  const {relativePath,...locator}=published,asset={id:assetId,projectId:f.project.id,name:'Owned output.mp4',mimeType:'video/mp4',...locator,width:1080,height:1920,duration:10,hasVideo:true,hasAudio:true,provenance:'export',producer:{kind:'export',id:record.id},createdAt:new Date().toISOString(),url:`/media/${assetId}`};
  f.store.put('assets',asset);f.store.put('exports',{...record,status:'succeeded',assetId,url:asset.url,error:null});
  const identity={projectId:f.project.id,exportId:record.id},output=exportOutputSchema.parse(await f.services.call('export.output.get',identity));assert.equal(output.fileLocation,path.join(f.root,relativePath));assert.equal(output.sha256,asset.sha256);assert.equal(output.sizeBytes,bytes.length);const {relativePath:publishedPath,...proof}=asset.publication;assert.deepEqual(output.publication,{...proof,projectRelativePath:publishedPath});
  await assert.rejects(f.services.call('export.output.get',{...identity,path:'/tmp/foreign.mp4'}));await assert.rejects(f.services.call('export.output.get',{...identity,projectId:randomUUID()}),{code:'NOT_FOUND'});
  for(const patch of [{publication:undefined},{publication:{...asset.publication,owner:{...asset.publication.owner,id:randomUUID()}}},{reference:{...asset.reference,path:`../${path.basename(relativePath)}`}}]){
   f.store.put('assets',{...asset,...patch});await assert.rejects(f.services.call('export.output.get',identity),{code:'EXPORT_FILE_UNAVAILABLE'});
  }f.store.put('assets',asset);
  const changed=Buffer.from(bytes);changed[changed.length-1]^=1;await writeFile(output.fileLocation,changed);await assert.rejects(f.services.call('export.output.get',identity),{code:'MEDIA_CHANGED'});
  const before=f.store.get('exports',String(record.id));assert.equal(object(await f.services.call('export.cancel',identity)).status,object(before).status);
});

test('real project worker retains published files after cancellation and never deletes replacements', {timeout:120_000}, async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'mioon-export-cancel-worker-')),source=path.join(base,'source.mp4');
  t.after(()=>rm(base,{recursive:true,force:true}));
  await run('ffmpeg',['-hide_banner','-loglevel','error','-n','-f','lavfi','-i','color=c=blue:s=1080x1920:r=30:d=0.2','-an','-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p',source],{timeout:30_000});
  const bytes=await readFile(source);
  for(const mode of ['cancel','replace-output','replace-part','published'] as const)await t.test(mode,async child=>{
    const root=path.join(base,mode),store=openStore(root),services=createServices(store,new Map(),{env:{MIOON_ENABLE_LIVE_PROVIDER:'0'}});
    let worker:ReturnType<typeof startWorker>|undefined,linkedFile='',linkedPart='',reached=false;
    const originalLink=fs.promises.link,replacement=Buffer.from('Foreign replacement must be retained');
    try{
      const project=object(await services.call('project.create',{name:'Local cancellation fixture'})),projectId=String(project.id);
      const asset=object(await services.call('asset.import',{projectId,name:'source.mp4',mimeType:'video/mp4',dataBase64:bytes.toString('base64')}));
      let timeline=object(await services.call('timeline.get',{projectId}));
      const track=(timeline.tracks as {id:string}[])[0];
      timeline=object(await services.call('timeline.clip.add',{projectId,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:track.id,startFrame:0,durationFrames:6}));
      const accepted=object(await services.call('timeline.render',{projectId,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export'})),exportId=String(accepted.id);
      const receipt=store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(String(accepted.requestId));
      child.mock.method(fs.promises,'link',async(...args:Parameters<typeof originalLink>)=>{
        await originalLink(...args);if(path.dirname(String(args[1]))!==path.join(root,'导出'))return;
        reached=true;linkedFile=String(args[1]);linkedPart=String(args[0]);
        if(mode==='replace-output'){await unlink(linkedFile);await writeFile(linkedFile,replacement,{flag:'wx',mode:0o600});}
        if(mode==='replace-part'){await unlink(linkedPart);await writeFile(linkedPart,replacement,{flag:'wx',mode:0o600});}
        if(mode!=='published')await services.call('export.cancel',{projectId,exportId});
      });syncBuiltinESMExports();
      worker=startWorker(store,services,new Map());await worker.tick();await worker.stop();worker=undefined;
      assert.equal(reached,true,'the real worker reached non-overwriting publication');
      const final=object(store.get('exports',exportId)),files=await readdir(path.join(root,'导出'));
      assert.deepEqual(store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(String(accepted.requestId)),receipt,'immutable acceptance remains exact');
      const storedAsset=object(store.get('assets',String(asset.id)));
      assert.deepEqual(await readFile(mediaFixturePath(root,storedAsset)),bytes,'source media remains exact');
      if(mode==='published'){
        assert.equal(final.status,'succeeded');assert.deepEqual(await services.call('export.cancel',{projectId,exportId}),publicValue(final));assert.deepEqual(store.get('exports',exportId),final);assert.ok((await readFile(linkedFile)).length>0);
      }else{
        assert.equal(final.status,'failed');assert.equal(object(final.error).code,'EXPORT_CANCELLED');assert.equal(final.assetId,null);
        assert.equal(files.includes(path.basename(linkedFile)),true,'ordinary project outputs are retained after cancellation');
        if(mode==='replace-output')assert.deepEqual(await readFile(linkedFile),replacement);
        if(mode==='replace-part')assert.deepEqual(await readFile(linkedPart),replacement);
      }
    }finally{child.mock.restoreAll();syncBuiltinESMExports();await worker?.stop();await services.drain();store.close();}
  });
});
