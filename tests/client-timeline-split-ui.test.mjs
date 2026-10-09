import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {timelineSplitState} from '../apps/web/src/timeline-split.js';
import {timelineSplitActionForKey} from '../apps/web/src/timeline-keyboard.js';
import {timelineHistoryState} from '../apps/web/src/timeline-history.js';
import {prepareSubmission,readPending,reconcilePending} from '../apps/web/src/submissions.js';
const root=fileURLToPath(new URL('..',import.meta.url));
const fixture=()=>({projectId:'project',timeline:{id:'timeline',revision:5,clips:[{id:'clip',name:'Frozen source',startFrame:10,durationFrames:50}]},history:{projectId:'project',timelineId:'timeline',revision:5,cursor:1,length:1,canUndo:true,canRedo:false,undoEntry:{id:'entry',operation:'timeline.clip.split'},redoEntry:null},selectedClipId:'clip',playhead:30,mode:'editing'});
const event=patch=>({key:'b',ctrlKey:true,metaKey:false,altKey:false,shiftKey:false,repeat:false,isComposing:false,defaultPrevented:false,target:null,...patch});
test('split state names exact selected clip and cut point with matching durations',()=>{
 assert.deepEqual(timelineSplitState(fixture()),{canSplit:true,blockedReason:'',clipId:'clip',clipName:'Frozen source',atFrame:30,leftDuration:20,rightDuration:30});
 assert.equal(timelineHistoryState(fixture()).undoLabel,'分割片段');
});
test('strict integer interior, selected clip, correct workspace and clip limit gate splitting',()=>{
 for(const playhead of [0,9,10,60,61,18000,-1,10.5,NaN,Infinity,'30',null,undefined])assert.equal(timelineSplitState({...fixture(),playhead}).canSplit,false,String(playhead));
 for(const playhead of [11,59])assert.equal(timelineSplitState({...fixture(),playhead}).canSplit,true);
 for(const patch of [{selectedClipId:null},{selectedClipId:'absent'},{mode:'canvas'},{timeline:null},{projectId:null}])assert.equal(timelineSplitState({...fixture(),...patch}).canSplit,false);
 const many=fixture();many.timeline.clips=Array.from({length:99},(_,i)=>({...many.timeline.clips[0],id:i?'extra-'+i:'clip'}));assert.equal(timelineSplitState(many).canSplit,true);many.timeline.clips.push({...many.timeline.clips[0],id:'hundred'});assert.match(timelineSplitState(many).blockedReason,/100/);
});
test('split fails closed for dirty, loading, offline, pending, busy and mismatched snapshots',()=>{
 for(const patch of [{dirty:true},{online:false},{busy:true},{pending:true},{history:null},{history:{...fixture().history,revision:4}},{history:{...fixture().history,projectId:'other'}}]){const state=timelineSplitState({...fixture(),...patch});assert.equal(state.canSplit,false,JSON.stringify(patch));assert.ok(state.blockedReason);}
});
test('split shortcut requires a single primary modifier and leaves editing/IME/repeats alone',()=>{
 for(const patch of [{},{key:'B'},{ctrlKey:false,metaKey:true}])assert.equal(timelineSplitActionForKey(event(patch)),'split');
 for(const patch of [{key:'s'},{key:undefined},{ctrlKey:false},{metaKey:true},{altKey:true},{shiftKey:true},{repeat:true},{isComposing:true},{keyCode:229},{defaultPrevented:true},{target:{isContentEditable:true}},{target:{closest:()=>({})}},{target:{parentElement:{closest:()=>({})}}},{composedPath:()=>[{isContentEditable:true}]},{target:{ownerDocument:{activeElement:{closest:()=>({})}}}}])assert.equal(timelineSplitActionForKey(event(patch)),null,JSON.stringify(patch));
 assert.equal(timelineSplitActionForKey(event(),{modalOpen:true}),null);
});
test('lost split responses preserve original clip, integer playhead, revision and request identity',t=>{
 const prior=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');const values=new Map();Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{get length(){return values.size},key:n=>[...values.keys()][n],getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}});t.after(()=>{if(prior)Object.defineProperty(globalThis,'sessionStorage',prior);else delete globalThis.sessionStorage;});
 const original={projectId:'project',key:'timeline:mutation',operation:'timeline.clip.split',createdAt:'2026-10-09T14:00:00Z',input:{projectId:'project',clipId:'clip',atFrame:30,expectedRevision:5,requestId:'original-split-request'}};
 assert.deepEqual(prepareSubmission(original),original);reconcilePending('project',{timeline:{revision:6,clips:[]},exports:[],jobs:[]});assert.deepEqual(readPending('project','timeline:mutation'),original);
 assert.deepEqual(prepareSubmission({...original,input:{...original.input,clipId:'other',atFrame:40,expectedRevision:6,requestId:'never-replace'}}),original);
});
test('shared split button renders accessible target, frame, shortcut and disabled reasons',()=>{
 const source=`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server.browser';import Controls from './src/TimelineSplitControls.jsx';export const ready=renderToStaticMarkup(<Controls state={${JSON.stringify(timelineSplitState(fixture()))}} onSplit={()=>{}}/>);export const blocked=renderToStaticMarkup(<Controls state={${JSON.stringify(timelineSplitState({...fixture(),dirty:true}))}} onSplit={()=>{}}/>);`;
 const script=`import {build} from 'esbuild';import assert from 'node:assert/strict';const {outputFiles}=await build({stdin:{contents:${JSON.stringify(source)},loader:'jsx',resolveDir:${JSON.stringify(path.join(root,'apps/web'))}},bundle:true,format:'esm',platform:'browser',write:false,define:{'process.env.NODE_ENV':'"production"'}});const {ready,blocked}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));assert.ok(ready.includes('data-slot="button"'));assert.ok(ready.includes('分割所选片段：Frozen source，播放头 30 帧'));assert.ok(ready.includes('Control+B Meta+B'));assert.ok(ready.includes('20 + 30 帧'));assert.ok(!ready.includes(' disabled=""'));assert.ok(blocked.includes(' disabled=""'));assert.ok(blocked.includes('保存或放弃'));process.stdout.write('split controls verified');process.exit(0);`;
 assert.match(execFileSync(process.execPath,['--input-type=module'],{input:script,cwd:root,encoding:'utf8',timeout:30000}),/verified/);
});
test('App rechecks current view and current aggregate before the shared durable mutation',()=>{
 const app=readFileSync(path.join(root,'apps/web/src/App.jsx'),'utf8');assert.match(app,/selectedClipId: viewRef\.current\.editing\.selectedClipId, playhead: viewRef\.current\.editing\.playhead, mode: viewRef\.current\.activeMode/);assert.match(app,/if \(!latest\.canSplit\) return null/);assert.match(app,/mutateTimeline\('timeline\.clip\.split', \{ clipId: latest\.clipId, atFrame: latest\.atFrame \}\)/);assert.match(app,/if \(viewRef\.current\.activeMode !== 'editing'\) return/);
});
