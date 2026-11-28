import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {lstatSync} from 'node:fs';
import {mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {TestContext} from 'node:test';
import {testEnv} from './test-env.ts';

/** The image is the project volume. The containing scratch directory holds
 * application data and receipts on the host filesystem. */
export async function mountProjectVolumeFixture(t:TestContext,format:'exFAT'|'FAT32') {
 if(process.platform!=='darwin'){t.skip(`${format} disk image fixture requires macOS hdiutil`);return;}
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
 if(create.status!==0){t.skip(`${format} image creation unavailable (hdiutil ${create.error?.message??create.signal??create.status})`);return;}
 const attach=hdiutil('attach','-nobrowse','-noautoopen','-mountpoint',mount,image);
 if(attach.status!==0){t.skip(`${format} image mount unavailable (hdiutil ${attach.error?.message??attach.signal??attach.status})`);return;}
 if(!mounted()){t.skip(`hdiutil did not mount the ${format} image at the test mountpoint`);return;}
 return {root,mount};
}
