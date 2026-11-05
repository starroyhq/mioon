import path from 'node:path';

// OS file intents keep their queue until a backend runs. Opening a path is not
// yet wired to S6's trusted project/window admission; never treat an ordinary
// SQLite .mioon file as an archive upload to the retired package service.
export const PROJECT_FILE_EXTENSION='.mioon';
export type ProjectFileOpenFailure='PROJECT_FILE_OPEN_UNAVAILABLE'|'PROJECT_PACKAGE_NOT_MIOON'|'PROJECT_PACKAGE_NEWER_FORMAT'|'PROJECT_PACKAGE_CORRUPT'|'UNAVAILABLE';
export type ProjectFileUpload=(file:string)=>Promise<void>;

export class ProjectFileOpenError extends Error {
 readonly code:ProjectFileOpenFailure;
 constructor(code:ProjectFileOpenFailure){super(code);this.code=code;}
}

/** Project files named on a command line (Windows and Linux pass them this way). */
export function projectFileArguments(argv:readonly string[]|undefined,cwd?:string):string[]{
 return (argv??[]).slice(1).filter(item=>!item.startsWith('-')&&item.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)).map(item=>cwd?path.resolve(cwd,item):path.resolve(item));
}

/** Retained internal call shape for the desktop lifecycle. Fail before any
 * filesystem or network access until OS paths have trusted S6 admission. */
export async function uploadProjectFile({base,token,file,signal,fetchImpl=fetch}:{base:string;token:string;file:string;signal?:AbortSignal;fetchImpl?:typeof fetch}):Promise<void>{
 throw new ProjectFileOpenError('PROJECT_FILE_OPEN_UNAVAILABLE');
}

/** Queues files until a backend is running, then dispatches one at a time.
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
