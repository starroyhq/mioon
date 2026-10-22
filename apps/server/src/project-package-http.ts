import type {IncomingMessage,ServerResponse} from 'node:http';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {AppError} from '@mioon/contracts';
import {PROJECT_PACKAGE_MIME_TYPE} from '../../../packages/contracts/src/project-package.ts';
import type {ProjectPackageService} from '@mioon/business/project-package/service';

// Project files are workspace management, like backups: they stay outside the
// RPC schema so they never become MCP tools or built-in agent capabilities.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_JSON=16*1024;
type Input=Record<string,unknown>;
const field=(input:Input,key:string,test:(value:unknown)=>boolean):void=>{if(!test(input[key]))invalid();};
const isId=(value:unknown):boolean=>typeof value==='string'&&UUID.test(value);
const isRequestId=(value:unknown):boolean=>typeof value==='string'&&value.length>=8&&value.length<=200;
const projectName=(value:unknown):string=>{if(typeof value!=='string')invalid();const trimmed=(value as string).trim();if(!trimmed||trimmed.length>150)invalid();return trimmed;};
const only=(input:Input,keys:string[]):void=>{if(Object.keys(input).some(key=>!keys.includes(key)))invalid();};
const send=(res:ServerResponse,status:number,data:unknown):void=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true,data}));};
const invalid=():never=>{throw new AppError('VALIDATION_ERROR','Invalid project file request.',400);};
async function json(req:IncomingMessage):Promise<Input>{
 if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']||''))invalid();
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>MAX_JSON)throw new AppError('VALIDATION_ERROR','Request too large.',413);chunks.push(chunk);}
 let value:unknown;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{invalid();}
 if(!value||typeof value!=='object'||Array.isArray(value))invalid();return value as Input;
}
const contentDisposition=(fileName:string):string=>`attachment; filename="project.mioon"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

/** Called after the server's Host, Origin and token checks and its backup
 * mutation gate. `available` refuses restored and candidate workspaces. */
export function createProjectPackageHttp({service,available,signal}:{service:()=>ProjectPackageService;available:()=>boolean;signal:AbortSignal}){
 return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
  const preview=/^\/api\/projects\/([0-9a-f-]{36})\/package-preview$/iu.exec(url.pathname);
  if(!preview&&!url.pathname.startsWith('/api/project-packages/'))return false;
  if(!available())throw new AppError('WORKSPACE_RESTORED_READ_ONLY','Project files are unavailable in this workspace.',409);
  const packages=service(),method=req.method||'GET';
  if(preview&&method==='GET'){
   const media=url.searchParams.get('media')??'all';if(media!=='all'&&media!=='used')invalid();
   send(res,200,packages.preview(preview[1],{media,includeExports:false}));return true;
  }
  if(url.pathname==='/api/project-packages/exports'&&method==='POST'){
   const input=await json(req);only(input,['projectId','media']);field(input,'projectId',isId);
   const media=input.media??'all';if(media!=='all'&&media!=='used')invalid();
   send(res,200,packages.startExport(input.projectId as string,{media,includeExports:false}));return true;
  }
  const exportMatch=/^\/api\/project-packages\/exports\/([0-9a-f-]{36})(\/download)?$/iu.exec(url.pathname);
  if(exportMatch){
   const [,exportId,download]=exportMatch;
   if(download&&method==='GET'){
    const {file,bytes,fileName}=packages.exportFile(exportId);
    const stream=createReadStream(file,{highWaterMark:1024*1024});
    await new Promise<void>((resolve,reject)=>{stream.once('open',()=>resolve());stream.once('error',reject);});
    res.writeHead(200,{'Content-Type':PROJECT_PACKAGE_MIME_TYPE,'Content-Length':String(bytes),'Content-Disposition':contentDisposition(fileName),'Cache-Control':'no-store'});
    await pipeline(stream,res,{signal});return true;
   }
   if(!download&&method==='GET'){send(res,200,packages.status(exportId));return true;}
   if(!download&&method==='DELETE'){await packages.discardExport(exportId);send(res,200,{discarded:true});return true;}
  }
  if(url.pathname==='/api/project-packages/imports/opened'&&method==='GET'){send(res,200,{preview:packages.takeOpened()});return true;}
  if(url.pathname==='/api/project-packages/imports'&&method==='POST'){
   const source=url.searchParams.get('source');if(source!==null&&source!=='open-file')invalid();
   const closed=new AbortController(),abort=()=>closed.abort();req.once('aborted',abort);res.once('close',()=>{if(!res.writableEnded)abort();});
   try{send(res,200,await packages.stageImport(req,AbortSignal.any([signal,closed.signal]),{opened:source==='open-file'}));}finally{req.off('aborted',abort);}
   return true;
  }
  const importMatch=/^\/api\/project-packages\/imports\/([0-9a-f-]{36})(\/commit)?$/iu.exec(url.pathname);
  if(importMatch){
   const [,importId,commit]=importMatch;
   if(commit&&method==='POST'){const input=await json(req);only(input,['requestId','name']);field(input,'requestId',isRequestId);send(res,200,await packages.commitImport(importId,{requestId:input.requestId as string,name:projectName(input.name)}));return true;}
   if(!commit&&method==='DELETE'){packages.discardImport(importId);send(res,200,{discarded:true});return true;}
  }
  if(url.pathname==='/api/project-packages/duplicates'&&method==='POST'){
   const input=await json(req);only(input,['projectId','requestId','name']);field(input,'projectId',isId);field(input,'requestId',isRequestId);
   send(res,200,await packages.duplicate(input.projectId as string,{requestId:input.requestId as string,name:projectName(input.name)}));return true;
  }
  throw new AppError('NOT_FOUND','Unknown project file request.',404);
 };
}
