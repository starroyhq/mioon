/** Mailbox-only audit/fault controls for a single synthetic loopback fixture. */
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export async function mutationQaClient() {
  const root=fileURLToPath(new URL('../evidence/mutation-replay',import.meta.url)),runtime=path.join(root,'browser-runtime');
  const fixture=JSON.parse(await readFile(path.join(runtime,'fixture.json'),'utf8'));
  const waitFor=async(test,label,timeout=20000)=>{const end=Date.now()+timeout;while(Date.now()<end){const result=await test();if(result)return result;await new Promise(resolve=>setTimeout(resolve,80));}throw Error(`Timed out: ${label}`);};
  async function request(action) {
    if(!['audit','restart'].includes(action))throw Error('Unknown fixture action');
    const box=path.join(root,'api-mailbox'),id=randomUUID();await mkdir(box,{recursive:true});await writeFile(path.join(box,id+'.request.json'),JSON.stringify({action}));
    const result=await waitFor(async()=>{try{return JSON.parse(await readFile(path.join(box,id+'.result.json'),'utf8'));}catch{return false;}},'graphical mutation fixture response');
    if(result.probeError)throw Error(result.probeError);return result;
  }
  const operations=['shot.create','shot.update','shot.reorder','node.create','node.update','version.select'];
  async function fault(operation,kind='drop') {
    if(!operations.includes(operation)||!['drop','hold','malformed'].includes(kind))throw Error('Unknown local mutation fault');
    for(const name of['fault-observed.json','release'])try{await unlink(path.join(runtime,name));}catch(error){if(error.code!=='ENOENT')throw error;}
    await writeFile(path.join(runtime,'fault.json'),JSON.stringify({operation,kind}));
  }
  return {root,runtime,fixture,waitFor,request,fault,audit:()=>request('audit'),restart:()=>request('restart'),release:()=>writeFile(path.join(runtime,'release'),'release'),
    waitFault:()=>waitFor(async()=>{try{return JSON.parse(await readFile(path.join(runtime,'fault-observed.json'),'utf8'));}catch{return false;}},'mutation acknowledgement fault'),
    requests:async()=>{try{return(await readFile(path.join(runtime,'requests.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return[];throw error;}}};
}
