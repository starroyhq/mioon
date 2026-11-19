import test from 'node:test';
import assert from 'node:assert/strict';
import {probeDesktopProjectLocation,configureDesktopWindowsProjectVolume} from '../apps/desktop/src/project-location-probe.ts';
import type {DesktopProjectLocationDependencies,WindowsProjectVolumeFacts,WindowsProjectVolumeReader} from '../apps/desktop/src/project-location-probe.ts';

type Kind='file'|'directory'|'link';
const info=(kind:Kind)=>({isFile:()=>kind==='file',isDirectory:()=>kind==='directory',isSymbolicLink:()=>kind==='link'});
const failure=(code:string)=>(error:unknown)=>typeof error==='object'&&error!==null&&'code'in error&&error.code===code;
const facts=(overrides:Partial<WindowsProjectVolumeFacts>={}):WindowsProjectVolumeFacts=>({fileSystem:'NTFS',isLocal:true,volumeReadOnly:false,permissionBits:true,cloudSyncRoot:false,placeholder:false,...overrides});
function windows(reader:WindowsProjectVolumeReader,{realpath,lstat}:{realpath?:(file:string)=>Promise<string>;lstat?:(file:string)=>Promise<ReturnType<typeof info>>}={}):DesktopProjectLocationDependencies {
 return {platform:'win32',homeDir:'C:\\Users\\me',readWindowsVolume:reader,
  realpath:realpath??(async file=>file),lstat:lstat??(async file=>info(file.endsWith('.mioon')?'file':'directory'))};
}
const target='C:\\Users\\me\\Movies\\Film.mioon';
test('every Windows location class maps to the contract facts without a write trial',async()=>{
 const byRoot:Record<string,WindowsProjectVolumeFacts>={
  'C:\\Users\\me\\Movies':facts(),
  'D:\\ReFS':facts({fileSystem:'ReFS'}),
  'E:\\USB':facts({fileSystem:'exFAT',permissionBits:false}),
  'F:\\FAT':facts({fileSystem:'FAT32',permissionBits:false}),
  'Z:\\Share':facts({fileSystem:'SMB',isLocal:false}),
  'R:\\ReadOnly':facts({volumeReadOnly:true}),
  'C:\\Users\\me\\OneDrive':facts({cloudSyncRoot:true}),
  'C:\\Users\\me\\Documents':facts({placeholder:true}),
 };
 const reader=async(existing:string)=>byRoot[existing]??byRoot['C:\\Users\\me\\Movies']!;
 for(const [folder,expected]of [
  ['C:\\Users\\me\\Movies',{fileSystem:'NTFS',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'not-reported'}],
  ['D:\\ReFS',{fileSystem:'ReFS',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'not-reported'}],
  ['E:\\USB',{fileSystem:'exFAT',isLocal:true,volumeReadOnly:false,permissionBits:false,cloud:'not-reported'}],
  ['F:\\FAT',{fileSystem:'FAT32',isLocal:true,volumeReadOnly:false,permissionBits:false,cloud:'not-reported'}],
  ['Z:\\Share',{fileSystem:'SMB',isLocal:false,volumeReadOnly:false,permissionBits:true,cloud:'not-reported'}],
  ['R:\\ReadOnly',{fileSystem:'NTFS',isLocal:true,volumeReadOnly:true,permissionBits:true,cloud:'not-reported'}],
  ['C:\\Users\\me\\OneDrive',{fileSystem:'NTFS',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'known-file-provider'}],
  ['C:\\Users\\me\\Documents',{fileSystem:'NTFS',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'known-file-provider'}],
 ] as const) assert.deepEqual(await probeDesktopProjectLocation({path:folder+'\\Film.mioon',purpose:'open',isDirectory:false},windows(reader,{realpath:async file=>file.replace(/\\Film\.mioon$/u,'')})),expected,folder);
});
test('extended-length, UNC and mixed-case drive paths are accepted and probed by their canonical form',async()=>{
 const seen:string[]=[];const reader=async(path:string)=>{seen.push(path);return facts({fileSystem:'NTFS'});};
 const deps=windows(reader,{realpath:async file=>file});
 assert.equal((await probeDesktopProjectLocation({path:'\\\\?\\c:/Users/me/Movies/Film.mioon',purpose:'open',isDirectory:false},deps)).isLocal,true);
 assert.equal((await probeDesktopProjectLocation({path:'\\\\server\\share\\Movies\\Film.mioon',purpose:'open',isDirectory:false},windows(async path=>{seen.push(path);return facts({fileSystem:'SMB',isLocal:false});}))).isLocal,false);
 assert.deepEqual(seen,['C:\\Users\\me\\Movies\\Film.mioon','\\\\server\\share\\Movies\\Film.mioon']);
});
test('path-detail refusals keep PROJECT_LOCATION_INVALID with a fixed reason',async()=>{
 for(const [path,reason] of [
  ['CON','relative'],['C:\\CON\\Film.mioon','reserved-name'],['C:\\a.\\Film.mioon','trailing-dot-or-space'],
  ['C:\\a<b\\Film.mioon','invalid-character'],['\\\\.\\C:\\Film.mioon','device-path'],['relative\\Film.mioon','relative'],
  ['C:Film.mioon','relative'],['C:\\a\\..\\Film.mioon','not-normalized'],['\\\\server\\CON\\Film.mioon','reserved-name'],
 ] as const) {
  try{await probeDesktopProjectLocation({path,purpose:'open',isDirectory:false},windows(async()=>facts()));assert.fail('accepted '+path);}
  catch(error){const value=error as {code?:unknown;details?:{reason?:unknown}};assert.equal(value.code,'PROJECT_LOCATION_INVALID',path);
   assert.equal(value.details?.reason,reason,path);}
 }
});
test('native facts are validated before use, and permission errors keep their own code',async()=>{
 for(const bad of [null,{},facts({fileSystem:''}),facts({fileSystem:'x'.repeat(101)}),facts({isLocal:'yes' as never}),facts({cloudSyncRoot:undefined as never})])
  await assert.rejects(probeDesktopProjectLocation({path:target,purpose:'open',isDirectory:false},windows(async()=>bad as WindowsProjectVolumeFacts)),failure('PROJECT_LOCATION_INVALID'));
 for(const code of ['EACCES','EPERM']) {
  await assert.rejects(probeDesktopProjectLocation({path:target,purpose:'open',isDirectory:false},windows(async()=>facts(),{lstat:async()=>{throw Object.assign(Error('private'),{code});}})),error=>failure('PROJECT_ACCESS_DENIED')(error)&&!(error as Error).message.includes('private'));
  await assert.rejects(probeDesktopProjectLocation({path:target,purpose:'open',isDirectory:false},windows(async()=>{throw Object.assign(Error('private'),{code});})),failure('PROJECT_ACCESS_DENIED'));
 }
});
test('Windows filesystem rules match the shared admission policy module',async()=>{
 configureDesktopWindowsProjectVolume(async()=>facts({fileSystem:'exFAT',permissionBits:false}));
 try{const deps:DesktopProjectLocationDependencies={platform:'win32',homeDir:'C:\\Users\\me',realpath:async file=>file,lstat:async file=>info(file.endsWith('.mioon')?'file':'directory')};
  assert.equal((await probeDesktopProjectLocation({path:target,purpose:'create',isDirectory:false},deps)).permissionBits,false);}
 finally{configureDesktopWindowsProjectVolume(null);}
});
test('missing targets probe their existing parent; links and non-directory parents are refused',async()=>{
 const absent=Object.assign(Error('missing'),{code:'ENOENT'});let observed='';
 const deps=windows(async path=>{observed=path;return facts();},{realpath:async file=>file,lstat:async file=>{if(file===target)throw absent;return info(file.endsWith('.mioon')?'file':'directory');}});
 assert.equal((await probeDesktopProjectLocation({path:target,purpose:'save-as',isDirectory:false},deps)).isLocal,true);
 assert.equal(observed,'C:\\Users\\me\\Movies');
 await assert.rejects(probeDesktopProjectLocation({path:target,purpose:'open',isDirectory:false},windows(async()=>facts(),{lstat:async()=>info('link')})),failure('PROJECT_LOCATION_INVALID'));
 await assert.rejects(probeDesktopProjectLocation({path:target,purpose:'open',isDirectory:false},windows(async()=>facts(),{lstat:async file=>file===target?info('directory'):info('file')})),failure('PROJECT_LOCATION_INVALID'));
});
