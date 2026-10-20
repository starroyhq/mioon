import type {IncomingMessage,ServerResponse} from 'node:http';
import {VIDEO_SETTINGS_LIMITS} from '../../../packages/contracts/src/video-providers.ts';
import {sanitizeVideoSettingsError,videoSettingsError} from '../../../packages/business/src/video/settings.ts';
import type {VideoSettingsService} from '../../../packages/business/src/video/settings.ts';

const json=(res:ServerResponse,status:number,value:unknown)=>{if(res.destroyed||res.writableEnded)return;if(res.headersSent){res.destroy();return;}res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const invalid=(status=400)=>Object.assign(videoSettingsError('VIDEO_SETTINGS_VALIDATION'),{status});
async function body(req:IncomingMessage,res:ServerResponse):Promise<unknown>{
 if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']??'')||req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')throw invalid();
 const length=req.headers['content-length'];if(length!==undefined&&(!/^(?:0|[1-9][0-9]*)$/u.test(length)||!Number.isSafeInteger(Number(length))))throw invalid();
 const tooLarge=()=>{res.setHeader('Connection','close');req.resume();return invalid(413);};if(length!==undefined&&Number(length)>VIDEO_SETTINGS_LIMITS.updateBytes)throw tooLarge();
 const chunks:Buffer[]=[];let size=0;for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>VIDEO_SETTINGS_LIMITS.updateBytes)throw tooLarge();chunks.push(chunk);}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw invalid();}
}
/** Fixed private user-settings route after Host/Origin/session admission; absent from RPC, CLI and Agent tools. */
export function createVideoHttp({settings,signal}:{settings:VideoSettingsService;signal?:AbortSignal}){
 return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
  if(!/^\/api\/video-providers(?:\/|$)/u.test(url.pathname))return false;
  try{
   if(Buffer.byteLength(req.url??'')>2048||url.search)throw invalid();
   if(url.pathname!=='/api/video-providers/settings'){json(res,404,{ok:false,error:{code:'NOT_FOUND',message:'视频配置接口不存在。',details:{},retryable:false}});return true;}
   if(!['GET','PUT'].includes(req.method??'')){res.setHeader('Allow','GET, PUT');json(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'请使用 GET 或 PUT。',details:{},retryable:false}});return true;}
   if(signal?.aborted)throw videoSettingsError('VIDEO_SETTINGS_CLOSED');
   const result=req.method==='GET'?await settings.get():await settings.put(await body(req,res));
   if(signal?.aborted)throw videoSettingsError('VIDEO_SETTINGS_CLOSED');
   json(res,200,{ok:true,data:result});
  }catch(error){const safe=sanitizeVideoSettingsError(error),status=error&&typeof error==='object'&&'status'in error&&error.status===413?413:safe.status;json(res,status,{ok:false,error:{code:safe.code,message:safe.message,details:{},retryable:false}});}
  return true;
 };
}
