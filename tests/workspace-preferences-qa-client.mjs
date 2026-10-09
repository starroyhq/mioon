/** Non-browser verification helpers for disposable runtime only. */
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
export async function qaClient(kind='browser'){
 assert.ok(['browser','native'].includes(kind));
 const root=fileURLToPath(new URL('../evidence/workspace-preferences',import.meta.url)),runtime=path.join(root,kind+'-runtime');
 const fixture=JSON.parse(await readFile(path.join(runtime,'fixture.json'),'utf8'));
 async function connection(){if(kind==='native'){const d=JSON.parse(await readFile(path.join(runtime,'user-data/mcp-connection.json'),'utf8'));return {url:d.url,token:(await readFile(d.tokenFile,'utf8')).trim(),pid:d.pid};}return {...JSON.parse(await readFile(path.join(runtime,'server.json'),'utf8')),token:(await readFile(path.join(runtime,'token'),'utf8')).trim()};}
 async function request(pathname,options={}){const id=randomUUID(),box=path.join(root,'api-mailbox');await mkdir(box,{recursive:true});await writeFile(path.join(box,id+'.request.json'),JSON.stringify({kind,pathname,options}));const result=await waitFor(async()=>{try{return JSON.parse(await readFile(path.join(box,id+'.result.json'),'utf8'));}catch{return false;}},'graphical-runtime API verifier');if(result.probeError)throw Error(result.probeError);return result;}
 async function rpc(operation,input={}){const r=await request('/api/rpc',{method:'POST',body:JSON.stringify({operation,input})});assert.equal(r.status,200);assert.equal(r.ok,true);return r.data;}
 async function prefs(projectId=fixture.project.id){const r=await request('/api/workspace-preferences/'+projectId);assert.equal(r.status,200);assert.equal(r.ok,true);return r.data;}
 async function put(projectId,state,expectedRevision){return request('/api/workspace-preferences/'+projectId,{method:'PUT',body:JSON.stringify({state,expectedRevision})});}
 async function snapshot(){return {primary:await rpc('project.get',{projectId:fixture.project.id}),secondary:await rpc('project.get',{projectId:fixture.second.id}),history:await rpc('timeline.history.get',{projectId:fixture.project.id})};}
 async function fault(value){assert.equal(kind,'browser');for(const name of ['fault-observed.json','fault-release'])try{await unlink(path.join(runtime,name));}catch{}await writeFile(path.join(runtime,'fault.json'),JSON.stringify(value));}
 const release=()=>writeFile(path.join(runtime,'fault-release'),'release');
 async function waitFor(test,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const value=await test();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out: '+label);}
 const waitFault=()=>waitFor(async()=>{try{return JSON.parse(await readFile(path.join(runtime,'fault-observed.json'),'utf8'));}catch{return false;}},'HTTP fixture fault observed');
 return {root,runtime,fixture,connection,request,rpc,prefs,put,snapshot,fault,release,waitFor,waitFault};
}
export async function recordNativeSnapshot(name){const q=await qaClient('native');const c=await q.connection();const data={name,at:new Date().toISOString(),origin:c.url,utilityPid:c.pid,preferences:await q.prefs(),secondPreferences:await q.prefs(q.fixture.second.id),domain:await q.snapshot()};await writeFile(path.join(q.runtime,name+'.json'),JSON.stringify(data,null,2));return {name,origin:c.url,utilityPid:c.pid,preferences:data.preferences};}
if(typeof process!=='undefined'&&process.argv.includes('--snapshot'))console.log(JSON.stringify(await recordNativeSnapshot(process.argv[process.argv.indexOf('--snapshot')+1]),null,2));
