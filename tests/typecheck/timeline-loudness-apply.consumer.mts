import {timelineLoudnessApplyInputSchema,isTimelineLoudnessApplyInput,canonicalTimelineLoudnessCandidate} from '@mioon/contracts/timeline-loudness-apply';
import type {TimelineLoudnessApplyInput,TimelineLoudnessApplyResponse} from '@mioon/contracts/timeline-loudness-apply';
import type {TimelineMixLoudnessResponse} from '@mioon/contracts/timeline-mix-loudness';
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Expect<T extends true>=T;
type NotAny<T>=0 extends(1&T)?false:true;
type ExactInput=Expect<Equal<keyof TimelineLoudnessApplyInput,'projectId'|'expectedRevision'|'requestId'|'mixProfile'|'measurementProfile'|'target'|'snapshotSha256'|'candidateDigest'>>;
type RealInput=Expect<Equal<ReturnType<typeof timelineLoudnessApplyInputSchema.parse>,TimelineLoudnessApplyInput>>;
type RealOutput=Expect<NotAny<TimelineLoudnessApplyResponse>>;
export function consume(value:unknown,report:TimelineMixLoudnessResponse,response:TimelineLoudnessApplyResponse):void{
 if(isTimelineLoudnessApplyInput(value)){
  const input:TimelineLoudnessApplyInput=value;
  // @ts-expect-error Client gains never grant write authority.
  input.gains;
  // @ts-expect-error Explicit source binding cannot be omitted.
  const incomplete:TimelineLoudnessApplyInput={projectId:input.projectId,expectedRevision:1,requestId:input.requestId,mixProfile:input.mixProfile,measurementProfile:input.measurementProfile,target:input.target};
  void incomplete;
 }
 const readonly:false=report.applyAllowed;
 const applied:true=response.application.meetsTarget;
 const operation:'timeline.loudness.apply'=response.operation;
 // @ts-expect-error The immutable application response cannot be a different operation.
 const other:'timeline.clip.update'=response.operation;
 void[readonly,applied,operation,other,canonicalTimelineLoudnessCandidate(report)];
}
