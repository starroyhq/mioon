import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {WAVEFORM_ALGORITHM,sourceFrameCount} from '@mioon/contracts';
import {kernelFixture,snapshot as currentSnapshot} from './helpers/current-retained-fixture.ts';

import {createWaveformHistoryReaders,WAVEFORM_CACHE_LIMITS} from '../packages/business/src/waveforms-history.ts';
import {createWaveformServices} from '../packages/business/src/waveforms.ts';
import type { BinaryLike } from 'crypto';

const at='2026-10-12T00:00:00.000Z',sha=(value: Buffer<ArrayBuffer>|BinaryLike)=>createHash('sha256').update(value).digest('hex');
const snapshot=(db: DatabaseSync)=>JSON.stringify(currentSnapshot(db));
const rowBytes=(row: { cacheKey: unknown; projectId: unknown; sourceSha256: unknown; algorithm: unknown; status: unknown; attemptId: unknown; data: unknown; reservedBytes?: number; })=>Buffer.byteLength(JSON.stringify({cacheKey:row.cacheKey,projectId:row.projectId,sourceSha256:row.sourceSha256,algorithm:row.algorithm,status:row.status,attemptId:row.attemptId,data:row.data}));
function fixture(t: test.TestContext){
 const native=kernelFixture(t,'Saved reader'),foreign=kernelFixture(t,'Foreign reader');
 const db=native.store.db;
 const projectId=native.projectId,otherProjectId=foreign.projectId;
 const id=randomUUID(),asset={id,projectId,name:'Historical source.wav',mimeType:'audio/wav',duration:1,hasAudio:true,sizeBytes:64,sha256:'a'.repeat(64),relativePath:`media/${id}.wav`,provenance:'user-import'};
 db.prepare('INSERT INTO assets VALUES(?,?,?)').run(id,projectId,JSON.stringify(asset));return {db,store:native.store,projectId,otherProjectId,asset,input:{projectId,assetId:id}};
}
function seed(f: Awaited<ReturnType<typeof fixture>>,status='ready',patch={}){
 const peaks=Array.from({length:100},(_,i)=>i<50?6553:52428),peakBytes=Buffer.alloc(peaks.length*2);peaks.forEach((value,i)=>peakBytes.writeUInt16LE(value,i*2));
 const data=status==='ready'?{duration:f.asset.duration,sourceFrames:sourceFrameCount(f.asset.duration),sampleFrames:48000,peaks,peakDigest:sha(peakBytes),clipped:false,channels:2,source:{mimeType:f.asset.mimeType,hasAudio:f.asset.hasAudio,sizeBytes:f.asset.sizeBytes}}:
 status==='queued'||status==='running'?{}:{reason:{code:'WAVEFORM_INTERRUPTED',message:'Waveform preparation was interrupted. Request an explicit retry to restart it.'}};
 const row: {cacheKey:string;projectId:string;sourceSha256:string;algorithm:string;status:string;attemptId:string;data:typeof data;bytes?:number;reservedBytes:number}={cacheKey:sha(JSON.stringify([f.projectId,f.asset.sha256,WAVEFORM_ALGORITHM])),projectId:f.projectId,sourceSha256:f.asset.sha256,algorithm:WAVEFORM_ALGORITHM,status,attemptId:randomUUID(),data,reservedBytes:['queued','running'].includes(status)?WAVEFORM_CACHE_LIMITS.recordBytes:0,...patch};(row as unknown as {bytes:number}).bytes=rowBytes(row);
 f.db.prepare('INSERT INTO waveform_cache(cacheKey,projectId,sourceSha256,algorithm,status,attemptId,data,bytes,reservedBytes) VALUES(?,?,?,?,?,?,?,?,?)').run(row.cacheKey,row.projectId,row.sourceSha256,row.algorithm,row.status,row.attemptId,JSON.stringify(row.data),row.bytes!,row.reservedBytes);return row;
}
function guarded(db: DatabaseSync){
 const returned: unknown[]=[];
 const proxy=new Proxy(db,{get(target,key){
  if(key==='prepare')return (sql: string)=>{assert.match(sql,/^SELECT\b/i);const statement=target.prepare(sql);return new Proxy(statement,{get(s,method){const value=Reflect.get(s,method,s);if(['get','all'].includes(method as string))return(...args: unknown[])=>{const row=value.apply(s,args);returned.push(row);return row;};if(method==='run')return()=>assert.fail('History attempted SQL run');return typeof value==='function'?value.bind(s):value;}});};
  if(key==='exec')return()=>assert.fail('Waveform history opened a transaction or wrote SQL');
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 const store=new Proxy({db:proxy},{get(target,key){assert.equal(key,'db','Waveform history accessed a runtime capability');return target.db;}});
 return {store,returned};
}
function withoutIO(t: test.TestContext,fn: { (): void; (): unknown; }){
 const guards: {mock:{restore():void}}[]=[];
 for(const [object,names] of [[fs,['readFileSync','openSync','statSync','lstatSync','readSync','readFile','open','createReadStream','writeFileSync','createWriteStream','mkdirSync']],
  [fsPromises,['readFile','open','stat','lstat','writeFile','mkdir']],[childProcess,['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']],
  [http,['request','get']],[https,['request','get']],[globalThis,['fetch','queueMicrotask']]] as const)for(const name of names)guards.push((t.mock.method as unknown as (object:object,name:PropertyKey,fn:()=>never)=>{mock:{restore():void}})(object,name,()=>assert.fail(`Waveform history entered ${name}`)));
 syncBuiltinESMExports();try{return fn();}finally{for(const guard of guards)guard.mock.restore();syncBuiltinESMExports();}
}

test('saved ready waveform GET reduces exact source-aligned peaks without runtime construction, writes, files or media work',t=>{
 const f=fixture(t),row=seed(f);const before=snapshot(f.db),changes=f.db.prepare('SELECT total_changes() n').get()!.n,guard=guarded(f.db);
 withoutIO(t,()=>{
  const hostile=new Proxy({},{get(){assert.fail('History inspected decode/probe options');}}),read=(createWaveformHistoryReaders as unknown as (store:Parameters<typeof createWaveformHistoryReaders>[0],options?:unknown)=>import('./helpers/strict-workspace-boundary-types.ts').WaveformHistory)(guard.store,hostile);
  assert.deepEqual(Object.keys(read.handlers),['asset.waveform.get']);const get=read.handlers['asset.waveform.get'];
  assert.deepEqual(get({...f.input,sourceStartFrame:0,sourceEndFrame:15,points:2}).peaks,[6553/65535,6553/65535]);
  assert.deepEqual(get({...f.input,sourceStartFrame:15,sourceEndFrame:30,points:2}).peaks,[.8,.8]);
  assert.equal(get({...f.input,points:1}).peaks![0],.8);assert.equal(get({...f.input,points:2048}).peaks!.length,100);
  assert.equal(get(f.input).attemptId,row.attemptId);
 });
 assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n,changes);assert.equal(snapshot(f.db),before);
});

for(const status of ['queued','running','interrupted','missing'] as const)test(`captured waveform ${status} remains exact and cannot initiate recovery or cache work`,t=>{
 const f=fixture(t);if(status!=='missing')seed(f,status);const before=snapshot(f.db),read=(createWaveformHistoryReaders as unknown as (store:Parameters<typeof createWaveformHistoryReaders>[0],options?:unknown)=>import('./helpers/strict-workspace-boundary-types.ts').WaveformHistory)(guarded(f.db).store).handlers['asset.waveform.get'];
 assert.equal(read(f.input).status,status);assert.equal(read({...f.input,points:1}).status,status);assert.equal(snapshot(f.db),before);
});

test('normal and pure waveform readers return identical bytes and do not touch caller transactions',async t=>{
 const f=fixture(t);seed(f);const store=f.store;
 const initial={snapshot:snapshot(f.db),changes:f.db.prepare('SELECT total_changes() AS n').get()!.n};
 const normal=createWaveformServices(store,{decode:()=>assert.fail('Decode entered'),probe:()=>assert.fail('Probe entered')});
 try{
  const inputs=[f.input,{...f.input,sourceStartFrame:3,sourceEndFrame:19,points:7}],expected=inputs.map(input=>JSON.stringify(normal.handlers['asset.waveform.get'](input)));
  assert.deepEqual({snapshot:snapshot(f.db),changes:f.db.prepare('SELECT total_changes() AS n').get()!.n},initial,'normal construction and reads do not write any attached database');
  const read=(createWaveformHistoryReaders as unknown as (store:Parameters<typeof createWaveformHistoryReaders>[0],options?:unknown)=>import('./helpers/strict-workspace-boundary-types.ts').WaveformHistory)(guarded(f.db).store).handlers['asset.waveform.get'],before=snapshot(f.db);f.db.exec('BEGIN');
  try{inputs.forEach((input,index)=>assert.equal(JSON.stringify(read(input)),expected[index]));assert.equal(f.db.isTransaction,true);}finally{f.db.exec('ROLLBACK');}
  assert.equal(snapshot(f.db),before);
 }finally{await normal.drain();}
});

test('waveform ownership, syntax and source bounds preserve safe refusal without writes',t=>{
 const f=fixture(t);seed(f);const read=(createWaveformHistoryReaders as unknown as (store:Parameters<typeof createWaveformHistoryReaders>[0],options?:unknown)=>import('./helpers/strict-workspace-boundary-types.ts').WaveformHistory)(guarded(f.db).store).handlers['asset.waveform.get'],before=snapshot(f.db);
 for(const input of [{...f.input,projectId:f.otherProjectId},{...f.input,assetId:randomUUID()}] as const)assert.throws(()=>read(input),cause=>(cause as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code==='NOT_FOUND'&&(cause as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).status===404);
 for(const input of [{...f.input,points:2049},{...f.input,points:0},{...f.input,retry:true},{...f.input,sourceStartFrame:-1}] as const)assert.throws(()=>read(input),cause=>(cause as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code==='VALIDATION_ERROR');
 for(const input of [{...f.input,sourceStartFrame:30},{...f.input,sourceEndFrame:31}] as const)assert.throws(()=>read(input),cause=>(cause as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code==='SOURCE_BOUNDS'&&(cause as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).details.availableFrames===30);
 assert.equal(snapshot(f.db),before);
});

for(const damage of ['digest','oversized-cache','source-metadata'] as const)test(`corrupt saved waveform ${damage} returns original safe error without repair or private disclosure`,t=>{
 const f=fixture(t),row=seed(f);
 if(damage==='digest'){(row.data as {peakDigest:string}).peakDigest='f'.repeat(64);f.db.prepare('UPDATE waveform_cache SET data=?,bytes=? WHERE cacheKey=?').run(JSON.stringify(row.data),rowBytes(row),row.cacheKey);}
 if(damage==='oversized-cache'){f.db.exec('PRAGMA ignore_check_constraints=ON');f.db.prepare('UPDATE waveform_cache SET data=? WHERE cacheKey=?').run('PRIVATE_SENTINEL'.repeat(WAVEFORM_CACHE_LIMITS.recordBytes),row.cacheKey);}
 if(damage==='source-metadata')f.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...f.asset,duration:2}),f.asset.id);
 const guard=guarded(f.db),read=(createWaveformHistoryReaders as unknown as (store:Parameters<typeof createWaveformHistoryReaders>[0],options?:unknown)=>import('./helpers/strict-workspace-boundary-types.ts').WaveformHistory)(guard.store).handlers['asset.waveform.get'],before=snapshot(f.db),result=read(f.input);
 assert.equal(result.status,'error');assert.equal(result.reason!.code,'CACHE_CORRUPT');assert.equal(snapshot(f.db),before);
 assert.ok(guard.returned.every(value=>!JSON.stringify(value??null).includes('PRIVATE_SENTINEL')));
});

test('over-capacity captured waveform cache returns unavailable without LRU eviction',t=>{
 const f=fixture(t);seed(f);for(let index=0;index<64;index++)seed(f,'interrupted',{cacheKey:sha(String(index)),sourceSha256:sha(`source-${index}`)});
 const before=snapshot(f.db),result=(createWaveformHistoryReaders as unknown as (store:Parameters<typeof createWaveformHistoryReaders>[0],options?:unknown)=>import('./helpers/strict-workspace-boundary-types.ts').WaveformHistory)(guarded(f.db).store).handlers['asset.waveform.get'](f.input);
 assert.equal(result.status,'error');assert.equal(result.reason!.code,'WAVEFORM_CACHE_UNAVAILABLE');assert.equal(snapshot(f.db),before);
});
