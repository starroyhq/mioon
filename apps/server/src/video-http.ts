import type {IncomingMessage,ServerResponse} from 'node:http';
import {VIDEO_SETTINGS_LIMITS,isCompatibleVideoBaseUrl,normalizeCompatibleVideoBaseUrl} from '../../../packages/contracts/src/video-providers.ts';
import {compatibleVideoCheckV2Schema,videoModelsListInputSchema,videoSettingsUpdateV2Schema,videoSettingsSnapshotV2Schema} from '../../../packages/contracts/src/generation-video-settings.ts';
import {checkCompatibleVideoService} from '../../../packages/business/src/video/compatible-check.ts';
import {probeVideoService,supportsVideoModelsList} from '../../../packages/business/src/video/draft-probe.ts';
import {sanitizeVideoSettingsV2Error,videoSettingsV2Error} from '../../../packages/business/src/video/settings-v2.ts';
import type {VideoSettingsV2Service} from '../../../packages/business/src/video/settings-v2.ts';

const json=(res:ServerResponse,status:number,value:unknown)=>{if(res.destroyed||res.writableEnded)return;if(res.headersSent){res.destroy();return;}res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const invalid=(status=400)=>Object.assign(videoSettingsV2Error('VIDEO_SETTINGS_VALIDATION'),{status});
async function body(req:IncomingMessage,res:ServerResponse):Promise<unknown>{
 if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']??'')||req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')throw invalid();
 const length=req.headers['content-length'];if(length!==undefined&&(!/^(?:0|[1-9][0-9]*)$/u.test(length)||!Number.isSafeInteger(Number(length))))throw invalid();
 const tooLarge=()=>{res.setHeader('Connection','close');req.resume();return invalid(413);};if(length!==undefined&&Number(length)>VIDEO_SETTINGS_LIMITS.updateBytes)throw tooLarge();
 const chunks:Buffer[]=[];let size=0;for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>VIDEO_SETTINGS_LIMITS.updateBytes)throw tooLarge();chunks.push(chunk);}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw invalid();}
}
/** Fixed private user-settings route after Host/Origin/session admission; absent from RPC, CLI and Agent tools. */
export function createVideoHttp({settings,signal,checkFetch}:{settings:VideoSettingsV2Service;signal?:AbortSignal;checkFetch?:typeof fetch}){
 return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
  if(!/^\/api\/video-providers(?:\/|$)/u.test(url.pathname))return false;
  try{
   if(Buffer.byteLength(req.url??'')>2048||url.search)throw invalid();
   if(url.pathname==='/api/video-providers/compatible-check'){
    if(req.method!=='POST'){res.setHeader('Allow','POST');json(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'请使用 POST。',details:{},retryable:false}});return true;}
    if(signal?.aborted)throw videoSettingsV2Error('VIDEO_SETTINGS_CLOSED');
    const parsed=compatibleVideoCheckV2Schema.safeParse(await body(req,res));if(!parsed.success)throw invalid();
    const input=parsed.data;
    // A draft key is only ever sent to the normalized draft origin; a saved key only to its own origin.
    const target=input.source==='draft'?(()=>{let origin='';try{origin=normalizeCompatibleVideoBaseUrl(input.baseUrl);}catch{}if(!isCompatibleVideoBaseUrl(origin))throw invalid();return {endpoint:origin,value:input.value};})():await settings.acquireCompatible(input.connectionId,input.configurationRevision,signal);
    const result=await checkCompatibleVideoService({baseUrl:target.endpoint,apiKey:target.value,...(checkFetch?{fetchImpl:checkFetch}:{}),...(signal?{signal}:{})});
    if(signal?.aborted)throw videoSettingsV2Error('VIDEO_SETTINGS_CLOSED');
    json(res,200,{ok:true,data:result});return true;
   }
   if(url.pathname==='/api/video-providers/models/list'){
    if(req.method!=='POST'){res.setHeader('Allow','POST');json(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'请使用 POST。',details:{},retryable:false}});return true;}
    const request = new AbortController();
    const abort = () => request.abort();
    const active = signal ? AbortSignal.any([signal,request.signal]) : request.signal;
    res.once('close', abort);
    try {
     if(active.aborted)throw videoSettingsV2Error('VIDEO_SETTINGS_CLOSED');
     const parsed=videoModelsListInputSchema.safeParse(await body(req,res));if(!parsed.success)throw invalid();
     const input=parsed.data;
     if(active.aborted)throw videoSettingsV2Error('VIDEO_SETTINGS_CLOSED');
     if(input.operation==='models'&&!supportsVideoModelsList(input.providerId)){
      json(res,200,{ok:true,data:{result:'unsupported'}});return true;
     }
     const {providerId,region,workspaceId,baseUrl,operation}=input;
     const target={providerId,region,workspaceId,...(baseUrl===undefined?{}:{baseUrl}),operation};
     // The probe only receives a key after an exact match with the saved
     // recipient. A typed key bypasses storage for this request.
     const value=input.source==='draft'?input.value:(await settings.acquireForProbe(input.connectionId,input.configurationRevision,target,active)).value;
     if(active.aborted)throw videoSettingsV2Error('VIDEO_SETTINGS_CLOSED');
     const result=await probeVideoService(target,value,{signal:active,...(checkFetch?{fetchImpl:checkFetch}:{})});
     if(active.aborted)throw videoSettingsV2Error('VIDEO_SETTINGS_CLOSED');
     json(res,200,{ok:true,data:result});return true;
    } finally {res.removeListener('close',abort);}
   }
   if(url.pathname!=='/api/video-providers/settings'){json(res,404,{ok:false,error:{code:'NOT_FOUND',message:'视频配置接口不存在。',details:{},retryable:false}});return true;}
   if(!['GET','PUT'].includes(req.method??'')){res.setHeader('Allow','GET, PUT');json(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'请使用 GET 或 PUT。',details:{},retryable:false}});return true;}
   if(signal?.aborted)throw videoSettingsV2Error('VIDEO_SETTINGS_CLOSED');
   let result:unknown;
   if(req.method==='GET')result=await settings.get();
   else {const parsed=videoSettingsUpdateV2Schema.safeParse(await body(req,res));if(!parsed.success)throw invalid();result=await settings.put(parsed.data);}
   if(signal?.aborted)throw videoSettingsV2Error('VIDEO_SETTINGS_CLOSED');
   const parsed=videoSettingsSnapshotV2Schema.safeParse(result);if(!parsed.success)throw videoSettingsV2Error('VIDEO_SETTINGS_CORRUPT');
   json(res,200,{ok:true,data:parsed.data});
  }catch(error){const safe=sanitizeVideoSettingsV2Error(error),status=error&&typeof error==='object'&&'status'in error&&error.status===413?413:safe.status;json(res,status,{ok:false,error:{code:safe.code,message:safe.message,details:{},retryable:false}});}
  return true;
 };
}
