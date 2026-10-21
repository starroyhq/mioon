import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {readdirSync,rmSync,watch} from 'node:fs';
import {spawn} from 'node:child_process';
import {initializeNodePrivateStorage} from '../packages/node-host/src/private-storage-bootstrap.ts';
import {createPrivateTemporaryDirectory,readPrivateFile,writePrivateFileAtomic,validateManagedFile} from '../packages/contracts/src/private-storage.ts';

const windows=process.platform==='win32';
const bootstrapUrl=new URL('../packages/node-host/src/private-storage-bootstrap.ts',import.meta.url).href;
const storageUrl=new URL('../packages/contracts/src/private-storage.ts',import.meta.url).href;
const MiB=1024*1024;
async function fixture(t){await initializeNodePrivateStorage();const root=createPrivateTemporaryDirectory(tmpdir(),'mioon-native-race-');t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function worker(t,{root,file,mode,marker=65,iterations=1,size=MiB}){
 const configuration=JSON.stringify({root,file,mode,marker,iterations,size});
 const source=`
 import {initializeNodePrivateStorage} from ${JSON.stringify(bootstrapUrl)};
 import {readPrivateFile,writePrivateFileAtomic} from ${JSON.stringify(storageUrl)};
 const config=${configuration};
 const send=value=>new Promise((resolve,reject)=>process.send(value,error=>error?reject(error):resolve()));
 await initializeNodePrivateStorage();
 await send({type:'ready'});
 await new Promise(resolve=>process.once('message',value=>value==='go'&&resolve()));
 let successes=0,rejected=0;
 if(config.mode==='crash')await send({type:'writing'});
 for(let index=0;index<config.iterations;index++){
  try{
   if(config.mode==='read'){
    const value=readPrivateFile(config.file,{root:config.root,maxBytes:2*1024*1024});
    if(!Buffer.isBuffer(value)||value.length!==config.size||![65,66,90].includes(value[0])||!value.every(byte=>byte===value[0]))throw Error('PARTIAL_SECRET');
   }else writePrivateFileAtomic(config.file,Buffer.alloc(config.size,config.marker),{root:config.root,maxBytes:config.mode==='crash'?64*1024*1024:2*1024*1024,replace:config.mode!=='publish'});
   successes++;
  }catch(error){
   const permitted=config.mode==='publish'?'ALREADY_EXISTS':'IO_ERROR';
   if(error?.reason!==permitted)await send({type:'unexpected',reason:typeof error?.reason==='string'?error.reason:'UNEXPECTED'}).finally(()=>process.exit(4));
   rejected++;
  }
 }
 await send({type:'result',successes,rejected});process.disconnect();
 `;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe','ipc']});
 const messages=[];let outputBytes=0,exitResult;
 child.stdout.on('data',bytes=>{outputBytes+=bytes.length;});child.stderr.on('data',bytes=>{outputBytes+=bytes.length;});
 const waiters=new Set();
 child.on('message',message=>{messages.push(message);for(const notify of waiters)notify();});
 const exited=new Promise(resolve=>{child.once('error',()=>{exitResult={code:-1,signal:null};for(const notify of waiters)notify();resolve(exitResult);});child.once('exit',(code,signal)=>{exitResult={code,signal};for(const notify of waiters)notify();resolve(exitResult);});});
 function message(type){return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{waiters.delete(check);reject(Error('Synthetic native worker timed out'));},30000);
  const check=()=>{const unexpected=messages.find(value=>value?.type==='unexpected');const found=messages.find(value=>value?.type===type);if(found||unexpected||exitResult){clearTimeout(timer);waiters.delete(check);if(unexpected)reject(Error(`Unexpected fixed native reason: ${unexpected.reason}`));else if(found)resolve(found);else reject(Error('Synthetic native worker exited before protocol completion'));}};
  waiters.add(check);check();
 });}
 t.after(async()=>{if(!exitResult)child.kill('SIGKILL');await exited;assert.ok(outputBytes<8192,'Worker diagnostic output must remain bounded');});
 return {child,message,exited,unexpected:()=>messages.find(value=>value?.type==='unexpected'),start:()=>child.send('go')};
}

test('native independent-process no-clobber publication has exactly one complete winner',{skip:!windows,timeout:60000},async t=>{
 const root=await fixture(t),file=path.join(root,'secret');
 const contenders=Array.from({length:8},(_,index)=>worker(t,{root,file,mode:'publish',marker:65+index}));
 await Promise.all(contenders.map(value=>value.message('ready')));contenders.forEach(value=>value.start());
 const results=await Promise.all(contenders.map(value=>value.message('result')));
 assert.equal(results.reduce((sum,value)=>sum+value.successes,0),1);
 assert.equal(results.reduce((sum,value)=>sum+value.rejected,0),7);
 const bytes=readPrivateFile(file,{root,maxBytes:2*MiB});assert.equal(bytes.length,MiB);assert.ok(bytes[0]>=65&&bytes[0]<=72);assert.ok(bytes.every(byte=>byte===bytes[0]));
 for(const value of contenders)assert.deepEqual(await value.exited,{code:0,signal:null});
 assert.deepEqual(readdirSync(root),['secret']);
});

test('native concurrent replacement and reads return only complete secrets or a safe sharing refusal',{skip:!windows,timeout:60000},async t=>{
 const root=await fixture(t),file=path.join(root,'secret'),size=MiB;
 writePrivateFileAtomic(file,Buffer.alloc(size,90),{root,maxBytes:2*MiB});
 const writers=[65,66].map(marker=>worker(t,{root,file,mode:'replace',marker,size,iterations:24}));
 const readers=Array.from({length:2},()=>worker(t,{root,file,mode:'read',size,iterations:48}));
 const workers=[...writers,...readers];await Promise.all(workers.map(value=>value.message('ready')));workers.forEach(value=>value.start());
 const results=await Promise.all(workers.map(value=>value.message('result')));
 assert.ok(results.slice(0,2).some(value=>value.successes>0),'At least one replacement must actually commit');
 assert.ok(results.slice(2).every(value=>value.successes>0),'Each independent reader must observe at least one complete secret');
 const bytes=readPrivateFile(file,{root,maxBytes:2*MiB});assert.equal(bytes.length,size);assert.ok([65,66,90].includes(bytes[0]));assert.ok(bytes.every(byte=>byte===bytes[0]));
 for(const value of workers)assert.deepEqual(await value.exited,{code:0,signal:null});
 assert.deepEqual(readdirSync(root),['secret']);
});

test('native writer terminated after temporary-file observation never publishes a partial destination',{skip:!windows,timeout:60000},async t=>{
 const root=await fixture(t),file=path.join(root,'secret'),oldSize=64*1024,newSize=32*MiB;
 writePrivateFileAtomic(file,Buffer.alloc(oldSize,90),{root,maxBytes:2*MiB});
 const writer=worker(t,{root,file,mode:'crash',marker:85,size:newSize});await writer.message('ready');
 let observed=false,terminationAccepted=false;
 const watcher=watch(root,(_event,name)=>{if(typeof name==='string'&&/^\.mioon-[a-f0-9]{32}\.tmp$/u.test(name)){observed=true;terminationAccepted=writer.child.kill('SIGKILL')||terminationAccepted;}});
 t.after(()=>watcher.close());writer.start();await writer.message('writing');
 const outcome=await writer.exited;watcher.close();
 assert.ok(observed,'A real staged temporary file must be observed before terminating the independent worker');
 assert.ok(terminationAccepted,'The operating system must accept termination of the live worker');assert.equal(writer.unexpected(),undefined);
 assert.ok(outcome.signal==='SIGKILL'||outcome.code!==0,'The worker must actually be terminated, not merely finish a sequential write');
 const bytes=readPrivateFile(file,{root,maxBytes:64*MiB});assert.ok(bytes.length===oldSize||bytes.length===newSize);const marker=bytes.length===oldSize?90:85;assert.ok(bytes.every(byte=>byte===marker));
 for(const entry of readdirSync(root)){if(entry==='secret')continue;assert.match(entry,/^\.mioon-[a-f0-9]{32}\.tmp$/u);assert.ok(validateManagedFile(path.join(root,entry),{root,private:true,maxBytes:64*MiB}));}
});
