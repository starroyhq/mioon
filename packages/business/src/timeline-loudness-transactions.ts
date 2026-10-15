import type {DatabaseSync} from 'node:sqlite';
import {TIMELINE_LOUDNESS_APPLY_OPERATION, TIMELINE_LOUDNESS_APPLY_REJECTION_CODES} from '@mioon/contracts/timeline-loudness-apply';
import type {TimelineLoudnessApplyInput, TimelineLoudnessApplyResponse, TimelineLoudnessApplyTimeline} from '@mioon/contracts/timeline-loudness-apply';
import type {TimelineLoudnessApplyTransactions} from './timeline-loudness-apply.ts';

type Mutable<T>={-readonly[K in keyof T]:T[K]};
type Timeline=Mutable<Omit<TimelineLoudnessApplyTimeline,'clips'>> & {clips:Mutable<TimelineLoudnessApplyTimeline['clips'][number]>[]};
interface Boundary {read():Timeline|null;validate(timeline:Timeline):unknown}
interface TransactionContext {boundary:Boundary;requestHash:string;write:()=>void}
type DomainError=Error & {code:string;status:number;details?:Record<string,unknown>};
interface Dependencies {
  readonly db:DatabaseSync;
  transaction<T>(operation:typeof TIMELINE_LOUDNESS_APPLY_OPERATION,input:TimelineLoudnessApplyInput,
    apply:(context:TransactionContext)=>T):T|TimelineLoudnessApplyResponse;
  editable(timeline:Timeline,input:TimelineLoudnessApplyInput):void;
  snapshot(timeline:Timeline):unknown;
  putTimeline(timeline:Timeline):void;
  admitTimelineImageResponse(timeline:Timeline):void;
  admitTimelineVolumeEnvelopeWrite(timeline:Timeline,options:{before:unknown;after:unknown;response:unknown}):void;
  recordEdit(operation:typeof TIMELINE_LOUDNESS_APPLY_OPERATION,timeline:Timeline,before:unknown):void;
  saveResponse(operation:typeof TIMELINE_LOUDNESS_APPLY_OPERATION,input:TimelineLoudnessApplyInput,requestHash:string,
    response:TimelineLoudnessApplyResponse,boundary:Boundary):TimelineLoudnessApplyResponse;
  now():string;
  error(code:string,status?:number):DomainError;
  isDomainError(error:unknown):error is DomainError;
}
const definiteCodes=new Set<string>([...TIMELINE_LOUDNESS_APPLY_REJECTION_CODES,'REVISION_CONFLICT','TIMELINE_REVISION_LIMIT']);
/** Adds only an admission adapter to the original aggregate transaction,
 * history writer and receipt store. There is no second mutation engine. */
export function createTimelineLoudnessTransactions(deps:Dependencies,assertAvailable:()=>void):TimelineLoudnessApplyTransactions {
  function run<T>(input:TimelineLoudnessApplyInput,body:(context:TransactionContext)=>T):T|TimelineLoudnessApplyResponse {
    let receiptAbsent=false,writesStarted=false,callbackFailed=false,callbackError:unknown;
    try{
      assertAvailable();
      return deps.transaction(TIMELINE_LOUDNESS_APPLY_OPERATION,input,context=>{
        // The shared transaction reaches this callback only after exact-key
        // receipt absence. All receipt replay/conflicts remain upstream.
        receiptAbsent=true;
        try{assertAvailable();return body({...context,write:()=>{writesStarted=true;context.write();}});}
        catch(error){
          // Keep the frozen loudness proof vocabulary. Image capacity is an
          // unsafe application, but retain its actionable capacity explanation.
          const failure=deps.isDomainError(error)&&error.code==='TIMELINE_IMAGE_AGGREGATE_BUDGET'
            ?Object.assign(deps.error('TIMELINE_LOUDNESS_APPLY_UNSAFE'),{message:error.message,details:error.details}):error;
          callbackFailed=true;callbackError=failure;throw failure;
        }
      });
    }catch(error){
      if(receiptAbsent&&callbackFailed&&error===callbackError&&!writesStarted&&!deps.db.isTransaction&&deps.isDomainError(error)&&definiteCodes.has(error.code)){
        // Owner/scope and fresh absence must still hold after a confirmed
        // rollback. Every failure of this proof keeps the result unknown.
        try{
          assertAvailable();
          if(!deps.db.prepare('SELECT 1 FROM timeline_requests WHERE requestId=?').get(input.requestId)){
            assertAvailable();
            error.details={...error.details,mutationOutcome:'not_applied',operation:TIMELINE_LOUDNESS_APPLY_OPERATION,
              projectId:input.projectId,requestId:input.requestId};
          }
        }catch{ /* A revoked scope or uncertain database never releases a key. */ }
      }
      throw error;
    }
  }
  return {
    prepare(input){
      const result=run(input,({boundary})=>{
        const timeline=boundary.read();if(!timeline)throw deps.error('TIMELINE_LOUDNESS_APPLY_STALE');
        deps.editable(timeline,input);return {replayed:false as const};
      });
      return 'replayed' in result?result:{replayed:true,response:result};
    },
    accept(input,admission){
      return run(input,({boundary,requestHash,write})=>{
        const timeline=boundary.read();if(!timeline)throw deps.error('TIMELINE_LOUDNESS_APPLY_STALE');
        deps.editable(timeline,input);
        if(timeline.id!==admission.report.identity.timelineId||timeline.revision!==admission.report.identity.timelineRevision)
          throw deps.error('TIMELINE_LOUDNESS_APPLY_STALE');
        const gains=admission.application.gains;
        for(const gain of gains){
          const clip=timeline.clips.find(clip=>clip.id===gain.clipId);
          if(!clip||clip.assetId!==gain.assetId||clip.gain!==gain.beforeGain)throw deps.error('TIMELINE_LOUDNESS_APPLY_STALE');
        }
        const before=deps.snapshot(timeline);
        for(const gain of gains)timeline.clips.find(clip=>clip.id===gain.clipId)!.gain=gain.afterGain;
        boundary.validate(timeline);
        timeline.revision++;timeline.updatedAt=deps.now();
        deps.admitTimelineImageResponse(timeline);
        const response:TimelineLoudnessApplyResponse={operation:TIMELINE_LOUDNESS_APPLY_OPERATION,requestId:input.requestId,
          timeline,application:admission.application};
        deps.admitTimelineVolumeEnvelopeWrite(timeline,{before,after:deps.snapshot(timeline),response});
        // Everything above changed only this private JS record. This is the
        // last owner/full-graph/source/deadline fence before the first write.
        admission.finalFence();
        write();deps.putTimeline(timeline);
        deps.recordEdit(TIMELINE_LOUDNESS_APPLY_OPERATION,timeline,before);
        return deps.saveResponse(TIMELINE_LOUDNESS_APPLY_OPERATION,input,requestHash,response,boundary);
      });
    },
    rejectBeforeApply(input,error){
      if(!TIMELINE_LOUDNESS_APPLY_REJECTION_CODES.some(code=>code===error.code))throw error;
      return run(input,()=>{throw deps.error(error.code,error.status);});
    },
  };
}
