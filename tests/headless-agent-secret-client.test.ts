import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createHeadlessSecretHelperClient} from '../apps/server/src/headless-agent-secret-client.ts';
const request={operation:'read' as const,service:'app.starroy.mioon.headless.agent.v1.development',account:'a'.repeat(64)};
async function script(t:TestContext,body:string){const root=await mkdtemp(path.join(tmpdir(),'mioon-headless-helper-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'helper.cjs');await writeFile(file,body,{mode:0o600});return {file:pathToFileURL(file),root};}
const safeFailure=(error:unknown)=>error instanceof Error&&'code' in error&&error.code==='AGENT_SETTINGS_STORAGE_UNAVAILABLE'&&!error.message.includes('MARKER');
test('headless IPC uses a fresh child per operation and ignores stdout/stderr credential-like noise',async t=>{
  const f=await script(t,`const fs=require('node:fs'),path=require('node:path');process.once('message',m=>{fs.appendFileSync(path.join(__dirname,'pids'),process.pid+'\\n');console.log('SYNTHETIC_STDOUT_MARKER');console.error('SYNTHETIC_STDERR_MARKER');process.send({version:1,id:m.id,ok:true,key:null},()=>process.exit(0));});`);
  const client=createHeadlessSecretHelperClient({helperFile:f.file,timeoutMs:1000});t.after(()=>client.close());
  assert.equal((await client.request(request)).ok,true);assert.equal((await client.request(request)).ok,true);
  const pids=(await readFile(path.join(f.root,'pids'),'utf8')).trim().split('\n');assert.equal(pids.length,2);assert.notEqual(pids[0],pids[1]);
});
test('headless IPC does not accept forged, failed-exit or late results',async t=>{
  for(const body of [
    `process.once('message',m=>process.send({version:1,id:m.id,ok:true,key:'SYNTHETIC_KEY_MARKER'},()=>process.exit(0)));`,
    `process.once('message',m=>process.send({version:1,id:m.id,ok:true,key:null},()=>process.exit(1)));`,
    `process.once('message',m=>{process.send({version:1,id:m.id,ok:true,key:null});setTimeout(()=>process.exit(0),200);});`,
  ]){
    const f=await script(t,body),client=createHeadlessSecretHelperClient({helperFile:f.file,timeoutMs:100});t.after(()=>client.close());
    await assert.rejects(client.request(request),safeFailure);await delay(5);
  }
});
test('headless IPC abort/close kills the owned child and rejects future requests',async t=>{
  const f=await script(t,`process.once('message',m=>setTimeout(()=>process.send({version:1,id:m.id,ok:true,key:null}),500));`);
  const client=createHeadlessSecretHelperClient({helperFile:f.file,timeoutMs:1000}),controller=new AbortController();t.after(()=>client.close());
  const pending=client.request(request,{signal:controller.signal});controller.abort('SYNTHETIC_ABORT_MARKER');await assert.rejects(pending,safeFailure);
  const second=client.request(request);client.close();await assert.rejects(second,safeFailure);await assert.rejects(client.request(request),safeFailure);
});
test('headless IPC recovers after repeated OS spawn failures without exhausting its child bound',async t=>{
  const f=await script(t,`process.once('message',m=>process.send({version:1,id:m.id,ok:true,key:null},()=>process.exit(0)));`);
  const client=createHeadlessSecretHelperClient({helperFile:f.file,timeoutMs:1000}),executable=process.execPath;t.after(()=>client.close());
  try{
    // This test file has its own Node process. A missing executable exercises
    // the actual fork error/close path; no helper or credential store is opened.
    process.execPath=path.join(f.root,'missing-node');
    for(let attempt=0;attempt<9;attempt++){await assert.rejects(client.request(request),safeFailure);await delay(0);}
  }finally{process.execPath=executable;}
  assert.deepEqual({...await client.request(request),id:undefined},{version:1,id:undefined,ok:true,key:null});
});
