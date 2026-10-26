import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TIMELINE_OUTPUT_PRESETS,isExportPreflightResponse} from '@mioon/contracts';

const report=()=>({
 projectId:randomUUID(),timelineId:randomUUID(),timelineRevision:3,expectedRevision:3,
 snapshotHash:'a'.repeat(64),checkedAt:'2026-01-01T00:00:00.000Z',status:'ready',
 summary:{fps:30,width:720,height:1280,durationFrames:71,trackCount:3,clipCount:2,assetCount:1,
  visualClipCount:2,audibleClipCount:1,mutedTrackCount:0,hiddenVideoTrackCount:0},
 checks:{totalAssets:1,checkedAssets:1,bytesHashed:100,fullDecode:false},issues:[],
});

test('export preflight accepts exactly the supported frozen dimension pairs at 30 fps',()=>{
 for(const {fps,width,height} of TIMELINE_OUTPUT_PRESETS){
  const value=report();Object.assign(value.summary,{fps,width,height});
  assert.ok(isExportPreflightResponse(value,{projectId:value.projectId,expectedRevision:3}));
 }
 for(const patch of [{width:1280,height:1280},{width:720,height:1080},{width:1920,height:1079},{width:1080,height:1919},{width:1920,height:1920},
  {width:1280,height:720,fps:24},{width:720,height:720,fps:60},{width:720.5},{fps:'30'}]){
  const value=report();Object.assign(value.summary,patch);
  assert.equal(isExportPreflightResponse(value),false,JSON.stringify(patch));
 }
 const legacy=report();assert.ok(isExportPreflightResponse(legacy));
 const absent=report();Object.assign(absent,{status:'blocked',timelineId:null,timelineRevision:null,snapshotHash:null,summary:null,
  checks:{totalAssets:0,checkedAssets:0,bytesHashed:0,fullDecode:false},issues:[{code:'TIMELINE_MISSING',severity:'error',message:'Missing saved timeline.'}]});
 assert.ok(isExportPreflightResponse(absent));
});
