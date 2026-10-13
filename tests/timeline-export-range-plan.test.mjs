import test from 'node:test';
import assert from 'node:assert/strict';
import {planTimelineExportRange,validateTimelineExportRangeOutputStart} from '../packages/business/src/timeline-export-range-plan.ts';

const saved=()=>({timeline:{fps:30,durationFrames:120,clips:[
 {startFrame:10,durationFrames:50},{startFrame:30,durationFrames:90},
]}});
const ranges=plan=>plan.segments.map(segment=>[segment.beginFrame,segment.endFrame,segment.outputFrames,segment.videoOutputTrim,segment.audioOutputTrim]);

test('range planner preserves original anchors, gaps and all frozen fields without rebasing',()=>{
 const snapshot={...saved(),exportRange:{startFrame:17,endFrame:83}},before=structuredClone(snapshot);
 const plan=planTimelineExportRange(snapshot);
 assert.equal(plan.selected,true);assert.equal(plan.outputFrames,66);
 assert.deepEqual(ranges(plan),[
  [10,30,13,'trim=start_frame=7:end_frame=20,','atrim=start_sample=11200:end_sample=32000,'],
  [30,60,30,'',''],
  [60,120,23,'trim=start_frame=0:end_frame=23,','atrim=start_sample=0:end_sample=36800,'],
 ]);
 assert.equal(plan.segments.reduce((sum,segment)=>sum+segment.outputFrames,0),66);
 assert.deepEqual(snapshot,before);assert.ok(Object.isFrozen(plan)&&Object.isFrozen(plan.segments));
 const gap=planTimelineExportRange({...snapshot,exportRange:{startFrame:3,endFrame:4}});
 assert.deepEqual(ranges(gap),[[0,10,1,'trim=start_frame=3:end_frame=4,','atrim=start_sample=4800:end_sample=6400,']]);
});

test('absent and explicit full span keep exact original segment filter arguments',()=>{
 const snapshot=saved(),plain=planTimelineExportRange(snapshot),explicit=planTimelineExportRange({...snapshot,exportRange:{startFrame:0,endFrame:120}});
 assert.equal(plain.selected,false);assert.equal(explicit.selected,true);assert.equal(plain.outputFrames,120);
 assert.deepEqual(plain.segments,explicit.segments);
 assert.deepEqual(ranges(plain),[[0,10,10,'',''],[10,30,20,'',''],[30,60,30,'',''],[60,120,60,'','']]);
 assert.equal(Object.hasOwn(snapshot,'exportRange'),false);
});

test('range planner handles half-open boundaries, minimum and bounded maximum without adding edges',()=>{
 for(const exportRange of [{startFrame:0,endFrame:1},{startFrame:119,endFrame:120},{startFrame:30,endFrame:60}]){
  const plan=planTimelineExportRange({...saved(),exportRange});assert.equal(plan.segments.length,1);
  assert.equal(plan.outputFrames,exportRange.endFrame-exportRange.startFrame);
 }
 const timeline={fps:30,durationFrames:200,clips:Array.from({length:100},(_,index)=>({startFrame:index*2+1,durationFrames:1}))};
 const plan=planTimelineExportRange({timeline,exportRange:{startFrame:1,endFrame:199}});
 assert.equal(plan.segments.length,198);assert.equal(plan.outputFrames,198);
 assert.ok(plan.segments.every(segment=>segment.outputFrames===1));
});

test('range planner delegates persisted range admission to the shared contract',()=>{
 for(const exportRange of [null,undefined,{},[],{startFrame:0,endFrame:0},{startFrame:-1,endFrame:1},{startFrame:0,endFrame:121},{startFrame:0.5,endFrame:1},{startFrame:1,endFrame:2,extra:true}])
  assert.throws(()=>planTimelineExportRange({...saved(),exportRange}),{code:'INVALID_TIMELINE_SNAPSHOT'});
});

test('selected output validates presentation origin without interpreting AAC priming packet DTS',()=>{
 const plan=planTimelineExportRange({...saved(),exportRange:{startFrame:1,endFrame:2}});
 const probe={streams:[{codec_type:'video',start_pts:0,start_time:'0.000000'},{codec_type:'audio',start_pts:0,start_time:'0.000000'}],format:{start_time:'0.000000'},packets:[{dts:-1024}]};
 assert.doesNotThrow(()=>validateTimelineExportRangeOutputStart(plan,probe));
 for(const patch of [()=>({...probe,format:{start_time:'0.033333'}}),()=>({...probe,streams:[{...probe.streams[0],start_pts:1000},probe.streams[1]]}),()=>({...probe,streams:[probe.streams[0],{...probe.streams[1],start_time:undefined}]}),()=>null])
  assert.throws(()=>validateTimelineExportRangeOutputStart(plan,patch()),{code:'INVALID_TIMELINE_OUTPUT'});
 assert.doesNotThrow(()=>validateTimelineExportRangeOutputStart(planTimelineExportRange(saved()),{}));
});
