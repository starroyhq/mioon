import {awaitProvider,operationCancelled} from '../operation-lifecycle.ts';
import {providerError} from '../providers/live-common.ts';

interface VideoSdkResponseOptions {
  expectedUrl:string;
  signal?:AbortSignal;
  send:(url:string,options:RequestInit)=>Promise<Response>;
}
const invalid=(beforeDispatch=true)=>providerError('VIDEO_SDK_REQUEST_INVALID','The video SDK requested an unsupported bound observation.',{...(beforeDispatch?{beforeDispatch:true}:{retryable:true})});
const cancel=(response:Response|undefined)=>{void response?.body?.cancel().catch(()=>{});};

/** The SDK constructs one GET, but never sees the real status or body. The
 * caller retains redirect, error and binary-stream handling, so SDK response
 * parsing cannot buffer media, consume an error body, follow a redirect or
 * acquire authority to write an output file. SDK authentication is not copied. */
export async function invokeVideoSdkResponse({expectedUrl,signal,send}:VideoSdkResponseOptions,invoke:(fetch:typeof globalThis.fetch)=>Promise<unknown>):Promise<Response> {
  let used=false,dispatched=false,response:Response|undefined,failure:unknown;
  const fetchImpl:typeof globalThis.fetch=async(input,init)=>{
    try{
      if(used)throw failure??invalid(!dispatched);used=true;
      if(signal?.aborted)throw operationCancelled({beforeDispatch:true});
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      let parsed:URL,request:Request;
      try{parsed=new URL(url);request=new Request(input,init);}catch{throw invalid();}
      if(url!==expectedUrl||parsed.href!==expectedUrl||parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash||
        request.method!=='GET'||request.body!==null||request.headers.has('x-stainless-retry-count')&&request.headers.get('x-stainless-retry-count')!=='0')throw invalid();
      const currentSignal=signal?AbortSignal.any([signal,request.signal]):request.signal;
      dispatched=true;
      response=await awaitProvider(async()=>{
        const incoming=await send(url,{method:'GET',redirect:'manual',signal:currentSignal});
        if(currentSignal.aborted){cancel(incoming);throw operationCancelled();}
        return incoming;
      },currentSignal);
      return new Response(null,{status:200});
    }catch(error){failure=error;throw error;}
  };
  try{
    await awaitProvider(()=>invoke(Object.assign(fetchImpl,{Response})),signal);
    if(!response)throw invalid(!dispatched);
    if(signal?.aborted)throw operationCancelled();
    return response;
  }catch{
    cancel(response);
    if(failure!==undefined)throw failure;
    if(signal?.aborted)throw operationCancelled({beforeDispatch:!dispatched});
    throw providerError('VIDEO_SDK_REQUEST_FAILED','The video SDK could not complete the bound observation.',{beforeDispatch:!dispatched,retryable:true});
  }
}
