import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {openStore} from '../packages/business/src/db.mjs';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.mjs';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from '../packages/business/src/workspace-schema-v34.ts';
import {initializeWorkspaceSchema36} from '../packages/business/src/workspace-schema-v36.ts';
import {initializeWorkspaceSchema38} from '../packages/business/src/workspace-schema-v38.ts';
import {validateWorkspaceSchema40,initializeWorkspaceSchema40} from '../packages/business/src/workspace-schema-v40.ts';
import {createTimelineServices as realTimelineServices} from '../packages/business/src/timeline.mjs';
import * as realRestorePolicy from '../packages/business/src/workspace-restore-policy.mjs';
import {hash} from '../packages/business/src/services.mjs';
import {AppError,parse,hasRequestNotAppliedProof} from '../packages/contracts/src/index.mjs';
import {VOLUME_ENVELOPE_PROFILE,createVolumeEnvelopeEvaluator} from '../packages/contracts/src/timeline-volume-envelope.mjs';
import {admitTimelineVolumeEnvelopeWrite} from '../packages/business/src/timeline-volume-envelope-admission.ts';
import {rejectTimelineMutation} from '../packages/business/src/timeline-recovery.mjs';
import {open,snapshot,insert} from './workspace-schema26-fixtures.mjs';
// Historical test-only seam retained for bounded synthetic transaction regressions.
// Genuine activation evidence lives in timeline-volume-envelope-owned-startup.test.mjs.
// No other permission check is mocked, and only full validated ordinary40
// synthetic fixtures receive the exemption. Restored/forged profiles refuse.
const fixtures=new WeakSet();
mock.module('../packages/business/src/workspace-restore-policy.mjs',{namedExports:{...realRestorePolicy,
 refuseRestoredOperation(store,operation,input){
  if(fixtures.has(store)){validateWorkspaceSchema40(store.db,{verifyBytes:false});return;}
  return realRestorePolicy.refuseRestoredOperation(store,operation,input);
 }
}});
const {createTimelineServices}=await import('../packages/business/src/timeline.mjs?synthetic40-tests');
const stamp='2026-10-15T00:00:00.000Z';
const envelope=()=>({profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:0,multiplier:1},{frame:10,multiplier:.2},{frame:60,multiplier:.8}]});
function fixture(t,{version=40,missing=false,realPolicy=false,owned=false}={}){
 const root=owned?mkdtempSync(new URL('../.tmp-envelope-mutation-',import.meta.url).pathname):null,ownedStore=owned?openStore(root):null;
 const db=ownedStore?.db??open(':memory:');t.after(()=>{if(ownedStore){ownedStore.close();rmSync(root,{recursive:true,force:true});}else db.close();});
 if(!owned)for(const initialize of [initializeWorkspaceSchemaThrough24,initializeWorkspaceSchema26,initializeWorkspaceSchema28,initializeWorkspaceSchema30,initializeWorkspaceSchema32,initializeWorkspaceSchema34,initializeWorkspaceSchema36,initializeWorkspaceSchema38])initialize(db);
 if(version===40)initializeWorkspaceSchema40(db);
 const projectId=randomUUID();insert(db,'projects',{id:projectId,data:JSON.stringify({id:projectId,name:'Synthetic',revision:1})});
 const store=ownedStore??{db,root:'/not-a-live-workspace',put(table,value){
  db.prepare(`INSERT INTO ${table}(id,projectId,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id,value.projectId,JSON.stringify(value));return value;
 },tx(fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}};
 const required=(table,id)=>{const row=db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);if(!row)throw new AppError('NOT_FOUND','missing',404);return JSON.parse(row.data);};
 if(version===40&&!realPolicy)fixtures.add(store);
 const services=(realPolicy?realTimelineServices:createTimelineServices)(store,{required,hash,now:()=>stamp,check(value,expected){if(value.revision!==expected)throw new AppError('REVISION_CONFLICT','revision',409);}});
 const asset=(fields={})=>store.put('assets',{id:randomUUID(),projectId,name:'Synthetic',mimeType:'video/mp4',duration:20,width:720,height:1280,sha256:'a'.repeat(64),relativePath:'media/synthetic.mp4',hasAudio:true,hasVideo:true,...fields});
 let timeline=missing?null:services.ensure(projectId);
 const call=(operation,fields={},request)=>{const input={projectId,expectedRevision:timeline?.revision??1,requestId:randomUUID(),...fields,...request};const result=services.handlers[operation](parse(operation,input));timeline=result.timeline??result;return {input,result};};
 return {db,store,services,asset,call,projectId,get timeline(){return timeline;},state:()=>snapshot(db)};
}
function rejected(f,operation,fields,code){const before=f.state();assert.throws(()=>f.call(operation,fields),error=>{assert.equal(error.code,code);if(code.startsWith('TIMELINE_VOLUME_ENVELOPE_'))assert.notEqual(error.details?.mutationOutcome,'not_applied','synthetic unowned store cannot create proof');return true;});assert.deepEqual(f.state(),before);}
test('fresh synthetic40 add/update/shrink/clear/Undo/redo preserve exact envelope presence and original replay',t=>{
 const f=fixture(t),source=f.asset(),trackId=f.timeline.tracks[0].id;
 const added=f.call('timeline.clip.add',{assetId:source.id,trackId,startFrame:0,durationFrames:60,volumeEnvelope:envelope()});
 const clipId=added.result.clips[0].id;
 assert.deepEqual(f.timeline.clips[0].volumeEnvelope,envelope());
 rejected(f,'timeline.clip.update',{clipId,patch:{durationFrames:30}},'TIMELINE_VOLUME_ENVELOPE_INVALID');
 f.call('timeline.clip.update',{clipId,patch:{startFrame:20,sourceInFrame:3,durationFrames:80}});
 assert.deepEqual(f.timeline.clips[0].volumeEnvelope,envelope());
 f.call('timeline.clip.update',{clipId,patch:{durationFrames:30,volumeEnvelope:null}});assert.equal(f.timeline.clips[0].volumeEnvelope,null);
 f.call('timeline.undo');assert.deepEqual(f.timeline.clips[0].volumeEnvelope,envelope());
 f.call('timeline.redo');assert.equal(f.timeline.clips[0].volumeEnvelope,null);
 f.call('timeline.clip.remove',{clipId});
 assert.deepEqual(f.services.handlers['timeline.clip.add'](added.input),added.result);
 f.call('timeline.undo');f.call('timeline.clip.update',{clipId,patch:{gain:.4}});
 assert.deepEqual(f.services.handlers['timeline.clip.add'](added.input),added.result);
 rejected(f,'timeline.redo',{},'NOTHING_TO_REDO');
});
test('absent/null and split exact interpolation survive history, fades reject atomically',t=>{
 const f=fixture(t),source=f.asset(),trackId=f.timeline.tracks[0].id;
 f.call('timeline.clip.add',{assetId:source.id,trackId,startFrame:0,durationFrames:60});let clipId=f.timeline.clips[0].id;
 assert.equal(Object.hasOwn(f.timeline.clips[0],'volumeEnvelope'),false);
 f.call('timeline.clip.update',{clipId,patch:{volumeEnvelope:envelope(),fadeInFrames:5,fadeOutFrames:5}});
 rejected(f,'timeline.clip.split',{clipId,atFrame:3},'SPLIT_FADE_BOUNDS');
 const original=f.timeline.clips[0],expected=createVolumeEnvelopeEvaluator(original);
 f.call('timeline.clip.split',{clipId,atFrame:23});const [left,right]=f.timeline.clips;
 assert.equal(left.fadeOutFrames,0);assert.equal(right.fadeInFrames,0);assert.equal(right.sourceInFrame,23);
 const l=createVolumeEnvelopeEvaluator(left),r=createVolumeEnvelopeEvaluator(right);
 assert.equal(l.limitAtSample(23*1600),expected.limitAtSample(23*1600));assert.equal(r.limitAtSample(0),expected.limitAtSample(23*1600));
 // Re-evaluating the partitioned line has ordinary IEEE-754 rounding; the inserted cut itself is exact.
 for(const frame of [0,4,10,22,23,24,40,60])assert.ok(Math.abs((frame<=23?l.limitAtSample(frame*1600):r.limitAtSample((frame-23)*1600))-expected.limitAtSample(frame*1600))<1e-15);
 f.call('timeline.undo');assert.deepEqual(f.timeline.clips[0],original);
 f.call('timeline.undo');assert.equal(Object.hasOwn(f.timeline.clips[0],'volumeEnvelope'),false);
});
test('replacement preserves envelope and rejects incompatible cached audio without probes',t=>{
 const f=fixture(t),a=f.asset(),b=f.asset(),bad=f.asset({hasAudio:false}),trackId=f.timeline.tracks[0].id;
 f.call('timeline.clip.add',{assetId:a.id,trackId,startFrame:0,durationFrames:60,volumeEnvelope:envelope()});const clipId=f.timeline.clips[0].id;
 f.call('timeline.clip.replaceSource',{clipId,assetId:b.id});assert.deepEqual(f.timeline.clips[0].volumeEnvelope,envelope());
 rejected(f,'timeline.clip.replaceSource',{clipId,assetId:bad.id},'TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED');
});
test('old38 explicit null refuses while exact40 admits inherited audio roles',t=>{
 const old=fixture(t,{version:38}),a=old.asset();rejected(old,'timeline.clip.add',{assetId:a.id,trackId:old.timeline.tracks[0].id,startFrame:0,durationFrames:60,volumeEnvelope:null},'TIMELINE_VOLUME_ENVELOPE_WORKSPACE_REQUIRED');
 const fresh=fixture(t),b=fresh.asset();fresh.call('timeline.clip.add',{assetId:b.id,trackId:fresh.timeline.tracks[0].id,startFrame:0,durationFrames:60,volumeEnvelope:envelope(),audioRole:null});assert.equal(fresh.timeline.clips[0].audioRole,null);
});
test('complete timeline/history/response budgets accept262143/262144 and reject262145 bytes independently',()=>{
 for(const field of ['timeline','before','after','response'])for(const size of [262143,262144,262145]){
  const base={volumeEnvelope:null,padding:''};base.padding='x'.repeat(size-Buffer.byteLength(JSON.stringify(base)));
  const timeline=field==='timeline'?base:{clips:[{volumeEnvelope:null}]},options=field==='timeline'?{}:{[field]:base};
  assert.equal(Buffer.byteLength(JSON.stringify(base)),size);
  if(size<=262144)assert.doesNotThrow(()=>admitTimelineVolumeEnvelopeWrite(timeline,options));else assert.throws(()=>admitTimelineVolumeEnvelopeWrite(timeline,options),{code:'TIMELINE_VOLUME_ENVELOPE_LIMIT'});
 }
});
test('new rejection proof requires rollback, exact scope, receipt absence and zero writes',t=>{
 const f=fixture(t),input={projectId:f.projectId,requestId:randomUUID(),expectedRevision:1},operation='timeline.clip.update';
 for(const override of [{ownedScope:()=>false},{writesStarted:true},{callbackFailed:false},{transactionEntered:false},{receiptAbsent:false}]){
  const error=new AppError('TIMELINE_VOLUME_ENVELOPE_LIMIT','limit',409);
  rejectTimelineMutation(f.db,input,error,{operation,ownedScope:()=>true,receiptAbsent:true,writesStarted:false,transactionEntered:true,callbackFailed:true,...override});
  assert.equal(hasRequestNotAppliedProof(error,input,{operation}),false);
 }
 const error=new AppError('TIMELINE_VOLUME_ENVELOPE_LIMIT','limit',409);
 rejectTimelineMutation(f.db,input,error,{operation,ownedScope:()=>true,receiptAbsent:true,writesStarted:false,transactionEntered:true,callbackFailed:true});
 assert.equal(hasRequestNotAppliedProof(error,input,{operation}),true);
 assert.equal(hasRequestNotAppliedProof(error,{...input,projectId:randomUUID()},{operation}),false);
});

test('live dispatch recognizes synthetic40 profile without the historical policy seam',t=>{
 const f=fixture(t,{missing:true,realPolicy:true});
 assert.equal(f.services.ensure(f.projectId).projectId,f.projectId);
});
test('scalar loudness transaction preserves envelope and immutable replay after Undo/removal',async t=>{
 const {readyMixLoudness,mixLoudnessInput}=await import('./fixtures/timeline-mix-loudness-fixtures.mjs');
 const f=fixture(t),source=f.asset(),volumeEnvelope={profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:0,multiplier:1},{frame:30,multiplier:.2}]};
 f.call('timeline.clip.add',{assetId:source.id,trackId:f.timeline.tracks[0].id,startFrame:0,durationFrames:30,volumeEnvelope});
 const before=f.timeline,clip=before.clips[0],input={...mixLoudnessInput,projectId:f.projectId,expectedRevision:before.revision,requestId:randomUUID(),target:{integratedLufs:-24,truePeakCeilingDbtp:-1},snapshotSha256:'b'.repeat(64),candidateDigest:'timeline-loudness-candidate-v1:'+ 'c'.repeat(64)};
 const report=readyMixLoudness(input);report.identity.timelineId=before.id;report.identity.timelineRevision=before.revision;
 const gainMultiplier=report.candidate.gainMultiplier;
 const application={candidateDigest:input.candidateDigest,snapshotSha256:input.snapshotSha256,mixProfile:input.mixProfile,measurementProfile:input.measurementProfile,target:input.target,beforeRevision:before.revision,afterRevision:before.revision+1,gainMultiplier,gains:[{clipId:clip.id,assetId:source.id,beforeGain:1,afterGain:gainMultiplier}],original:report.original,candidate:report.candidate.measurement,meetsTarget:true,meetsTruePeak:true,marginDb:.5};
 let fences=0;const transactions=f.services.createLoudnessApplyTransactions(()=>{});
 const applied=transactions.accept(input,{report,application,finalFence(){fences++;}});
 assert.equal(fences,1);assert.deepEqual(applied.timeline.clips[0].volumeEnvelope,volumeEnvelope);assert.equal(applied.timeline.clips[0].gain,gainMultiplier);
 f.call('timeline.undo',{}, {expectedRevision:applied.timeline.revision});
 f.call('timeline.clip.remove',{clipId:clip.id});
 assert.deepEqual(transactions.prepare(input),{replayed:true,response:applied});
});
test('100-clip complete candidate rejects revision growth before timeline/history/redo/receipt writes',t=>{
 const f=fixture(t),source=f.asset(),timeline=structuredClone(f.timeline);
 timeline.revision=9;timeline.tracks=Array.from({length:12},(_,i)=>({id:randomUUID(),name:'\x01'.repeat(150),kind:'video',orderIndex:i,hidden:false,muted:false}));
 timeline.clips=Array.from({length:100},(_,i)=>({id:randomUUID(),trackId:timeline.tracks[0].id,assetId:source.id,name:'\x01'.repeat(200),startFrame:i*180,durationFrames:180,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,fadeInFrames:0,fadeOutFrames:0,colour:null,volumeEnvelope:{profileId:VOLUME_ENVELOPE_PROFILE,points:Array.from({length:16},(_,j)=>({frame:j*12,multiplier:.12345678901234567}))}}));
 timeline.durationFrames=18000;timeline.subtitles={profileId:'bottom_cjk_v1',cues:Array.from({length:100},(_,i)=>({id:randomUUID(),text:'中'.repeat(20)+'\n'+'中'.repeat(20),startFrame:i*180,durationFrames:180}))};
 let extra=Buffer.byteLength(JSON.stringify(timeline))-262144;assert.ok(extra>20);
 for(const clip of timeline.clips){while(extra>=6&&clip.name.length>1){clip.name=clip.name.slice(1);extra-=6;}if(extra<6)break;}
 if(extra){const track=timeline.tracks[0];track.name=track.name.slice(1)+'a'.repeat(6-extra);}
 assert.equal(Buffer.byteLength(JSON.stringify(timeline)),262144);
 // Direct synthetic seeding, not a production bypass: it is already a complete
 // admitted record. The ordinary edit grows revision9 to10 by one byte.
 f.store.put('timelines',timeline);const before=f.state();
 assert.throws(()=>f.call('timeline.track.update',{trackId:timeline.tracks[0].id,patch:{muted:false}},{expectedRevision:9}),{code:'TIMELINE_VOLUME_ENVELOPE_LIMIT'});
 assert.deepEqual(f.state(),before);
});
test('lazy ensure writes never acquire definite rejection proof even after rollback',t=>{
 const f=fixture(t,{missing:true}),before=f.state();
 assert.throws(()=>f.call('timeline.clip.update',{clipId:randomUUID(),patch:{volumeEnvelope:null}}),error=>{
  assert.equal(error.code,'CLIP_NOT_FOUND');assert.equal(error.details?.mutationOutcome,undefined);return true;
 });
 assert.deepEqual(f.state(),before);assert.equal(f.db.isTransaction,false);
});
test('authentic owned synthetic40 source rejection has exact no-write transaction proof',t=>{
 const f=fixture(t,{owned:true}),source=f.asset({hasAudio:false}),before=f.state(),input={projectId:f.projectId,requestId:randomUUID(),expectedRevision:f.timeline.revision,assetId:source.id,trackId:f.timeline.tracks[0].id,startFrame:0,durationFrames:60,volumeEnvelope:envelope()};
 assert.throws(()=>f.services.handlers['timeline.clip.add'](parse('timeline.clip.add',input)),error=>{
  assert.equal(error.code,'TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED');assert.equal(hasRequestNotAppliedProof(error,input,{operation:'timeline.clip.add'}),true);
  assert.equal(hasRequestNotAppliedProof(error,{...input,requestId:randomUUID()},{operation:'timeline.clip.add'}),false);return true;
 });assert.deepEqual(f.state(),before);
});
test('atomic shrink with replacement keeps requested anchors rather than clamping',t=>{
 const f=fixture(t),source=f.asset(),trackId=f.timeline.tracks[0].id;f.call('timeline.clip.add',{assetId:source.id,trackId,startFrame:0,durationFrames:60,volumeEnvelope:envelope()});
 const clipId=f.timeline.clips[0].id,replacement={profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:4,multiplier:.2},{frame:30,multiplier:.6}]};
 f.call('timeline.clip.update',{clipId,patch:{durationFrames:30,volumeEnvelope:replacement}});assert.deepEqual(f.timeline.clips[0].volumeEnvelope,replacement);
 f.call('timeline.undo');assert.deepEqual(f.timeline.clips[0].volumeEnvelope,envelope());f.call('timeline.redo');assert.deepEqual(f.timeline.clips[0].volumeEnvelope,replacement);
});
