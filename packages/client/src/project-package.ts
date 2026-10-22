import {open,unlink,stat,type FileHandle} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {resolveConnection} from './connection.ts';
import {ClientError} from './index.ts';

// Project files are workspace management like backups: these calls use
// dedicated routes outside the RPC catalog, so they never become MCP tools.
export interface ProjectPackageClientOptions {env?:NodeJS.ProcessEnv;fetchImpl?:typeof fetch;signal?:AbortSignal;onProgress?:(progress:unknown)=>void;intervalMs?:number}
type Json=Record<string,unknown>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const errorCode=(error:unknown):unknown=>(error as {code?:unknown}|null|undefined)?.code;

async function call(route:string,init:RequestInit&{json?:unknown},{env=process.env,fetchImpl=fetch,signal}:ProjectPackageClientOptions):Promise<Json>{
 const {base,token}=await resolveConnection(env);
 const {json,...rest}=init;
 const response=await fetchImpl(base+route,{...rest,...(json!==undefined?{body:JSON.stringify(json)}:{}),headers:{authorization:`Bearer ${token}`,...(json!==undefined?{'content-type':'application/json'}:{}),...(init.headers as Record<string,string>|undefined)},redirect:'error',signal});
 let body:{ok?:boolean;data?:unknown;error?:{code?:string;message?:string;details?:unknown}};
 try{body=await response.json() as typeof body;}catch{throw new ClientError('BACKEND_PROTOCOL_ERROR','The backend returned an invalid response.',{status:response.status});}
 if(!body.ok)throw new ClientError(body.error?.code??'BACKEND_UNAVAILABLE',body.error?.message??'Project file request failed.',{status:response.status,details:body.error?.details});
 return body.data as Json;
}
const projectId=(input:Json):string=>{if(typeof input.projectId!=='string'||!UUID.test(input.projectId))throw new ClientError('VALIDATION_ERROR','A UUID projectId is required.');return input.projectId;};
// Like every CLI mutation, the caller owns the replay key; none is invented here.
const requestIdOf=(input:Json):string=>{if(typeof input.requestId!=='string'||input.requestId.length<8||input.requestId.length>200)throw new ClientError('VALIDATION_ERROR','A stable requestId (8–200 characters) is required.');return input.requestId;};

/** Writes the package to `output`, created exclusively so nothing is overwritten. */
export async function exportProjectPackage(input:Json,output:unknown,options:ProjectPackageClientOptions={}):Promise<Json>{
 if(typeof output!=='string'||!output)throw new ClientError('VALIDATION_ERROR','Project export requires an explicit --output file.');
 if(Object.keys(input).some(key=>!['projectId','media'].includes(key)))throw new ClientError('VALIDATION_ERROR','project export accepts projectId and media.');
 const destination=path.resolve(output);
 let handle:FileHandle|undefined,completed=false;
 try{handle=await open(destination,'wx',0o600);}
 catch(error){throw new ClientError(errorCode(error)==='EEXIST'?'OUTPUT_EXISTS':'FILE_WRITE_ERROR',errorCode(error)==='EEXIST'?'Output already exists. Choose a new filename; no file was overwritten.':'Cannot create the requested output file.');}
 let status=await call('/api/project-packages/exports',{method:'POST',json:{projectId:projectId(input),media:input.media??'all'}},options);
 try{
  while(status.phase==='running'){
   options.onProgress?.({files:status.files,totalFiles:status.totalFiles,bytes:status.bytes,totalBytes:status.totalBytes});
   await pause(options.intervalMs??250,undefined,{signal:options.signal});
   status=await call(`/api/project-packages/exports/${status.id}`,{method:'GET'},options);
  }
  if(status.phase!=='ready'){const error=status.error as {code?:string;details?:unknown}|undefined;throw new ClientError(error?.code??'PROJECT_PACKAGE_CORRUPT','The project export did not finish.',{details:error?.details});}
  const {base,token}=await resolveConnection(options.env??process.env);
  const response=await (options.fetchImpl??fetch)(`${base}/api/project-packages/exports/${status.id}/download`,{headers:{authorization:`Bearer ${token}`},redirect:'error',signal:options.signal});
  if(!response.ok||!response.body)throw new ClientError('BACKEND_UNAVAILABLE','The project file could not be downloaded.',{status:response.status});
  let bytes=0;
  for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){bytes+=chunk.byteLength;let offset=0;while(offset<chunk.length)offset+=(await handle.write(chunk,offset,chunk.length-offset)).bytesWritten;}
  if(bytes!==Number(response.headers.get('content-length')))throw new ClientError('BACKEND_PROTOCOL_ERROR','The project file download ended early.');
  await handle.sync();completed=true;
  return {projectId:status.projectId,output:destination,bytes,fileName:status.fileName};
 }finally{
  await handle.close();
  if(!completed)await unlink(destination).catch(()=>{});
  await call(`/api/project-packages/exports/${status.id}`,{method:'DELETE'},{...options,signal:undefined}).catch(()=>{});
 }
}

/** Streams the file to the backend for verification, then creates the project. */
export async function importProjectPackage(input:Json,file:unknown,options:ProjectPackageClientOptions={}):Promise<Json>{
 if(typeof file!=='string'||!file)throw new ClientError('VALIDATION_ERROR','Project import requires --file.');
 if(Object.keys(input).some(key=>!['name','requestId'].includes(key)))throw new ClientError('VALIDATION_ERROR','project import accepts name and requestId.');
 const source=path.resolve(file);
 try{if(!(await stat(source)).isFile())throw new Error('not a file');}catch{throw new ClientError('FILE_READ_ERROR','Cannot read the requested project file.');}
 const body=Readable.toWeb(createReadStream(source,{highWaterMark:1024*1024})) as unknown as BodyInit;
 const preview=await call('/api/project-packages/imports',{method:'POST',body,headers:{'content-type':'application/octet-stream'},duplex:'half'} as RequestInit,options);
 options.onProgress?.(preview);
 const name=typeof input.name==='string'?input.name:String(preview.suggestedName);
 try{
  const result=await call(`/api/project-packages/imports/${preview.id}/commit`,{method:'POST',json:{requestId:requestIdOf(input),name}},options);
  return {...result,name,counts:preview.counts};
 }catch(error){await call(`/api/project-packages/imports/${preview.id}`,{method:'DELETE'},{...options,signal:undefined}).catch(()=>{});throw error;}
}

export async function duplicateProject(input:Json,options:ProjectPackageClientOptions={}):Promise<Json>{
 if(Object.keys(input).some(key=>!['projectId','name','requestId'].includes(key)))throw new ClientError('VALIDATION_ERROR','project duplicate accepts projectId, name and requestId.');
 const id=projectId(input);
 let name=typeof input.name==='string'?input.name:'';
 if(!name){const project=await call('/api/rpc',{method:'POST',json:{operation:'project.get',input:{projectId:id}}},options) as {project?:{name?:string};name?:string};name=`${(project.project??project).name??'project'} 副本`;}
 return call('/api/project-packages/duplicates',{method:'POST',json:{projectId:id,requestId:requestIdOf(input),name}},options);
}
