import {normalizeCompatibleVideoBaseUrl} from '../../../contracts/src/video-providers.ts';
import type {CompatibleVideoCheckResult} from '../../../contracts/src/video-providers.ts';
import {createPinnedVideoFetch} from './network.ts';

/** Reads `GET {base}/models` with the key, through the pinned transport. It never
 * creates a video, never follows a redirect and never returns provider text. */
export async function checkCompatibleVideoService({baseUrl,apiKey,fetchImpl=createPinnedVideoFetch(),signal,timeoutMs=15_000}:{baseUrl:string;apiKey:string;fetchImpl?:typeof fetch;signal?:AbortSignal;timeoutMs?:number}):Promise<CompatibleVideoCheckResult> {
  const origin=normalizeCompatibleVideoBaseUrl(baseUrl);
  const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
  let response:Response;
  try{response=await fetchImpl(`${origin}/models`,{method:'GET',headers:{Authorization:`Bearer ${apiKey}`,Accept:'application/json'},redirect:'error',signal:bounded});}
  catch(error){
    const code=error!==null&&typeof error==='object'?(error as {code?:unknown}).code:undefined;
    return {result:code==='VIDEO_NETWORK_DENIED'?'denied':'unreachable'};
  }
  await response.body?.cancel().catch(()=>{});
  if(response.ok)return {result:'ok'};
  if(response.status===401||response.status===403)return {result:'unauthorized',httpStatus:response.status};
  if(response.status===404||response.status===405)return {result:'unsupported',httpStatus:response.status};
  return {result:'http_error',httpStatus:response.status};
}
