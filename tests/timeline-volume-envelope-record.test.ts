type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import test from 'node:test';
import assert from 'node:assert/strict';
import {isTimelineRecord} from '../packages/contracts/src/timeline-replacement.ts';
import {isTimelineVolumeEnvelopeRecord} from '../packages/contracts/src/timeline-volume-envelope-record.ts';
import {isTimelineVolumeEnvelopeCandidateRecord as historical} from './helpers/timeline-volume-envelope-candidate.ts';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const profileId = 'mioon-clip-linear-attenuation-v1';
function fixture(field: {volumeEnvelope?: undefined | null | { profileId: string; points: { frame: number; multiplier: number; }[]; };} = {}) {
 return {id:id(1),projectId:id(2),revision:1,fps:30,width:720,height:1280,
 tracks:[{id:id(3),name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
 clips:[{id:id(4),trackId:id(3),assetId:id(5),name:'Clip',startFrame:0,durationFrames:20,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,...field}],
 durationFrames:20,createdAt:'2026-10-10T00:00:00.000Z',updatedAt:'2026-10-10T00:00:00.000Z'};
}
const curve = () => ({profileId,points:[{frame:0,multiplier:0},{frame:20,multiplier:1}]});
const valid = (value?: unknown, options: { projectId?: unknown; } = {}) => isTimelineVolumeEnvelopeRecord(value,options,isTimelineRecord);
function equivalent(value: unknown,expected: boolean,options: { [x: string]: unknown; }|undefined={}) {
 assert.equal(historical(value,options),expected,'historical guard');
 assert.equal(valid(value,options),expected,'typed extraction');
}
test('typed record extraction preserves absent/null/value, owner binding and detached bytes',()=>{
 for(const field of ([{},{volumeEnvelope:null},{volumeEnvelope:curve()}] as const)) {
  const value=fixture(field),before=JSON.stringify(value);
  equivalent(value,true);equivalent(value,true,{projectId:id(2)});
  equivalent(value,false,{projectId:id(9)});equivalent(value,false,{unknown:true});
  assert.equal(JSON.stringify(value),before);
 }
 assert.equal(isTimelineVolumeEnvelopeRecord(fixture(),{},((undefined) as unknown as Parameters<typeof isTimelineVolumeEnvelopeRecord>[2])),false);
});
test('Unicode ES2022 predicate is equivalent for every UTF-16 code unit and pair boundaries',()=>{
 const wellFormed=(value: string)=>/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u.test(value);
 for(let unit=0;unit<=0xffff;unit++){
  const text=String.fromCharCode(unit);
  assert.equal(wellFormed(text),text.isWellFormed(),`unit ${unit}`);
 }
 for(const high of ([0xd800,0xdbff] as const))for(const low of ([0xdc00,0xdfff] as const)){
  const text=String.fromCharCode(high,low);assert.equal(wellFormed(text),true);
  equivalent(fixture((({name:text}) as unknown as Parameters<NonNullable<typeof fixture>>[0])),true);
 }
 for(const text of (['\ud800','\udfff','\ud800x','x\udc00','\udc00\ud800','\ud800\ud800','\udc00\udc00'] as const))equivalent(fixture((({name:text}) as unknown as Parameters<NonNullable<typeof fixture>>[0])),false);
});
test('decoded JSON retains negative-zero, unknown-key, typed-array and profile refusal',()=>{
 for(const mutate of ([
(  v: { revision: number; })=>{v.revision=-0;},(v: { clips: { gain: number; }[]; })=>{v.clips[0].gain=-0;},(v: { clips: { rect: { x: number; }; }[]; })=>{v.clips[0].rect.x=-0;},
(  v: { clips: { volumeEnvelope: { points: { frame: number; }[]; }; }[]; })=>{v.clips[0].volumeEnvelope.points[0].frame=-0;},(v: { clips: { volumeEnvelope: { points: { multiplier: number; }[]; }; }[]; })=>{v.clips[0].volumeEnvelope.points[0].multiplier=-0;},
(  v: { extra: boolean; })=>{v.extra=true;},(v: { clips: { extra: boolean; }[]; })=>{v.clips[0].extra=true;},(v: { clips: { volumeEnvelope: { extra: boolean; }; }[]; })=>{v.clips[0].volumeEnvelope.extra=true;},
(  v: { clips: { volumeEnvelope: { profileId: string; }; }[]; })=>{v.clips[0].volumeEnvelope.profileId='future';},(v: { clips: { volumeEnvelope: { points: { frame: number; multiplier: number; }[]; }; }[]; })=>{v.clips[0].volumeEnvelope.points=Array.from({length:17},(_,frame)=>({frame,multiplier:1}));},
(  v: { clips: { rect: never[]; }[]; })=>{v.clips[0].rect=[];},(v: { tracks: { name: never[]; }[]; })=>{v.tracks[0].name=[];},(v: { extra: never[]; })=>{v.extra=[];},
(  v: { clips: { volumeEnvelope: { points: { multiplier: number[]; }[]; }; }[]; })=>{v.clips[0].volumeEnvelope.points[0].multiplier=[0];},
 ] as const)){const value=fixture({volumeEnvelope:curve()});mutate(((((value) as unknown as Parameters<typeof mutate>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>));equivalent(value,false);}
 // JSON.parse preserves lexical -0 even though stringify does not.
 const raw=JSON.stringify(fixture({volumeEnvelope:curve()})).replace('"gain":1','"gain":-0');
 equivalent(JSON.parse(raw),false);
});
test('prototype/descriptor/proxy and array-cap invariant matches without effects',()=>{
 let effects=0;
 const hostile=(value?: unknown)=>new Proxy(((value) as unknown as ConstructorParameters<typeof Proxy>[0]),{get(){effects++;throw Error();},getPrototypeOf(){effects++;throw Error();},ownKeys(){effects++;throw Error();},getOwnPropertyDescriptor(){effects++;throw Error();}});
 for(const mutate of ([
(  v?: unknown)=>hostile(v),(v: { clips: unknown; })=>{v.clips=hostile(v.clips);return v;},
(  v: { clips: unknown[]; })=>{Object.defineProperty(v.clips[0],'name',{get(){effects++;throw Error();},enumerable:true});return v;},
(  v: { clips: unknown[]; })=>{Object.setPrototypeOf(v.clips[0],Date.prototype);return v;},
(  v: { clips: unknown; })=>{Object.setPrototypeOf(v.clips,class Odd extends Array{}.prototype);return v;},
(  v: { clips: { [x: string]: number; }; })=>{(v.clips as unknown as Record<symbol,unknown>)[Symbol('hidden')]=1;return v;},
(  v: { clips: unknown[]; })=>{Object.defineProperty(v.clips[0],'name',{value:'hidden',enumerable:false});return v;},
(  v: { clips: { volumeEnvelope: { points: unknown[]; }; }[]; })=>{delete v.clips[0].volumeEnvelope.points[0];return v;},
(  v: { clips: { volumeEnvelope: { points: { extra: boolean; }; }; }[]; })=>{v.clips[0].volumeEnvelope.points.extra=true;return v;},
(  v: { clips: string|unknown[]; })=>{(v.clips as {length: number}).length=100000000;return v;},
(  v: { cycle: unknown; })=>{v.cycle=v;return v;},
 ] as const))equivalent((mutate as (value:unknown)=>unknown)(((((fixture({volumeEnvelope:curve()})) as unknown as Parameters<typeof mutate>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>)),false);
 assert.equal(effects,0);
 const value=fixture({volumeEnvelope:curve()});Object.setPrototypeOf(value,null);equivalent(value,true);
});
test('complete timeline aggregate retains exact 256KiB boundary',()=>{
 const value=fixture();
 value.tracks=Array.from({length:12},(_,n)=>({...value.tracks[0],id:id(100+n),name:'\u0001'.repeat(150),orderIndex:n}));
 const colour={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:'a'.repeat(64),streamIndex:0,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:value.createdAt},look:{resourceId:id(800),resourceSha256:'b'.repeat(64),resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:0.12345678901234568}};
 value.clips=Array.from({length:100},(_,n)=>({...structuredClone(value.clips[0]),id:id(300+n),trackId:value.tracks[n%12].id,startFrame:Math.floor(n/12)*30,durationFrames:30,name:'\u0001'.repeat(200),versionId:id(500+n),shotId:id(600+n),jobId:id(700+n),fadeInFrames:0,fadeOutFrames:0,colour:structuredClone(colour),volumeEnvelope:{profileId,points:Array.from({length:16},(_,frame)=>({frame,multiplier:0.0000010000000000000002}))}}));
 value.durationFrames=270;
 for(const target of ([262143,262144,262145] as const)){
  const candidate=structuredClone(value);let excess=Buffer.byteLength(JSON.stringify(candidate))-target;
  assert.ok(excess>0);
  for(const clip of candidate.clips){const replace=Math.min(Math.floor(excess/5),clip.name.length);clip.name='x'.repeat(replace)+clip.name.slice(replace);excess-=replace*5;if(excess<5)break;}
  if(excess){const clip=candidate.clips.find(clip=>clip.name.startsWith('x'.repeat(excess))&&clip.name.length>excess);assert.ok(clip);clip.name=clip.name.slice(excess);}
  assert.equal(Buffer.byteLength(JSON.stringify(candidate)),target);
  equivalent(candidate,target<=262144);
 }
});
