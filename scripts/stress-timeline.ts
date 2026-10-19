/** Optional full-bound render check. Expected runtime is a few minutes. */
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {probe,run} from '../packages/business/src/media.ts';

interface VideoStream {readonly codec_type?: string; readonly nb_frames?: unknown}
interface StressResult {
  readonly probe: {readonly streams: VideoStream[]};
  readonly duration: unknown;
  readonly width: unknown;
  readonly height: unknown;
}
const output=path.resolve(process.argv[2]||`evidence/v2-tests/stress-repeat-${Date.now()}`);
await mkdir(output,{recursive:true});const source=path.join(output,'source.png');
await run('ffmpeg',['-v','error','-n','-f','lavfi','-i','color=c=blue:s=320x180','-frames:v','1','-threads','1',source]);
const probed=await probe(source);
const assets=new Map([['image',{path:source,mimeType:'image/png',...probed}]]);
const timeline={fps:30,width:720,height:1280,durationFrames:18000,tracks:[{id:'visual',kind:'video',orderIndex:0,hidden:false,muted:false}],clips:Array.from({length:100},(_,i)=>({id:`clip-${i}`,trackId:'visual',assetId:'image',startFrame:i*180,durationFrames:180,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1}))};
const start=performance.now();const result=await renderTimeline({timeline} as never,assets as never,path.join(output,'100-clips-600s.mp4')) as StressResult;
console.log(JSON.stringify({elapsedSeconds:(performance.now()-start)/1000,frames:result.probe.streams.find(stream=>stream.codec_type==='video')?.nb_frames,duration:result.duration,width:result.width,height:result.height,output},null,2));
