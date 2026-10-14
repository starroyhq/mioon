import {z} from 'zod';
import {EXPORT_LOUDNESS_PROFILE, EXPORT_LOUDNESS_ADVISORY_MARGIN_DB,
  exportLoudnessTargetSchema, exportLoudnessMeasurementSchema} from './export-loudness.ts';

/** Read-only, complete saved-timeline observation; never an edit permission. */
export const TIMELINE_MIX_LOUDNESS_PROFILE = 'timeline-float-mix-v1';
export const TIMELINE_MIX_LOUDNESS_LIMITS = Object.freeze({sourceBytes:512*1024*1024,
  hashBytes:1024*1024*1024, pcmBytes:460800000, decodeWorkFrames:72000,
  timelineFrames:18000, segments:200, clips:100, tracks:12, timeoutMs:120000,
  clientTimeoutMs:125000, reportBytes:64*1024, targetToleranceLu:0.1} as const);
const id=z.string().uuid(), hash=z.string().regex(/^[a-f0-9]{64}$/u);
const count=(max:number,min=0):z.ZodNumber=>z.number().finite().int().min(min).max(max);
const near=(a:number,b:number):boolean=>Math.abs(a-b)<=1e-10*Math.max(1,Math.abs(b));
export const timelineMixLoudnessInputSchema=z.object({projectId:id,
  expectedRevision:count(Number.MAX_SAFE_INTEGER,1),
  mixProfile:z.literal(TIMELINE_MIX_LOUDNESS_PROFILE),measurementProfile:z.literal(EXPORT_LOUDNESS_PROFILE),
  target:exportLoudnessTargetSchema,
}).strict();
export type TimelineMixLoudnessInput=z.infer<typeof timelineMixLoudnessInputSchema>;
export const timelineMixLoudnessSchemas=Object.freeze({'timeline.loudness.prepare':timelineMixLoudnessInputSchema});
const source=z.object({assetId:id,sha256:hash,sizeBytes:count(TIMELINE_MIX_LOUDNESS_LIMITS.sourceBytes,1)}).strict();
const gain=z.object({clipId:id,assetId:id,beforeGain:z.number().finite().positive().max(2),
  afterGain:z.number().finite().positive().max(2)}).strict();
export type TimelineMixLoudnessGain=z.infer<typeof gain>;
const candidateCommon={marginDb:z.literal(EXPORT_LOUDNESS_ADVISORY_MARGIN_DB),applyAllowed:z.literal(false)};
export const timelineMixLoudnessCandidateSchema=z.discriminatedUnion('status',[
  z.object({...candidateCommon,status:z.literal('unavailable'),reason:z.enum(['NO_VALID_LOUDNESS','GAIN_OUT_OF_RANGE']),
    requiredGainDb:z.number().finite().nullable(),gainMultiplier:z.number().finite().positive().nullable(),
    gains:z.array(gain).max(0),measurement:z.null(),meetsTarget:z.literal(false),meetsTruePeak:z.literal(false)}).strict(),
  z.object({...candidateCommon,status:z.literal('measured'),reason:z.null(),requiredGainDb:z.number().finite(),
    gainMultiplier:z.number().finite().positive(),gains:z.array(gain).min(1).max(100),
    measurement:exportLoudnessMeasurementSchema,meetsTarget:z.boolean(),meetsTruePeak:z.boolean()}).strict(),
]);
export type TimelineMixLoudnessCandidate=z.infer<typeof timelineMixLoudnessCandidateSchema>;
export const timelineMixLoudnessResponseSchema=z.object({...timelineMixLoudnessInputSchema.shape,
  status:z.literal('ready'),checkedAt:z.string().max(30).datetime(),stage:z.literal('preencode_float_mix'),applyAllowed:z.literal(false),
  identity:z.object({timelineId:id,timelineRevision:count(Number.MAX_SAFE_INTEGER,1),snapshotSha256:hash,
    range:z.object({startFrame:z.literal(0),endFrame:count(18000,1),sampleFrames:count(28800000,1600)}).strict(),
    sources:z.array(source).max(100)}).strict(),
  original:exportLoudnessMeasurementSchema,candidate:timelineMixLoudnessCandidateSchema,
  checks:z.object({bytesHashed:count(TIMELINE_MIX_LOUDNESS_LIMITS.hashBytes),pcmBytes:count(TIMELINE_MIX_LOUDNESS_LIMITS.pcmBytes),
    decodeWorkFrames:count(TIMELINE_MIX_LOUDNESS_LIMITS.decodeWorkFrames),segmentCount:count(200,1),
    passes:z.union([z.literal(1),z.literal(2)]),audioFullyDecoded:z.literal(true)}).strict(),
}).strict().superRefine((v,c)=>{
  const fail=(message:string):void=>c.addIssue({code:z.ZodIssueCode.custom,message});
  const {range,sources}=v.identity;
  if(v.identity.timelineRevision!==v.expectedRevision)fail('Saved revision must match the requested revision.');
  if(range.sampleFrames!==range.endFrame*1600||v.original.sampleFrames!==range.sampleFrames)
    fail('Complete float mixes require exact sample counts without AAC tolerance.');
  if(sources.some((s,i)=>i>0&&sources[i-1]!.assetId>=s.assetId))fail('Source identities must be unique and sorted.');
  const sourceBytes=sources.reduce((n,s)=>n+s.sizeBytes,0);
  if(sourceBytes>TIMELINE_MIX_LOUDNESS_LIMITS.sourceBytes||v.checks.bytesHashed!==2*sourceBytes)
    fail('All unique potentially audible sources require two complete hash passes.');
  const candidate=v.candidate, passes=candidate.status==='measured'?2:1;
  if(v.checks.passes!==passes||v.checks.pcmBytes!==range.sampleFrames*8*passes||v.checks.decodeWorkFrames%passes!==0)
    fail('Work counters must describe the actual complete passes.');
  const valid=v.original.state==='valid'&&v.original.integratedLufs!==null;
  const required=valid?v.target.integratedLufs-v.original.integratedLufs!:null;
  const multiplier=required===null?null:10**(required/20);
  if(required===null?candidate.requiredGainDb!==null||candidate.gainMultiplier!==null:
    candidate.requiredGainDb===null||candidate.gainMultiplier===null||!near(candidate.requiredGainDb,required)||!near(candidate.gainMultiplier,multiplier!))
    fail('Candidate multiplier must bind the measured original and explicit target.');
  if(candidate.status==='unavailable'){
    if((candidate.reason==='NO_VALID_LOUDNESS')===valid)fail('Unavailable reason must match the actual measurement.');
  }else{
    if(!valid||candidate.measurement.sampleFrames!==range.sampleFrames)fail('Candidate must be a separately completed full mix.');
    if(candidate.gains.some((g,i)=>i>0&&candidate.gains[i-1]!.clipId>=g.clipId))fail('Candidate gains must be unique and sorted.');
    if(candidate.gains.some(g=>!sources.some(s=>s.assetId===g.assetId)||!near(g.afterGain,g.beforeGain*candidate.gainMultiplier)))
      fail('Every gain must bind a source and the single fixed multiplier without clamping.');
    const measured=candidate.measurement;
    if(candidate.meetsTarget!==(measured.state==='valid'&&measured.integratedLufs!==null&&
      Math.abs(measured.integratedLufs-v.target.integratedLufs)<=TIMELINE_MIX_LOUDNESS_LIMITS.targetToleranceLu))
      fail('Target comparison requires the actual candidate measurement.');
    if(candidate.meetsTruePeak!==(measured.truePeakDbtp!==null&&measured.truePeakDbtp<=v.target.truePeakCeilingDbtp-EXPORT_LOUDNESS_ADVISORY_MARGIN_DB))
      fail('True-peak comparison must reserve the explicit application margin.');
  }
});
export type TimelineMixLoudnessResponse=z.infer<typeof timelineMixLoudnessResponseSchema>;

/** Inspect bounded plain values before schema traversal; never invoke getters. */
function bounded(value:unknown):boolean{
  const ancestors=new Set<object>();let nodes=6000,bytes=0;
  const visit=(v:unknown,depth:number):boolean=>{
    if(--nodes<0||depth>12)return false;
    if(v===null||typeof v==='boolean')return true;
    if(typeof v==='number')return Number.isFinite(v);
    if(typeof v==='string'){bytes+=new TextEncoder().encode(v).length;return bytes<=TIMELINE_MIX_LOUDNESS_LIMITS.reportBytes;}
    if(typeof v!=='object'||ancestors.has(v))return false;
    const array=Array.isArray(v);
    if(array?Object.getPrototypeOf(v)!==Array.prototype||v.length>100:![Object.prototype,null].includes(Object.getPrototypeOf(v)))return false;
    const keys=Reflect.ownKeys(v);
    if(keys.length>(array?101:40)||array&&keys.length!==v.length+1)return false;
    ancestors.add(v);
    for(const key of keys){
      if(array&&key==='length')continue;
      if(typeof key!=='string'||array&&(!/^(?:0|[1-9][0-9]*)$/u.test(key)||Number(key)>=v.length))return false;
      bytes+=key.length;if(bytes>TIMELINE_MIX_LOUDNESS_LIMITS.reportBytes)return false;
      const d=Object.getOwnPropertyDescriptor(v,key);
      if(!d?.enumerable||!Object.hasOwn(d,'value')||!visit(d.value,depth+1))return false;
    }
    ancestors.delete(v);return true;
  };
  return visit(value,0)&&new TextEncoder().encode(JSON.stringify(value)).length<=TIMELINE_MIX_LOUDNESS_LIMITS.reportBytes;
}
export function isTimelineMixLoudnessResponse(value:unknown,input?:unknown):value is TimelineMixLoudnessResponse{
  try{
    if(!bounded(value))return false;
    const parsed=timelineMixLoudnessResponseSchema.safeParse(value);if(!parsed.success)return false;
    if(input===undefined)return true;
    const request=timelineMixLoudnessInputSchema.safeParse(input);
    return request.success&&parsed.data.projectId===request.data.projectId&&parsed.data.expectedRevision===request.data.expectedRevision&&
      parsed.data.mixProfile===request.data.mixProfile&&parsed.data.measurementProfile===request.data.measurementProfile&&
      parsed.data.target.integratedLufs===request.data.target.integratedLufs&&parsed.data.target.truePeakCeilingDbtp===request.data.target.truePeakCeilingDbtp;
  }catch{return false;}
}
