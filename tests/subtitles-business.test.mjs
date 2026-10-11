import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';
import {hasRequestNotAppliedProof,isTimelineMutationResponse,TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256} from '@mioon/contracts';
const at='2026-10-11T12:00:00.000Z';
const tables=['projects','timelines','assets','shots','jobs','versions','exports','timeline_requests','timeline_history','timeline_history_cursors','edit_tasks'];
async function fixture(t){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-subtitles-business-'));let store=openStore(root),services=createServices(store,new Map());
 const f={root,get store(){return store;},call:(operation,input)=>services.call(operation,input),restart(){store.close();store=openStore(root);services=createServices(store,new Map());},
 capture:()=>JSON.stringify(tables.map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
 asset(patch={}){const id=randomUUID();return store.put('assets',{id,projectId:f.projectId,name:'Fixture',mimeType:'video/mp4',duration:20,width:720,height:1280,hasVideo:true,hasAudio:true,sha256:'a'.repeat(64),relativePath:`media/${id}.fixture`,provenance:'user-import',createdAt:at,...patch});}};
 f.projectId=(await f.call('project.create',{name:'Manual subtitles'})).id;f.otherId=(await f.call('project.create',{name:'Foreign project'})).id;
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return f;
}
const request=(f,timeline,patch={})=>({projectId:f.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),...patch});
async function populated(f){const timeline=await f.call('timeline.get',{projectId:f.projectId}),source=f.asset();return f.call('timeline.clip.add',request(f,timeline,{assetId:source.id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:300}));}
async function add(f,timeline,patch={}){return f.call('timeline.subtitle.add',request(f,timeline,{text:'原始手动字幕',startFrame:0,durationFrames:30,...patch}));}
async function rejected(f,operation,input,code,{proof=true}={}){const before=f.capture();await assert.rejects(f.call(operation,input),error=>{assert.equal(error.code,code);assert.equal(hasRequestNotAppliedProof(error,input,{operation}),proof);return true;});assert.equal(f.capture(),before);}

test('manual subtitles save exact complete records through shared history and no media/provider work',async t=>{
 const f=await fixture(t),events=[];const stop=onMediaProcess(event=>events.push(event));t.after(stop);
 let timeline=await populated(f);assert.equal(Object.hasOwn(timeline,'subtitles'),false);const before=f.capture();
 const input=request(f,timeline,{text:'你好 World\n100% {literal}',startFrame:30,durationFrames:60});timeline=await f.call('timeline.subtitle.add',input);
 assert.ok(isTimelineMutationResponse('timeline.subtitle.add',input,timeline));assert.equal(timeline.subtitles.profileId,TIMELINE_SUBTITLE_PROFILE_ID);assert.match(timeline.subtitles.cues[0].id,/^[a-f0-9-]{36}$/);
 assert.equal(timeline.subtitles.cues[0].text,input.text);assert.equal(timeline.durationFrames,300);assert.notEqual(f.capture(),before);
 const cueId=timeline.subtitles.cues[0].id;timeline=await f.call('timeline.subtitle.update',request(f,timeline,{cueId,patch:{text:'修改后',startFrame:35,durationFrames:55}}));
 assert.deepEqual(timeline.subtitles.cues[0],{id:cueId,text:'修改后',startFrame:35,durationFrames:55});
 timeline=await f.call('timeline.subtitle.remove',request(f,timeline,{cueId}));assert.deepEqual(timeline.subtitles,{profileId:TIMELINE_SUBTITLE_PROFILE_ID,cues:[]});
 const history=await f.call('timeline.history.get',{projectId:f.projectId});assert.equal(history.length,4);assert.equal(history.undoEntry.operation,'timeline.subtitle.remove');
 assert.deepEqual(events,[]);assert.equal(f.store.db.prepare('SELECT count(*) n FROM jobs').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM exports').get().n,0);
});

test('undo actually removes the optional field from old snapshots and redo restores exact cue identity',async t=>{
 const f=await fixture(t);let timeline=await populated(f);const before=JSON.stringify(f.store.db.prepare('SELECT * FROM timeline_history').all());
 timeline=await add(f,timeline);const subtitles=structuredClone(timeline.subtitles);let input=request(f,timeline);timeline=await f.call('timeline.undo',input);
 assert.equal(Object.hasOwn(timeline,'subtitles'),false);const stored=f.store.get('timelines',timeline.id);assert.equal(Object.hasOwn(stored,'subtitles'),false);
 assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM timeline_history WHERE position=1').all()),before);
 timeline=await f.call('timeline.redo',request(f,timeline));assert.deepEqual(timeline.subtitles,subtitles);
 timeline=await f.call('timeline.undo',request(f,timeline));timeline=await f.call('timeline.track.update',request(f,timeline,{trackId:timeline.tracks[0].id,patch:{name:'Branch'}}));
 assert.equal(Object.hasOwn(timeline,'subtitles'),false);await rejected(f,'timeline.redo',request(f,timeline),'NOTHING_TO_REDO');
});

test('overlap, media bounds, count limits and stale CAS reject atomically with exact bound proofs',async t=>{
 const f=await fixture(t);let timeline=await populated(f);timeline=await add(f,timeline,{startFrame:30,durationFrames:30});
 await rejected(f,'timeline.subtitle.add',request(f,timeline,{text:'交叠',startFrame:59,durationFrames:1}),'SUBTITLE_OVERLAP');
 await rejected(f,'timeline.subtitle.add',request(f,timeline,{text:'超出',startFrame:299,durationFrames:2}),'SUBTITLE_BOUNDS');
 await rejected(f,'timeline.subtitle.update',request(f,timeline,{cueId:timeline.subtitles.cues[0].id,patch:{durationFrames:300}}),'SUBTITLE_BOUNDS');
 await rejected(f,'timeline.subtitle.remove',request(f,timeline,{cueId:randomUUID()}),'SUBTITLE_NOT_FOUND');
 await rejected(f,'timeline.subtitle.add',request(f,timeline,{expectedRevision:1,text:'过期',startFrame:60,durationFrames:1}),'REVISION_CONFLICT');
 timeline=await add(f,timeline,{text:'首尾相接',startFrame:60,durationFrames:1});
 const full=structuredClone(timeline);full.subtitles.cues=Array.from({length:100},(_,startFrame)=>({id:randomUUID(),text:'字',startFrame,durationFrames:1}));f.store.put('timelines',full);
 await rejected(f,'timeline.subtitle.add',request(f,full,{text:'太多',startFrame:100,durationFrames:1}),'SUBTITLE_LIMIT');
});

test('clip shorten, remove and move cannot strand existing subtitles and leave history/redo/receipts unchanged',async t=>{
 const f=await fixture(t);let timeline=await populated(f);timeline=await add(f,timeline,{startFrame:270,durationFrames:30});const clipId=timeline.clips[0].id;
 await rejected(f,'timeline.clip.update',request(f,timeline,{clipId,patch:{durationFrames:299}}),'SUBTITLE_BOUNDS');
 await rejected(f,'timeline.clip.remove',request(f,timeline,{clipId}),'SUBTITLE_BOUNDS');
 // A move still has a media-derived aggregate; it may not pull its end before a cue.
 timeline=await f.call('timeline.clip.update',request(f,timeline,{clipId,patch:{startFrame:30,durationFrames:270}}));
 await rejected(f,'timeline.clip.update',request(f,timeline,{clipId,patch:{startFrame:0}}),'SUBTITLE_BOUNDS');
 timeline=await f.call('timeline.subtitle.remove',request(f,timeline,{cueId:timeline.subtitles.cues[0].id}));timeline=await f.call('timeline.clip.remove',request(f,timeline,{clipId}));assert.equal(timeline.durationFrames,0);assert.deepEqual(timeline.subtitles.cues,[]);
});

test('exact replay survives later update/remove/undo/restart and changed request reuse conflicts across operation namespace',async t=>{
 const f=await fixture(t);let timeline=await populated(f);const input=request(f,timeline,{text:'冻结回执',startFrame:1,durationFrames:30}),saved=await f.call('timeline.subtitle.add',input);
 const bytes=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
 timeline=await f.call('timeline.subtitle.remove',request(f,saved,{cueId:saved.subtitles.cues[0].id}));timeline=await f.call('timeline.undo',request(f,timeline));f.restart();
 const before=f.capture();assert.deepEqual(await f.call('timeline.subtitle.add',input),saved);assert.equal(f.capture(),before);assert.equal(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,bytes);
 await rejected(f,'timeline.subtitle.add',{...input,text:'changed'},'IDEMPOTENCY_CONFLICT',{proof:false});
 await rejected(f,'timeline.track.add',{projectId:f.projectId,expectedRevision:timeline.revision,requestId:input.requestId,kind:'audio'},'IDEMPOTENCY_CONFLICT',{proof:false});
 await rejected(f,'timeline.subtitle.add',{...input,projectId:f.otherId},'IDEMPOTENCY_CONFLICT',{proof:false});
});

test('frozen render snapshots bind exact subtitle state and font without reading media or font files at acceptance',async t=>{
 const f=await fixture(t);let timeline=await populated(f);const legacyInput=request(f,timeline,{purpose:'preview'}),legacy=await f.call('timeline.render',legacyInput);
 assert.equal(Object.hasOwn(legacy.snapshot,'subtitleProfile'),false);const legacyBytes=JSON.stringify(legacy);
 timeline=await add(f,timeline);const renderInput=request(f,timeline,{purpose:'export'}),render=await f.call('timeline.render',renderInput);
 assert.deepEqual(render.snapshot.subtitleProfile,{profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256});assert.deepEqual(render.snapshot.timeline.subtitles,timeline.subtitles);
 timeline=await f.call('timeline.subtitle.update',request(f,timeline,{cueId:timeline.subtitles.cues[0].id,patch:{text:'new'}}));f.restart();
 assert.equal(JSON.stringify(await f.call('timeline.render',legacyInput)),legacyBytes);assert.deepEqual(await f.call('timeline.render',renderInput),render);
});

test('receipt failure rolls back cue, revision, history, redo branch and key without a false not-applied proof',async t=>{
 const f=await fixture(t);let timeline=await populated(f);timeline=await add(f,timeline);timeline=await f.call('timeline.undo',request(f,timeline));
 f.store.db.exec("CREATE TRIGGER fail_subtitle_receipt BEFORE INSERT ON timeline_requests BEGIN SELECT RAISE(ABORT,'injected receipt failure');END");const before=f.capture();
 await assert.rejects(add(f,timeline),error=>{assert.equal(error.details?.mutationOutcome,undefined);return /injected receipt failure/.test(error.message);});assert.equal(f.capture(),before);
 f.store.db.exec('DROP TRIGGER fail_subtitle_receipt');timeline=await f.call('timeline.redo',request(f,timeline));assert.equal(timeline.subtitles.cues.length,1);
});

test('legitimate escaped records over128KiB support ordinary edits, history, explicit replacement, and immutable replay',async t=>{
 const f=await fixture(t);let timeline=await populated(f);const source=timeline.clips[0].assetId,template=timeline.clips[0];
 timeline.tracks=Array.from({length:12},(_,orderIndex)=>({id:randomUUID(),name:'\0'.repeat(150),kind:'video',orderIndex,hidden:false,muted:false}));
 timeline.clips=Array.from({length:100},(_,index)=>({...template,id:randomUUID(),trackId:timeline.tracks[index%12].id,assetId:source,name:'\0'.repeat(200),startFrame:index,durationFrames:1}));timeline.durationFrames=100;
 timeline.subtitles={profileId:TIMELINE_SUBTITLE_PROFILE_ID,cues:Array.from({length:100},(_,startFrame)=>({id:randomUUID(),text:'中'.repeat(20)+'\n'+'文'.repeat(20),startFrame,durationFrames:1}))};
 assert.ok(Buffer.byteLength(JSON.stringify(timeline))>128*1024);f.store.put('timelines',timeline);
 const edit=request(f,timeline,{cueId:timeline.subtitles.cues[0].id,patch:{text:'updated'}}),saved=await f.call('timeline.subtitle.update',edit);assert.ok(Buffer.byteLength(JSON.stringify(saved))>128*1024);
 timeline=await f.call('timeline.undo',request(f,saved));timeline=await f.call('timeline.redo',request(f,timeline));assert.equal(timeline.subtitles.cues[0].text,'updated');
 const replacement=f.asset(),replace=request(f,timeline,{clipId:timeline.clips[0].id,assetId:replacement.id});timeline=await f.call('timeline.clip.replaceSource',replace);assert.equal(timeline.clips[0].assetId,replacement.id);
 f.restart();assert.deepEqual(await f.call('timeline.subtitle.update',edit),saved);assert.deepEqual(await f.call('timeline.clip.replaceSource',replace),timeline);
});


test('format eligibility reads mixed legacy and subtitle history without writing or leaking present cues into old snapshots',async t=>{
 const f=await fixture(t);let timeline=await populated(f);timeline=await add(f,timeline,{startFrame:270,durationFrames:30});
 for(const direction of [null,'timeline.undo','timeline.redo']){
  if(direction)timeline=await f.call(direction,request(f,timeline));
  const before=f.capture(),response=await f.call('timeline.format.get',{projectId:f.projectId});
  assert.equal(response.eligible,false);assert.ok(response.blockedReasons.includes('HISTORY_PRESENT'));assert.ok(response.blockedReasons.includes('REQUEST_HISTORY'));assert.equal(response.timelineRevision,timeline.revision);assert.equal(f.capture(),before);
  assert.equal(Object.hasOwn(timeline,'subtitles'),direction!=='timeline.undo');
 }
});
