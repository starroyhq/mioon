import test from 'node:test';
import assert from 'node:assert/strict';
import {touchesLockedTrack} from '../apps/web/src/timeline-track-locks.ts';
test('window track lock covers source, destination and aggregate history without blocking reads or unrelated tracks',()=>{
 const timeline={clips:[{id:'clip',trackId:'locked'},{id:'other',trackId:'open'}]},locked=new Set(['locked']);
 for(const [op,input] of [['timeline.clip.remove',{clipId:'clip'}],['timeline.clip.update',{clipId:'clip',patch:{gain:1.2}}],['timeline.clip.update',{clipId:'other',patch:{trackId:'locked'}}],['timeline.clip.add',{trackId:'locked'}],['timeline.track.update',{trackId:'locked',patch:{hidden:true}}],['timeline.undo',{}],['timeline.redo',{}],['timeline.seed',{}],['timeline.loudness.apply',{}]] as const)assert.equal(touchesLockedTrack(op,input,timeline,locked),true,op);
 for(const [op,input] of [['timeline.clip.update',{clipId:'other',patch:{gain:.5}}],['timeline.track.add',{kind:'audio'}],['timeline.get',{}],['timeline.render',{}]] as const)assert.equal(touchesLockedTrack(op,input,timeline,locked),false,op);
 assert.equal(touchesLockedTrack('timeline.undo',{},timeline,new Set()),false);
});
