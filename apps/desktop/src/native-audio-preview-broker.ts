import {nativeAudioCommandSchema,nativeAudioReplySchema} from '@mioon/contracts/native-audio-preview';
import type {NativeAudioCommand,NativeAudioReply} from '@mioon/contracts/native-audio-preview';
interface Options {backendId:string;send(message:NativeAudioCommand):void;isCurrent():boolean;timeoutMs?:number}
const unavailable=()=>Object.assign(new Error('Native audition cleanup or reservation is unconfirmed.'),{code:'NATIVE_AUDIO_UNCONFIRMED'});
/** Exact utility-handle transport. A deadline reports uncertainty without
 * discarding the original settlement; a matching late reply remains evidence. */
export function createNativeAudioPreviewBroker({backendId,send,isCurrent,timeoutMs=10000}:Options){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw unavailable();
  const pending=new Map<string,{command:NativeAudioCommand;resolve:(reply:NativeAudioReply)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  let closed=false;
  return {
    request(raw:NativeAudioCommand,onPending?:()=>void):Promise<NativeAudioReply>{
      const parsed=nativeAudioCommandSchema.safeParse(raw);
      if(closed||!isCurrent()||!parsed.success||parsed.data.owner.backendId!==backendId||pending.has(parsed.data.requestId)||pending.size>=16)return Promise.reject(unavailable());
      const command=parsed.data;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{if(pending.has(command.requestId)){try{onPending?.();}catch{/* Observation cannot discard actual cleanup evidence. */}}},timeoutMs);
        pending.set(command.requestId,{command,resolve,reject,timer});
        try{send(command);}catch{clearTimeout(timer);pending.delete(command.requestId);reject(unavailable());}
      });
    },
    handle(raw:unknown):boolean{
      if(raw===null||typeof raw!=='object'||!('type' in raw)||raw.type!=='native-audio:reply')return false;
      const parsed=nativeAudioReplySchema.safeParse(raw);if(!parsed.success||closed||!isCurrent())return true;
      const reply=parsed.data,entry=pending.get(reply.requestId);
      if(!entry||reply.backendId!==backendId||reply.leaseId!==entry.command.leaseId)return true;
      if(reply.status==='reserved'&&entry.command.type!=='native-audio:reserve'||reply.status==='retired'&&entry.command.type!=='native-audio:retire')return true;
      clearTimeout(entry.timer);pending.delete(reply.requestId);entry.resolve(reply);return true;
    },
    close():void{closed=true;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(unavailable());}pending.clear();},
  };
}
