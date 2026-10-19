/** Disposable own-cloud acceptance fixture. The production server, auth and CSP
 * remain unchanged; one exact synthetic request can be held/rejected/dropped. */
import http from 'node:http';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,appendFile,unlink,access,readdir} from 'node:fs/promises';
import {startServer} from '../apps/server/src/index.ts';
import {migrateData} from '../apps/desktop/scripts/migrate-data.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
export const qaRoot=path.resolve('evidence/dockable-panels');
export const runtime=path.join(qaRoot,'browser-runtime');
export async function prepareDockableFixture(){
 await mkdir(runtime,{recursive:true});const workspace=path.join(runtime,'workspace'),fixturePath=path.join(runtime,'fixture.json');
 try{return JSON.parse(await readFile(fixturePath,'utf8'));}catch{}
 await migrateData(path.resolve('examples/multitrack-project'),workspace);
 const store=openStore(workspace),s=createServices(store,new Map(),{env:{}});
 try{
  const project=(await s.call('project.list',{}))[0];
  const shot=await s.call('shot.create',{projectId:project.id,title:'固定面板 · 草稿保护',prompt:'Synthetic local dockable-panel QA only.',duration:2,aspectRatio:'9:16',position:{x:420,y:80}});
  const otherShot=await s.call('shot.create',{projectId:project.id,title:'第二镜头 · 切换保护',prompt:'Independent synthetic selection.',duration:2,aspectRatio:'9:16',position:{x:780,y:120}});
  const second=await s.call('project.create',{name:'独立项目 · 固定面板',description:'Synthetic panel isolation acceptance only.'});
  const node=await s.call('node.create',{projectId:second.id,type:'text',label:'第二项目节点',text:'Independent dock layout',position:{x:50,y:70}});
  let data=await s.call('project.get',{projectId:project.id});
  while(data.timeline.tracks.length<6){await s.call('timeline.track.add',{projectId:project.id,expectedRevision:data.timeline.revision,requestId:randomUUID(),kind:'video',name:'QA scroll track '+data.timeline.tracks.length});data=await s.call('project.get',{projectId:project.id});}
  const fixture={workspace,project,second,secondNode:node,shot,otherShot,clip:data.timeline.clips[0],audioClip:data.timeline.clips.find(c=>data.assets.find(a=>a.id===c.assetId)?.mimeType.startsWith('audio/')),otherClip:data.timeline.clips[1],asset:data.assets.find(a=>a.id===data.timeline.clips[0].assetId)};
  await writeFile(fixturePath,JSON.stringify(fixture,null,2));return fixture;
 }finally{store.close();}
}
if(process.argv.includes('--prepare')) console.log(JSON.stringify(await prepareDockableFixture(),null,2));
if(process.argv.includes('--serve')){
 process.env.MIOON_ENABLE_LIVE_PROVIDER='0';for(const key of Object.keys(process.env))if(/^(RUNWAY|RUNWAYML|ARK_|VEO_|GEMINI_|MINIMAX_|HAILUO_|VIDU_)/.test(key))delete process.env[key];
 const fixture=await prepareDockableFixture();
 // Synthetic QA-only credential, never a user credential or production token.
 const token='dockable-panels-local-synthetic-qa-token';await writeFile(path.join(runtime,'token'),token,{mode:0o600});
 const backend=await startServer({dataDir:fixture.workspace,port:0,token,distDir:path.resolve('apps/web/dist')});
 const port=4881,host='127.0.0.1:'+port,origin='http://'+host;let closing=false,seq=0;
 const server=http.createServer(async(req,res)=>{
  if(req.headers.host!==host||(req.headers.origin&&req.headers.origin!==origin))return res.writeHead(403).end();
  const chunks=[];for await(const part of req)chunks.push(part);const bytes=Buffer.concat(chunks);let operation,input;try{({operation,input}=JSON.parse(bytes));}catch{}
  const event={seq:++seq,at:new Date().toISOString(),method:req.method,path:req.url,operation};
  if(req.method==='PUT'&&req.url.startsWith('/api/workspace-preferences/')){event.body=JSON.parse(bytes);await appendFile(path.join(runtime,'preference-writes.jsonl'),JSON.stringify(event)+'\n');}
  let fault;try{const candidate=JSON.parse(await readFile(path.join(runtime,'fault.json'),'utf8'));if((!candidate.method||candidate.method===req.method)&&(!candidate.pathname||candidate.pathname===req.url)&&(!candidate.operation||candidate.operation===operation)){fault=candidate;await unlink(path.join(runtime,'fault.json'));}}catch{}
  const observed=details=>writeFile(path.join(runtime,'fault-observed.json'),JSON.stringify({...event,input,...details}));
  if(fault?.kind==='reject'){await observed({status:503,kind:'reject'});return res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({ok:false,error:{code:'QA_UNAVAILABLE',message:'Synthetic temporary outage'}}));}
  const headers={...req.headers,host:new URL(backend.url).host};if(headers.origin)headers.origin=backend.url;
  const upstream=http.request(backend.url+req.url,{method:req.method,headers},async response=>{
   if(fault){const parts=[];for await(const part of response)parts.push(part);const data=Buffer.concat(parts);await observed({kind:fault.kind,status:response.statusCode,body:JSON.parse(data)});
    if(fault.kind==='drop')return res.writeHead(response.statusCode,{'content-type':'application/json','content-length':1}).end(data.subarray(0,1));
    if(fault.kind==='hold')while(!closing){try{await access(path.join(runtime,'fault-release'));await unlink(path.join(runtime,'fault-release'));break;}catch{await new Promise(r=>setTimeout(r,50));}}
    res.writeHead(response.statusCode,response.headers);res.end(data);return;
   }res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});upstream.end(bytes);
 });
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));await writeFile(path.join(runtime,'server.json'),JSON.stringify({url:origin,pid:process.pid,workspace:fixture.workspace}));
 const inbox=path.join(qaRoot,'api-mailbox');await mkdir(inbox,{recursive:true});let probeBusy=false;
 const timer=setInterval(async()=>{if(probeBusy||closing)return;probeBusy=true;try{for(const file of(await readdir(inbox)).filter(n=>n.endsWith('.request.json'))){const pathname=path.join(inbox,file),req=JSON.parse(await readFile(pathname,'utf8'));await unlink(pathname);let result;
  try{if(!/^\/api\/(rpc|workspace-preferences\/[0-9a-f-]+)$/.test(req.pathname))throw Error('Out-of-scope QA route');if(req.pathname==='/api/rpc'&&!['project.get','timeline.history.get'].includes(JSON.parse(req.options.body).operation))throw Error('Only read-only domain verifier operations allowed');const response=await fetch(origin+req.pathname,{...req.options,headers:{authorization:'Bearer '+token,'content-type':'application/json'},signal:AbortSignal.timeout(12000)});result={status:response.status,...await response.json()};}catch(error){result={probeError:error.message};}await writeFile(path.join(inbox,file.replace('.request.json','.result.json')),JSON.stringify(result));
 }}finally{probeBusy=false;}},25);timer.unref();console.log('DOCKABLE_PANELS_QA_READY '+origin);
 const close=async()=>{if(closing)return;closing=true;clearInterval(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await backend.close();};process.on('SIGTERM',close);process.on('SIGINT',close);
}
