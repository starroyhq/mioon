import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TIMELINE_OUTPUT_PRESETS,TIMELINE_CURRENT_OUTPUT_PRESETS,TIMELINE_LEGACY_OUTPUT_PRESETS,DEFAULT_TIMELINE_OUTPUT_PRESET,parse,resolveTimelineExportDelivery,isTimelineExportDelivery,isTimelineExportCapabilitiesResponse} from '@mioon/contracts';
import {freezeStoryboardOutputGeometry,storyboardOutputGeometry} from '../packages/business/src/storyboard-output.ts';

test('new projects use three 1080 presets while every legacy geometry remains readable',()=>{
  assert.equal(DEFAULT_TIMELINE_OUTPUT_PRESET,'portrait_1080');
  assert.deepEqual(TIMELINE_CURRENT_OUTPUT_PRESETS.map(p=>[p.id,p.width,p.height]),[
    ['portrait_1080',1080,1920],['landscape_1080',1920,1080],['square_1080',1080,1080],
  ]);
  assert.equal(TIMELINE_LEGACY_OUTPUT_PRESETS.length,3);assert.equal(TIMELINE_OUTPUT_PRESETS.length,6);
  for(const preset of TIMELINE_OUTPUT_PRESETS){
    const input={projectId:randomUUID(),expectedProjectRevision:1,expectedRevision:0,requestId:randomUUID(),presetId:preset.id};
    assert.deepEqual(parse('timeline.format.set',input),input);
  }
  const input={projectId:randomUUID(),expectedRevision:1,requestId:randomUUID(),clipId:randomUUID(),patch:{rect:{x:0,y:0,width:1920,height:1080}}};
  assert.deepEqual(parse('timeline.clip.update',input),input);
  assert.throws(()=>parse('timeline.clip.update',{...input,patch:{rect:{x:2,y:0,width:1920,height:1080}}}));
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
  const projectId=randomUUID(),calls=[];
  const db=value=>({prepare(sql){calls.push(sql);return {get(id){assert.equal(id,projectId);return value;}};}});
  assert.deepEqual(freezeStoryboardOutputGeometry(db(undefined),projectId),{fps:30,width:1080,height:1920});
  for(const preset of TIMELINE_OUTPUT_PRESETS){
    const expected={fps:30,width:preset.width,height:preset.height};
    assert.deepEqual(freezeStoryboardOutputGeometry(db({data:JSON.stringify(expected)}),projectId),expected);
    assert.deepEqual(storyboardOutputGeometry({outputGeometry:expected}),expected);
  }
  assert.ok(calls.every(sql=>sql==='SELECT data FROM timelines WHERE projectId=?'));
  assert.deepEqual(storyboardOutputGeometry({snapshot:[]}),{fps:30,width:720,height:1280});
  for(const outputGeometry of [null,undefined,{fps:60,width:1080,height:1920},{fps:30,width:1920,height:1920},{fps:30,width:1080,height:1280}])
    assert.throws(()=>storyboardOutputGeometry({outputGeometry}),e=>e.code==='INVALID_TIMELINE_SNAPSHOT');
});
