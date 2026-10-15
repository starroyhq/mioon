import test from 'node:test';
import assert from 'node:assert/strict';
import {VOLUME_ENVELOPE_PROFILE as profileId,validateVolumeEnvelope,createVolumeEnvelopeEvaluator,volumeEnvelopeFieldsAfterEdit,splitVolumeEnvelopeFields} from '../packages/contracts/src/timeline-volume-envelope.mjs';
const envelope=points=>({profileId,points:points.map(([frame,multiplier])=>({frame,multiplier}))});
const clip=(points,durationFrames=20)=>({durationFrames,volumeEnvelope:envelope(points)});
const invalid=fn=>assert.throws(fn,{code:'INVALID_VOLUME_ENVELOPE'});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-14,`${a} != ${b}`);
test('strict bounded values, ordering and non-normalization',()=>{
 const value=envelope([[0,0],[20,1]]),before=JSON.stringify(value);
 assert.equal(validateVolumeEnvelope(value,20),value);assert.equal(JSON.stringify(value),before);
 for(const bad of [undefined,{},[],{...value,extra:1},envelope([]),envelope([[2,1],[1,0]]),envelope([[1,0],[1,1]]),envelope([[21,1]]),envelope([[.5,1]]),envelope([[0,NaN]]),envelope([[0,Infinity]]),envelope([[0,1.1]]),envelope([[0,-.1]]),envelope([[0,-0]]),envelope([[-0,1]]),envelope(Array.from({length:17},(_,i)=>[i,1]))])invalid(()=>validateVolumeEnvelope(bad,20));
 const getter={profileId,get points(){throw Error('must not invoke');}};invalid(()=>validateVolumeEnvelope(getter,20));
 class Malicious extends Array {map(){throw Error('must not invoke');}}
 const subclass={profileId,points:new Malicious({frame:0,multiplier:1})};invalid(()=>validateVolumeEnvelope(subclass,20));
 const sparse={profileId,points:new Array(2)};invalid(()=>validateVolumeEnvelope(sparse,20));
 const p=envelope([[0,1]]);p.points.extra=1;invalid(()=>validateVolumeEnvelope(p,20));
});
test('legacy absent, explicit null, constants and closed endpoint versus half-open samples',()=>{
 for(const c of [{durationFrames:20},{durationFrames:20,volumeEnvelope:null},clip([[5,1]])]){
  const e=createVolumeEnvelopeEvaluator(c);assert.equal(e.atSample(0),1);assert.equal(e.limitAtSample(32000),1);assert.equal(e.atSample(32000),0);assert.equal(e.atSample(-1),0);invalid(()=>e.limitAtSample(-1));invalid(()=>e.atSample(.5));
 }
 const e=createVolumeEnvelopeEvaluator(clip([[5,.25],[15,.75]]));assert.equal(e.atSample(0),.25);assert.equal(e.atSample(8000),.25);assert.equal(e.atSample(24000),.75);assert.equal(e.limitAtSample(32000),.75);near(e.atSample(16001),.5+.5/16000);
});
test('immutable evaluator and edit fields preserve presence without aliasing',()=>{
 const c=clip([[0,0],[20,1]]),e=createVolumeEnvelopeEvaluator(c);c.volumeEnvelope.points[0].multiplier=1;assert.equal(e.atSample(0),0);
 assert.deepEqual(volumeEnvelopeFieldsAfterEdit({durationFrames:20},{durationFrames:10}),{});
 assert.deepEqual(volumeEnvelopeFieldsAfterEdit({durationFrames:20,volumeEnvelope:null},{}),{volumeEnvelope:null});
 invalid(()=>volumeEnvelopeFieldsAfterEdit(c,{durationFrames:10}));
 assert.deepEqual(volumeEnvelopeFieldsAfterEdit(c,{durationFrames:10,volumeEnvelope:null}),{volumeEnvelope:null});
 const changed=volumeEnvelopeFieldsAfterEdit(c,{durationFrames:10,volumeEnvelope:envelope([[10,.5]])});assert.equal(changed.volumeEnvelope.points[0].frame,10);
 for(const patch of [{durationFrames:30},{startFrame:100},{sourceInFrame:100},{}])assert.deepEqual(volumeEnvelopeFieldsAfterEdit(c,patch),{volumeEnvelope:c.volumeEnvelope});
 const copied=volumeEnvelopeFieldsAfterEdit(c,{});copied.volumeEnvelope.points[0].multiplier=0;assert.equal(c.volumeEnvelope.points[0].multiplier,1);
 invalid(()=>volumeEnvelopeFieldsAfterEdit(c,{volumeEnvelope:undefined}));
});
test('all interior frame cuts preserve exact anchors and numerical curve including held regions',()=>{
 for(const points of [[[0,0],[20,1]],[[5,.25],[15,.75]],[[5,.25]],[[0,1],[5,0],[10,1],[20,0]],Array.from({length:16},(_,i)=>[i+2,(i%3)/2])]){
  const c=clip(points),before=JSON.stringify(c),original=createVolumeEnvelopeEvaluator(c);
  for(let cut=1;cut<20;cut++){
   const fields=splitVolumeEnvelopeFields(c,cut),left=createVolumeEnvelopeEvaluator({durationFrames:cut,...fields[0]}),right=createVolumeEnvelopeEvaluator({durationFrames:20-cut,...fields[1]});
   assert.ok(fields.every(f=>f.volumeEnvelope.points.length<=16));
   for(let sample=0;sample<=32000;sample+=137)near(original.limitAtSample(sample),sample<=cut*1600?left.limitAtSample(sample):right.limitAtSample(sample-cut*1600));
   near(left.limitAtSample(cut*1600),right.limitAtSample(0));
  }
  assert.equal(JSON.stringify(c),before);
 }
 assert.deepEqual(splitVolumeEnvelopeFields({durationFrames:20},10),[{},{}]);
 assert.deepEqual(splitVolumeEnvelopeFields({durationFrames:20,volumeEnvelope:null},10),[{volumeEnvelope:null},{volumeEnvelope:null}]);
 invalid(()=>splitVolumeEnvelopeFields(clip([[0,1]]),0));invalid(()=>splitVolumeEnvelopeFields(clip([[0,1]]),20));
});
test('fade times automation is quadratic, not a combined endpoint ramp',()=>{
 const e=createVolumeEnvelopeEvaluator(clip([[0,0],[20,1]]));
 const sample=16000,fade=sample/32000;assert.equal(fade*e.atSample(sample),.25);assert.notEqual(fade*e.atSample(sample),.5);
 for(const gain of [0,.5,1,2])for(let sample=0;sample<32000;sample+=97)assert.ok(gain*e.atSample(sample)<=2);
});
test('serialized budget proof: 16 numeric points fit per-edit, but raw draft and aggregate need explicit admission',()=>{
 const bytes=v=>Buffer.byteLength(JSON.stringify(v));
 // Safe overbound: an ECMAScript finite number's JSON representation is under
 // 32 ASCII characters (binary64 shortest round-trip digits plus punctuation).
 const pointBound=Buffer.byteLength('{"frame":18000,"multiplier":}')+32;
 const envelopeBound=Buffer.byteLength(JSON.stringify({profileId,points:[]}))+16*pointBound+15;
 const fieldBound=Buffer.byteLength(',"volumeEnvelope":')+envelopeBound;
 assert.equal(pointBound,61);assert.equal(envelopeBound,1051);assert.equal(fieldBound,1069);
 const e=envelope(Array.from({length:16},(_,i)=>[18000-15+i,0.0000010000000000000002]));
 assert.ok(bytes(e)<=envelopeBound);
 // A conservative per-edit allowance: 2 maximal escaped 200-unit strings,
 // IDs/revision/geometry and complete colour declaration reserved at 2 KiB.
 const colourBound=27*20+17*66+6*32+5+8;
 assert.equal(colourBound,1867);assert.ok(colourBound<2048);
 const remainingEditBound=21*20+3*38+7+11*32+6+4;
 assert.equal(remainingEditBound,903);assert.ok(remainingEditBound<1024);
 assert.equal(20+28+51,99);assert.ok(99<128);assert.ok(5<=8);
 const editBound=2*200*6+2048+1024+fieldBound;
 assert.equal(editBound,6541);assert.ok(editBound<8192);
 // Existing scalar rawNumber allows 48 arbitrary Unicode/control characters.
 // Reusing it for 32 point coordinates violates the 8192-byte draft bound.
 const raw={profileId,points:Array.from({length:16},()=>({frame:'\0'.repeat(48),multiplier:'\0'.repeat(48)}))};
 assert.ok(bytes(raw)>8192);
 // 100 envelopes add <=106900 bytes. They cannot universally fit in the
 // remaining bytes of every already-valid 256-KiB timeline.
 assert.equal(100*fieldBound,106900);assert.ok(262144-1+fieldBound>262144);
});
