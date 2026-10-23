import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,symlink,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile);

test('project package fixture honors selected media paths before the legacy tool directory',async t=>{
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-project-package-tools-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const legacy=path.join(root,'legacy tools');await mkdir(legacy);
 const encoder=path.join(root,'selected encoder'),probe=path.join(root,'selected probe'),missing=path.join(root,'missing');
 for(const file of [encoder,probe,path.join(legacy,'ffmpeg'),path.join(legacy,'ffprobe')])await writeFile(file,'synthetic availability check only',{mode:0o700});
 const fixture=pathToFileURL(path.resolve('tests/helpers/project-package-fixture.ts')).href;
 const source=`import {mediaToolsAvailable} from ${JSON.stringify(fixture)};console.log(JSON.stringify({available:mediaToolsAvailable,ffmpeg:process.env.MIOON_FFMPEG_PATH,ffprobe:process.env.MIOON_FFPROBE_PATH}));`;
 for(const scenario of [
  {name:'independent selected paths need no legacy directory',ffmpeg:encoder,ffprobe:probe,tools:missing,available:true},
  {name:'legacy directory remains supported without overrides',ffmpeg:undefined,ffprobe:undefined,tools:legacy,available:true},
  {name:'missing selected executable cannot fall back to a legacy binary',ffmpeg:missing,ffprobe:probe,tools:legacy,available:false},
 ])await t.test(scenario.name,async()=>{
  const env:NodeJS.ProcessEnv={...process.env,MIOON_TEST_MEDIA_TOOLS:scenario.tools};
  delete env.MIOON_FFMPEG_PATH;delete env.MIOON_FFPROBE_PATH;
  if(scenario.ffmpeg!==undefined)env.MIOON_FFMPEG_PATH=scenario.ffmpeg;
  if(scenario.ffprobe!==undefined)env.MIOON_FFPROBE_PATH=scenario.ffprobe;
  const result=await exec(process.execPath,['--input-type=module','-e',source],{env,timeout:60000});
  const output=JSON.parse(result.stdout) as {available:boolean;ffmpeg?:string;ffprobe?:string};
  assert.equal(output.available,scenario.available);
  if(scenario.available){assert.equal(output.ffmpeg,scenario.ffmpeg??path.join(legacy,'ffmpeg'));assert.equal(output.ffprobe,scenario.ffprobe??path.join(legacy,'ffprobe'));}
 });
});

test('mock generation and probe use selected absolute executables with no host PATH',async()=>{
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'wb-media-runtime-'));
 const bin=path.join(root,'selected media tools');await mkdir(bin);
 const {stdout:ffmpeg}=await exec('/bin/sh',['-c','command -v ffmpeg']);
 const {stdout:ffprobe}=await exec('/bin/sh',['-c','command -v ffprobe']);
 const encoder=path.join(bin,'encoder selected'),probe=path.join(bin,'probe selected');
 await symlink(ffmpeg.trim(),encoder);await symlink(ffprobe.trim(),probe);
 const provider=pathToFileURL(path.resolve('packages/business/src/providers/mock.ts')).href;
 const media=pathToFileURL(path.resolve('packages/business/src/media.ts')).href;
 const source=`import {DatabaseSync} from 'node:sqlite';import {createMockProvider} from ${JSON.stringify(provider)};import {probe} from ${JSON.stringify(media)};const root=${JSON.stringify(root)},db=new DatabaseSync(':memory:');const p=createMockProvider({db,root});const job=await p.submit({prompt:'Synthetic path verification',duration:2,aspectRatio:'9:16',parameters:{scenario:'success',delayMs:0},referenceAssets:[]},{requestId:'custom-runtime-path'});await p.download(job.providerJobId,root+'/output.mp4');const result=await probe(root+'/output.mp4');console.log(JSON.stringify({codec:result.codec,width:result.width,height:result.height,duration:result.duration}));db.close();`;
 const result=await exec(process.execPath,['--input-type=module','-e',source],{env:{...process.env,PATH:path.join(root,'missing-path'),MIOON_FFMPEG_PATH:encoder,MIOON_FFPROBE_PATH:probe},timeout:60000});
 const output=JSON.parse(result.stdout);assert.equal(output.codec,'h264');assert.equal(output.width/output.height,9/16);assert.equal(output.duration,2);
});
