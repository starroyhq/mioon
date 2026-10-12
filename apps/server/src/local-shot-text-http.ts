import type {IncomingMessage,ServerResponse} from 'node:http';
import {LOCAL_SHOT_TEXT_LIMITS} from '@mioon/contracts/local-shot-text';
import type {LocalShotTextEnvelope,LocalShotTextExecution} from '@mioon/contracts/local-shot-text';
import {LocalShotTextError,safeLocalShotTextError} from '@mioon/business/local-shot-text';

export interface LocalShotTextHttpService{
  get(input:unknown):LocalShotTextEnvelope;put(input:unknown):LocalShotTextEnvelope;
  discard(input:unknown):LocalShotTextEnvelope;prepare(input:unknown):LocalShotTextEnvelope;
  execute(input:unknown):Promise<LocalShotTextExecution>;recover(input:unknown):Promise<LocalShotTextExecution>;
}
const invalid=():never=>{throw new LocalShotTextError('LOCAL_SHOT_TEXT_VALIDATION');};
function query(url:URL,allowed:string[]):Record<string,string>{
  const keys=[...url.searchParams.keys()];
  if(keys.length!==allowed.length||new Set(keys).size!==keys.length||keys.some(key=>!allowed.includes(key)))invalid();
  return Object.fromEntries(url.searchParams);
}
const send=(res:ServerResponse,status:number,value:unknown):void=>{
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));
};
async function body(req:IncomingMessage,res:ServerResponse):Promise<unknown>{
  if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']||'')||req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')invalid();
  const oversized=():never=>{res.setHeader('Connection','close');req.resume();throw new LocalShotTextError('LOCAL_SHOT_TEXT_LIMIT');};
  const length=req.headers['content-length'];
  if(length!==undefined&&(!/^(?:0|[1-9][0-9]*)$/u.test(length)||!Number.isSafeInteger(Number(length))))invalid();
  if(length!==undefined&&Number(length)>LOCAL_SHOT_TEXT_LIMITS.httpBytes)oversized();
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of req.iterator({destroyOnReturn:false})){
    const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);bytes+=data.length;
    if(bytes>LOCAL_SHOT_TEXT_LIMITS.httpBytes)oversized();chunks.push(data);
  }
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{return invalid();}
}
/** Call only after startServer's Host, Origin and authentication gates. No RPC,
 * Agent, native bridge, arbitrary operation or renderer outcome input exists. */
export function createLocalShotTextHttp({shotText,signal}:{shotText:LocalShotTextHttpService;signal?:AbortSignal}){
  return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(!/^\/api\/local-shot-text(?:\/|$)/u.test(url.pathname))return false;
    const deadline=setTimeout(()=>{req.destroy();res.destroy();},15_000);deadline.unref();
    try{
      if(Buffer.byteLength(req.url||'')>LOCAL_SHOT_TEXT_LIMITS.urlBytes)throw new LocalShotTextError('LOCAL_SHOT_TEXT_LIMIT');
      const route=url.pathname.slice('/api/local-shot-text'.length);
      const methods=route===''?['GET']:route==='/draft'?['PUT','DELETE']:['/prepare','/execute','/recover'].includes(route)?['POST']:null;
      if(methods===null)throw new LocalShotTextError('LOCAL_SHOT_TEXT_NOT_FOUND');
      if(!methods.includes(req.method||'')){res.setHeader('Allow',methods.join(', '));send(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'此接口不支持该请求方法。',details:{},retryable:false}});return true;}
      if(signal?.aborted)throw new LocalShotTextError('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
      let result:LocalShotTextEnvelope|LocalShotTextExecution;
      if(req.method==='GET')result=shotText.get(query(url,['projectId','shotId']));
      else{
        query(url,[]);const input=await body(req,res);
        if(signal?.aborted)throw new LocalShotTextError('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
        if(route==='/draft')result=req.method==='PUT'?shotText.put(input):shotText.discard(input);
        else if(route==='/prepare')result=shotText.prepare(input);
        else result=await (route==='/execute'?shotText.execute(input):shotText.recover(input));
      }
      const bytes=JSON.stringify({ok:true,data:result});
      if(Buffer.byteLength(bytes)>LOCAL_SHOT_TEXT_LIMITS.executeResponseBytes)throw new LocalShotTextError('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE');
      send(res,200,{ok:true,data:result});
    }catch(error){
      if(res.headersSent)res.destroy();else{const safe=safeLocalShotTextError(error);send(res,safe.status,{ok:false,error:{code:safe.code,message:safe.message,details:{},retryable:false}});}
    }finally{clearTimeout(deadline);}
    return true;
  };
}
