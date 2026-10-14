import {nativeAudioAcquireResultSchema,nativeAudioEventSchema,nativeAudioLeaseSchema} from '@mioon/contracts/native-audio-preview';
import type {NativeAudioLease,NativeAudioPreviewBridge} from '@mioon/contracts/native-audio-preview';
import type {AudioPreviewPlan} from '@mioon/contracts/timeline-audio-preview';

export interface NativeAudioPreviewAttempt {
  acquire(plan:AudioPreviewPlan,signal:AbortSignal):Promise<NativeAudioLease>;
  retire(resources:Promise<void>):void;
}
export interface NativeAudioPreviewAdmission {
  begin(callbacks:{onRevoke:()=>void;onWaiting:(state:'waiting'|'blocked')=>void}):NativeAudioPreviewAttempt;
}
const failure=(code:string)=>Object.assign(new Error('Native sound audition is unavailable.'),{code});
const matches=(lease:NativeAudioLease,plan:AudioPreviewPlan):boolean=>lease.planHash===plan.planHash&&lease.owner.projectId===plan.projectId&&
  lease.input.projectId===plan.projectId&&lease.input.timelineId===plan.timelineId&&lease.input.expectedRevision===plan.timelineRevision&&
  lease.input.startFrame===plan.range.startFrame&&lease.admittedBytes===plan.memory.admittedBytes;

/** A desktop-only adapter. A null/invalid native bridge fails closed rather
 * than silently acquiring PCM through the ordinary Web path. */
export function createNativeAudioPreviewAdmission(bridge:NativeAudioPreviewBridge|null):NativeAudioPreviewAdmission {
  return {begin({onRevoke,onWaiting}){
    if(!bridge||!['acquire','cancel','retired','subscribe'].every(key=>typeof bridge[key as keyof NativeAudioPreviewBridge]==='function'))throw failure('NATIVE_AUDIO_UNAVAILABLE');
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
    return {
      async acquire(plan,signal){
        if(acquiring||cancelled||signal.aborted)throw failure('AUDIO_PREVIEW_CANCELLED');acquiring=true;
        const input={projectId:plan.projectId,timelineId:plan.timelineId,expectedRevision:plan.timelineRevision,startFrame:plan.range.startFrame};
        let rejectInterrupted!:(error:Error)=>void;
        const interrupted=new Promise<never>((_resolve,reject)=>{rejectInterrupted=reject;});
        const abort=()=>{cancel();rejectInterrupted(failure('AUDIO_PREVIEW_CANCELLED'));};
        signal.addEventListener('abort',abort,{once:true});
        acquisition=bridge.acquire(input,plan.planHash,actionId).then(raw=>{
          const parsed=nativeAudioAcquireResultSchema.safeParse(raw);if(!parsed.success)throw failure('NATIVE_AUDIO_UNAVAILABLE');
          if(parsed.data.status!=='granted'){
            if(parsed.data.status==='cancelled')throw failure('AUDIO_PREVIEW_CANCELLED');
            throw failure(parsed.data.status==='blocked'?'NATIVE_AUDIO_CLEANUP_UNCONFIRMED':parsed.data.status==='busy'?'NATIVE_AUDIO_BUSY':'NATIVE_AUDIO_UNAVAILABLE');
          }
          const granted=nativeAudioLeaseSchema.parse(parsed.data.lease);
          if(granted.actionId!==actionId||!matches(granted,plan))throw failure('NATIVE_AUDIO_UNAVAILABLE');
          lease=granted;if(cancelled){cancel();acknowledge();return null;}return lease;
        });
        // Observe a late grant after abort, retaining the exact action until it
        // can be retired. The aborted client itself must never receive it.
        void acquisition.catch(()=>{if(local)unsubscribe();});
        if(signal.aborted)abort();
        try{const result=await Promise.race([acquisition,interrupted]);
          if(cancelled||signal.aborted||!result)throw failure('AUDIO_PREVIEW_CANCELLED');return result;
        }finally{signal.removeEventListener('abort',abort);}
      },
      retire(resources){
        if(local)return;cancel();
        local=resources.then(()=> 'retired' as const,()=> 'unconfirmed' as const);
        acknowledge();
        if(acquisition)void acquisition.then(value=>{if(value)acknowledge();else if(!lease)unsubscribe();},()=>{if(!lease)unsubscribe();});
        else if(!lease)unsubscribe();
      },
    };
  }};
}
