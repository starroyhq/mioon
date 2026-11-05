import path from 'node:path';
import {PROJECT_OPEN_ERROR_CODES} from '../../../packages/contracts/src/project-file.ts';

export const PROJECT_FILE_EXTENSION='.mioon';
export type ProjectFileOpenFailure=typeof PROJECT_OPEN_ERROR_CODES[number]|'PROJECT_LOCATION_INVALID'|'PROJECT_LOCATION_REJECTED'|'UNAVAILABLE';
export type ProjectFileOpen=(file:string)=>Promise<void>;
export class ProjectFileOpenError extends Error {
 readonly code:ProjectFileOpenFailure;
 constructor(code:ProjectFileOpenFailure){super(code);this.code=code;}
}

/** Project files named on a command line (Windows and Linux pass them this way). */
export function projectFileArguments(argv:readonly string[]|undefined,cwd?:string):string[]{
 return (argv??[]).slice(1).filter(item=>!item.startsWith('-')&&item.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)).map(item=>cwd?path.resolve(cwd,item):path.resolve(item));
}

const failureFor=(error:unknown):{code:ProjectFileOpenFailure;reason?:'read-only'}=>{
 const source=error!==null&&typeof error==='object'?error as {code?:unknown;details?:unknown}:{};
 const code=source.code,details=source.details!==null&&typeof source.details==='object'?source.details as {reason?:unknown;invalidReason?:unknown}:{};
 const known=typeof code==='string'&&[...PROJECT_OPEN_ERROR_CODES,'PROJECT_LOCATION_INVALID','PROJECT_LOCATION_REJECTED'].includes(code)?code as ProjectFileOpenFailure:'UNAVAILABLE';
 return {code:known,...(code==='PROJECT_INVALID'&&details.reason==='read-only'?{reason:'read-only' as const}:{})};
};

/** OS intents wait for a trusted path-opening port. No project bytes are uploaded.
 * Detaching invalidates completion callbacks from the old backend; an in-flight
 * intent is never replayed after an unknown result. Later files remain queued. */
export function createProjectFileOpener({opened,failed}:{opened:()=>void;failed:(file:string,code:ProjectFileOpenFailure,reason?:'read-only')=>void|Promise<void>}){
 const pending:string[]=[];
 let open:ProjectFileOpen|null=null,draining:Promise<void>|null=null,generation=0;
 const connected=()=>open!==null;
 function drain():Promise<void>{
  if(draining)return draining;
  const running=(async()=>{
   while(open&&pending.length){
    const file=pending.shift()!,run=open,epoch=generation;
    try{await run(file);if(open===run&&generation===epoch)opened();}
    catch(error){if(open===run&&generation===epoch){const failure=failureFor(error);await failed(file,failure.code,failure.reason);}}
   }
  })();
  draining=running;
  void running.finally(()=>{if(draining===running){draining=null;if(open&&pending.length)void drain();}});
  return running;
 }
 return {
  add(files:readonly string[]):void{for(const file of files)if(!pending.includes(file))pending.push(file);void drain();},
  attach(run:ProjectFileOpen):Promise<void>{open=run;generation++;return (async()=>{do{await drain();}while(connected()&&pending.length);})();},
  detach(run:ProjectFileOpen):void{if(open===run){open=null;generation++;}},
  get pending():readonly string[]{return [...pending];},
 };
}
export type ProjectFileOpener=ReturnType<typeof createProjectFileOpener>;
