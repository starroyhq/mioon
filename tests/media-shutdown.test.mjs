import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {startServer} from '@mioon/server';
import {onMediaProcess} from '@mioon/business/media-processes';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('shutdown interrupts a real long FFmpeg export, reaps its process and preserves queued recovery',async()=>{
 const dataDir=await mkdtemp('/tmp/wb-shutdown-render-'),token='synthetic-interruption-test-token';
 const active=new Map();const unsubscribe=onMediaProcess(event=>event.type==='started'?active.set(event.pid,event.kind):active.delete(event.pid));
 const service=await startServer({dataDir,port:0,token});
 const rpc=async(operation,input={})=>{const response=await fetch(service.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation,input})});const value=await response.json();assert.equal(value.ok,true,JSON.stringify(value));return value.data;};
 let closed=false;
 try{
  const project=await rpc('project.create',{name:'Shutdown render fixture'});
  const bytes=await readFile(path.resolve('examples/synthetic/reference.png'));
  const asset=await rpc('asset.import',{projectId:project.id,name:'synthetic.png',mimeType:'image/png',dataBase64:bytes.toString('base64')});
  let timeline=await rpc('timeline.get',{projectId:project.id});
  await rpc('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:timeline.tracks.find(track=>track.kind==='video').id,startFrame:0,durationFrames:18000});
  timeline=await rpc('timeline.get',{projectId:project.id});
  const render=await rpc('timeline.render',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export'});
  let ffmpegPid;
  for(let i=0;i<200&&!ffmpegPid;i++){
   for(const [pid,kind] of active)if(kind==='ffmpeg')ffmpegPid=pid;
   if(!ffmpegPid)await pause(20);
  }
  assert.ok(ffmpegPid,'real FFmpeg render must start before shutdown');
  const started=Date.now();await service.close();closed=true;assert.ok(Date.now()-started<6000,'shutdown must not wait for ten-minute output');
  assert.equal(active.size,0,'no tracked child survives close');
  assert.throws(()=>process.kill(ffmpegPid,0),/ESRCH/);
  const db=new DatabaseSync(path.join(dataDir,'workbench.sqlite'));
  try{const row=JSON.parse(db.prepare('SELECT data FROM exports WHERE id=?').get(render.id).data);assert.equal(row.status,'queued');assert.equal(row.error,null);assert.equal(row.snapshot.timeline.clips[0].durationFrames,18000);}finally{db.close();}
 }finally{if(!closed)await service.close();unsubscribe();}
});
