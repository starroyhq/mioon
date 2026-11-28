import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, unlinkSync, writeSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import {mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {TestContext} from 'node:test';
import {testEnv} from './test-env.ts';

function diagnoseVolumeIdentity(t: TestContext, format: 'exFAT'|'FAT32', mount: string): void {
 const probe = path.join(mount, 'inode-probe');
 const stat = (info: BigIntStats) =>
  `dev=${info.dev} ino=${info.ino} birthtimeNs=${info.birthtimeNs} size=${info.size}`;
 const fd = openSync(probe, 'wx');
 try {
  const sample = (phase: string) =>
   t.diagnostic(`FAT stat ${format} ${phase} fd[${stat(fstatSync(fd, {bigint:true}))}] path[${stat(lstatSync(probe, {bigint:true}))}]`);
  sample('empty');
  ftruncateSync(fd, 1);
  sample('truncate');
  assert.equal(writeSync(fd, Buffer.from([1]), 0, 1, 0), 1);
  sample('first-write');
  fsyncSync(fd);
  sample('synced');
 } finally {
  closeSync(fd);
  try {t.diagnostic(`FAT stat ${format} closed path[${stat(lstatSync(probe, {bigint:true}))}]`);}
  finally {unlinkSync(probe);}
 }
}

/** The image is the project volume. The containing scratch directory holds
 * application data and receipts on the host filesystem. */
export async function mountProjectVolumeFixture(t:TestContext,format:'exFAT'|'FAT32') {
 const required = process.env.MIOON_REQUIRE_PROJECT_VOLUME_FIXTURES === '1';
 const unavailable = (reason: string) => {
  if (required) assert.fail(reason);
  t.skip(reason);
 };
 if(process.platform!=='darwin'){unavailable(`${format} disk image fixture requires macOS hdiutil`);return;}
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-project-volume-'));
 const mount=path.join(root,'volume'),home=path.join(root,'home'),temp=path.join(root,'temp');
 const image=path.join(root,'fixture.dmg'),hostDevice=lstatSync(root).dev;
 const hdiutil=(...args:string[])=>spawnSync('/usr/bin/hdiutil',args,{
  stdio:'pipe',timeout:20000,env:{...testEnv(),HOME:home,CFFIXED_USER_HOME:home,TMPDIR:temp},
 });
 const mounted=()=>{
  const info=lstatSync(mount,{throwIfNoEntry:false});
  return info!==undefined&&info.dev!==hostDevice;
 };
 t.after(async()=>{
  if(mounted()){
   const detach=hdiutil('detach',mount);
   if(detach.status!==0&&mounted())assert.equal(hdiutil('detach','-force',mount).status,0,'detach the project volume fixture');
   assert.equal(mounted(),false,'never traverse a mounted image during test cleanup');
  }
  await rm(root,{recursive:true,force:true});
 });
 await Promise.all([mkdir(mount),mkdir(home),mkdir(temp)]);
 const create=hdiutil('create','-size','128m','-fs',format==='exFAT'?'ExFAT':'MS-DOS FAT32','-volname','MIOONTEST','-layout','MBRSPUD','-type','UDIF',image);
 if(create.status!==0){unavailable(`${format} image creation unavailable (hdiutil ${create.error?.message??create.signal??create.status})`);return;}
 const attach=hdiutil('attach','-nobrowse','-noautoopen','-mountpoint',mount,image);
 if(attach.status!==0){unavailable(`${format} image mount unavailable (hdiutil ${attach.error?.message??attach.signal??attach.status})`);return;}
 if(!mounted()){unavailable(`hdiutil did not mount the ${format} image at the test mountpoint`);return;}
 if(required) diagnoseVolumeIdentity(t,format,mount);
 return {root,mount};
}
