/** Disposable own-cloud settings acceptance fixture. No provider requests.
 * Production auth/CSP are retained; faults affect one local settings response. */
import http from 'node:http';
import path from 'node:path';
import {mkdir,readFile,writeFile,appendFile,unlink,access,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {startServer} from '../apps/server/src/index.ts';
import {migrateData} from '../apps/desktop/scripts/migrate-data.ts';
export const qaRoot=path.resolve('evidence/agent-settings');
export const runtime=path.join(qaRoot,'browser-runtime');
export async function prepareAgentSettingsFixture(){
 await mkdir(runtime,{recursive:true});const workspace=path.join(runtime,'workspace'),fixturePath=path.join(runtime,'fixture.json');
 try{return JSON.parse(await readFile(fixturePath,'utf8'));}catch{}
 await migrateData(path.resolve('examples/multitrack-project'),workspace);
 const db=new DatabaseSync(path.join(workspace,'workbench.sqlite'),{readOnly:true});
 let project;try{project=JSON.parse(db.prepare('SELECT data FROM projects ORDER BY rowid LIMIT 1').get().data);}finally{db.close();}
 const fixture={workspace,project};await writeFile(fixturePath,JSON.stringify(fixture,null,2));return fixture;
}
if(process.argv.includes('--prepare'))console.log(JSON.stringify(await prepareAgentSettingsFixture(),null,2));
if(process.argv.includes('--serve')){
 process.env.MIOON_ENABLE_LIVE_PROVIDER='0';for(const key of Object.keys(process.env))if(/^(RUNWAY|RUNWAYML|ARK_|VEO_|GEMINI_|MINIMAX_|HAILUO_|VIDU_|OPENAI_|DEEPSEEK_|DASHSCOPE_|MOONSHOT_)/.test(key))delete process.env[key];
 const fixture=await prepareAgentSettingsFixture();
 const token='agent-settings-synthetic-local-qa-token';
 const backend=await startServer({dataDir:fixture.workspace,port:0,token,distDir:path.resolve('apps/web/dist')});
 const port=4884,host='127.0.0.1:'+port,origin='http://'+host;let closing=false,seq=0;
 const audit=async()=>{
  const db=new DatabaseSync(path.join(fixture.workspace,'workbench.sqlite'),{readOnly:true});let domain;
  try{const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='workspace_preferences' ORDER BY name").all().map(row=>row.name);domain=Object.fromEntries(names.map(name=>[name,db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]));}finally{db.close();}
  const settingsFile=path.join(fixture.workspace,'agent-settings/settings.json');let settingsText='';try{settingsText=await readFile(settingsFile,'utf8');}catch{}
  return{domainHash:createHash('sha256').update(JSON.stringify(domain)).digest('hex'),settingsFilePresent:Boolean(settingsText),plaintextDummyKeyPresent:settingsText.includes('mioon-qa-dummy-agent-key-'),at:new Date().toISOString()};
 };
 const server=http.createServer(async(req,res)=>{
  if(req.headers.host!==host||(req.headers.origin&&req.headers.origin!==origin))return res.writeHead(403).end();
  const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>2*1024*1024)return res.writeHead(413).end();chunks.push(part);}const bytes=Buffer.concat(chunks);
  const event={seq:++seq,at:new Date().toISOString(),method:req.method,path:req.url};
  // No request body or key value is ever included in this acceptance log.
  if(req.url==='/api/agent/settings')await appendFile(path.join(runtime,'settings-requests.jsonl'),JSON.stringify(event)+'\n');
  let fault;try{const candidate=JSON.parse(await readFile(path.join(runtime,'fault.json'),'utf8'));if(candidate.pathname===req.url&&candidate.method===req.method){fault=candidate;await unlink(path.join(runtime,'fault.json'));}}catch{}
  const observed=details=>writeFile(path.join(runtime,'fault-observed.json'),JSON.stringify({...event,...details}));
  if(fault?.kind==='reject'){await observed({status:503,kind:'reject'});return res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({ok:false,error:{code:'QA_UNAVAILABLE',message:'Synthetic local settings outage'}}));}
  const headers={...req.headers,host:new URL(backend.url).host};if(headers.origin)headers.origin=backend.url;
  const upstream=http.request(backend.url+req.url,{method:req.method,headers},async response=>{
   if(fault){const parts=[];for await(const part of response)parts.push(part);const data=Buffer.concat(parts);let safeBody;try{safeBody=JSON.parse(data);}catch{}
    await observed({kind:fault.kind,status:response.statusCode,body:safeBody});
    if(fault.kind==='drop')return res.writeHead(response.statusCode,{'content-type':'application/json','content-length':1}).end(data.subarray(0,1));
    if(fault.kind==='hold')while(!closing){try{await access(path.join(runtime,'fault-release'));await unlink(path.join(runtime,'fault-release'));break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
    res.writeHead(response.statusCode,response.headers);res.end(data);return;
   }res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});upstream.end(bytes);
 });
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));await writeFile(path.join(runtime,'server.json'),JSON.stringify({url:origin,pid:process.pid,workspace:fixture.workspace}));
 const inbox=path.join(qaRoot,'api-mailbox');await mkdir(inbox,{recursive:true});let probeBusy=false;
 const timer=setInterval(async()=>{if(probeBusy||closing)return;probeBusy=true;try{for(const file of(await readdir(inbox)).filter(name=>name.endsWith('.request.json'))){const pathname=path.join(inbox,file),req=JSON.parse(await readFile(pathname,'utf8'));await unlink(pathname);let result;
  try{if(req.pathname==='/audit')result=await audit();else{if(req.pathname!=='/api/agent/settings'||!['GET','PUT'].includes(req.options?.method||'GET'))throw Error('Out-of-scope QA route');const response=await fetch(origin+req.pathname,{...req.options,headers:{authorization:'Bearer '+token,'content-type':'application/json'},signal:AbortSignal.timeout(12000)});result={status:response.status,...await response.json()};}}catch(error){result={probeError:error.message};}await writeFile(path.join(inbox,file.replace('.request.json','.result.json')),JSON.stringify(result));
 }}finally{probeBusy=false;}},25);timer.unref();console.log('AGENT_SETTINGS_QA_READY '+origin);
 const close=async()=>{if(closing)return;closing=true;clearInterval(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await backend.close();};process.on('SIGTERM',close);process.on('SIGINT',close);
}
