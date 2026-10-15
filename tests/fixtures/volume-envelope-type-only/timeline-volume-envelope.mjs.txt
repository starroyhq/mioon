/** Pure value/curve algebra shared by bounded contracts and processing.
 * This module establishes no source-audio eligibility or workspace authority. */
export const VOLUME_ENVELOPE_PROFILE = 'mioon-clip-linear-attenuation-v1';
export const VOLUME_ENVELOPE_LIMITS = Object.freeze({points:16, frames:18000, samplesPerFrame:1600});
const own = (v,k) => Object.hasOwn(v,k);
const integer = (v,min,max) => Number.isSafeInteger(v) && v >= min && v <= max;
const fail = message => {throw Object.assign(new Error(message),{code:'INVALID_VOLUME_ENVELOPE'});};
function record(value, keys) {
  if(value===null || typeof value!=='object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
  const descriptors=Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length===keys.length && keys.every(key=>own(descriptors,key)&&descriptors[key].enumerable&&own(descriptors[key],'value'));
}
function duration(value) {if(!integer(value,1,18000))fail('Invalid clip duration.');}
/** Returns the original value, never normalizes, sorts, defaults or mutates it. */
export function validateVolumeEnvelope(value,durationFrames) {
  duration(durationFrames);
  if(value===null)return value;
  if(!record(value,['profileId','points']) || value.profileId!==VOLUME_ENVELOPE_PROFILE || !Array.isArray(value.points) || Object.getPrototypeOf(value.points)!==Array.prototype ||
     value.points.length<1 || value.points.length>16)fail('Invalid envelope shape or point count.');
  const descriptors=Object.getOwnPropertyDescriptors(value.points);
  if(Reflect.ownKeys(descriptors).length!==value.points.length+1)fail('Invalid point list.');
  let previous=-1;
  for(let i=0;i<value.points.length;i++) {
    const descriptor=descriptors[i];
    if(!descriptor?.enumerable || !own(descriptor,'value'))fail('Invalid point list.');
    const point=descriptor.value;
    if(!record(point,['frame','multiplier']) || !integer(point.frame,0,durationFrames) || point.frame<=previous ||
       typeof point.multiplier!=='number' || !Number.isFinite(point.multiplier) || point.multiplier<0 || point.multiplier>1 ||
       Object.is(point.frame,-0) || Object.is(point.multiplier,-0))fail('Invalid point time or multiplier.');
    previous=point.frame;
  }
  return value;
}
const copy = value => value===null ? null : {profileId:value.profileId,points:value.points.map(point=>({...point}))};
function field(clip) {
  if(!clip || typeof clip!=='object')fail('Invalid clip.');
  const d=Object.getOwnPropertyDescriptor(clip,'volumeEnvelope');
  if(d && (!d.enumerable || !own(d,'value')))fail('Invalid envelope field.');
  if(d)validateVolumeEnvelope(d.value,clip.durationFrames);else duration(clip.durationFrames);
  return d;
}
function multiplier(points,sample) {
  if(sample<=points[0].frame*1600)return points[0].multiplier;
  for(let i=1;i<points.length;i++) {
    const right=points[i],left=points[i-1],end=right.frame*1600;
    if(sample===end)return right.multiplier;
    if(sample<end)return left.multiplier+(right.multiplier-left.multiplier)*((sample-left.frame*1600)/(end-left.frame*1600));
  }
  return points.at(-1).multiplier;
}
/** Validated immutable evaluator. Endpoint evaluation is not playback membership.
 * Integers are exact sample positions; interpolation uses IEEE-754 arithmetic. */
export function createVolumeEnvelopeEvaluator(clip) {
  const d=field(clip),end=clip.durationFrames*1600,points=d?.value===null||!d?null:copy(d.value).points;
  return Object.freeze({
    limitAtSample(sample) {
      if(!integer(sample,0,end))fail('Invalid endpoint sample.');
      return points?multiplier(points,sample):1;
    },
    atSample(sample) {
      if(!Number.isSafeInteger(sample))fail('Invalid playback sample.');
      return sample<0||sample>=end?0:points?multiplier(points,sample):1;
    },
  });
}
/** Generic duration/source/start edits preserve local point times. A shrink
 * needs a same-patch replacement or clear when old points exceed its end.
 * Returns only the owned envelope field for the caller's complete clip merge. */
export function volumeEnvelopeFieldsAfterEdit(clip,patch) {
  field(clip);
  if(!patch || typeof patch!=='object')fail('Invalid patch.');
  const candidate={durationFrames:own(patch,'durationFrames')?patch.durationFrames:clip.durationFrames};
  const source=own(patch,'volumeEnvelope')?patch:clip;
  const d=Object.getOwnPropertyDescriptor(source,'volumeEnvelope');
  if(d){if(!d.enumerable||!own(d,'value'))fail('Invalid envelope field.');candidate.volumeEnvelope=d.value;}
  field(candidate);
  return own(candidate,'volumeEnvelope')?{volumeEnvelope:copy(candidate.volumeEnvelope)}:{};
}
/** Split the envelope only; existing caller-owned fade split restrictions stay.
 * At a cut between points, replace the removed side with its interpolated
 * boundary. Constant-held regions need no redundant point, keeping <=16. */
export function splitVolumeEnvelopeFields(clip,cutFrame) {
  const d=field(clip);
  if(!integer(cutFrame,1,clip.durationFrames-1))fail('Split must be inside clip.');
  if(!d)return [{},{}];
  if(d.value===null)return [{volumeEnvelope:null},{volumeEnvelope:null}];
  const points=d.value.points,value=multiplier(points,cutFrame*1600);
  const left=points.filter(p=>p.frame<=cutFrame).map(p=>({...p}));
  const right=points.filter(p=>p.frame>=cutFrame).map(p=>({frame:p.frame-cutFrame,multiplier:p.multiplier}));
  if(!left.length)left.push({frame:cutFrame,multiplier:value});
  else if(left.at(-1).frame<cutFrame && points.at(-1).frame>cutFrame)left.push({frame:cutFrame,multiplier:value});
  if(!right.length)right.push({frame:0,multiplier:value});
  else if(right[0].frame>0 && points[0].frame<cutFrame)right.unshift({frame:0,multiplier:value});
  return [left,right].map((p,i)=>({volumeEnvelope:validateVolumeEnvelope({profileId:VOLUME_ENVELOPE_PROFILE,points:p},i?clip.durationFrames-cutFrame:cutFrame)}));
}
