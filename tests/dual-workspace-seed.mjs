/** Seed only the copied synthetic workspace; no external network or paid calls. */
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const runtime = path.resolve(process.env.MIOON_QA_RUNTIME || 'evidence/dual-workspace/runtime');
if (!runtime.endsWith('/evidence/dual-workspace/runtime')) throw Error('Disposable dual-workspace runtime required');
const server = JSON.parse(await readFile(`${runtime}/server.json`, 'utf8'));
const rpc = async (operation,input={}) => { const response = await fetch(server.url+'/api/rpc',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer dualmode-local-synthetic-browser-token'},body:JSON.stringify({operation,input})}); const value=await response.json();if(!value.ok)throw Error(JSON.stringify(value));return value.data; };
const projects = await rpc('project.list');
const project = projects.find(p=>p.name.includes('多轨工作台'));
if(!project)throw Error('Copied synthetic multitrack fixture missing');
let data = await rpc('project.get',{projectId:project.id});
const image = data.assets.find(a=>a.mimeType==='image/png');
const shot = await rpc('shot.create',{projectId:project.id,title:'晨光 · 两个固定版本',prompt:'本地合成验收，山间晨光与星形构图。',duration:2,aspectRatio:'9:16',referenceAssetIds:[],position:{x:410,y:40}});
const referenceNode = await rpc('node.create',{projectId:project.id,type:'image',assetId:image.id,label:'星形首帧 · 固定来源',position:{x:50,y:40}});
const edge=await rpc('reference.attach',{projectId:project.id,sourceNodeId:referenceNode.id,targetShotId:shot.id,role:'first_frame',expectedSourceRevision:referenceNode.revision,expectedShotRevision:shot.revision,requestId:randomUUID()});
const versions=[];
for(let i=0;i<2;i++){
 data=await rpc('project.get',{projectId:project.id});const current=data.shots.find(s=>s.id===shot.id);
 const job=await rpc('generation.submit',{shotId:shot.id,expectedRevision:current.revision,providerId:'mock',requestId:randomUUID()});
 for(let j=0;j<150;j++){data=await rpc('project.get',{projectId:project.id});const result=data.jobs.find(item=>item.id===job.id);if(result.status==='succeeded'){versions.push(data.versions.find(v=>v.id===result.versionId));break;}if(result.status==='failed')throw Error(JSON.stringify(result));await new Promise(r=>setTimeout(r,200));}
 if(versions.length!==i+1)throw Error('Mock generation timeout');
}
data=await rpc('project.get',{projectId:project.id});
const current=data.shots.find(s=>s.id===shot.id);
await rpc('version.select',{shotId:shot.id,versionId:versions[1].id,expectedRevision:current.revision});
let timeline=data.timeline;
timeline=await rpc('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),trackId:timeline.tracks.find(t=>t.kind==='video'&&t.orderIndex===0).id,assetId:versions[0].assetId,name:'晨光 V1 · 固定片段',startFrame:330,durationFrames:60,sourceInFrame:0});
const second=await rpc('project.create',{name:'独立项目 · 视图不串联',description:'Synthetic per-project browser acceptance only.'});
const secondNode=await rpc('node.create',{projectId:second.id,type:'text',label:'第二项目',text:'独立画板状态',position:{x:60,y:70}});
const fixture={runtime,server:server.url,project,second,secondNode,shot,referenceNode,image,versions,clip:timeline.clips.find(c=>c.assetId===versions[0].assetId),edge};
await writeFile(`${runtime}/fixture.json`,JSON.stringify(fixture,null,2));
console.log(JSON.stringify({projectId:project.id,secondProjectId:second.id,versions:versions.map(v=>v.id)}));
