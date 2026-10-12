import type {IncomingMessage,ServerResponse} from 'node:http';
import {LOCAL_DELIVERY_LIMITS} from '@mioon/contracts/local-delivery';
import type {LocalDeliveryEnvelope,LocalDeliveryExecution} from '@mioon/contracts/local-delivery';
import {LocalDeliveryError,safeLocalDeliveryError} from '@mioon/business/local-delivery';

export interface LocalDeliveryHttpService{
  get(input:unknown):LocalDeliveryEnvelope;put(input:unknown):LocalDeliveryEnvelope;
  discard(input:unknown):LocalDeliveryEnvelope;prepare(input:unknown):LocalDeliveryEnvelope;
  execute(input:unknown):Promise<LocalDeliveryExecution>;recover(input:unknown):Promise<LocalDeliveryExecution>;
}
const invalid=():never=>{throw new LocalDeliveryError('LOCAL_DELIVERY_VALIDATION');};
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
  const oversized=():never=>{res.setHeader('Connection','close');req.resume();throw new LocalDeliveryError('LOCAL_DELIVERY_LIMIT');};
  const length=req.headers['content-length'];
  if(length!==undefined&&(!/^(?:0|[1-9][0-9]*)$/u.test(length)||!Number.isSafeInteger(Number(length))))invalid();
  if(length!==undefined&&Number(length)>LOCAL_DELIVERY_LIMITS.httpBytes)oversized();
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of req.iterator({destroyOnReturn:false})){
    const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);bytes+=data.length;
    if(bytes>LOCAL_DELIVERY_LIMITS.httpBytes)oversized();chunks.push(data);
  }
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{return invalid();}
}
/** Call only after startServer's Host, Origin and authentication gates. No RPC,
 * Agent, native bridge, arbitrary operation or renderer outcome input exists. */
export function createLocalDeliveryHttp({delivery,signal}:{delivery:LocalDeliveryHttpService;signal?:AbortSignal}){
  return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(!/^\/api\/local-delivery(?:\/|$)/u.test(url.pathname))return false;
    try{
      if(Buffer.byteLength(req.url||'')>LOCAL_DELIVERY_LIMITS.urlBytes)throw new LocalDeliveryError('LOCAL_DELIVERY_LIMIT');
      const route=url.pathname.slice('/api/local-delivery'.length);
      const methods=route===''?['GET']:route==='/draft'?['PUT','DELETE']:['/prepare','/execute','/recover'].includes(route)?['POST']:null;
      if(methods===null)throw new LocalDeliveryError('LOCAL_DELIVERY_NOT_FOUND');
      if(!methods.includes(req.method||'')){res.setHeader('Allow',methods.join(', '));send(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'此接口不支持该请求方法。',details:{},retryable:false}});return true;}
      if(signal?.aborted)throw new LocalDeliveryError('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
      let result:LocalDeliveryEnvelope|LocalDeliveryExecution;
      if(req.method==='GET')result=delivery.get(query(url,['projectId']));
      else{
        query(url,[]);const input=await body(req,res);
        if(signal?.aborted)throw new LocalDeliveryError('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
        if(route==='/draft')result=req.method==='PUT'?delivery.put(input):delivery.discard(input);
        else if(route==='/prepare')result=delivery.prepare(input);
        else result=await (route==='/execute'?delivery.execute(input):delivery.recover(input));
      }
      const bytes=JSON.stringify({ok:true,data:result});
      if(Buffer.byteLength(bytes)>LOCAL_DELIVERY_LIMITS.executeResponseBytes)throw new LocalDeliveryError('LOCAL_DELIVERY_STORAGE_UNAVAILABLE');
      send(res,200,{ok:true,data:result});
    }catch(error){
      if(res.headersSent)res.destroy();else{const safe=safeLocalDeliveryError(error);send(res,safe.status,{ok:false,error:{code:safe.code,message:safe.message,details:{},retryable:false}});}
    }
    return true;
  };
}
