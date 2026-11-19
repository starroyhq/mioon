import {execFile} from 'node:child_process';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {mountFor,parseMacMounts,parseLinuxMountInfo} from '../../../packages/business/src/media-reference/location.ts';
import type {MountEntry} from '../../../packages/business/src/media-reference/location.ts';
import {projectLocationFactsSchema} from '../../../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectLocationFacts,ProjectStoragePurpose} from '../../../packages/contracts/src/project-entry-desktop.ts';
import {readDesktopProjectVolume} from './project-location-volume.ts';
import {normalizeWindowsProjectPath,windowsExtendedPath,windowsOrdinaryPath,WindowsProjectPathError} from './project-location-windows.ts';
import type {DesktopProjectVolumeIdentity} from './project-location-volume.ts';

const MAX_MOUNT_BYTES=1024*1024;
export interface DesktopProjectMount extends MountEntry {readonly volumeReadOnly:boolean;readonly device?:string}
interface EntryStat {isSymbolicLink():boolean;isDirectory():boolean;isFile():boolean}
export interface DesktopProjectLocationDependencies {
 platform?:NodeJS.Platform;homeDir?:string;
 readMounts?:()=>Promise<readonly DesktopProjectMount[]|null>;
 readVolume?:(existingPath:string)=>Promise<DesktopProjectVolumeIdentity>;
 readWindowsVolume?:WindowsProjectVolumeReader;
 realpath?:(file:string)=>Promise<string>;
 lstat?:(file:string)=>Promise<EntryStat>;
}
/** Native Windows volume facts. Only fixed booleans and a bounded filesystem
 * name cross the helper boundary; the probe validates every field again. */
export interface WindowsProjectVolumeFacts {
 readonly fileSystem:string;readonly isLocal:boolean;readonly volumeReadOnly:boolean;
 readonly permissionBits:boolean;readonly cloudSyncRoot:boolean;readonly placeholder:boolean;
}
export type WindowsProjectVolumeReader=(existingPath:string)=>Promise<WindowsProjectVolumeFacts>;
let configuredWindowsVolumeReader:WindowsProjectVolumeReader|null=null;
/** Main installs the shipped native helper once; renderers and HTTP requests
 * cannot configure or reach this seam. */
export function configureDesktopWindowsProjectVolume(reader:WindowsProjectVolumeReader|null):void{configuredWindowsVolumeReader=reader;}
const defaultWindowsVolume:WindowsProjectVolumeReader=async(path)=>{
 if(!configuredWindowsVolumeReader)return invalid();
 return configuredWindowsVolumeReader(path);
};
export interface DesktopProjectLocationInput {path:string;purpose:'open'|ProjectStoragePurpose;isDirectory:boolean}
const invalid=():never=>{throw Object.assign(new Error('Project location cannot be safely identified.'),{code:'PROJECT_LOCATION_INVALID',status:400});};
function filesystemFailure(error:unknown):never {
 const code=(error as {code?:unknown}|null)?.code;
 if(code==='EACCES'||code==='EPERM'||code==='PROJECT_ACCESS_DENIED')throw Object.assign(new Error('Project location access was denied.'),{code:'PROJECT_ACCESS_DENIED',status:403});
 return invalid();
}
function contained(root:string,file:string):boolean {
 const relative=path.posix.relative(root,file);
 return relative===''||relative!=='..'&&!relative.startsWith('../')&&!path.posix.isAbsolute(relative);
}
/** Reuse the media layer's real mount parser, retaining the readonly flag.
 * Any unparsed nonempty row blocks the probe: dropping a nested mount could
 * otherwise incorrectly select its writable/local parent. */
export function parseDesktopMacMounts(output:string):readonly DesktopProjectMount[]|null {
 if(Buffer.byteLength(output)>MAX_MOUNT_BYTES)return null;
 const entries:DesktopProjectMount[]=[];
 for(const line of output.split('\n')){
  if(line==='')continue;
  const parsed=parseMacMounts(line);
  if(parsed.length!==1||/[\u0000-\u001f\u007f]/u.test(line))return null;
  const device=line.slice(0,line.indexOf(' on /'));
  if(!device||device.trim()!==device)return null;
  const flags=line.trimEnd().slice(line.lastIndexOf(' (')+2,-1).split(',').map(flag=>flag.trim());
  entries.push({...parsed[0]!,device,volumeReadOnly:flags.includes('read-only')});
 }
 return entries.length?entries:null;
}
export function parseDesktopLinuxMounts(output:string):readonly DesktopProjectMount[]|null {
 if(Buffer.byteLength(output)>MAX_MOUNT_BYTES)return null;
 const entries:DesktopProjectMount[]=[];
 for(const line of output.split('\n')){
  if(line==='')continue;
  const parsed=parseLinuxMountInfo(line),flags=line.split(' ')[5]?.split(',');
  if(parsed.length!==1||!flags||!flags.some(flag=>flag==='ro'||flag==='rw'))return null;
  entries.push({...parsed[0]!,volumeReadOnly:flags.includes('ro')});
 }
 return entries.length?entries:null;
}
async function systemMounts(platform:NodeJS.Platform):Promise<readonly DesktopProjectMount[]|null> {
 if(platform==='darwin'){
  const {stdout}=await promisify(execFile)('/sbin/mount',[],{encoding:'utf8',timeout:5000,maxBuffer:MAX_MOUNT_BYTES});
  return parseDesktopMacMounts(stdout);
 }
 if(platform==='linux')return parseDesktopLinuxMounts(await readFile('/proc/self/mountinfo','utf8'));
 return null;
}
/** Metadata only, shared by open/create and all storage panels. There is no
 * permission/write trial, recursive search, download or user-data mutation.
 * The caller rejects nonlocal/readonly facts and owns any warning UI. */
export async function probeDesktopProjectLocation(input:DesktopProjectLocationInput,{platform=process.platform,homeDir=homedir(),readMounts,readVolume=readDesktopProjectVolume,readWindowsVolume,realpath:resolve=realpath,lstat:stat=lstat}:DesktopProjectLocationDependencies={}):Promise<ProjectLocationFacts> {
 if(!input||typeof input.path!=='string'||input.path.length>4096||input.path.includes('\0')||typeof input.isDirectory!=='boolean'||!['open','create','save-as','duplicate','copy-to','template'].includes(input.purpose)||!['darwin','linux','win32'].includes(platform))return invalid();
 if(platform==='win32')return probeWindowsProjectLocation(input,{readWindowsVolume:readWindowsVolume??defaultWindowsVolume,realpath:resolve,lstat:stat});
 if(!path.posix.isAbsolute(input.path))return invalid();
 const selected=path.posix.resolve(input.path);let real:string,existing:string;
 try{
  let info:EntryStat|undefined;
  try{info=await stat(selected);}catch(error){if((error as {code?:unknown}|null)?.code!=='ENOENT')throw error;}
  if(input.isDirectory){
   if(!info)return invalid();real=await resolve(selected);if(!(await stat(real)).isDirectory())return invalid();existing=real;
  }else{
   if(info?.isSymbolicLink())return invalid();
   if(info){if(!info.isFile())return invalid();real=await resolve(selected);existing=real;}
   else{const parent=await resolve(path.posix.dirname(selected));if(!(await stat(parent)).isDirectory())return invalid();real=path.posix.join(parent,path.posix.basename(selected));existing=parent;}
  }
 }catch(error){return filesystemFailure(error);}
 let mounts:readonly DesktopProjectMount[]|null;
 try{mounts=await(readMounts??(()=>systemMounts(platform)))();}catch(error){return filesystemFailure(error);}
 if(!Array.isArray(mounts)||!mounts.length||mounts.some(entry=>!entry||typeof entry.mountPoint!=='string'||!path.posix.isAbsolute(entry.mountPoint)||typeof entry.fileSystem!=='string'||!entry.fileSystem||typeof entry.network!=='boolean'||typeof entry.ownersIgnored!=='boolean'||typeof entry.volumeReadOnly!=='boolean'))return invalid();
 let mount:DesktopProjectMount|null;
 if(platform==='darwin'){
  let volume:DesktopProjectVolumeIdentity;
  try{volume=await readVolume(existing);}catch(error){return filesystemFailure(error);}
  if(!volume||typeof volume.device!=='string'||!volume.device||typeof volume.mountPoint!=='string'||!path.posix.isAbsolute(volume.mountPoint))return invalid();
  // APFS firmlinks leave realpath under /Users while df identifies the Data
  // volume. Exact device AND mount-point agreement is required; a root-prefix
  // fallback would incorrectly inherit the sealed system volume's readonly.
  const matching=mounts.filter(entry=>entry.device===volume.device&&entry.mountPoint===volume.mountPoint);
  if(matching.length!==1)return invalid();mount=matching[0]!;
 }else mount=mountFor(mounts,real) as DesktopProjectMount|null;
 if(!mount)return invalid();
 let cloud:ProjectLocationFacts['cloud']='not-reported';
 if(platform==='darwin'){
  try{
   const home=await resolve(homeDir);
   if(contained(path.posix.join(home,'Library/Mobile Documents'),real))cloud='known-icloud';
   else if(contained(path.posix.join(home,'Library/CloudStorage'),real))cloud='known-file-provider';
  }catch(error){const code=(error as {code?:unknown}|null)?.code;if(code==='EACCES'||code==='EPERM')return filesystemFailure(error);cloud='unknown';}
 }
 const parsed=projectLocationFactsSchema.safeParse({fileSystem:mount.fileSystem,isLocal:!mount.network,volumeReadOnly:mount.volumeReadOnly,permissionBits:!mount.ownersIgnored,cloud});
 if(!parsed.success)return invalid();return parsed.data;
}

function windowsPathFailure(error:unknown):never {
 if(error instanceof WindowsProjectPathError)throw Object.assign(new Error('Project location cannot be safely identified.'),{code:'PROJECT_LOCATION_INVALID',status:400,details:{reason:error.reason}});
 throw error;
}
/** Windows metadata probe: path syntax, canonical case and native volume facts.
 * No permission/write trial, placeholder hydration or user-data mutation. */
async function probeWindowsProjectLocation(input:DesktopProjectLocationInput,{readWindowsVolume,realpath:resolve,lstat:stat}:Required<Pick<DesktopProjectLocationDependencies,'realpath'|'lstat'>> & {readWindowsVolume:WindowsProjectVolumeReader}):Promise<ProjectLocationFacts> {
 let normalized:{path:string};try{normalized=normalizeWindowsProjectPath(input.path);}catch(error){return windowsPathFailure(error);}
 if(typeof input.isDirectory!=='boolean')return invalid();
 const selected=normalized.path;
 const statPath=(value:string):string=>value.length>=260||value.startsWith('\\')?windowsExtendedPath(value):value;
 let real:string,existing:string;
 try{
  let info:EntryStat|undefined;
  try{info=await stat(statPath(selected));}catch(error){if((error as {code?:unknown}|null)?.code!=='ENOENT')throw error;}
  if(input.isDirectory){
   if(!info)return invalid();
   real=windowsOrdinaryPath(await resolve(statPath(selected)));
   if(!(await stat(statPath(real))).isDirectory())return invalid();
   existing=real;
  }else{
   if(info?.isSymbolicLink())return invalid();
   if(info){if(!info.isFile())return invalid();real=windowsOrdinaryPath(await resolve(statPath(selected)));existing=real;}
   else{const parent=windowsOrdinaryPath(await resolve(statPath(path.win32.dirname(selected))));if(!(await stat(statPath(parent))).isDirectory())return invalid();real=path.win32.join(parent,path.win32.basename(selected));existing=parent;}
  }
  try{normalized=normalizeWindowsProjectPath(real);}catch(error){return windowsPathFailure(error);}
  real=normalized.path;
 }catch(error){return filesystemFailure(error);}
 let facts:WindowsProjectVolumeFacts;
 try{facts=await readWindowsVolume(existing);}catch(error){return filesystemFailure(error);}
 if(!facts||typeof facts!=='object'||typeof facts.fileSystem!=='string'||facts.fileSystem.length<1||facts.fileSystem.length>100||/[\u0000-\u001f\u007f-\u009f]/u.test(facts.fileSystem)||typeof facts.isLocal!=='boolean'||typeof facts.volumeReadOnly!=='boolean'||typeof facts.permissionBits!=='boolean'||typeof facts.cloudSyncRoot!=='boolean'||typeof facts.placeholder!=='boolean')return invalid();
 const parsed=projectLocationFactsSchema.safeParse({fileSystem:facts.fileSystem,isLocal:facts.isLocal,volumeReadOnly:facts.volumeReadOnly,permissionBits:facts.permissionBits,
  cloud:facts.cloudSyncRoot||facts.placeholder?'known-file-provider':'not-reported'});
 if(!parsed.success)return invalid();return parsed.data;
}
