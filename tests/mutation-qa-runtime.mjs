/** Disposable UI fixture. Only copied synthetic media and existing shared RPCs.
 * Faults live in a loopback proxy, never in production code or renderer hooks. */
import http from 'node:http';
import path from 'node:path';
import {mkdir, readFile, writeFile, appendFile, unlink, readdir, access} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {migrateData} from '../apps/desktop/scripts/migrate-data.mjs';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {startServer} from '../apps/server/src/index.mjs';

export const mutationQaRoot = path.resolve('evidence/mutation-replay');
export const mutationRuntime = path.join(mutationQaRoot, 'browser-runtime');
export const mutationQaToken = 'mutation-replay-synthetic-local-token';
export async function prepareMutationQaFixture(directory = mutationRuntime) {
  await mkdir(directory, {recursive:true});
  const file = path.join(directory,'fixture.json'), workspace = path.join(directory,'workspace');
  try {return JSON.parse(await readFile(file,'utf8'));} catch(error) {if(error.code!=='ENOENT')throw error;}
  await migrateData(path.resolve('examples/multitrack-project'),workspace);
  const store = openStore(workspace);
  let fixture;
  try {
    const services = createServices(store,new Map()), project = store.list('projects')[0];
    const secondProject = await services.call('project.create',{name:'Mutation QA · independent empty project'});
    const shot = await services.call('shot.create',{projectId:project.id,title:'Replay QA · original shot',prompt:'Synthetic original saved prompt',duration:2});
    const secondShot = await services.call('shot.create',{projectId:project.id,title:'Replay QA · second shot',duration:2});
    const asset = store.list('assets',project.id).find(value=>value.mimeType==='video/mp4');
    if(!asset)throw Error('Synthetic copied video fixture missing');
    const jobId=randomUUID(),versionId=randomUUID(),at=new Date().toISOString();
    store.put('jobs',{id:jobId,projectId:project.id,shotId:shot.id,requestId:randomUUID(),providerId:'mock',model:'fixture-existing-video',status:'succeeded',phase:'complete',progress:100,revision:1,submissionCount:0,versionId,createdAt:at,updatedAt:at,snapshot:{shotId:shot.id,shotRevision:shot.revision,title:shot.title,prompt:shot.prompt,referenceAssetIds:[],duration:2,aspectRatio:'9:16'}});
    store.put('versions',{id:versionId,projectId:project.id,jobId,shotId:shot.id,assetId:asset.id,number:1,providerId:'mock',model:'fixture-existing-video',isMock:true,sha256:asset.sha256,url:asset.url,createdAt:at});
    await services.call('project.get',{projectId:secondProject.id});
    fixture={workspace,project,secondProject,shot,secondShot,versionId,synthetic:true};
  } finally {store.close();}
  await writeFile(file,JSON.stringify(fixture,null,2));return fixture;
}
export function mutationQaAudit(workspace) {
  const db=new DatabaseSync(path.join(workspace,'workbench.sqlite'),{readOnly:true});
  try {
    const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
    const data=Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM "${table}" ORDER BY rowid LIMIT 1001`).all()]));
    if(Object.values(data).some(rows=>rows.length>1000))throw Error('QA audit bound exceeded');
    return {at:new Date().toISOString(),data,hash:createHash('sha256').update(JSON.stringify(data)).digest('hex')};
  } finally {db.close();}
}
const invokedDirectly=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(invokedDirectly&&process.argv.includes('--prepare'))console.log(JSON.stringify(await prepareMutationQaFixture(process.argv.includes('--native')?path.join(mutationQaRoot,'native-runtime'):mutationRuntime),null,2));
if(invokedDirectly&&process.argv.includes('--serve')) {
  process.env.MIOON_ENABLE_LIVE_PROVIDER='0';
  for(const key of Object.keys(process.env))if(/^(RUNWAY|RUNWAYML|ARK_|VEO_|GEMINI_|MINIMAX_|HAILUO_|VIDU_|OPENAI_|DEEPSEEK_|DASHSCOPE_|MOONSHOT_)/.test(key))delete process.env[key];
  const fixture=await prepareMutationQaFixture();
  let backend=await startServer({dataDir:fixture.workspace,port:0,token:mutationQaToken,distDir:path.resolve('apps/web/dist')}),closing=false,seq=0;
  const port=4894,host=`127.0.0.1:${port}`,origin=`http://${host}`;
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.headers.host!==host||req.headers.origin&&req.headers.origin!==origin)return res.writeHead(403).end();
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1024*1024)return res.writeHead(413).end();chunks.push(chunk);}
      const bytes=Buffer.concat(chunks);let input;try{input=JSON.parse(bytes);}catch{}
      const event={seq:++seq,at:new Date().toISOString(),method:req.method,path:req.url,...(req.url==='/api/rpc'?{operation:input?.operation,input:input?.input}:{})};
      if(req.url==='/api/rpc'||req.url.startsWith('/api/agent/'))await appendFile(path.join(mutationRuntime,'requests.jsonl'),JSON.stringify(event)+'\n');
      let fault;try{const candidate=JSON.parse(await readFile(path.join(mutationRuntime,'fault.json'),'utf8'));if(req.method==='POST'&&req.url==='/api/rpc'&&candidate.operation===input?.operation&&['drop','hold','malformed'].includes(candidate.kind)){fault=candidate;await unlink(path.join(mutationRuntime,'fault.json'));}}catch{}
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
    if(item.action==='audit')result=mutationQaAudit(fixture.workspace);
    else if(item.action==='restart'){await backend.close();backend=await startServer({dataDir:fixture.workspace,port:0,token:mutationQaToken,distDir:path.resolve('apps/web/dist')});await descriptor();result={restarted:true};}
    else throw Error('Unknown bounded QA action');
  }catch(error){result={probeError:error.message};}await writeFile(path.join(box,name.replace('.request.json','.result.json')),JSON.stringify(result));}}finally{busy=false;}},40);timer.unref();
  console.log(`MUTATION_SYNTHETIC_QA_READY ${origin}`);
  const close=async()=>{if(closing)return;closing=true;clearInterval(timer);await backend.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(mutationRuntime,'exit.json'),JSON.stringify({at:new Date().toISOString(),closed:true}));};process.on('SIGTERM',close);process.on('SIGINT',close);
}
