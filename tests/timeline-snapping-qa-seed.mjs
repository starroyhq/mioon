/** Copy-only synthetic fixture. Never opens or writes the original workspace. */
import path from 'node:path';
import {mkdir,writeFile,access} from 'node:fs/promises';
import {migrateData} from '../apps/desktop/scripts/migrate-data.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {randomUUID} from 'node:crypto';
const runtime=path.resolve('evidence/timeline-snapping/runtime'),dataDir=path.join(runtime,'workspace');
await mkdir(runtime,{recursive:true});
let exists=false;try{await access(path.join(runtime,'fixture.json'));exists=true;}catch{}
if(!exists){
 try{await access(path.join(dataDir,'workbench.sqlite'));}catch{await migrateData(path.resolve('examples/multitrack-project'),dataDir);}
 const store=openStore(dataDir),s=createServices(store,new Map(),{env:{}});
 const project=(await s.call('project.list',{}))[0],projectId=project.id;
 let timeline=await s.call('timeline.get',{projectId});
 timeline=await s.call('timeline.track.add',{projectId,expectedRevision:timeline.revision,requestId:randomUUID(),kind:'video',name:'吸附练习 · 画面'});
 const targetTrack=timeline.tracks.at(-1);
 timeline=await s.call('timeline.track.add',{projectId,expectedRevision:timeline.revision,requestId:randomUUID(),kind:'audio',name:'吸附练习 · 音频'});
 const audioTrack=timeline.tracks.at(-1);
 const second=await s.call('project.create',{name:'吸附验收 · 独立项目'});
 const data=await s.call('project.get',{projectId});
 const unknown={...data.assets.find(a=>a.mimeType.startsWith('video/')),id:randomUUID(),name:'验收专用 · 时长未知',duration:null};store.put('assets',unknown);
 await writeFile(path.join(runtime,'fixture.json'),JSON.stringify({runtime,dataDir,project,second,targetTrack,audioTrack,timeline,unknownAssetId:unknown.id},null,2));
 store.close();
}
