import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {Readable} from 'node:stream';
import path from 'node:path';

// A .mioon file opened from the OS (double-click, "Open With", drag onto the
// dock icon) is streamed to the backend, which verifies and stages it like an
// in-app import. The home page or workbench then collects the preview, so the
// user still confirms the name and nothing is created until they do.
export const PROJECT_FILE_EXTENSION='.mioon';
export type ProjectFileOpenFailure='PROJECT_PACKAGE_NOT_MIOON'|'PROJECT_PACKAGE_NEWER_FORMAT'|'PROJECT_PACKAGE_CORRUPT'|'UNAVAILABLE';
export type ProjectFileUpload=(file:string)=>Promise<void>;

export class ProjectFileOpenError extends Error {
 readonly code:ProjectFileOpenFailure;
 constructor(code:ProjectFileOpenFailure){super(code);this.code=code;}
}

/** Project files named on a command line (Windows and Linux pass them this way). */
export function projectFileArguments(argv:readonly string[]|undefined,cwd?:string):string[]{
 return (argv??[]).slice(1).filter(item=>!item.startsWith('-')&&item.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)).map(item=>cwd?path.resolve(cwd,item):path.resolve(item));
}

const failureFor=(code:unknown):ProjectFileOpenFailure=>{
 if(code==='PROJECT_PACKAGE_NOT_MIOON'||code==='PROJECT_PACKAGE_NEWER_FORMAT')return code;
 if(code==='PROJECT_PACKAGE_CORRUPT'||code==='PROJECT_PACKAGE_INVALID_CONTENT'||code==='PROJECT_PACKAGE_TOO_LARGE')return 'PROJECT_PACKAGE_CORRUPT';
 return 'UNAVAILABLE';
};

export async function uploadProjectFile({base,token,file,signal,fetchImpl=fetch}:{base:string;token:string;file:string;signal?:AbortSignal;fetchImpl?:typeof fetch}):Promise<void>{
 try{if(!(await stat(file)).isFile())throw new Error('not a file');}catch{throw new ProjectFileOpenError('UNAVAILABLE');}
 const body=Readable.toWeb(createReadStream(file,{highWaterMark:1024*1024})) as unknown as BodyInit;
 let response:Response;
 try{response=await fetchImpl(new URL('/api/project-packages/imports?source=open-file',base),{method:'POST',body,headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream'},redirect:'error',signal,duplex:'half'} as RequestInit);}
 catch{throw new ProjectFileOpenError('UNAVAILABLE');}
 type Envelope={ok?:boolean;error?:{code?:unknown}}|null;
 const envelope=await response.json().catch(()=>null) as Envelope;
 if(!envelope?.ok)throw new ProjectFileOpenError(failureFor(envelope?.error?.code));
}

/** Queues files until a backend is running, then uploads them one at a time.
 * Files arriving before startup (macOS sends open-file before ready) wait. */
export function createProjectFileOpener({opened,failed}:{opened:()=>void;failed:(file:string,code:ProjectFileOpenFailure)=>void}){
 const pending:string[]=[];
 let upload:ProjectFileUpload|null=null,draining=false;
 async function drain():Promise<void>{
  if(draining)return;draining=true;
  try{
   while(upload&&pending.length){
    const file=pending.shift()!,run=upload;
    try{await run(file);opened();}
    catch(error){failed(file,error instanceof ProjectFileOpenError?error.code:'UNAVAILABLE');}
   }
  }finally{draining=false;}
 }
 return {
  add(files:readonly string[]):void{for(const file of files)if(!pending.includes(file))pending.push(file);void drain();},
  attach(run:ProjectFileUpload):void{upload=run;void drain();},
  detach(run:ProjectFileUpload):void{if(upload===run)upload=null;},
  get pending():readonly string[]{return [...pending];},
 };
}
export type ProjectFileOpener=ReturnType<typeof createProjectFileOpener>;
