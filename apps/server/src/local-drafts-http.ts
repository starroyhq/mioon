import type {IncomingMessage,ServerResponse} from 'node:http';
import {LOCAL_DRAFT_LIMITS} from '@mioon/contracts/local-drafts';
import type {ClipDraftEnvelope,ClipDraftList} from '@mioon/contracts/local-drafts';
import {LocalDraftError,safeLocalDraftError} from '@mioon/business/local-drafts';

export interface LocalDraftHttpService {
  get(input:unknown):ClipDraftEnvelope;
  list(input:unknown):ClipDraftList;
  put(input:unknown):ClipDraftEnvelope;
  discard(input:unknown):ClipDraftEnvelope;
}
const send=(res:ServerResponse,status:number,value:unknown):void=>{
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));
};
const invalid=():never=>{throw new LocalDraftError('LOCAL_DRAFT_VALIDATION');};
function query(url:URL,allowed:string[]):Record<string,string>{
  const keys=[...url.searchParams.keys()];
  if(keys.length!==allowed.length||new Set(keys).size!==keys.length||keys.some(key=>!allowed.includes(key)))invalid();
  return Object.fromEntries(url.searchParams);
}
async function body(req:IncomingMessage,res:ServerResponse):Promise<unknown>{
  if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']||'')||req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')invalid();
  const oversized=():never=>{res.setHeader('Connection','close');req.resume();throw new LocalDraftError('LOCAL_DRAFT_LIMIT');};
  const length=req.headers['content-length'];
  if(length!==undefined&&(!/^(?:0|[1-9][0-9]*)$/u.test(length)||!Number.isSafeInteger(Number(length))))invalid();
  if(length!==undefined&&Number(length)>LOCAL_DRAFT_LIMITS.httpBytes)oversized();
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of req.iterator({destroyOnReturn:false})){
    const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);bytes+=data.length;
    if(bytes>LOCAL_DRAFT_LIMITS.httpBytes)oversized();chunks.push(data);
  }
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{return invalid();}
}
// Fixed restored43 routes reuse these exact bounded transport primitives.
// They do not add a codec selector or change the ordinary endpoint's grammar.
export {send as sendLocalDraftHttpResponse, query as readLocalDraftHttpQuery, body as readLocalDraftHttpBody};

/** Invoked only after startServer's existing Host, Origin and authentication
 * checks. No RPC, Agent-tool, provider, file-path or native bridge capability. */
export function createLocalDraftHttp({drafts,signal}:{drafts:LocalDraftHttpService;signal?:AbortSignal}){
  return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(!/^\/api\/local-drafts(?:\/|$)/u.test(url.pathname))return false;
    try{
      if(Buffer.byteLength(req.url||'')>LOCAL_DRAFT_LIMITS.urlBytes)throw new LocalDraftError('LOCAL_DRAFT_LIMIT');
      const clip=url.pathname==='/api/local-drafts/clip';
      if(!clip&&url.pathname!=='/api/local-drafts')throw new LocalDraftError('LOCAL_DRAFT_NOT_FOUND');
      const methods=clip?['GET','PUT','DELETE']:['GET'];
      if(!methods.includes(req.method||'')){
        res.setHeader('Allow',methods.join(', '));send(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'此接口不支持该请求方法。',details:{},retryable:false}});return true;
      }
      let result:ClipDraftEnvelope|ClipDraftList;
      if(signal?.aborted)throw new LocalDraftError('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
      if(req.method==='GET')result=clip?drafts.get(query(url,['projectId','timelineId','clipId'])):drafts.list(query(url,['projectId']));
      else{
        query(url,[]);const input=await body(req,res);
        if(signal?.aborted)throw new LocalDraftError('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
        result=req.method==='PUT'?drafts.put(input):drafts.discard(input);
      }
      send(res,200,{ok:true,data:result});
    }catch(error){
      if(res.headersSent)res.destroy();
      else{const safe=safeLocalDraftError(error);send(res,safe.status,{ok:false,error:{code:safe.code,message:safe.message,details:{},retryable:false}});}
    }
    return true;
  };
}
