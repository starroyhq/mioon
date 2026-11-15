import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,realpath,readFile,writeFile,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {timelineLoudnessCandidateDigest} from '../packages/contracts/src/timeline-loudness-apply.ts';
import {openProjectDatabase} from './helpers/project-database.ts';
import {readProjectState} from './helpers/project-state.ts';
import type {ProjectState} from './helpers/project-state.ts';
const repo=fileURLToPath(new URL('../',import.meta.url)),workerPath=fileURLToPath(new URL('./helpers/timeline-loudness-process-worker.ts',import.meta.url));
interface WorkerReady {pid: number; startup: {processed: number; unavailable: number}}
interface WorkerReply {[key: string]: unknown}
interface WorkerHarness {pid: number | undefined; readonly stopped: {code: number | null; signal: string | null} | undefined; ready: Promise<WorkerReady>; exited: Promise<{code: number | null; signal: string | null}>; ask<T = WorkerReply>(method: string, input?: unknown): Promise<T>; close(): Promise<unknown>}
interface TimelineView {id: string; revision: number; tracks: {id: string; kind: string; [key: string]: unknown}[]; clips: unknown[]; [key: string]: unknown}
interface ProjectView {id: string}
function deadline<T>(promise: Promise<T>, label: string, ms = 10000): Promise<T> {let timer: ReturnType<typeof setTimeout> | undefined;return Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`Timed out: ${label}`)),ms);})]).finally(()=>clearTimeout(timer));}
function startWorker(root: string,{missingTools=false}: {missingTools?: boolean} = {}): WorkerHarness {
  const child=spawn(process.execPath,[workerPath,root],{cwd:repo,stdio:['ignore','pipe','pipe','ipc'],
    env:{PATH:process.env.PATH||'',HOME:root,TMPDIR:root,LANG:'C.UTF-8',NODE_ENV:'test',
      ...(missingTools?{MIOON_FFMPEG_PATH:path.join(root,'missing-ffmpeg'),MIOON_FFPROBE_PATH:path.join(root,'missing-ffprobe')}:{})}});
  const ready=Promise.withResolvers<WorkerReady>(),exited=Promise.withResolvers<{code: number | null; signal: string | null}>(),pending=new Map<string,{resolve: (value: unknown) => void; reject: (error: unknown) => void}>();let stopped: {code: number | null; signal: string | null} | undefined,output='',bytes=0;
  const reject=(error: unknown)=>{ready.reject(error);for(const reply of pending.values())reply.reject(error);};
  // One inventory site: both text pipes use continuous UTF-8 decoding before
  // delivery; bounded capture cannot split a multibyte character per chunk.
  assert.ok(child.stdout && child.stderr);
  for(const stream of [child.stdout,child.stderr])stream.setEncoding('utf8').on('data',(chunk: string)=>{
    bytes+=Buffer.byteLength(chunk);output=(output+chunk).slice(-20000);
    if(bytes>65536){reject(Error('Owned worker output limit'));child.kill('SIGKILL');}
  });
  child.once('error',reject);child.once('close',(code: number | null,signal: string | null)=>{stopped={code,signal};reject(Object.assign(Error(`Owned worker exited (${code}, ${signal}) ${output}`),{code:'WORKER_EXITED',signal}));exited.resolve(stopped);});
  child.on('message',(message: unknown)=>{
    const value=message as {type?: string; message?: string; id?: string; error?: {message?: string; code?: string}; data?: unknown; pid?: number; startup?: {processed: number; unavailable: number}};
    if(value.type==='ready')ready.resolve(value as WorkerReady);else if(value.type==='fatal')reject(Error(String(value.message)));
    else if(value.type==='reply'){const response=value.id===undefined?undefined:pending.get(value.id);if(value.error)response?.reject(Object.assign(Error(String(value.error.message)),{code:value.error.code}));else response?.resolve(value.data);}
  });
  return {pid:child.pid,get stopped(){return stopped;},ready:ready.promise,exited:exited.promise,
    async ask<T = WorkerReply>(method: string,input?: unknown): Promise<T> {if(stopped)throw Error('Owned worker stopped');const id=randomUUID(),reply=Promise.withResolvers<unknown>();pending.set(id,reply);
      child.send({id,method,input},(error: Error | null)=>{if(error)reply.reject(error);});try{return await deadline(reply.promise,method) as T;}finally{pending.delete(id);}},
    async close(){if(!stopped&&child.connected)child.send({method:'close'});try{return await deadline(exited.promise,'worker close');}
      catch(error){if(!stopped)child.kill('SIGKILL');await deadline(exited.promise,'worker kill');throw error;}},
  };
}
function wav(): Buffer {const frames=144000,bytes=Buffer.alloc(44+frames*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);
  bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
  for(let i=0;i<frames;i++){const sample=Math.round(6000*Math.sin(2*Math.PI*997*i/48000));bytes.writeInt16LE(sample,44+i*4);bytes.writeInt16LE(-sample,46+i*4);}return bytes;}
const action=(envelope: {task: {projectId?: string; id?: string; digest?: string; [key: string]: unknown}; instanceId: string}) => ({projectId:envelope.task.projectId,taskId:envelope.task.id,digest:envelope.task.digest,instanceId:envelope.instanceId});
test('SIGKILL after real loudness commit retains one history/receipt and recovers the original durable ACK with missing media/tools', {timeout:30000},async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-loudness-sigkill-'))),workers: WorkerHarness[]=[];
  t.after(async()=>{try{for(const worker of workers)await worker.close();t.diagnostic(`Reaped ${workers.length} owned workers: ${workers.map(worker=>worker.pid).join(', ')}`);}
    finally{await rm(root,{recursive:true,force:true});}});
  const store=openStore(root),services=createServices(store,new Map());let project: ProjectView | undefined,timeline: TimelineView | undefined,asset: Record<string, unknown> | undefined;
  try{
    project=await services.call('project.create',{name:'Synthetic gain crash recovery'}) as ProjectView;timeline=await services.call('timeline.get',{projectId:project.id}) as TimelineView;
    assert.ok(project && timeline);
    const id=randomUUID(),bytes=wav();asset={id,projectId:project.id,name:'Synthetic tone.wav',mimeType:'audio/wav',relativePath:`media/${id}.wav`,
      sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,duration:3,hasAudio:true,hasVideo:false,width:0,height:0,url:`/media/${id}`,createdAt:new Date().toISOString()};
    await writeFile(path.join(root,String(asset.relativePath)),bytes,{mode:0o600});store.put('assets',asset);
    const audioTrack=timeline.tracks.find((track: {kind: string})=>track.kind==='audio');assert.ok(audioTrack);
    timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),
      assetId:id,trackId:audioTrack.id,startFrame:0,durationFrames:60,gain:.75}) as TimelineView;
  }finally{await services.drain();store.close();}
  // The active worker reads its own connection. After SIGKILL or a clean close,
  // the test reacquires the full kernel, including recovery and native locks.
  // JSON keeps the IPC and local snapshot shapes equal.
  const state=async(worker:WorkerHarness):Promise<ProjectState>=>{
    if(!worker.stopped)return worker.ask<ProjectState>('snapshot');
    const db=openProjectDatabase(root);try{return JSON.parse(JSON.stringify(readProjectState(db))) as ProjectState;}finally{db.close();}
  };
  const receipt=(saved:ProjectState,requestId:string)=>{const row=saved.tables.timeline_requests.find(row=>row.requestId===requestId);
    return row?{requestHash:row.requestHash,response:row.response as string}:undefined;};
  const start=async (options?: {missingTools?: boolean})=>{const worker=startWorker(root,options);workers.push(worker);const ready=await deadline(worker.ready,'worker ready');
    assert.equal(ready.pid,worker.pid);assert.notEqual(ready.pid,process.pid);assert.throws(()=>openProjectDatabase(root),{code:'PROJECT_LOCKED'});return {worker,ready};};
  assert.ok(project && timeline && asset);
  const first=await start();assert.deepEqual(first.ready.startup,{processed:0,unavailable:0});
  const prepareInput={projectId:project.id,expectedRevision:timeline.revision,mixProfile:'timeline-float-mix-v1',measurementProfile:'bs1770-5-48k-stereo-fir4x-v1',
    target:{integratedLufs:-30,truePeakCeilingDbtp:-1}};
  const report=await first.worker.ask<{candidate:{meetsTarget:boolean;meetsTruePeak:boolean}; identity:{snapshotSha256:string}}>('rpc',{operation:'timeline.loudness.prepare',input:prepareInput});assert.equal(report.candidate.meetsTarget,true);assert.equal(report.candidate.meetsTruePeak,true);
  const input={...prepareInput,requestId:randomUUID(),snapshotSha256:report.identity.snapshotSha256,candidateDigest:await timelineLoudnessCandidateDigest(report)};
  const prepared=await first.worker.ask<{task:{id:string;projectId:string;digest:string;input:unknown;requestId:string}; instanceId:string}>('prepare',{projectId:project.id,operation:'timeline.loudness.apply',input,origin:'new'});
  await first.worker.ask('arm','afterBusinessCommit');await assert.rejects(first.worker.ask('execute',action(prepared)),{code:'WORKER_EXITED',signal:'SIGKILL'});
  assert.deepEqual(await first.worker.exited,{code:null,signal:'SIGKILL'});assert.doesNotThrow(()=>{const recovered=openProjectDatabase(root);recovered.close();},'the real SIGKILL releases kernel locks for normal recovery');
  const crash=JSON.parse(await readFile(path.join(root,'owned-loudness-crash-proof.json'),'utf8'));
  assert.deepEqual(crash,{phase:'afterBusinessCommit',pid:first.worker.pid,liveMediaCount:0,dispatchCount:1,operation:'timeline.loudness.apply',requestId:input.requestId});
  const committed=await state(first.worker),originalRow=receipt(committed,input.requestId);assert.ok(originalRow);const original=originalRow,ack=JSON.parse(original.response);
  const editStatus=committed.tables.edit_tasks.find(row=>row.id===prepared.task.id);assert.ok(editStatus);assert.equal(editStatus.status,'dispatching');
  await unlink(path.join(root,String(asset.relativePath)));const second=await start({missingTools:true});assert.deepEqual(second.ready.startup,{processed:1,unavailable:0});
  const recovered=await second.worker.ask<{task:{status:string;requestId:string;digest:string;input:unknown}; instanceId:string}>('get',{projectId:project.id,taskId:prepared.task.id});assert.equal(recovered.task.status,'applied');
  assert.equal(recovered.task.requestId,input.requestId);assert.equal(recovered.task.digest,prepared.task.digest);assert.deepEqual(recovered.task.input,input);assert.notEqual(recovered.instanceId,prepared.instanceId);
  await assert.rejects(second.worker.ask('execute',action(prepared)),{code:'EDIT_TASK_STALE_INSTANCE'});
  const undone=await second.worker.ask<{clips: unknown[]}>('rpc',{operation:'timeline.undo',input:{projectId:project.id,expectedRevision:ack.timeline.revision,requestId:randomUUID()}});
  assert.ok(timeline);assert.deepEqual(undone.clips,timeline.clips);
  assert.equal(JSON.stringify(((await second.worker.ask('execute',action(recovered))) as {result: unknown}).result),original.response);
  assert.equal(JSON.stringify(await second.worker.ask('rpc',{operation:'timeline.loudness.apply',input})),original.response);
  const retained=await state(second.worker);
  assert.deepEqual(receipt(retained,input.requestId),original);
  assert.equal(retained.tables.timeline_history.filter(row=>row.operation==='timeline.loudness.apply').length,1);
  assert.equal(retained.tables.timeline_requests.filter(row=>row.requestId===input.requestId).length,1);
  assert.deepEqual(await second.worker.ask('observe'),{dispatches:[],media:[],liveMediaCount:0});
  t.diagnostic(`SIGKILL afterBusinessCommit confirmed for owned worker ${first.worker.pid}; new owner ${second.worker.pid} recovered original ACK without media or redispatch.`);
});
