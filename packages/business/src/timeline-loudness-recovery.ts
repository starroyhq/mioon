import {TIMELINE_LOUDNESS_APPLY_RESPONSE_BYTES, isTimelineLoudnessApplyInput} from '@mioon/contracts/timeline-loudness-apply';
import type {TimelineLoudnessApplyInput,TimelineLoudnessApplyResponse,TimelineLoudnessApplyTimeline} from '@mioon/contracts/timeline-loudness-apply';
interface Receipt {readonly requestHash:string;readonly response:string}
interface Dependencies {
  invalid():never;
  isResponse(value:unknown,input:unknown):value is TimelineLoudnessApplyResponse;
  /** Shared aggregate reader, using structure + DB ownership but no current
   * source duration/audio metadata semantics for historical acknowledgement. */
  readCurrent(historical:boolean):TimelineLoudnessApplyTimeline|null;
  sources(timeline:TimelineLoudnessApplyTimeline):unknown;
  readReceipt():Receipt|undefined;
}
/** Envelope-specific projection only. Historical media ownership/lineage is
 * checked by the original DB reader; no file/hash/decoder is reachable here. */
export function createTimelineLoudnessRecovery(input:unknown,deps:Dependencies){
  function validate(value:unknown):TimelineLoudnessApplyResponse {
    if(!isTimelineLoudnessApplyInput(input)||!deps.isResponse(value,input))return deps.invalid();
    return value;
  }
  return {
    replay(text:unknown):TimelineLoudnessApplyResponse {
      if(typeof text!=='string'||Buffer.byteLength(text)>TIMELINE_LOUDNESS_APPLY_RESPONSE_BYTES)return deps.invalid();
      let parsed:unknown;try{parsed=JSON.parse(text);}catch{return deps.invalid();}
      const response=validate(parsed),current=deps.readCurrent(true);
      if(!current||current.projectId!==response.timeline.projectId||current.id!==response.timeline.id||current.revision<response.timeline.revision)return deps.invalid();
      // Clips may have since disappeared or changed gain. Historical ownership
      // still binds every retained asset/shot/version without remeasurement.
      deps.sources(response.timeline);
      return response;
    },
    verify(response:unknown,requestHash:string):void {
      const exact=validate(response),current=deps.readCurrent(false);
      if(!current||JSON.stringify(current)!==JSON.stringify(exact.timeline))return deps.invalid();
      deps.sources(exact.timeline);
      const saved=deps.readReceipt();
      if(saved?.requestHash!==requestHash||saved.response!==JSON.stringify(exact))return deps.invalid();
    },
  };
}
