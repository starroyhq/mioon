import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const moduleUrl=(file:string):string=>new URL(file,import.meta.url).href;

test('image, frame and complete scene stages route directory sync through the Windows managed I/O backend (synthetic protocol)',{skip:process.platform==='win32'},()=>{
 // This isolated child tests dispatch with real stage bytes and a POSIX policy
 // standing in for native ACL checks. It is not Windows ACL/platform evidence.
 const script=`
 import assert from 'node:assert/strict';
 import path from 'node:path';
 import {mkdtempSync,mkdirSync,realpathSync,readFileSync,rmSync} from 'node:fs';
 import {tmpdir} from 'node:os';
 import {randomUUID,createHash} from 'node:crypto';
 import * as privateStorage from ${JSON.stringify(moduleUrl('../packages/contracts/src/private-storage.ts'))};
 import {createProjectFile,openProjectStore} from ${JSON.stringify(moduleUrl('../packages/business/src/project-file/index.ts'))};
 import {createImageStorage} from ${JSON.stringify(moduleUrl('../packages/business/src/image-storage.ts'))};
 import {createFrameStorage} from ${JSON.stringify(moduleUrl('../packages/business/src/frame-storage.ts'))};
 import {createSceneShotsStorage} from ${JSON.stringify(moduleUrl('../packages/business/src/scene-shots-storage.ts'))};
 import {validatePng} from ${JSON.stringify(moduleUrl('../packages/business/src/images/png.ts'))};
 import {png} from ${JSON.stringify(moduleUrl('./helpers/timeline-image-fixtures.ts'))};
 const platform=process.platform,policy=privateStorage.createPrivateStoragePolicy(),calls=[];
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-win-staging-stub-')),projectDir=path.join(root,'project'),tempDir=path.join(root,'tmp');
 mkdirSync(projectDir,{mode:0o700});const projectFile=path.join(projectDir,'project.mioon'),projectId=createProjectFile(projectFile);
 const store=openProjectStore({projectFile,locate:()=>({localDir:path.join(root,'records'),cacheDir:path.join(root,'cache'),tempDir})});
 // Capture the genuine current project capabilities before switching only the
 // platform dispatch seam. Native directory opens are deliberately not used.
 const image=createImageStorage(store,{validatePng}),frame=createFrameStorage(store,{validatePng}),scene=createSceneShotsStorage(store);
 const bytes=png({width:1024,height:1024,rgba:false,tagged:false}),check=()=>{};
 const imageTask={id:randomUUID(),projectId,groupId:randomUUID(),inputHash:'a'.repeat(64),input:'{}',snapshot:{providerId:'mock'}};
 const source={assetId:randomUUID(),sha256:'b'.repeat(64),mimeType:'video/mp4',sizeBytes:100,relativePath:'media/source.mp4',duration:1,width:1024,height:1024};
 const frameTask={id:randomUUID(),projectId,inputHash:'c'.repeat(64),snapshot:{source,requested:{sourceFrame:0,fps:30}}};
 const provenance={profileId:'local-png-1024-v1',selectionRule:'first-pts-at-or-after-v1',sourceFrame:0,fps:30,sourceHash:source.sha256,probe:{streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:1024,height:1024,rotation:0,sarNumerator:1,sarDenominator:1}};
 const sceneId=randomUUID(),sceneTask={id:sceneId,projectId,requestId:sceneId,inputHash:'d'.repeat(64),snapshot:{schemaVersion:1,projectId,taskId:sceneId,kind:'shots',source,resultId:randomUUID(),frameCount:30,frame:{profileId:provenance.profileId,selectionRule:provenance.selectionRule,fps:30},aspectRatio:'1:1',titlePrefix:'Scene',origin:{x:0,y:0},segments:[[1,0,30]]}};
 const receipt={schemaVersion:1,projectId,taskId:sceneId,inputHash:sceneTask.inputHash,sourceAssetId:source.assetId,sourceHash:source.sha256,profileId:provenance.profileId,selectionRule:provenance.selectionRule,fps:30,probe:provenance.probe,keyframes:[{segment:1,sourceFrame:15,assetId:randomUUID(),sha256:createHash('sha256').update(bytes).digest('hex'),width:1024,height:1024,byteLength:bytes.length}]};
 try{
  Object.defineProperty(process,'platform',{value:'win32'});
  privateStorage.registerWindowsPrivateStorageBackend({...policy,platform:'win32',apiVersion:1,managedFileIO:{syncDirectory:(directory,options)=>calls.push({directory,...options})}});
  await image.stage(imageTask,{bytes},check);await frame.stage(frameTask,{bytes,provenance},check);scene.stage(sceneId,0,bytes);scene.complete(sceneTask,receipt,check);
  for(const family of ['image-staging','frame-staging','scene-staging']){
   assert.equal(calls.filter(call=>call.directory===path.join(tempDir,family)).length,2,family+' stage and receipt directory sync');
  }
  assert.equal(calls.filter(call=>call.directory===tempDir).length,3,'new stage directory entries are synchronized');
  assert.equal(calls.length,9);for(const call of calls){assert.equal(call.root,tempDir);assert.equal(call.private,true);}
  for(const [family,name] of [['image-staging',imageTask.id+'.png'],['frame-staging',frameTask.id+'.png'],['scene-staging',sceneId+'-0.png']])assert.deepEqual(readFileSync(path.join(tempDir,family,name)),bytes);
  assert.deepEqual(scene.readReceipt(sceneTask),receipt);
 }finally{Object.defineProperty(process,'platform',{value:platform});store.close();rmSync(root,{recursive:true,force:true});}
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:30_000});
 assert.equal(child.status,0,child.stderr||child.stdout||String(child.error));
});
