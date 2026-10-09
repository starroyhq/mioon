/** No browser hooks. Server/API audit for this disposable QA workspace only. */
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
export async function dockableQaClient(){
 const root=fileURLToPath(new URL('../evidence/dockable-panels',import.meta.url)),runtime=path.join(root,'browser-runtime');
 const fixture=JSON.parse(await readFile(path.join(runtime,'fixture.json'),'utf8'));
 const connection=async()=>JSON.parse(await readFile(path.join(runtime,'server.json'),'utf8'));
 async function waitFor(test,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const value=await test();if(value)return value;await new Promise(r=>setTimeout(r,80));}throw Error('Timed out: '+label);}
 async function request(pathname,options={}){const id=randomUUID(),box=path.join(root,'api-mailbox');await mkdir(box,{recursive:true});await writeFile(path.join(box,id+'.request.json'),JSON.stringify({pathname,options}));const result=await waitFor(async()=>{try{return JSON.parse(await readFile(path.join(box,id+'.result.json'),'utf8'));}catch{return false;}},'graphical-runtime QA verifier');if(result.probeError)throw Error(result.probeError);return result;}
 async function rpc(operation,input={}){const r=await request('/api/rpc',{method:'POST',body:JSON.stringify({operation,input})});assert.equal(r.status,200);assert.equal(r.ok,true);return r.data;}
 async function prefs(projectId=fixture.project.id){const r=await request('/api/workspace-preferences/'+projectId);assert.equal(r.status,200);assert.equal(r.ok,true);return r.data;}
 const put=(projectId,state,expectedRevision)=>request('/api/workspace-preferences/'+projectId,{method:'PUT',body:JSON.stringify({state,expectedRevision})});
 const snapshot=async()=>({primary:await rpc('project.get',{projectId:fixture.project.id}),secondary:await rpc('project.get',{projectId:fixture.second.id}),history:await rpc('timeline.history.get',{projectId:fixture.project.id})});
 const writes=async()=>{try{return(await readFile(path.join(runtime,'preference-writes.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}};
 async function fault(value){for(const name of ['fault-observed.json','fault-release'])try{await unlink(path.join(runtime,name));}catch{}await writeFile(path.join(runtime,'fault.json'),JSON.stringify(value));}
 const release=()=>writeFile(path.join(runtime,'fault-release'),'release');
 const waitFault=()=>waitFor(async()=>{try{return JSON.parse(await readFile(path.join(runtime,'fault-observed.json'),'utf8'));}catch{return false;}},'HTTP fixture fault observed');
 return{root,runtime,fixture,connection,request,rpc,prefs,put,snapshot,writes,fault,release,waitFor,waitFault};
}
