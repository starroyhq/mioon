import {nativeAudioAcquireResultSchema,nativeAudioEventSchema,nativeAudioLeaseSchema} from '@mioon/contracts/native-audio-preview';
import type {NativeAudioLease,NativeAudioContinuousLease,NativeAudioPreviewBridge} from '@mioon/contracts/native-audio-preview';
import type {AudioPreviewPlan} from '@mioon/contracts/timeline-audio-preview';
import type {ContinuousAudioPlan} from '@mioon/contracts/timeline-audio-continuous';

export interface NativeAudioPreviewAttempt {
  acquire(plan:AudioPreviewPlan,signal:AbortSignal):Promise<NativeAudioLease>;
  retire(resources:Promise<void>):void;
}
export interface NativeAudioPreviewAdmission {
  begin(callbacks:{onRevoke:()=>void;onWaiting:(state:'waiting'|'blocked')=>void}):NativeAudioPreviewAttempt;
  beginContinuous(callbacks:{onRevoke:()=>void;onWaiting:(state:'waiting'|'blocked')=>void}):NativeAudioContinuousAttempt;
}
export interface NativeAudioContinuousAttempt {
  acquireContinuous(plan:ContinuousAudioPlan,sessionId:string,signal:AbortSignal):Promise<NativeAudioContinuousLease>;
  retire(resources:Promise<void>):void;
}
const failure=(code:string)=>Object.assign(new Error('Native sound audition is unavailable.'),{code});
const matches=(lease:NativeAudioLease,plan:AudioPreviewPlan):boolean=>lease.planHash===plan.planHash&&lease.owner.projectId===plan.projectId&&
  lease.input.projectId===plan.projectId&&lease.input.timelineId===plan.timelineId&&lease.input.expectedRevision===plan.timelineRevision&&
  lease.input.startFrame===plan.range.startFrame&&lease.admittedBytes===plan.memory.admittedBytes;

/** A desktop-only adapter. A null/invalid native bridge fails closed rather
 * than silently acquiring PCM through the ordinary Web path. */
export function createNativeAudioPreviewAdmission(bridge:NativeAudioPreviewBridge|null):NativeAudioPreviewAdmission {
  function begin({onRevoke,onWaiting}:{onRevoke:()=>void;onWaiting:(state:'waiting'|'blocked')=>void},continuous:boolean){
    if(!bridge||![continuous?'acquireContinuous':'acquire','cancel','retired','subscribe'].every(key=>typeof bridge[key as keyof NativeAudioPreviewBridge]==='function'))throw failure('NATIVE_AUDIO_UNAVAILABLE');
    const availableBridge=bridge;
    const actionId=crypto.randomUUID();let lease:NativeAudioLease|null=null,cancelled=false,acquiring=false,acknowledged=false;
    let local:Promise<'retired'|'unconfirmed'>|null=null,acquisition:Promise<NativeAudioLease|null>|null=null;
    const cancel=():void=>{cancelled=true;void bridge.cancel(actionId).catch(()=>{/* Unknown transport never releases capacity. */});};
    let unsubscribe=()=>{};
    const acknowledge=():void=>{
      if(!local||!lease||acknowledged)return;acknowledged=true;
      const exact=lease;
      void local.then(status=>bridge.retired(exact,status)).catch(()=>{/* Main retains an unknown cleanup. */}).finally(()=>unsubscribe());
    };
    unsubscribe=bridge.subscribe(raw=>{
      const parsed=nativeAudioEventSchema.safeParse(raw);if(!parsed.success)return;const event=parsed.data;
      if(event.type==='revoke'){
        if(event.lease.actionId!==actionId||lease&&event.lease.leaseId!==lease.leaseId)return;
        lease??=event.lease;cancel();onRevoke();acknowledge();
      }else if(event.actionId===actionId&&!cancelled)onWaiting(event.type);
    });
    const acquire=async(plan:AudioPreviewPlan|ContinuousAudioPlan,signal:AbortSignal,sessionId?:string):Promise<NativeAudioLease>=>{
        if(acquiring||cancelled||signal.aborted)throw failure('AUDIO_PREVIEW_CANCELLED');acquiring=true;
        const input={projectId:plan.projectId,timelineId:plan.timelineId,expectedRevision:plan.timelineRevision,startFrame:'range' in plan?plan.range.startFrame:plan.startFrame};
        let rejectInterrupted!:(error:Error)=>void;
        const interrupted=new Promise<never>((_resolve,reject)=>{rejectInterrupted=reject;});
        const abort=()=>{cancel();rejectInterrupted(failure('AUDIO_PREVIEW_CANCELLED'));};
        signal.addEventListener('abort',abort,{once:true});
        acquisition=(sessionId===undefined?availableBridge.acquire(input,plan.planHash,actionId):availableBridge.acquireContinuous(input,plan.planHash,sessionId,actionId)).then(raw=>{
          const parsed=nativeAudioAcquireResultSchema.safeParse(raw);if(!parsed.success)throw failure('NATIVE_AUDIO_UNAVAILABLE');
          if(parsed.data.status!=='granted'){
            if(parsed.data.status==='cancelled')throw failure('AUDIO_PREVIEW_CANCELLED');
            throw failure(parsed.data.status==='blocked'?'NATIVE_AUDIO_CLEANUP_UNCONFIRMED':parsed.data.status==='busy'?'NATIVE_AUDIO_BUSY':'NATIVE_AUDIO_UNAVAILABLE');
          }
          const granted=nativeAudioLeaseSchema.parse(parsed.data.lease);
          const matched='range' in plan?!('sessionId' in granted)&&matches(granted,plan):
            'sessionId' in granted&&granted.sessionId===sessionId&&granted.admittedBytes===plan.admittedBytes&&
            granted.planHash===plan.planHash&&granted.owner.projectId===plan.projectId&&granted.input.projectId===plan.projectId&&
            granted.input.timelineId===plan.timelineId&&granted.input.expectedRevision===plan.timelineRevision&&granted.input.startFrame===plan.startFrame;
          if(granted.actionId!==actionId||!matched)throw failure('NATIVE_AUDIO_UNAVAILABLE');
          lease=granted;if(cancelled){cancel();acknowledge();return null;}return lease;
        });
        // Observe a late grant after abort, retaining the exact action until it
        // can be retired. The aborted client itself must never receive it.
        void acquisition.catch(()=>{if(local)unsubscribe();});
        if(signal.aborted)abort();
        try{const result=await Promise.race([acquisition,interrupted]);
          if(cancelled||signal.aborted||!result)throw failure('AUDIO_PREVIEW_CANCELLED');return result;
        }finally{signal.removeEventListener('abort',abort);}
    };
    return {
      acquire:(plan:AudioPreviewPlan,signal:AbortSignal)=>acquire(plan,signal),
      async acquireContinuous(plan:ContinuousAudioPlan,sessionId:string,signal:AbortSignal):Promise<NativeAudioContinuousLease>{
        const granted=await acquire(plan,signal,sessionId);if(!('sessionId' in granted))throw failure('NATIVE_AUDIO_UNAVAILABLE');return granted;
      },
      retire(resources:Promise<void>){
        if(local)return;cancel();
        local=resources.then(()=> 'retired' as const,()=> 'unconfirmed' as const);
        acknowledge();
        if(acquisition)void acquisition.then(value=>{if(value)acknowledge();else if(!lease)unsubscribe();},()=>{if(!lease)unsubscribe();});
        else if(!lease)unsubscribe();
      },
    };
  }
  return {begin:callbacks=>begin(callbacks,false),beginContinuous:callbacks=>begin(callbacks,true)};
}
