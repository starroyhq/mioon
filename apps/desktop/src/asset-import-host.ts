import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {nativeAssetImportRequestSchema, nativeAssetImportResponseSchema, assetPathImportSchema} from '../../../packages/contracts/src/asset-media.ts';
import {projectApiPath} from '../../../packages/contracts/src/project-file.ts';
export const ASSET_IMPORT_CHANNEL='mioon:asset-import';
interface Owner {readonly projectId:string;readonly key:object;isCurrent():boolean}
interface Options<E> {ownerForEvent(event:E):Owner|null;chooseFiles():Promise<string[]>;importPath(input:{projectId:string;requestId:string;sourcePath:string}):Promise<unknown>;now?:()=>number}
const unavailable=()=>Object.assign(new Error('Asset import is unavailable.'),{code:'ASSET_IMPORT_UNAVAILABLE'});
/** Tokens retain the actual OS-selected file and exact document owner. The
 * renderer receives a basename, never the admitted path or a filesystem API. */
export function createAssetImportHost<E>(options:Options<E>){
 const selections=new Map<string,{file:string;owner:Owner;expires:number}>(),now=options.now??Date.now;
 let choosing=false;
 return {async dispatch(event:E,raw:unknown):Promise<unknown>{
  const input=nativeAssetImportRequestSchema.parse(raw),owner=options.ownerForEvent(event);if(!owner?.isCurrent())throw unavailable();
  const check=()=>{if(!owner.isCurrent())throw unavailable();};
  for(const [token,value] of selections)if(value.expires<=now()||!value.owner.isCurrent())selections.delete(token);
  if(input.action==='import'){
   const selection=selections.get(input.token);if(!selection||selection.owner.key!==owner.key||selection.owner.projectId!==owner.projectId)throw unavailable();
   check();const value=await options.importPath(assetPathImportSchema.parse({projectId:owner.projectId,requestId:input.requestId,sourcePath:selection.file}));check();
   const result=nativeAssetImportResponseSchema.parse(value);
   if(result.asset.projectId!==owner.projectId)throw unavailable();
   return result.asset;
  }
  if(choosing)throw unavailable();
  choosing=true;
  try{
   const files=input.action==='choose'?await options.chooseFiles():input.paths;check();
   if(files.length>100||selections.size+files.length>1000)throw unavailable();
   return files.map(file=>{if(!path.isAbsolute(file)||path.resolve(file)!==file)throw unavailable();const token=randomUUID();selections.set(token,{file,owner,expires:now()+2*60*60*1000});return {token,name:path.basename(file)};});
  }finally{choosing=false;}
 }};
}
/** Only the owning desktop main process calls this fixed trusted route with
 * its captured backend bearer. The user-action header is intent, not a grant. */
export async function importNativeAssetPath({base,token,input,signal,check}:{base:string;token:string;input:{projectId:string;requestId:string;sourcePath:string};signal:AbortSignal;check:()=>void}):Promise<unknown>{
 check();const response=await fetch(new URL(projectApiPath(input.projectId,'asset-media','trusted'),base),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-mioon-user-action':'asset-media'},body:JSON.stringify({operation:'asset.import.path',input:assetPathImportSchema.parse(input)}),redirect:'error',signal});
 const reader=response.body?.getReader();if(!reader)throw unavailable();let text='',bytes=0;const decoder=new TextDecoder('utf-8',{fatal:true});
 try{for(;;){const part=await reader.read();if(part.done)break;check();bytes+=part.value.byteLength;if(bytes>256*1024)throw unavailable();text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 check();const value:unknown=JSON.parse(text);if(!response.ok||!value||typeof value!=='object'||!('ok'in value)||value.ok!==true||!('data'in value))throw unavailable();return value.data;
}
