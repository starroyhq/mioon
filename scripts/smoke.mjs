import {spawn} from 'node:child_process';import fs from 'node:fs';
const root=process.cwd(),token='workbench-development-token-2026',port=4320;
const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,PORT:String(port),MIOON_DATA_DIR:root+'/data-demo',MIOON_TOKEN:token},stdio:['ignore','pipe','pipe']});server.stdout.pipe(process.stdout);server.stderr.pipe(process.stderr);
const rpc=async(operation,input)=>{const r=await fetch(`http://127.0.0.1:${port}/api/rpc`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({operation,input})});const v=await r.json();if(!v.ok)throw Error(JSON.stringify(v));return v.data};
try{for(let i=0;i<50;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
const p=await rpc('project.create',{name:'Stanley × Maltese · 合成测试',description:'软件验收专用合成素材。非授权产品图，非 AI 广告成片。'});
const a=await rpc('asset.import',{projectId:p.id,name:'synthetic-reference.png',mimeType:'image/png',dataBase64:fs.readFileSync('examples/synthetic/reference.png').toString('base64')});
const s=await rpc('shot.create',{projectId:p.id,title:'01 追逐星星',prompt:'二维白色与浅棕小狗追逐星星。合成测试，仅用于软件验收。',referenceAssetIds:[a.id]});
const j=await rpc('generation.submit',{shotId:s.id,expectedRevision:s.revision,requestId:'first-smoke-'+Date.now(),providerId:'mock'});let job;for(let n=0;n<60;n++){await new Promise(r=>setTimeout(r,500));job=await rpc('job.get',{jobId:j.id});if(['succeeded','failed'].includes(job.status))break;}console.log(JSON.stringify({project:p.id,asset:a.id,shot:s.id,job},null,2));fs.writeFileSync('evidence/M1-smoke.json',JSON.stringify({project:p.id,asset:a.id,shot:s.id,job},null,2));if(job.status!=='succeeded')throw Error('Generation did not succeed');
}finally{server.kill('SIGTERM');await new Promise(r=>server.on('exit',r));}
