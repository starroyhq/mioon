import {IMAGE_SETTINGS_LIMITS} from '@mioon/contracts';
import {sanitizeImageSettingsResult,sanitizeCustomImageSettingsResult,sanitizeImageSettingsError} from '@mioon/business/images/settings';
import {safeImageReviewError} from '@mioon/business/images/reviews';
import {safeImageServiceError} from '@mioon/business/images';
const json=(res,status,value)=>{if(res.destroyed||res.writableEnded)return;if(res.headersSent){res.destroy();return;}res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const invalid=(status=400)=>Object.assign(Error('图像请求格式无效。'),{code:'IMAGE_HTTP_VALIDATION',status});
async function body(req,res,max){
 if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']||'')||req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')throw invalid();
 const length=req.headers['content-length'];if(length!==undefined&&(!/^(?:0|[1-9][0-9]*)$/u.test(length)||!Number.isSafeInteger(Number(length))))throw invalid();
 const tooLarge=()=>{res.setHeader('Connection','close');req.resume();return invalid(413);};if(Number(length)>max)throw tooLarge();
 const chunks=[];let size=0;for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>max)throw tooLarge();chunks.push(chunk);}
 try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw invalid();}
}
/** Existing server Host/Origin/session authentication runs before this route.
 * These fixed user actions are intentionally absent from RPC/CLI/MCP/Agent
 * catalogs. They are not a cryptographic attestation of a physical human click. */
export function createImageHttp({settings,customSettings,approve,reject,signal}){
 return async(req,res,url)=>{
  if(!/^\/api\/images(?:\/|$)/u.test(url.pathname))return false;
  const customSettingsRoute=url.pathname==='/api/images/custom-settings',settingsRoute=customSettingsRoute||url.pathname==='/api/images/settings',approval=url.pathname==='/api/images/reviews/approve',rejection=url.pathname==='/api/images/reviews/reject';
  try{
   if(Buffer.byteLength(req.url)>2048||url.search)throw invalid();
   if(!settingsRoute&&!approval&&!rejection){json(res,404,{ok:false,error:{code:'NOT_FOUND',message:'图像接口不存在',details:{},retryable:false}});return true;}
   const methods=settingsRoute?['GET','PUT']:['POST'];if(!methods.includes(req.method)){res.setHeader('Allow',methods.join(', '));json(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'图像接口请求方法无效',details:{},retryable:false}});return true;}
   const selectedSettings=customSettingsRoute?customSettings:settings,sanitizeSettings=customSettingsRoute?sanitizeCustomImageSettingsResult:sanitizeImageSettingsResult;
   if(settingsRoute&&!selectedSettings)throw Object.assign(Error(),{code:'IMAGE_SETTINGS_CLOSED'});
   let result;
   if(req.method==='GET')result=sanitizeSettings(await selectedSettings.get());
   else{
    const input=await body(req,res,settingsRoute?IMAGE_SETTINGS_LIMITS.updateBytes:1024);
    if(signal?.aborted)throw Object.assign(Error(),{code:'IMAGE_SERVICE_STOPPED',status:503});
    result=settingsRoute?sanitizeSettings(await selectedSettings.put(input)):approval?await approve(input):await reject(input);
   }
   json(res,200,{ok:true,data:result});
  }catch(error){
   const safe=error?.code==='IMAGE_HTTP_VALIDATION'?{code:error.code,message:'图像请求格式无效或超出大小限制。',status:error.status}
    :String(error?.code).startsWith('IMAGE_SETTINGS_')?sanitizeImageSettingsError(error)
    :String(error?.code).startsWith('IMAGE_REVIEW_')?safeImageReviewError(error):safeImageServiceError(error);
   json(res,safe.status,{ok:false,error:{code:safe.code,message:safe.message,details:safe.details||{},retryable:false}});
  }
  return true;
 };
}
