type NumericExpression=(n:number)=>number;
type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import test from 'node:test';
import assert from 'node:assert/strict';
import {compileVolumeEnvelopeFilterCandidate as compile,VOLUME_ENVELOPE_FILTER_BYTE_CAP} from '../packages/business/src/timeline-volume-envelope-filter-candidate.ts';
import {VOLUME_ENVELOPE_PROFILE,createVolumeEnvelopeEvaluator} from '../packages/contracts/src/timeline-volume-envelope.ts';
const clip=(points: readonly (readonly [number,number])[],durationFrames: number|undefined=18000)=>({durationFrames,volumeEnvelope:{profileId:VOLUME_ENVELOPE_PROFILE,points:points.map(([frame,multiplier])=>({frame,multiplier}))}});

// Independent restricted grammar reader/interpreter, not JS eval and not FFmpeg.
// Parses every branch, rejects leftover text, and preserves arithmetic grouping.
function parseFilter(filter: string) {
  assert.ok(filter.startsWith('aeval=exprs=val(ch)*('));
  assert.ok(filter.endsWith('):c=same'));
  const escaped=filter.slice('aeval=exprs=val(ch)*('.length,-'):c=same'.length);
  assert.ok(!/(?<!\\),/.test(escaped));
  assert.ok(!/\\(?!,)/.test(escaped));
  const text=escaped.replaceAll('\\,',',');
  const tokens=text.match(/(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|lte|lt|if|n|[()+*,/\-])/g);
  assert.equal((tokens)!.join(''),text);
  let cursor=0;
  const take=(t: string)=>{assert.equal((tokens)![cursor++],t);};
  function atom():NumericExpression {
    const t=(tokens)![cursor++];
    if(t==='('){const a=add();take(')');return a;}
    if(t==='n')return (n:number)=>n;
    if(['if','lt','lte'].includes(t)){
      take('(');const a=add();take(',');const b=add();
      if(t==='if'){take(',');const c=add();take(')');return (n:number)=>a(n)?b(n):c(n);}
      take(')');return t==='lt'?(n:number)=>+(a(n)<b(n)):(n:number)=>+(a(n)<=b(n));
    }
    assert.match(t,/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/);return ()=>Number(t);
  }
  function mul(){let a=atom();while(['*','/'].includes((tokens)![cursor])){const op=(tokens)![cursor++],l=a,r=atom();a=op==='*'?(n:number)=>l(n)*r(n):(n:number)=>l(n)/r(n);}return a;}
  function add(){let a=mul();while(['+','-'].includes((tokens)![cursor])){const op=(tokens)![cursor++],l=a,r=mul();a=op==='+'?(n:number)=>l(n)+r(n):(n:number)=>l(n)-r(n);}return a;}
  const result=add();assert.equal(cursor,(tokens)!.length);return result;
}

test('absent/null append no stage and preserve exact legacy string',()=>{
  const legacy='volume=1,afade=t=in:ss=0:ns=1600,asetpts=N/SR/TB';
  for(const c of ([{durationFrames:1},{durationFrames:1,volumeEnvelope:null}] as const)){
    assert.equal(compile(c,0,1600),'');
    assert.equal(legacy+compile(c,0,1600),legacy);
  }
});
test('nearest holds, exact anchors, sample boundaries and detached output',()=>{
  const c=clip([[2,0.8],[4,0.1],[7,1],[9,0]],12);
  const filter=compile(((c) as unknown as Parameters<typeof compile>[0]),0,19200), evaluate=parseFilter(filter), reference=createVolumeEnvelopeEvaluator(((c) as unknown as Parameters<typeof createVolumeEnvelopeEvaluator>[0]));
  for(const n of ([0,1,3199,3200,3201,6399,6400,6401,11199,11200,11201,14399,14400,19199] as const))assert.equal(evaluate(n),reference.atSample(n));
  for(const p of c.volumeEnvelope.points)assert.equal(evaluate(p.frame*1600),p.multiplier);
  c.volumeEnvelope.points[0].multiplier=0;assert.equal(evaluate(0),0.8);
});
test('original sample offset, seek inside ramp, segment and frame boundaries',()=>{
  const c=clip([[0,0],[4,1],[9,0.2]],12), reference=createVolumeEnvelopeEvaluator(((c) as unknown as Parameters<typeof createVolumeEnvelopeEvaluator>[0]));
  for(const offset of ([1,1599,1600,3201,6399,6400,9599,14400,19199] as const)){
    const count=19200-offset,evaluate=parseFilter(compile(((c) as unknown as Parameters<typeof compile>[0]),offset,count));
    for(const n of ([0,Math.min(1,count-1),Math.floor(count/2),count-1] as const))assert.equal(evaluate(n),reference.atSample(n+offset));
  }
});
test('one point, zero, unity, tiny and scientific notation numbers',()=>{
  for(const value of ([0,1,0.1,Number.MIN_VALUE,1e-7,0.9999999999999999] as const)){
    const evaluate=parseFilter(compile(((clip([[18000,value]])) as unknown as Parameters<typeof compile>[0]),0,28800000));
    for(const n of ([0,1,28799999] as const))assert.equal(evaluate(n),value);
  }
});
test('16-point maximum grammar and conservative escaped byte bound',()=>{
  // Per interval: 3 multiplier literals <=32 each, 2 x terms <=12 each,
  // three sample/delta literals <=8 each, 27 fixed/escaped ASCII =171.
  // Initial hold/final constant/stage wrapper reserve 192 more bytes.
  const bound=15*(3*32+2*12+3*8+27)+192;
  assert.ok(bound<=VOLUME_ENVELOPE_FILTER_BYTE_CAP);
  const c=clip(Array.from({length:16},(_,i)=>[17985+i,i%2?0.9999999999999999:Number.MIN_VALUE]));
  const filter=compile(((c) as unknown as Parameters<typeof compile>[0]),28799999,1),evaluate=parseFilter(filter);
  assert.ok(Buffer.byteLength(filter)<=bound);
  assert.equal(evaluate(0),createVolumeEnvelopeEvaluator(((c) as unknown as Parameters<typeof createVolumeEnvelopeEvaluator>[0])).atSample(28799999));
  const full=parseFilter(compile(((c) as unknown as Parameters<typeof compile>[0]),0,28800000));
  for(const p of c.volumeEnvelope.points)assert.equal(full(p.frame*1600),p.multiplier);
});
test('invalid ranges, integer samples, negative zero and unsupported shapes reject',()=>{
  const good=clip([[0,0],[1,1]],1);
  for(const [offset,count] of ([[-0,1],[-1,1],[0.5,1],[0,1.5],[0,0],[0,-0],[1600,1],[1599,2],[0,1601],[NaN,1],[0,Infinity],['0',1],[0,'1'],[Number.MAX_SAFE_INTEGER,1]] as const))assert.throws(()=>compile(((good) as unknown as Parameters<typeof compile>[0]),((offset) as unknown as Parameters<typeof compile>[1]),((count) as unknown as Parameters<typeof compile>[2])));
  for(const c of ([clip([[-0,1]],1),clip([[0,-0]],1),clip([[0,NaN]],1),clip([[0,Infinity]],1),clip([[0,2]],1),clip([[0,1],[0,0]],1),clip([[2,1]],1),clip([],1),clip(Array.from({length:17},(_,i)=>[i,1])),{durationFrames:1,volumeEnvelope:undefined}] as const))assert.throws(()=>compile(((c) as unknown as Parameters<typeof compile>[0]),0,1));
  for(const key of (['frame','multiplier'] as const)){const c=clip([[0,1]],1);c.volumeEnvelope.points[0][key]=('0);anullsrc;[out]' as unknown as ((((typeof c)["volumeEnvelope"])["points"])[number])[typeof key]);assert.throws(()=>compile(((c) as unknown as Parameters<typeof compile>[0]),0,1));}
  const c=clip([[0,1]],1);c.volumeEnvelope.profileId='if(1,1,0)';assert.throws(()=>compile(((c) as unknown as Parameters<typeof compile>[0]),0,1));
  c.volumeEnvelope.profileId=VOLUME_ENVELOPE_PROFILE;(c.volumeEnvelope as unknown as {extra:("anull")|(1)}).extra='anull';assert.throws(()=>compile(((c) as unknown as Parameters<typeof compile>[0]),0,1));
});
test('malformed records, point arrays and accessor properties reject',()=>{
  for(const mutate of ([
(    c: { volumeEnvelope: { points: string|unknown[]; }; })=>{(c.volumeEnvelope.points as {length: number}).length=2;},
(    c: { volumeEnvelope: { points: { extra: number; }; }; })=>{c.volumeEnvelope.points.extra=1;},
(    c: { volumeEnvelope: { points: { extra: number; }[]; }; })=>{c.volumeEnvelope.points[0].extra=1;},
(    c: { volumeEnvelope: { points: Date[]; }; })=>{c.volumeEnvelope.points[0]=new Date();},
(    c: { volumeEnvelope: { points: unknown; }; })=>{Object.defineProperty(c.volumeEnvelope.points,'0',{get(){throw Error('Unexpected getter execution');},enumerable:true});},
(    c?: unknown)=>{Object.defineProperty(c,'volumeEnvelope',{get(){throw Error('Unexpected getter execution');},enumerable:true});},
(    c: { volumeEnvelope: { points: { multiplier: number; }[]; }; })=>{c.volumeEnvelope.points[0].multiplier=-Number.MIN_VALUE;},
  ] as const)){
    const c=clip([[0,1]],1);(mutate as (value:unknown)=>unknown)(((((c) as unknown as Parameters<typeof mutate>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>));
    assert.throws(()=>compile(((c) as unknown as Parameters<typeof compile>[0]),0,1),error=>(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code==='INVALID_VOLUME_ENVELOPE');
  }
});
test('deterministic curves match pure evaluator over sampled original coordinates',()=>{
  let state=0x12345678;
  const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/2**32;};
  for(let run=0;run<20;run++){
    const c=clip(Array.from({length:16},(_,i)=>[i*1000,next()]));
    const reference=createVolumeEnvelopeEvaluator(((c) as unknown as Parameters<typeof createVolumeEnvelopeEvaluator>[0])),offset=Math.floor(next()*10000000);
    const evaluate=parseFilter(compile(((c) as unknown as Parameters<typeof compile>[0]),offset,28800000-offset));
    for(let i=0;i<100;i++){
      const n=Math.floor(next()*(28800000-offset));
      assert.equal(evaluate(n),reference.atSample(n+offset));
    }
  }
});
