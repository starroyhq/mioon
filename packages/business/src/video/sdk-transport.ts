import {operationCancelled} from '../operation-lifecycle.ts';
import {providerError} from '../providers/live-common.ts';
import type {JsonRequestOptions,ProviderContext} from '../providers/live-common.ts';

export type VideoSdkSend=(path:string,options:JsonRequestOptions&{headers?:Record<string,string>})=>Promise<Record<string,unknown>>;
interface SdkOperation {api:string;method:'POST'|'GET';context:ProviderContext;send:VideoSdkSend;allowedHeaders?:readonly string[]}
const invalid=()=>providerError('VIDEO_SDK_REQUEST_INVALID','The video SDK requested an unsupported bound operation.',{beforeDispatch:true});

/** The SDK owns wire parameters. Only the existing bounded project transport
 * acquires credentials and dispatches HTTP; one invocation can never retry a
 * paid submit, even if an SDK changes its internal retry defaults. */
export async function invokeVideoSdk({api,method,context,send,allowedHeaders=[]}:SdkOperation,invoke:(fetch:typeof globalThis.fetch)=>Promise<unknown>):Promise<Record<string,unknown>> {
  let used=false,result:Record<string,unknown>|undefined,failure:unknown;
  const fetchImpl:typeof globalThis.fetch=async(input,init)=>{
    try{
      if(used)throw failure??providerError(method==='POST'?'SUBMISSION_UNKNOWN':'VIDEO_SDK_REQUEST_INVALID','The SDK attempted to repeat the same video operation.',{uncertain:method==='POST',retryable:method!=='POST'});used=true;
      if(context.signal?.aborted)throw operationCancelled({beforeDispatch:method==='POST'});
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if(!url.startsWith(`${api}/`))throw invalid();
      const relative=url.slice(api.length),parsed=new URL(url);
      if(parsed.origin!==new URL(api).origin||parsed.username||parsed.password||parsed.hash||relative.includes('..')||relative.includes('\\'))throw invalid();
      const request=new Request(input,init);
      if(request.method!==method||request.headers.has('x-stainless-retry-count')&&request.headers.get('x-stainless-retry-count')!=='0')throw invalid();
      const headers:Record<string,string>={};
      for(const name of allowedHeaders){const value=request.headers.get(name);if(value!==null)headers[name.toLowerCase()==='x-runway-version'?'X-Runway-Version':name]=value;}
      const signal=context.signal?AbortSignal.any([context.signal,request.signal]):request.signal;
      const options:JsonRequestOptions&{headers?:Record<string,string>}={method,context:{...context,signal},...(Object.keys(headers).length?{headers}:{})};
      if(method==='POST'){
        const contentType=request.headers.get('content-type')??'';
        // Serialize FormData through the standard HTTP implementation; all
        // fields and uploaded files were supplied by the official SDK.
        const bytes=new Uint8Array(await request.arrayBuffer());
        if(bytes.byteLength>32*1024*1024)throw invalid();
        if(contentType.startsWith('application/json'))options.body=JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
        else if(contentType.startsWith('multipart/form-data; boundary='))options.raw={bytes,contentType};
        else throw invalid();
      }
      result=await send(relative,options);
      return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
    }catch(error){failure=error;throw error;}
  };
  try{
    // OpenAI checks a custom fetch's FormData support with a local data: probe
    // unless its matching Response constructor is supplied. Advertise the native
    // constructor so that probe never consumes this single-dispatch boundary.
    await invoke(Object.assign(fetchImpl,{Response}));
    if(!result)throw invalid();
    return result;
  }catch{
    // SDKs wrap fetch exceptions. Preserve the trusted dispatch/uncertainty
    // evidence instead of exposing SDK messages, headers or response bodies.
    if(failure!==undefined)throw failure;
    if(context.signal?.aborted&&!used)throw operationCancelled({beforeDispatch:method==='POST'});
    throw providerError(method==='POST'&&used?'SUBMISSION_UNKNOWN':'VIDEO_SDK_REQUEST_FAILED','The video SDK could not complete the bound operation.',{uncertain:method==='POST'&&used,beforeDispatch:!used,retryable:method!=='POST'});
  }
}
