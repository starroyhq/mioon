import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const out=path.dirname(new URL(import.meta.url).pathname),work=path.join(out,'subtitle-work-after');
await mkdir(work,{recursive:true});
const results={capture:'The spawn wrapper records real argv and stderr, calls the original spawn unchanged, and does not stub any process or rendering result',production:{},commands:[]};
const original=cp.spawn;
cp.spawn=function(command,args,options){
 const item={command,args:[...args],stderr:''};results.commands.push(item);
 const child=original.call(this,command,args,options);
 child.stderr?.on('data',chunk=>{if(item.stderr.length<65536)item.stderr+=chunk.toString();});
 child.once('close',(code,signal)=>Object.assign(item,{exitCode:code,signal}));
 return child;
};
syncBuiltinESMExports();
try{
 const {prepareTimelineSubtitles}=await import('../verify/packages/business/src/subtitle-media.mjs');
 const {TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256}=await import('../verify/packages/contracts/src/index.mjs');
 try{
  await prepareTimelineSubtitles({timeline:{width:720,height:1280,subtitles:{profileId:TIMELINE_SUBTITLE_PROFILE_ID,cues:[{text:'你好，字幕\nExport 100%',startFrame:25,durationFrames:10}]}},subtitleProfile:{profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256}},work);
  results.production.unexpectedSuccess=true;
 }catch(error){results.production={code:error.code,message:error.message};}
}finally{cp.spawn=original;syncBuiltinESMExports();}
results.measurementFilter=await readFile(path.join(work,'subtitle-measure.filter'),'utf8');
await writeFile(path.join(out,'subtitle-diagnostics-after.json'),JSON.stringify(results,null,2)+'\n');
await writeFile(path.join(out,'subtitle-production-after.stderr.txt'),results.commands.map(item=>item.stderr).join('\n'));
console.log(JSON.stringify(results,null,2));
