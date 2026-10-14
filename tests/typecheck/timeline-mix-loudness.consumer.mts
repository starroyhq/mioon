import {TIMELINE_MIX_LOUDNESS_PROFILE,timelineMixLoudnessInputSchema,isTimelineMixLoudnessResponse} from '@mioon/contracts/timeline-mix-loudness';
import type {TimelineMixLoudnessInput,TimelineMixLoudnessResponse,TimelineMixLoudnessCandidate} from '@mioon/contracts/timeline-mix-loudness';
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Expect<T extends true>=T;
type NotAny<T>=0 extends(1&T)?false:true;
type InputKeys=Expect<Equal<keyof TimelineMixLoudnessInput,'projectId'|'expectedRevision'|'mixProfile'|'measurementProfile'|'target'>>;
type RealInput=Expect<Equal<ReturnType<typeof timelineMixLoudnessInputSchema.parse>,TimelineMixLoudnessInput>>;
type RealOutput=Expect<NotAny<TimelineMixLoudnessResponse>>;
type RealCandidate=Expect<NotAny<TimelineMixLoudnessCandidate>>;
type Profile=Expect<Equal<typeof TIMELINE_MIX_LOUDNESS_PROFILE,'timeline-float-mix-v1'>>;
export function consume(input:TimelineMixLoudnessInput,value:unknown):void{
  // @ts-expect-error Explicit numeric target is mandatory, not a platform default.
  const absent:TimelineMixLoudnessInput={projectId:input.projectId,expectedRevision:1,mixProfile:input.mixProfile,measurementProfile:input.measurementProfile};
  // @ts-expect-error Observation grants no mutation request identity.
  input.requestId;
  // @ts-expect-error Arbitrary caller file paths are never accepted.
  input.path;
  if(isTimelineMixLoudnessResponse(value,input)){
    const report:TimelineMixLoudnessResponse=value;
    const noApply:false=report.applyAllowed;
    // @ts-expect-error Passing measurements never grants apply authority.
    const apply:true=report.candidate.applyAllowed;
    if(report.candidate.status==='measured'){
      const gains:readonly {clipId:string;beforeGain:number;afterGain:number}[]=report.candidate.gains;
      void gains;
    }else{
      const absentMeasurement:null=report.candidate.measurement;
      void absentMeasurement;
    }
    void[noApply,apply];
  }
  void absent;
}
