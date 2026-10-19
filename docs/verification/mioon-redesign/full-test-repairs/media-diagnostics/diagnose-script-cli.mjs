import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

const out=path.dirname(new URL(import.meta.url).pathname),exec=promisify(execFile),results=[];
const simple=path.join(out,'simple-null.filter'),complex=path.join(out,'complex-null.filter');
await writeFile(simple,'null');await writeFile(complex,'[0:v]null[outv]');
const prefix=['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=64x64:r=30'];
for(const [label,args] of [
 ['old-filter-script',[...prefix,'-filter_script:v',simple,'-frames:v','1','-f','null','-']],
 ['new-filter-file',[...prefix,'-/filter:v',simple,'-frames:v','1','-f','null','-']],
 ['old-filter-complex-script',[...prefix,'-filter_complex_script',complex,'-map','[outv]','-frames:v','1','-f','null','-']],
 ['new-filter-complex-file',[...prefix,'-/filter_complex',complex,'-map','[outv]','-frames:v','1','-f','null','-']],
 ['independent-subtitles-no-options',[...prefix,'-vf','subtitles','-frames:v','1','-f','null','-']]
]){const item={label,file:'/opt/homebrew/bin/ffmpeg',args};try{const result=await exec(item.file,args,{timeout:10000});Object.assign(item,{exitCode:0,stderr:result.stderr});}catch(error){Object.assign(item,{exitCode:error.code,stderr:error.stderr??''});}results.push(item);await writeFile(path.join(out,label+'.stderr.txt'),item.stderr);}
await writeFile(path.join(out,'script-cli-diagnostics.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results.map(({label,exitCode,stderr})=>({label,exitCode,stderr})),null,2));
