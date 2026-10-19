import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,symlink,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile);

test('mock generation and probe use selected absolute executables with no host PATH',async()=>{
 const root=await mkdtemp('/tmp/wb-media-runtime-');
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
