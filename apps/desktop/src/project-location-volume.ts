import {execFile} from 'node:child_process';
import path from 'node:path';
import {promisify} from 'node:util';

export const DESKTOP_PROJECT_VOLUME_LIMITS=Object.freeze({timeoutMs:5000,maxBytes:1024*1024});
export interface DesktopProjectVolumeIdentity {readonly device:string;readonly mountPoint:string}
export interface DesktopProjectVolumeCommandOptions {
 readonly encoding:'utf8';readonly timeout:number;readonly killSignal:'SIGKILL';readonly maxBuffer:number;
 readonly windowsHide:true;readonly env:NodeJS.ProcessEnv;
}
/** Trusted construction seam, never an input from a renderer or HTTP request. */
export type DesktopProjectVolumeRunner=(file:string,args:readonly string[],options:DesktopProjectVolumeCommandOptions)=>Promise<{stdout:string;stderr?:string}>;
const execute=promisify(execFile);
const runDefault:DesktopProjectVolumeRunner=async(file,args,options)=>{
 const {stdout,stderr}=await execute(file,args,options);return {stdout,stderr};
};
const safeText=(value:string)=>!/[\u0000-\u001f\u007f-\u009f\ufffd]/u.test(value)&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const absolute=(value:string)=>value.length>0&&value.length<=4096&&safeText(value)&&path.posix.isAbsolute(value)&&path.posix.normalize(value)===value;
const invalid=():never=>{throw Object.assign(new Error('Project volume cannot be safely identified.'),{code:'PROJECT_LOCATION_INVALID',status:400});};

/** POSIX df has exactly four numeric columns followed by the complete mounted
 * path. Splitting on whitespace would truncate names such as "USB 2026 Drive".
 * This result must still match one mount-table device AND mount point; it is
 * not a path-prefix guess and grants no write/ownership claim by itself. */
export function parseDesktopProjectDf(output:string):DesktopProjectVolumeIdentity|null{
 if(typeof output!=='string'||Buffer.byteLength(output,'utf8')>DESKTOP_PROJECT_VOLUME_LIMITS.maxBytes)return null;
 const lines=output.split('\n');if(lines.at(-1)==='')lines.pop();
 if(lines.length!==2||!/^Filesystem[ \t]+[0-9]+-blocks[ \t]+Used[ \t]+Available[ \t]+(?:Capacity|Use%)[ \t]+Mounted[ \t]+on[ \t]*$/u.test(lines[0]!))return null;
 const row=/^(.+?)[ \t]+([0-9]{1,40})[ \t]+([0-9]{1,40})[ \t]+(-?[0-9]{1,40})[ \t]+([0-9]{1,6})%[ \t]+(\/.*)$/u.exec(lines[1]!);
 if(!row)return null;
 const device=row[1]!,mountPoint=row[6]!;
 if(!device||device.length>4096||device.trim()!==device||!safeText(device)||!absolute(mountPoint))return null;
 return Object.freeze({device,mountPoint});
}

/** The caller passes an existing file/directory (or the nearest existing
 * parent for a new target). macOS firmlinks can keep realpath under /Users even
 * though statfs/df identifies the Data volume mounted elsewhere. */
export async function readDesktopProjectVolume(existingPath:string,{run=runDefault}:{run?:DesktopProjectVolumeRunner}={}):Promise<DesktopProjectVolumeIdentity>{
 if(typeof existingPath!=='string'||!absolute(existingPath))return invalid();
 let result:{stdout:string;stderr?:string};
 try{result=await run('/bin/df',['-P',existingPath],{encoding:'utf8',timeout:DESKTOP_PROJECT_VOLUME_LIMITS.timeoutMs,killSignal:'SIGKILL',maxBuffer:DESKTOP_PROJECT_VOLUME_LIMITS.maxBytes,windowsHide:true,env:{...process.env,LC_ALL:'C',LANG:'C'}});}
 catch(error){
  const code=(error as {code?:unknown}|null)?.code;
  if(code==='EACCES'||code==='EPERM')throw Object.assign(new Error('Project volume access was denied.'),{code:'PROJECT_ACCESS_DENIED',status:403});
  return invalid();
 }
 if(!result||typeof result.stdout!=='string'||result.stderr!==undefined&&typeof result.stderr!=='string'||Buffer.byteLength(result.stdout,'utf8')+Buffer.byteLength(result.stderr??'','utf8')>DESKTOP_PROJECT_VOLUME_LIMITS.maxBytes||Boolean(result.stderr))return invalid();
 const identity=parseDesktopProjectDf(result.stdout);return identity??invalid();
}
