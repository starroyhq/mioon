import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
 CLIP_TRANSITION_PROFILE,canonicalClipTransition,clipTransitionFits,clipTransitionRegions,clipTransitionRoom,clipTransitionSides,staleClipTransitions,
 validateClipTransition,type ClipTransition,type ClipTransitionKind,type TransitionSource,
} from '../packages/contracts/src/timeline-clip-transition.ts';
import {isTimelineMutationResponse} from '../packages/contracts/src/timeline-acknowledgement.ts';
import {openStore,classifyCurrentWorkspaceSchema} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {downgradeReviewedWorkspace} from './helpers/reviewed-schema-layers.ts';
import {CURRENT_ORDINARY_ROLE,CURRENT_RESTORED_ROLE} from './helpers/workspace-schema-current.ts';
import {TIMELINE_COLOUR_PREFLIGHT_MESSAGES} from '../packages/contracts/src/timeline-colour.ts';
import {freezeTimelineSnapshot} from '../packages/business/src/timeline-inputs.ts';
import {assertTransitionImageBudget} from '../packages/business/src/timeline-transition-filter.ts';
import {createTimelinePreflightServices} from '../packages/business/src/timeline-preflight.ts';
import {png,sha,imageColour,stamp,timelineFixture} from './helpers/timeline-image-fixtures.ts';

type Rec=Record<string,any>;
const make=(kind: ClipTransitionKind='dissolve',durationFrames=20): ClipTransition=>({profileId:CLIP_TRANSITION_PROFILE,kind,durationFrames});
const dissolve=make();
const invalid=(error: unknown)=>(error as {code?: unknown}).code==='INVALID_CLIP_TRANSITION';

test('transition values are validated exactly and never normalized',()=>{
 assert.equal(validateClipTransition(dissolve),dissolve);
 assert.equal(validateClipTransition(null),null);
 for(const kind of ['dissolve','dipToBlack','wipeLeft','wipeRight','pushLeft','pushRight'] as const)assert.equal(validateClipTransition(make(kind,2))?.kind,kind);
 for(const [label,value] of [
  ['profile',{...dissolve,profileId:'other'}],['kind',{...dissolve,kind:'fade'}],['short',make('dissolve',1)],['long',make('dissolve',61)],
  ['fractional',make('dissolve',10.5)],['extra key',{...dissolve,audio:true}],['missing key',{profileId:CLIP_TRANSITION_PROFILE,kind:'dissolve'}],['array',[]],
 ] as const)assert.throws(()=>validateClipTransition(value),invalid,label);
 assert.deepEqual(Object.keys(canonicalClipTransition({durationFrames:20,kind:'dissolve',profileId:CLIP_TRANSITION_PROFILE} as never)!),['profileId','kind','durationFrames']);
 // An odd frame goes after the cut, to the outgoing clip's tail.
 assert.deepEqual([clipTransitionSides(20),clipTransitionSides(15),clipTransitionSides(2)],[{before:10,after:10},{before:7,after:8},{before:1,after:1}]);
});

test('a transition needs a cut, source handles on both sides and room beside its neighbours',()=>{
 // Two 300-frame videos and a still; A [0,60) at source 0, B [60,120) at source 30.
 const sources=(assetId: string): TransitionSource|null=>assetId==='still'?{image:true,frames:0}:assetId==='video'?{image:false,frames:300}:null;
 const clip=(id: string,startFrame: number,durationFrames: number,sourceInFrame: number,extra: Rec={})=>({id,trackId:'v',assetId:'video',startFrame,durationFrames,sourceInFrame,...extra});
 const a=clip('a',0,60,0),b=clip('b',60,60,30);
 assert.equal(clipTransitionRoom([a,b],a,sources),0,'no cut before the first clip');
 assert.equal(clipTransitionRoom([a,b],b,sources),60);
 assert.equal(clipTransitionRoom([a,{...b,sourceInFrame:4}],{...b,sourceInFrame:4},sources),9,'four lead-in frames allow 4 before the cut');
 const tail={...a,sourceInFrame:236};
 assert.equal(clipTransitionRoom([tail,b],b,sources),8,'four tail frames allow 4 after the cut, so 8 frames in all');
 assert.equal(clipTransitionRoom([{...tail,assetId:'still',sourceInFrame:0},{...b,assetId:'still',sourceInFrame:0}],{...b,assetId:'still',sourceInFrame:0},sources),60,'stills repeat');
 assert.equal(clipTransitionRoom([a,{...b,trackId:'other'}],{...b,trackId:'other'},sources),0,'another track is no cut');
 assert.equal(clipTransitionRoom([a,{...b,startFrame:61}],{...b,startFrame:61},sources),0,'a gap is no cut');
 // A short outgoing clip that already starts with a transition keeps room for both.
 const z=clip('z',0,10,0),short=clip('a',10,25,30,{transitionIn:make('dissolve',20)}),next=clip('b',35,60,30);
 assert.equal(clipTransitionRoom([z,short,next],next,sources),31,'25 frames minus the 10 after the earlier cut leave 15 before this one');
 assert.equal(clipTransitionFits([z,short,next],next,32,sources),false);
 // Pruning reads each track left to right: the earlier transition stays.
 const crowded=[z,short,{...next,transitionIn:make('dissolve',40)}];
 assert.deepEqual(staleClipTransitions({durationFrames:95,clips:crowded},sources),['b']);
 assert.deepEqual(staleClipTransitions({durationFrames:95,clips:[z,short,{...next,transitionIn:make('dissolve',30)}]},sources),[]);
 assert.deepEqual(staleClipTransitions({durationFrames:120,clips:[a,{...b,transitionIn:{...dissolve,kind:'fade'}}]},sources),['b'],'an unreadable transition is stale');
 assert.throws(()=>clipTransitionRegions({durationFrames:95,clips:crowded},sources),invalid,'a saved timeline never renders a stale transition');
 assert.deepEqual(clipTransitionRegions({durationFrames:120,clips:[a,{...b,transitionIn:dissolve}]},sources),
  [{trackId:'v',outgoingId:'a',incomingId:'b',kind:'dissolve',durationFrames:20,startFrame:50,cutFrame:60,endFrame:70}]);
 // Transition edges count towards the 200 composition segments.
 const many=Array.from({length:100},(_,index)=>clip(`c${index}`,index*20,20,30,index?{transitionIn:make('dissolve',2)}:{}));
 // 100 clips make 100 segments; each kept transition adds two edges, so 50 fit
 // and the 49 latest cuts lose theirs, latest first.
 assert.deepEqual(staleClipTransitions({durationFrames:2000,clips:many},sources),Array.from({length:49},(_,index)=>`c${99-index}`));
});

async function fixture(t: test.TestContext){
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-clip-transition-')));
 let store=openStore(root) as unknown as {db: import('node:sqlite').DatabaseSync;put(table: string,value: Rec): Rec;close(): void};
 let services=createServices(store as never,new Map()) as unknown as {call(operation: string,input: unknown): Promise<Rec>};
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const project=await services.call('project.create',{name:'Transitions'}),projectId=project.id as string;
 const asset=(mimeType: string)=>store.put('assets',{id:randomUUID(),projectId,name:mimeType,mimeType,duration:10,width:640,height:360,hasAudio:mimeType!=='image/png',hasVideo:mimeType!=='audio/wav',
  provenance:'user-import',sha256:'a'.repeat(64),relativePath:`media/${randomUUID()}.fixture`,createdAt:new Date().toISOString()});
 let timeline=await services.call('timeline.get',{projectId});
 const f={root,projectId,asset,get timeline(){return timeline;},get store(){return store;},
  input:(fields: Rec)=>({projectId,expectedRevision:timeline.revision,requestId:randomUUID(),...fields}),
  async raw(operation: string,input: Rec){const response=await services.call(operation,input);timeline=response.timeline??response;return response;},
  call(operation: string,fields: Rec={}){return f.raw(operation,f.input(fields));},
  inspect:()=>services.call('timeline.inspect',{projectId}),
  clip:(name: string)=>timeline.clips.find((item: Rec)=>item.name===name),
  async reopen(){store.close();store=openStore(root) as never;services=createServices(store as never,new Map()) as never;timeline=await services.call('timeline.get',{projectId});},
  /** A [0,60) at source 0 and B [60,120) at source 30 on the first video track. */
  async pair(){
   const video=timeline.tracks.find((track: Rec)=>track.kind==='video'),assetId=asset('video/mp4').id;
   await f.call('timeline.clip.add',{trackId:video.id,assetId,name:'A',startFrame:0,durationFrames:60});
   await f.call('timeline.clip.add',{trackId:video.id,assetId,name:'B',startFrame:60,durationFrames:60,sourceInFrame:30});
   return {a:f.clip('A'),b:f.clip('B')};
  },
 };
 return f;
}
const notApplied=(code: string)=>(error: Rec)=>error.code===code&&error.details?.mutationOutcome==='not_applied'&&error.details?.operation==='timeline.clip.setTransition';

test('setTransition saves one edit, replays exactly, undoes and clears',async t=>{
 const f=await fixture(t),{b}=await f.pair();
 const revision=f.timeline.revision,input=f.input({clipId:b.id,transition:dissolve});
 const response=await f.raw('timeline.clip.setTransition',input);
 assert.deepEqual(Object.keys(response).sort(),['clipId','operation','previousTransition','requestId','timeline','transition']);
 assert.deepEqual([response.operation,response.clipId,response.previousTransition,response.timeline.revision],['timeline.clip.setTransition',b.id,null,revision+1]);
 assert.deepEqual(response.transition,dissolve);assert.deepEqual(f.clip('B').transitionIn,dissolve);
 assert.equal(isTimelineMutationResponse('timeline.clip.setTransition',input,response),true);
 assert.deepEqual(await f.raw('timeline.clip.setTransition',input),response,'exact replay');
 assert.deepEqual((await f.inspect()).clips.find((clip: Rec)=>clip.id===b.id).transitionIn,{kind:'dissolve',durationFrames:20},'Mio reads the transition');
 const changed=await f.call('timeline.clip.setTransition',{clipId:b.id,transition:make('pushLeft',30)});
 assert.deepEqual([changed.previousTransition,changed.transition],[dissolve,make('pushLeft',30)]);
 await f.call('timeline.undo');assert.deepEqual(f.clip('B').transitionIn,dissolve,'undo restores the previous one');
 await f.call('timeline.redo');assert.deepEqual(f.clip('B').transitionIn,make('pushLeft',30));
 const cleared=await f.call('timeline.clip.setTransition',{clipId:b.id,transition:null});
 assert.deepEqual([cleared.previousTransition,cleared.transition,Object.hasOwn(f.clip('B'),'transitionIn')],[make('pushLeft',30),null,false]);
});

test('setTransition refuses before writing and proves it',async t=>{
 const f=await fixture(t),{a,b}=await f.pair(),audio=f.timeline.tracks.find((track: Rec)=>track.kind==='audio');
 await f.call('timeline.clip.add',{trackId:audio.id,assetId:f.asset('audio/wav').id,name:'S',startFrame:0,durationFrames:60});
 const sound=f.clip('S'),before=structuredClone(f.timeline);
 await f.call('timeline.clip.setTransition',{clipId:b.id,transition:dissolve});
 for(const [code,fields] of [
  ['CLIP_TRANSITION_UNCHANGED',{clipId:b.id,transition:dissolve}],
  ['CLIP_TRANSITION_UNSUPPORTED',{clipId:sound.id,transition:dissolve}],
  ['CLIP_TRANSITION_NO_CUT',{clipId:a.id,transition:dissolve}],
  ['CLIP_NOT_FOUND',{clipId:randomUUID(),transition:dissolve}],
 ] as const){
  const revision=f.timeline.revision;
  await assert.rejects(f.call('timeline.clip.setTransition',fields),notApplied(code),code);
  assert.equal((await f.raw('timeline.get',{projectId:f.projectId})).revision,revision,`${code} writes nothing`);
 }
 // Malformed values never reach the timeline: the operation schema refuses them.
 for(const transition of [{...dissolve,durationFrames:1},{...dissolve,durationFrames:61},{...dissolve,kind:'fade'}]){
  const revision=f.timeline.revision;
  await assert.rejects(f.call('timeline.clip.setTransition',{clipId:b.id,transition}));
  assert.equal((await f.raw('timeline.get',{projectId:f.projectId})).revision,revision,'a malformed transition writes nothing');
 }
 // A lead-in of 20 source frames allows 20 frames before the cut: 41 in all.
 await f.call('timeline.clip.update',{clipId:b.id,patch:{sourceInFrame:20}});
 await assert.rejects(f.call('timeline.clip.setTransition',{clipId:b.id,transition:make('wipeLeft',50)}),
  (error: Rec)=>notApplied('CLIP_TRANSITION_ROOM')(error)&&error.details.maxFrames===41);
 await assert.rejects(f.raw('timeline.clip.setTransition',{...f.input({clipId:b.id,transition:null}),expectedRevision:before.revision}),notApplied('REVISION_CONFLICT'));
});

test('a transition past the segment bound is refused and proves it',async t=>{
 const f=await fixture(t),video=f.timeline.tracks.find((track: Rec)=>track.kind==='video'),assetId=f.asset('video/mp4').id;
 for(let index=0;index<100;index++)await f.call('timeline.clip.add',{trackId:video.id,assetId,name:`c${index}`,startFrame:index*20,durationFrames:20,sourceInFrame:30});
 // 100 clips make 100 segments and each 2-frame transition adds two edges: 50 fit.
 for(let index=1;index<=50;index++)await f.call('timeline.clip.setTransition',{clipId:f.clip(`c${index}`).id,transition:make('dissolve',2)});
 const revision=f.timeline.revision;
 await assert.rejects(f.call('timeline.clip.setTransition',{clipId:f.clip('c51').id,transition:make('dissolve',2)}),
  (error: Rec)=>notApplied('CLIP_TRANSITION_LIMIT')(error)&&error.details.maxSegments===200);
 assert.equal((await f.raw('timeline.get',{projectId:f.projectId})).revision,revision,'the refusal writes nothing');
 assert.equal(Object.hasOwn(f.clip('c51'),'transitionIn'),false);
});

test('edits keep transitions that still fit and remove the ones they break',async t=>{
 const f=await fixture(t),{a,b}=await f.pair();
 await f.call('timeline.clip.setTransition',{clipId:b.id,transition:dissolve});
 // Splitting the incoming clip keeps the cut; the new inner cut is plain.
 await f.call('timeline.clip.split',{clipId:b.id,atFrame:100});
 const right=f.timeline.clips.find((clip: Rec)=>clip.startFrame===100);
 assert.deepEqual([f.clip('B').transitionIn,Object.hasOwn(right,'transitionIn')],[dissolve,false]);
 // Splitting the outgoing clip keeps the cut too: its right part is adjacent now.
 await f.call('timeline.clip.split',{clipId:a.id,atFrame:30});
 assert.deepEqual(f.clip('B').transitionIn,dissolve);
 // Less lead-in than the transition needs before the cut removes it; undo brings it back.
 const response=await f.call('timeline.clip.update',{clipId:b.id,patch:{sourceInFrame:5}});
 assert.equal(Object.hasOwn(response.clips.find((clip: Rec)=>clip.id===b.id),'transitionIn'),false,'the edit stands without the transition');
 await f.call('timeline.undo');assert.deepEqual(f.clip('B').transitionIn,dissolve);
 // A move away from the cut removes it as well.
 await f.call('timeline.clip.update',{clipId:b.id,patch:{startFrame:200}});
 assert.equal(Object.hasOwn(f.clip('B'),'transitionIn'),false);
 await f.call('timeline.undo');
 // Removing the outgoing clip leaves no cut.
 const outgoing=f.timeline.clips.find((clip: Rec)=>clip.startFrame===30);
 await f.call('timeline.clip.remove',{clipId:outgoing.id});
 assert.equal(Object.hasOwn(f.clip('B'),'transitionIn'),false);
});

test('schema70 refuses transitions; schema72 keeps them through backup and restore',async t=>{
 const f=await fixture(t),{b}=await f.pair(),clipId=b.id;
 downgradeReviewedWorkspace(f.store.db,70);
 assert.equal(readCurrentWorkspaceRole(f.store.db),'ordinary-70');
 await assert.rejects(f.call('timeline.clip.setTransition',{clipId,transition:dissolve}),notApplied('CLIP_TRANSITION_WORKSPACE_REQUIRED'));
 // A transition written into a schema70 timeline fails classification.
 const row=f.store.db.prepare('SELECT id,data FROM timelines WHERE projectId=?').get(f.projectId) as {id: string;data: string},data=JSON.parse(row.data);
 data.clips[1].transitionIn=dissolve;f.store.db.prepare('UPDATE timelines SET data=? WHERE id=?').run(JSON.stringify(data),row.id);
 assert.throws(()=>classifyCurrentWorkspaceSchema(f.store.db as never),(error: Rec)=>error.code==='RESTORE_SCHEMA_UNSUPPORTED');
 f.store.db.prepare('UPDATE timelines SET data=? WHERE id=?').run(row.data,row.id);
 await f.reopen();
 assert.equal(readCurrentWorkspaceRole(f.store.db),CURRENT_ORDINARY_ROLE,'opening upgrades it again');
 await f.call('timeline.clip.setTransition',{clipId,transition:dissolve});
 f.store.close();
 const base=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-clip-transition-backup-'))),backup=path.join(base,'backup'),restored=path.join(base,'restored');
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 assert.equal((await createWorkspaceBackup({source:f.root,destination:backup})).integrity,'verified');
 await restoreWorkspaceBackup({directory:backup,destination:restored});
 const copy=openStore(restored) as unknown as {db: import('node:sqlite').DatabaseSync;close(): void};
 try{
  assert.equal(readCurrentWorkspaceRole(copy.db),CURRENT_RESTORED_ROLE);
  const saved=JSON.parse((copy.db.prepare('SELECT data FROM timelines WHERE projectId=?').get(f.projectId) as {data: string}).data);
  assert.deepEqual(saved.clips.find((clip: Rec)=>clip.id===clipId).transitionIn,dissolve);
  const services=createServices(copy as never,new Map()) as unknown as {call(operation: string,input: unknown): Promise<Rec>};
  await assert.rejects(services.call('timeline.clip.setTransition',{projectId:f.projectId,expectedRevision:saved.revision,requestId:randomUUID(),clipId,transition:null}),
   (error: Rec)=>typeof error.code==='string'&&error.code.startsWith('RESTORE'),'a restored copy refuses transition edits');
 }finally{copy.close();}
 await f.reopen();
});

test('a transition between images counts both towards the managed image budget',async t=>{
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-transition-images-')));
 const store=openStore(root) as unknown as {db: import('node:sqlite').DatabaseSync;put(table: string,value: Rec): Rec;close(): void};
 const services=createServices(store as never,new Map()) as unknown as {call(operation: string,input: unknown): Promise<Rec>};
 let probes=0;
 const preflight=createTimelinePreflightServices(store as never,{probe:async()=>{probes++;assert.fail('an over-budget snapshot fails before probing');}}) as unknown as {handlers: Record<string,(input: Rec)=>Promise<Rec>>;drain(): Promise<void>};
 t.after(async()=>{await preflight.drain();store.close();rmSync(root,{recursive:true,force:true});});
 const projectId=randomUUID(),bytes=[0,1,2].map(index=>png({width:8,height:8,pixel:()=>[40+index*60,96,160,255]}));
 const assets=bytes.map((data,index)=>{const id=randomUUID();return {id,projectId,name:`PNG ${index}`,mimeType:'image/png',relativePath:`media/${id}.png`,sha256:sha(data),sizeBytes:data.length,
  width:8,height:8,duration:null,hasVideo:true,hasAudio:false,provenance:'user-import',createdAt:stamp};});
 const evidence=assets.map(asset=>({profileId:'png-rgb8-srgb-v1',sha256:asset.sha256,sourceByteLength:asset.sizeBytes,width:8,height:8,bitDepth:8,alphaMode:'straight',orientation:1,colourTag:'srgb'}));
 // A and B meet on the first track with a 4-frame dissolve; C spans both on the third.
 const timeline=timelineFixture(assets,evidence.map(value=>imageColour(value))) as Rec,[a,b,c]=timeline.clips as Rec[];
 Object.assign(a!,{startFrame:0,durationFrames:6});Object.assign(b!,{trackId:a!.trackId,startFrame:6,durationFrames:6,transitionIn:make('dissolve',4)});Object.assign(c!,{startFrame:0,durationFrames:12});
 timeline.durationFrames=12;
 const budget={code:'TIMELINE_IMAGE_COMPOSITOR_BUDGET',message:TIMELINE_COLOUR_PREFLIGHT_MESSAGES.TIMELINE_IMAGE_COMPOSITOR_BUDGET};
 const freeze=(value: Rec)=>freezeTimelineSnapshot(value as never,new Map(assets.map(asset=>[asset.id,asset])) as never,undefined);
 // Clip ranges show two images at a time; the dissolve shows A, B and C at once.
 const {transitionIn:_transition,...plain}=b!;
 assert.doesNotThrow(()=>assertTransitionImageBudget(freeze({...timeline,clips:[a,plain,c]}) as never));
 assert.throws(()=>assertTransitionImageBudget(freeze(timeline) as never),budget);
 assert.doesNotThrow(()=>assertTransitionImageBudget(freeze({...timeline,tracks:timeline.tracks.map((track: Rec)=>track.id===c!.trackId?{...track,hidden:true}:track)}) as never),'a hidden image is no input');
 // Export preflight and a render say so before probing or rendering anything.
 store.put('projects',{id:projectId,name:'Transition images',createdAt:stamp,updatedAt:stamp});
 for(const asset of assets)store.put('assets',asset);
 store.put('timelines',timeline);
 const report=await preflight.handlers['timeline.export.preflight']!({projectId,expectedRevision:1});
 assert.deepEqual([report.status,report.issues],['blocked',[{...budget,severity:'error'}]]);
 await assert.rejects(services.call('timeline.render',{projectId,expectedRevision:1,requestId:randomUUID(),purpose:'preview'}),(error: Rec)=>error.code===budget.code);
 assert.equal(probes,0);
});
