import {run} from './media-runtime.ts';

// An actual bounded per-frame scale and overlay invocation, rather than
// trusting the tool's version text: animated transforms need FFmpeg 5 or later.
// It consumes no source media; a cancelled render keeps its own error.
export async function assertTimelineTransformCapability({signal,beforeEffect}: {signal?: AbortSignal;beforeEffect?: ()=>void}={}): Promise<void>{
 try{
  await run('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-threads','1','-filter_complex_threads','1',
   '-f','lavfi','-i','color=c=black:s=32x32:r=30','-f','lavfi','-i','color=c=white:s=8x8:r=30',
   '-filter_complex',"[1:v]format=rgba,scale=w='max(2,2*round(iw*(1+round(t*30))/2))':h='max(2,2*round(ih*(1+round(t*30))/2))':eval=frame[layer];[0:v][layer]overlay=x='16+round(t*30)-overlay_w/2':y='16-overlay_h/2':eval=frame",
   '-frames:v','2','-an','-f','null','-'],{timeout:15000,maxStdoutBytes:65536,maxStderrBytes:65536,signal,beforeEffect});
 }catch(error){
  // Cancellation, effect fences and spawn faults keep their own errors.
  if(signal?.aborted||(error as {code?: unknown})?.code!=='MEDIA_EXIT_FAILED')throw error;
  throw Object.assign(new Error('当前视频工具不支持逐帧变换，请改用 Mioon 提供的 FFmpeg 7.1.5 或其他 5.0 以上的版本'),{code:'TIMELINE_TRANSFORM_UNSUPPORTED'});
 }
}
