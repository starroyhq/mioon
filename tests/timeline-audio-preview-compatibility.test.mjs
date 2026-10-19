import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {timelineAudioFadeFilters as before} from './fixtures/timeline-audio-preview/legacy-timeline-audio-1398.mjs';
import {timelineAudioFadeFilters as current} from '../packages/business/src/timeline-audio.ts';

test('1398 frozen fade implementation retains exact bytes and all valid legacy filter strings',async()=>{
  const bytes=await readFile(new URL('./fixtures/timeline-audio-preview/legacy-timeline-audio-1398.mjs',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'aa58364a5ce28f56a74d204b822e9b73b8b121b937b5e485ce8492ca088166ac');
  let cases=0;
  for(const startFrame of [0,1,17,17400])for(const durationFrames of [1,30,600]){
    if(startFrame+durationFrames>18000)continue;
    for(const fadeInFrames of [undefined,0,1,Math.floor(durationFrames/2),durationFrames])
      for(const fadeOutFrames of [undefined,0,1,Math.floor(durationFrames/2),durationFrames]){
        if((fadeInFrames??0)+(fadeOutFrames??0)>durationFrames)continue;
        const clip={startFrame,durationFrames,...(fadeInFrames===undefined?{}:{fadeInFrames}),...(fadeOutFrames===undefined?{}:{fadeOutFrames})};
        for(const offset of [...new Set([0,Math.floor(durationFrames/2),durationFrames])]){
          assert.equal(current(clip,startFrame+offset),before(clip,startFrame+offset));cases++;
        }
      }
  }
  assert.ok(cases>500);
  assert.equal(current({startFrame:undefined},0),'','omitted fades retain the old zero-effect fast path');
});


// Exact historical segment/trim descriptor preservation: selected-range export
// continues to seek from the same original global edges, including muted clips.
import {planTimelineExportRange as oldRange} from './fixtures/timeline-audio-preview/legacy-timeline-range-plan-1398.ts';
import {planTimelineExportRange as currentRange} from '../packages/business/src/timeline-export-range-plan.ts';
test('1398 frozen export segmentation and argument strings remain byte-identical',async()=>{
  const bytes=await readFile(new URL('./fixtures/timeline-audio-preview/legacy-timeline-range-plan-1398.ts',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'62cb427509730be6f995b0e1501d50a93dc98ba3fe6496690cb9c75375e29888');
  let cases=0;
  for(const durationFrames of [1,30,600,18000]){
    const inner=Math.floor(durationFrames/3),length=Math.max(1,Math.floor(durationFrames/4));
    const clips=[{startFrame:0,durationFrames},...(inner+length<=durationFrames?[{startFrame:inner,durationFrames:length,muted:true}]:[])];
    const timeline={fps:30,durationFrames,clips};
    const snapshots=[{timeline}];
    for(const startFrame of [...new Set([0,Math.floor(durationFrames/2),durationFrames-1])])
      for(const endFrame of [...new Set([startFrame+1,durationFrames])])
        snapshots.push({timeline,exportRange:{startFrame,endFrame}});
    for(const snapshot of snapshots){assert.equal(JSON.stringify(currentRange(snapshot)),JSON.stringify(oldRange(snapshot)));cases++;}
  }
  assert.ok(cases>=20);
});
