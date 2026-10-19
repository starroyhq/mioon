import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openOpacityCandidateStore} from '../packages/business/src/opacity-candidate-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {captureOpacityTimelineRecord} from '../packages/contracts/src/timeline-opacity-persistence.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {mkdtempPortable} from './helpers/temp-root.ts';

const stamp='2026-10-16T00:00:00.000Z';
const bytes=(value: unknown)=>Buffer.byteLength(JSON.stringify(value));

test('actual42 accepts revision digit growth from 262143 to the complete 262144-byte record limit',async (t: TestContext)=>{
  const root=mkdtempPortable('mioon-opacity-record-limit-');
  const store=openOpacityCandidateStore(root),media: unknown[]=[];
  let providerTouches=0;
  const off=onMediaProcess(event=>media.push(event));
  const services=createServices(store,new Proxy(new Map(),{get(){providerTouches++;throw Error('No provider is needed for metadata edits');}}));
  t.after(async()=>{try{await services.drain();store.close();assert.equal(providerTouches,0);assert.deepEqual(media,[]);}finally{off();rmSync(root,{recursive:true,force:true});}});
  const projectId=randomUUID(),assetId=randomUUID(),trackId=randomUUID();
  const opacityEnvelope={profileId:'mioon-clip-linear-opacity-v1',points:Array.from({length:7},(_,index)=>({frame:index*30,opacity:.12345678901234566}))};
  const volumeEnvelope={profileId:'mioon-clip-linear-attenuation-v1',points:Array.from({length:16},(_,index)=>({frame:index*12,multiplier:.12345678901234566}))};
  const timeline={id:randomUUID(),projectId,revision:9,fps:30,width:720,height:1280,
    tracks:[{id:trackId,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
    clips:Array.from({length:100},(_,index)=>({id:randomUUID(),assetId,trackId,name:'c',startFrame:index*180,durationFrames:180,sourceInFrame:0,
      rect:{x:0,y:0,width:720,height:1280},gain:1,audioRole:'human',colour:null,volumeEnvelope:structuredClone(volumeEnvelope),opacityEnvelope:structuredClone(opacityEnvelope)})),
    durationFrames:18000,createdAt:stamp,updatedAt:stamp};
  // Existing clip names permit 200 code units. JSON escapes each control
  // character to six bytes; ASCII supplies the exact remaining byte count.
  // No extra fields, oversized strings or relaxed contract are needed.
  let remaining=262143-bytes(timeline);assert.ok(remaining>0);
  for(const clip of timeline.clips){
    const escaped=Math.min(199,Math.floor(remaining/6));clip.name+='\u0001'.repeat(escaped);remaining-=escaped*6;
    const plain=Math.min(200-clip.name.length,remaining);clip.name+='x'.repeat(plain);remaining-=plain;
  }
  assert.equal(remaining,0);assert.equal(bytes(timeline),262143);
  assert.deepEqual(captureOpacityTimelineRecord(timeline,{projectId}).record,timeline);
  store.put('projects',{id:projectId,name:'Synthetic limit metadata',revision:1,createdAt:stamp,updatedAt:stamp});
  store.put('assets',{id:assetId,projectId,name:'Never opened',mimeType:'video/mp4',duration:6,width:720,height:1280,hasVideo:true,hasAudio:true,
    sha256:'a'.repeat(64),relativePath:'media/never-opened.mp4',createdAt:stamp});
  store.put('timelines',timeline);
  const input={projectId,clipId:timeline.clips[0].id,patch:{opacityEnvelope:structuredClone(opacityEnvelope)},expectedRevision:9,requestId:randomUUID()};
  const saved=await services.call('timeline.clip.update',input) as typeof timeline & {revision: number};
  assert.equal(saved.revision,10);assert.equal(bytes(saved),262144);
  assert.deepEqual(captureOpacityTimelineRecord(saved,{projectId}).record,saved);
  assert.deepEqual(saved.clips,timeline.clips);
  assert.deepEqual(store.get('timelines',timeline.id),saved);
  const receipt=store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId) as {response: string};
  assert.equal(Buffer.byteLength(receipt.response),262144);assert.equal(receipt.response,JSON.stringify(saved));
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM timeline_history').get() as {n: number}).n,1);
  assert.equal((store.db.prepare('SELECT position FROM timeline_history_cursors WHERE projectId=?').get(projectId) as {position: number}).position,1);
  assert.deepEqual(await services.call('timeline.clip.update',input),saved);
});
