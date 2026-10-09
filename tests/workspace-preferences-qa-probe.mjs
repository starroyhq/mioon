/** Graphical-runtime verifier: bounded synthetic API mailbox, no browser hooks. */
import {readdir,readFile,writeFile,unlink,mkdir} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('evidence/workspace-preferences'),inbox=path.join(root,'api-mailbox');await mkdir(inbox,{recursive:true});
const allowed=new Set(['project.get','project.create','timeline.history.get']);
console.log('PREFERENCES_API_PROBE_READY');
for(;;){
 for(const file of (await readdir(inbox)).filter(n=>n.endsWith('.request.json'))){
  const reqPath=path.join(inbox,file),req=JSON.parse(await readFile(reqPath,'utf8'));await unlink(reqPath);
  const resultPath=path.join(inbox,file.replace('.request.json','.result.json'));
  try{
   if(!['browser','native'].includes(req.kind)||!/^\/api\/(rpc|workspace-preferences\/[0-9a-f-]+)$/.test(req.pathname))throw Error('Only bounded local synthetic QA API allowed');
   if(req.pathname==='/api/rpc'&&!allowed.has(JSON.parse(req.options.body).operation))throw Error('Operation outside QA verifier scope');
   const runtime=path.join(root,req.kind+'-runtime');let url,token;
   if(req.kind==='native'){const d=JSON.parse(await readFile(path.join(runtime,'user-data/mcp-connection.json'),'utf8'));url=d.url;token=(await readFile(d.tokenFile,'utf8')).trim();}else{url=JSON.parse(await readFile(path.join(runtime,'server.json'),'utf8')).url;token=(await readFile(path.join(runtime,'token'),'utf8')).trim();}
   const response=await fetch(url+req.pathname,{...req.options,headers:{authorization:'Bearer '+token,'content-type':'application/json'},signal:AbortSignal.timeout(12000)});await writeFile(resultPath,JSON.stringify({status:response.status,...await response.json()}));
  }catch(e){await writeFile(resultPath,JSON.stringify({probeError:e.message}));}
 }await new Promise(r=>setTimeout(r,25));
}
