import type {IncomingMessage, ServerResponse} from 'node:http';
import {IMAGE_SETTINGS_LIMITS, IMAGE_REVIEW_LIMITS} from '@mioon/contracts';
import {sanitizeImageSettingsResult, sanitizeImageSettingsError} from '@mioon/business/images/settings';
import type {createImageSettings} from '@mioon/business/images/settings';
import {customImageSettingsV2Error, sanitizeCustomImageSettingsV2Error} from '@mioon/business/images/custom-settings-v2';
import type {createCustomImageSettingsV2} from '@mioon/business/images/custom-settings-v2';
import {CUSTOM_IMAGE_SETTINGS_V2_LIMITS, customImageSettingsV2ResultSchema} from '../../../packages/contracts/src/generation-image-settings.ts';
import {generationImageServiceSchemas} from '../../../packages/contracts/src/generation-image-services.ts';
import {officialImageProbeSchema, customImageProbeSchema} from '../../../packages/contracts/src/draft-image-probe.ts';
import {draftServiceProbeResultSchema} from '../../../packages/contracts/src/draft-service-probe.ts';
import {probeImageService} from '@mioon/business/images/draft-probe';
import {safeImageReviewError} from '@mioon/business/images/reviews';
import {safeImageServiceError} from '@mioon/business/images';
import {rejectProjectMismatch} from './project-host/request.ts';
import type {ProjectAddress} from './project-host/request.ts';
import {readOutputLocale} from './output-locale-http.ts';
import type {OutputLocale} from '../../../packages/contracts/src/output-locale.ts';

type ImageSettings = Awaited<ReturnType<typeof createImageSettings>>;
type CustomImageSettings = Awaited<ReturnType<typeof createCustomImageSettingsV2>>;
interface SafeImageError {code: string; message: string; status: number; details?: unknown}
export interface ImageHttpOptions {
  settings?: ImageSettings;
  customSettings?: CustomImageSettings;
  generationServices?: (operation: string, input: unknown, outputLocale?: OutputLocale) => unknown;
  approve: (input: unknown) => unknown;
  reject: (input: unknown) => unknown;
  signal?: AbortSignal;
  probeFetch?: typeof fetch;
}
const json = (res: ServerResponse, status: number, value: unknown): void => {if(res.destroyed||res.writableEnded)return;if(res.headersSent){res.destroy();return;}res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const errorField = (error: unknown, name: string): unknown => error !== null && typeof error === 'object' && name in error ? (error as Record<string, unknown>)[name] : undefined;
const errorStatus = (error: unknown): number | undefined => {const status = errorField(error, 'status'); return typeof status === 'number' ? status : undefined;};
const invalid = (status = 400) => Object.assign(Error('图像请求格式无效。'), {code: 'IMAGE_HTTP_VALIDATION', status});
async function body(req: IncomingMessage, res: ServerResponse, max: number): Promise<unknown> {
 if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']||'')||req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')throw invalid();
 const length=req.headers['content-length'];if(length!==undefined&&(!/^(?:0|[1-9][0-9]*)$/u.test(length)||!Number.isSafeInteger(Number(length))))throw invalid();
 const tooLarge=()=>{res.setHeader('Connection','close');req.resume();return invalid(413);};if(length!==undefined&&Number(length)>max)throw tooLarge();
 const chunks: Buffer[]=[];let size=0;for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>max)throw tooLarge();chunks.push(chunk);}
 try{const value: unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw invalid();}
}
/** Existing server Host/Origin/session authentication runs before this route.
 * These fixed user actions are intentionally absent from RPC/CLI/MCP/Agent
 * catalogs. They are not a cryptographic attestation of a physical human click. */
export function createImageHttp({settings,customSettings,generationServices,approve,reject,signal,probeFetch}: ImageHttpOptions) {
 return async (req: IncomingMessage, res: ServerResponse, url: URL, address?: ProjectAddress): Promise<boolean> => {
  if(!/^\/api\/images(?:\/|$)/u.test(url.pathname))return false;
  const customSettingsRoute=url.pathname==='/api/images/custom-settings',settingsRoute=customSettingsRoute||url.pathname==='/api/images/settings',servicesRoute=url.pathname==='/api/images/services',approval=url.pathname==='/api/images/reviews/approve',rejection=url.pathname==='/api/images/reviews/reject';
  try{
   if(Buffer.byteLength(req.url ?? '')>2048||url.search)throw invalid();
   if(!settingsRoute&&!approval&&!rejection&&!servicesRoute||servicesRoute&&(!address||!generationServices)){json(res,404,{ok:false,error:{code:'NOT_FOUND',message:'图像接口不存在',details:{},retryable:false}});return true;}
   const methods=settingsRoute?['GET','PUT','POST']:['POST'];if(!methods.includes(req.method ?? '')){res.setHeader('Allow',methods.join(', '));json(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'图像接口请求方法无效',details:{},retryable:false}});return true;}
   if(settingsRoute&&!(customSettingsRoute?customSettings:settings))throw Object.assign(Error(),{code:'IMAGE_SETTINGS_CLOSED'});
   let result: unknown;
   if(req.method==='GET') {
    if(customSettingsRoute){const parsed=customImageSettingsV2ResultSchema.safeParse(await customSettings!.get());if(!parsed.success)throw customImageSettingsV2Error('IMAGE_SETTINGS_CORRUPT');result=parsed.data;}
    else result=sanitizeImageSettingsResult(await settings!.get());
   } else {
    const input=await body(req,res,customSettingsRoute?CUSTOM_IMAGE_SETTINGS_V2_LIMITS.updateBytes:settingsRoute?IMAGE_SETTINGS_LIMITS.updateBytes:servicesRoute?IMAGE_REVIEW_LIMITS.intentBytes:1024);
    if(!settingsRoute&&!servicesRoute&&rejectProjectMismatch(res,address,input))return true;
    if(signal?.aborted)throw Object.assign(Error(),{code:'IMAGE_SERVICE_STOPPED',status:503});
    if(settingsRoute&&req.method==='POST') {
     if(address||url.hash)throw invalid();
     const observer=new AbortController();
     const abort=()=>observer.abort();
     req.once('aborted',abort); res.once('close',abort);
     const active=signal?AbortSignal.any([signal,observer.signal]):observer.signal;
     const options={signal:active,fetchImpl:probeFetch};
     try {
      if(req.aborted||res.destroyed) abort();
      if(customSettingsRoute) {
       const parsed=customImageProbeSchema.safeParse(input); if(!parsed.success)throw invalid();
       result=await probeImageService({kind:'custom',input:parsed.data,settings:customSettings!},options);
      } else {
       const parsed=officialImageProbeSchema.safeParse(input); if(!parsed.success)throw invalid();
       result=await probeImageService({kind:'official',input:parsed.data,settings:settings!},options);
      }
      if(active.aborted)throw Object.assign(Error(),{code:'IMAGE_SERVICE_STOPPED',status:503});
      result=draftServiceProbeResultSchema.parse(result);
     } finally {req.off('aborted',abort); res.off('close',abort);}
    } else if(customSettingsRoute) {
     const {action,...update}=input as Record<string,unknown>;
     let stored:unknown;
     if(action==='create')stored=await customSettings!.create(update);
     else if(action==='put')stored=await customSettings!.put(update);
     else if(action==='remove')stored=await customSettings!.remove(update);
     else if(action==='batch')stored=await customSettings!.batch(update);
     else throw invalid();
     const parsed=customImageSettingsV2ResultSchema.safeParse(stored);if(!parsed.success)throw customImageSettingsV2Error('IMAGE_SETTINGS_CORRUPT');result=parsed.data;
    } else if(settingsRoute) result=sanitizeImageSettingsResult(await settings!.put(input));
    else if(servicesRoute) {
     const envelope=input as Record<string,unknown>,operation=envelope.operation;
     if(Object.keys(envelope).length!==2||!Object.hasOwn(envelope,'input')||operation!=='image.service.list'&&operation!=='image.service.review.prepare')throw invalid();
     const parsed=generationImageServiceSchemas[operation].safeParse(envelope.input);if(!parsed.success)throw invalid();
     const payload=parsed.data,named='projectId'in payload?payload:payload.input;
     if(rejectProjectMismatch(res,address,named))return true;
     result=await generationServices!(operation,payload,readOutputLocale(req,operation));
    } else result=approval?await approve(input):await reject(input);
   }
   json(res,200,{ok:true,data:result});
  }catch(error){
   const code=errorField(error,'code');
   const safe: SafeImageError = code==='IMAGE_HTTP_VALIDATION'?{code,message:'图像请求格式无效或超出大小限制。',status:errorStatus(error) ?? 400}
    :code==='VALIDATION_ERROR'?{code,message:'图片服务请求格式无效。',status:400}
    :typeof code==='string'&&code.startsWith('IMAGE_SETTINGS_')?(customSettingsRoute||servicesRoute||['IMAGE_SETTINGS_SELECTION_REQUIRED','IMAGE_SETTINGS_NOT_FOUND','IMAGE_SETTINGS_CAPACITY'].includes(code)?sanitizeCustomImageSettingsV2Error(error):sanitizeImageSettingsError(error))
    :typeof code==='string'&&code.startsWith('IMAGE_REVIEW_')?safeImageReviewError(error):safeImageServiceError(error);
   json(res,safe.status,{ok:false,error:{code:safe.code,message:safe.message,details:safe.details||{},retryable:false}});
  }
  return true;
 };
}
