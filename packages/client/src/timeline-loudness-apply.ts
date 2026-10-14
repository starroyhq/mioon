import {TIMELINE_LOUDNESS_APPLY_RESPONSE_BYTES} from '@mioon/contracts/timeline-loudness-apply';

/** Includes the RPC or durable-task envelope around a bounded immutable ACK.
 * A task's scalar intent and identity fit the remaining 16 KiB. */
export const TIMELINE_LOUDNESS_APPLY_WIRE_BYTES = TIMELINE_LOUDNESS_APPLY_RESPONSE_BYTES + 16 * 1024;
export const TIMELINE_LOUDNESS_APPLY_CLIENT_MS = 125_000;

/** New application responses are always bounded before JSON parsing. Cancellation
 * only stops the local read: it is never evidence that a mutation was cancelled. */
export async function readTimelineLoudnessApplyEnvelope(response:Pick<Response,'body'|'headers'>,
  signal?:AbortSignal):Promise<unknown> {
  const maximum=TIMELINE_LOUDNESS_APPLY_WIRE_BYTES,declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/u.test(declared)||!Number.isSafeInteger(Number(declared))||Number(declared)>maximum)){
    void response.body?.cancel().catch(()=>{});throw new Error('Oversized loudness application response.');
  }
  if(!response.body)throw new Error('Missing loudness application response.');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];
  let count=0,complete=false;
  const cancel=():void=>{void reader.cancel().catch(()=>{});};
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    signal?.throwIfAborted();
    while(true){
      const part=await reader.read();signal?.throwIfAborted();
      if(part.done){complete=true;break;}
      count+=part.value.byteLength;if(count>maximum)throw new Error('Oversized loudness application response.');
      chunks.push(part.value);
    }
    const bytes=new Uint8Array(count);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
  }finally{
    signal?.removeEventListener('abort',cancel);if(!complete)cancel();
    try{reader.releaseLock();}catch{/* Preserve the primary read/cancellation result. */}
  }
}
