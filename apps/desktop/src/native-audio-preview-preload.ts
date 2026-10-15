import {nativeAudioOwnerSchema,nativeAudioLeaseSchema,sameNativeAudioOwner} from '@mioon/contracts/native-audio-preview';
import type {NativeAudioOwner} from '@mioon/contracts/native-audio-preview';
import type {AudioPreviewPlanInput} from '@mioon/contracts/timeline-audio-preview';
import {NATIVE_AUDIO_CHANNEL,NATIVE_AUDIO_EVENT,nativeAudioRequestSchema,nativeAudioAcquireResultSchema,nativeAudioEventSchema} from './native-audio-preview-protocol.ts';
import type {NativeAudioPreviewBridge,NativeAudioRequest,NativeAudioAcquireResult} from './native-audio-preview-protocol.ts';
interface Transport {
  invoke(channel:typeof NATIVE_AUDIO_CHANNEL,value:NativeAudioRequest):Promise<unknown>;
  on(channel:typeof NATIVE_AUDIO_EVENT,listener:(event:unknown,value:unknown)=>void):void;
  removeListener(channel:typeof NATIVE_AUDIO_EVENT,listener:(event:unknown,value:unknown)=>void):void;
}
const refused=()=>new Error('Native sound audition is unavailable.');
/** One fixed namespace. Electron events/transports, signing keys, PCM, paths,
 * business calls and arbitrary URL/channel input never enter the page. */
export function createNativeAudioPreviewBridge(transport:Transport):NativeAudioPreviewBridge {
  const actions=new Map<string,{contextId:string|null;cancelled:boolean;sent:boolean}>();
  let identity:NativeAudioOwner|null=null;
  const own=(owner:NativeAudioOwner):boolean=>identity!==null&&sameNativeAudioOwner(identity,owner);
  const context=async()=>{const value=await transport.invoke(NATIVE_AUDIO_CHANNEL,{action:'describe'});
    if(value===null){if(identity)throw refused();return null;}
    const parsed=nativeAudioOwnerSchema.safeParse(value);if(!parsed.success||identity&&!own(parsed.data))throw refused();
    identity??=Object.freeze(parsed.data);return Object.freeze({...identity});};
  const invoke=async(request:NativeAudioRequest):Promise<unknown>=>{
    const parsed=nativeAudioRequestSchema.safeParse(request);if(!parsed.success)throw refused();
    return transport.invoke(NATIVE_AUDIO_CHANNEL,parsed.data);
  };
  const acquire=async(input:AudioPreviewPlanInput,planHash:string,actionId:string,sessionId?:string):Promise<NativeAudioAcquireResult>=>{
      if(actions.size>=8&&!actions.has(actionId))return {status:'busy'};
      // Register synchronously: cancellation while describe is in flight must
      // fence this original action before it can cause another window's handoff.
      const action=actions.get(actionId)??{contextId:null,cancelled:false,sent:false};actions.set(actionId,action);
      let owner:NativeAudioOwner|null;
      try{owner=await context();}catch(error){if(!action.sent&&actions.get(actionId)===action)actions.delete(actionId);throw error;}
      if(action.cancelled||actions.get(actionId)!==action){if(!action.sent&&actions.get(actionId)===action)actions.delete(actionId);return {status:'cancelled'};}
      if(!owner){if(actions.get(actionId)===action)actions.delete(actionId);return {status:'unavailable'};}
      action.contextId=owner.contextId;action.sent=true;
      const request:NativeAudioRequest=sessionId===undefined?{action:'acquire',contextId:owner.contextId,actionId,input,planHash}:
        {action:'acquireContinuous',contextId:owner.contextId,actionId,input,planHash,sessionId};
      const result=nativeAudioAcquireResultSchema.safeParse(await invoke(request));
      if(!result.success)throw refused();
      if(result.data.status==='granted'&&(!own(result.data.lease.owner)||result.data.lease.actionId!==actionId||result.data.lease.planHash!==planHash||
        result.data.lease.input.projectId!==input.projectId||result.data.lease.input.timelineId!==input.timelineId||result.data.lease.input.expectedRevision!==input.expectedRevision||result.data.lease.input.startFrame!==input.startFrame||
        (sessionId===undefined?'sessionId' in result.data.lease:!('sessionId' in result.data.lease)||result.data.lease.sessionId!==sessionId)))throw refused();
      if(result.data.status!=='granted'&&actions.get(actionId)===action)actions.delete(actionId);
      return Object.freeze(result.data);
  };
  return Object.freeze({context,
    acquire:(input,planHash,actionId)=>acquire(input,planHash,actionId),
    acquireContinuous:(input,planHash,sessionId,actionId)=>acquire(input,planHash,actionId,sessionId),
    async cancel(actionId){const action=actions.get(actionId);if(!action)return false;
      action.cancelled=true;if(!action.contextId)return true;
      const result=await invoke({action:'cancel',contextId:action.contextId,actionId});if(typeof result!=='boolean')throw refused();return result;},
    async retired(lease,status){const parsed=nativeAudioLeaseSchema.safeParse(lease),action=actions.get(lease.actionId);if(!parsed.success||!own(parsed.data.owner)||action?.contextId!==lease.owner.contextId)throw refused();
      const result=await invoke({action:'retired',contextId:lease.owner.contextId,actionId:lease.actionId,leaseId:lease.leaseId,status});
      if(typeof result!=='boolean')throw refused();if(result&&actions.get(lease.actionId)===action)actions.delete(lease.actionId);return result;},
    subscribe(listener){if(typeof listener!=='function')throw refused();let active=true;
      const receive=(_event:unknown,value:unknown)=>{const parsed=nativeAudioEventSchema.safeParse(value);
        if(active&&parsed.success&&own(parsed.data.type==='revoke'?parsed.data.lease.owner:parsed.data.owner))listener(Object.freeze(parsed.data));};
      transport.on(NATIVE_AUDIO_EVENT,receive);return()=>{if(active){active=false;transport.removeListener(NATIVE_AUDIO_EVENT,receive);}};},
  } satisfies NativeAudioPreviewBridge);
}
