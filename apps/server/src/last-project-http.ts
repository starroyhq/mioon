import type {IncomingMessage,ServerResponse} from 'node:http';
import {LAST_PROJECT_LIMITS} from '@mioon/contracts/last-project';
import type {LastProjectEnvelope} from '@mioon/contracts/last-project';
import {LastProjectError,safeLastProjectError} from '@mioon/business/last-project';

export interface LastProjectHttpService{get():LastProjectEnvelope;put(input:unknown):LastProjectEnvelope}
const send=(res:ServerResponse,status:number,value:unknown):void=>{
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));
};
const invalid=():never=>{throw new LastProjectError('LAST_PROJECT_VALIDATION');};
async function body(req:IncomingMessage,res:ServerResponse):Promise<unknown>{
  if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']||'')||req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')invalid();
  const oversized=():never=>{res.setHeader('Connection','close');req.resume();throw new LastProjectError('LAST_PROJECT_LIMIT');};
  const length=req.headers['content-length'];
  if(length!==undefined&&(!/^(?:0|[1-9][0-9]*)$/u.test(length)||!Number.isSafeInteger(Number(length))))invalid();
  if(length!==undefined&&Number(length)>LAST_PROJECT_LIMITS.httpBytes)oversized();
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of req.iterator({destroyOnReturn:false})){
    const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);bytes+=data.length;
    if(bytes>LAST_PROJECT_LIMITS.httpBytes)oversized();chunks.push(data);
  }
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{return invalid();}
}
/** Called strictly after the existing Host, Origin and token checks. */
export function createLastProjectHttp({lastProject,signal}:{lastProject:LastProjectHttpService;signal?:AbortSignal}){
  return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(!/^\/api\/last-project(?:\/|$)/u.test(url.pathname))return false;
    try{
      if(Buffer.byteLength(req.url||'')>LAST_PROJECT_LIMITS.urlBytes)throw new LastProjectError('LAST_PROJECT_LIMIT');
      if(url.pathname!=='/api/last-project')throw new LastProjectError('LAST_PROJECT_NOT_FOUND');
      if(!['GET','PUT'].includes(req.method||'')){
        res.setHeader('Allow','GET, PUT');send(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'此接口不支持该请求方法。',details:{},retryable:false}});return true;
      }
      if(req.url!=='/api/last-project')invalid();
      if(signal?.aborted)throw new LastProjectError('LAST_PROJECT_STORAGE_UNAVAILABLE');
      let result:LastProjectEnvelope;
      if(req.method==='GET'){
        if(req.headers['transfer-encoding']||req.headers['content-length']&&req.headers['content-length']!=='0'){
          res.setHeader('Connection','close');req.resume();
          if(Number(req.headers['content-length'])>LAST_PROJECT_LIMITS.httpBytes)throw new LastProjectError('LAST_PROJECT_LIMIT');invalid();
        }
        result=lastProject.get();
      }
      else{const input=await body(req,res);if(signal?.aborted)throw new LastProjectError('LAST_PROJECT_STORAGE_UNAVAILABLE');result=lastProject.put(input);}
      send(res,200,{ok:true,data:result});
    }catch(error){
      if(res.headersSent)res.destroy();else{const safe=safeLastProjectError(error);send(res,safe.status,{ok:false,error:{code:safe.code,message:safe.message,details:{},retryable:false}});}
    }
    return true;
  };
}
