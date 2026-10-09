/** Verify a copied sample against this or a clean-installed checkout. */
import {spawn} from 'node:child_process';import {once} from 'node:events';import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import net from 'node:net';import {randomUUID,createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const original=fileURLToPath(new URL('..',import.meta.url)),repo=path.resolve(process.argv[2]||original),folder=await mkdtemp(path.join(tmpdir(),'workbench-v3-relocation-')),data=path.join(folder,'data');
await cp(path.join(repo,'examples/multitrack-project'),data,{recursive:true});
const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(r=>s.close(r));const base=`http://127.0.0.1:${port}`,token='relocation-local-'+randomUUID();
const backend=spawn(process.execPath,['server/index.mjs'],{cwd:repo,env:{...process.env,PORT:String(port),MIOON_DATA_DIR:data,MIOON_TOKEN:token,MIOON_ENABLE_LIVE_PROVIDER:'0',RUNWAYML_API_SECRET:'',RUNWAY_MAX_GENERATIONS:'0'},stdio:['ignore','pipe','pipe']});let log='';backend.stdout.on('data',b=>log+=b);backend.stderr.on('data',b=>log+=b);const pause=ms=>new Promise(r=>setTimeout(r,ms));
const rpc=async(operation,input={})=>{const r=await fetch(base+'/api/rpc',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({operation,input})});const b=await r.json();if(!b.ok)throw Error(JSON.stringify(b));return b.data;};
const bytes=async url=>{const r=await fetch(base+url,{headers:{authorization:`Bearer ${token}`}});if(!r.ok)throw Error('Media unavailable '+r.status);return Buffer.from(await r.arrayBuffer());};const sha=buf=>createHash('sha256').update(buf).digest('hex');
try{
 for(let i=0;i<100;i++){if(backend.exitCode!==null)throw Error(log);try{if((await fetch(base+'/health')).ok)break;}catch{}await pause(100);}
 const project=(await rpc('project.list')).find(p=>p.name.startsWith('多轨工作台'));if(!project)throw Error('Portable multitrack sample missing');
 const before=await rpc('project.get',{projectId:project.id}),timeline=before.timeline;if(timeline.clips.length!==5||timeline.durationFrames!==300)throw Error('Portable timeline changed');
 const previous=before.exports.find(e=>e.mode==='timeline'&&e.purpose==='export'&&e.status==='succeeded');const expected=sha(await bytes(previous.url));
 let render=await rpc('timeline.render',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export'});const deadline=Date.now()+90000;
 while(!['succeeded','failed'].includes(render.status)&&Date.now()<deadline){await pause(200);render=await rpc('export.get',{exportId:render.id});}
 if(render.status!=='succeeded')throw Error(JSON.stringify(render));const actual=sha(await bytes(render.url));if(actual!==expected)throw Error('Relocated render changed output bytes');
 const after=await rpc('timeline.get',{projectId:project.id});if(JSON.stringify(before.timeline)!==JSON.stringify(after))throw Error('Read/render changed timeline');
 const result={status:'PASS',repository:repo,projectId:project.id,timelineId:timeline.id,revision:timeline.revision,durationFrames:300,clipCount:5,oldOutputSha256:expected,newOutputSha256:actual,exactMediaParity:true,managedPathsResolvedAfterRelocation:true,sourceTimelineUnchanged:true};
 await mkdir(path.join(original,'evidence/v3-clean-install'),{recursive:true});await writeFile(path.join(original,'evidence/v3-clean-install/relocation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{if(backend.exitCode===null&&!backend.signalCode){const closed=once(backend,'exit');backend.kill('SIGTERM');await closed;}await rm(folder,{recursive:true,force:true});}
