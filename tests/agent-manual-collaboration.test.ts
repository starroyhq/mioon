import { readFileSync } from 'node:fs';
import { evaluateExpression, extractBetween } from './helpers/eval-source.ts';
import { workspaceOriginScope } from '../apps/web/src/workspace-origin.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClipDraftController } from '../apps/web/src/clip-draft-state.ts';
import type { ClipDraftClient, ClipDraftContext, ClipDraftEnvelope } from '../apps/web/src/clip-draft-state.ts';
import { createSubtitleController, subtitleCanSave } from '../apps/web/src/subtitle-state.ts';
import type { SubtitleContext, SubtitleIntent } from '../apps/web/src/subtitle-state.ts';
import type { AgentEditingProof } from '../apps/web/src/agent-editing-proof.ts';
import { retainClipInspector } from '../apps/web/src/clip-inspector-retention.ts';

const projectId=crypto.randomUUID(),timelineId=crypto.randomUUID(),clipId=crypto.randomUUID(),assetId=crypto.randomUUID(),trackId=crypto.randomUUID(),ownerId=crypto.randomUUID(),stamp='2026-10-20T00:00:00.000Z';
const raw={name:'saved A',trackId,startFrame:0,durationFrames:60,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1};
const proof=(timelineRevision:number,revision=3):AgentEditingProof=>({ownerId,kind:'timeline_clip',id:clipId,revision,timelineRevision});
function clips(collaboration:AgentEditingProof|null=proof(7)){
  const context:ClipDraftContext={projectId,timelineId,clipId,scope:'owned-clip',restored:false,connected:true,visible:true,busy:false,timelineRevision:7,source:{assetId,assetSha256:'b'.repeat(64)},saved:structuredClone(raw),collaboration,volumeEnvelopeEditable:true};
  let row:ClipDraftEnvelope={supported:true,workspaceScope:'a'.repeat(64),instanceId:crypto.randomUUID(),key:{projectId,timelineId,clipId},revision:0,targetStatus:'matching',draft:null};
  const client:ClipDraftClient={get:async()=>structuredClone(row),put:async input=>{row={...row,revision:row.revision+1,draft:{baseRevision:input.baseRevision,source:structuredClone(input.source),raw:structuredClone(input.raw),updatedAt:stamp}};return structuredClone(row);},remove:async()=>{row={...row,revision:row.revision+1,draft:null};return structuredClone(row);}};
  const controller=createClipDraftController({context,client,delay:100000,validateTimeline:()=>true});return{context,controller};
}
test('manual clip A preserves its draft and saves at the new aggregate revision after AI changes B',async()=>{
  const f=clips();await f.controller.load();f.controller.edit('name','manual A');f.controller.setContext({...f.context,timelineRevision:8,collaboration:proof(8)});
  assert.equal(f.controller.getState().raw.name,'manual A');assert.equal(f.controller.getState().baseRevision,8);assert.equal(f.controller.getState().conflict,false);
  let submitted=0;const result=await f.controller.save(async(id,patch,base,options)=>{submitted++;assert.equal(id,clipId);assert.equal(base,8);assert.equal(options.canExecute(),true);return{id:timelineId,projectId,revision:9,clips:[{id:clipId,assetId,...raw,...patch}]};});
  assert.ok(result);assert.equal(submitted,1);assert.equal(f.controller.getState().dirty,false);assert.equal(f.controller.getState().baseRevision,9);f.controller.dispose();
});
test('same-target ABA, wrong owner and missing collaboration proof never rebase a manual clip draft',async()=>{
  for(const next of [proof(8,5),{...proof(8),ownerId:crypto.randomUUID()},null]){const f=clips();await f.controller.load();f.controller.edit('name','manual A');f.controller.setContext({...f.context,timelineRevision:8,collaboration:next});assert.equal(f.controller.getState().baseRevision,7);assert.equal(f.controller.getState().conflict,true);let writes=0;await f.controller.save(async()=>{writes++;return null;});assert.equal(writes,0);f.controller.dispose();}
});
test('legacy clip behavior keeps aggregate conflicts, and cooperative refresh preserves the active IME token',async()=>{
  const legacy=clips(null);await legacy.controller.load();legacy.controller.edit('name','legacy');legacy.controller.setContext({...legacy.context,timelineRevision:8});assert.equal(legacy.controller.getState().conflict,true);legacy.controller.dispose();
  const f=clips();await f.controller.load();const token=f.controller.beginVolumeComposition(f.controller.capture());assert.ok(token);f.controller.setContext({...f.context,timelineRevision:8,collaboration:proof(8)});assert.equal(f.controller.getState().compositionPending,true);assert.equal(f.controller.getState().baseRevision,8);assert.equal(f.controller.endVolumeComposition(token),true);f.controller.dispose();
});
test('a cooperative timeline observation keeps the same retained Inspector input owner during composition',()=>{
  const old={key:'clip-owner',scope:'scope',projectId,timeline:{id:timelineId,revision:7},clip:{id:clipId,assetId},asset:{sha256:'b'.repeat(64)},restored:false,collaboration:proof(7)};
  const next={...old,timeline:{...old.timeline,revision:8},collaboration:proof(8)};
  const state=retainClipInspector({snapshot:old,retained:false},next,{dirty:true,pending:true,connected:true});assert.equal(state.snapshot,next);assert.equal(state.retained,false);
  const aba=retainClipInspector({snapshot:old,retained:false},{...next,collaboration:proof(8,5)},{dirty:true,pending:true,connected:true});assert.equal(aba.snapshot,old);assert.equal(aba.retained,true);
});
const cueId=crypto.randomUUID(),secondCueId=crypto.randomUUID();
function timeline(revision=7){return{id:timelineId,projectId,revision,fps:30,width:720,height:1280,durationFrames:180,tracks:[{id:trackId,kind:'video',name:'Video',orderIndex:0,hidden:false,muted:false}],clips:[{id:clipId,assetId,...raw,durationFrames:180}],subtitles:{profileId:'bottom_cjk_v1',cues:[{id:cueId,text:'A',startFrame:0,durationFrames:30},{id:secondCueId,text:'B',startFrame:60,durationFrames:30}]},createdAt:stamp,updatedAt:stamp};}
test('subtitle A rebases only when its claimed target ledger is unchanged; saving keeps AI subtitle B',async()=>{
  let live:SubtitleContext={scope:'subtitle-owner',projectId,timeline:timeline(),connected:true,pending:false};const intents:SubtitleIntent[]=[];
  const controller=createSubtitleController({getContext:()=>live,createRequestId:()=>crypto.randomUUID(),submit:async intent=>{intents.push(intent);const next=structuredClone(live.timeline) as ReturnType<typeof timeline>;next.revision=intent.input.expectedRevision!+1;Object.assign(next.subtitles.cues[0]!,intent.input.patch);return{status:'applied',timeline:next};}});
  controller.setContext(live);controller.setVisible(true);controller.select(cueId);live={...live,collaboration:{...proof(7),kind:'timeline_subtitle',id:cueId}};controller.setContext(live);controller.edit('text','manual A');
  const next=timeline(8);next.subtitles.cues[1]!.text='AI B';live={...live,timeline:next,collaboration:{...proof(8),kind:'timeline_subtitle',id:cueId}};controller.setContext(live);assert.equal(subtitleCanSave(controller.getState()),true);const saved=await controller.save();assert.ok(saved);assert.equal(intents[0]?.input.expectedRevision,8);assert.equal((saved as ReturnType<typeof timeline>).subtitles.cues[1]?.text,'AI B');controller.dispose();
});

test('the actual App refresh rechecks workspace origin after an asynchronous editing-ledger read',async()=>{
  const source=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
  const fragment=extractBetween(source,'  const refresh = useCallback(', '  async function revealImageAsset(');
  for(const switchOrigin of [false,true]){
    let release!:()=>void,entered!:()=>void,published=0;
    const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const workspaceRef:{current:{restored:boolean;workspaceOrigin?:string}}={current:{restored:false}};
    const snapshot={project:{id:projectId},shots:[],nodes:[]};
    const noop=()=>{};
    const env={useCallback:(fn:()=>Promise<unknown>)=>fn,currentProject:{current:projectId},projectSessionReady:()=>true,requestCounter:{current:0},projectEpoch:{current:1},workspaceRef,
      rpc:async()=>snapshot,readGenerationProviderDirectory:async()=>({providers:[],videoUnavailable:false}),importSession:{current:{active:true}},workspaceOriginScope,
      hasProjectResponseOriginMismatch:()=>false,validateProjectWorkspace:noop,projectResponseMatches:()=>true,application:null,refreshAgentEditingTargets:async()=>{entered();await held;},
      reconcilePending:()=>{published++;},dataRef:{current:null},emptyData:{},setData:noop,setProviders:noop,setVideoDirectoryUnavailable:noop,setLastSync:noop,setOnline:noop,setPending:noop,pendingForProject:()=>[],
      clipDraftRef:{current:null},viewRef:{current:{}},reconcileWorkspaceState:(view:unknown)=>view,viewReady:{current:false},setView:noop,preferencesRef:{current:null},notify:noop,setAuth:noop,readableError:()=>''};
    const refresh=evaluateExpression<()=>Promise<unknown>>(fragment,'refresh',Object.keys(env),Object.values(env));
    const reading=refresh();await started;if(switchOrigin)workspaceRef.current={restored:true,workspaceOrigin:crypto.randomUUID()};release();const result=await reading;
    assert.equal(published,switchOrigin?0:1);assert.equal(result,switchOrigin?null:snapshot);
  }
});

test('the actual App agent-dock gate opens only exact schema53, schema55, schema57 and schema59 restored task histories',()=>{
  const source=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8'),start=source.indexOf('<AgentDockPane id="right-dock-agent"'),segment=source.slice(start),expression=segment.slice(segment.indexOf('>{')+2,segment.indexOf(' ? <RestoredUnavailable'));
  for(const schemaVersion of [undefined,49,51,52,53,54,55,56,57,58,59,60,61])assert.equal(evaluateExpression('', '('+expression+')',['restored','workspace'],[true,{restored:true,schemaVersion}]),![53,55,57,59,61].includes(schemaVersion??0));
  assert.equal(evaluateExpression('', '('+expression+')',['restored','workspace'],[false,{restored:false}]),false);
});
