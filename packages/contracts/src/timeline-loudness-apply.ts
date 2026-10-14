import {z} from 'zod';
import {EXPORT_LOUDNESS_ADVISORY_MARGIN_DB, exportLoudnessMeasurementSchema} from './export-loudness.ts';
import {TIMELINE_MIX_LOUDNESS_LIMITS, timelineMixLoudnessInputSchema, isTimelineMixLoudnessResponse} from './timeline-mix-loudness.ts';
import type {TimelineMixLoudnessResponse} from './timeline-mix-loudness.ts';
import type {AgentTimelineGainClip, AgentTimelineGainTrack} from './agent-timeline-gain.ts';

/** A content binding, never an approval token or a persisted measurement lease. */
export const TIMELINE_LOUDNESS_CANDIDATE_VERSION = 'timeline-loudness-candidate-v1';
export const TIMELINE_LOUDNESS_APPLY_OPERATION = 'timeline.loudness.apply';
export const TIMELINE_LOUDNESS_APPLY_RESPONSE_BYTES = 320 * 1024;
export const TIMELINE_LOUDNESS_APPLY_REJECTION_CODES = Object.freeze([
  'TIMELINE_LOUDNESS_APPLY_STALE', 'TIMELINE_LOUDNESS_APPLY_UNSAFE', 'TIMELINE_LOUDNESS_APPLY_UNCHANGED',
] as const);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const digest = z.string().regex(/^timeline-loudness-candidate-v1:[a-f0-9]{64}$/u);
const revision = z.number().finite().int().min(1).max(Number.MAX_SAFE_INTEGER);
const gain = z.object({clipId:z.string().uuid(),assetId:z.string().uuid(),beforeGain:z.number().finite().positive().max(2),
  afterGain:z.number().finite().positive().max(2)}).strict();
export const timelineLoudnessApplyInputSchema = timelineMixLoudnessInputSchema.extend({
  requestId:z.string().min(8).max(200),snapshotSha256:hash,candidateDigest:digest,
}).strict();
export const timelineLoudnessApplySchemas = Object.freeze({'timeline.loudness.apply':timelineLoudnessApplyInputSchema});
export type TimelineLoudnessApplyInput = z.infer<typeof timelineLoudnessApplyInputSchema>;
export const timelineLoudnessApplicationSchema = z.object({
  candidateDigest:digest,snapshotSha256:hash,mixProfile:timelineMixLoudnessInputSchema.shape.mixProfile,
  measurementProfile:timelineMixLoudnessInputSchema.shape.measurementProfile,target:timelineMixLoudnessInputSchema.shape.target,
  beforeRevision:revision,afterRevision:revision,gainMultiplier:z.number().finite().positive(),gains:z.array(gain).min(1).max(100),
  original:exportLoudnessMeasurementSchema,candidate:exportLoudnessMeasurementSchema,
  meetsTarget:z.literal(true),meetsTruePeak:z.literal(true),marginDb:z.literal(EXPORT_LOUDNESS_ADVISORY_MARGIN_DB),
}).strict();
export type TimelineLoudnessApplication = z.infer<typeof timelineLoudnessApplicationSchema>;
export type TimelineLoudnessApplyTimeline = Readonly<{id:string;projectId:string;revision:number;fps:30;width:number;height:number;
  tracks:readonly AgentTimelineGainTrack[];clips:readonly AgentTimelineGainClip[];durationFrames:number;createdAt:string;updatedAt:string;
  subtitles?:unknown}>;
export type TimelineLoudnessApplyResponse = Readonly<{operation:typeof TIMELINE_LOUDNESS_APPLY_OPERATION;requestId:string;
  timeline:TimelineLoudnessApplyTimeline;application:TimelineLoudnessApplication}>;

const encoder = new TextEncoder();
const object = (value:unknown): value is Record<string,unknown> => value!==null&&typeof value==='object'&&!Array.isArray(value);
const near = (a:number,b:number):boolean => Math.abs(a-b)<=1e-10*Math.max(1,Math.abs(b));
/** Descriptor-only bounded traversal before Zod or legacy validators may read.
 * Input mode deliberately rejects all arrays and keeps the durable 128-node cap. */
function bounded(value:unknown, maximum:number, input=false):boolean {
  let nodes=input?128:12000, bytes=0;
  const ancestors=new Set<object>();
  const visit=(item:unknown,depth:number):boolean=>{
    if(--nodes<0||depth>(input?8:16))return false;
    if(item===null||typeof item==='boolean')return true;
    if(typeof item==='number')return Number.isFinite(item);
    if(typeof item==='string'){bytes+=encoder.encode(item).length;return bytes<=maximum&&(!input||/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u.test(item));}
    if(typeof item!=='object'||ancestors.has(item))return false;
    const array=Array.isArray(item);
    if(array?(input||Object.getPrototypeOf(item)!==Array.prototype||item.length>100):![Object.prototype,null].includes(Object.getPrototypeOf(item)))return false;
    const keys=Reflect.ownKeys(item);
    if(keys.length>(array?101:64)||array&&keys.length!==item.length+1)return false;
    ancestors.add(item);
    for(const key of keys){
      if(array&&key==='length')continue;
      if(typeof key!=='string'||key==='__proto__'||array&&(!/^(?:0|[1-9][0-9]*)$/u.test(key)||Number(key)>=item.length))return false;
      bytes+=key.length;if(bytes>maximum)return false;
      const descriptor=Object.getOwnPropertyDescriptor(item,key);
      if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value')||!visit(descriptor.value,depth+1))return false;
    }
    ancestors.delete(item);return true;
  };
  try{return visit(value,0)&&encoder.encode(JSON.stringify(value)).length<=maximum;}catch{return false;}
}
export function isTimelineLoudnessApplyInput(value:unknown):value is TimelineLoudnessApplyInput {
  try{return bounded(value,8192,true)&&timelineLoudnessApplyInputSchema.safeParse(value).success;}catch{return false;}
}
function canonical(value:unknown):string {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
}
/** All public observation content participates except its changing wall clock.
 * Version/domain separation prevents confusion with an export snapshot digest. */
export function canonicalTimelineLoudnessCandidate(value:unknown):string {
  if(!isTimelineMixLoudnessResponse(value))throw new TypeError('A complete bounded timeline loudness report is required.');
  const {checkedAt: _checkedAt,...report}=value;
  return canonical({version:TIMELINE_LOUDNESS_CANDIDATE_VERSION,report});
}
export async function timelineLoudnessCandidateDigest(value:unknown):Promise<string> {
  const material=canonicalTimelineLoudnessCandidate(value);
  const bytes=await globalThis.crypto.subtle.digest('SHA-256',encoder.encode(material));
  return `${TIMELINE_LOUDNESS_CANDIDATE_VERSION}:${Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('')}`;
}
/** Ready only means this report describes an actually measured, changed gain
 * group meeting both explicit targets. It grants no backend mutation authority. */
export function isTimelineLoudnessApplicableReport(value:unknown):value is TimelineMixLoudnessResponse & {
  candidate:Extract<TimelineMixLoudnessResponse['candidate'],{status:'measured'}>
} {
  return isTimelineMixLoudnessResponse(value)&&value.candidate.status==='measured'&&value.candidate.meetsTarget&&
    value.candidate.meetsTruePeak&&value.candidate.gains.some(item=>item.afterGain!==item.beforeGain);
}

/** Keep the single established timeline DTO validator; do not grow a second
 * timeline parser or normalize old operation acknowledgements. */
export function createTimelineLoudnessApplyContracts({isTimelineRecord}:Readonly<{
  isTimelineRecord:(value:unknown,options?:Readonly<{projectId?:unknown}>)=>boolean;
}>) {
  function isTimelineLoudnessApplyResponse(value:unknown,input:unknown):value is TimelineLoudnessApplyResponse {
    try{
      if(!isTimelineLoudnessApplyInput(input)||!bounded(value,TIMELINE_LOUDNESS_APPLY_RESPONSE_BYTES)||!object(value)||
        Object.keys(value).length!==4||!['operation','requestId','timeline','application'].every(key=>Object.hasOwn(value,key))||
        value.operation!==TIMELINE_LOUDNESS_APPLY_OPERATION||value.requestId!==input.requestId||
        !isTimelineRecord(value.timeline,{projectId:input.projectId})||!object(value.timeline))return false;
      const parsed=timelineLoudnessApplicationSchema.safeParse(value.application);if(!parsed.success)return false;
      const application=parsed.data,timeline=value.timeline as unknown as TimelineLoudnessApplyTimeline;
      if(input.expectedRevision===Number.MAX_SAFE_INTEGER||timeline.revision!==input.expectedRevision+1||
        application.beforeRevision!==input.expectedRevision||application.afterRevision!==timeline.revision||
        application.candidateDigest!==input.candidateDigest||application.snapshotSha256!==input.snapshotSha256||
        application.mixProfile!==input.mixProfile||application.measurementProfile!==input.measurementProfile||
        application.target.integratedLufs!==input.target.integratedLufs||application.target.truePeakCeilingDbtp!==input.target.truePeakCeilingDbtp)return false;
      const {original,candidate,gains,gainMultiplier}=application;
      if(original.state!=='valid'||original.integratedLufs===null||candidate.state!=='valid'||candidate.integratedLufs===null||
        original.sampleFrames!==timeline.durationFrames*1600||candidate.sampleFrames!==original.sampleFrames||
        !near(gainMultiplier,10**((input.target.integratedLufs-original.integratedLufs)/20))||
        Math.abs(candidate.integratedLufs-input.target.integratedLufs)>TIMELINE_MIX_LOUDNESS_LIMITS.targetToleranceLu||
        candidate.truePeakDbtp===null||candidate.truePeakDbtp>input.target.truePeakCeilingDbtp-EXPORT_LOUDNESS_ADVISORY_MARGIN_DB||
        !gains.some(item=>item.beforeGain!==item.afterGain))return false;
      return gains.every((item,index)=>{
        if(index>0&&gains[index-1]!.clipId>=item.clipId||!near(item.afterGain,item.beforeGain*gainMultiplier))return false;
        const clip=timeline.clips.find(clip=>clip.id===item.clipId);
        return Boolean(clip&&clip.assetId===item.assetId&&clip.gain===item.afterGain&&
          timeline.tracks.some(track=>track.id===clip.trackId&&!track.muted));
      });
    }catch{return false;}
  }
  return {isTimelineLoudnessApplyResponse};
}

/** A retained request may be released only by the backend's exact pre-write,
 * rolled-back proof. Legacy timeline proofs with optional owner fields do not
 * grant this new operation a definitive outcome. */
export function hasTimelineLoudnessApplyNotAppliedProof(error:unknown,input:unknown):boolean {
  try{
    if(!isTimelineLoudnessApplyInput(input)||!object(error))return false;
    const own=(key:string):unknown=>{const d=Object.getOwnPropertyDescriptor(error,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;};
    const code=own('code'),status=own('status'),details=own('details');
    if(typeof code!=='string'||![...TIMELINE_LOUDNESS_APPLY_REJECTION_CODES,'REVISION_CONFLICT','TIMELINE_REVISION_LIMIT'].includes(code)||
      own('terminationUnconfirmed')===true||!bounded(details,8192,true)||!object(details)||
      !(typeof status==='number'&&Number.isInteger(status)&&status>=400&&status<=499&&status!==401&&status!==403||status===undefined&&own('definitive')===true))return false;
    return ['mutationOutcome','operation','projectId','requestId'].every(key=>Object.hasOwn(details,key))&&
      details.mutationOutcome==='not_applied'&&details.operation===TIMELINE_LOUDNESS_APPLY_OPERATION&&
      details.projectId===input.projectId&&details.requestId===input.requestId;
  }catch{return false;}
}
