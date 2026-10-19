/** Own-cloud disposable QA fixture. No production route or security override.
 * Real HTTP/SQLite services; exact-request faults affect only this local proxy.
 */
import http from 'node:http';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { startServer } from '../apps/server/src/index.ts';
import { migrateData } from '../apps/desktop/scripts/migrate-data.ts';
import { openStore } from '../packages/business/src/db.ts';
import { createServices } from '../packages/business/src/services.ts';
export const qaRoot=path.resolve('evidence/workspace-preferences');
function assertDisposable(workspace){if(!workspace.startsWith(qaRoot+path.sep))throw Error('QA workspace must be disposable');}
export async function prepareWorkspace(workspace,fixturePath){
 try{await access(fixturePath);return JSON.parse(await readFile(fixturePath,'utf8'));}catch{}
 assertDisposable(workspace);
 try{await access(path.join(workspace,'workbench.sqlite'));}catch{await migrateData(path.resolve('examples/multitrack-project'),workspace);}
 const store=openStore(workspace),s=createServices(store,new Map(),{env:{}});
 try{
  const project=(await s.call('project.list',{}))[0];
  const shot=await s.call('shot.create',{projectId:project.id,title:'持久视图 · 原生重启',prompt:'Synthetic local persistence acceptance only.',duration:2,aspectRatio:'9:16',position:{x:420,y:80}});
  const second=await s.call('project.create',{name:'独立项目 · 持久偏好',description:'Synthetic persistence QA only.'});
  const node=await s.call('node.create',{projectId:second.id,type:'text',label:'第二项目节点',text:'Independent view preferences',position:{x:50,y:70}});
  let data=await s.call('project.get',{projectId:project.id});
  while(data.timeline.tracks.length<6){await s.call('timeline.track.add',{projectId:project.id,expectedRevision:data.timeline.revision,requestId:randomUUID(),kind:'video',name:'QA scroll track '+data.timeline.tracks.length});data=await s.call('project.get',{projectId:project.id});}
  const fixture={workspace,project,second,secondNode:node,shot,clip:data.timeline.clips[0],asset:data.assets.find(a=>a.id===data.timeline.clips[0].assetId)};
  await writeFile(fixturePath,JSON.stringify(fixture,null,2));return fixture;
 }finally{store.close();}
}
if(process.argv.includes('--serve')){
 const runtime=path.join(qaRoot,'browser-runtime');await mkdir(runtime,{recursive:true});
 const fixture=await prepareWorkspace(path.join(runtime,'workspace'),path.join(runtime,'fixture.json'));
 let token;try{token=(await readFile(path.join(runtime,'token'),'utf8')).trim();}catch{token=randomBytes(32).toString('hex');await writeFile(path.join(runtime,'token'),token,{mode:0o600});}
 const backend=await startServer({dataDir:fixture.workspace,port:0,token,distDir:path.resolve('apps/web/dist')});
 const port=4876,host='127.0.0.1:'+port,origin='http://'+host;
 let closing=false,seq=0;
 const server=http.createServer(async(req,res)=>{
  if(req.headers.host!==host||(req.headers.origin&&req.headers.origin!==origin))return res.writeHead(403).end();
  const parsed=new URL(req.url,origin);
  if(parsed.pathname==='/qa-storage')return res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; script-src 'self'"}).end('<!doctype html><title>Mioon local storage QA fixture</title><h1>Synthetic migration fixture</h1><button id="seed">Seed historical browser state</button><button id="audit">Audit migrated browser state</button><a id="open">Open production Mioon</a><pre id="result" data-testid="storage-audit"></pre><script src="/qa-storage-script.js"></script>');
  if(parsed.pathname==='/qa-storage-script.js'){
   const config=JSON.parse(await readFile(path.join(runtime,'storage-seed.json'),'utf8'));
   const script=`const config=${JSON.stringify(config)};const old='frame.workspace.v1:'+config.projectId,current='mioon.workspace.v1:'+config.projectId,oldPending='frame.pending.v1:'+config.projectId+':'+config.pending.key,newPending='mioon.pending.v1:'+config.projectId+':'+config.pending.key;document.querySelector('#open').href='/?project='+config.projectId;document.querySelector('#seed').onclick=()=>{localStorage.removeItem('mioon.project');localStorage.setItem('frame.project',config.projectId);localStorage.setItem(old,JSON.stringify(config.state));sessionStorage.setItem(oldPending,config.pendingRaw);document.querySelector('#result').textContent='Seeded synthetic historical keys';};document.querySelector('#audit').onclick=()=>{document.querySelector('#result').textContent=JSON.stringify({oldProject:localStorage.getItem('frame.project'),newProject:localStorage.getItem('mioon.project'),oldWorkspace:localStorage.getItem(old),newWorkspace:localStorage.getItem(current),oldPending:sessionStorage.getItem(oldPending),newPending:sessionStorage.getItem(newPending)},null,2);};`;
   return res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'}).end(script);
  }
  if(parsed.pathname==='/qa-denied-storage.js')return res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'}).end("Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new DOMException('Injected synthetic storage denial','SecurityError')}});");
  const chunks=[];for await(const part of req)chunks.push(part);const bytes=Buffer.concat(chunks);
  let operation;try{operation=JSON.parse(bytes).operation;}catch{}
  let fault;try{const candidate=JSON.parse(await readFile(path.join(runtime,'fault.json'),'utf8'));if((!candidate.method||candidate.method===req.method)&&(!candidate.pathname||candidate.pathname===req.url)&&(!candidate.operation||candidate.operation===operation)){fault=candidate;await unlink(path.join(runtime,'fault.json'));}}catch{}
  const observed=async(details)=>{await writeFile(path.join(runtime,'fault-observed.json'),JSON.stringify({seq:++seq,method:req.method,path:req.url,operation,...details}));};
  if(fault?.kind==='reject'){await observed({status:503,kind:'reject'});return res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({ok:false,error:{code:'QA_UNAVAILABLE',message:'Synthetic temporary preferences outage'}}));}
  const headers={...req.headers,host:new URL(backend.url).host};if(headers.origin)headers.origin=backend.url;
  const upstream=http.request(backend.url+req.url,{method:req.method,headers},async response=>{
   if(parsed.pathname==='/'&&parsed.searchParams.get('qaStorageDenied')==='1'){
    const parts=[];for await(const part of response)parts.push(part);const html=Buffer.concat(parts).toString('utf8').replace('<head>','<head><script src="/qa-denied-storage.js"></script>');const responseHeaders={...response.headers};delete responseHeaders['content-length'];return res.writeHead(response.statusCode,responseHeaders).end(html);
   }
   if(fault){const parts=[];for await(const part of response)parts.push(part);const data=Buffer.concat(parts);await observed({kind:fault.kind,status:response.statusCode});
    if(fault.kind==='drop')return res.writeHead(response.statusCode,{'content-type':'application/json','content-length':1}).end(data.subarray(0,1));
    if(fault.kind==='hold')while(!closing){try{await access(path.join(runtime,'fault-release'));await unlink(path.join(runtime,'fault-release'));break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
    res.writeHead(response.statusCode,response.headers);res.end(data);return;
   }res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});upstream.end(bytes);
 });
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 await writeFile(path.join(runtime,'server.json'),JSON.stringify({url:origin,pid:process.pid,backendPid:process.pid,workspace:fixture.workspace}));
 console.log('PREFERENCES_QA_READY '+origin);
 const close=async()=>{if(closing)return;closing=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await backend.close();};process.on('SIGTERM',close);process.on('SIGINT',close);
}
