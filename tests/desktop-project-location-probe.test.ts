import test from 'node:test';
import assert from 'node:assert/strict';
import {probeDesktopProjectLocation,parseDesktopMacMounts,parseDesktopLinuxMounts} from '../apps/desktop/src/project-location-probe.ts';
import type {DesktopProjectLocationDependencies,DesktopProjectMount} from '../apps/desktop/src/project-location-probe.ts';

const local:DesktopProjectMount={device:'/dev/disk1',mountPoint:'/',fileSystem:'apfs',network:false,ownersIgnored:false,volumeReadOnly:false};
const selected='/Users/me/Movies/Film.mioon',homeDir='/Users/me';
const info=(kind:'file'|'directory'|'link')=>({isFile:()=>kind==='file',isDirectory:()=>kind==='directory',isSymbolicLink:()=>kind==='link'});
/** Synthetic df: ordinary fixtures explicitly simulate an OS volume lookup.
 * Firmlinks and disagreement are exercised separately below. */
const mounted=(mounts:readonly DesktopProjectMount[])=>({readMounts:async()=>mounts,readVolume:async(existing:string)=>{
 const mount=[...mounts].sort((a,b)=>b.mountPoint.length-a.mountPoint.length).find(entry=>entry.mountPoint==='/'||existing===entry.mountPoint||existing.startsWith(entry.mountPoint+'/'));
 assert.ok(mount?.device);return {device:mount.device,mountPoint:mount.mountPoint};
}});
const defaults:DesktopProjectLocationDependencies={platform:'darwin',homeDir,...mounted([local]),realpath:async file=>file,lstat:async file=>info(file.endsWith('.mioon')?'file':'directory')};
const input={path:selected,purpose:'open',isDirectory:false} as const;
const failure=(code:string)=>(error:unknown)=>typeof error==='object'&&error!==null&&'code'in error&&error.code===code;
test('open/create and every storage destination share real mount facts without a writable claim',async()=>{
 for(const purpose of ['open','create','save-as','duplicate','copy-to']as const){
  assert.deepEqual(await probeDesktopProjectLocation({...input,purpose},defaults),{fileSystem:'apfs',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'not-reported'});
 }
 assert.deepEqual(await probeDesktopProjectLocation({path:'/Users/me/Movies',purpose:'create',isDirectory:true},defaults),{fileSystem:'apfs',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'not-reported'});
});
test('actual SMB/NFS, readonly, exFAT and noowners flags survive for caller admission',async()=>{
 const mounts=parseDesktopMacMounts('/dev/disk1 on / (apfs, local, journaled)\n//user@nas/Film on /Volumes/NAS (smbfs, nodev, nosuid)\nnas:/share on /Volumes/NFS (nfs, nosuid)\n/dev/disk2 on /Volumes/USB (exfat, local, noowners)\n/dev/disk3 on /Volumes/RO (apfs, local, read-only)\n/dev/disk4 on /Volumes/Owners (apfs, local, noowners)\n');assert.ok(mounts);
 for(const [folder,expected]of [['NAS',{fileSystem:'smbfs',isLocal:false,volumeReadOnly:false,permissionBits:true}],['NFS',{fileSystem:'nfs',isLocal:false,volumeReadOnly:false,permissionBits:true}],['USB',{fileSystem:'exfat',isLocal:true,volumeReadOnly:false,permissionBits:false}],['RO',{fileSystem:'apfs',isLocal:true,volumeReadOnly:true,permissionBits:true}],['Owners',{fileSystem:'apfs',isLocal:true,volumeReadOnly:false,permissionBits:false}]]as const){
  assert.deepEqual(await probeDesktopProjectLocation({...input,path:`/Volumes/${folder}/Film.mioon`},{...defaults,...mounted(mounts)}),{...expected,cloud:'not-reported'});
 }
});
test('only the two approved system roots after realpath report cloud; old provider-named folders do not',async()=>{
 for(const [file,cloud]of [['/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Film.mioon','known-icloud'],['/Users/me/Library/CloudStorage/AnyProvider/Film.mioon','known-file-provider'],['/Users/me/Library/CloudStorage/Film.mioon','known-file-provider'],['/Users/me/Library/CloudStorageLookalike/Film.mioon','not-reported'],['/Users/me/Dropbox/Film.mioon','not-reported'],['/Users/me/OneDrive - Work/Film.mioon','not-reported'],['/Users/me/Documents/Film.mioon','not-reported'],['/Users/other/Library/Mobile Documents/Film.mioon','not-reported']]as const){
  assert.equal((await probeDesktopProjectLocation({...input,path:file},defaults)).cloud,cloud,file);
 }
 const target='/Users/me/Library/CloudStorage/Provider/Film.mioon';
 assert.equal((await probeDesktopProjectLocation(input,{...defaults,realpath:async file=>file===selected?target:file})).cloud,'known-file-provider');
 assert.equal((await probeDesktopProjectLocation({...input,path:target},{...defaults,realpath:async file=>file===target?selected:file})).cloud,'not-reported','a system-looking alias resolving outside the approved roots is not positive cloud evidence');
 assert.equal((await probeDesktopProjectLocation(input,{...defaults,realpath:async file=>{if(file===homeDir)throw Object.assign(Error('missing home'),{code:'ENOENT'});return file;}})).cloud,'unknown');
});
test('unreadable, missing, malformed or unmatched mounts block rather than inheriting permissive defaults',async()=>{
 for(const mounts of [null,[],[{...local,mountPoint:'/Volumes/Elsewhere'}],[{...local,volumeReadOnly:undefined}],[{...local,fileSystem:''}]])await assert.rejects(probeDesktopProjectLocation(input,{...defaults,readMounts:async()=>mounts as readonly DesktopProjectMount[]|null}),failure('PROJECT_LOCATION_INVALID'));
 await assert.rejects(probeDesktopProjectLocation(input,{...defaults,readMounts:async()=>{throw Error('mount failed');}}),failure('PROJECT_LOCATION_INVALID'));
 assert.equal(parseDesktopMacMounts('/dev/disk1 on / (apfs, local)\nmalformed nested mount\n'),null);assert.equal(parseDesktopMacMounts(''),null);assert.equal(parseDesktopMacMounts('x'.repeat(1024*1024+1)),null);
 assert.equal(parseDesktopLinuxMounts('22 1 8:1 / / shared:1 - ext4 /dev/sda1 rw\n'),null);
});
test('mount matching keeps deepest entries, spaces and parentheses; Linux readonly facts are equally explicit',async()=>{
 const mounts=parseDesktopMacMounts('/dev/disk1 on / (apfs, local)\n/dev/disk2 on /Volumes/USB (1) (exfat, local, noowners)\n//user@nas/Back on Track on /Volumes/Back on Track (smbfs, nosuid)\n');assert.ok(mounts);
 assert.equal((await probeDesktopProjectLocation({...input,path:'/Volumes/USB (1)/Film.mioon'},{...defaults,...mounted(mounts)})).permissionBits,false);
 assert.equal((await probeDesktopProjectLocation({...input,path:'/Volumes/Back on Track/Film.mioon'},{...defaults,...mounted(mounts)})).isLocal,false);
 const linux=parseDesktopLinuxMounts('22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n23 22 8:17 / /media/USB\\040Drive ro,nosuid - exfat /dev/sdb1 ro\n');assert.ok(linux);
 assert.deepEqual(await probeDesktopProjectLocation({...input,path:'/media/USB Drive/Film.mioon'},{...defaults,platform:'linux',readMounts:async()=>linux}),{fileSystem:'exfat',isLocal:true,volumeReadOnly:true,permissionBits:false,cloud:'not-reported'});
});
test('EACCES and EPERM from metadata, realpath or mounts retain the independent permission code',async()=>{
 for(const code of ['EACCES','EPERM'])for(const stage of ['lstat','realpath','readMounts','readVolume']as const){
  const denied=async()=>{throw Object.assign(Error('private path in raw native error'),{code});};
  const deps={...defaults,[stage]:denied};
  await assert.rejects(probeDesktopProjectLocation(input,deps),error=>failure('PROJECT_ACCESS_DENIED')(error)&&(error as {status?:unknown}).status===403&&!(error as Error).message.includes('private path'));
 }
});
test('project leaf symlinks are rejected while directory aliases are resolved before matching',async()=>{
 let mountsRead=0;await assert.rejects(probeDesktopProjectLocation(input,{...defaults,lstat:async()=>info('link'),readMounts:async()=>{mountsRead++;return [local];}}),failure('PROJECT_LOCATION_INVALID'));assert.equal(mountsRead,0);
 const alias='/picked-alias',actual='/Volumes/NAS';
 const facts=await probeDesktopProjectLocation({path:alias,purpose:'create',isDirectory:true},{...defaults,lstat:async file=>info(file===alias?'link':'directory'),realpath:async file=>file===alias?actual:file,...mounted([local,{...local,mountPoint:actual,fileSystem:'smbfs',network:true}])});assert.equal(facts.isLocal,false);
});
test('a not-yet-created target uses its existing real parent; missing and non-directory parents block without creating anything',async()=>{
 const absent=Object.assign(Error('missing'),{code:'ENOENT'}),target='/alias/Film.mioon';let parentStats=0;
 let observed='';const volume=mounted([local,{...local,mountPoint:'/Volumes/USB',fileSystem:'exfat',ownersIgnored:true}]);
 const deps={...defaults,lstat:async(file:string)=>{if(file===target)throw absent;parentStats++;return info('directory');},realpath:async(file:string)=>file==='/alias'?'/Volumes/USB':file,...volume,readVolume:async(existing:string)=>{observed=existing;return volume.readVolume(existing);}};
 assert.equal((await probeDesktopProjectLocation({path:target,purpose:'save-as',isDirectory:false},deps)).permissionBits,false);assert.equal(parentStats,1);
 assert.equal(observed,'/Volumes/USB','df receives the existing real parent rather than the not-yet-created file');
 await assert.rejects(probeDesktopProjectLocation({path:target,purpose:'save-as',isDirectory:false},{...deps,realpath:async()=>{throw absent;}}),failure('PROJECT_LOCATION_INVALID'));
 await assert.rejects(probeDesktopProjectLocation({path:target,purpose:'save-as',isDirectory:false},{...deps,lstat:async file=>{if(file===target)throw absent;return info('file');}}),failure('PROJECT_LOCATION_INVALID'));
});

test('macOS firmlink paths use the actual df volume instead of the sealed root prefix',async()=>{
 const mounts=parseDesktopMacMounts('/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)\n');assert.ok(mounts);
 let observed='';
 const facts=await probeDesktopProjectLocation(input,{...defaults,readMounts:async()=>mounts,readVolume:async existing=>{observed=existing;return {device:'/dev/disk3s5',mountPoint:'/System/Volumes/Data'};}});
 assert.equal(observed,selected);assert.equal(facts.volumeReadOnly,false);assert.equal(facts.isLocal,true);
 const rootFacts=await probeDesktopProjectLocation({...input,path:'/System/Film.mioon'},{...defaults,readMounts:async()=>mounts,readVolume:async()=>({device:'/dev/disk3s1s1',mountPoint:'/'})});
 assert.equal(rootFacts.volumeReadOnly,true,'the system volume remains readonly');
});

test('df device and mount point must match one complete mount record or the probe blocks',async()=>{
 const data={...local,device:'/dev/disk3s5',mountPoint:'/System/Volumes/Data'},root={...local,volumeReadOnly:true};
 for(const [mounts,volume]of [
  [[root,data],{device:'/dev/other',mountPoint:data.mountPoint}],
  [[root,data],{device:data.device,mountPoint:'/System/Volumes/Elsewhere'}],
  [[root,data,data],{device:data.device,mountPoint:data.mountPoint}],
  [[{...data,device:undefined}],{device:data.device,mountPoint:data.mountPoint}],
 ]as const)await assert.rejects(probeDesktopProjectLocation(input,{...defaults,readMounts:async()=>mounts,readVolume:async()=>volume}),failure('PROJECT_LOCATION_INVALID'));
 await assert.rejects(probeDesktopProjectLocation(input,{...defaults,readVolume:async()=>{throw Object.assign(Error('hidden native failure'),{code:'PROJECT_ACCESS_DENIED',status:403});}}),error=>failure('PROJECT_ACCESS_DENIED')(error)&&(error as {status?:unknown}).status===403);
});
