/** API audit of disposable settings fixture; no browser hooks or real providers. */
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
export async function agentSettingsQaClient(){
 const root=fileURLToPath(new URL('../evidence/agent-settings',import.meta.url)),runtime=path.join(root,'browser-runtime');
 const fixture=JSON.parse(await readFile(path.join(runtime,'fixture.json'),'utf8'));
 const connection=async()=>JSON.parse(await readFile(path.join(runtime,'server.json'),'utf8'));
 async function waitFor(test,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const value=await test();if(value)return value;await new Promise(resolve=>setTimeout(resolve,80));}throw Error('Timed out: '+label);}
 async function request(pathname,options={}){const id=randomUUID(),box=path.join(root,'api-mailbox');await mkdir(box,{recursive:true});await writeFile(path.join(box,id+'.request.json'),JSON.stringify({pathname,options}));const result=await waitFor(async()=>{try{return JSON.parse(await readFile(path.join(box,id+'.result.json'),'utf8'));}catch{return false;}},'graphical settings runtime verifier');if(result.probeError)throw Error(result.probeError);return result;}
 const snapshot=async()=>{const result=await request('/api/agent/settings');assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.ok,true);return result.data;};
 const put=input=>request('/api/agent/settings',{method:'PUT',body:JSON.stringify(input)});
 const audit=()=>request('/audit');
 const writes=async()=>{try{return(await readFile(path.join(runtime,'settings-requests.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}};
 async function fault(value){for(const name of ['fault-observed.json','fault-release'])try{await unlink(path.join(runtime,name));}catch{}await writeFile(path.join(runtime,'fault.json'),JSON.stringify({method:'PUT',pathname:'/api/agent/settings',...value}));}
 const release=()=>writeFile(path.join(runtime,'fault-release'),'release');
 const waitFault=()=>waitFor(async()=>{try{return JSON.parse(await readFile(path.join(runtime,'fault-observed.json'),'utf8'));}catch{return false;}},'settings HTTP fixture fault observed');
 return{root,runtime,fixture,connection,request,snapshot,put,audit,writes,fault,release,waitFor,waitFault};
}
