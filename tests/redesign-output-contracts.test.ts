import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TIMELINE_OUTPUT_PRESETS,TIMELINE_CURRENT_OUTPUT_PRESETS,TIMELINE_LEGACY_OUTPUT_PRESETS,DEFAULT_TIMELINE_OUTPUT_PRESET,parse,timelineFormatSchemas,resolveTimelineExportDelivery,isTimelineExportDelivery,isTimelineExportCapabilitiesResponse,timelineExportDeliverySchema} from '@mioon/contracts';
import {TIMELINE_FORMAT_WRITE_PRESETS,timelineOutputPresetForRatio,timelineOutputRatio} from '../packages/contracts/src/timeline-output-geometry.ts';
import {freezeStoryboardOutputGeometry,storyboardOutputGeometry} from '../packages/business/src/storyboard-output.ts';

test('project creation keeps three 1080 presets while the public frame setter accepts the closed twelve',()=>{
  assert.equal(DEFAULT_TIMELINE_OUTPUT_PRESET,'portrait_1080');
  assert.deepEqual(TIMELINE_CURRENT_OUTPUT_PRESETS.map(p=>[p.id,p.width,p.height]),[
    ['portrait_1080',1080,1920],['landscape_1080',1920,1080],['square_1080',1080,1080],
  ]);
  assert.equal(TIMELINE_LEGACY_OUTPUT_PRESETS.length,3);assert.equal(TIMELINE_OUTPUT_PRESETS.length,12);
  for(const preset of TIMELINE_OUTPUT_PRESETS){
    const input={projectId:randomUUID(),expectedProjectRevision:1,expectedRevision:0,requestId:randomUUID(),presetId:preset.id};
    assert.deepEqual(parse('timeline.format.set',input),input);
    assert.equal(timelineFormatSchemas['timeline.format.set'].safeParse(input).success,
      TIMELINE_FORMAT_WRITE_PRESETS.some(value=>value.id===preset.id));
  }
  const input={projectId:randomUUID(),expectedRevision:1,requestId:randomUUID(),clipId:randomUUID(),patch:{rect:{x:0,y:0,width:1920,height:1080}}};
  assert.throws(()=>parse('timeline.format.set',{projectId:input.projectId,expectedProjectRevision:1,expectedRevision:0,requestId:input.requestId,presetId:'arbitrary'}),{code:'VALIDATION_ERROR'});
  assert.deepEqual(parse('timeline.clip.update',input),input);
  assert.throws(()=>parse('timeline.clip.update',{...input,patch:{rect:{x:2,y:0,width:1920,height:1080}}}));
});

test('frame ratios select both native short edges exactly and keep the native and encoded pixel pairs closed',()=>{
  const table=[
    ['9:16',720,1280,1080,1920,360,640],
    ['16:9',1280,720,1920,1080,640,360],
    ['1:1',720,720,1080,1080,360,360],
    ['4:3',960,720,1440,1080,480,360],
    ['3:4',720,960,1080,1440,360,480],
    ['21:9',1680,720,2520,1080,840,360],
  ] as const;
  for(const [ratio,w720,h720,w1080,h1080,w360,h360] of table){
    const small=timelineOutputPresetForRatio(ratio,720)!,large=timelineOutputPresetForRatio(ratio,1080)!;
    assert.deepEqual([small.width,small.height,large.width,large.height],[w720,h720,w1080,h1080]);
    assert.equal(timelineOutputRatio(small),ratio);assert.equal(timelineOutputRatio(large),ratio);
    const settings={profileId:'mp4_h264_v1',resolution:'short_360',rateControl:{mode:'crf',quality:'standard'}};
    const delivery=resolveTimelineExportDelivery(small,settings);
    assert.deepEqual([delivery.effective.width,delivery.effective.height],[w360,h360]);
    assert.deepEqual(resolveTimelineExportDelivery(large,settings),delivery);
  }
  const wide=timelineOutputPresetForRatio('21:9',1080)!;
  for(const profileId of ['mp4_h264_v1','mp4_h264_float_checked_v2']){
    const delivery=resolveTimelineExportDelivery(wide,{profileId,resolution:'native',rateControl:{mode:'crf',quality:'standard'}});
    assert.ok(timelineExportDeliverySchema.safeParse(delivery).success);
    for(const geometry of [{width:2518},{height:2520},{width:2521},{fps:60}]){
      assert.equal(timelineExportDeliverySchema.safeParse({...delivery,effective:{...delivery.effective,...geometry}}).success,false);
    }
  }
  assert.equal(timelineOutputRatio({width:840,height:360,fps:30}),null);
});

test('v1 and float deliveries scale from each native geometry, and capability ACKs admit only exact legal output',()=>{
  for(const timeline of TIMELINE_OUTPUT_PRESETS)for(const profileId of ['mp4_h264_v1','mp4_h264_float_checked_v2'])for(const resolution of ['native','short_720','short_360','short_1080']){
    const settings={profileId,resolution,rateControl:{mode:'crf',quality:'standard'}},before=JSON.stringify(timeline);
    const short=resolution==='native'?Math.min(timeline.width,timeline.height):Number(resolution.slice(6));
    const delivery=resolveTimelineExportDelivery(timeline,settings);
    assert.equal(Math.min(delivery.effective.width,delivery.effective.height),short);
    assert.equal(delivery.effective.width/delivery.effective.height,timeline.width/timeline.height);
    assert.equal(delivery.effective.fps,30);assert.ok(isTimelineExportDelivery(delivery,timeline,settings));
    assert.equal(JSON.stringify(timeline),before);
    const input={projectId:randomUUID(),expectedRevision:1,exportSettings:settings};
    const report={...input,timelineId:randomUUID(),timelineRevision:1,delivery,checkedAt:'2026-10-19T00:00:00.000Z',status:'available',issues:[]};
    assert.ok(isTimelineExportCapabilitiesResponse(report,input));
    assert.equal(isTimelineExportCapabilitiesResponse({...report,delivery:{...delivery,effective:{...delivery.effective,width:delivery.effective.width+2}}},input),false);
  }
});

test('storyboard exports freeze current geometry without initializing a timeline and retain old queued output',()=>{
  const projectId=randomUUID(),calls: string[]=[];
  const db=(value?: { data: string; }|undefined)=>({prepare(sql: string){calls.push(sql);return {get(id: unknown){assert.equal(id,projectId);return value;}};}});
  assert.deepEqual(freezeStoryboardOutputGeometry(db(undefined),projectId),{fps:30,width:1080,height:1920});
  for(const preset of TIMELINE_OUTPUT_PRESETS){
    const expected={fps:30,width:preset.width,height:preset.height};
    assert.deepEqual(freezeStoryboardOutputGeometry(db({data:JSON.stringify(expected)}),projectId),expected);
    assert.deepEqual(storyboardOutputGeometry({outputGeometry:expected}),expected);
  }
  assert.ok(calls.every(sql=>sql==='SELECT data FROM timelines WHERE projectId=?'));
  assert.deepEqual(storyboardOutputGeometry({snapshot:[]}),{fps:30,width:720,height:1280});
  for(const outputGeometry of [null,undefined,{fps:60,width:1080,height:1920},{fps:30,width:1920,height:1920},{fps:30,width:1080,height:1280}])
    assert.throws(()=>storyboardOutputGeometry({outputGeometry}),e=>(e as {code?: string}).code==='INVALID_TIMELINE_SNAPSHOT');
});
