import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {prepareTimelineSubtitles} from '../verify/packages/business/src/subtitle-media.mjs';
import {TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256} from '../verify/packages/contracts/src/index.mjs';

const out=path.dirname(new URL(import.meta.url).pathname),work=path.join(out,'subtitle-work'),exec=promisify(execFile);
await mkdir(work,{recursive:true});
const results={production:{},commands:[]};
try{await prepareTimelineSubtitles({timeline:{width:720,height:1280,subtitles:{profileId:TIMELINE_SUBTITLE_PROFILE_ID,cues:[{text:'你好，字幕\nExport 100%',startFrame:25,durationFrames:10}]}},subtitleProfile:{profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256}},work);results.production.unexpectedSuccess=true;}
catch(error){results.production={code:error.code,message:error.message};}
const script=path.join(work,'subtitle-measure.filter'),filter=await readFile(script,'utf8');
results.measurementFilter=filter;
async function run(label,args){const item={label,file:'/opt/homebrew/bin/ffmpeg',args};try{const result=await exec(item.file,args,{timeout:30000,maxBuffer:4*1024*1024});Object.assign(item,{exitCode:0,stdoutBytes:result.stdout.length,stderr:result.stderr});}catch(error){Object.assign(item,{exitCode:error.code,stdoutBytes:error.stdout?.length??0,stderr:error.stderr??''});}results.commands.push(item);await writeFile(path.join(out,label+'.stderr.txt'),item.stderr);}
const prefix=['-hide_banner','-loglevel','error','-filter_threads','1','-f','lavfi','-i','color=c=black@0:s=4096x256:r=30,format=rgba'];
const suffix=['-frames:v','1','-an','-c:v','rawvideo','-pix_fmt','gray','-threads','1','-f','rawvideo','pipe:1'];
await run('subtitle-exact-measurement', [...prefix,'-filter_script:v',script,...suffix]);
await run('subtitle-measurement-inline-filter', [...prefix,'-vf',filter,...suffix]);
const srt=path.join(work,'sample.srt');await writeFile(srt,'1\n00:00:00,000 --> 00:00:00,100\nLocal diagnostic\n');
await run('independent-libass-subtitles-filter',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=64x64:r=30','-vf',`subtitles=${srt}`,'-frames:v','1','-f','null','-']);
await writeFile(path.join(out,'subtitle-diagnostics.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
