/** Reproducible local-only v2 compositor sample. Starts and stops its own backend. */
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensurePrivateDirectory} from '@mioon/contracts/private-storage';
const root=fileURLToPath(new URL('..',import.meta.url));
const data=path.resolve(process.env.MIOON_V2_DEMO_DIR||path.join(root,'examples/multitrack-project'));
const evidence=path.join(root,'evidence/v2-demo');await mkdir(evidence,{recursive:true});ensurePrivateDirectory(data,{create:true});
const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const token='timeline-synthetic-demo-'+randomUUID(),base=`http://127.0.0.1:${port}`;
let output='';const server=spawn(process.execPath,['server/index.ts'],{cwd:root,env:{...process.env,PORT:String(port),MIOON_DATA_DIR:data,MIOON_TOKEN:token,MIOON_ENABLE_LIVE_PROVIDER:'0',RUNWAYML_API_SECRET:'',RUNWAY_MAX_GENERATIONS:'0'},stdio:['ignore','pipe','pipe']});
server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const rpc=async(operation,input={})=>{const r=await fetch(base+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation,input})});const b=await r.json();if(!b.ok)throw Error(`${operation}: ${JSON.stringify(b.error)}`);return b.data;};
try{
 for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Backend exited: '+output);try{if((await fetch(base+'/health')).ok)break;}catch{}await pause(100);}
 const name='多轨工作台｜叠层与声音 · 合成演示';let project=(await rpc('project.list')).find(x=>x.name===name);let timeline;let sources;
 if(!project){
  project=await rpc('project.create',{name,description:'原创几何测试素材。10秒时间线：两段主画面、中间1秒空隙、上层星形卡片画中画、独立音频。仅验收软件合成，不是真实AI生成广告。'});
  sources={};for(const [key,file,mimeType,title] of [['a','scene-a.mp4','video/mp4','01 First Light · 无声主画面'],['b','scene-b.mp4','video/mp4','02 After Hours · 含声音主画面'],['overlay','overlay-star.png','image/png','星形卡片 · 透明背景叠层'],['audio','sound-bed.wav','audio/wav','独立音频 · 合成音调']]){
   sources[key]=await rpc('asset.import',{projectId:project.id,name:title,mimeType,dataBase64:(await readFile(path.join(root,'examples/timeline-synthetic',file))).toString('base64')});
  }
  const notes=await rpc('node.create',{projectId:project.id,type:'text',label:'画布负责组织素材关系',text:'左侧拖入素材 → 在画布建立关系\n时间线决定何时播放、叠层和声音\n所有素材都是软件验收用的原创合成图形',position:{x:20,y:0}});
  const visualA=await rpc('node.create',{projectId:project.id,type:'video',assetId:sources.a.id,label:'主画面 A · 0–4 秒',position:{x:20,y:190}});
  const visualB=await rpc('node.create',{projectId:project.id,type:'video',assetId:sources.b.id,label:'主画面 B · 5–10 秒',position:{x:420,y:190}});
  const overlay=await rpc('node.create',{projectId:project.id,type:'image',assetId:sources.overlay.id,label:'上层画中画 · 2–7 秒',position:{x:420,y:-170}});
  await rpc('edge.create',{projectId:project.id,source:notes.id,target:visualA.id});await rpc('edge.create',{projectId:project.id,source:visualA.id,target:visualB.id});await rpc('edge.create',{projectId:project.id,source:overlay.id,target:visualB.id});
  timeline=await rpc('timeline.get',{projectId:project.id});
  const video=timeline.tracks.filter(t=>t.kind==='video').sort((a,b)=>a.orderIndex-b.orderIndex),audio=timeline.tracks.find(t=>t.kind==='audio');
  const add=async input=>{timeline=await rpc('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),...input});};
  await add({trackId:video[0].id,assetId:sources.a.id,name:'01 主画面 · 无声',startFrame:0,durationFrames:120,sourceInFrame:0});
  await add({trackId:video[0].id,assetId:sources.b.id,name:'02 主画面 · 原声',startFrame:150,durationFrames:150,sourceInFrame:0,gain:0.6});
  await add({trackId:video[1].id,assetId:sources.overlay.id,name:'星形卡片 · 画中画',startFrame:60,durationFrames:150,sourceInFrame:0,rect:{x:400,y:160,width:280,height:400}});
  await add({trackId:audio.id,assetId:sources.audio.id,name:'配乐 A',startFrame:0,durationFrames:120,sourceInFrame:0,gain:0.5});
  await add({trackId:audio.id,assetId:sources.audio.id,name:'配乐 B · 源内裁剪',startFrame:150,durationFrames:120,sourceInFrame:150,gain:0.5});
 }else{timeline=await rpc('timeline.get',{projectId:project.id});sources=(await rpc('project.get',{projectId:project.id})).assets;}
 const jobs=[];for(const purpose of ['preview','export']){
  let job=await rpc('timeline.render',{projectId:project.id,expectedRevision:timeline.revision,requestId:`v2-demo-${purpose}-${timeline.id}-r${timeline.revision}`,purpose});
  const end=Date.now()+180000;while(!['succeeded','failed'].includes(job.status)&&Date.now()<end){await pause(350);job=await rpc('export.get',{exportId:job.id});}
  if(job.status!=='succeeded')throw Error('Timeline render failed: '+JSON.stringify(job));jobs.push(job);
 }
 const state=await rpc('project.get',{projectId:project.id});
 await writeFile(path.join(evidence,'demo-project.json'),JSON.stringify({projectId:project.id,timelineId:timeline.id,timelineRevision:timeline.revision,durationFrames:timeline.durationFrames,dataDirectory:'examples/multitrack-project',sources,preview:jobs[0],export:jobs[1]},null,2));
 await writeFile(path.join(evidence,'project-state.json'),JSON.stringify(state,null,2));
 for(let i=0;i<jobs.length;i++){
  const response=await fetch(base+jobs[i].url,{headers:{authorization:`Bearer ${token}`}});if(!response.ok)throw Error('Render download failed');
  await writeFile(path.join(evidence,i===0?'timeline-preview.mp4':'timeline-export.mp4'),Buffer.from(await response.arrayBuffer()));
 }
 console.log(JSON.stringify({projectId:project.id,timelineRevision:timeline.revision,durationFrames:timeline.durationFrames,files:['evidence/v2-demo/timeline-preview.mp4','evidence/v2-demo/timeline-export.mp4']},null,2));
}finally{
 if(server.exitCode===null&&!server.signalCode){const closed=once(server,'exit');server.kill('SIGTERM');await closed;}
 await writeFile(path.join(evidence,'server.log'),output);
}
