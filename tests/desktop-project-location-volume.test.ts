import test from 'node:test';
import assert from 'node:assert/strict';
import {DESKTOP_PROJECT_VOLUME_LIMITS,parseDesktopProjectDf,readDesktopProjectVolume} from '../apps/desktop/src/project-location-volume.ts';
import type {DesktopProjectVolumeCommandOptions} from '../apps/desktop/src/project-location-volume.ts';

const header='Filesystem   512-blocks       Used  Available Capacity  Mounted on';
const row='/dev/disk3s5 7805330720 4383932608 3332491264 57% /System/Volumes/Data';
const output=`${header}\n${row}\n`;
const failure=(code:string)=>(error:unknown)=>Boolean(error&&typeof error==='object'&&'code'in error&&error.code===code);

test('df selects the real Data volume behind a macOS firmlink without rewriting the selected path',async()=>{
 const calls:Array<{file:string;args:readonly string[];options:DesktopProjectVolumeCommandOptions}>=[],selected='/Users/me/Movies/Film 2026.mioon';
 const volume=await readDesktopProjectVolume(selected,{run:async(file,args,options)=>{calls.push({file,args,options});return {stdout:output,stderr:''};}});
 assert.deepEqual(volume,{device:'/dev/disk3s5',mountPoint:'/System/Volumes/Data'});assert.deepEqual(calls[0]!.args,['-P',selected]);assert.equal(calls[0]!.file,'/bin/df');assert.equal(calls[0]!.options.timeout,5000);assert.equal(calls[0]!.options.killSignal,'SIGKILL');assert.equal(calls[0]!.options.maxBuffer,1024*1024);assert.equal(calls[0]!.options.encoding,'utf8');assert.equal(calls[0]!.options.env.LC_ALL,'C');assert.equal('shell'in calls[0]!.options,false);
});

test('one df record preserves numeric and spaced mount/device names as complete fields',()=>{
 for(const [device,mountPoint]of [['/dev/disk2s1','/Volumes/USB 2026 Drive'],['//user@nas/Back on Track','/Volumes/Back on Track'],['nas:/2026 share','/Volumes/2026 11 04'],['map auto_home','/System/Volumes/Data/home'],['/dev/disk1','/Volumes/USB (1)']]as const){
  assert.deepEqual(parseDesktopProjectDf(`${header}\n${device} 1000 400 600 40% ${mountPoint}\n`),{device,mountPoint});
 }
 assert.deepEqual(parseDesktopProjectDf('Filesystem 1024-blocks Used Available Use% Mounted on\n/dev/sda1 1000 400 600 40% /mnt/USB 2026\n'),{device:'/dev/sda1',mountPoint:'/mnt/USB 2026'});
});

test('df parser rejects malformed, extra, truncated, unsafe or ambiguous records instead of selecting a prefix',()=>{
 for(const value of ['',row,`${header}\n`,`${header}\n${row}\n${row}\n`,`${header}\n${row}\n\n`,`${header}\n/dev/disk1 1 2 3 /Volumes/Data\n`,`${header}\n/dev/disk1 bad 2 3 50% /\n`,`${header}\n/dev/disk1 1 2 3 50% relative\n`,`${header}\n/dev/disk1 1 2 3 50% /Volumes/../Data\n`,`${header}\n/dev/disk1 1 2 3 50% /Volumes/Bad\0Path\n`,`${header}\n/dev/disk1 1 2 3 50% /Volumes/Bad\tPath\n`,`${header}\n/dev/disk1 1 2 3 50% /Volumes/Bad\ufffd\n`,`${header}\n/dev/disk1 1 2 3 50% /Volumes/Bad\ud800\n`])assert.equal(parseDesktopProjectDf(value),null,JSON.stringify(value));
});

test('complete df bytes are bounded at exactly one MiB, including multibyte names',async()=>{
 const suffix=`\n/dev/disk1 1000 400 600 40% /Volumes/磁盘 2026\n`,base=header+suffix,padding=DESKTOP_PROJECT_VOLUME_LIMITS.maxBytes-Buffer.byteLength(base),maximum=header+' '.repeat(padding)+suffix;
 assert.ok(parseDesktopProjectDf(maximum));assert.equal(parseDesktopProjectDf(maximum+' '),null);
 assert.deepEqual(await readDesktopProjectVolume('/existing',{run:async()=>({stdout:maximum})}),{device:'/dev/disk1',mountPoint:'/Volumes/磁盘 2026'});
 await assert.rejects(readDesktopProjectVolume('/existing',{run:async()=>({stdout:maximum+' '})}),failure('PROJECT_LOCATION_INVALID'));
});

test('command failures and warning output are fixed safe failures; denied metadata retains its independent code',async()=>{
 for(const code of ['ETIMEDOUT','ENOENT','ERR_CHILD_PROCESS_STDIO_MAXBUFFER',1])await assert.rejects(readDesktopProjectVolume('/existing',{run:async()=>{throw Object.assign(Error('sensitive raw process details'),{code});}}),error=>failure('PROJECT_LOCATION_INVALID')(error)&&!(error as Error).message.includes('sensitive'));
 for(const code of ['EACCES','EPERM'])await assert.rejects(readDesktopProjectVolume('/existing',{run:async()=>{throw Object.assign(Error('sensitive raw process details'),{code});}}),error=>failure('PROJECT_ACCESS_DENIED')(error)&&!(error as Error).message.includes('sensitive'));
 await assert.rejects(readDesktopProjectVolume('/existing',{run:async()=>({stdout:output,stderr:'Unexpected warning'})}),failure('PROJECT_LOCATION_INVALID'));
 await assert.rejects(readDesktopProjectVolume('/existing',{run:async()=>({stdout:output,stderr:'x'.repeat(1024*1024)})}),failure('PROJECT_LOCATION_INVALID'));
});

test('a normalized nearest existing parent is passed as one argv value and unsafe paths dispatch nothing',async()=>{
 const parent='/Volumes/USB 2026/$(literal)';let calls=0;await readDesktopProjectVolume(parent,{run:async(_file,args)=>{calls++;assert.deepEqual(args,['-P',parent]);return {stdout:output};}});assert.equal(calls,1);
 for(const file of ['relative','/Volumes/../Data','/bad\npath','/bad\0path','/'+ 'x'.repeat(4096)])await assert.rejects(readDesktopProjectVolume(file,{run:async()=>{calls++;return {stdout:output};}}),failure('PROJECT_LOCATION_INVALID'));assert.equal(calls,1);
});
