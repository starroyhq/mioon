import {parseProjectApiPath} from '../packages/contracts/src/project-file.ts';
/** Disposable UI fixture. Only copied synthetic media and existing shared RPCs.
 * Faults live in a loopback proxy, never in production code or renderer hooks. */
import http from 'node:http';
import path from 'node:path';
import {mkdir, readFile, writeFile, appendFile, unlink, readdir, access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startServer} from './helpers/test-server.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {openServerProject} from './helpers/project-database.ts';
import {createQaProject, closeQaProject, auditQaDatabases, hashQaSnapshot} from './helpers/kernel-qa-fixture.mjs';

export const mutationQaRoot = path.resolve('evidence/mutation-replay');
export const mutationRuntime = path.join(mutationQaRoot, 'browser-runtime');
export const mutationQaToken = 'mutation-replay-synthetic-local-token';
export async function prepareMutationQaFixture(directory = mutationRuntime) {
  await mkdir(directory, {recursive:true});
  const file = path.join(directory,'fixture.json'), workspace = path.resolve(directory,'data');
  try {
    const cached=JSON.parse(await readFile(file,'utf8'));
    if(cached.kernel!==true||cached.synthetic!==true||cached.workspace!==workspace)throw Error('Historical QA fixture must be preserved; choose a fresh kernel fixture directory');
    return cached;
  } catch(error) {if(error.code!=='ENOENT')throw error;}
  const primary=await createQaProject(workspace,{name:'Mutation QA · synthetic primary project'}),{store,services,project}=primary;
  let fixture;
  try {
    const shot = await services.call('shot.create',{projectId:project.id,title:'Replay QA · original shot',prompt:'Synthetic original saved prompt',duration:2});
    const secondShot = await services.call('shot.create',{projectId:project.id,title:'Replay QA · second shot',duration:2});
    const asset = store.list('assets',project.id).find(value=>value.mimeType==='video/mp4');
    if(!asset)throw Error('Synthetic copied video fixture missing');
    const jobId=randomUUID(),versionId=randomUUID(),at=new Date().toISOString();
    store.tx(()=>{
      store.put('jobs',{id:jobId,projectId:project.id,shotId:shot.id,requestId:randomUUID(),providerId:'mock',model:'fixture-existing-video',status:'succeeded',phase:'complete',progress:100,revision:1,submissionCount:0,versionId,createdAt:at,updatedAt:at,snapshot:{shotId:shot.id,shotRevision:shot.revision,title:shot.title,prompt:shot.prompt,referenceAssetIds:[],duration:2,aspectRatio:'9:16'}});
      store.put('versions',{id:versionId,projectId:project.id,jobId,shotId:shot.id,assetId:asset.id,number:1,providerId:'mock',model:'fixture-existing-video',isMock:true,sha256:asset.sha256,url:asset.url,createdAt:at});
    });
    fixture={workspace,project,shot,secondShot,versionId,synthetic:true,kernel:true};
  } finally {await closeQaProject(primary);}
  const second=await createQaProject(workspace,{name:'Mutation QA · independent empty project',media:false});
  try{fixture.secondProject=second.project;}finally{await closeQaProject(second);}
  await writeFile(file,JSON.stringify(fixture,null,2));return fixture;
}
export async function mutationQaAudit(workspace,{inspectProject,inspectApplication}={}) {
  if(Boolean(inspectProject)!==Boolean(inspectApplication))throw Error('Live QA audit requires both trusted project and application inspectors');
  const projects={};let application,ids;
  if(inspectApplication){
    application=inspectApplication(auditQaDatabases);
    ids=application.databases.main.rows.recent_projects.map(row=>row.projectId).sort();
    for(const id of ids)projects[id]=await inspectProject(id,auditQaDatabases);
    application=inspectApplication(auditQaDatabases);
  }else{
    // Cold-only: these real openers reject an already-held app/project. Never
    // open a raw SQLite reader beside a native backend's live connection.
    const library=openAppLibrary({dataDir:workspace});
    try{ids=library.registry.list().map(row=>row.projectId).sort();application=auditQaDatabases(library.db);}finally{library.close();}
    for(const id of ids){const store=openServerProject(workspace,id);try{projects[id]=auditQaDatabases(store.db);}finally{store.close();}}
  }
  // Preserve the old read-only data projection for graphical consumers, with
  // every real host included. Full schemas/rows/changeMarks remain alongside it.
  const data={};
  for(const snapshot of Object.values(projects))for(const database of Object.values(snapshot.databases))for(const [table,rows] of Object.entries(database.rows)){
    (data[table]??=[]).push(...rows);
  }
  return {at:new Date().toISOString(),data,projects,application,hash:hashQaSnapshot({projects,application})};
}
const invokedDirectly=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(invokedDirectly&&process.argv.includes('--prepare'))console.log(JSON.stringify(await prepareMutationQaFixture(process.argv.includes('--native')?path.join(mutationQaRoot,'native-runtime'):mutationRuntime),null,2));
if(invokedDirectly&&process.argv.includes('--serve')) {
  const fixture=await prepareMutationQaFixture();
  let inspectProject,inspectApplication;
  const startBackend=()=>startServer({dataDir:fixture.workspace,port:0,token:mutationQaToken,distDir:path.resolve('apps/web/dist'),inspectProject:value=>{inspectProject=value;},inspectApplication:value=>{inspectApplication=value;}});
  let backend=await startBackend(),closing=false,seq=0;
  const port=4894,host=`127.0.0.1:${port}`,origin=`http://${host}`;
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.headers.host!==host||req.headers.origin&&req.headers.origin!==origin)return res.writeHead(403).end();
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1024*1024)return res.writeHead(413).end();chunks.push(chunk);}
      const bytes=Buffer.concat(chunks);let input;try{input=JSON.parse(bytes);}catch{}
      const rpc=req.url==='/api/rpc'||parseProjectApiPath(req.url)?.kind==='rpc';
      // Agent reads can carry query parameters; classify their pathname and
      // retain the complete original request URL in the observation below.
      const scoped=parseProjectApiPath(new URL(req.url,origin).pathname);
      const projectAgent=scoped?.kind==='other'&&scoped.segments[0]==='agent';
      const event={seq:++seq,at:new Date().toISOString(),method:req.method,path:req.url,...(rpc?{operation:input?.operation,input:input?.input}:{})};
      if(rpc||projectAgent||req.url.startsWith('/api/agent/'))await appendFile(path.join(mutationRuntime,'requests.jsonl'),JSON.stringify(event)+'\n');
      let fault;try{const candidate=JSON.parse(await readFile(path.join(mutationRuntime,'fault.json'),'utf8'));if(req.method==='POST'&&rpc&&candidate.operation===input?.operation&&['drop','hold','malformed'].includes(candidate.kind)){fault=candidate;await unlink(path.join(mutationRuntime,'fault.json'));}}catch{}
      const headers={...req.headers,host:new URL(backend.url).host};if(headers.origin)headers.origin=backend.url;
      const upstream=http.request(backend.url+req.url,{method:req.method,headers},async response=>{
        if(!fault){res.writeHead(response.statusCode,response.headers);response.pipe(res);return;}
        const parts=[];for await(const part of response)parts.push(part);const output=Buffer.concat(parts);let result;try{result=JSON.parse(output);}catch{}
        await writeFile(path.join(mutationRuntime,'fault-observed.json'),JSON.stringify({...event,kind:fault.kind,status:response.statusCode,result}));
        if(fault.kind==='drop')return res.writeHead(response.statusCode,{'content-type':'application/json'}).end('{');
        if(fault.kind==='malformed')return res.writeHead(200,{'content-type':'application/json'}).end('{"ok":true}');
        const deadline=Date.now()+30000;
        while(!closing&&!res.destroyed&&Date.now()<deadline){try{await access(path.join(mutationRuntime,'release'));await unlink(path.join(mutationRuntime,'release'));break;}catch{await new Promise(resolve=>setTimeout(resolve,40));}}
        if(!res.destroyed){res.writeHead(response.statusCode,response.headers);res.end(output);}
      });
      res.on('close',()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});upstream.end(bytes);
    } catch {if(!res.headersSent)res.writeHead(500);res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const descriptor=()=>writeFile(path.join(mutationRuntime,'server.json'),JSON.stringify({url:origin,pid:process.pid,workspace:fixture.workspace,synthetic:true}));await descriptor();
  const box=path.join(mutationQaRoot,'api-mailbox');await mkdir(box,{recursive:true});let busy=false;
  const timer=setInterval(async()=>{if(busy||closing)return;busy=true;try{for(const name of(await readdir(box)).filter(name=>name.endsWith('.request.json'))){const file=path.join(box,name),item=JSON.parse(await readFile(file,'utf8'));await unlink(file);let result;try{
    if(item.action==='audit')result=await mutationQaAudit(fixture.workspace,{inspectProject,inspectApplication});
    else if(item.action==='restart'){await backend.close();inspectProject=undefined;inspectApplication=undefined;backend=await startBackend();await descriptor();result={restarted:true};}
    else throw Error('Unknown bounded QA action');
  }catch(error){result={probeError:error.message};}await writeFile(path.join(box,name.replace('.request.json','.result.json')),JSON.stringify(result));}}finally{busy=false;}},40);timer.unref();
  console.log(`MUTATION_SYNTHETIC_QA_READY ${origin}`);
  const close=async()=>{if(closing)return;closing=true;clearInterval(timer);await backend.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(mutationRuntime,'exit.json'),JSON.stringify({at:new Date().toISOString(),closed:true}));};process.on('SIGTERM',close);process.on('SIGINT',close);
}
