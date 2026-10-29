import {run} from './media-runtime.ts';

// An actual bounded invocation of every filter a transition uses (xfade, tpad,
// fade to black, per-frame overlay positions and switches), rather than
// trusting the tool's version text. It consumes no source media; a cancelled
// render keeps its own error.
export async function assertTimelineTransitionCapability({signal,beforeEffect}: {signal?: AbortSignal;beforeEffect?: ()=>void}={}): Promise<void>{
 try{
  await run('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-threads','1','-filter_complex_threads','1',
   '-f','lavfi','-i','color=c=black:s=32x32:r=30','-f','lavfi','-i','color=c=white:s=32x32:r=30',
   '-filter_complex',"[1:v]format=rgba,split=3[w0][w1][w2];[0:v]setpts=N/(30*TB),fps=30,tpad=start=1:start_mode=clone[a];[w0]setpts=N/(30*TB),fps=30,tpad=start=1:start_mode=clone[b];[a][b]xfade=transition=wipeleft:duration=0.1:offset=0,trim=start_frame=1,setpts=N/(30*TB)[x];[w1]fade=t=out:st=0:d=0.05:color=black[d];[x][d]overlay=x='-32*(1+round(t*30))/3':y=0:eval=frame:enable='lt((1+round(t*30))/3,0.5)'[y];[y][w2]overlay=0:0:enable='gte(t,0)'",
   '-frames:v','2','-an','-f','null','-'],{timeout:15000,maxStdoutBytes:65536,maxStderrBytes:65536,signal,beforeEffect});
 }catch(error){
  // Cancellation, effect fences and spawn faults keep their own errors.
  if(signal?.aborted||(error as {code?: unknown})?.code!=='MEDIA_EXIT_FAILED')throw error;
  throw Object.assign(new Error('当前视频工具不支持转场所需的滤镜，请改用 Mioon 提供的 FFmpeg 7.1.5 或其他 5.0 以上的版本'),{code:'TIMELINE_TRANSITION_UNSUPPORTED'});
 }
}
