import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startServer} from '@mioon/server';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {syntheticPng} from './helpers/runway-unknown-fixture.mjs';
import {deferred} from './helpers/worker-shutdown-fixture.mjs';

const token='synthetic-q3-server-shutdown-token';
async function rpc(server,operation,input={}) {
 const response=await fetch(server.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation,input})});
 return {status:response.status,...await response.json()};
}

test('server close aborts an active RPC media import, reaps its probe, and relaunches without publication',{timeout:10000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-server-shutdown-'));let server,closing;
 t.after(async()=>{await server?.close();await rm(root,{recursive:true,force:true});});
 server=await startServer({dataDir:root,port:0,token});
 const {data:project}=await rpc(server,'project.create',{name:'Shutdown import'}),events=[];
 const detach=onMediaProcess(event=>{
  events.push(event);
  if(event.type==='started'&&event.kind==='ffprobe'&&!closing)closing=server.close();
 });
 const began=performance.now();
 try {
  const result=await rpc(server,'asset.import',{projectId:project.id,name:'Synthetic.png',mimeType:'image/png',dataBase64:syntheticPng.toString('base64')});
  assert.ok(closing,'stop must start while the import probe is active');await closing;
  assert.equal(result.status,503);assert.equal(result.error.code,'OPERATION_CANCELLED');assert.ok(performance.now()-began<5000);
  const started=events.filter(e=>e.type==='started').map(e=>e.pid),exited=events.filter(e=>e.type==='exited').map(e=>e.pid);
  assert.equal(started.length,1);assert.deepEqual(exited,started);assert.deepEqual(await readdir(path.join(root,'media')),[]);
 } finally {detach();}
 server=await startServer({dataDir:root,port:0,token});
 assert.deepEqual((await rpc(server,'asset.list',{projectId:project.id})).data,[]);
 const imported=await rpc(server,'asset.import',{projectId:project.id,name:'Recovered.png',mimeType:'image/png',dataBase64:syntheticPng.toString('base64')});
 assert.equal(imported.ok,true);assert.equal((await rpc(server,'asset.list',{projectId:project.id})).data.length,1);
});

test('shutdown fences a partial HTTP RPC body before it can start a new import or touch closed SQLite',{timeout:10000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-server-body-shutdown-'));let server;
 t.after(async()=>{await server?.close();await rm(root,{recursive:true,force:true});});
 server=await startServer({dataDir:root,port:0,token});
 const project=(await rpc(server,'project.create',{name:'Partial request'})).data;
 const body=JSON.stringify({operation:'asset.import',input:{projectId:project.id,name:'Late.png',mimeType:'image/png',dataBase64:syntheticPng.toString('base64')}});
 const connected=deferred();
 const reply=new Promise((resolve,reject)=>{
  const req=http.request(server.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));
  });
  req.on('error',reject);req.on('socket',socket=>socket.once('connect',()=>connected.resolve(req)));
  req.write(body.slice(0,-1));
 });
 const req=await connected.promise;
 // Let the local connection deliver its incomplete request into body().
 await new Promise(resolve=>setTimeout(resolve,20));
 const events=[],detach=onMediaProcess(event=>events.push(event));
 try {
  const closing=server.close();req.end(body.slice(-1));
  const result=await reply;await closing;
  assert.equal(result.status,503);assert.equal(result.body.error.code,'OPERATION_CANCELLED');assert.deepEqual(events,[]);
 } finally {detach();}
 server=await startServer({dataDir:root,port:0,token});
 assert.deepEqual((await rpc(server,'asset.list',{projectId:project.id})).data,[]);
});
