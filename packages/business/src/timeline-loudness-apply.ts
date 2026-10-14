import {createHash} from 'node:crypto';
import {TIMELINE_LOUDNESS_APPLY_OPERATION, TIMELINE_LOUDNESS_CANDIDATE_VERSION,
  isTimelineLoudnessApplyInput, timelineLoudnessApplyInputSchema, canonicalTimelineLoudnessCandidate} from '@mioon/contracts/timeline-loudness-apply';
import type {TimelineLoudnessApplyInput, TimelineLoudnessApplyResponse, TimelineLoudnessApplication} from '@mioon/contracts/timeline-loudness-apply';
import type {TimelineMixLoudnessInput, TimelineMixLoudnessResponse} from '@mioon/contracts/timeline-mix-loudness';

export interface TimelineLoudnessFreshMeasurement {
  /** Backend-private continuation, invoked synchronously only after every
   * decoder is confirmed retired. Its finalFence expires on callback return. */
  withFreshMeasurement<T>(input: TimelineMixLoudnessInput,
    consume: (report: TimelineMixLoudnessResponse, finalFence: () => void) => T): Promise<T>;
}
export interface TimelineLoudnessApplyAdmission {
  readonly report: TimelineMixLoudnessResponse;
  readonly application: TimelineLoudnessApplication;
  readonly finalFence: () => void;
}
export interface TimelineLoudnessApplyTransactions {
  /** Short synchronous shared transaction. Receipt-first, exact content hash,
   * strict retained ACK replay. No current revision or media admission first. */
  prepare(input: TimelineLoudnessApplyInput):
    {replayed:true;response:TimelineLoudnessApplyResponse}|{replayed:false};
  /** The existing timeline mutation transaction: receipt-first again, then a
   * finalFence directly before exact gain changes, one history and one receipt. */
  accept(input: TimelineLoudnessApplyInput, admission: TimelineLoudnessApplyAdmission): TimelineLoudnessApplyResponse;
  /** Only called for known pre-accept candidate failures. Recheck owner,
   * receipt-first and rollback/no-write proof; a raced receipt may be replayed.
   * Do not infer a safe outcome merely from a code or from receipt absence. */
  rejectBeforeApply?(input: TimelineLoudnessApplyInput, error: Error & {code:string;status:number}): TimelineLoudnessApplyResponse;
}
const failure = (code:string,status=409):Error & {code:string;status:number} => Object.assign(
  new Error('The reviewed fixed gain candidate cannot be applied. Prepare and review the current saved timeline again.'),{code,status});
function freeze<T>(value:T):T {
  if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
/** Full fresh measurement authority is owned by the backend service. No public
 * report, gain array, approval flag or client timestamp can enter this lane. */
export function createTimelineLoudnessApplyServices(options:Readonly<{
  measurement:TimelineLoudnessFreshMeasurement;transactions:TimelineLoudnessApplyTransactions;
  /** Restore/owner/lifetime checks only: receipt replay must not require media. */
  assertAvailable:()=>void;
}>) {
  const {measurement,transactions,assertAvailable}=options;
  async function apply(rawInput:unknown):Promise<TimelineLoudnessApplyResponse> {
    // Restore/ownership precedes traversal of untrusted values, as in prepare.
    assertAvailable();
    if(!isTimelineLoudnessApplyInput(rawInput))throw failure('VALIDATION_ERROR',400);
    const input=freeze(timelineLoudnessApplyInputSchema.parse(rawInput));
    const prior=transactions.prepare(input);
    if(prior.replayed)return prior.response;
    const request:TimelineMixLoudnessInput={projectId:input.projectId,expectedRevision:input.expectedRevision,
      mixProfile:input.mixProfile,measurementProfile:input.measurementProfile,target:input.target};
    // Deliberately ignore transport disconnect. The owner controls shutdown;
    // accepted mutating work and its durable request identity outlive a socket.
    return measurement.withFreshMeasurement(request,(report,finalFence)=>{
      const reject=(code:string):TimelineLoudnessApplyResponse=>{
        const error=failure(code);if(transactions.rejectBeforeApply)return transactions.rejectBeforeApply(input,error);throw error;
      };
      const digest=`${TIMELINE_LOUDNESS_CANDIDATE_VERSION}:${createHash('sha256').update(canonicalTimelineLoudnessCandidate(report)).digest('hex')}`;
      if(report.projectId!==input.projectId||report.expectedRevision!==input.expectedRevision||
        report.mixProfile!==input.mixProfile||report.measurementProfile!==input.measurementProfile||
        report.target.integratedLufs!==input.target.integratedLufs||report.target.truePeakCeilingDbtp!==input.target.truePeakCeilingDbtp||
        report.identity.snapshotSha256!==input.snapshotSha256||digest!==input.candidateDigest)return reject('TIMELINE_LOUDNESS_APPLY_STALE');
      const candidate=report.candidate;
      if(candidate.status!=='measured'||!candidate.meetsTarget||!candidate.meetsTruePeak||
        candidate.gains.some(gain=>!Number.isFinite(gain.afterGain)||gain.afterGain<=0||gain.afterGain>2))return reject('TIMELINE_LOUDNESS_APPLY_UNSAFE');
      if(!candidate.gains.some(gain=>gain.afterGain!==gain.beforeGain))return reject('TIMELINE_LOUDNESS_APPLY_UNCHANGED');
      const application:TimelineLoudnessApplication=freeze({candidateDigest:input.candidateDigest,snapshotSha256:input.snapshotSha256,
        mixProfile:input.mixProfile,measurementProfile:input.measurementProfile,target:input.target,
        beforeRevision:input.expectedRevision,afterRevision:input.expectedRevision+1,gainMultiplier:candidate.gainMultiplier,
        gains:candidate.gains,original:report.original,candidate:candidate.measurement,
        meetsTarget:true,meetsTruePeak:true,marginDb:candidate.marginDb});
      // This must remain outside every media catch. No later fence may turn a
      // successful or uncertain commit into a claimed pre-write rejection.
      return transactions.accept(input,{report,application,finalFence});
    });
  }
  return {handlers:{[TIMELINE_LOUDNESS_APPLY_OPERATION]:apply}};
}
