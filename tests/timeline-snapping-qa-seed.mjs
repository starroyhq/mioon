/** Copy-only synthetic fixture. Never opens or writes the original workspace. */
import path from 'node:path';
import {mkdir,writeFile,access} from 'node:fs/promises';
import {createQaProject,closeQaProject,readQaFixture} from './helpers/kernel-qa-fixture.mjs';
import {randomUUID} from 'node:crypto';
const runtime=path.resolve('evidence/timeline-snapping/runtime'),dataDir=path.join(runtime,'data');
await mkdir(runtime,{recursive:true});
const exists=readQaFixture(path.join(runtime,'fixture.json'),dataDir)!==null;
if(!exists){
 const first=await createQaProject(dataDir,{name:'吸附验收 · 合成项目'}),{store,services:s,project}=first,projectId=project.id;let other;
 try{
 let timeline=await s.call('timeline.get',{projectId});
 timeline=await s.call('timeline.track.add',{projectId,expectedRevision:timeline.revision,requestId:randomUUID(),kind:'video',name:'吸附练习 · 画面'});
 const targetTrack=timeline.tracks.at(-1);
 timeline=await s.call('timeline.track.add',{projectId,expectedRevision:timeline.revision,requestId:randomUUID(),kind:'audio',name:'吸附练习 · 音频'});
 const audioTrack=timeline.tracks.at(-1);
 other=await createQaProject(dataDir,{name:'吸附验收 · 独立项目',media:false});const second=other.project;
 const data=await s.call('project.get',{projectId});
 const unknown={...data.assets.find(a=>a.mimeType.startsWith('video/')),id:randomUUID(),name:'验收专用 · 时长未知',duration:null};store.put('assets',unknown);
 await writeFile(path.join(runtime,'fixture.json'),JSON.stringify({kernel:true,workspace:dataDir,projectDir:store.projectDir,runtime,dataDir,project,second,targetTrack,audioTrack,timeline,unknownAssetId:unknown.id},null,2));
 }finally{if(other)await closeQaProject(other);await closeQaProject(first);}
}
